// A trunk buildings tile (SPEC § 4, compact) from OpenStreetMap via Protomaps basemap extracts (PMTiles in R2): the
// `buildings` layer of the four z15 vector tiles under our z14 tile, each piece clipped to its z15 tile so pieces of a
// building cut by a tile edge abut instead of overlapping, standing on the lowest terrain under its footprint.
import { PMTiles, type Source, type RangeResponse } from "pmtiles";
import { VectorTile, classifyRings } from "@mapbox/vector-tile";
import Pbf from "pbf";
import { decodeErt, encodeBuildingsCompact, gridLatLon, tileYToLat, type Building, type TileKey } from "@earthrt/core";
import type { Upstream } from "./upstream.ts";

export const BUILDINGS_ZOOM = 14;
/** the zoom of the vector tiles read (Protomaps' most detailed) */
const MVT_ZOOM = 15;

export interface Region { name: string; bbox: [number, number, number, number]; key: string }

/** Regions with an extract in R2 (`tools/regions.ts` makes and uploads them). bbox: west, south, east, north. */
export const REGIONS: Region[] = [
  { name: "Kyoto–Osaka", bbox: [135.25, 34.45, 135.95, 35.12], key: "kansai" },
  { name: "Tokyo", bbox: [139.35, 35.45, 140.0, 35.86], key: "tokyo" },
  { name: "San Francisco Bay", bbox: [-122.56, 37.2, -121.75, 38.0], key: "sf-bay" },
  { name: "New York City", bbox: [-74.27, 40.48, -73.68, 40.93], key: "nyc" },
  { name: "Shanghai", bbox: [121.15, 30.95, 121.8, 31.45], key: "shanghai" },
  { name: "Paris", bbox: [2.2, 48.76, 2.5, 48.95], key: "paris" },
  { name: "London", bbox: [-0.35, 51.38, 0.15, 51.62], key: "london" },
];
export const regionObject = (r: Region) => `buildings/v1/${r.key}.pmtiles`;

class ObjectSource implements Source {
  constructor(private up: Upstream, private key: string) {}
  getKey() { return this.key; }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const b = await this.up.getObjectRange(this.key, offset, length);
    if (!b) throw new Error(`missing object ${this.key}`);
    return { data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer };
  }
}

const archives = new Map<string, PMTiles>();
function archive(up: Upstream, r: Region) {
  let a = archives.get(r.key);
  if (!a) archives.set(r.key, (a = new PMTiles(new ObjectSource(up, regionObject(r)))));
  return a;
}

export function regionsOf(k: { z: number; x: number; y: number }): Region[] {
  const w = (k.x / 2 ** k.z) * 360 - 180, e = ((k.x + 1) / 2 ** k.z) * 360 - 180;
  const n = tileYToLat(k.y, k.z), s = tileYToLat(k.y + 1, k.z);
  return REGIONS.filter((r) => r.bbox[0] < e && r.bbox[2] > w && r.bbox[1] < n && r.bbox[3] > s);
}

// ------------------------------------------------------------------------------------------------------- geometry

type P = { x: number; y: number };

/** Sutherland–Hodgman against [0, ext]²; rings of fewer than 3 points come back empty. */
export function clipRing(ring: P[], ext: number): P[] {
  let pts = ring;
  if (pts.length > 1 && pts[0].x === pts[pts.length - 1].x && pts[0].y === pts[pts.length - 1].y) pts = pts.slice(0, -1);
  const edges: [(p: P) => boolean, (a: P, b: P) => P][] = [
    [(p) => p.x >= 0, (a, b) => ({ x: 0, y: a.y + ((b.y - a.y) * (0 - a.x)) / (b.x - a.x) })],
    [(p) => p.x <= ext, (a, b) => ({ x: ext, y: a.y + ((b.y - a.y) * (ext - a.x)) / (b.x - a.x) })],
    [(p) => p.y >= 0, (a, b) => ({ x: a.x + ((b.x - a.x) * (0 - a.y)) / (b.y - a.y), y: 0 })],
    [(p) => p.y <= ext, (a, b) => ({ x: a.x + ((b.x - a.x) * (ext - a.y)) / (b.y - a.y), y: ext })],
  ];
  for (const [inside, cut] of edges) {
    if (pts.length < 3) return [];
    const out: P[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i];
      const ia = inside(a), ib = inside(b);
      if (ib) { if (!ia) out.push(cut(a, b)); out.push(b); }
      else if (ia) out.push(cut(a, b));
    }
    pts = out;
  }
  // drop repeated points
  const clean: P[] = [];
  for (const p of pts) { const q = clean[clean.length - 1]; if (!q || q.x !== p.x || q.y !== p.y) clean.push(p); }
  if (clean.length > 1 && clean[0].x === clean[clean.length - 1].x && clean[0].y === clean[clean.length - 1].y) clean.pop();
  return clean.length >= 3 ? clean : [];
}

const area = (r: P[]) => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p.x * q.y - q.x * p.y; } return a / 2; };

/** A 32-bit hash of a number pair (stable colours and heights). */
function hash2(a: number, b: number) {
  let h = (Math.imul(Math.round(a * 1e6) | 0, 374761393) ^ Math.imul(Math.round(b * 1e6) | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// OSM building=* → kind (SPEC § 4)
const KIND: Record<string, number> = {
  house: 1, detached: 1, semidetached_house: 1, terrace: 1, bungalow: 1, residential: 2, apartments: 2, dormitory: 2,
  commercial: 3, retail: 3, office: 3, hotel: 3, supermarket: 3, industrial: 4, warehouse: 4, factory: 4, manufacture: 4,
  church: 5, temple: 5, shrine: 5, mosque: 5, cathedral: 5, chapel: 5, synagogue: 5, religious: 5,
  civic: 6, public: 6, school: 6, university: 6, hospital: 6, government: 6, train_station: 6, transportation: 6, college: 6, kindergarten: 6,
  tower: 7, skyscraper: 7,
};

type RGB = [number, number, number];
const WALLS: Record<number, RGB[]> = {
  0: [[196, 190, 180], [176, 170, 162], [210, 204, 194], [160, 156, 150]],
  1: [[214, 204, 186], [190, 176, 156], [226, 220, 208], [172, 150, 128]],
  2: [[206, 200, 190], [186, 184, 180], [220, 214, 200], [168, 160, 152]],
  3: [[170, 180, 190], [150, 160, 172], [196, 198, 200], [128, 138, 150]],
  4: [[176, 172, 164], [150, 152, 150], [196, 190, 176], [132, 128, 122]],
  5: [[190, 160, 120], [150, 74, 52], [216, 206, 186], [120, 96, 76]],
  6: [[204, 196, 182], [184, 172, 156], [214, 210, 204], [170, 160, 146]],
  7: [[150, 168, 186], [124, 140, 160], [176, 188, 198], [100, 116, 134]],
};
const ROOFS: Record<number, RGB[]> = {
  0: [[132, 128, 124], [112, 110, 108], [150, 144, 136]],
  1: [[92, 88, 86], [128, 74, 58], [74, 78, 86], [150, 140, 128]],
  2: [[140, 138, 134], [120, 120, 118], [160, 156, 150]],
  3: [[128, 130, 132], [104, 108, 112], [150, 150, 148]],
  4: [[150, 152, 154], [124, 128, 130], [172, 170, 166]],
  5: [[70, 74, 72], [96, 104, 96], [120, 70, 52]],
  6: [[120, 118, 114], [104, 108, 106], [138, 134, 126]],
  7: [[110, 116, 122], [90, 96, 104]],
};
const pick = <T>(a: T[], u: number) => a[Math.min(a.length - 1, Math.floor(u * a.length))];

/** Height of a building from its tags, else a plausible default (by kind and footprint, varied by a hash). */
export function buildingHeight(props: Record<string, unknown>, kind: number, footprintM2: number, u: number): { height: number; minHeight: number } {
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN);
  let h = num(props.height);
  const levels = num(props["building:levels"] ?? props.levels);
  if (!(h > 0) && levels > 0) h = levels * 3.2 + 1;
  if (!(h > 0)) {
    const side = Math.sqrt(Math.max(1, footprintM2));
    if (kind === 1) h = 5.5 + u * 3.5;
    else if (kind === 4) h = 7 + u * 5;
    else if (kind === 5) h = 9 + u * 8;
    else if (kind === 7) h = 30 + u * 30;
    else h = Math.min(36, 5 + side * 0.22 + u * 6);
  }
  const mh = num(props.min_height ?? props["min_height"]);
  return { height: Math.min(828, h), minHeight: mh > 0 && mh < h ? mh : 0 };
}

/** Terrain heights of a compact tile, sampled bilinearly (rows uniform in Mercator). */
function terrainSampler(compact: Uint8Array, key: { z: number; x: number; y: number }) {
  const e = decodeErt(compact);
  const n = e.header.n!, minH = e.header.minH!, range = e.header.maxH! - minH, h = e.chunks.h as Uint16Array;
  const H = (i: number, j: number) => minH + (h[i * n + j] / 65535) * range;
  const { lons } = gridLatLon(key, n);
  return (lat: number, lon: number) => {
    const fj = Math.max(0, Math.min(n - 1.0001, ((lon - lons[0]) / (lons[n - 1] - lons[0])) * (n - 1)));
    const my = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const ty = (1 - my / Math.PI) / 2 * 2 ** key.z - key.y;
    const fi = Math.max(0, Math.min(n - 1.0001, ty * (n - 1)));
    const i0 = Math.floor(fi), j0 = Math.floor(fj), a = fi - i0, b = fj - j0;
    return (H(i0, j0) * (1 - b) + H(i0, j0 + 1) * b) * (1 - a) + (H(i0 + 1, j0) * (1 - b) + H(i0 + 1, j0 + 1) * b) * a;
  };
}

// ------------------------------------------------------------------------------------------------- context

/** What a building's surroundings say about it: the POIs inside or near it, the landuse under it. */
type Poi = { x: number; y: number; kind: number; detail: string };
interface Context {
  pois: Poi[];
  /** POIs by cell (CELL tile units square) */
  grid: Map<number, Poi[]>;
  worship: Poi[];
  landuse: { kind: number; box: [number, number, number, number]; rings: P[][] }[];
}

// POI kinds → building kind
const POI_KIND: Record<string, number> = {
  place_of_worship: 5, hotel: 3, guest_house: 3, hostel: 3, department_store: 3, mall: 3, supermarket: 3, cinema: 3, theatre: 6,
  school: 6, university: 6, college: 6, hospital: 6, clinic: 6, townhall: 6, library: 6, museum: 6, police: 6, fire_station: 6,
  post_office: 6, train_station: 6, station: 6, kindergarten: 6, office: 3, bank: 3,
};
// landuse kinds → building kind
const LANDUSE_KIND: Record<string, number> = {
  industrial: 4, commercial: 3, retail: 3, school: 6, university: 6, college: 6, kindergarten: 6, hospital: 6,
  residential: 2, railway: 6, military: 6, cemetery: 5, religious: 5,
};

function context(vt: VectorTile): Context {
  const c: Context = { pois: [], grid: new Map(), worship: [], landuse: [] };
  const P = vt.layers.pois;
  if (P) for (let i = 0; i < P.length; i++) {
    const f = P.feature(i), pr = f.properties as Record<string, unknown>;
    const k = POI_KIND[String(pr.kind)];
    if (k === undefined || f.type !== 1) continue;
    const g = f.loadGeometry()[0]?.[0];
    if (!g) continue;
    const poi = { x: g.x, y: g.y, kind: k, detail: String(pr.kind_detail ?? pr.kind) };
    c.pois.push(poi);
    if (k === 5) c.worship.push(poi);
    const cell = cellOf(g.x, g.y);
    (c.grid.get(cell) ?? c.grid.set(cell, []).get(cell)!).push(poi);
  }
  const L = vt.layers.landuse;
  if (L) for (let i = 0; i < L.length; i++) {
    const f = L.feature(i), k = LANDUSE_KIND[String((f.properties as Record<string, unknown>).kind)];
    if (k === undefined || f.type !== 3) continue;
    for (const poly of classifyRings(f.loadGeometry() as never) as P[][][]) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of poly[0]) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
      c.landuse.push({ kind: k, box: [x0, y0, x1, y1], rings: poly });
    }
  }
  return c;
}

const CELL = 128;
const cellOf = (x: number, y: number) => (Math.floor(y / CELL) + 64) * 1024 + Math.floor(x / CELL) + 64;

function inRing(ring: P[], x: number, y: number) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
const inPoly = (poly: P[][], x: number, y: number) => inRing(poly[0], x, y) && !poly.slice(1).some((h) => inRing(h, x, y));

/** The kind of an untagged building: a POI inside it, a place of worship near a large one, the landuse, its size. */
function inferKind(c: Context, poly: P[][], cx: number, cy: number, areaM2: number, unitsPerM: number, u: number): { kind: number; detail: string; inside?: boolean } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly[0]) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) {
    for (const p of c.grid.get(cellOf(gx * CELL, gy * CELL)) ?? []) if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && inPoly(poly, p.x, p.y)) return { ...p, inside: true };
  }
  if (areaM2 > 250) {
    // a temple's or shrine's halls: the POI sits somewhere in the precinct
    const reach = 45 * unitsPerM;
    for (const p of c.worship) if (Math.abs(p.x - cx) < reach && Math.abs(p.y - cy) < reach) return p;
  }
  for (const l of c.landuse) {
    if (cx < l.box[0] || cx > l.box[2] || cy < l.box[1] || cy > l.box[3] || !inPoly(l.rings, cx, cy)) continue;
    if (l.kind === 2) return { kind: areaM2 < 230 ? 1 : 2, detail: "" };
    return { kind: l.kind, detail: "" };
  }
  if (areaM2 < 230) return { kind: 1, detail: "" };
  if (areaM2 < 900) return { kind: u < 0.7 ? 2 : 3, detail: "" };
  return { kind: u < 0.5 ? 3 : 2, detail: "" };
}

/** Japan (Kansai first): lower, denser, kawara roofs. */
const inJapan = (lat: number, lon: number) => lat > 24 && lat < 46 && lon > 122 && lon < 146;

const WALLS_JP: Record<number, RGB[]> = {
  0: [[200, 196, 188], [176, 172, 166], [214, 208, 198]],
  1: [[92, 70, 54], [120, 96, 74], [206, 198, 182], [182, 172, 156], [226, 222, 212], [150, 140, 128]], // machiya wood, plaster
  2: [[222, 218, 208], [196, 192, 184], [210, 200, 184], [180, 178, 176]],
  3: [[186, 190, 194], [160, 166, 172], [206, 204, 198], [140, 146, 154]],
  4: [[176, 174, 168], [156, 160, 162], [196, 192, 182]],
  5: [[150, 112, 78], [122, 88, 62], [210, 200, 182]], // temple wood and plaster
  6: [[210, 204, 192], [190, 186, 178], [222, 216, 206]],
  7: [[150, 168, 186], [124, 140, 160], [176, 188, 198]],
};
const SHRINE: RGB[] = [[196, 70, 44], [214, 92, 56]]; // vermilion
const ROOFS_JP: Record<number, RGB[]> = {
  0: [[128, 126, 122], [110, 110, 108]],
  1: [[64, 66, 72], [74, 76, 82], [84, 86, 90], [96, 88, 80], [70, 80, 92]], // kawara and sheet metal
  2: [[150, 148, 144], [130, 130, 128]],
  3: [[136, 138, 140], [118, 120, 124], [156, 156, 152]],
  4: [[150, 152, 154], [126, 132, 138], [110, 120, 128]],
  5: [[56, 58, 62], [64, 66, 70], [72, 86, 80]], // temple tiles, a copper-green now and then
  6: [[126, 124, 120], [108, 112, 112]],
  7: [[110, 116, 122], [90, 96, 104]],
};

/** Height for an untagged building in Japan (Kyoto: two-storey machiya, height limits downtown). */
function heightJP(kind: number, a: number, u: number): number {
  const side = Math.sqrt(Math.max(1, a));
  switch (kind) {
    case 1: return 6 + u * 2.6;
    case 2: return Math.min(31, 9 + side * 0.35 + u * 9);
    case 3: return Math.min(45, 10 + side * 0.4 + u * 12);
    case 4: return 7 + u * 7;
    case 5: return Math.min(26, 7 + side * 0.28 + u * 3);
    case 6: return Math.min(28, 10 + side * 0.15 + u * 6);
    case 7: return 40 + u * 40;
    default: return 7 + u * 5;
  }
}

/**
 * The buildings of a z14 tile; null where no region covers it (the service answers 204). `terrain` gives the compact
 * terrain tile of a key (the base heights come from it, so buildings stand on the same ground the viewers draw).
 */
export async function makeBuildingsTile(up: Upstream, key: { z: number; x: number; y: number }, terrain: (k: TileKey) => Promise<Uint8Array>): Promise<Uint8Array | null> {
  const regions = regionsOf(key);
  if (!regions.length) return null;
  const d = MVT_ZOOM - key.z, subs: { x: number; y: number }[] = [];
  for (let dy = 0; dy < 2 ** d; dy++) for (let dx = 0; dx < 2 ** d; dx++) subs.push({ x: (key.x << d) + dx, y: (key.y << d) + dy });
  const [ground, ...tiles] = await Promise.all([
    terrain(key).then((b) => terrainSampler(b, key)),
    ...subs.map(async (s) => {
      for (const r of regions) {
        const t = await archive(up, r).getZxy(MVT_ZOOM, s.x, s.y);
        if (t?.data && t.data.byteLength) return { s, data: t.data };
      }
      return null;
    }),
  ]) as [(lat: number, lon: number) => number, ...({ s: { x: number; y: number }; data: ArrayBuffer } | null)[]];
  const list: Building[] = [];
  const Z = 2 ** MVT_ZOOM;
  const japan = inJapan(tileYToLat(key.y + 0.5, key.z), ((key.x + 0.5) / 2 ** key.z) * 360 - 180);
  for (const t of tiles) {
    if (!t) continue;
    const vt = new VectorTile(new Pbf(new Uint8Array(t.data)));
    const layer = vt.layers.buildings ?? vt.layers.building;
    if (!layer) continue;
    const ctx = context(vt);
    const ext = layer.extent;
    const toLon = (px: number) => ((t.s.x + px / ext) / Z) * 360 - 180;
    const mPerUnit = (40075016.7 / Z / ext) * Math.cos((tileYToLat(t.s.y + 0.5, MVT_ZOOM) * Math.PI) / 180);
    for (let f = 0; f < layer.length; f++) {
      const feat = layer.feature(f);
      if (feat.type !== 3) continue;
      const props = feat.properties as Record<string, unknown>;
      const geom = feat.loadGeometry();
      const rings = geom.map((r) => clipRing(r, ext)).filter((r) => r.length >= 3);
      if (!rings.length) continue;
      for (const poly of classifyRings(rings as never) as P[][][]) {
        const outer = poly[0];
        const a = Math.abs(area(outer)) * mPerUnit * mPerUnit;
        if (a < 4) continue;
        let cx = 0, cy = 0;
        for (const p of outer) { cx += p.x; cy += p.y; }
        cx /= outer.length; cy /= outer.length;
        // the whole footprint (before clipping) decides the kind and the default height, so pieces agree
        const clipped = rings.length !== geom.length || rings.some((r, i) => r.length !== geom[i].length - (geom[i][0].x === geom[i][geom[i].length - 1].x && geom[i][0].y === geom[i][geom[i].length - 1].y ? 1 : 0));
        const src = clipped ? ((classifyRings(geom as never) as P[][][]).find((w) => inRing(w[0], cx, cy)) ?? poly) : poly;
        let wx = 0, wy = 0;
        for (const p of src[0]) { wx += p.x; wy += p.y; }
        wx /= src[0].length; wy /= src[0].length;
        const wa = Math.abs(area(src[0])) * mPerUnit * mPerUnit;
        const u = hash2(toLon(wx), wy / ext + t.s.y);
        const kd = String(props.kind_detail ?? props["building"] ?? "");
        let kind = KIND[kd] ?? 0, detail = "", inside = false;
        if (!kind) ({ kind, detail, inside = false } = inferKind(ctx, src, wx, wy, wa, 1 / mPerUnit, u));
        let { height, minHeight } = buildingHeight(props, kind, wa, u);
        if (japan && !(Number(props.height) > 0) && !(Number(props["building:levels"]) > 0)) height = heightJP(kind, wa, u);
        if (kind !== 7 && height > 60) kind = 7;
        const latRings = poly.map((ring) => ring.map((p) => [tileYToLat(t.s.y + p.y / ext, MVT_ZOOM), toLon(p.x)] as [number, number]));
        let base = Infinity;
        for (const [la, lo] of latRings[0]) base = Math.min(base, ground(la, lo));
        const u2 = hash2(u * 977, wa), u3 = hash2(u2 * 131, u);
        const walls = japan ? (kind === 5 && detail === "shinto" && inside ? SHRINE : WALLS_JP[kind] ?? WALLS_JP[0]) : WALLS[kind] ?? WALLS[0];
        const roofs = japan ? ROOFS_JP[kind] ?? ROOFS_JP[0] : ROOFS[kind] ?? ROOFS[0];
        // roof forms for when viewers draw them (v1 draws flat): houses gabled, halls hipped
        const roof = kind === 1 ? (u3 < 0.75 ? 1 : 2) : kind === 5 ? 2 : 0;
        list.push({ rings: latRings, base, height, minHeight, kind, roof, wall: pick(walls, u2), roofColor: pick(roofs, u3) });
      }
    }
  }
  return encodeBuildingsCompact(key, list, ["osm"]);
}
