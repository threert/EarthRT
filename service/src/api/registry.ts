// /api/v1: the places registry on D1 (SPEC § 8).
import { validatePlace, topicOf, topicBase, placeBox, score, type PlaceManifest, type PlaceRecord } from "@earthrt/core";
import type { Env } from "../env.ts";
import { bearer, getRepo, headSha, headShaGit, HttpError, rawFile, searchTopic, whoAmI, type GhRepo, type GhUser } from "./github.ts";

export const DISCOVERY_TOPIC = "earthrt-place";

interface Row {
  id: string; repo: string; path: string; sha: string; manifest: string; topic: string; topic_base: string; kind: string; title: string;
  lat: number; lon: number; west: number; south: number; east: number; north: number;
  author: string; author_id: number | null; stars: number; likes: number; source: string; created: string; updated: string;
  rank?: number;
}

export function filesHost(env: Env, req?: Request) {
  if (env.FILES_HOST) return `https://${env.FILES_HOST}`;
  return req ? new URL(req.url).origin : "";
}

export function record(r: Row, files: string): PlaceRecord & { path: string; rank?: number; score: number; source: string; created: string } {
  const dir = r.path ? `/${r.path}` : "";
  return {
    id: r.id, repo: r.repo, path: r.path, sha: r.sha, manifest: JSON.parse(r.manifest) as PlaceManifest,
    files: `${files}/p/${r.repo}/${r.sha}${dir}/`, author: r.author, likes: r.likes, stars: r.stars, topic: r.topic,
    updated: r.updated, created: r.created, source: r.source, score: score(r), ...(r.rank !== undefined ? { rank: r.rank } : {}),
  };
}

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

const now = () => new Date().toISOString();

async function auth(env: Env, req: Request): Promise<GhUser> {
  const t = bearer(req);
  if (!t) throw new HttpError(401, "Authorization: Bearer <GitHub token> required");
  return whoAmI(env, t);
}

/** Path of the manifest's directory: '' or 'a/b' (no leading or trailing slash, no '..'). */
function cleanPath(p: unknown): string {
  if (p === undefined || p === null || p === "") return "";
  if (typeof p !== "string" || p.length > 200 || p.includes("..") || p.includes("\\") || /^\//.test(p) || !/^[A-Za-z0-9._\-/]+$/.test(p)) throw new HttpError(400, "path: a directory in the repository");
  return p.replace(/\/+$/, "");
}

/**
 * Reads earthrt.json at a commit, checks it, writes the place. `who` registered it (or the owner, when discovered).
 */
export async function upsertPlace(env: Env, repo: GhRepo, sha: string, path: string, who: { login: string; id: number | null }, source: "api" | "topic"): Promise<Row> {
  const mpath = path ? `${path}/earthrt.json` : "earthrt.json";
  const r = await rawFile(env, repo.full_name, sha, mpath);
  if (r.status === 404) throw new HttpError(422, `no ${mpath} in ${repo.full_name} at ${sha.slice(0, 7)}`);
  if (!r.ok) throw new HttpError(502, `reading ${mpath}: ${r.status}`);
  const text = await r.text();
  if (text.length > 256 * 1024) throw new HttpError(422, "earthrt.json is larger than 256 KiB");
  let m: PlaceManifest;
  try { m = JSON.parse(text); } catch (e) { throw new HttpError(422, `earthrt.json is not JSON: ${(e as Error).message}`); }
  const problems = validatePlace(m);
  if (problems.length) throw new HttpError(422, "earthrt.json does not pass validatePlace", { problems });
  const id = `${repo.full_name}/${m.id}`.toLowerCase();
  const box = placeBox(m);
  const t = now();
  const topic = topicOf(m);
  const prev = await env.DB.prepare("SELECT author, author_id, source, created, path FROM places WHERE id = ?").bind(id).first<Row>();
  if (prev && prev.path !== path) throw new HttpError(409, `${id} is already registered from ${prev.path || "the root"}: ids are unique in a repository`);
  // whoever registered it first stays its author; an API registration takes over a discovered one
  const author = prev && !(prev.source === "topic" && source === "api") ? prev.author : who.login;
  const authorId = prev && !(prev.source === "topic" && source === "api") ? prev.author_id : who.id;
  const src = prev && prev.source === "api" ? "api" : source;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO places (id, repo, path, sha, manifest, topic, topic_base, kind, title, lat, lon, west, south, east, north, author, author_id, stars, likes, source, created, updated)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, 0, ?19, ?20, ?20)
       ON CONFLICT (id) DO UPDATE SET repo = ?2, sha = ?4, manifest = ?5, topic = ?6, topic_base = ?7, kind = ?8, title = ?9, lat = ?10, lon = ?11,
         west = ?12, south = ?13, east = ?14, north = ?15, author = ?16, author_id = ?17, stars = ?18, source = ?19, updated = ?20`,
    ).bind(id, repo.full_name, path, sha, JSON.stringify(m), topic, topicBase(topic), m.kind, m.title, m.anchor.lat, m.anchor.lon,
      box.west, box.south, box.east, box.north, author, authorId, repo.stargazers_count ?? 0, src, t),
    env.DB.prepare("INSERT OR IGNORE INTO versions (repo, sha, at) VALUES (?, ?, ?)").bind(repo.full_name.toLowerCase(), sha, t),
  ]);
  return (await env.DB.prepare("SELECT * FROM places WHERE id = ?").bind(id).first<Row>())!;
}

const RANKED = `SELECT *, RANK() OVER (PARTITION BY topic_base ORDER BY likes * 2 + stars DESC, created ASC) AS rank FROM places`;

async function list(env: Env, url: URL, files: string) {
  const q = url.searchParams;
  const where: string[] = [], args: unknown[] = [];
  const bbox = q.get("bbox");
  if (bbox) {
    const b = bbox.split(",").map(Number);
    if (b.length !== 4 || !b.every(Number.isFinite)) throw new HttpError(400, "bbox=west,south,east,north");
    const [w, s, e, n] = b;
    where.push("south <= ? AND north >= ?");
    args.push(n, s);
    if (w <= e) { where.push("west <= ? AND east >= ?"); args.push(e, w); }
    else { where.push("(west <= ? OR east >= ?)"); args.push(e, w); } // across the antimeridian
  }
  const kind = q.get("kind");
  if (kind) { where.push("kind = ?"); args.push(kind); }
  const topic = q.get("topic");
  if (topic) { where.push("(topic = ? OR topic_base = ?)"); args.push(topic, topic); }
  const text = q.get("q");
  if (text) { where.push("(title LIKE ? OR id LIKE ? OR topic LIKE ?)"); const like = `%${text.replace(/[%_]/g, "")}%`; args.push(like, like, like); }
  const limit = Math.max(1, Math.min(500, Number(q.get("limit")) || 100));
  const sql = `SELECT * FROM (${RANKED}) ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY rank ASC, likes * 2 + stars DESC LIMIT ${limit}`;
  const { results } = await env.DB.prepare(sql).bind(...args).all<Row>();
  return { places: results.map((r) => record(r, files)) };
}

async function one(env: Env, id: string, files: string) {
  const r = await env.DB.prepare(`SELECT * FROM (${RANKED}) WHERE id = ?`).bind(id.toLowerCase()).first<Row>();
  if (!r) throw new HttpError(404, `no place ${id}`);
  return r;
}

export async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const origin = req.headers.get("origin");
  const cors: Record<string, string> = origin ? { "access-control-allow-origin": origin, vary: "origin" } : {};
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "GET, POST, PUT, DELETE", "access-control-allow-headers": "authorization, content-type", "access-control-max-age": "86400" } });
  }
  const files = filesHost(env, req);
  const p = url.pathname.replace(/^\/api\/v1/, "");
  const m = req.method;
  try {
    let out: unknown;
    let status = 200;
    let seg: RegExpExecArray | null;
    if (m === "GET" && p === "/places") out = await list(env, url, files);
    else if (m === "POST" && p === "/places") {
      const user = await auth(env, req);
      const body = (await req.json().catch(() => null)) as { repo?: string; path?: string } | null;
      if (!body?.repo) throw new HttpError(400, `{ "repo": "owner/name", "path"?: "dir" }`);
      const token = bearer(req)!;
      const repo = await getRepo(env, body.repo, token);
      if (repo.private) throw new HttpError(422, "the repository is private: places are public repositories");
      const perm = repo.permissions ?? {};
      if (!(perm.push || perm.admin || perm.maintain)) throw new HttpError(403, `${user.login} cannot push to ${repo.full_name}`);
      const sha = await headSha(env, repo.full_name, repo.default_branch, token);
      const row = await upsertPlace(env, repo, sha, cleanPath(body.path), user, "api");
      out = record(row, files);
      status = 201;
    } else if ((seg = /^\/places\/([^/]+)\/([^/]+)\/([^/]+)(\/refresh|\/like)?$/.exec(p))) {
      const id = `${seg[1]}/${seg[2]}/${seg[3]}`.toLowerCase();
      const action = seg[4];
      if (!action && m === "GET") out = record(await one(env, id, files), files);
      else if (action === "/refresh" && m === "POST") {
        const user = await auth(env, req);
        const row = await one(env, id, files);
        const token = bearer(req)!;
        const repo = await getRepo(env, row.repo, token);
        const sha = await headSha(env, repo.full_name, repo.default_branch, token);
        const m2 = await upsertPlace(env, repo, sha, row.path, user, row.source as "api" | "topic");
        out = record(m2, files);
      } else if (action === "/like" && (m === "PUT" || m === "DELETE")) {
        const user = await auth(env, req);
        await one(env, id, files);
        if (m === "PUT") await env.DB.prepare("INSERT OR IGNORE INTO likes (place, user_id, login, at) VALUES (?, ?, ?, ?)").bind(id, user.id, user.login, now()).run();
        else await env.DB.prepare("DELETE FROM likes WHERE place = ? AND user_id = ?").bind(id, user.id).run();
        await env.DB.prepare("UPDATE places SET likes = (SELECT COUNT(*) FROM likes WHERE place = ?1) WHERE id = ?1").bind(id).run();
        const r = await one(env, id, files);
        out = { id, liked: m === "PUT", likes: r.likes, rank: r.rank };
      } else throw new HttpError(405, "method not allowed");
    } else if (m === "GET" && (seg = /^\/topics\/(.+)$/.exec(p))) {
      const topic = decodeURIComponent(seg[1]);
      const { results } = await env.DB.prepare(`SELECT * FROM (${RANKED}) WHERE topic_base = ? OR topic = ? ORDER BY rank ASC`).bind(topicBase(topic), topic).all<Row>();
      const places = results.filter((r) => r.topic === topic || r.topic_base === topic).map((r) => record(r, files));
      out = { topic, default: places.find((x) => x.topic === topic)?.id ?? places[0]?.id ?? null, places };
    } else if (m === "GET" && p === "/me") {
      const user = await auth(env, req);
      const { results } = await env.DB.prepare("SELECT place FROM likes WHERE user_id = ?").bind(user.id).all<{ place: string }>();
      out = { login: user.login, id: user.id, likes: results.map((r) => r.place) };
    } else if (m === "GET" && (p === "" || p === "/")) {
      out = { name: "EarthRT registry", v: 1, spec: "https://github.com/threert/EarthRT/blob/main/docs/SPEC.md#8-the-registry-api" };
    } else throw new HttpError(404, `no route ${m} ${url.pathname}`);
    return json(out, status, cors);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, ...(e.detail ? (e.detail as object) : {}) }, e.status, cors);
    console.error(e);
    return json({ error: (e as Error).message ?? "internal error" }, 500, cors);
  }
}

/** The hourly crawl: repositories with the topic earthrt-place, registered under their owner's name. */
export async function discover(env: Env): Promise<{ seen: number; registered: string[]; errors: Record<string, string> }> {
  const registered: string[] = [], errors: Record<string, string> = {};
  let seen = 0;
  for (let page = 1; page <= 10; page++) {
    const { items, total } = await searchTopic(env, DISCOVERY_TOPIC, page);
    for (const repo of items) {
      seen++;
      if (repo.private) continue;
      const lc = repo.full_name.toLowerCase();
      const prev = await env.DB.prepare("SELECT pushed FROM crawl WHERE repo = ?").bind(lc).first<{ pushed: string | null }>();
      const known = await env.DB.prepare("SELECT id, path FROM places WHERE lower(repo) = ?").bind(lc).all<{ id: string; path: string }>();
      // stars move without a push: keep them current
      if (known.results.length) await env.DB.prepare("UPDATE places SET stars = ? WHERE lower(repo) = ?").bind(repo.stargazers_count, lc).run();
      if (prev && prev.pushed === (repo.pushed_at ?? null)) continue;
      try {
        const sha = env.GITHUB_TOKEN ? await headSha(env, repo.full_name, repo.default_branch, env.GITHUB_TOKEN) : await headShaGit(env, repo.full_name);
        const paths = known.results.length ? [...new Set(known.results.map((r) => r.path))] : [""];
        for (const path of paths) {
          const row = await upsertPlace(env, repo, sha, path, { login: repo.owner.login, id: repo.owner.id }, "topic");
          registered.push(row.id);
        }
        await env.DB.prepare("INSERT INTO crawl (repo, checked, pushed, error) VALUES (?1, ?2, ?3, NULL) ON CONFLICT (repo) DO UPDATE SET checked = ?2, pushed = ?3, error = NULL").bind(lc, now(), repo.pushed_at ?? null).run();
      } catch (e) {
        errors[repo.full_name] = (e as Error).message;
        await env.DB.prepare("INSERT INTO crawl (repo, checked, pushed, error) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (repo) DO UPDATE SET checked = ?2, pushed = ?3, error = ?4").bind(lc, now(), repo.pushed_at ?? null, (e as Error).message).run();
      }
    }
    if (page * 100 >= total) break;
  }
  return { seen, registered, errors };
}
