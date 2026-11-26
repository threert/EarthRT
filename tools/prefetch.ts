// Tiles into a directory, laid out as the client's cache (`<out>/cache/tiles/v1/<gen>/…`, `meta.json` beside): the
// asset root of `threert-render play --assets <out>` for development and offline tests, the same paths the package
// reads after `assets.fetch`.
//
//   bun tools/prefetch.ts --out out/tiles [--api https://earth.threert.dev] <what>...
//   bun tools/prefetch.ts --out out/tiles --synthetic <what>...      tiles of a procedural planet (no network)
//
// What (any number):
//   --global <zmax>                 every tile of z0..zmax, and the polar caps
//   --around <lat,lon,zmax[,r]>     tiles of z0..zmax within r tiles (default 3) of the point at each zoom
//   --route <from;to,zmax[,r]>      the same along a great circle (lat,lon;lat,lon or names: kyoto, san-francisco, …)
//   --buildings                     the buildings tiles of every z(meta.buildings.zoom) terrain tile fetched
// Network: HTTPS_PROXY is honoured (curl). The synthetic planet's gen is "s1".
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  decodeErt, encodeBuildingsCompact, encodeBuildingsExpanded, encodeTerrainCompact, encodeTerrainExpanded, expandBuildings, expandTerrain,
  greatCircle, gridLatLon, gridNormals, haversine, isCap, keyOf, tileAt, tileSize, type Building, type TileKey,
} from "../packages/core/src/index.ts";
import { NAMED } from "../app/src/flights.ts";

const args = process.argv.slice(2);
const flag = (k: string) => args.includes(k);
const values = (k: string) => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));
const out = values("--out")[0] ?? "out/tiles";
const api = (values("--api")[0] ?? "https://earth.threert.dev").replace(/\/$/, "");
const synthetic = flag("--synthetic");

// ------------------------------------------------------------------------------------------------ which tiles
const want = new Map<string, TileKey>();
const add = (k: TileKey) => want.set(keyOf(k), k);
for (const g of values("--global")) {
  const zmax = Number(g);
  add({ cap: "n" });
  add({ cap: "s" });
  for (let z = 0; z <= zmax; z++) for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++) add({ z, x, y });
}
const point = (s: string) => {
  const n = NAMED[s.trim().toLowerCase()];
  if (n) return n;
  const [lat, lon] = s.split(",").map(Number);
  return { lat, lon };
};
function around(lat: number, lon: number, zmax: number, r: number) {
  for (let z = 0; z <= zmax; z++) {
    const c = tileAt(lat, lon, z), n = 2 ** z;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const y = c.y + dy;
      if (y < 0 || y >= n) continue;
      add({ z, x: (((c.x + dx) % n) + n) % n, y });
    }
  }
}
for (const a of values("--around")) {
  const [lat, lon, zmax, r] = a.split(",").map(Number);
  around(lat, lon, zmax, r || 3);
}
for (const a of values("--route")) {
  // "from;to,zmax[,r]": to is a name or lat,lon
  const [from, tail] = a.split(";");
  const parts = tail.split(",");
  const named = NAMED[parts[0].toLowerCase()];
  const to = named ? named : { lat: Number(parts[0]), lon: Number(parts[1]) };
  const nums = parts.slice(named ? 1 : 2).map(Number);
  const zmax = nums[0], r = nums[1] || 2;
  const A = point(from), B = to;
  const d = haversine(A.lat, A.lon, B.lat, B.lon);
  for (let z = 0; z <= zmax; z++) {
    const step = Math.max(1000, tileSize({ z, x: 0, y: 2 ** (z - 1) }) / 2);
    for (let s = 0; s <= d; s += step) {
      const p = greatCircle(A.lat, A.lon, B.lat, B.lon, s / d);
      const c = tileAt(p.lat, p.lon, z), n = 2 ** z;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const y = c.y + dy;
        if (y >= 0 && y < n) add({ z, x: (((c.x + dx) % n) + n) % n, y });
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------ the synthetic planet
function hash(x: number, y: number, z: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(
    l(l(hash(xi, yi, zi), hash(xi + 1, yi, zi), u), l(hash(xi, yi + 1, zi), hash(xi + 1, yi + 1, zi), u), v),
    l(l(hash(xi, yi, zi + 1), hash(xi + 1, yi, zi + 1), u), l(hash(xi, yi + 1, zi + 1), hash(xi + 1, yi + 1, zi + 1), u), v),
    w,
  ) * 2 - 1;
}
/** Height (m) of the synthetic planet at a latitude and longitude: continents, ridged mountains, detail to ~20 m. */
function height(lat: number, lon: number): number {
  const p = (lat * Math.PI) / 180, l = (lon * Math.PI) / 180;
  const X = Math.cos(p) * Math.cos(l), Y = Math.cos(p) * Math.sin(l), Z = Math.sin(p);
  // continents: 3 octaves at the scale of thousands of km
  let c = 0, a = 1, f = 1.6;
  for (let o = 0; o < 4; o++, a *= 0.5, f *= 2.1) c += a * noise(X * f + 11.3, Y * f + 3.1, Z * f + 7.7);
  const land = c - 0.05;
  // mountains: ridged, stronger inland
  let m = 0;
  a = 1; f = 24;
  for (let o = 0; o < 6; o++, a *= 0.5, f *= 2.03) m += a * (1 - Math.abs(noise(X * f + 1.7, Y * f + 9.2, Z * f + 4.4)));
  const ridge = Math.max(0, m - 0.9) ** 2 * 3200 * Math.max(0, Math.min(1, land * 4));
  // hills and detail down to ~20 m (f up to ~3e5 on the unit sphere: 6371 km / 3e5 = 21 m)
  let d = 0;
  a = 1; f = 200;
  for (let o = 0; o < 14; o++, a *= 0.5, f *= 2) d += a * noise(X * f + 5.5, Y * f + 2.2, Z * f + 8.8);
  return land * 2600 + ridge + d * 90 * Math.max(0.15, Math.min(1, land * 3 + 0.3));
}

function srgb(c: [number, number, number], k: number): [number, number, number] {
  return [Math.min(255, Math.round(c[0] * k)), Math.min(255, Math.round(c[1] * k)), Math.min(255, Math.round(c[2] * k))];
}
const COL: Record<number, [number, number, number]> = {
  1: [52, 74, 38], 2: [104, 104, 66], 3: [112, 128, 70], 4: [150, 146, 92], 5: [128, 122, 116], 6: [170, 150, 120], 7: [236, 240, 245], 8: [22, 44, 66], 11: [120, 118, 96],
};

function syntheticTerrain(k: TileKey): Uint8Array {
  const n = 65;
  const { lats, lons } = gridLatLon(k, n);
  const lat = (i: number) => (i < 0 ? 2 * lats[0] - lats[1] : i >= n ? 2 * lats[n - 1] - lats[n - 2] : lats[i]);
  const lon = (j: number) => (j < 0 ? 2 * lons[0] - lons[1] : j >= n ? 2 * lons[n - 1] - lons[n - 2] : lons[j]);
  const B = new Float32Array((n + 2) * (n + 2));
  for (let i = -1; i <= n; i++) for (let j = -1; j <= n; j++) B[(i + 1) * (n + 2) + (j + 1)] = Math.max(0, height(lat(i), lon(j)));
  const normals = gridNormals(k, n, B);
  const heights = new Float32Array(n * n), cls = new Uint8Array(n * n), rgb = new Uint8Array(3 * n * n), water = new Uint8Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const v = i * n + j, la = lats[i], lo = lons[j];
    const h = height(la, lo);
    heights[v] = Math.max(0, h);
    const w = h < 0 ? Math.min(1, -h / 8) : 0;
    water[v] = Math.round(w * 255);
    // up: the ellipsoid's normal; slope from the normal
    const p = (la * Math.PI) / 180, l = (lo * Math.PI) / 180;
    const ux = Math.cos(p) * Math.cos(l), uy = Math.cos(p) * Math.sin(l), uz = Math.sin(p);
    const cosSlope = normals[3 * v] * ux + normals[3 * v + 1] * uy + normals[3 * v + 2] * uz;
    const alat = Math.abs(la);
    const wet = noise(ux * 9 + 2, uy * 9 + 5, uz * 9 + 1) - (alat > 14 && alat < 32 ? 0.6 : 0) + (alat < 12 ? 0.4 : 0);
    const snowLine = 4800 - 4600 * Math.min(1, (alat / 72) ** 1.6);
    let c: number;
    if (w > 0.5) c = 8;
    else if (h > snowLine + noise(ux * 3000, uy * 3000, uz * 3000) * 300 || alat > 78) c = 7;
    else if (cosSlope < 0.8) c = 6;
    else if (wet < -0.35) c = 6;
    else if (alat > 62) c = 11;
    else if (wet < -0.1) c = 2;
    else {
      const f = noise(ux * 900 + 3, uy * 900 + 1, uz * 900 + 7);
      c = f > 0.25 ? 1 : f > -0.05 ? 3 : f > -0.3 ? 4 : 1;
      if (urban(la, lo, ux, uy, uz)) c = 5;
    }
    cls[v] = c;
    const tone = 0.9 + 0.2 * noise(ux * 4000, uy * 4000, uz * 4000);
    const col = srgb(COL[c] ?? [128, 128, 128], c === 8 ? 1 : tone);
    rgb[3 * v] = col[0]; rgb[3 * v + 1] = col[1]; rgb[3 * v + 2] = col[2];
  }
  const size = isCap(k) ? 600_000 : tileSize(k);
  const skirt = Math.max(30, Math.min(5000, size / 16));
  const compact = encodeTerrainCompact({ key: k, n, heights, cls, rgb, water, normals, skirt, src: ["synthetic"] });
  const mesh = expandTerrain(decodeErt(compact));
  return encodeTerrainExpanded(mesh, { skirt, src: ["synthetic"] });
}

/** Built up: noise, and every named city within 7 km. */
function urban(la: number, lo: number, ux: number, uy: number, uz: number): boolean {
  if (noise(ux * 300, uy * 300 + 4, uz * 300 + 2) > 0.62) return true;
  for (const c of Object.values(NAMED)) if (Math.abs(c.lat - la) < 0.1 && haversine(c.lat, c.lon, la, lo) < 7000 + 2500 * noise(ux * 2000, uy * 2000, uz * 2000)) return true;
  return false;
}

/** A buildings tile of the synthetic planet: blocks of boxes where the class says built-up. */
function syntheticBuildings(k: { z: number; x: number; y: number }): Uint8Array | null {
  const n = 65;
  const { lats, lons } = gridLatLon(k, n);
  const list: Building[] = [];
  for (let i = 1; i < n - 1; i += 2) for (let j = 1; j < n - 1; j += 2) {
    const la = lats[i], lo = lons[j];
    const p = (la * Math.PI) / 180, l = (lo * Math.PI) / 180;
    const ux = Math.cos(p) * Math.cos(l), uy = Math.cos(p) * Math.sin(l), uz = Math.sin(p);
    if (!urban(la, lo, ux, uy, uz)) continue;
    const h = height(la, lo);
    if (h < 2) continue;
    // a block of up to 4 buildings, each a box of 12-30 m
    const dLat = (lats[i] - lats[i + 1]) * 0.8, dLon = (lons[j + 1] - lons[j]) * 0.8;
    for (let b = 0; b < 4; b++) {
      const r = hash(k.x * 131 + j, k.y * 71 + i, b);
      if (r < 0.25) continue;
      const cx = la - dLat * (0.25 + 0.5 * (b >> 1)), cy = lo + dLon * (0.25 + 0.5 * (b & 1));
      const s = (0.3 + 0.15 * r) * Math.min(dLat, dLon);
      const hgt = 6 + Math.round(60 * r ** 3);
      list.push({ rings: [[[cx - s, cy - s], [cx - s, cy + s], [cx + s, cy + s], [cx + s, cy - s]]], base: h - 1, height: hgt, wall: srgb([196, 188, 176], 0.8 + 0.4 * r), roofColor: srgb([110, 104, 100], 0.8 + 0.4 * r) });
    }
  }
  if (!list.length) return null;
  const compact = encodeBuildingsCompact(k, list, ["synthetic"]);
  return encodeBuildingsExpanded(expandBuildings(decodeErt(compact)), ["synthetic"]);
}

// ------------------------------------------------------------------------------------------------ fetching
function curl(url: string): { status: number; body: Uint8Array } {
  const tmp = join(out, ".dl");
  const status = Number(execFileSync("curl", ["-s", "-L", "-o", tmp, "-w", "%{http_code}", "--max-time", "60", url], { encoding: "utf8" }).trim());
  const body = status === 200 && existsSync(tmp) ? new Uint8Array(readFileSync(tmp)) : new Uint8Array();
  return { status, body };
}

mkdirSync(out, { recursive: true });
let meta: { gen: string; terrain: { maxZoom: number; n: number; skirt: number }; buildings: { zoom: number } };
if (synthetic) {
  meta = { gen: "s1", terrain: { maxZoom: 14, n: 65, skirt: 0 }, buildings: { zoom: 14 } };
  const m = { v: 1, ...meta, buildings: { zoom: 14, regions: [] }, attribution: ["Synthetic planet (tools/prefetch.ts --synthetic)"] };
  mkdirSync(join(out, "cache/tiles/v1"), { recursive: true });
  writeFileSync(join(out, "cache/tiles/v1/meta.json"), JSON.stringify(m, null, 2));
} else {
  const r = curl(`${api}/tiles/v1/meta.json`);
  if (r.status !== 200) throw new Error(`meta.json: ${r.status}`);
  mkdirSync(join(out, "cache/tiles/v1"), { recursive: true });
  writeFileSync(join(out, "cache/tiles/v1/meta.json"), r.body);
  meta = JSON.parse(new TextDecoder().decode(r.body));
}
const keys = [...want.values()].filter((k) => isCap(k) || k.z <= meta.terrain.maxZoom);
console.log(`${keys.length} terrain tiles (${synthetic ? "synthetic" : api}) into ${out}`);
let made = 0, skipped = 0, bytes = 0, built = 0;
const t0 = Date.now();
for (const k of keys) {
  const key = keyOf(k);
  const path = join(out, `cache/tiles/v1/${meta.gen}/terrain/${key}.x.ert`);
  if (!existsSync(path)) {
    let data: Uint8Array | null;
    if (synthetic) data = syntheticTerrain(k);
    else {
      const r = curl(`${api}/tiles/v1/${meta.gen}/terrain/${key}.x.ert`);
      data = r.status === 200 ? r.body : null;
      if (!data) console.log(`  ${key}: ${r.status}`);
    }
    if (data) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data);
      bytes += data.length;
      made++;
    }
  } else skipped++;
  if (flag("--buildings") && !isCap(k) && k.z === meta.buildings.zoom) {
    const bp = join(out, `cache/tiles/v1/${meta.gen}/buildings/${key}.x.ert`);
    if (!existsSync(bp)) {
      let data: Uint8Array | null;
      if (synthetic) data = syntheticBuildings(k);
      else {
        const r = curl(`${api}/tiles/v1/${meta.gen}/buildings/${key}.x.ert`);
        data = r.status === 200 ? r.body : null;
      }
      if (data) {
        mkdirSync(dirname(bp), { recursive: true });
        writeFileSync(bp, data);
        bytes += data.length;
        built++;
      }
    }
  }
  if ((made + skipped) % 200 === 0) console.log(`  ${made + skipped} / ${keys.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
console.log(`made ${made}, had ${skipped}, buildings ${built}, ${(bytes / 1048576).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
