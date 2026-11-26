// The web engine's loading, measured (docs/ROADMAP.md "How work is judged"): real Chrome, a fresh profile each run.
//   bun tools/probe-web.ts [--base http://127.0.0.1:8795] [--runs 3] [--flight-seconds 120] [--skip-flight] [--json out/s3/probe.json]
// - first picture: navigation start → the first frame with the globe drawn (performance mark), median of runs
// - bytes for the first view: everything the page and its workers took over the network until the view's tiles are in
// - tile latency p50 / p95 (network responses, not Cache Storage hits)
// - a flight Kyoto → San Francisco played in --flight-seconds: frames with nothing shown, frames missing detail the
//   view wants badly (a shown tile 4× coarser than wanted), GPU memory against the budget; with and without look-ahead
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { launch } from "./cdp.ts";
import { settle } from "./shots-web.ts";

const root = resolve(import.meta.dirname, "..");
const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const base = arg("--base", "http://127.0.0.1:8795")!;
const runs = Number(arg("--runs", "3"));
const flightSeconds = Number(arg("--flight-seconds", "120"));
const startQuery = arg("--query", "")!; // the bare page: what anyone opening the address sees
// tiles straight from a service (HTTP/2 to its edge, as in production) rather than through the dev server's proxy
const api = arg("--api") ? `&api=${arg("--api")}` : "";

const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};
const median = (a: number[]) => pct(a, 0.5);

interface FirstView { firstGlobeMs: number; settledMs: number; bytes: number; tileBytes: number; requests: number; latencies: number[]; codeBytes: number }

async function firstView(query: string): Promise<FirstView> {
  const b = await launch();
  try {
    const page = await b.open(`${base}/?${query}${api}`);
    await page.waitFor("window.earth && earth.firstGlobeMs > 0", 30_000);
    const first = await page.evaluate<number>("performance.getEntriesByName('earthrt-first-globe')[0].startTime");
    await settle(page, 120_000, 1500);
    const settledMs = await page.evaluate<number>("performance.now()");
    const s = await page.evaluate<{ net: number; req: number; lat: number[]; code: number }>(
      "(() => { const s = earth.tiles.stats; return { net: s.netBytes, req: s.requests, lat: s.latencies, code: performance.getEntriesByType('resource').filter(e => /static\\//.test(e.name)).reduce((t, e) => t + (e.transferSize || e.encodedBodySize || 0), 0) + (performance.getEntriesByType('navigation')[0]?.transferSize || 0) }; })()",
    );
    const r = { firstGlobeMs: first, settledMs, bytes: page.netBytes(), tileBytes: s.net, requests: s.req, latencies: s.lat, codeBytes: s.code };
    await page.close();
    return r;
  } finally {
    b.close();
    await Bun.sleep(1600);
  }
}

interface FlightResult { frames: number; emptyFrames: number; coarseFrames: number; coarseShare: number; maxGpuMB: number; budgetMB: number; requests: number; netMB: number; fps: number; p95FrameMs: number }

async function flight(lookahead: boolean): Promise<FlightResult> {
  const b = await launch();
  try {
    const q = `fly=kyoto;san-francisco&flightSeconds=${flightSeconds}&time=2026-06-21T01:00:00Z${lookahead ? "" : "&lookahead=0"}`;
    const page = await b.open(`${base}/?${q}${api}`);
    await page.waitFor("window.earth && earth.flight && earth.flight.active && earth.firstGlobeMs > 0", 60_000);
    await page.evaluate("earth.record = []");
    await page.waitFor("!earth.flight.active", (flightSeconds + 60) * 1000);
    const r = await page.evaluate<FlightResult>(`(() => {
      const rec = earth.record; earth.record = null;
      const dts = rec.slice(1).map((f, i) => f.t - rec[i].t).sort((a, b) => a - b);
      const s = earth.tiles.stats;
      return {
        frames: rec.length, emptyFrames: rec.filter(f => f.hole).length, coarseFrames: rec.filter(f => f.coarse > 0).length,
        coarseShare: rec.reduce((t, f) => t + f.coarse / Math.max(1, f.shown), 0) / Math.max(1, rec.length),
        maxGpuMB: Math.max(...rec.map(f => f.gpu)) / 1048576, budgetMB: earth.tiles.gpuBudget / 1048576,
        requests: s.requests, netMB: s.netBytes / 1048576,
        fps: 1000 / (dts.reduce((a, b) => a + b, 0) / Math.max(1, dts.length)), p95FrameMs: dts[Math.floor(dts.length * 0.95)] ?? 0,
      };
    })()`);
    await page.close();
    return r;
  } finally {
    b.close();
    await Bun.sleep(1600);
  }
}

const out: Record<string, unknown> = { base, date: new Date().toISOString(), startQuery };
const views: FirstView[] = [];
for (let i = 0; i < runs; i++) {
  const v = await firstView(startQuery);
  views.push(v);
  console.log(`run ${i + 1}: first globe ${v.firstGlobeMs.toFixed(0)} ms, view settled ${(v.settledMs / 1000).toFixed(1)} s, ${(v.bytes / 1048576).toFixed(2)} MB over the network (tiles ${(v.tileBytes / 1048576).toFixed(2)} MB, code ${(v.codeBytes / 1024).toFixed(0)} KB), ${v.requests} tile requests`);
}
const lat = views.flatMap((v) => v.latencies);
out.firstView = {
  firstGlobeMsMedian: median(views.map((v) => v.firstGlobeMs)), firstGlobeMs: views.map((v) => Math.round(v.firstGlobeMs)),
  settledSMedian: median(views.map((v) => v.settledMs / 1000)), bytesMBMedian: median(views.map((v) => v.bytes / 1048576)),
  tileLatencyP50: pct(lat, 0.5), tileLatencyP95: pct(lat, 0.95), tileResponses: lat.length,
};
console.log("first view", out.firstView);
if (!process.argv.includes("--skip-flight")) {
  // first a flight to warm the service's edge for the route (the tiles are then the same for both runs: only the
  // page's prefetching differs), unless --cold
  if (!process.argv.includes("--cold")) {
    const w = await flight(true);
    out.flightWarmup = w;
    console.log("warm-up flight (service edge cold):", w);
  }
  for (const la of [true, false]) {
    const f = await flight(la);
    out[la ? "flight" : "flightNoLookahead"] = f;
    console.log(`flight Kyoto → San Francisco in ${flightSeconds} s, look-ahead ${la ? "on" : "off"}:`, f);
  }
}
const file = resolve(root, arg("--json", "out/s3/probe.json")!);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`→ ${file}`);
