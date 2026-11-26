// A city's own tiles on the map (SPEC § 5 `tiles`, `earthrt/tileset@2`): GLB tiles in the place's frame, refined by
// screen-space error with core's selectCityTiles, loaded a few at a time, kept under a byte budget. While its tiles
// show, the trunk's buildings inside the city's bounds are hidden (a mask of its polygon) and the trunk's terrain is
// refined to the tileset's ground zoom under it (its roads and building feet are draped on those triangles).
import * as THREE from "three";
import type { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { selectCityTiles, tileBounds, type Frame, type PlaceManifest, type Tileset, type TilesetTile, type V3 } from "@earthrt/core";

interface Slot {
  tile: TilesetTile;
  state: "loading" | "ready" | "failed";
  object?: THREE.Object3D;
  bytes: number;
  lastUsed: number;
}

/** Bytes a loaded glTF scene holds on the GPU (vertex and index buffers, instance data). */
function sceneBytes(o: THREE.Object3D): number {
  let n = 0;
  const seen = new Set<unknown>();
  o.traverse((x) => {
    const m = x as THREE.Mesh & { instanceMatrix?: THREE.BufferAttribute; instanceColor?: THREE.BufferAttribute | null };
    if (!m.isMesh) return;
    for (const a of [...Object.values(m.geometry.attributes), m.geometry.index, m.instanceMatrix, m.instanceColor]) {
      const arr = (a as THREE.BufferAttribute | null | undefined)?.array as ArrayLike<number> & { byteLength?: number } | undefined;
      if (!arr || seen.has(arr)) continue;
      seen.add(arr);
      n += arr.byteLength ?? 0;
    }
  });
  return n;
}

/** The tileset's materials, made to read on the map: water calm and dark with the sun's glint, the rest as given. */
function adjustMaterials(o: THREE.Object3D, ts: Tileset) {
  o.traverse((x) => {
    const m = x as THREE.Mesh;
    if (!m.isMesh) return;
    m.frustumCulled = true;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      const sm = mat as THREE.MeshStandardMaterial;
      const hint = ts.materials[sm.name];
      if (!hint) continue;
      if (hint.surface && (hint.surface as { water?: boolean }).water) {
        sm.color.setRGB(0.18, 0.28, 0.32);
        sm.roughness = 0.08;
        sm.metalness = 0;
      }
    }
  });
}

export class CityTiles {
  readonly group = new THREE.Group();
  private readonly slots = new Map<string, Slot>();
  private inFlight = 0;
  private frameNo = 0;
  bytes = 0;
  /** Tiles shown last frame (0: the trunk draws the city). */
  shown = 0;
  readonly box: { west: number; south: number; east: number; north: number };
  readonly groundZoom: number;
  /** The bounds polygon in the place's frame (x east, z south), for the buildings' mask. */
  readonly polygon: [number, number][];

  constructor(
    readonly manifest: PlaceManifest,
    readonly ts: Tileset,
    private readonly tilesetUrl: string,
    private readonly files: string,
    private readonly loader: Promise<GLTFLoader>,
    frame: Frame,
    private readonly budget: () => number,
  ) {
    this.group.name = "city-tiles";
    this.groundZoom = ts.ground?.zoom ?? 14;
    const b = manifest.bounds as { radius?: number; polygon?: [number, number][] };
    const poly = b.polygon ?? circle(manifest.anchor.lat, manifest.anchor.lon, b.radius ?? 1000);
    let west = 180, east = -180, south = 90, north = -90;
    for (const [la, lo] of poly) { west = Math.min(west, lo); east = Math.max(east, lo); south = Math.min(south, la); north = Math.max(north, la); }
    this.box = { west, south, east, north };
    this.polygon = poly.map(([la, lo]) => {
      const p = frame.point(geodetic(la, lo));
      return [p[0], p[2]];
    });
  }

  /** A tile's URL: relative to tileset.json, or `@release/<tag>/<asset>` at the place's files base. */
  url(uri: string): string {
    return new URL(uri, uri.startsWith("@release/") ? this.files : this.tilesetUrl).href;
  }

  /**
   * One frame: which tiles show (selectCityTiles from the camera in the place's frame), what to load next, what to
   * drop. `visible` tests a bounding sphere in the place's frame against the view.
   */
  update(camera: V3, fov: number, height: number, sse: number, visible: (c: V3, r: number) => boolean) {
    this.frameNo++;
    const sel = selectCityTiles(this.ts, { position: camera, fov, height, sse, visible }, (k) => this.slots.get(k)?.state === "ready");
    const show = new Set(sel.show.map((t) => t.key));
    let shown = 0;
    for (const [k, s] of this.slots) {
      const on = show.has(k) && s.state === "ready";
      if (s.object) s.object.visible = on;
      if (on) { shown++; s.lastUsed = this.frameNo; }
      else if (sel.want.some((w) => w.key === k)) s.lastUsed = this.frameNo;
    }
    this.shown = shown;
    // the coarsest and nearest first: a level fills before the next starts
    const want = sel.want
      .filter((t) => !this.slots.has(t.key))
      .sort((a, b) => b.error - a.error || dist(a.center, camera) - dist(b.center, camera));
    for (const t of want) {
      if (this.inFlight >= 4) break;
      this.load(t);
    }
    if (this.bytes > this.budget()) this.evict();
  }

  private load(t: TilesetTile) {
    const slot: Slot = { tile: t, state: "loading", bytes: 0, lastUsed: this.frameNo };
    this.slots.set(t.key, slot);
    this.inFlight++;
    this.loader
      .then((l) => l.loadAsync(this.url(t.uri)))
      .then((gltf) => {
        if (this.slots.get(t.key) !== slot) return; // dropped meanwhile
        const o = gltf.scene;
        o.name = t.key;
        o.visible = false;
        adjustMaterials(o, this.ts);
        slot.object = o;
        slot.bytes = sceneBytes(o);
        this.bytes += slot.bytes;
        slot.state = "ready";
        this.group.add(o);
      })
      .catch((e) => {
        slot.state = "failed";
        console.warn("city tile", t.key, e?.message ?? e);
      })
      .finally(() => this.inFlight--);
  }

  private evict() {
    const old = [...this.slots.values()].filter((s) => s.state === "ready" && s.lastUsed < this.frameNo).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const s of old) {
      if (this.bytes <= this.budget() * 0.9) break;
      this.drop(s);
    }
  }

  private drop(s: Slot) {
    this.slots.delete(s.tile.key);
    this.bytes -= s.bytes;
    if (s.object) disposeObject(s.object);
  }

  dispose() {
    for (const s of [...this.slots.values()]) this.drop(s);
    this.group.removeFromParent();
  }

  /** The zoom the trunk's terrain must reach at a tile (the ground zoom inside the city while its tiles show). */
  minZoom(k: { z: number; x: number; y: number }): number {
    if (!this.shown || k.z >= this.groundZoom) return 0;
    const b = tileBounds(k);
    const meets = b.west <= this.box.east && b.east >= this.box.west && b.south <= this.box.north && b.north >= this.box.south;
    return meets ? this.groundZoom : 0;
  }

  /** The bounds polygon as a mask texture over its box in the place's frame (x, z), and that box. */
  mask(size = 512): { texture: THREE.Texture; x0: number; z0: number; x1: number; z1: number } {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of this.polygon) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d")!;
    g.fillStyle = "#000";
    g.fillRect(0, 0, size, size);
    g.fillStyle = "#fff";
    g.beginPath();
    this.polygon.forEach(([x, z], i) => {
      const u = ((x - x0) / (x1 - x0)) * size, v = ((z - z0) / (z1 - z0)) * size;
      if (i) g.lineTo(u, v);
      else g.moveTo(u, v);
    });
    g.closePath();
    g.fill();
    const texture = new THREE.CanvasTexture(c);
    texture.flipY = false;
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    return { texture, x0, z0, x1, z1 };
  }

  stats() {
    let ready = 0, loading = 0, failed = 0;
    for (const s of this.slots.values()) s.state === "ready" ? ready++ : s.state === "loading" ? loading++ : failed++;
    return { shown: this.shown, ready, loading, failed, MB: Math.round(this.bytes / 1048576) };
  }
}

const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function geodetic(lat: number, lon: number): V3 {
  const a = 6378137, e2 = 0.0066943799901413165;
  const p = (lat * Math.PI) / 180, l = (lon * Math.PI) / 180, s = Math.sin(p);
  const n = a / Math.sqrt(1 - e2 * s * s);
  return [n * Math.cos(p) * Math.cos(l), n * Math.cos(p) * Math.sin(l), n * (1 - e2) * s];
}

function circle(lat: number, lon: number, r: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * 2 * Math.PI;
    out.push([lat + (Math.cos(a) * r) / 111_320, lon + (Math.sin(a) * r) / (111_320 * Math.cos((lat * Math.PI) / 180))]);
  }
  return out;
}

export function disposeObject(o: THREE.Object3D) {
  o.removeFromParent();
  o.traverse((x) => {
    const mesh = x as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    (mesh as THREE.Mesh & { dispose?: () => void }).dispose?.();
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const v of Object.values(mat)) if ((v as THREE.Texture)?.isTexture) (v as THREE.Texture).dispose();
      mat.dispose();
    }
  });
}
