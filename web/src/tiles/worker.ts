// A tile worker: fetches (through the Cache Storage API), decodes and packs tiles off the main thread, and hands the
// arrays back as transferables. Several run as a pool (tiles/pool.ts).
import { decodeErp, parseKey } from "@earthrt/core";
import { packBuildings, packTerrain } from "./pack.ts";
import { devTerrainTile, TERRARIUM } from "./dev-source.ts";
import { transferablesOf, type PackedTile } from "./gpu-format.ts";

export type WorkerRequest =
  | { op: "get"; id: number; url: string; layer: "terrain" | "buildings"; cache: string | null; priority: "high" | "low" | "auto" }
  | { op: "unpack"; id: number; bytes: ArrayBuffer }
  | { op: "abort"; id: number };

export type WorkerResponse =
  | { id: number; ok: true; tile: PackedTile }
  | { id: number; ok: true; tiles: PackedTile[] }
  | { id: number; ok: false; error: string; status?: number };

const scope = self as unknown as { postMessage(m: unknown, t?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null };
const aborts = new Map<number, AbortController>();
const cacheOpen = new Map<string, Promise<Cache | null>>();

function openCache(name: string | null): Promise<Cache | null> {
  if (!name || typeof caches === "undefined") return Promise.resolve(null);
  let c = cacheOpen.get(name);
  if (!c) cacheOpen.set(name, (c = caches.open(name).catch(() => null)));
  return c;
}

/** Bytes of a URL, from the cache when it is there (and into it when not). */
async function fetchBytes(url: string, cacheName: string | null, signal: AbortSignal, priority: RequestInit["priority"]) {
  const t0 = performance.now();
  const cache = await openCache(cacheName);
  const hit = cache ? await cache.match(url).catch(() => undefined) : undefined;
  if (hit) {
    const b = await hit.arrayBuffer();
    return { status: hit.status, bytes: b, netMs: performance.now() - t0, cached: true };
  }
  const res = await fetch(url, { signal, priority, mode: "cors", credentials: "omit" });
  if (res.status === 204 || res.status === 404) {
    // (no data there: remembered too, so it is not asked for again)
    if (cache && res.status === 204) cache.put(url, new Response(null, { status: 204 })).catch(() => {});
    return { status: res.status, bytes: new ArrayBuffer(0), netMs: performance.now() - t0, cached: false };
  }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${url}`), { status: res.status });
  const bytes = await res.arrayBuffer();
  if (cache) cache.put(url, new Response(bytes.slice(0), { headers: { "content-type": res.headers.get("content-type") ?? "application/octet-stream" } })).catch(() => {});
  return { status: res.status, bytes, netMs: performance.now() - t0, cached: false };
}

async function decodePng(bytes: ArrayBuffer): Promise<Uint8ClampedArray> {
  const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  bmp.close();
  return g.getImageData(0, 0, c.width, c.height, { colorSpace: "srgb" }).data;
}

async function get(req: Extract<WorkerRequest, { op: "get" }>, signal: AbortSignal): Promise<PackedTile> {
  if (req.url.startsWith("dev:")) {
    // dev:terrain/<key>: a compact tile made here from Terrarium heights
    const key = parseKey(req.url.slice("dev:terrain/".length));
    let rgba: Uint8ClampedArray | null = null;
    let net = { netMs: 0, bytes: 0, cached: false };
    if (!("cap" in key)) {
      const r = await fetchBytes(`${TERRARIUM}/${key.z}/${key.x}/${key.y}.png`, "earthrt-dev-terrarium", signal, req.priority);
      net = { netMs: r.netMs, bytes: r.bytes.byteLength, cached: r.cached };
      if (r.bytes.byteLength) rgba = await decodePng(r.bytes);
    }
    const compact = devTerrainTile(key, rgba);
    const t = packTerrain(compact);
    return { ...t, netMs: net.netMs, netBytes: net.bytes, cached: net.cached };
  }
  const r = await fetchBytes(req.url, req.cache, signal, req.priority);
  const key = req.url.match(/\/(terrain|buildings)\/(.+)\.c\.ert$/)?.[2] ?? req.url;
  if (!r.bytes.byteLength) return { kind: "empty", key, netMs: r.netMs, netBytes: 0, cached: r.cached };
  const t = req.layer === "terrain" ? packTerrain(r.bytes) : packBuildings(r.bytes);
  return { ...t, netMs: r.netMs, netBytes: r.bytes.byteLength, cached: r.cached };
}

scope.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const m = e.data;
  if (m.op === "abort") {
    aborts.get(m.id)?.abort();
    aborts.delete(m.id);
    return;
  }
  if (m.op === "unpack") {
    try {
      const tiles = decodeErp(m.bytes).map((f) => packTerrain(f));
      scope.postMessage({ id: m.id, ok: true, tiles } satisfies WorkerResponse, tiles.flatMap(transferablesOf));
    } catch (err) {
      scope.postMessage({ id: m.id, ok: false, error: String(err) } satisfies WorkerResponse);
    }
    return;
  }
  const ac = new AbortController();
  aborts.set(m.id, ac);
  try {
    const tile = await get(m, ac.signal);
    if (ac.signal.aborted) return;
    scope.postMessage({ id: m.id, ok: true, tile } satisfies WorkerResponse, transferablesOf(tile));
  } catch (err) {
    if (ac.signal.aborted) return;
    scope.postMessage({ id: m.id, ok: false, error: String((err as Error)?.message ?? err), status: (err as { status?: number }).status } satisfies WorkerResponse);
  } finally {
    aborts.delete(m.id);
  }
};
