// The client's streaming probe (ROADMAP "how work is judged"): the package on a fixed route in the engine's live view
// at 1280 x 720 (the GPU lock held), frame time p50 / p95 / p99 from the engine's frame log, the commit time a frame
// (`edit`), the script's own time and adds, coarse tiles (still on their way) and the process's memory.
//   bun tools/probe-client.ts [flight|descent] [--online] [--assets out/tiles] [--reconstruction metalfx-denoised,builtin]
//                             [--api URL] [--out out/s4/probe-<route>.json]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { root, startLive } from "./lib/live.ts";

const args = process.argv.slice(2);
const val = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const route = args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--")) ?? "flight";
const out = val("--out") ?? join(root, `out/s4/probe-${route}.json`);
const frameLog = join(root, `out/s4/probe-${route}.frames.jsonl`);
mkdirSync(dirname(out), { recursive: true });
if (!args.includes("--no-build")) execFileSync("bun", [join(root, "traced/build.ts")], { stdio: "inherit" });
const launch: Record<string, string> = { probe: route, time: "12" };
if (val("--api")) launch.api = val("--api")!;
const live = await startLive(join(root, "traced/dist/traced.js"), {
  assets: val("--assets"), online: args.includes("--online"), earth: args.includes("--earth"), launch, frameLog, quiet: true,
  reconstruction: val("--reconstruction") ?? "metalfx-denoised,builtin",
});
const pid = (live as unknown as { pid?: number }).pid;
const footprint = (): number => {
  try {
    const p = execFileSync("pgrep", ["-n", "-f", "threert-render live"], { encoding: "utf8" }).trim();
    const m = /^\s*\d+\s+([\d.]+)([KMG])\+?/m.exec(execFileSync("top", ["-l", "1", "-pid", p, "-stats", "pid,mem"], { encoding: "utf8" }).split("PID")[1] ?? "");
    return m ? Number(m[1]) / (m[2] === "G" ? 1 : m[2] === "M" ? 1024 : 1048576) : NaN;
  } catch {
    return NaN;
  }
};
void pid;
const mem: number[] = [];
const sampler = setInterval(() => mem.push(footprint()), 5000);
const t0 = Date.now();
await live.wait((l) => l.includes("earth-probe end"), 20 * 60_000).catch((e) => console.log(`(no end: ${e.message})`));
clearInterval(sampler);
mem.push(footprint());
await live.snapshot(join(root, `out/s4/probe-${route}-end.png`), 8);
await live.quit();
const probe = live.lines.filter((l) => l.includes("earth-probe {")).map((l) => JSON.parse(l.slice(l.indexOf("{"))));
const F = readFileSync(frameLog, "utf8").trim().split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) as { interval: number; gpu: number; edit?: number; rebuild?: number; scale?: number; fallback?: string }[];
const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const iv = F.map((f) => f.interval).filter((x) => x > 0), gpu = F.map((f) => f.gpu), edit = F.map((f) => f.edit ?? 0);
const result = {
  route, online: args.includes("--online"), seconds: (Date.now() - t0) / 1000, frames: F.length,
  interval: { p50: q(iv, 0.5), p95: q(iv, 0.95), p99: q(iv, 0.99), max: q(iv, 1), over33: iv.filter((x) => x > 33.4).length, over50: iv.filter((x) => x > 50).length },
  fps: 1000 / q(iv, 0.5),
  gpu: { p50: q(gpu, 0.5), p95: q(gpu, 0.95) },
  commit: { p50: q(edit, 0.5), p95: q(edit, 0.95), p99: q(edit, 0.99), max: q(edit, 1) },
  rebuilds: F.filter((f) => (f.rebuild ?? 0) > 1).map((f) => ({ ms: Math.round(f.rebuild!), why: f.fallback })).slice(0, 10),
  scale: q(F.map((f) => f.scale ?? 1), 0.5),
  script: { avg: probe.reduce((s, p) => s + p.scriptAvg, 0) / Math.max(1, probe.length), max: Math.max(0, ...probe.map((p) => p.scriptMax)), selectMax: Math.max(0, ...probe.map((p) => p.selectMs)), addMaxMs: Math.max(0, ...probe.map((p) => p.maxAddMs)) },
  tiles: { added: probe.reduce((s, p) => s + p.added, 0), removed: probe.reduce((s, p) => s + p.removed, 0), maxResident: Math.max(0, ...probe.map((p) => p.tiles)), maxResidentTris: Math.max(0, ...probe.map((p) => p.tris)), maxShownTris: Math.max(0, ...probe.map((p) => p.shownTris)), holes: probe.filter((p) => p.holes).length, coarseMax: Math.max(0, ...probe.map((p) => p.coarse)) },
  memoryGB: { peak: Math.max(...mem.filter((x) => !isNaN(x))), end: mem[mem.length - 1], samples: mem.map((x) => +x.toFixed(2)) },
  fetched: live.fetches.n, fetchedMB: +(live.fetches.bytes / 1048576).toFixed(1), fetchMs: { p50: q(live.fetches.ms, 0.5), p95: q(live.fetches.ms, 0.95) },
  interrupted: live.lines.filter((l) => l.includes("interrupted")).length,
};
writeFileSync(out, JSON.stringify({ result, probe }, null, 1));
writeFileSync(out.replace(/\.json$/, ".log"), live.lines.join("\n"));
console.log(JSON.stringify(result, null, 1));
