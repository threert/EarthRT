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
const times: number[] = [], made: number[] = [], hits: number[] = [];
let i = 0, fails = 0, done = 0;
const t0 = performance.now();
await Promise.all(Array.from({ length: conc }, async () => {
  while (i < urls.length) {
    const u = urls[i++];
    const p = Bun.spawn(["curl", "-sS", "-o", "/dev/null", "-H", "accept-encoding: br", "--max-time", "60", "-w", "%{http_code} %{time_total} %header{server-timing}|%header{x-earthrt}", `${api}/tiles/v1/${gen}/${u}`], { stdout: "pipe" });
    const line = (await new Response(p.stdout).text()).trim();
    const [status, total] = line.split(" ");
    const server = Number(/total;dur=(\d+)/.exec(line)?.[1] ?? NaN);
    times.push(Number(total) * 1000);
    if (!Number.isNaN(server)) (/\|made|\|expanded/.test(line) ? made : hits).push(server);
    if (status !== "200" && status !== "204") { fails++; console.error(u, line); }
    if (++done % 200 === 0) console.log(`${done}/${urls.length} ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  }
}));
const q = (a: number[], f: number) => (a.sort((x, y) => x - y), a.length ? a[Math.min(a.length - 1, Math.floor(a.length * f))].toFixed(0) : "-");
console.log(`server-side: made ${made.length} p50 ${q(made, 0.5)} p95 ${q(made, 0.95)} max ${q(made, 1)} ms; already there ${hits.length} p50 ${q(hits, 0.5)} p95 ${q(hits, 0.95)} ms`);
times.sort((a, b) => a - b);
console.log(`done: ${fails} failed; client-side p50 ${times[times.length >> 1].toFixed(0)} ms, p95 ${times[Math.floor(times.length * 0.95)].toFixed(0)} ms, max ${times[times.length - 1].toFixed(0)} ms`);
