// /tiles/v1: the trunk (SPEC § 3). Every tile is made on its first request, kept in R2 and cached at the edge.
import { keyOf, decodeErt, encodeErp, encodeTerrainExpanded, expandTerrain, expandBuildings, encodeBuildingsExpanded, parseKey, type TileKey } from "@earthrt/core";
import { makeTerrainTile, N, skirtFor, type TerrainTimings } from "./gen/terrain.ts";
import { WorldCover } from "./gen/landcover.ts";
import { makeBuildingsTile, REGIONS, BUILDINGS_ZOOM } from "./gen/buildings.ts";
import { MemoUpstream, type Upstream } from "./gen/upstream.ts";
import { WorkerUpstream } from "./worker-upstream.ts";
import type { Env } from "./env.ts";

/** The generation of the generator: bump when what tiles hold changes (SPEC § 3). */
export const GEN = "g5";
export const MAX_Z = 14;
/** The top pack: z0 … this and the caps (z2 too would be 315 KB with brotli). */
export const TOP_MAX_Z = 1;

export const ATTRIBUTION = [
  "Terrain: Mapzen Terrain Tiles on AWS (SRTM, GMTED, ETOPO1, NED and others; https://github.com/tilezen/joerd/blob/master/docs/attribution.md)",
  "Terrain in Japan: Geospatial Information Authority of Japan (GSI tiles, 国土地理院 標高タイル)",
  "Land cover: © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium (CC BY 4.0)",
  "Buildings: © OpenStreetMap contributors (ODbL), via Protomaps",
];

const IMMUTABLE = "public, max-age=31536000, immutable";
const BIN = "application/octet-stream";

export function meta() {
  return {
    v: 1,
    gen: GEN,
    terrain: { maxZoom: MAX_Z, n: N, skirt: skirtFor({ z: MAX_Z, x: 0, y: 1 << (MAX_Z - 1) }), skirtPerTile: true },
    buildings: { zoom: BUILDINGS_ZOOM, regions: REGIONS.map((r) => ({ name: r.name, bbox: r.bbox })) },
    attribution: ATTRIBUTION,
  };
}

let memo: MemoUpstream | null = null;
/** One memo per isolate (upstream bytes shared by the tiles made in it). */
function upstreamFor(env: Env, _ctx: ExecutionContext): Upstream {
  if (!memo) memo = new MemoUpstream(new WorkerUpstream(env.TILES));
  return memo;
}

interface Made { bytes: Uint8Array | null; how: string; timing?: string }

function key(path: string) { return `tiles/v1/${GEN}/${path}`; }

async function fromR2(env: Env, k: string): Promise<Uint8Array | null | undefined> {
  const o = await env.TILES.get(k);
  if (!o) return undefined;
  const b = new Uint8Array(await o.arrayBuffer());
  return b.length ? b : null; // empty object: "no data here" (204)
}

async function store(env: Env, ctx: ExecutionContext, k: string, bytes: Uint8Array | null) {
  ctx.waitUntil(env.TILES.put(k, bytes ?? new Uint8Array(0), { httpMetadata: { contentType: BIN } }));
}

const inflight = new Map<string, Promise<Made>>();
function once(k: string, make: () => Promise<Made>): Promise<Made> {
  let p = inflight.get(k);
  if (!p) {
    p = make().finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  return p;
}

export function terrainCompact(env: Env, ctx: ExecutionContext, tk: TileKey, path: string): Promise<Made> {
  const k = key(path);
  return once(k, async () => {
    const r2 = await fromR2(env, k);
    if (r2 !== undefined) return { bytes: r2, how: "r2" };
    const t: TerrainTimings = { fetch: 0, landcover: 0, build: 0 };
    const up = upstreamFor(env, ctx);
    const bytes = await makeTerrainTile(up, tk, new WorldCover(up), t);
    await store(env, ctx, k, bytes);
    return { bytes, how: "made", timing: `src;dur=${t.fetch}, lc;dur=${t.landcover}, build;dur=${t.build}` };
  });
}

async function terrainExpanded(env: Env, ctx: ExecutionContext, tk: TileKey, base: string): Promise<Made> {
  const k = key(`${base}.x.ert`);
  return once(k, async () => {
    const r2 = await fromR2(env, k);
    if (r2 !== undefined) return { bytes: r2, how: "r2" };
    const c = await terrainCompact(env, ctx, tk, `${base}.c.ert`);
    const ert = decodeErt(c.bytes!);
    const mesh = expandTerrain(ert);
    const bytes = encodeTerrainExpanded(mesh, { skirt: ert.header.skirt, src: ert.header.src });
    await store(env, ctx, k, bytes);
    return { bytes, how: `expanded-from-${c.how}`, timing: c.timing };
  });
}

async function buildingsCompact(env: Env, ctx: ExecutionContext, tk: { z: number; x: number; y: number }, base: string): Promise<Made> {
  const k = key(`${base}.c.ert`);
  return once(k, async () => {
    const r2 = await fromR2(env, k);
    if (r2 !== undefined) return { bytes: r2, how: "r2" };
    const up = upstreamFor(env, ctx);
    const t0 = Date.now();
    const bytes = await makeBuildingsTile(up, tk, (t) => terrainCompact(env, ctx, t, `terrain/${keyOf(t)}.c.ert`).then((m) => m.bytes!));
    await store(env, ctx, k, bytes);
    return { bytes, how: "made", timing: `build;dur=${Date.now() - t0}` };
  });
}

async function buildingsExpanded(env: Env, ctx: ExecutionContext, tk: { z: number; x: number; y: number }, base: string): Promise<Made> {
  const k = key(`${base}.x.ert`);
  return once(k, async () => {
    const r2 = await fromR2(env, k);
    if (r2 !== undefined) return { bytes: r2, how: "r2" };
    const c = await buildingsCompact(env, ctx, tk, base);
    if (!c.bytes) { await store(env, ctx, k, null); return { bytes: null, how: c.how }; }
    const ert = decodeErt(c.bytes);
    const bytes = encodeBuildingsExpanded(expandBuildings(ert), ert.header.src ?? []);
    await store(env, ctx, k, bytes);
    return { bytes, how: `expanded-from-${c.how}`, timing: c.timing };
  });
}

async function topPack(env: Env, ctx: ExecutionContext): Promise<Made> {
  const k = key("terrain/top.c.erp");
  return once(k, async () => {
    const r2 = await fromR2(env, k);
    if (r2 !== undefined) return { bytes: r2, how: "r2" };
    const keys: TileKey[] = [];
    for (let z = 0; z <= TOP_MAX_Z; z++) for (let y = 0; y < 2 ** z; y++) for (let x = 0; x < 2 ** z; x++) keys.push({ z, x, y });
    keys.push({ cap: "n" }, { cap: "s" });
    const files = await Promise.all(keys.map((t) => terrainCompact(env, ctx, t, `terrain/${"cap" in t ? `cap/${t.cap}` : `${t.z}/${t.x}/${t.y}`}.c.ert`)));
    const bytes = encodeErp(files.map((f) => f.bytes!));
    await store(env, ctx, k, bytes);
    return { bytes, how: "made" };
  });
}

const TILE = /^\/tiles\/v1\/([a-z0-9]+)\/(terrain|buildings)\/(?:(\d+)\/(\d+)\/(\d+)|cap\/([ns]))\.([cx])\.ert$/;

export async function handleTiles(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const cors = { "access-control-allow-origin": "*", "access-control-expose-headers": "x-earthrt, server-timing" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "GET, HEAD", "access-control-max-age": "86400" } });
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: cors });
  const p = url.pathname;
  if (p === "/tiles/v1/meta.json") {
    return new Response(JSON.stringify(meta()), { headers: { ...cors, "content-type": "application/json", "cache-control": "public, max-age=300" } });
  }
  const t0 = Date.now();
  // the edge cache first (immutable URLs: the cache key is the URL alone)
  const cacheKey = new Request(`${url.origin}${p}`);
  const hit = await caches.default.match(cacheKey);
  if (hit) {
    const h = new Headers(hit.headers);
    h.set("x-earthrt", "edge");
    h.set("server-timing", `total;dur=${Date.now() - t0}`);
    return compressed(req, new Response(req.method === "HEAD" ? null : hit.body, { status: hit.status, headers: h }));
  }
  let made: Made;
  try {
    const top = p === `/tiles/v1/${GEN}/terrain/top.c.erp`;
    const m = top ? null : TILE.exec(p);
    if (!top && !m) return new Response("not a tile address", { status: 404, headers: cors });
    if (!top && m![1] !== GEN) return new Response(`unknown generation ${m![1]} (now ${GEN}: read /tiles/v1/meta.json)`, { status: 404, headers: cors });
    if (top) made = await topPack(env, ctx);
    else {
      const [, , layer, z, x, y, cap, enc] = m!;
      let tk: TileKey;
      try { tk = cap ? { cap: cap as "n" | "s" } : parseKey(`${z}/${x}/${y}`); }
      catch { return new Response("not a tile", { status: 404, headers: cors }); }
      const base = `${layer}/${cap ? `cap/${cap}` : `${z}/${x}/${y}`}`;
      if (layer === "terrain") {
        if (!cap && +z > MAX_Z) return new Response(`terrain stops at z${MAX_Z}`, { status: 404, headers: cors });
        made = enc === "c" ? await terrainCompact(env, ctx, tk, `${base}.c.ert`) : await terrainExpanded(env, ctx, tk, base);
      } else {
        if (cap || +z !== BUILDINGS_ZOOM) return new Response(`buildings tiles are z${BUILDINGS_ZOOM}`, { status: 404, headers: cors });
        const bk = tk as { z: number; x: number; y: number };
        made = enc === "c" ? await buildingsCompact(env, ctx, bk, base) : await buildingsExpanded(env, ctx, bk, base);
      }
    }
  } catch (e) {
    console.error(p, e);
    return new Response(`tile failed: ${(e as Error).message}`, { status: 502, headers: { ...cors, "cache-control": "no-store" } });
  }
  const headers: Record<string, string> = { ...cors, "cache-control": IMMUTABLE, "x-earthrt": made.how };
  let res: Response;
  if (!made.bytes) res = new Response(null, { status: 204, headers });
  else res = new Response(made.bytes, { headers: { ...headers, "content-type": BIN } });
  ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
  res.headers.set("server-timing", [`total;dur=${Date.now() - t0}`, made.timing].filter(Boolean).join(", "));
  return compressed(req, req.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res);
}

/** Tiles compress to about 40 % (the top pack 886 → 264 KB with br): the runtime encodes a body whose response
 *  names an encoding. The cache keeps the plain bytes. */
function compressed(req: Request, res: Response): Response {
  if (res.status !== 200) return res;
  const ae = req.headers.get("accept-encoding") ?? "";
  const enc = /\bbr\b/.test(ae) ? "br" : /\bgzip\b/.test(ae) ? "gzip" : null;
  const h = new Headers(res.headers);
  h.append("vary", "accept-encoding");
  if (!enc) return new Response(res.body, { status: res.status, headers: h });
  h.set("content-encoding", enc);
  h.delete("content-length");
  return new Response(res.body, { status: res.status, headers: h });
}
