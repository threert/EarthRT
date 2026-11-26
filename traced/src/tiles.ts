// The place's surroundings: the trunk's terrain and buildings tiles (SPEC § 2–4) around the anchor, in the place's
// frame. A fixed cover, not a view's selection: z14 within the surroundings' radius, coarser rings beyond it out to the
// horizon (each ring a level coarser, its tiles four times the area), no two tiles overlapping. Fetched once when the
// place opens, made into meshes a frame budget at a time (a large tile in parts), dropped when it closes.
import { BufferAttribute, BufferGeometry, Mesh, readAsset, type Scene } from "@threert/scene";
import {
  children,
  ecefToGeodetic,
  geodeticToEcef,
  keyOf,
  latToTileY,
  lonToTileX,
  readBuildingsExpanded,
  readErtHeader,
  readTerrainExpanded,
  Scheduler,
  tileAt,
  tileBounds,
  tileSize,
  type ErtHeader,
  type Frame,
  type V3,
} from "../../packages/core/src/index.ts";
import type { Fetched, Files } from "./source.ts";
import type { Materials } from "./materials.ts";

export interface Meta {
  v: number;
  gen: string;
  terrain: { maxZoom: number; n: number; skirt: number };
  buildings: { zoom: number; regions?: { name: string; bbox: number[] }[] };
}

interface Tile {
  id: string; // "t:z/x/y" | "b:z/x/y"
  z: number;
  key: string;
  path: string;
  url: string;
  state: "wanted" | "fetched" | "ready" | "empty";
  meshes: Mesh[];
  center?: V3;
  /** Terrain: positions (relative to center), grid n, for heights. */
  positions?: Float32Array;
  n?: number;
  tris: number;
  bytes: number;
  priority: number;
  job?: { header: ErtHeader; bodyAt: number; cursor: number };
}

/** Triangles a mesh of a large tile (a part, made in a frame: the script loops over its indices once). */
const PART_TRIS = 8_000;
const EMPTY = new Float32Array(0);
const EMPTY_INDEX = new Uint32Array(0);

/** The file of a URL under the asset root: `cache/<host>/<path>` (the app's map writes the same: SPEC § 6.2). */
export function cachePath(url: string): string {
  const m = /^https?:\/\/([^/?#]+)([^?#]*)/.exec(url);
  if (!m) throw new Error(`not a URL: ${url}`);
  return `cache/${m[1].replace(/:/g, "_")}${m[2]}`;
}

export class Surroundings {
  meta: Meta | null = null;
  base = "";
  /** Radius of full detail (z14 terrain and buildings), m; the rings beyond go to `horizon`. */
  radius = 1500;
  horizon = 120_000;
  buildings = true;
  budget = { tris: 60_000, objects: 12, ms: 5 };
  stats = { total: 0, done: 0, bytes: 0, tris: 0, maxAddMs: 0 };

  private tiles = new Map<string, Tile>();
  private queue: Tile[] = [];
  private sched: Scheduler<Fetched>;
  private fresh: Mesh[] = [];
  private frame: Frame | null = null;
  /** Buildings within this circle (the place's frame, xz) cut out: the place replaces them. */
  cut: { x: number; z: number; r: number } | null = null;

  constructor(private scene: Scene, private mats: Materials, public files: Files) {
    this.sched = new Scheduler<Fetched>({ get: (id, signal) => { const t = this.tiles.get(id)!; return this.files.get(t.url, t.path, signal); } }, 16);
  }

  setMeta(meta: Meta, base: string) {
    this.meta = meta;
    this.base = base.replace(/\/$/, "");
  }

  /** The cover about an anchor: tile ids, nearest (and finest) first. */
  private cover(lat: number, lon: number): { key: string; z: number; d: number }[] {
    const maxZ = this.meta!.terrain.maxZoom;
    const anchor = geodeticToEcef(lat, lon, 0);
    const out: { key: string; z: number; d: number }[] = [];
    const dist = (k: { z: number; x: number; y: number }) => {
      // the nearest point of the tile to the anchor, on the ellipsoid
      const b = tileBounds(k);
      const la = Math.min(b.north, Math.max(b.south, lat)), lo = Math.min(b.east, Math.max(b.west, lon));
      const p = geodeticToEcef(la, lo, 0);
      return Math.hypot(p[0] - anchor[0], p[1] - anchor[1], p[2] - anchor[2]);
    };
    // a tile is refined while it is nearer than this many of its own sizes (z14 inside the radius)
    const visit = (k: { z: number; x: number; y: number }) => {
      const d = dist(k);
      if (d > this.horizon) return;
      const size = tileSize(k);
      const fine = k.z >= maxZ || (d > this.radius && d > size * 1.5);
      if (fine) {
        out.push({ key: keyOf(k), z: k.z, d });
        return;
      }
      for (const c of children(k)) visit(c);
    };
    // (from the z6 tiles about the anchor: the horizon is far inside one level-6 tile's neighbours)
    const z0 = 6, c = tileAt(lat, lon, z0), n = 2 ** z0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const y = c.y + dy;
      if (y >= 0 && y < n) visit({ z: z0, x: (((c.x + dx) % n) + n) % n, y });
    }
    out.sort((a, b) => a.d - b.d);
    return out;
  }

  /** Opens the surroundings of a place whose frame is `frame`, about lat, lon (its anchor, or for a city where the
   *  camera is: `center` moves them later). */
  open(frame: Frame, lat: number, lon: number) {
    this.close();
    this.frame = frame;
    this.stats = { total: 0, done: 0, bytes: 0, tris: 0, maxAddMs: 0 };
    this.center(lat, lon);
  }

  /** Where the cover is about. */
  at: { lat: number; lon: number } | null = null;

  /** The cover about another point: tiles it no longer needs go, the ones it now needs are asked for. */
  center(lat: number, lon: number) {
    if (!this.meta || !this.frame) return;
    this.at = { lat, lon };
    const gen = this.meta.gen, bz = this.meta.buildings.zoom;
    const next = new Map<string, { layer: "t" | "b"; key: string; z: number; priority: number }>();
    for (const c of this.cover(lat, lon)) {
      next.set(`t:${c.key}`, { layer: "t", key: c.key, z: c.z, priority: 1e6 - c.d });
      if (this.buildings && c.z === bz && c.d < this.radius) next.set(`b:${c.key}`, { layer: "b", key: c.key, z: c.z, priority: 1e6 - c.d - 1 });
    }
    for (const [id, t] of this.tiles) {
      if (next.has(id)) continue;
      for (const m of t.meshes) m.parent?.remove(m);
      this.tiles.delete(id);
      if (t.state === "ready" || t.state === "empty") this.stats.done--;
      this.stats.total--;
    }
    this.queue = this.queue.filter((t) => this.tiles.has(t.id));
    for (const [id, n] of next) {
      const old = this.tiles.get(id);
      if (old) {
        old.priority = n.priority;
        continue;
      }
      const url = `${this.base}/tiles/v1/${gen}/${n.layer === "t" ? "terrain" : "buildings"}/${n.key}.x.ert`;
      this.tiles.set(id, { id, z: n.z, key: n.key, url, path: cachePath(url), state: "wanted", meshes: [], tris: 0, bytes: 0, priority: n.priority });
      this.stats.total++;
    }
    const want = [...this.tiles.values()].filter((t) => t.state === "wanted").map((t) => ({ id: t.id, url: t.id, priority: t.priority }));
    this.sched.want(want);
  }

  /** Every tile out of the scene. */
  close() {
    for (const t of this.tiles.values()) for (const m of t.meshes) m.parent?.remove(m);
    this.tiles.clear();
    this.queue = [];
    this.sched.want([]);
    this.fresh = [];
  }

  /** Once a frame: what arrived goes in within the budget. */
  update() {
    // (the script's copies of last frame's arrays go: the engine has them)
    for (const m of this.fresh) {
      const g = m.geometry as BufferGeometry;
      for (const a of Object.values(g.attributes)) a.array = EMPTY;
      g.index = EMPTY_INDEX;
    }
    this.fresh.length = 0;
    for (const r of this.sched.take()) {
      const t = this.tiles.get(r.id);
      if (!t || t.state === "ready") continue;
      if (r.error !== undefined || !r.result || r.result.status !== 200) {
        t.state = "empty";
        this.stats.done++;
      } else {
        t.state = "fetched";
        this.queue.push(t);
      }
    }
    if (!this.queue.length) return;
    this.queue.sort((a, b) => b.priority - a.priority);
    const t0 = Date.now(), until = t0 + this.budget.ms;
    let tris = this.budget.tris, objects = this.budget.objects, n = 0;
    while (this.queue.length && objects > 0 && (n === 0 || (tris > 0 && Date.now() < until))) {
      const t = this.queue[0];
      let made = 0;
      try {
        made = this.make(t);
      } catch (e) {
        console.log(`traced: ${t.id}: ${(e as Error).message}`);
        t.state = "empty";
      }
      if (t.state !== "fetched") {
        this.queue.shift();
        this.stats.done++;
      }
      tris -= made;
      objects--;
      n++;
    }
    this.stats.maxAddMs = Math.max(this.stats.maxAddMs, Date.now() - t0);
  }

  /** All tiles in (or given up). */
  get complete() {
    return this.stats.total > 0 && this.stats.done >= this.stats.total;
  }

  /**
   * The file → meshes; the triangles added. Up to PART_TRIS triangles: one mesh whose arrays are views of the file.
   * Larger (a city's buildings: 14,000 in one z14 tile of Kyoto, 190 k triangles, 25 MB): in parts over frames, each a
   * ranged read of a slice of the index and of the vertices it names (a building's are together), made relative.
   */
  private make(t: Tile): number {
    if (!t.job) {
      const L = new DataView(readAsset(t.path, 0, 8)).getUint32(4, true);
      const { header, bodyAt } = readErtHeader(new Uint8Array(readAsset(t.path, 0, 8 + L)));
      const idx = header.chunks.idx;
      t.center = header.center;
      if (!idx || idx.count / 3 <= PART_TRIS) return this.makeWhole(t);
      t.job = { header, bodyAt, cursor: 0 };
    }
    const { header, bodyAt } = t.job;
    const c = header.chunks;
    const at = t.job.cursor, n = Math.min(PART_TRIS * 3, c.idx.count - at);
    const src = new Uint32Array(readAsset(t.path, bodyAt + c.idx.offset + at * 4, n * 4));
    let lo = 0xffffffff, hi = 0;
    for (let i = 0; i < n; i++) {
      const v = src[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    for (let i = 0; i < n; i++) src[i] -= lo;
    const vn = hi - lo + 1;
    const read = (name: string, k: number) => new Float32Array(readAsset(t.path, bodyAt + c[name].offset + lo * k * 4, vn * k * 4));
    this.addMesh(t, read("pos", 3), read("nrm", 3), read("uv", 2), read("col", 3), src);
    t.bytes += vn * 44 + n * 4;
    t.tris += n / 3;
    this.stats.bytes += vn * 44 + n * 4;
    t.job.cursor += n;
    if (t.job.cursor >= c.idx.count) {
      t.job = undefined;
      t.state = "ready";
    }
    return n / 3;
  }

  private makeWhole(t: Tile): number {
    const buf = readAsset(t.path);
    const isT = t.id[0] === "t";
    const m = isT ? readTerrainExpanded(buf) : readBuildingsExpanded(buf);
    t.center = m.center;
    this.addMesh(t, m.positions, m.normals, m.uvs, m.colors, m.index);
    t.tris = m.index.length / 3;
    t.bytes = buf.byteLength;
    this.stats.bytes += buf.byteLength;
    if (isT) {
      t.positions = (m as ReturnType<typeof readTerrainExpanded>).positions.slice();
      t.n = (m as ReturnType<typeof readTerrainExpanded>).n;
    }
    t.state = "ready";
    return t.tris;
  }

  private addMesh(t: Tile, pos: Float32Array, nrm: Float32Array, uv: Float32Array, col: Float32Array, index: Uint32Array) {
    const g = new BufferGeometry();
    g.positions = pos;
    g.normals = nrm;
    g.uvs = uv;
    g.setAttribute("color", new BufferAttribute(col, 3));
    g.index = index;
    const isB = t.id[0] === "b";
    const mesh = new Mesh(g, !isB ? this.mats.terrain : this.cutsTile(t) ? this.mats.buildingsCut : this.mats.buildings);
    mesh.name = t.id;
    const f = this.frame!;
    const p = f.point(t.center!);
    const q = f.quat;
    mesh.position.set(p[0], p[1], p[2]);
    mesh.quaternion.set(q[0], q[1], q[2], q[3]);
    t.meshes.push(mesh);
    this.fresh.push(mesh);
    this.scene.add(mesh);
    this.stats.tris += index.length / 3;
  }

  /** A buildings tile that meets the place's cut circle takes the cut-out material. */
  private cutsTile(t: Tile): boolean {
    if (!this.cut || !t.center) return false;
    const p = this.frame!.point(t.center);
    return Math.hypot(p[0] - this.cut.x, p[2] - this.cut.z) < this.cut.r + 2500;
  }

  /** Terrain height (m above the ellipsoid) at a point, from the finest tile there that is in; NaN where none is. */
  heightAt(lat: number, lon: number): number {
    if (!this.meta) return NaN;
    for (let z = this.meta.terrain.maxZoom; z >= 0; z--) {
      const k = tileAt(lat, lon, z);
      const t = this.tiles.get(`t:${z}/${k.x}/${k.y}`);
      if (!t || t.state !== "ready" || !t.positions) continue;
      const n = t.n!;
      const fx = (lonToTileX(lon, z) - k.x) * (n - 1), fy = (latToTileY(lat, z) - k.y) * (n - 1);
      const j0 = Math.min(n - 2, Math.max(0, Math.floor(fx))), i0 = Math.min(n - 2, Math.max(0, Math.floor(fy)));
      const tx = fx - j0, ty = fy - i0, P = t.positions, c = t.center!;
      const hAt = (i: number, j: number) => {
        const v = 3 * (i * n + j);
        return ecefToGeodetic(P[v] + c[0], P[v + 1] + c[1], P[v + 2] + c[2]).h;
      };
      return (hAt(i0, j0) * (1 - tx) + hAt(i0, j0 + 1) * tx) * (1 - ty) + (hAt(i0 + 1, j0) * (1 - tx) + hAt(i0 + 1, j0 + 1) * tx) * ty;
    }
    return NaN;
  }

  /** The terrain tile under a point is in (its file read): heights there are the trunk's finest. */
  hasGround(lat: number, lon: number): boolean {
    if (!this.meta) return false;
    const k = tileAt(lat, lon, this.meta.terrain.maxZoom);
    return this.tiles.get(`t:${keyOf(k)}`)?.state === "ready";
  }

  /** The terrain tile under the anchor read at once, if it is in the cache: the place's ground before anything. */
  groundNow(lat: number, lon: number): number {
    if (!this.meta) return NaN;
    const k = tileAt(lat, lon, this.meta.terrain.maxZoom);
    const t = this.tiles.get(`t:${keyOf(k)}`);
    if (t && t.state !== "ready") {
      try {
        readAsset(t.path, 0, 1);
      } catch {
        return NaN;
      }
      this.makeWhole(t);
      this.stats.done++;
      this.queue = this.queue.filter((x) => x !== t);
      // (it may still be in flight: its answer finds it ready)
    }
    return this.heightAt(lat, lon);
  }
}

