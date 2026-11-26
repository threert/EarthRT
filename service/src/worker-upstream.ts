// The generator's Upstream inside the Worker: the Cache API in front of fetch (ranges are cached as 200 responses under
// a synthetic key), R2 for our own objects.
import type { Upstream } from "./gen/upstream.ts";

const MISSING = "x-earthrt-missing";
const TTL = 60 * 60 * 24 * 30;

/** A second request when the first is slow (S3's tail): the first answer wins. */
function hedged(make: () => Promise<Response>, after = 1200): Promise<Response> {
  return new Promise((resolve, reject) => {
    let settled = false, failures = 0, started = 1;
    const go = () => make().then(
      (r) => { if (!settled) { settled = true; resolve(r); } else r.body?.cancel().catch(() => {}); },
      (e) => { if (++failures === started && !settled) { settled = true; reject(e); } },
    );
    go();
    setTimeout(() => { if (!settled) { started++; go(); } }, after);
  });
}

async function cachedFetch(key: string, make: () => Promise<Response>, ctx?: ExecutionContext): Promise<Uint8Array | null> {
  const cache = caches.default;
  const req = new Request(key);
  const hit = await cache.match(req);
  if (hit) {
    if (hit.headers.get(MISSING)) return null;
    return new Uint8Array(await hit.arrayBuffer());
  }
  let r: Response | null = null;
  let err: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      r = await hedged(make);
      if (r.status < 500) break;
      await r.body?.cancel();
      err = new Error(`${r.status} ${key}`);
      r = null;
    } catch (e) {
      err = e;
    }
    await new Promise((res) => setTimeout(res, 200 * (i + 1)));
  }
  if (!r) throw err;
  if (r.status === 404 || r.status === 403) {
    await r.body?.cancel();
    const put = cache.put(req, new Response("", { headers: { [MISSING]: "1", "cache-control": `public, max-age=${TTL}` } }));
    ctx ? ctx.waitUntil(put) : await put;
    return null;
  }
  if (!r.ok && r.status !== 206) throw new Error(`${r.status} ${key}`);
  const body = new Uint8Array(await r.arrayBuffer());
  const put = cache.put(req, new Response(body, { headers: { "cache-control": `public, max-age=${TTL}`, "content-type": "application/octet-stream" } }));
  ctx ? ctx.waitUntil(put) : await put;
  return body;
}

export class WorkerUpstream implements Upstream {
  constructor(private bucket: R2Bucket, private ctx?: ExecutionContext) {}
  get(url: string) {
    return cachedFetch(url, () => fetch(url, { cf: { cacheTtl: TTL, cacheEverything: true }, signal: AbortSignal.timeout(15_000) }), this.ctx);
  }
  async range(url: string, start: number, length: number) {
    const key = `https://upstream.earthrt.internal/range/${start}/${length}/${encodeURIComponent(url)}`;
    const body = await cachedFetch(key, () => fetch(url, { headers: { range: `bytes=${start}-${start + length - 1}` }, signal: AbortSignal.timeout(15_000) }), this.ctx);
    if (body && body.length > length) return body.subarray(start, start + length); // a server that ignored the range
    return body;
  }
  async getObject(key: string) {
    const o = await this.bucket.get(key);
    return o ? new Uint8Array(await o.arrayBuffer()) : null;
  }
  async getObjectRange(key: string, start: number, length: number) {
    const o = await this.bucket.get(key, { range: { offset: start, length } });
    return o ? new Uint8Array(await o.arrayBuffer()) : null;
  }
  async putObject(key: string, bytes: Uint8Array, contentType = "application/octet-stream") {
    await this.bucket.put(key, bytes, { httpMetadata: { contentType } });
  }
}
