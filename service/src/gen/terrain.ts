// A trunk terrain tile (SPEC § 4, compact) from the AWS Terrain Tiles (Terrarium) and a land cover.
//
// Our tile z/x/y has a 65 × 65 grid; the Terrarium tile of the same z has 256 × 256 pixels, so 4 pixels a cell. A
// vertex sits on a pixel corner and takes the mean of the 4 × 4 pixels around it (heights, and the share of water).
// Normals need one more vertex beyond every edge, which reads the neighbouring Terrarium tiles: both sides of an edge
// read the same pixels, so their heights and normals agree.
import {
  encodeTerrainCompact, gridLatLon, gridNormals, tileYToLat, tileSize, enu, MAX_LAT, isCap, keyOf,
  type TileKey,
} from "@earthrt/core";
import { decodePng } from "./png.ts";
import type { Upstream } from "./upstream.ts";
import { albedo, CLS, seaIce, worldCoverClass } from "./albedo.ts";

export const TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
export const TERRARIUM_MAX_Z = 15;
export const N = 65;

/** Land cover at points: ESA WorldCover values (10 … 100), 0 where there is none (the open sea, no data). */
export interface LandCover {
  sample(lons: Float64Array, lats: Float64Array, degPerPixel: number, only?: Uint8Array): Promise<Uint8Array>;
  /** share of bare land in the region about each point (0..1), null when unknown */
  desertShare?(lats: Float64Array, lons: Float64Array): Promise<Float32Array | null>;
  /** source names for the tile's `src` */
  readonly src: string[];
}

/** Lakes whose surface is below sea level (the rule "water below 0 m is the sea, at 0 m" would lift them). */
export const LAKES = [
  { name: "Dead Sea", s: 30.9, n: 31.85, w: 35.3, e: 35.65, h: -430 },
  { name: "Sea of Galilee", s: 32.68, n: 32.93, w: 35.5, e: 35.67, h: -212 },
  { name: "Caspian Sea", s: 36.4, n: 47.3, w: 46.3, e: 55.2, h: -28 },
  { name: "Lake Assal", s: 11.6, n: 11.72, w: 42.35, e: 42.5, h: -155 },
  { name: "Salton Sea", s: 33.0, n: 33.55, w: -116.2, e: -115.5, h: -71 },
  { name: "Kati Thanda–Lake Eyre", s: -29.7, n: -27.8, w: 136.7, e: 138.0, h: -15 },
];
export function lakeOf(lat: number, lon: number) {
  for (const l of LAKES) if (lat >= l.s && lat <= l.n && lon >= l.w && lon <= l.e) return l;
  return null;
}

/** Terrarium tile → heights in metres (256 × 256), null where the tile is missing. */
/** Japan's GSI DEM (10 m, "dem_png", z ≤ 14; numerical value × 0.01 m, 2²³ = no data): finer than Terrarium there. */
export const GSI = "https://cyberjapandata.gsi.go.jp/xyz/dem_png";
const GSI_MIN_Z = 8;
const inGsi = (z: number, x: number, y: number) => {
  if (z < GSI_MIN_Z || z > 14) return false;
  const w = (x / 2 ** z) * 360 - 180, e = ((x + 1) / 2 ** z) * 360 - 180, n = tileYToLat(y, z), s = tileYToLat(y + 1, z);
  return e > 122 && w < 154 && n > 20 && s < 46;
};

/** Heights of a source tile (256²): Terrarium, with GSI's pixels where it has data. `used` collects source names. */
export async function sourceHeights(up: Upstream, z: number, x: number, y: number, used?: Set<string>): Promise<Float32Array | null> {
  const [t, g] = await Promise.all([terrariumHeights(up, z, x, y), inGsi(z, x, y) ? up.get(`${GSI}/${z}/${x}/${y}.png`) : Promise.resolve(null)]);
  if (t) used?.add("terrarium");
  if (!t || !g) return t;
  let img;
  try { img = await decodePng(g); } catch { return t; }
  if (img.width !== 256 || img.height !== 256) return t;
  const d = img.data, c = img.channels;
  let any = false;
  for (let i = 0; i < 256 * 256; i++) {
    const v = d[i * c] * 65536 + d[i * c + 1] * 256 + d[i * c + 2];
    if (v === 8388608) continue;
    t[i] = (v < 8388608 ? v : v - 16777216) * 0.01;
    any = true;
  }
  if (any) used?.add("gsi");
  return t;
}

export async function terrariumHeights(up: Upstream, z: number, x: number, y: number): Promise<Float32Array | null> {
  const png = await up.get(`${TERRARIUM}/${z}/${x}/${y}.png`);
  if (!png) return null;
  const img = await decodePng(png);
  const { width, height, channels, data } = img;
  if (width !== 256 || height !== 256) throw new Error(`terrarium ${z}/${x}/${y}: ${width}×${height}`);
  const out = new Float32Array(256 * 256);
  for (let i = 0; i < 256 * 256; i++) out[i] = data[i * channels] * 256 + data[i * channels + 1] + data[i * channels + 2] / 256 - 32768;
  return out;
}

/** Skirt depth of a tile, m: covers the height steps between levels and the chord's sag over a cell. */
export function skirtFor(key: TileKey, n = N): number {
  const spacing = tileSize(key) / (n - 1);
  return Math.round((Math.min(1.5 * spacing, 3000) + (spacing * spacing) / (4 * 6371000)) * 10) / 10;
}

export interface TerrainTimings { fetch: number; landcover: number; build: number }

/** Pixels around a vertex (each side): 4 × 4 → 2. */
const HALF = 2;

export async function makeTerrainTile(up: Upstream, key: TileKey, lc: LandCover | null, timings?: TerrainTimings): Promise<Uint8Array> {
  if (isCap(key)) return makeCap(up, key.cap, lc, timings);
  const t0 = Date.now();
  const { z, x, y } = key;
  const n = N, step = 256 / (n - 1); // 4 pixels a cell
  const tiles = 2 ** z;
  // the pixel window: from the border vertex west/north (−step) minus HALF to the east/south one plus HALF
  const lo = -step - HALF, hi = 256 + step + HALF; // [lo, hi)
  const W = hi - lo;
  // which Terrarium tiles that needs (x wraps, y clamps at the poles)
  const wrapX = (tx: number) => ((tx % tiles) + tiles) % tiles;
  const clampY = (ty: number) => Math.max(0, Math.min(tiles - 1, ty));
  const want = new Map<string, Promise<Float32Array | null>>();
  const used = new Set<string>();
  for (const dy of [-1, 0, 1]) for (const dx of [-1, 0, 1]) {
    const tx = wrapX(x + dx), ty = clampY(y + dy), k = `${tx}/${ty}`;
    if (!want.has(k)) want.set(k, sourceHeights(up, z, tx, ty, used));
  }
  const got = new Map<string, Float32Array | null>();
  await Promise.all([...want].map(async ([k, p]) => got.set(k, await p)));
  if (!got.get(`${x}/${y}`)) throw new Error(`terrarium ${z}/${x}/${y} missing`);
  const t1 = Date.now();
  // elevations of the window's pixels (global pixel rows clamp at the poles: the row beyond is the edge row again)
  const elev = new Float32Array(W * W);
  const maxRow = tiles * 256 - 1;
  for (let r = 0; r < W; r++) {
    const gy = Math.max(0, Math.min(maxRow, y * 256 + lo + r));
    const ty = gy >> 8, py = gy & 255;
    for (let c = 0; c < W; c++) {
      const gxr = x * 256 + lo + c;
      const gx = ((gxr % (tiles * 256)) + tiles * 256) % (tiles * 256);
      const tx = gx >> 8, px = gx & 255;
      const t = got.get(`${tx}/${ty}`) ?? got.get(`${x}/${y}`)!;
      elev[r * W + c] = t[py * 256 + px];
    }
  }
  // the pixels' centres
  const rowLat = new Float64Array(W), colLon = new Float64Array(W);
  for (let r = 0; r < W; r++) rowLat[r] = tileYToLat(y + (lo + r + 0.5) / 256, z);
  for (let c = 0; c < W; c++) { let lon = ((x + (lo + c + 0.5) / 256) / tiles) * 360 - 180; if (lon >= 180) lon -= 360; if (lon < -180) lon += 360; colLon[c] = lon; }
  const lakeAt = (r: number, c: number) => lakeOf(rowLat[r], colLon[c]);
  const anyLake = LAKES.some((l) => l.s < rowLat[0] && l.n > rowLat[W - 1] && l.w < colLon[W - 1] && l.e > colLon[0]);
  // land cover at them
  let cover: Uint8Array | null = null;
  if (lc) {
    const lons = new Float64Array(W * W), lats = new Float64Array(W * W);
    for (let r = 0; r < W; r++) for (let c = 0; c < W; c++) { lats[r * W + c] = rowLat[r]; lons[r * W + c] = colLon[c]; }
    // the deep sea needs no land cover: only pixels above −40 m are looked up (and every pixel of a low lake)
    const only = new Uint8Array(W * W);
    let any = false;
    for (let r = 0; r < W; r++) for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (elev[i] > -40 || (anyLake && lakeAt(r, c))) { only[i] = 1; any = true; }
    }
    cover = any ? await lc.sample(lons, lats, 360 / tiles / 256, only) : new Uint8Array(W * W);
  }
  const t2 = Date.now();
  // per pixel: is it water, and the surface height
  const isWater = new Uint8Array(W * W), surf = new Float32Array(W * W);
  for (let r = 0; r < W; r++) for (let c = 0; c < W; c++) {
    const i = r * W + c;
    const e = elev[i], v = cover ? cover[i] : 0;
    const lake = anyLake ? lakeAt(r, c) : null;
    let w: boolean;
    if (lake) w = v === 80 || (v === 0 && e <= lake.h + 0.5); // a lake below sea level: its own surface
    else if (v === 80) w = true;
    else if (v === 0) w = e < 0; // no land cover: the sea where it is below sea level
    else w = false; // land, even below sea level (polders)
    isWater[i] = w ? 1 : 0;
    // the sea's surface at 0 m; inland water above sea level at its own height; low lakes at theirs
    surf[i] = !w ? e : lake ? lake.h : e < 0 ? 0 : e;
  }
  // vertices (bordered: (n + 2)²): means over the 4 × 4 pixels about each corner
  const nb = n + 2;
  const bordered = new Float32Array(nb * nb);
  const water = new Uint8Array(n * n), depth = new Float32Array(n * n), cls = new Uint8Array(n * n);
  const counts = new Uint16Array(256);
  for (let i = -1; i <= n; i++) {
    for (let j = -1; j <= n; j++) {
      const r0 = i * step - HALF - lo, c0 = j * step - HALF - lo;
      let s = 0, wsum = 0, dsum = 0;
      const inside = i >= 0 && j >= 0 && i < n && j < n;
      if (inside && cover) counts.fill(0);
      for (let r = r0; r < r0 + 2 * HALF; r++) for (let c = c0; c < c0 + 2 * HALF; c++) {
        const p = r * W + c;
        s += surf[p];
        if (inside) {
          wsum += isWater[p];
          dsum += isWater[p] ? Math.max(0, -elev[p]) : 0;
          if (cover) counts[cover[p]]++;
        }
      }
      const m = (2 * HALF) ** 2;
      bordered[(i + 1) * nb + (j + 1)] = s / m;
      if (inside) {
        const v = i * n + j;
        water[v] = Math.round((wsum / m) * 255);
        depth[v] = wsum ? dsum / wsum : 0;
        if (cover) {
          // the most common class among the land pixels (water decides by its share)
          let best = 0, bc = 0;
          for (let k = 1; k < 256; k++) if (k !== 80 && counts[k] > bc) { bc = counts[k]; best = k; }
          cls[v] = wsum * 2 > m ? CLS.water : worldCoverClass(best);
        } else cls[v] = wsum * 2 > m ? CLS.water : CLS.unknown;
      }
    }
  }
  const heights = new Float32Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) heights[i * n + j] = bordered[(i + 1) * nb + (j + 1)];
  const normals = gridNormals(key, n, bordered);
  const { lats, lons } = gridLatLon(key, n);
  const rgb = new Uint8Array(3 * n * n);
  // where bare land is, the region's share of it (desert sand or patchy rock)
  let share: Float32Array | null = null;
  if (lc?.desertShare) {
    const la = new Float64Array(n * n), lo = new Float64Array(n * n);
    let anyBare = false;
    for (let v = 0; v < n * n; v++) { la[v] = lats[Math.floor(v / n)]; lo[v] = lons[v % n]; if (cls[v] === CLS.bare) anyBare = true; }
    if (anyBare) share = await lc.desertShare(la, lo);
  }
  for (let i = 0; i < n; i++) {
    const { u } = enu(lats[i], 0);
    for (let j = 0; j < n; j++) {
      const v = i * n + j;
      // slope: 1 − the normal's up component (up at this longitude: rotate u by the longitude)
      const lam = (lons[j] * Math.PI) / 180, cl = Math.cos(lam), sl = Math.sin(lam);
      const ux = u[0] * cl - u[1] * sl, uy = u[0] * sl + u[1] * cl, uz = u[2];
      const slope = 1 - (normals[3 * v] * ux + normals[3 * v + 1] * uy + normals[3 * v + 2] * uz);
      const ice = water[v] ? seaIce(lats[i], lons[j]) : 0;
      albedo(cls[v], lats[i], lons[j], heights[v], slope, water[v] / 255, depth[v], rgb, 3 * v, share ? share[v] : -1);
      if (ice > 0) {
        water[v] = Math.round(water[v] * (1 - ice));
        if (ice > 0.5 && cls[v] === CLS.water) cls[v] = CLS.snow;
      }
    }
  }
  const src = [...(used.size ? used : ["terrarium"]), ...(lc ? lc.src : [])];
  const out = encodeTerrainCompact({ key, n, heights, cls, rgb, water, normals, skirt: skirtFor(key, n), src });
  if (timings) { timings.fetch = t1 - t0; timings.landcover = t2 - t1; timings.build = Date.now() - t2; }
  return out;
}

// ------------------------------------------------------------------------------------------------------ polar caps

/** Height of the South Pole's ice surface, m. */
const SOUTH_POLE_H = 2835;

/**
 * A polar cap (north or south of 85.05°): the grid is rings of latitude from the cap's edge to the pole. Mercator
 * sources stop at the edge, so the heights are the edge's (the last Terrarium row of z3) eased toward the pole's: the
 * Arctic Ocean's sea ice in the north, the ice sheet in the south.
 */
async function makeCap(up: Upstream, cap: "n" | "s", lc: LandCover | null, timings?: TerrainTimings): Promise<Uint8Array> {
  const t0 = Date.now();
  const key = { cap } as TileKey;
  const n = N, z = 3, tiles = 8;
  const row = cap === "n" ? 0 : tiles - 1;
  const strips = await Promise.all(Array.from({ length: tiles }, (_, tx) => terrariumHeights(up, z, tx, row)));
  const t1 = Date.now();
  // the edge row of the whole world at z3: 2048 pixels west → east
  const edge = new Float32Array(tiles * 256);
  for (let tx = 0; tx < tiles; tx++) for (let px = 0; px < 256; px++) edge[tx * 256 + px] = strips[tx]?.[(cap === "n" ? 0 : 255) * 256 + px] ?? 0;
  const edgeAt = (lon: number) => {
    const g = ((lon + 180) / 360) * edge.length;
    let s = 0, k = 0;
    for (let d = -16; d < 16; d++) { s += edge[(((Math.floor(g) + d) % edge.length) + edge.length) % edge.length]; k++; }
    return s / k;
  };
  const { lats, lons } = gridLatLon(key, n);
  const nb = n + 2;
  const bordered = new Float32Array(nb * nb);
  const latAt = (i: number) => (i < 0 ? 2 * lats[0] - lats[1] : i >= n ? 2 * lats[n - 1] - lats[n - 2] : lats[i]);
  const lonAt = (j: number) => (j < 0 ? 2 * lons[0] - lons[1] : j >= n ? 2 * lons[n - 1] - lons[n - 2] : lons[j]);
  const hAt = (lat: number, lon: number) => {
    const t = Math.min(1, Math.max(0, (Math.abs(lat) - MAX_LAT) / (90 - MAX_LAT)));
    if (cap === "n") return 0;
    const e = Math.max(0, edgeAt(lon));
    const s = t * t * (3 - 2 * t);
    return e * (1 - s) + SOUTH_POLE_H * s;
  };
  for (let i = -1; i <= n; i++) for (let j = -1; j <= n; j++) bordered[(i + 1) * nb + (j + 1)] = hAt(latAt(i), lonAt(j));
  const heights = new Float32Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) heights[i * n + j] = bordered[(i + 1) * nb + (j + 1)];
  const normals = gridNormals(key, n, bordered);
  // the grid's rows run toward the pole: in the north that is northward, which turns the cross product down
  for (let v = 0; v < n * n; v++) {
    const i = Math.floor(v / n), j = v % n;
    const { u } = enu(lats[i], lons[j]);
    if (normals[3 * v] * u[0] + normals[3 * v + 1] * u[1] + normals[3 * v + 2] * u[2] < 0) for (let c = 0; c < 3; c++) normals[3 * v + c] *= -1;
  }
  const cls = new Uint8Array(n * n).fill(CLS.snow), water = new Uint8Array(n * n), rgb = new Uint8Array(3 * n * n);
  for (let v = 0; v < n * n; v++) {
    const i = Math.floor(v / n), j = v % n;
    albedo(CLS.snow, lats[i], lons[j], heights[v], 0, 0, 0, rgb, 3 * v);
    if (cap === "n") { rgb[3 * v] = 226; rgb[3 * v + 1] = 232; rgb[3 * v + 2] = 240; }
  }
  const out = encodeTerrainCompact({ key, n, heights, cls, rgb, water, normals, skirt: 200, src: ["terrarium"] });
  if (timings) { timings.fetch = t1 - t0; timings.landcover = 0; timings.build = Date.now() - t1; }
  void lc; void keyOf;
  return out;
}
