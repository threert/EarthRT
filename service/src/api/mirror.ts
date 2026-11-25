// /p/<owner>/<repo>/<sha>/<path>: a place's files at a registered commit, read from GitHub once (Git LFS pointers
// followed), kept in R2, immutable. Served only on the files host: user content never comes from the app's origin.
import type { Env } from "../env.ts";
import { mediaUrl, rawUrl, UA } from "./github.ts";

const MAX = 64 * 1024 * 1024;

const TYPES: Record<string, string> = {
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  json: "application/json",
  js: "text/plain; charset=utf-8",
  cjs: "text/plain; charset=utf-8",
  mjs: "text/plain; charset=utf-8",
  ts: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  ktx2: "image/ktx2",
};
/** A type that is never a page (no html, no svg): anything else is bytes. */
export const contentType = (path: string) => TYPES[path.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";

export function allowedOrigin(env: Env, origin: string | null): string | null {
  if (!origin) return null;
  if (env.APP_HOST && origin === `https://${env.APP_HOST}`) return origin;
  if (/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return origin;
  if ((env.EXTRA_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean).includes(origin)) return origin;
  return null;
}

const PATH = /^\/p\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/([0-9a-f]{40})\/(.+)$/;

export async function handleMirror(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const origin = allowedOrigin(env, req.headers.get("origin"));
  const base: Record<string, string> = {
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "cross-origin",
    ...(origin ? { "access-control-allow-origin": origin, vary: "origin" } : { vary: "origin" }),
  };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...base, "access-control-allow-methods": "GET, HEAD", "access-control-max-age": "86400" } });
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: base });
  const m = PATH.exec(url.pathname);
  if (!m) return new Response("not a mirror address: /p/<owner>/<repo>/<sha>/<path>", { status: 404, headers: base });
  const [, owner, name, sha] = m;
  let path: string;
  try { path = decodeURIComponent(m[4]); } catch { return new Response("bad path", { status: 400, headers: base }); }
  if (path.split("/").some((s) => s === ".." || s === "." || s === "") || path.includes("\\")) return new Response("bad path", { status: 400, headers: base });
  const repo = `${owner}/${name}`;
  const type = contentType(path);
  const headers = { ...base, "content-type": type, "cache-control": "public, max-age=31536000, immutable" };

  const cacheKey = new Request(`${url.origin}${url.pathname}`);
  const hit = await caches.default.match(cacheKey);
  if (hit) return withCors(hit, base, req.method);

  const key = `mirror/${repo.toLowerCase()}/${sha}/${path}`;
  let obj = await env.TILES.get(key);
  let how = "r2";
  if (!obj) {
    // only commits a place was registered at
    const v = await env.DB.prepare("SELECT 1 FROM versions WHERE repo = ? AND sha = ?").bind(repo.toLowerCase(), sha).first();
    if (!v) return new Response("not a registered place commit", { status: 404, headers: { ...base, "cache-control": "no-store" } });
    let r = await fetch(rawUrl(env, repo, sha, path), { headers: { "user-agent": UA } });
    if (r.status === 404) return new Response("no such file at that commit", { status: 404, headers: { ...base, "cache-control": "public, max-age=300" } });
    if (!r.ok) return new Response(`GitHub: ${r.status}`, { status: 502, headers: { ...base, "cache-control": "no-store" } });
    let len = Number(r.headers.get("content-length") ?? NaN);
    if (len > MAX) return new Response("file larger than 64 MiB", { status: 413, headers: base });
    // a Git LFS pointer is small text: look at it, then fetch the real bytes
    let body: ReadableStream | Uint8Array | null = r.body;
    if (!(len > 200)) {
      const bytes = new Uint8Array(await r.arrayBuffer());
      const head = new TextDecoder().decode(bytes.subarray(0, 200));
      if (head.startsWith("version https://git-lfs.github.com/spec/v1")) {
        r = await fetch(mediaUrl(env, repo, sha, path), { headers: { "user-agent": UA } });
        if (!r.ok) return new Response(`GitHub LFS: ${r.status}`, { status: 502, headers: { ...base, "cache-control": "no-store" } });
        len = Number(r.headers.get("content-length") ?? NaN);
        if (len > MAX) return new Response("file larger than 64 MiB", { status: 413, headers: base });
        body = r.body;
        how = "github-lfs";
      } else {
        body = bytes;
        len = bytes.length;
      }
    } else how = "github";
    if (body instanceof Uint8Array || !(len >= 0)) {
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
      if (bytes.length > MAX) return new Response("file larger than 64 MiB", { status: 413, headers: base });
      await env.TILES.put(key, bytes, { httpMetadata: { contentType: type } });
    } else {
      const fixed = new FixedLengthStream(len);
      const done = env.TILES.put(key, fixed.readable, { httpMetadata: { contentType: type } });
      await body!.pipeTo(fixed.writable);
      await done;
    }
    obj = await env.TILES.get(key);
    if (!obj) return new Response("mirror write failed", { status: 502, headers: base });
  }
  const res = new Response(obj.body, { headers: { ...headers, "content-length": String(obj.size), etag: `"${sha}"`, "x-earthrt": how } });
  // the cache keeps a copy without CORS headers (they depend on the asker)
  const plain = new Headers(res.headers);
  plain.delete("access-control-allow-origin");
  const [a, b] = res.body!.tee();
  const toCache = new Response(b, { headers: plain });
  ctx.waitUntil(caches.default.put(cacheKey, toCache).catch(() => {}));
  if (req.method === "HEAD") { a.cancel().catch(() => {}); return new Response(null, { headers: res.headers }); }
  return new Response(a, { headers: res.headers });
}

function withCors(hit: Response, base: Record<string, string>, method: string) {
  const h = new Headers(hit.headers);
  for (const [k, v] of Object.entries(base)) h.set(k, v);
  if (!base["access-control-allow-origin"]) h.delete("access-control-allow-origin");
  h.set("x-earthrt", "edge");
  return new Response(method === "HEAD" ? null : hit.body, { status: hit.status, headers: h });
}
