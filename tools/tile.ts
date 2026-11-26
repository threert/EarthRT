// Makes a tile locally with the service's own generator (same code as the Worker) and shows it.
//   bun tools/tile.ts <z/x/y | cap/n | cap/s> [--x] [--buildings] [--png out.png] [--no-landcover]
//   bun tools/tile.ts --at <lat,lon> --z <z> ...        (the tile under a point)
// Prints sizes and timings; --png renders a top-down preview (albedo × sun) to judge the colours by eye.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { decodeErt, expandTerrain, encodeTerrainExpanded, expandBuildings, encodeBuildingsExpanded, parseKey, tileAt, keyOf, isCap, type TileKey } from "../packages/core/src/index.ts";
import { makeTerrainTile, type TerrainTimings } from "../service/src/gen/terrain.ts";
import { WorldCover } from "../service/src/gen/landcover.ts";
import { makeBuildingsTile } from "../service/src/gen/buildings.ts";
import { encodePng } from "../service/src/gen/png.ts";
import { MemoUpstream } from "../service/src/gen/upstream.ts";
import { BunUpstream } from "./lib/bun-upstream.ts";
import { topDown, view } from "./lib/render.ts";

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
let key: TileKey;
if (opt("--at")) {
  const [lat, lon] = opt("--at")!.split(",").map(Number);
  key = tileAt(lat, lon, Number(opt("--z") ?? 14));
} else key = parseKey(args.find((a) => /^(\d+\/\d+\/\d+|cap\/[ns])$/.test(a)) ?? "0/0/0");

const up = new MemoUpstream(new BunUpstream());
const lc = flag("--no-landcover") ? null : new WorldCover(up);
const t: TerrainTimings = { fetch: 0, landcover: 0, build: 0 };
const t0 = performance.now();
const compact = await makeTerrainTile(up, key, lc, t);
const ms = performance.now() - t0;
const e = decodeErt(compact);
console.log(`terrain ${keyOf(key)}: compact ${compact.length} B in ${ms.toFixed(0)} ms (sources ${t.fetch} ms, land cover ${t.landcover} ms, build ${t.build} ms); h ${e.header.minH}..${e.header.maxH} m, skirt ${e.header.skirt} m, src ${e.header.src}`);
const cls = e.chunks.cls as Uint8Array, hist: Record<number, number> = {};
for (const c of cls) hist[c] = (hist[c] ?? 0) + 1;
console.log(`classes: ${Object.entries(hist).map(([c, k]) => `${c}:${k}`).join(" ")}`);
if (flag("--x")) {
  const t1 = performance.now();
  const x = encodeTerrainExpanded(expandTerrain(e), { skirt: e.header.skirt, src: e.header.src });
  console.log(`expanded ${x.length} B in ${(performance.now() - t1).toFixed(0)} ms`);
}
if (flag("--buildings") && !isCap(key)) {
  const t1 = performance.now();
  const b = await makeBuildingsTile(up, key as { z: number; x: number; y: number }, async (k) => (keyOf(k) === keyOf(key) ? compact : makeTerrainTile(up, k, lc)));
  if (!b) console.log("buildings: none here (204)");
  else {
    const be = decodeErt(b);
    const t2 = performance.now();
    const bx = encodeBuildingsExpanded(expandBuildings(be), be.header.src ?? []);
    console.log(`buildings: ${be.header.count} in ${b.length} B (${(t2 - t1).toFixed(0)} ms); expanded ${bx.length} B (${(performance.now() - t2).toFixed(0)} ms)`);
  }
}
const png = opt("--png");
if (png) {
  mkdirSync(dirname(png), { recursive: true });
  writeFileSync(png, await encodePng(topDown(view(compact, key), Number(opt("--size") ?? 512))));
  console.log(`preview: ${png}`);
}
