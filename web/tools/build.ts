// Builds web/dist: index.html (the boot script inline), static/main-<hash>.js and its chunks, the tile worker. Paths are
// relative, so the page works at any base; the service serves dist/ at its root (its threert.json and game.js, the
// ThreeRT package, sit beside it and are not touched here).
import { gzipSync } from "node:zlib";
import { mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const web = resolve(import.meta.dirname, "..");
const out = join(web, "dist");
const minify = !process.argv.includes("--dev");

export async function build(log = true) {
  const t0 = performance.now();
  rmSync(join(out, "static"), { recursive: true, force: true });
  mkdirSync(join(out, "static"), { recursive: true });
  const common = { target: "browser" as const, format: "esm" as const, minify, sourcemap: minify ? ("none" as const) : ("linked" as const) };
  const w = await Bun.build({ ...common, entrypoints: [join(web, "src/tiles/worker.ts")], outdir: join(out, "static"), naming: "worker-[hash].[ext]" });
  if (!w.success) throw new AggregateError(w.logs, "worker build failed");
  const workerFile = w.outputs.find((o) => o.kind === "entry-point")!.path.split("/").pop()!;
  const m = await Bun.build({
    ...common,
    entrypoints: [join(web, "src/main.ts")],
    outdir: join(out, "static"),
    splitting: true,
    naming: { entry: "[name]-[hash].[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
    define: { __WORKER_URL__: JSON.stringify(`./${workerFile}`) },
  });
  if (!m.success) throw new AggregateError(m.logs, "main build failed");
  const entry = m.outputs.find((o) => o.kind === "entry-point")!.path.split("/").pop()!;
  // the entry's static imports: preloaded with it (the dynamic ones, e.g. GLTFLoader, are not)
  const code = readFileSync(join(out, "static", entry), "utf8");
  const deps = [...code.matchAll(/(?:^|[;\n}])\s*import\s*(?:[\w${},\s*]+from\s*)?["'](\.\/[\w.-]+\.js)["']/g)].map((x) => x[1].slice(2));
  let html = readFileSync(join(web, "index.html"), "utf8");
  html = html.replace("<!--MODULEPRELOAD-->", [entry, ...deps].map((f) => `<link rel="modulepreload" href="static/${f}">`).join("\n"));
  html = html.replace("<!--MAIN-->", `<script type="module" src="static/${entry}"></script>`);
  writeFileSync(join(out, "index.html"), html);
  if (log) {
    const rows: string[] = [];
    let total = 0, totalGz = 0;
    for (const f of ["index.html", ...readdirSync(join(out, "static")).map((x) => `static/${x}`)]) {
      if (f.endsWith(".map")) continue;
      const b = readFileSync(join(out, f));
      const gz = gzipSync(b).length;
      total += b.length;
      totalGz += gz;
      rows.push(`  ${f.padEnd(44)} ${(b.length / 1024).toFixed(1).padStart(8)} KB  ${(gz / 1024).toFixed(1).padStart(7)} KB gz`);
    }
    console.log(rows.join("\n"));
    console.log(`  ${"total".padEnd(44)} ${(total / 1024).toFixed(1).padStart(8)} KB  ${(totalGz / 1024).toFixed(1).padStart(7)} KB gz   (${(performance.now() - t0).toFixed(0)} ms)`);
  }
  return { entry, worker: workerFile };
}

if (import.meta.main) {
  await build();
  void statSync;
}
