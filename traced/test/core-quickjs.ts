// Runs traced/test/core-smoke.ts in Bun and in the engine's QuickJS (`threert-render setup`) and compares the lines.
//   bun traced/test/core-quickjs.ts
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { bundleGame } from "../../engine/tools/bundle-game.ts";
import { run } from "./core-smoke.ts";
import { bin, root } from "../../tools/lib/live.ts";

const bun: string[] = [];
const s = run((k, v) => bun.push(`core-smoke ${k} ${JSON.stringify(v)}`));
for (let k = 0; k < 4; k++) await Promise.resolve();
bun.push(`core-smoke scheduler ${JSON.stringify(s.take().map((x) => x.id))}`);
const out = join(root, "out/core-smoke.js");
await bundleGame(join(root, "traced/test/core-smoke.game.ts"), out);
const all = (execFileSync("sh", ["-c", `"${bin}" setup "${out}" 2>&1`], { encoding: "utf8" })).split("\n");
const qjs = all.map((l) => l.replace(/^\[game\] /, "")).filter((l) => l.startsWith("core-smoke"));
let bad = 0;
for (let i = 0; i < Math.max(bun.length, qjs.length); i++) {
  const ok = bun[i] === qjs[i];
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "DIFF"} ${bun[i] ?? "(none)"}${ok ? "" : `\n     ${qjs[i] ?? "(none)"}`}`);
}
console.log(bad ? `${bad} lines differ` : `core: ${bun.length} checks, the same in QuickJS and Bun`);
process.exit(bad ? 1 : 0);
