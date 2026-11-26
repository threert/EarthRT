// An oblique picture of z14 tiles (terrain + buildings) to judge the city by eye: a small z-buffer rasterizer, sun
// from the south-west, the camera looking north-east… or wherever --heading says.
//   bun tools/oblique.ts --at 34.9875,135.7592 [--tiles 2] [--heading 20] [--pitch 35] [--dist 2500] [--out out/s2/kyoto.png] [--api URL]
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { decodeErt, expandTerrain, expandBuildings, tileAt, keyOf, enu, geodeticToEcef, terrainIndex, type V3 } from "../packages/core/src/index.ts";
import { makeTerrainTile } from "../service/src/gen/terrain.ts";
import { WorldCover } from "../service/src/gen/landcover.ts";
import { makeBuildingsTile } from "../service/src/gen/buildings.ts";
import { encodePng } from "../service/src/gen/png.ts";
import { MemoUpstream } from "../service/src/gen/upstream.ts";
import { BunUpstream, curl } from "./lib/bun-upstream.ts";

const args = process.argv.slice(2);
const opt = (f: string, d?: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const [lat, lon] = opt("--at", "34.9875,135.7592")!.split(",").map(Number);
const span = Number(opt("--tiles", "1")), heading = Number(opt("--heading", "20")), pitch = Number(opt("--pitch", "35")), dist = Number(opt("--dist", "2200"));
const W = Number(opt("--w", "1280")), H = Number(opt("--h", "800"));
const out = opt("--out", "out/s2/oblique.png")!;
const api = opt("--api");
const up = new MemoUpstream(new BunUpstream());
const lc = new WorldCover(up);

async function terrainBytes(k: { z: number; x: number; y: number }) {
  if (api) { const r = await curl(`${api}/tiles/v1/${gen}/terrain/${keyOf(k)}.c.ert`); return r.body; }
  return makeTerrainTile(up, k, lc);
}
async function buildingBytes(k: { z: number; x: number; y: number }) {
  if (api) { const r = await curl(`${api}/tiles/v1/${gen}/buildings/${keyOf(k)}.c.ert`); return r.status === 200 ? r.body : null; }
  return makeBuildingsTile(up, k, (t) => terrainBytes(t as { z: number; x: number; y: number }));
}
let gen = "g2";
if (api) gen = JSON.parse(new TextDecoder().decode((await curl(`${api}/tiles/v1/meta.json`)).body)).gen;

// camera: a frame at the point, east-north-up
const c = tileAt(lat, lon, 14);
const O = geodeticToEcef(lat, lon, 0);
const { e, n, u } = enu(lat, lon);
const toLocal = (p: V3): V3 => { const d = [p[0] - O[0], p[1] - O[1], p[2] - O[2]]; return [d[0] * e[0] + d[1] * e[1] + d[2] * e[2], d[0] * n[0] + d[1] * n[1] + d[2] * n[2], d[0] * u[0] + d[1] * u[1] + d[2] * u[2]]; };
const dirLocal = (p: V3): V3 => [p[0] * e[0] + p[1] * e[1] + p[2] * e[2], p[0] * n[0] + p[1] * n[1] + p[2] * n[2], p[0] * u[0] + p[1] * u[1] + p[2] * u[2]];
const hd = (heading * Math.PI) / 180, pt = (pitch * Math.PI) / 180;
const fwd: V3 = [Math.sin(hd) * Math.cos(pt), Math.cos(hd) * Math.cos(pt), -Math.sin(pt)];
const right: V3 = [Math.cos(hd), -Math.sin(hd), 0];
const upv: V3 = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
const eye: V3 = [-fwd[0] * dist, -fwd[1] * dist, -fwd[2] * dist + 40];
const f = (H / 2) / Math.tan((40 * Math.PI) / 360);
const sun: V3 = (() => { const v: V3 = [-0.45, -0.6, 0.66]; const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; })();

const color = new Float32Array(W * H * 3), depth = new Float32Array(W * H).fill(Infinity);
for (let i = 0; i < W * H; i++) { const t = i / W / H; color[3 * i] = 0.55 - 0.2 * t; color[3 * i + 1] = 0.68 - 0.2 * t; color[3 * i + 2] = 0.85 - 0.15 * t; }

function draw(pos: Float32Array, nrm: Float32Array, col: Float32Array, idx: Uint32Array, center: V3) {
  const V = pos.length / 3;
  const sx = new Float32Array(V), sy = new Float32Array(V), sz = new Float32Array(V), lit = new Float32Array(V * 3);
  for (let v = 0; v < V; v++) {
    const p = toLocal([pos[3 * v] + center[0], pos[3 * v + 1] + center[1], pos[3 * v + 2] + center[2]]);
    const d = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
    const z = d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2];
    sz[v] = z;
    sx[v] = W / 2 + (f * (d[0] * right[0] + d[1] * right[1] + d[2] * right[2])) / z;
    sy[v] = H / 2 - (f * (d[0] * upv[0] + d[1] * upv[1] + d[2] * upv[2])) / z;
    const nn = dirLocal([nrm[3 * v], nrm[3 * v + 1], nrm[3 * v + 2]]);
    const ndl = Math.max(0, nn[0] * sun[0] + nn[1] * sun[1] + nn[2] * sun[2]);
    const sky = 0.5 + 0.5 * nn[2];
    const E = 2.2 * ndl + 0.55 * sky;
    // a little aerial haze
    const haze = 1 - Math.exp(-z / 9000);
    for (let k = 0; k < 3; k++) lit[3 * v + k] = col[3 * v + k] * E * 0.42 * (1 - haze) + [0.5, 0.6, 0.75][k] * haze * 0.9;
  }
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], cc = idx[t + 2];
    if (sz[a] < 1 || sz[b] < 1 || sz[cc] < 1) continue;
    const x0 = Math.max(0, Math.floor(Math.min(sx[a], sx[b], sx[cc]))), x1 = Math.min(W - 1, Math.ceil(Math.max(sx[a], sx[b], sx[cc])));
    const y0 = Math.max(0, Math.floor(Math.min(sy[a], sy[b], sy[cc]))), y1 = Math.min(H - 1, Math.ceil(Math.max(sy[a], sy[b], sy[cc])));
    const area = (sx[b] - sx[a]) * (sy[cc] - sy[a]) - (sx[cc] - sx[a]) * (sy[b] - sy[a]);
    if (Math.abs(area) < 1e-9) continue;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((sx[b] - px) * (sy[cc] - py) - (sx[cc] - px) * (sy[b] - py)) / area;
      const w1 = ((sx[cc] - px) * (sy[a] - py) - (sx[a] - px) * (sy[cc] - py)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w0 * sz[a] + w1 * sz[b] + w2 * sz[cc], i = y * W + x;
      if (z >= depth[i]) continue;
      depth[i] = z;
      for (let k = 0; k < 3; k++) color[3 * i + k] = w0 * lit[3 * a + k] + w1 * lit[3 * b + k] + w2 * lit[3 * cc + k];
    }
  }
}

const keys: { z: number; x: number; y: number }[] = [];
const r = Math.floor(span / 2);
for (let dy = -r; dy <= span - 1 - r; dy++) for (let dx = -r; dx <= span - 1 - r; dx++) keys.push({ z: 14, x: c.x + dx, y: c.y + dy });
let count = 0;
for (const k of keys) {
  const tm = expandTerrain(decodeErt(await terrainBytes(k)));
  draw(tm.positions, tm.normals, tm.colors, terrainIndex(tm.n), tm.center);
  const bb = await buildingBytes(k);
  if (bb) { const bm = expandBuildings(decodeErt(bb)); count += bm.count; draw(bm.positions, bm.normals, bm.colors, bm.index, bm.center); }
}
const toSrgb = (l: number) => Math.max(0, Math.min(255, Math.round((l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055) * 255)));
const px = new Uint8Array(W * H * 3);
for (let i = 0; i < W * H * 3; i++) px[i] = toSrgb(color[i]);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, await encodePng({ width: W, height: H, channels: 3, data: px }));
console.log(`${keys.length} tiles, ${count} buildings → ${out}`);
