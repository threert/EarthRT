// The trunk's tiles on the web: what the view shows (core selectTiles), what it asks for (core Scheduler, through the
// worker pool), what arrives a frame (UploadBudget), and what the GPU keeps (evictions).
import { heightIn, isCap, keyOf, parseKey, Scheduler, selectTiles, tileAt, tilesInBox, type Request, type TileKey, type View } from "@earthrt/core";
import { evictions, UploadBudget } from "./budget.ts";
import type { PackedBuildings, PackedTerrain, PackedTile } from "./gpu-format.ts";
import type { TilePool } from "./pool.ts";

export interface TileMeta {
  v: number;
  gen: string;
  terrain: { maxZoom: number; n: number; skirt: number };
  buildings: { zoom: number; regions: { name: string; bbox: number[] }[] };
  attribution: string[];
}

export interface TileSource {
  meta: TileMeta;
  /** URL of a tile; dev tiles are `dev:terrain/<key>`. */
  url(layer: "terrain" | "buildings", key: string): string;
  /** Cache Storage name (versioned by gen), or null for no caching. */
  cache: string | null;
  dev: boolean;
}

export interface Entry<O> {
  id: string;
  layer: "terrain" | "buildings";
  key: string;
  bytes: number;
  lastUsed: number;
  minH: number;
  maxH: number;
  n: number;
  heights?: Float32Array;
  /** The renderer's object (absent for empty buildings tiles). */
  object?: O;
}

export interface Renderer<O> {
  createTerrain(t: PackedTerrain): O;
  createBuildings(t: PackedBuildings): O;
  dispose(o: O): void;
}

export interface FrameResult<O> {
  terrain: Entry<O>[];
  buildings: Entry<O>[];
  /** Screen-space error of each shown terrain tile. */
  sse: Map<string, number>;
  /** Shown terrain tiles whose error is well above the threshold (detail still on its way). */
  coarse: number;
  /** No tile at all could be shown (the top levels not there yet). */
  hole: boolean;
}

export interface Stats {
  shown: number;
  buildingsShown: number;
  inFlight: number;
  queued: number;
  resident: number;
  gpuBytes: number;
  netBytes: number;
  requests: number;
  cacheHits: number;
  decodeMs: number;
  decoded: number;
  /** Latency of each network response, ms (the probe takes percentiles). */
  latencies: number[];
  uploadsLastFrame: number;
  failures: number;
  lastErrors: string[];
}

export interface UpdateOptions {
  threshold: number;
  /** Extra views a flight will need soon: fetched at a lower priority, kept from eviction. */
  lookahead?: View[];
  /** A zoom the terrain must reach in a region whatever its error (under a city's tiles: SPEC § 5). */
  minZoom?: (k: { z: number; x: number; y: number }) => number;
}

const T = (k: string) => `t:${k}`;
const B = (k: string) => `b:${k}`;

export class TileManager<O> {
  readonly entries = new Map<string, Entry<O>>();
  private readonly scheduler: Scheduler<PackedTile>;
  private readonly upload = new UploadBudget();
  private readonly arrived: (PackedTile & { id: string })[] = [];
  private frame = 0;
  private lowUrls = new Set<string>();
  gpuBytes = 0;
  gpuBudget: number;
  /** Called when the service answers 404 (its generation moved on: read meta.json again). */
  onStale: (() => void) | null = null;
  readonly stats: Stats = { shown: 0, buildingsShown: 0, inFlight: 0, queued: 0, resident: 0, gpuBytes: 0, netBytes: 0, requests: 0, cacheHits: 0, decodeMs: 0, decoded: 0, latencies: [], uploadsLastFrame: 0, failures: 0, lastErrors: [] };

  constructor(public source: TileSource, private readonly pool: TilePool, private readonly renderer: Renderer<O>, gpuBudget: number, maxInFlight = 12) {
    this.gpuBudget = gpuBudget;
    this.scheduler = new Scheduler<PackedTile>({
      get: (url, signal) => {
        const layer = url.includes("/buildings/") ? "buildings" : "terrain";
        const low = this.lowUrls.has(url);
        this.stats.requests++;
        return this.pool.get(url, layer, source.cache, low ? "low" : "high", signal);
      },
    }, maxInFlight);
  }

  /** Tiles from the top pack (or any batch), ready at once without the per-frame budget. */
  addBatch(tiles: PackedTile[]) {
    for (const t of tiles) this.install(t.kind === "buildings" ? B(t.key) : T(t.key), t);
  }

  private install(id: string, t: PackedTile) {
    if (this.entries.has(id)) return;
    let object: O | undefined;
    let bytes = 0, minH = 0, maxH = 0, n = 0, heights: Float32Array | undefined;
    if (t.kind === "terrain") {
      object = this.renderer.createTerrain(t);
      bytes = t.bytes; minH = t.minH; maxH = t.maxH; n = t.n; heights = t.heights;
    } else if (t.kind === "buildings") {
      object = this.renderer.createBuildings(t);
      bytes = t.bytes;
    } else if (id.startsWith("t:")) return; // (a terrain tile must have data)
    this.entries.set(id, { id, layer: id.startsWith("t:") ? "terrain" : "buildings", key: id.slice(2), bytes, lastUsed: this.frame, minH, maxH, n, heights, object });
    this.gpuBytes += bytes;
    if (t.kind !== "empty") {
      this.stats.decodeMs += t.decodeMs;
      this.stats.decoded++;
    }
  }

  private buildingsWanted(k: TileKey): boolean {
    if (isCap(k)) return false;
    const { zoom, regions } = this.source.meta.buildings;
    if (k.z !== zoom || !regions?.length) return false;
    const lon = ((k.x + 0.5) / 2 ** k.z) * 360 - 180;
    const n = Math.PI - (2 * Math.PI * (k.y + 0.5)) / 2 ** k.z;
    const lat = (Math.atan(Math.sinh(n)) * 180) / Math.PI;
    return regions.some((r) => lon >= r.bbox[0] && lat >= r.bbox[1] && lon <= r.bbox[2] && lat <= r.bbox[3]);
  }

  update(view: View, opt: UpdateOptions): FrameResult<O> {
    this.frame++;
    const info = (key: string) => {
      const e = this.entries.get(T(key));
      return e ? { ready: true, minH: e.minH, maxH: e.maxH } : undefined;
    };
    const maxZoom = this.source.meta.terrain.maxZoom;
    const sel = selectTiles(view, { threshold: opt.threshold, maxZoom, info, minZoom: opt.minZoom });
    for (const k of sel.touched) {
      const e = this.entries.get(T(k));
      if (e) e.lastUsed = this.frame;
    }
    const requests: Request[] = sel.want.map((w) => ({ id: T(keyOf(w.key)), url: this.source.url("terrain", keyOf(w.key)), priority: w.priority }));
    // buildings: for every shown tile at the buildings' zoom, below the terrain in priority
    const buildings: Entry<O>[] = [];
    for (const k of sel.show) {
      if (!this.buildingsWanted(k)) continue;
      const key = keyOf(k), e = this.entries.get(B(key));
      if (e) {
        e.lastUsed = this.frame;
        if (e.object) buildings.push(e);
      } else requests.push({ id: B(key), url: this.source.url("buildings", key), priority: (sel.sse.get(key) ?? 1) * 0.5 });
    }
    // a flight's look-ahead: what it will show soon, at a fraction of the priority
    const ahead = new Set<string>();
    for (const [i, v] of (opt.lookahead ?? []).entries()) {
      const s = selectTiles(v, { threshold: opt.threshold * 1.5, maxZoom, info });
      for (const k of s.touched) {
        const e = this.entries.get(T(k));
        if (e) e.lastUsed = this.frame;
      }
      for (const w of s.want) {
        const id = T(keyOf(w.key));
        if (ahead.has(id) || requests.some((r) => r.id === id)) continue;
        ahead.add(id);
        // ranked with the view's own by screen error, discounted by how far ahead: a tile the next seconds need badly
        // (a coarse level over a new region) goes before fine detail the view merely wants
        requests.push({ id, url: this.source.url("terrain", keyOf(w.key)), priority: (w.priority * 0.6) / (1 + 0.25 * i) });
      }
    }
    this.lowUrls = new Set(requests.filter((r) => ahead.has(r.id)).map((r) => r.url));
    // (not what is here already, nor what arrived and waits for its upload)
    const waiting = new Set(this.arrived.map((a) => a.id));
    this.scheduler.want(requests.filter((r) => !this.entries.has(r.id) && !waiting.has(r.id)), (id) => ahead.has(id) || waiting.has(id));
    // arrivals
    for (const r of this.scheduler.take()) {
      if (r.error !== undefined) {
        if ((r.error as Error).message !== "aborted") {
          this.stats.failures++;
          if ((r.error as { status?: number }).status === 404) this.onStale?.();
          if (this.stats.lastErrors.length < 20) this.stats.lastErrors.push(`${r.id}: ${(r.error as Error).message}`);
        }
        continue;
      }
      const t = r.result!;
      this.stats.netBytes += t.netBytes;
      if (t.cached) this.stats.cacheHits++;
      else this.stats.latencies.push(t.netMs);
      if (this.entries.has(r.id) || this.arrived.some((a) => a.id === r.id)) continue;
      this.arrived.push({ ...t, id: r.id, bytes: t.kind === "empty" ? 0 : t.bytes } as PackedTile & { id: string });
    }
    // the most wanted first: coarser tiles fill holes sooner
    this.arrived.sort((a, b) => zOf(a.id) - zOf(b.id));
    this.stats.uploadsLastFrame = this.upload.take(this.arrived as (PackedTile & { id: string; bytes: number })[], (t) => this.install(t.id, t));
    // GPU budget
    if (this.gpuBytes > this.gpuBudget) {
      const drop = evictions(this.entries.values(), this.gpuBytes, this.gpuBudget, this.frame, (key) => isTop(key));
      for (const id of drop) this.drop(id);
    }
    const terrain: Entry<O>[] = [];
    // detail the view needs badly and does not have yet (a shown tile 4× coarser than wanted, its children missing)
    const coarse = sel.want.filter((w) => w.priority > opt.threshold * 4).length;
    for (const k of sel.show) {
      const e = this.entries.get(T(keyOf(k)))!;
      terrain.push(e);
    }
    Object.assign(this.stats, {
      shown: terrain.length, buildingsShown: buildings.length, inFlight: this.scheduler.pending,
      queued: Math.max(0, requests.length - this.scheduler.pending), resident: this.entries.size, gpuBytes: this.gpuBytes,
    });
    return { terrain, buildings, sse: sel.sse, coarse, hole: terrain.length === 0 };
  }

  private drop(id: string) {
    const e = this.entries.get(id);
    if (!e) return;
    if (e.object) this.renderer.dispose(e.object);
    this.gpuBytes -= e.bytes;
    this.entries.delete(id);
  }

  /** Terrain height (m above the ellipsoid) at a point, from the finest tile there; NaN if none. */
  groundAt(lat: number, lon: number): number {
    const maxZ = this.source.meta.terrain.maxZoom;
    for (let z = maxZ; z >= 0; z--) {
      const k = tileAt(lat, lon, z);
      const e = this.entries.get(T(keyOf(k)));
      if (e?.heights) {
        const h = heightIn({ heights: e.heights, n: e.n } as never, k, lat, lon);
        if (Number.isFinite(h)) return h;
      }
    }
    return NaN;
  }

  /** Finest loaded zoom at a point (how much the camera's floor can be trusted). */
  zoomAt(lat: number, lon: number): number {
    for (let z = this.source.meta.terrain.maxZoom; z >= 0; z--) if (this.entries.has(T(keyOf(tileAt(lat, lon, z))))) return z;
    return -1;
  }

  /** Tile keys of a zoom in a box that are loaded (tests, the probe). */
  loadedIn(box: { west: number; south: number; east: number; north: number }, z: number) {
    return tilesInBox(box, z).filter((k) => this.entries.has(T(keyOf(k)))).length;
  }

  wants(id: string) { return this.scheduler.isInFlight(id); }
}

const zOf = (id: string) => {
  const k = id.slice(2);
  if (k.startsWith("cap")) return 0;
  return (id.startsWith("b:") ? 100 : 0) + (parseKey(k) as { z: number }).z;
};
/** z0–z2 and the caps (the top pack) stay resident. */
const isTop = (id: string) => {
  const k = id.slice(2);
  return id.startsWith("t:") && (k.startsWith("cap") || Number(k.split("/")[0]) <= 2);
};
