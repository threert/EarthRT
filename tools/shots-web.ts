// Screenshots of the web engine at fixed poses, in real Chrome: each waits until the view's tiles have arrived.
//   bun tools/shots-web.ts [--base http://127.0.0.1:8795] [--out out/s3] [--only name,name] [--query "&tiles=dev"]
//   bun tools/shots-web.ts --one "at=35,135.7,3000,0,-30&hour=10" out/x.jpg
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { launch, type Page } from "./cdp.ts";

const root = resolve(import.meta.dirname, "..");
const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const base = arg("--base") ?? "http://127.0.0.1:8795";
const outDir = resolve(root, arg("--out") ?? "out/s3");
const extra = (arg("--query") ?? "") + (arg("--api") ? `&api=${arg("--api")}` : "");

export interface Pose { name: string; query: string; /** extra settling after the tiles are in, ms */ settle?: number; flight?: { progress: number } }

/** The fixed poses (tools/poses.json: time = local solar hour at the pose, on 2026-06-21 UTC unless given), and the
 *  flight the S3 acceptance asks for. */
const posesFile = JSON.parse(readFileSync(join(root, "tools/poses.json"), "utf8")) as { poses: { name: string; lat: number; lon: number; alt: number; heading: number; pitch: number; time: number; date?: string }[] };
export const POSES: Pose[] = [
  ...posesFile.poses.map((p) => {
    const day = Date.parse(`${p.date ?? "2026-06-21"}T00:00:00Z`);
    const t = new Date(day + (p.time - p.lon / 15) * 3600_000).toISOString();
    return { name: p.name, query: `at=${p.lat},${p.lon},${p.alt},${p.heading},${p.pitch}&time=${t}` };
  }),
  { name: "flight-kyoto-sf", query: "fly=kyoto;san-francisco&flightSeconds=60&time=2026-06-21T01:00:00Z", flight: { progress: 0.45 } },
];

export async function settle(page: Page, timeoutMs = 90_000, quietMs = 1200) {
  await page.waitFor("window.earth && window.earth.firstGlobeMs > 0", 30_000);
  const t0 = Date.now();
  let quietSince = 0;
  for (;;) {
    const s = await page.evaluate<{ inFlight: number; queued: number; up: number }>(
      "(() => { const s = earth.tiles.stats; return { inFlight: s.inFlight, queued: s.queued, up: earth.tiles.arrivedCount ?? 0 }; })()",
    );
    if (s.inFlight === 0 && s.queued === 0) {
      quietSince ||= Date.now();
      if (Date.now() - quietSince > quietMs) return true;
    } else quietSince = 0;
    if (Date.now() - t0 > timeoutMs) return false;
    await Bun.sleep(150);
  }
}

async function shoot(page: Page, pose: Pose, file: string) {
  if (pose.flight) {
    await page.waitFor("window.earth && earth.flight && earth.flight.active", 30_000);
    // jump the flight close to the point, then let it fly in and fill its tiles
    await page.evaluate(`(() => { const f = earth.flight; f.t = f.flight.duration * ${Math.max(0, pose.flight.progress - 0.02)}; })()`);
    await page.waitFor(`earth.flight.progress >= ${pose.flight.progress}`, 60_000);
    await page.evaluate("earth.flight.paused = true");
    await settle(page);
  } else {
    const ok = await settle(page);
    if (!ok) console.warn(`  ${pose.name}: tiles still loading at the timeout`);
  }
  await Bun.sleep(pose.settle ?? 400);
  mkdirSync(dirname(file), { recursive: true });
  await page.screenshot(file);
  const s = await page.evaluate<Record<string, number>>("(() => { const s = earth.tiles.stats; return { shown: s.shown, gpuMB: s.gpuBytes / 1048576, netMB: s.netBytes / 1048576, requests: s.requests, holes: earth.holes }; })()");
  console.log(`  ${pose.name}: ${file}  ${JSON.stringify(s)}`);
}

if (import.meta.main) {
  const logs: string[] = [];
  const b = await launch({ log: (l) => { logs.push(l); if (/error|exception/i.test(l)) console.log(l); } });
  try {
    const one = arg("--one");
    if (one) {
      const file = resolve(root, process.argv[process.argv.indexOf("--one") + 2] ?? "out/shot.jpg");
      const page = await b.open(`${base}/?${one}${extra}`);
      await shoot(page, { name: "one", query: one, flight: one.includes("fly=") ? { progress: Number(arg("--progress") ?? 0.45) } : undefined }, file);
      await page.close();
    } else {
      const only = arg("--only")?.split(",");
      for (const p of POSES) {
        if (only && !only.includes(p.name)) continue;
        const page = await b.open(`${base}/?${p.query}${extra}`);
        await shoot(page, p, join(outDir, `${p.name}.jpg`));
        await page.close();
      }
    }
  } finally {
    b.close();
  }
  if (process.argv.includes("--logs")) console.log(logs.join("\n"));
}
