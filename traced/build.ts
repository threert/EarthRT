// Builds the traced view's script: traced/dist/traced.js, one script for the engine's QuickJS (the game, @earthrt/core, the
// ThreeRT runtime and the node host: the engine's tools/bundle-game.ts). The native app (native/) loads it; so does
// `threert-render play` (traced/README.md).
//
//   bun traced/build.ts
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { bundleGame } from "../engine/tools/bundle-game.ts";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "traced/dist");
mkdirSync(dist, { recursive: true });
const out = join(dist, "traced.js");
const r = await bundleGame(join(root, "traced/src/traced.game.ts"), out);
const code = readFileSync(out);
const version = JSON.parse(readFileSync(join(root, "traced/package.json"), "utf8")).version as string;
const hash = createHash("sha256").update(code).digest("hex");
// (what the app checks before loading it: the bundle's version and hash, and the engine it was built against)
const engine = (() => {
  try {
    return execFileSync("git", ["-C", join(root, "engine"), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
})();
writeFileSync(join(dist, "traced.json"), JSON.stringify({ name: "traced.js", version, sha256: hash, bytes: code.length, engine }, null, 2) + "\n");
console.log(`traced/dist/traced.js ${(r.bytes / 1024).toFixed(0)} KiB (${r.ms.toFixed(0)} ms) ${hash.slice(0, 12)}`);
