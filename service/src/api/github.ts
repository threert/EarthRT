// What the registry asks GitHub. A caller's token is used for that request only and kept nowhere.
import type { Env } from "../env.ts";

export const UA = "EarthRT-registry (+https://earth.threert.dev)";

export class HttpError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) { super(message); }
}

const api = (env: Env) => env.GITHUB_API ?? "https://api.github.com";
const raw = (env: Env) => env.GITHUB_RAW ?? "https://raw.githubusercontent.com";
const media = (env: Env) => env.GITHUB_MEDIA ?? "https://media.githubusercontent.com/media";

export async function gh(env: Env, path: string, token?: string, accept = "application/vnd.github+json"): Promise<Response> {
  const headers: Record<string, string> = { "user-agent": UA, accept, "x-github-api-version": "2022-11-28" };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${api(env)}${path}`, { headers });
}

export interface GhUser { login: string; id: number }

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^(?:Bearer|token)\s+([A-Za-z0-9_\-.]{20,255})$/i.exec(h.trim());
  return m ? m[1] : null;
}

/** Who a token is; 401 when GitHub does not know it. */
export async function whoAmI(env: Env, token: string): Promise<GhUser> {
  const r = await gh(env, "/user", token);
  if (r.status === 401 || r.status === 403) throw new HttpError(401, "GitHub did not accept the token");
  if (!r.ok) throw new HttpError(502, `GitHub /user: ${r.status}`);
  const u = (await r.json()) as GhUser;
  return { login: u.login, id: u.id };
}

export interface GhRepo {
  full_name: string;
  private: boolean;
  default_branch: string;
  stargazers_count: number;
  owner: { login: string; id: number };
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean };
  topics?: string[];
  pushed_at?: string;
}

export const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export async function getRepo(env: Env, repo: string, token?: string): Promise<GhRepo> {
  if (!REPO.test(repo)) throw new HttpError(400, `not a repository: ${repo}`);
  const r = await gh(env, `/repos/${repo}`, token);
  if (r.status === 404) throw new HttpError(404, `no public repository ${repo}`);
  if (!r.ok) throw new HttpError(502, `GitHub /repos/${repo}: ${r.status}`);
  return (await r.json()) as GhRepo;
}

/** The commit at the head of a branch. */
export async function headSha(env: Env, repo: string, branch: string, token?: string): Promise<string> {
  const r = await gh(env, `/repos/${repo}/commits/${encodeURIComponent(branch)}`, token, "application/vnd.github.sha");
  if (!r.ok) throw new HttpError(502, `GitHub head of ${repo}@${branch}: ${r.status}`);
  const sha = (await r.text()).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new HttpError(502, `GitHub head of ${repo}: not a sha`);
  return sha;
}

/** The commit at a repository's HEAD from git's smart-HTTP ref list (no API quota: discovery runs unauthenticated). */
export async function headShaGit(env: Env, repo: string): Promise<string> {
  const r = await fetch(`${env.GITHUB_WEB ?? "https://github.com"}/${repo}.git/info/refs?service=git-upload-pack`, { headers: { "user-agent": `git/2.45 ${UA}` } });
  if (!r.ok) throw new HttpError(502, `git refs of ${repo}: ${r.status}`);
  const text = await r.text();
  // pkt-lines: "# service=…", a flush, then "<sha> HEAD\0<capabilities>" first when the repository has a HEAD
  const m = /([0-9a-f]{40}) HEAD\0/.exec(text);
  if (!m) throw new HttpError(502, `git refs of ${repo}: no HEAD`);
  return m[1];
}

export const rawUrl = (env: Env, repo: string, sha: string, path: string) => `${raw(env)}/${repo}/${sha}/${path.split("/").map(encodeURIComponent).join("/")}`;
export const mediaUrl = (env: Env, repo: string, sha: string, path: string) => `${media(env)}/${repo}/${sha}/${path.split("/").map(encodeURIComponent).join("/")}`;

/** A file at a commit, read from raw.githubusercontent.com (no API quota). */
export async function rawFile(env: Env, repo: string, sha: string, path: string): Promise<Response> {
  return fetch(rawUrl(env, repo, sha, path), { headers: { "user-agent": UA } });
}

/** Repositories with a topic (the hourly discovery). */
export async function searchTopic(env: Env, topic: string, page = 1): Promise<{ items: GhRepo[]; total: number }> {
  const r = await gh(env, `/search/repositories?q=${encodeURIComponent(`topic:${topic}`)}&sort=updated&per_page=100&page=${page}`, env.GITHUB_TOKEN);
  if (!r.ok) throw new HttpError(502, `GitHub search: ${r.status} ${await r.text()}`);
  const j = (await r.json()) as { items: GhRepo[]; total_count: number };
  return { items: j.items, total: j.total_count };
}
