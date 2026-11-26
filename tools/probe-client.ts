// The traced view's probe (ROADMAP S4): the script in the engine's live view at 1280 x 720 with the GPU lock, this
// script as the app (it answers assets.fetch and net.fetch, lists "assets" and "traced"). It enters the Kyoto places
// one after another with `traced.open`, as the app does, and measures for each: the time to `traced.ready` (from the
// cache after the first round), the frame interval p50 / p95 / p99 while still and while walking, the commit time, and
// the process's memory after it (entries in a row must not grow it).
//   bun tools/probe-client.ts [--rounds 3] [--reconstruction metalfx-denoised,builtin] [--assets out/real] [--out out/s4/probe.json]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { root, startLive } from "./lib/live.ts";
import { PLACES } from "./places.ts";

const args = process.argv.slice(2);
const val = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const out = val("--out") ?? join(root, "out/s4/probe.json");
const frameLog = out.replace(/\.json$/, ".frames.jsonl");
const rounds = Number(val("--rounds") ?? 3);
const api = val("--api") ?? "https://earth.threert.dev";
mkdirSync(dirname(out), { recursive: true });
if (!args.includes("--no-build")) execFileSync("bun", [join(root, "traced/build.ts")], { stdio: "inherit" });

const curl = (url: string) => execFileSync("curl", ["-s", "-L", "--max-time", "30", ...(process.env.HTTPS_PROXY ? ["-x", process.env.HTTPS_PROXY] : []), url], { encoding: "utf8" });
const names = ["machiya", "tower", "tower-lowpoly", "tower-air"].filter((n) => PLACES[n]);
const records = new Map<string, unknown>();
for (const n of names) {
  const id = PLACES[n].place;
  if (!records.has(id)) {
    const j = JSON.parse(curl(`${api}/api/v1/places/${id}`));
    records.set(id, j.manifest ? j : j.place);
  }
}
const camera = (n: string) => {
  const at = PLACES[n].at;
  if (!at) return undefined;
  const [lat, lon, alt, heading, pitch] = at.split(",").map(Number);
  return { lat, lon, alt, heading, pitch, fov: 50 };
};

const live = await startLive(join(root, "traced/dist/traced.js"), {
  assets: val("--assets") ?? join(root, "out/real"), online: true, traced: true, frameLog, quiet: true,
  launch: { width: "1280", height: "720" }, reconstruction: val("--reconstruction") ?? "metalfx-denoised,builtin",
});
const footprint = (): number => {
  try {
    const p = execFileSync("pgrep", ["-n", "-f", "threert-render live"], { encoding: "utf8" }).trim();
    const m = /^\s*\d+\s+([\d.]+)([KMG])\+?/m.exec(execFileSync("top", ["-l", "1", "-pid", p, "-stats", "pid,mem"], { encoding: "utf8" }).split("PID")[1] ?? "");
    return m ? Number(m[1]) / (m[2] === "G" ? 1 : m[2] === "M" ? 1024 : 1048576) : NaN;
  } catch {
    return NaN;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frames = () => readFileSync(frameLog, "utf8").trim().split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) as { interval: number; gpu: number; edit?: number }[];
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1) : NaN; };
const stats = (F: { interval: number; gpu: number; edit?: number }[]) => ({ frames: F.length, p50: q(F.map((f) => f.interval), 0.5), p95: q(F.map((f) => f.interval), 0.95), p99: q(F.map((f) => f.interval), 0.99), gpu50: q(F.map((f) => f.gpu), 0.5), commit95: q(F.map((f) => f.edit ?? 0), 0.95) });

const entries: unknown[] = [];
let k = 0;
for (let r = 0; r < rounds; r++) {
  for (const n of names) {
    k++;
    const mark = live.lines.length;
    const t0 = Date.now();
    live.send({ cmd: "host", messages: [{ t: "traced.open", place: records.get(PLACES[n].place), camera: camera(n), utc: Date.UTC(2026, 5, 21, 6, 0) }] });
    let ready = NaN;
    for (let w = 0; w < 1200 && isNaN(ready); w++) {
      if (live.lines.slice(mark).some((l) => l.includes("traced: ready"))) ready = (Date.now() - t0) / 1000;
      else await sleep(100);
    }
    const n0 = frames().length;
    await sleep(4000);
    const still = frames().slice(n0);
    // walking: the app's input, W held for 3 s
    const n1 = frames().length;
    live.send({ cmd: "host", messages: [{ t: "input", keys: ["W"] }] });
    await sleep(3000);
    live.send({ cmd: "host", messages: [{ t: "input", keys: [] }] });
    const walk = frames().slice(n1);
    const e = { k, round: r, place: n, readyS: +ready.toFixed(2), still: stats(still), walk: stats(walk), memoryGB: +footprint().toFixed(2) };
    entries.push(e);
    console.log(JSON.stringify(e));
  }
}
await live.snapshot(join(root, "out/s4/probe-end.png"), 8);
await live.quit();
const interrupted = live.lines.filter((l) => l.includes("interrupted")).length;
writeFileSync(out, JSON.stringify({ reconstruction: val("--reconstruction") ?? "metalfx-denoised,builtin", interrupted, entries }, null, 1));
writeFileSync(out.replace(/\.json$/, ".log"), live.lines.join("\n"));
console.log(`interrupted frames: ${interrupted}; ${out}`);
