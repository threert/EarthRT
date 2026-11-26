// Puts files from out/r2 into the R2 bucket under the same keys (wrangler, a few at a time).
//   bun tools/r2-put.ts <prefix under out/r2> [--concurrency 6]
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "../out/r2");
const args = process.argv.slice(2);
const prefix = args.find((a) => !a.startsWith("--")) ?? "";
const conc = Number(args[args.indexOf("--concurrency") + 1] || 6);
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const files = walk(join(ROOT, prefix));
console.log(`${files.length} files`);
let i = 0, done = 0;
await Promise.all(Array.from({ length: conc }, async () => {
  while (i < files.length) {
    const f = files[i++], key = relative(ROOT, f);
    for (let a = 0; ; a++) {
      const p = Bun.spawn([join(import.meta.dir, "../service/node_modules/.bin/wrangler"), "r2", "object", "put", `earthrt-tiles/${key}`, "--file", f, "--remote", "--content-type", "application/octet-stream"], { cwd: join(import.meta.dir, "../service"), stdout: "pipe", stderr: "pipe" });
      if ((await p.exited) === 0) break;
      if (a >= 3) { console.error(key, await new Response(p.stderr).text()); break; }
    }
    if (++done % 50 === 0) console.log(done);
  }
}));
console.log("done");
