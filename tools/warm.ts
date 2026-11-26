// Makes a region's tiles once (so viewers find them warm): every z14 buildings tile (and so its terrain) in a box,
// plus the terrain above it up to z8, through the live service.
//   bun tools/warm.ts --bbox 135.25,34.45,135.95,35.12 [--api https://earth.threert.dev] [--concurrency 8] [--x]
import { tilesInBox, keyOf } from "../packages/core/src/index.ts";
import { curl } from "./lib/bun-upstream.ts";

const args = process.argv.slice(2);
const opt = (f: string, d?: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const api = opt("--api", "https://earth.threert.dev")!;
const [west, south, east, north] = opt("--bbox", "135.25,34.45,135.95,35.12")!.split(",").map(Number);
const conc = Number(opt("--concurrency", "8"));
const gen = JSON.parse(new TextDecoder().decode((await curl(`${api}/tiles/v1/meta.json`)).body)).gen;
const urls: string[] = [];
for (let z = 8; z <= 13; z++) for (const k of tilesInBox({ west, south, east, north }, z)) urls.push(`terrain/${keyOf(k)}.c.ert`);
for (const k of tilesInBox({ west, south, east, north }, 14)) {
  urls.push(`buildings/${keyOf(k)}.c.ert`);
  if (args.includes("--x")) urls.push(`buildings/${keyOf(k)}.x.ert`, `terrain/${keyOf(k)}.x.ert`);
}
console.log(`${urls.length} tiles (${gen})`);
const times: number[] = [];
let i = 0, fails = 0, done = 0;
const t0 = performance.now();
await Promise.all(Array.from({ length: conc }, async () => {
  while (i < urls.length) {
    const u = urls[i++];
    const t = performance.now();
    const r = await curl(`${api}/tiles/v1/${gen}/${u}`, undefined, { "accept-encoding": "br" });
    times.push(performance.now() - t);
    if (r.status !== 200 && r.status !== 204) { fails++; console.error(u, r.status, new TextDecoder().decode(r.body.subarray(0, 200))); }
    if (++done % 200 === 0) console.log(`${done}/${urls.length} ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  }
}));
times.sort((a, b) => a - b);
console.log(`done: ${fails} failed; client-side p50 ${times[times.length >> 1].toFixed(0)} ms, p95 ${times[Math.floor(times.length * 0.95)].toFixed(0)} ms, max ${times[times.length - 1].toFixed(0)} ms`);
