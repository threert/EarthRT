// Stills of the traced view in the engine's live view (its own window-less runner, this script as the app):
//   bun tools/shot.ts <name>... [--online] [--assets out/real] [--out out/s4] [--after 48] [--wait 120] [--suffix -before]
// Names (the Kyoto places, SPEC § 5 registry ids, with a camera each; `--at lat,lon,alt,heading,pitch` overrides):
//   machiya, tower, tower-lowpoly, cube — or --place <owner/repo/id> --name <name>.
// Each waits for "traced: ready" (the place and its surroundings in), then for the denoiser's history.
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { root, startLive } from "./lib/live.ts";

export const PLACES: Record<string, { place: string; at?: string; time?: string }> = {
  // inside the back parlour, toward the garden and the andon
  machiya: { place: "threert/earth-sample-gion-machiya/gion-machiya", time: "15" },
  "machiya-dusk": { place: "threert/earth-sample-gion-machiya/gion-machiya", time: "18.6" },
  // over the roofs of Karasuma street, 400 m north of the tower, looking south at it
  tower: { place: "threert/earth-sample-kyoto-tower/kyoto-tower", at: "34.9912,135.7596,95,184,4", time: "15" },
  "tower-lowpoly": { place: "threert/earth-sample-kyoto-tower-lowpoly/kyoto-tower", at: "34.9912,135.7596,95,184,4", time: "15" },
  "tower-air": { place: "threert/earth-sample-kyoto-tower/kyoto-tower", at: "34.9830,135.7550,250,35,-12", time: "15" },
  cube: { place: "threert/earth-sample-cube/sample-cube", time: "15" },
};

const args = process.argv.slice(2);
const val = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const outDir = val("--out") ?? join(root, "out/s4");
const takesValue = new Set(["--out", "--assets", "--after", "--wait", "--suffix", "--at", "--time", "--place", "--name"]);
const names = args.filter((a, i) => !a.startsWith("--") && !takesValue.has(args[i - 1]));
const jobs: { name: string; launch: Record<string, string> }[] = [];
for (const n of names) {
  const p = PLACES[n];
  if (!p) throw new Error(`no place ${n} (${Object.keys(PLACES).join(", ")})`);
  jobs.push({ name: n, launch: { place: p.place, ...(p.at ? { at: p.at } : {}), ...(p.time ? { time: p.time } : {}) } });
}
if (val("--place")) jobs.push({ name: val("--name") ?? "place", launch: { place: val("--place")! } });
for (const j of jobs) {
  if (val("--at")) j.launch.at = val("--at")!;
  if (val("--time")) j.launch.time = val("--time")!;
}
if (!args.includes("--no-build")) execFileSync("bun", [join(root, "traced/build.ts")], { stdio: "inherit" });
for (const j of jobs) {
  const t0 = Date.now();
  const live = await startLive(join(root, "traced/dist/traced.js"), { assets: val("--assets") ?? join(root, "out/real"), online: !args.includes("--offline"), traced: args.includes("--traced"), launch: j.launch });
  try {
    const ready = await live.wait((l) => l.includes("traced: ready"), Number(val("--wait") ?? 120) * 1000).catch(() => "(not ready: shot anyway)");
    console.log(`  ${ready.replace(/^\[game\] /, "")}`);
    const path = join(outDir, `${j.name}${val("--suffix") ?? ""}.png`);
    await live.snapshot(path, Number(val("--after") ?? 48));
    console.log(`${path} (${((Date.now() - t0) / 1000).toFixed(0)} s; ${live.fetches.n} files fetched, ${(live.fetches.bytes / 1048576).toFixed(0)} MB)`);
  } finally {
    await live.quit();
  }
}
