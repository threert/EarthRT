// Building extracts: cuts each region of service/src/gen/buildings.ts REGIONS out of the latest Protomaps basemap
// build (z15 only: the generator reads z15) with the go-pmtiles CLI, and puts it in R2.
//   bun tools/regions.ts [--only kansai,tokyo] [--upload] [--build 20261120]
// Needs `pmtiles` (brew install pmtiles, or go install github.com/protomaps/go-pmtiles@latest → go-pmtiles).
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { REGIONS, regionObject } from "../service/src/gen/buildings.ts";
import { curl } from "./lib/bun-upstream.ts";

const args = process.argv.slice(2);
const opt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const only = opt("--only")?.split(",");
const OUT = join(import.meta.dir, "../out/r2");

const bin = ["pmtiles", "go-pmtiles", join(process.env.HOME!, "go/bin/go-pmtiles")].find((b) => Bun.spawnSync(["which", b]).exitCode === 0 || existsSync(b));
if (!bin) throw new Error("no pmtiles CLI: brew install pmtiles, or go install github.com/protomaps/go-pmtiles@latest");

let build = opt("--build");
if (!build) {
  const r = await curl("https://build-metadata.protomaps.dev/builds.json");
  const builds = JSON.parse(new TextDecoder().decode(r.body)) as { key: string }[];
  build = builds.map((b) => b.key.replace(/\.pmtiles$/, "")).sort().pop()!;
}
console.log(`Protomaps build ${build}`);

for (const r of REGIONS) {
  if (only && !only.includes(r.key)) continue;
  const key = regionObject(r), file = join(OUT, key);
  mkdirSync(join(file, ".."), { recursive: true });
  if (!existsSync(file) || args.includes("--force")) {
    const t0 = performance.now();
    const p = Bun.spawn([bin, "extract", `https://build.protomaps.com/${build}.pmtiles`, file, `--bbox=${r.bbox.join(",")}`, "--minzoom=15", "--maxzoom=15", "--download-threads=8"], { stdout: "inherit", stderr: "inherit" });
    if (await p.exited) throw new Error(`extract ${r.key} failed`);
    console.log(`${r.name}: ${(statSync(file).size / 1e6).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  } else console.log(`${r.name}: have ${(statSync(file).size / 1e6).toFixed(1)} MB`);
  if (args.includes("--upload")) {
    const t0 = performance.now();
    const p = Bun.spawn([join(import.meta.dir, "../service/node_modules/.bin/wrangler"), "r2", "object", "put", `earthrt-tiles/${key}`, "--file", file, "--remote", "--content-type", "application/vnd.pmtiles"], { cwd: join(import.meta.dir, "../service"), stdout: "inherit", stderr: "inherit" });
    if (await p.exited) throw new Error(`upload ${r.key} failed`);
    console.log(`  uploaded in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  }
}
