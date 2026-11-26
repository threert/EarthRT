// Places on the web (SPEC § 5, § 8): what the registry lists around the view, one version per topic (the user's choice
// in localStorage, else the best ranked), their GLB content loaded within `visibleFrom` and placed in the place's
// frame through the floating origin, and the trunk's buildings hidden inside those that replace them. `scene`
// content is not run on the web in v1: its place shows a marker and "Open in ThreeRT".
import * as THREE from "three";
import { serviceUrl } from "../host.ts";
import { CityTiles } from "./city.ts";
import { validateTileset, type Tileset, chooseVersions, ecefToGeodetic, geodeticToEcef, haversine, placeFrame, placeRadius, topicBase, VISIBLE_FROM, type PlaceManifest, type PlaceRecord } from "@earthrt/core";
import { centerTarget, geodetic, type CamState } from "../camera/math.ts";
import type { App } from "../main.ts";

const CHOICE_KEY = "earthrt.choice";
/** Radiance of one nit in the renderer's units: the sun's irradiance is 1, about 100,000 lux, so a white surface it
 *  lights square on is 1/π ≈ 32,000 nits. */
export const NITS = 1e-5;

export interface Loaded {
  record: PlaceRecord;
  group: THREE.Group;
  state: "loading" | "ready" | "failed" | "none";
  ground: number;
  groundZoom: number;
  bytes: number;
  error?: string;
  /** A city's own tiles (SPEC § 5 `tiles`). */
  city?: CityTiles;
}

export function loadChoice(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): Record<string, string> {
  try { return JSON.parse(storage?.getItem(CHOICE_KEY) ?? "{}") ?? {}; } catch { return {}; }
}

export function saveChoice(choice: Record<string, string>, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage) {
  try { storage?.setItem(CHOICE_KEY, JSON.stringify(choice)); } catch { /* private mode */ }
}

/** A lon/lat box around what the camera sees (a radius about the point it looks at, grown with height). */
export function viewBox(lat: number, lon: number, radiusM: number) {
  const r = Math.min(radiusM, 5_000_000);
  const dLat = r / 111_320, dLon = dLat / Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  if (dLon >= 180) return { west: -180, south: Math.max(-90, lat - dLat), east: 180, north: Math.min(90, lat + dLat) };
  let west = lon - dLon, east = lon + dLon;
  if (west < -180) west += 360;
  if (east > 180) east -= 360;
  return { west, south: Math.max(-90, lat - dLat), east, north: Math.min(90, lat + dLat) };
}

export class Places {
  readonly api: string;
  /** Every place the registry has told us about. */
  readonly records = new Map<string, PlaceRecord>();
  /** The version shown for each topic (base). */
  chosen = new Map<string, PlaceRecord>();
  choice: Record<string, string> = loadChoice();
  /** Versions opened by a link or a search this visit: shown, not remembered. */
  private visitChoice: Record<string, string> = {};
  readonly loaded = new Map<string, Loaded>();
  available = true;
  dev: PlaceRecord | null = null;
  devVersion = 0;
  private lastQuery = 0;
  private lastBox = "";
  private loader: Promise<import("three/examples/jsm/loaders/GLTFLoader.js").GLTFLoader> | null = null;

  constructor(private readonly app: App) {
    this.api = serviceUrl(`${app.launch.api || ""}/api/v1`, app.launch.host === "app");
  }

  private async getJson<T>(path: string): Promise<T> {
    const r = await fetch(`${this.api}${path}`, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    const ct = r.headers.get("content-type") ?? "";
    if (!ct.includes("json")) throw new Error(`not JSON: ${path}`);
    return r.json() as Promise<T>;
  }

  async search(q: string): Promise<PlaceRecord[]> {
    const r = await this.getJson<{ places: PlaceRecord[] }>(`/places?q=${encodeURIComponent(q)}&limit=12`);
    for (const p of r.places) this.keep(p);
    return r.places;
  }

  /** A record from the registry, its files' base through the app's URL scheme when hosted by the app. */
  private keep(p: PlaceRecord): PlaceRecord {
    p.files = serviceUrl(p.files, this.app.launch.host === "app");
    this.records.set(p.id, p);
    return p;
  }

  async get(id: string): Promise<PlaceRecord> {
    if (this.dev?.id === id) return this.dev;
    return this.keep(await this.getJson<PlaceRecord>(`/places/${id}`));
  }

  /** Every version of a topic (its base and eras), best first. */
  async versions(topic: string): Promise<PlaceRecord[]> {
    if (this.dev && topicBase(this.dev.topic) === topicBase(topic)) return [this.dev];
    const r = await this.getJson<{ places: PlaceRecord[] }>(`/topics/${encodeURIComponent(topicBase(topic))}`);
    for (const p of r.places) this.keep(p);
    return r.places;
  }

  /** Make a version the one shown for its topic (remembered). */
  choose(p: PlaceRecord) {
    delete this.visitChoice[topicBase(p.topic)];
    this.choice[topicBase(p.topic)] = p.id;
    saveChoice(this.choice);
    this.rechoose();
  }

  /** The host's choice for a topic (it keeps them; SPEC § 6.1 `earth.choose`). */
  setChoice(topic: string, id: string) {
    this.choice[topicBase(topic)] = id;
    delete this.visitChoice[topicBase(topic)];
    this.rechoose();
  }

  /** A place under development from the host (`earth.dev`): its files at `base`, its manifest given; sent again after
   *  each save, which reloads it. */
  showDev(base: string, m: PlaceManifest) {
    const dir = base.endsWith("/") ? base : `${base}/`;
    const old = this.dev && this.loaded.get(this.dev.id);
    if (old) this.unload(old);
    const first = !this.dev;
    this.devVersion++;
    this.dev = {
      id: `dev/local/${m.id}`, repo: "dev/local", sha: "dev", manifest: m, files: dir, author: "you (dev)", likes: 0, stars: 0,
      topic: m.topic ?? `${m.kind}:${m.id}`, updated: new Date().toISOString(),
    };
    this.rechoose();
    if (first) this.goTo(this.dev);
  }

  private rechoose() {
    const list = [...this.records.values()];
    if (this.dev) list.push(this.dev);
    const choice = { ...this.choice, ...this.visitChoice };
    if (this.dev) choice[topicBase(this.dev.topic)] = this.dev.id;
    this.chosen = chooseVersions(list, choice);
    // drop loaded places that are no longer the chosen version
    const ids = new Set([...this.chosen.values()].map((p) => p.id));
    for (const [id, l] of this.loaded) if (!ids.has(id)) this.unload(l);
  }

  /** Opens a place by id: the panel, and a flight there. */
  async open(id: string, go: boolean) {
    try {
      const p = await this.get(id);
      // the version asked for is the one shown (this visit; the panel's "Show" remembers a choice)
      this.visitChoice[topicBase(p.topic)] = p.id;
      this.rechoose();
      this.app.ui.showPlace(p);
      if (go) this.goTo(p);
    } catch (e) {
      this.app.ui.toast(`Can't open ${id}: ${(e as Error).message}`);
    }
  }

  /** "Go there": the place's start view, else a view of its anchor from its size. */
  goTo(p: PlaceRecord, again = true) {
    const m = p.manifest;
    const l = this.loaded.get(p.id);
    const ground = l && l.groundZoom >= 0 ? l.ground : this.app.tiles.groundAt(m.anchor.lat, m.anchor.lon);
    const g = Number.isFinite(ground) ? ground : 0;
    const zoom = this.app.tiles.zoomAt(m.anchor.lat, m.anchor.lon);
    // on arrival: if the ground there was only known coarsely when this was aimed (the floor kept the camera above
    // its guess), aim again with what has arrived since
    const done = () => {
      if (!again) return;
      const z2 = this.app.tiles.zoomAt(m.anchor.lat, m.anchor.lon);
      const h2 = this.app.tiles.groundAt(m.anchor.lat, m.anchor.lon);
      if (z2 > zoom || (Number.isFinite(h2) && Math.abs(h2 - g) > 0.5)) this.goTo(p, false);
    };
    if (m.start) {
      const f = placeFrame(m, g);
      const pos = f.pointToEcef(m.start.position), tgt = f.pointToEcef(m.start.target);
      const gp = ecefToGeodetic(...pos), gt = ecefToGeodetic(...tgt);
      const range = Math.hypot(pos[0] - tgt[0], pos[1] - tgt[1], pos[2] - tgt[2]);
      const heading = (Math.atan2(
        Math.sin(((gt.lon - gp.lon) * Math.PI) / 180) * Math.cos((gt.lat * Math.PI) / 180),
        Math.cos((gp.lat * Math.PI) / 180) * Math.sin((gt.lat * Math.PI) / 180) - Math.sin((gp.lat * Math.PI) / 180) * Math.cos((gt.lat * Math.PI) / 180) * Math.cos(((gt.lon - gp.lon) * Math.PI) / 180),
      ) * 180) / Math.PI;
      const tilt = (Math.acos(Math.max(-1, Math.min(1, (gp.h - gt.h) / Math.max(range, 1e-3)))) * 180) / Math.PI;
      this.app.goTo(this.app.viewOf(gt.lat, gt.lon, gt.h, range, heading, Math.min(88, tilt)), done);
      return;
    }
    const r = placeRadius(m);
    this.app.goTo(this.app.viewOf(m.anchor.lat, m.anchor.lon, g, Math.max(150, r * 2.5), m.anchor.heading ?? 0, 55), done);
  }

  /** A place under development (SPEC § 7, `dev=`): its manifest and files from a URL, reloaded when the dev server
   *  says its files changed (`GET <origin>/_dev/wait?v=<n>` long-polls and answers `{ v }`). */
  async loadDev(base: string, first = true) {
    const dir = base.endsWith("/") ? base : `${base}/`;
    try {
      const m = (await fetch(`${dir}earthrt.json?v=${this.devVersion}`, { cache: "no-store" }).then((r) => r.json())) as PlaceManifest;
      const old = this.dev && this.loaded.get(this.dev.id);
      if (old) this.unload(old);
      this.dev = {
        id: `dev/local/${m.id}`, repo: "dev/local", sha: "dev", manifest: m, files: dir, author: "you (dev)", likes: 0, stars: 0,
        topic: m.topic ?? `${m.kind}:${m.id}`, updated: new Date().toISOString(),
      };
      this.rechoose();
      if (first) {
        this.app.ui.showPlace(this.dev);
        // (a page opened at a pose stays there)
        if (!this.app.launch.at) this.goTo(this.dev);
        this.watchDev(dir);
      }
    } catch (e) {
      this.app.ui.toast(`Dev place at ${base}: ${(e as Error).message}`);
    }
  }

  private async watchDev(dir: string) {
    const origin = new URL(dir).origin;
    for (let fails = 0; fails < 20;) {
      try {
        const r = await fetch(`${origin}/_dev/wait?v=${this.devVersion}`, { cache: "no-store" });
        if (r.status === 404) return; // a plain static server: no reloads
        const { v } = (await r.json()) as { v: number };
        fails = 0;
        if (v !== this.devVersion) {
          this.devVersion = v;
          await this.loadDev(dir, false);
          this.app.ui.toast("Place reloaded");
        }
      } catch {
        fails++;
        await new Promise((ok) => setTimeout(ok, 1000 * fails));
      }
    }
  }

  /** Queries the registry for the view (at most every 1.5 s and when the box changed), loads and places content. */
  update(s: CamState) {
    const now = performance.now();
    const g = geodetic(s.pos);
    if (this.available && now - this.lastQuery > 1500) {
      const c = geodetic(centerTarget(s));
      const box = viewBox(c.lat, c.lon, Math.max(20_000, g.h * 1.5));
      const key = [box.west, box.south, box.east, box.north].map((v) => v.toFixed(g.h > 1e5 ? 0 : 2)).join(",");
      if (key !== this.lastBox) {
        this.lastQuery = now;
        this.lastBox = key;
        this.getJson<{ places: PlaceRecord[] }>(`/places?bbox=${key}&limit=200`).then((r) => {
          for (const p of r.places) this.keep(p);
          this.rechoose();
        }).catch(() => {
          // no registry here (a static server, the dev page): stop asking
          this.available = false;
        });
      }
    }
    const origin = this.app.globe.origin;
    for (const p of this.chosen.values()) {
      const m = p.manifest;
      const d = haversine(g.lat, g.lon, m.anchor.lat, m.anchor.lon);
      const dist = Math.hypot(d, g.h - (m.anchor.height ?? 0));
      const visible = dist < (m.visibleFrom ?? VISIBLE_FROM[m.kind]);
      let l = this.loaded.get(p.id);
      if (visible && !l) l = this.load(p);
      else if (!visible && l && dist > (m.visibleFrom ?? VISIBLE_FROM[m.kind]) * 1.5) {
        this.unload(l);
        continue;
      }
      if (!l) continue;
      // the ground under the anchor, refined as finer tiles arrive
      const z = this.app.tiles.zoomAt(m.anchor.lat, m.anchor.lon);
      if (z > l.groundZoom) {
        const h = this.app.tiles.groundAt(m.anchor.lat, m.anchor.lon);
        if (Number.isFinite(h)) { l.ground = h; l.groundZoom = z; }
      }
      const f = placeFrame(m, l.ground);
      const t = origin.placeFrame(f);
      l.group.position.set(...t.position);
      l.group.quaternion.set(...t.quaternion);
      l.group.visible = true;
      l.group.updateMatrixWorld(true);
      if (l.city) this.updateCity(l, f, s);
    }
  }

  private readonly frustum = new THREE.Frustum();
  private readonly projView = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();

  /** A city's tiles this frame: the camera in the place's frame, the view's frustum for their spheres. */
  private updateCity(l: Loaded, f: ReturnType<typeof placeFrame>, s: CamState) {
    const cam = this.app.globe.camera;
    this.projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const mw = l.group.matrixWorld;
    const visible = (c: [number, number, number], r: number) => {
      this.sphere.center.set(c[0], c[1], c[2]).applyMatrix4(mw);
      this.sphere.radius = r;
      return this.frustum.intersectsSphere(this.sphere);
    };
    const { h } = this.app.size;
    l.city!.update(f.point(s.pos), (this.app.fov * Math.PI) / 180, h, this.app.sse, visible);
  }

  /** The zoom the trunk's terrain must reach at a tile: a city's ground zoom under its shown tiles (SPEC § 5). */
  minZoom(k: { z: number; x: number; y: number }): number {
    let z = 0;
    for (const l of this.loaded.values()) if (l.city) z = Math.max(z, l.city.minZoom(k));
    return z;
  }

  /** The city whose tiles show (the buildings' mask): its mask texture and the matrix from the frame to mask uv. */
  cityMask(): { texture: THREE.Texture; matrix: THREE.Matrix4 } | null {
    for (const l of this.loaded.values()) {
      const c = l.city;
      if (!c || !c.shown || !l.record.manifest.replaces?.includes("buildings")) continue;
      const m = (c as CityTiles & { _mask?: ReturnType<CityTiles["mask"]> })._mask ??= c.mask();
      // frame → place frame (the group's inverse), then x, z → uv over the polygon's box
      const toUv = new THREE.Matrix4().set(
        1 / (m.x1 - m.x0), 0, 0, -m.x0 / (m.x1 - m.x0),
        0, 0, 0, 0,
        0, 0, 1 / (m.z1 - m.z0), -m.z0 / (m.z1 - m.z0),
        0, 0, 0, 1,
      );
      return { texture: m.texture, matrix: toUv.multiply(l.group.matrixWorld.clone().invert()) };
    }
    return null;
  }

  private load(p: PlaceRecord): Loaded {
    const group = new THREE.Group();
    group.name = `place:${p.id}`;
    group.visible = false;
    const l: Loaded = { record: p, group, state: "loading", ground: 0, groundZoom: -1, bytes: 0 };
    this.loaded.set(p.id, l);
    this.app.globe.placesGroup.add(group);
    // GLB content, and scene content's fallback GLB (the web runs no scene modules): placed by its own transform or none
    const glbs = p.manifest.content.flatMap((c) =>
      c.type === "glb" ? [c] : c.type === "scene" && c.fallback ? [{ type: "glb" as const, uri: c.fallback }] : []);
    const tiles = p.manifest.content.find((c) => c.type === "tiles");
    if (!glbs.length && !tiles) {
      l.state = "none";
      return l;
    }
    this.loader ??= import("three/examples/jsm/loaders/GLTFLoader.js").then(({ GLTFLoader }) => new GLTFLoader());
    if (tiles) this.loadCity(p, l, tiles.uri);
    if (!glbs.length) return l;
    this.loader.then(async (loader) => {
      for (const c of glbs) {
        if (c.type !== "glb") continue;
        const url = new URL(c.uri, p.files).href + (p.sha === "dev" ? `?v=${this.devVersion}` : "");
        const gltf = await loader.loadAsync(url);
        const o = gltf.scene;
        if (c.position) o.position.set(...c.position);
        if (c.rotation) o.rotation.set(...(c.rotation.map((d) => (d * Math.PI) / 180) as [number, number, number]), "XYZ");
        if (c.scale !== undefined) typeof c.scale === "number" ? o.scale.setScalar(c.scale) : o.scale.set(...c.scale);
        o.traverse((x) => {
          const mesh = x as THREE.Mesh;
          if (mesh.isMesh) {
            mesh.frustumCulled = true;
            // emission is in nits (SPEC § 5): into this renderer's units (sun irradiance 1 ≈ 100,000 lux)
            for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
              const sm = mat as THREE.MeshStandardMaterial;
              if (sm.emissive && sm.emissiveIntensity !== undefined) sm.emissiveIntensity *= NITS;
            }
            l.bytes += Object.values(mesh.geometry.attributes).reduce((s, a) => s + (a.array as ArrayLike<number> & { byteLength: number }).byteLength, 0);
          }
        });
        if (this.loaded.get(p.id) !== l) return; // unloaded meanwhile
        group.add(o);
      }
      l.state = "ready";
    }).catch((e) => {
      l.state = "failed";
      l.error = String(e?.message ?? e);
      console.warn("place", p.id, e);
    });
    return l;
  }

  /** A city's tileset.json (its tiles come as the view asks). */
  private async loadCity(p: PlaceRecord, l: Loaded, uri: string) {
    try {
      const url = new URL(uri, p.files).href;
      const ts = (await fetch(url + (p.sha === "dev" ? `?v=${this.devVersion}` : "")).then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${url}`);
        return r.json();
      })) as Tileset;
      const problems = validateTileset(ts);
      if (problems.length) throw new Error(`tileset.json: ${problems.slice(0, 3).join("; ")}`);
      if (this.loaded.get(p.id) !== l) return;
      const app = this.app;
      const budget = () => (app.settings.quality === "app" ? 900 : app.mobile ? 150 : 320) << 20;
      l.city = new CityTiles(p.manifest, ts, url, p.files, this.loader!, placeFrame(p.manifest, 0), budget);
      l.group.add(l.city.group);
      l.state = "ready";
    } catch (e) {
      l.state = "failed";
      l.error = String((e as Error)?.message ?? e);
      console.warn("city", p.id, e);
    }
  }

  private unload(l: Loaded) {
    l.city?.dispose();
    this.loaded.delete(l.record.id);
    l.group.removeFromParent();
    l.group.traverse((x) => {
      const mesh = x as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        for (const v of Object.values(mat)) if ((v as THREE.Texture)?.isTexture) (v as THREE.Texture).dispose();
        mat.dispose();
      }
    });
  }

  /** Where the trunk's buildings must not show (places that replace them), as (centre in the frame, radius). */
  holes(out: THREE.Vector4[], layer: "buildings" | "terrain" = "buildings"): number {
    let n = 0;
    for (const l of this.loaded.values()) {
      const m = l.record.manifest;
      if ((layer === "buildings" && !m.replaces?.includes("buildings")) || l.state !== "ready" || l.city || n >= out.length) continue;
      const c = this.app.globe.origin.frame.point(geodeticToEcef(m.anchor.lat, m.anchor.lon, l.ground));
      out[n++].set(c[0], c[1], c[2], placeRadius(m));
    }
    return n;
  }

  /** A place's minDistance near a known place (ARCHITECTURE § 4: a place earns close views; around it too, so the
   *  camera can come down to it: within 3× its radius, at least 150 m, and out to its start view), else undefined. */
  minDistanceAt(lat: number, lon: number): number | undefined {
    let best: number | undefined;
    // every place the page knows (the chosen versions), loaded or not: the camera must be able to come down to a
    // place before it loads (it loads within its visibleFrom)
    for (const p of this.chosen.values()) {
      const m = p.manifest;
      // (and as far as its own start view, which must be reachable)
      const start = m.start ? Math.hypot(m.start.position[0], m.start.position[2]) * 1.25 : 0;
      if (haversine(lat, lon, m.anchor.lat, m.anchor.lon) > Math.max(150, placeRadius(m) * 3, start)) continue;
      const d = m.minDistance ?? 1;
      best = best === undefined ? d : Math.min(best, d);
    }
    return best;
  }

  /** What is still loading: places' content and cities' tiles (the shots' and the probe's settle). */
  pending(): number {
    let n = 0;
    for (const l of this.loaded.values()) n += (l.state === "loading" ? 1 : 0) + (l.city?.stats().loading ?? 0);
    return n;
  }

  /** Markers: every chosen place (and the dev place) with where it is. */
  markers(): PlaceRecord[] {
    return [...this.chosen.values()];
  }
}
