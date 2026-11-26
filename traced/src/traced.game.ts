// EarthRT's traced view: one place path-traced with its surroundings (ARCHITECTURE § 1, § 2; SPEC § 5, § 6.2, § 7).
// The native app runs it (traced/build.ts bundles it to traced/dist/traced.js; traced/README.md is its contract), and
// `threert-render play` runs it alone for development.
//
// The app opens a place with `traced.open` (the registry's record or a dev folder, the map's camera, the time); in play
// the launch parameters stand in for it: place=<owner>/<repo>/<id> or dev=<folder under the asset root>,
// at=lat,lon,alt[,heading,pitch], utc=<ISO or ms> or time=<local solar hour>, api=<url>, radius=<m>.
import { BufferAttribute, BufferGeometry, Mesh, PerspectiveCamera, rendering, Scene } from "@threert/scene";
import { defineGame, host, hud, type FrameContext } from "@threert/gameplay";
import { ecefToGeodetic, Frame, geodeticToEcef, placeRadius as placeRadiusOf, quatFromRows, validatePlace, ENTER_FROM, type PlaceManifest, type V3 } from "../../packages/core/src/index.ts";
import { AssetsFetch, LocalFiles, netFetch, readText, type Files } from "./source.ts";
import { makeMaterials, setHidden, type Materials } from "./materials.ts";
import { cachePath, Surroundings, type Meta } from "./tiles.ts";
import { PlaceContent, type PlaceSource } from "./place.ts";
import { Walker, type GeoCamera } from "./walker.ts";
import { Sky } from "./sky.ts";
import { Clock } from "./clock.ts";

const DEFAULT_API = "https://earth.threert.dev";

let scene: Scene;
let camera: PerspectiveCamera;
let mats: Materials;
let sky: Sky;
let tiles: Surroundings;
let content: PlaceContent;
let walker: Walker;
const clock = new Clock();
let files: Files = new LocalFiles();
let api = DEFAULT_API;
/** The app answers traced.* (else: play, with a small HUD and launch parameters). */
let app = false;
let frame = new Frame(35, 135.7, 0, 0);
/** The place asked for before the tiles' meta was in: opened when it is. */
let opening: { src: PlaceSource; cam: GeoCamera | null; radius: number } | null = null;
let openedAt = 0;
let readyPosted = false;
let nowT = 0, nowMs = 0;
let status = "starting";
let lastView = "", lastViewAt = -1, lastStatus = -1, lastLoading = -1, lastHud = -1;
let frameMs = 0;
let exitPosted = false;
let city = false;

// ------------------------------------------------------------------------------------------------ the tiles' meta
let metaTry = 0, metaRetryAt = -1, metaAsking = false;
function metaUrl() {
  return `${api}/tiles/v1/meta.json`;
}
function metaLocal(): boolean {
  const text = readText(cachePath(metaUrl()));
  if (!text) return false;
  try {
    tiles.setMeta(JSON.parse(text) as Meta, api);
    return true;
  } catch {
    return false;
  }
}
/** The tiles' generation: fetched into the cache (a new URL each time so a cached copy does not answer), retried 1, 2,
 *  4 … 60 s apart while it fails, the cached copy used meanwhile (and offline). */
function loadMeta() {
  if (!files.online) {
    if (!metaLocal()) status = `no tiles: ${cachePath(metaUrl())} missing`;
    return afterMeta();
  }
  if (metaAsking) return;
  metaAsking = true;
  void files.get(`${metaUrl()}?at=${nowMs || 1}`, cachePath(metaUrl())).then(
    (f) => {
      metaAsking = false;
      if (f.status === 200 && metaLocal()) {
        metaTry = 0;
        return afterMeta();
      }
      retryMeta(String(f.status));
    },
    (e) => {
      metaAsking = false;
      retryMeta(String((e as Error)?.message ?? e));
    },
  );
}
function retryMeta(why: string) {
  if (!tiles.meta && metaLocal()) afterMeta();
  const wait = Math.min(60, 2 ** metaTry++);
  metaRetryAt = nowT + wait;
  console.log(`traced: meta.json: ${why}; again in ${wait} s`);
}
function afterMeta() {
  if (tiles.meta) status = `tiles ${tiles.meta.gen}`;
  if (opening && tiles.meta) {
    const o = opening;
    opening = null;
    open(o.src, o.cam, o.radius);
  }
}

// ------------------------------------------------------------------------------------------------ opening a place
/** The terrain under a point of the frame, as the frame's y. */
function groundY(x: number, z: number): number {
  const g = ecefToGeodetic(...frame.pointToEcef([x, 0, z]));
  const h = tiles.heightAt(g.lat, g.lon);
  if (!isFinite(h)) return NaN;
  return frame.point(geodeticToEcef(g.lat, g.lon, h))[1];
}

function open(src: PlaceSource, cam: GeoCamera | null, radius: number) {
  const m = src.manifest;
  if (!tiles.meta) {
    opening = { src, cam, radius };
    return;
  }
  content.close();
  tiles.close();
  frame = new Frame(m.anchor.lat, m.anchor.lon, 0, m.anchor.heading ?? 0);
  tiles.radius = radius;
  const cut = content.cutRadiusOf(m);
  tiles.cut = cut ? { x: 0, z: 0, r: cut } : null;
  setHidden(mats, cut ? [[0, 0, 0, cut]] : []);
  // (a city's surroundings follow the camera: it is entered anywhere in it; a site's and a room's are its anchor's)
  city = m.kind === "city";
  const c0 = city && cam ? cam : m.anchor;
  tiles.open(frame, c0.lat, c0.lon);
  const ground = tiles.groundNow(m.anchor.lat, m.anchor.lon);
  content.open(src, ground);
  walker.reach = city ? Math.max(radius, content.cutRadiusOf(m) || placeRadiusOf(m)) + radius : radius;
  walker.exitAbove = m.enterFrom ?? ENTER_FROM[m.kind] ?? 120;
  if (cam) walker.setGeo(cam);
  else startCamera(m);
  exitPosted = false;
  readyPosted = false;
  openedAt = nowT;
  status = `${m.title}`;
  console.log(`traced: open ${src.id} (${m.title}), surroundings ${tiles.stats.total} tiles within ${radius} m`);
}

/** No camera given: the place's `start`, else a view of it from its bounds' distance. */
function startCamera(m: PlaceManifest) {
  const h = content.height;
  if (m.start) {
    const [px, py, pz] = m.start.position, [tx, ty, tz] = m.start.target;
    walker.pos = [px, py + h, pz];
    const dx = tx - px, dy = ty - py, dz = tz - pz;
    walker.yaw = (Math.atan2(dx, -dz) * 180) / Math.PI;
    walker.pitch = (Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI;
  } else {
    const b = m.bounds as { radius?: number };
    const r = Math.max(20, (b.radius ?? 30) * 2.2);
    walker.pos = [0, h + r * 0.5, r];
    walker.yaw = 0;
    walker.pitch = -25;
  }
}

/** The place a launch or a message names: a registry id, a record, or a dev folder. */
async function source(p: { place?: unknown; dev?: unknown }): Promise<PlaceSource | null> {
  if (p.dev) {
    const d = p.dev as { path?: string; manifest?: PlaceManifest } | string;
    const folder = (typeof d === "string" ? d : d.path ?? "").replace(/\/$/, "");
    const manifest = (typeof d === "object" && d.manifest) || JSON.parse(readText(`${folder}/earthrt.json`) ?? "null");
    if (!manifest) return console.log(`traced: no earthrt.json in ${folder}`), null;
    const errs = validatePlace(manifest);
    if (errs.length) console.log(`traced: dev place: ${errs.join("; ")}`);
    return { id: `dev/${manifest.id}`, manifest, files: null, folder };
  }
  if (typeof p.place === "object" && p.place) {
    const r = p.place as { id: string; manifest: PlaceManifest; files: string };
    return { id: r.id, manifest: r.manifest, files: r.files.replace(/\/$/, "") };
  }
  if (typeof p.place === "string") {
    const r = await netFetch(`${api}/api/v1/places/${p.place}`);
    if (r.status !== 200) return console.log(`traced: place ${p.place}: ${r.status} ${r.error ?? ""}`), null;
    const j = JSON.parse(r.body) as { id: string; manifest: PlaceManifest; files: string; place?: { id: string; manifest: PlaceManifest; files: string } };
    const rec = j.manifest ? j : j.place!;
    return { id: rec.id, manifest: rec.manifest, files: rec.files.replace(/\/$/, "") };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ the host channel
host.on("launch", (m) => {
  const caps = (m.caps ?? []) as string[];
  if (caps.includes("assets")) {
    files = new AssetsFetch();
    tiles.files = files;
  }
  app = caps.includes("traced");
  if (app) hud.set({ items: [] });
  const p = m.params as Record<string, string>;
  if (p.api) api = String(p.api).replace(/\/$/, "");
  if (p.width && p.height) setView(Number(p.width), Number(p.height));
  if (p.utc) clock.set(isFinite(Number(p.utc)) ? Number(p.utc) : Date.parse(p.utc), nowT, 0);
  loadMeta();
  if (p.place || p.dev) {
    let cam: GeoCamera | null = null;
    if (p.at) {
      const [lat, lon, alt, heading, pitch] = String(p.at).split(",").map(Number);
      cam = { lat, lon, alt, heading: heading || 0, pitch: isFinite(pitch) ? pitch : -10 };
    }
    void source(p).then((src) => {
      if (!src) return;
      if (p.time !== undefined) clock.setSolar(Number(p.time), src.manifest.anchor.lon, nowT, 0);
      open(src, cam, Number(p.radius) || 1500);
    });
  }
});

host.on("traced.open", (m) => {
  const o = m as unknown as { place?: unknown; dev?: unknown; camera?: GeoCamera; utc?: number; surroundings?: { radius?: number } };
  if (typeof o.utc === "number") clock.set(o.utc, nowT);
  void source(o).then((src) => src && open(src, o.camera ?? null, o.surroundings?.radius ?? 1500));
});
host.on("traced.time", (m) => {
  const o = m as unknown as { utc?: number; rate?: number };
  if (typeof o.utc === "number") clock.set(o.utc, nowT, o.rate);
  else if (typeof o.rate === "number") clock.set(clock.utc(nowT, nowMs), nowT, o.rate);
});
host.on("traced.close", () => {
  content.close();
  tiles.close();
  opening = null;
});
host.on("view", (m) => {
  const v = m as unknown as { width?: number; height?: number };
  setView(Number(v.width), Number(v.height));
});

function setView(w: number, h: number) {
  if (!(w > 0 && h > 0)) return;
  camera.aspect = w / h;
  content.city.viewportHeight = h;
}

// ------------------------------------------------------------------------------------------------ setup and frames
/** A triangle with each material, out of sight: the scene's first vertex colours and functions come with setup (a
 *  later first one rebuilds the scene). */
function primeMaterials() {
  for (const m of [mats.terrain, mats.buildings, mats.buildingsCut, mats.water]) {
    const g = new BufferGeometry();
    g.positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]);
    g.normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]);
    g.uvs = new Float32Array(6);
    g.setAttribute("color", new BufferAttribute(new Float32Array(9).fill(0.5), 3));
    g.index = new Uint32Array([0, 2, 1]);
    const mesh = new Mesh(g, m);
    mesh.position.set(0, -1e6, 0);
    mesh.scale.set(1e-3, 1e-3, 1e-3);
    scene.add(mesh);
  }
}

function setup() {
  scene = new Scene();
  camera = new PerspectiveCamera(50, 16 / 9, 0.05, 1e6);
  camera.setAutoExposure(0, 6, 16);
  mats = makeMaterials();
  sky = new Sky(scene);
  tiles = new Surroundings(scene, mats, files);
  content = new PlaceContent(scene, () => files, (lon) => clock.solarHour(lon, nowT, nowMs));
  walker = new Walker(() => frame, () => 0);
  walker.ground = groundY;
  primeMaterials();
  aim();
  return { scene, camera };
}

function aim() {
  const f = walker.forward();
  // right = forward × up(0,1,0) normalised; up = right × forward
  let rx = -f[2], rz = f[0];
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl; rz /= rl;
  const right: V3 = [rx, 0, rz];
  const up: V3 = [right[1] * f[2] - right[2] * f[1], right[2] * f[0] - right[0] * f[2], right[0] * f[1] - right[1] * f[0]];
  const q = quatFromRows([right[0], up[0], -f[0]], [right[1], up[1], -f[1]], [right[2], up[2], -f[2]]);
  camera.position.set(walker.pos[0], walker.pos[1], walker.pos[2]);
  camera.quaternion.set(q[0], q[1], q[2], q[3]);
  if (camera.fov !== walker.fov) {
    camera.fov = walker.fov;
  }
}

let inFrame = false, interruptedLogs = 0, step = "";
function frameFn(f: FrameContext<Record<string, never>>) {
  if (inFrame && interruptedLogs++ < 20) console.log(`traced: the last frame was interrupted in ${step}`);
  inFrame = true;
  const t0 = Date.now();
  nowT = f.time;
  nowMs = f.now;
  step = "walk";
  walker.update(f.input, f.dt);
  if (f.input.pressed("BracketLeft")) clock.shift(-3600_000, f.time, f.now);
  if (f.input.pressed("BracketRight")) clock.shift(3600_000, f.time, f.now);
  step = "tiles";
  tiles.update();
  step = "content";
  content.update();
  if (content.source && content.city.ts) content.city.update(walker.pos, (walker.fov * Math.PI) / 180);
  // (a city's surroundings follow the camera, re-centred when it has gone a third of their radius)
  if (city && tiles.at && f.dt > 0) {
    const g = ecefToGeodetic(...frame.pointToEcef([walker.pos[0], 0, walker.pos[2]]));
    const d = Math.hypot((g.lat - tiles.at.lat) * 111_320, (g.lon - tiles.at.lon) * 111_320 * Math.cos((g.lat * Math.PI) / 180));
    if (d > tiles.radius / 3) tiles.center(g.lat, g.lon);
  }
  if (content.source) {
    const g = tiles.hasGround(content.source.manifest.anchor.lat, content.source.manifest.anchor.lon) ? tiles.heightAt(content.source.manifest.anchor.lat, content.source.manifest.anchor.lon) : NaN;
    if (isFinite(g)) content.setGround(g);
  }
  walker.clamp();
  aim();
  step = "sky";
  const geo = walker.geo();
  sky.update(frame, clock.utc(f.time, f.now), geo.alt);
  step = "post";
  post(geo, f.time);
  if (metaRetryAt >= 0 && f.time >= metaRetryAt) {
    metaRetryAt = -1;
    loadMeta();
  }
  const ms = Date.now() - t0;
  frameMs = frameMs * 0.9 + ms * 0.1;
  inFrame = false;
}

function post(geo: GeoCamera, t: number) {
  const src = content.source;
  const loaded = src && content.ready && tiles.complete;
  if (src && !readyPosted && (loaded || (content.ready && t - openedAt > 10))) {
    readyPosted = true;
    console.log(`traced: ready ${src.id} in ${(t - openedAt).toFixed(1)} s (${tiles.stats.total} tiles, ${(tiles.stats.tris / 1e6).toFixed(2)} M triangles${content.failed.length ? `; failed: ${content.failed.join("; ")}` : ""})`);
    host.post({ t: "traced.ready", id: src.id });
    console.log(`traced: camera ${walker.pos.map((v) => v.toFixed(1))} yaw ${walker.yaw.toFixed(1)} pitch ${walker.pitch.toFixed(1)} geo ${JSON.stringify(geo)} content h ${content.height.toFixed(1)} sun ${sky.sun.position.toArray().map((v) => v.toFixed(1))} cam ${camera.position.toArray().map((v) => v.toFixed(1))}`);
  }
  if (src && !readyPosted && t - lastLoading >= 0.25) {
    lastLoading = t;
    host.post({ t: "traced.loading", done: tiles.stats.done + content.done, total: tiles.stats.total + content.total, bytes: tiles.stats.bytes });
  }
  if (walker.exit && !exitPosted && src) {
    exitPosted = true;
    host.post({ t: "traced.exit", camera: geo, why: walker.exit });
    console.log(`traced: exit (${walker.exit})`);
  }
  if (t - lastViewAt >= 0.1) {
    const v = { lat: +geo.lat.toFixed(7), lon: +geo.lon.toFixed(7), alt: +geo.alt.toFixed(2), heading: +geo.heading.toFixed(2), pitch: +geo.pitch.toFixed(2), fov: geo.fov };
    const k = JSON.stringify(v);
    if (k !== lastView) {
      lastView = k;
      lastViewAt = t;
      host.post({ t: "traced.view", ...v });
    }
  }
  if (t - lastStatus >= 1) {
    lastStatus = t;
    const r = rendering.status() as { quality?: { scale?: number }; reconstruction?: { active?: string } } | undefined;
    host.post({ t: "traced.status", frameMs: +frameMs.toFixed(1), scale: r?.quality?.scale ?? null, reconstruction: r?.reconstruction?.active ?? null, ...(content.failed.length ? { errors: content.failed } : {}) });
  }
  if (!app && t - lastHud >= 0.25) {
    lastHud = t;
    const p = `${geo.lat.toFixed(5)}, ${geo.lon.toFixed(5)} · ${Math.round(geo.alt)} m`;
    hud.set({ items: [
      { type: "text", anchor: "top-left", label: "EarthRT traced", text: `${status} · ${p}`, size: "small" },
      { type: "text", anchor: "bottom-left", text: readyPosted ? "ready" : `loading ${tiles.stats.done + content.done} / ${tiles.stats.total + content.total}`, size: "small", tone: "dim" },
    ] });
  }
}

export default defineGame<Record<string, never>>({
  state: {},
  pointer: "free",
  on: { click: () => {} },
  setup: () => setup(),
  frame: frameFn,
});
