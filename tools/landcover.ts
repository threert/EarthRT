// Bakes the global land-cover raster the service reads for coarse tiles (z ≤ 7) from ESA WorldCover's COG overviews:
// 1/40° in 10° blocks, and 1/4° in one object. Writes into out/r2/landcover/v1/…; --upload puts them in R2.
//   bun tools/landcover.ts [--upload] [--concurrency 16]
// A cell takes the most common land class when land covers at least a quarter of it; else water (80) when the file
// says water, else 0 (no land cover: the generator decides water by the height).
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openCog, readCogTile } from "../service/src/gen/cog.ts";
import { deflate } from "../service/src/gen/inflate.ts";
import { WORLDCOVER, worldCoverUrl, COARSE, FINE, fineBlockKey, GLOBAL_PREFIX } from "../service/src/gen/landcover.ts";
import { BunUpstream, curl } from "./lib/bun-upstream.ts";

const args = process.argv.slice(2);
const opt = (f: string, d?: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const conc = Number(opt("--concurrency", "16"));
const OUT = join(import.meta.dir, "../out/r2");
const up = new BunUpstream();

// the list of WorldCover cells (the grid file the project publishes)
async function cells(): Promise<string[]> {
  const cache = join(import.meta.dir, "../out/cache/worldcover-cells.json");
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"));
  for (const u of [`${WORLDCOVER.replace(/\/v200\/2021\/map$/, "")}/esa_worldcover_grid.geojson`, `${WORLDCOVER.replace(/\/v200\/2021\/map$/, "")}/v100/2020/esa_worldcover_2020_grid.geojson`]) {
    const r = await curl(u);
    if (r.status !== 200) continue;
    const g = JSON.parse(new TextDecoder().decode(r.body)) as { features: { properties: Record<string, string> }[] };
    const list = g.features.map((f) => f.properties.ll_tile ?? f.properties.tile ?? f.properties.name).filter(Boolean);
    if (list.length) {
      mkdirSync(join(import.meta.dir, "../out/cache"), { recursive: true });
      writeFileSync(cache, JSON.stringify(list));
      return list;
    }
  }
  throw new Error("WorldCover grid file not found");
}

const list = await cells();
console.log(`${list.length} WorldCover cells`);
const P = FINE.perDeg, W = 360 * P, H = 180 * P;
const fine = new Uint8Array(W * H);
let done = 0;
const t0 = performance.now();

async function bake(cell: string) {
  const m = /^([NS])(\d\d)([EW])(\d\d\d)$/.exec(cell);
  if (!m) return;
  const lat0 = (m[1] === "S" ? -1 : 1) * +m[2], lon0 = (m[3] === "W" ? -1 : 1) * +m[4];
  const cog = await openCog(up, worldCoverUrl(cell));
  if (!cog) return;
  const level = cog.levels.length - 1, L = cog.levels[level];
  const across = Math.ceil(L.width / L.tileW), down = Math.ceil(L.height / L.tileH);
  const px = new Uint8Array(L.width * L.height);
  for (let ty = 0; ty < down; ty++) for (let tx = 0; tx < across; tx++) {
    const t = await readCogTile(up, cog, level, tx, ty);
    if (!t) continue;
    for (let y = 0; y < L.tileH; y++) {
      const gy = ty * L.tileH + y;
      if (gy >= L.height) break;
      for (let x = 0; x < L.tileW; x++) { const gx = tx * L.tileW + x; if (gx < L.width) px[gy * L.width + gx] = t[y * L.tileW + x]; }
    }
  }
  // the file's 3° at 1/40°: 120 × 120 cells
  const S = 3 * P, counts = new Uint32Array(256);
  for (let cy = 0; cy < S; cy++) for (let cx = 0; cx < S; cx++) {
    counts.fill(0);
    const x0 = Math.floor((cx / S) * L.width), x1 = Math.max(x0 + 1, Math.floor(((cx + 1) / S) * L.width));
    const y0 = Math.floor((cy / S) * L.height), y1 = Math.max(y0 + 1, Math.floor(((cy + 1) / S) * L.height));
    let total = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { counts[px[y * L.width + x]]++; total++; }
    let land = 0, best = 0, bc = 0;
    for (let v = 1; v < 256; v++) if (v !== 80 && counts[v]) { land += counts[v]; if (counts[v] > bc) { bc = counts[v]; best = v; } }
    const v = land * 4 >= total ? best : counts[80] * 2 >= total ? 80 : 0;
    const gx = Math.round((lon0 + 180) * P) + cx, gy = Math.round((90 - (lat0 + 3)) * P) + cy;
    fine[gy * W + gx] = v;
  }
  if (++done % 100 === 0) console.log(`${done}/${list.length} (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
}

let i = 0;
await Promise.all(Array.from({ length: conc }, async () => {
  while (i < list.length) {
    const c = list[i++];
    for (let a = 0; ; a++) {
      try { await bake(c); break; } catch (e) { if (a >= 3) { console.error(c, (e as Error).message); break; } await Bun.sleep(1000 * (a + 1)); }
    }
  }
}));
console.log(`baked ${done} cells in ${((performance.now() - t0) / 1000).toFixed(0)} s`);

// 10° blocks
const B = FINE.block * P;
const written: string[] = [];
for (let lat0 = -90; lat0 < 90; lat0 += FINE.block) for (let lon0 = -180; lon0 < 180; lon0 += FINE.block) {
  const block = new Uint8Array(B * B);
  let any = false;
  const gy0 = (90 - (lat0 + FINE.block)) * P, gx0 = (lon0 + 180) * P;
  for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) { const v = fine[(gy0 + y) * W + gx0 + x]; block[y * B + x] = v; if (v) any = true; }
  if (!any) continue;
  const key = fineBlockKey(lat0, lon0);
  mkdirSync(join(OUT, key, ".."), { recursive: true });
  writeFileSync(join(OUT, key), await deflate(block, "deflate"));
  written.push(key);
}
// the coarse raster: 1/4°, the same rule over the fine cells
const f = P / COARSE.perDeg, coarse = new Uint8Array(COARSE.w * COARSE.h), counts = new Uint32Array(256);
for (let y = 0; y < COARSE.h; y++) for (let x = 0; x < COARSE.w; x++) {
  counts.fill(0);
  for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) counts[fine[(y * f + dy) * W + x * f + dx]]++;
  let land = 0, best = 0, bc = 0;
  for (let v = 1; v < 256; v++) if (v !== 80 && counts[v]) { land += counts[v]; if (counts[v] > bc) { bc = counts[v]; best = v; } }
  coarse[y * COARSE.w + x] = land * 4 >= f * f ? best : counts[80] * 2 >= f * f ? 80 : 0;
}
writeFileSync(join(OUT, COARSE.key), await deflate(coarse, "deflate"));
written.push(COARSE.key);
console.log(`${written.length} objects under out/r2/${GLOBAL_PREFIX}`);

if (args.includes("--upload")) {
  let k = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (k < written.length) {
      const key = written[k++];
      const p = Bun.spawn([join(import.meta.dir, "../service/node_modules/.bin/wrangler"), "r2", "object", "put", `earthrt-tiles/${key}`, "--file", join(OUT, key), "--remote", "--content-type", "application/octet-stream"], { cwd: join(import.meta.dir, "../service"), stdout: "pipe", stderr: "pipe" });
      if (await p.exited) console.error(key, await new Response(p.stderr).text());
    }
  }));
  console.log("uploaded");
}
