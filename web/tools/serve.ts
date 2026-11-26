// A local server for web/dist: rebuilds on change (--watch), proxies /tiles, /api and /p to a service when one is
// given (--service http://127.0.0.1:8790 for a `wrangler dev`, or https://earth.threert.dev), and serves web/dev/
// fixtures (sample places) under /dev/. Without a service the page uses its dev tile source.
//   bun tools/serve.ts [--port 8795] [--service <url>] [--watch]
import { watch } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { build } from "./build.ts";

const web = resolve(import.meta.dirname, "..");
const dist = join(web, "dist");
const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const port = Number(arg("--port") ?? 8795);
const service = arg("--service")?.replace(/\/+$/, "");

await build();
if (process.argv.includes("--watch")) {
  let timer: Timer | undefined;
  for (const dir of [join(web, "src"), join(web, "index.html"), resolve(web, "../packages/core/src")]) {
    watch(dir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => build().catch((e) => console.error(e)), 120);
    });
  }
}

const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript", json: "application/json", glb: "model/gltf-binary", map: "application/json" };

Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    const path = normalize(decodeURIComponent(url.pathname));
    if (service && /^\/(tiles|api|p)\//.test(path)) {
      const headers: Record<string, string> = {};
      for (const k of ["accept", "authorization", "content-type", "if-none-match"]) { const v = req.headers.get(k); if (v) headers[k] = v; }
      const r = await fetch(service + url.pathname + url.search, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer() });
      const h = new Headers(r.headers);
      h.delete("content-encoding");
      h.delete("content-length");
      return new Response(r.body, { status: r.status, headers: h });
    }
    const root = path.startsWith("/dev/") ? web : dist;
    const file = join(root, path.endsWith("/") ? path + "index.html" : path);
    if (!file.startsWith(root)) return new Response("no", { status: 403 });
    const f = Bun.file(file);
    if (!(await f.exists())) return new Response("not found", { status: 404 });
    const ext = file.split(".").pop() ?? "";
    const immutable = path.startsWith("/static/");
    return new Response(f, {
      headers: {
        "content-type": TYPES[ext] ?? "application/octet-stream",
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
        "access-control-allow-origin": "*",
      },
    });
  },
});
console.log(`EarthRT web: http://127.0.0.1:${port}/${service ? `  (tiles and API from ${service})` : "  (dev tile source)"}`);
