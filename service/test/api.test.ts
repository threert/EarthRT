// The Worker in workerd (wrangler's unstable_dev, local D1 / R2) against a fake GitHub.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = join(import.meta.dir, "..");
const SHA = "a".repeat(40), SHA2 = "b".repeat(40);
const GLB = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 20, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
const BIG = new Uint8Array(4096).map((_, i) => i & 255);

const manifest = (title = "A sample cube") => ({
  format: "earthrt/place@1", id: "sample-cube", title, kind: "site", topic: "site:sample-cube",
  anchor: { lat: 35.0116, lon: 135.7681, height: 0, heightRef: "terrain", heading: 0 },
  bounds: { radius: 20 }, content: [{ type: "glb", uri: "models/cube.glb" }], license: "CC0-1.0",
});
let head = SHA;
let title = "A sample cube";

const users: Record<string, { login: string; id: number }> = { "tok_alice_0123456789abcdef": { login: "alice", id: 1 }, "tok_bob_0123456789abcdefgh": { login: "bob", id: 2 } };
let gh: ReturnType<typeof Bun.serve>;
let worker: { proc: ReturnType<typeof Bun.spawn>; base: string; fetch: (path: string, init?: RequestInit) => Promise<Response>; stop: () => Promise<void> };
let persist: string;

beforeAll(async () => {
  gh = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url), tok = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const p = u.pathname;
      if (p === "/user") return users[tok] ? Response.json(users[tok]) : new Response("{}", { status: 401 });
      if (p === "/repos/alice/sample-cube") return Response.json({ full_name: "alice/sample-cube", private: false, default_branch: "main", stargazers_count: 3, owner: { login: "alice", id: 1 }, permissions: { push: users[tok]?.login === "alice" }, pushed_at: "2026-11-26T00:00:00Z" });
      if (p === "/repos/alice/sample-cube/commits/main") return new Response(head);
      if (p === "/web/alice/sample-cube/releases/download/v0.1.0/15-1-2.ert") return Response.redirect(`${u.origin}/objects/15-1-2.ert`, 302);
      if (p === "/objects/15-1-2.ert") return new Response(BIG);
      if (p === "/web/alice/sample-cube.git/info/refs") return new Response(`001e# service=git-upload-pack\n0000015b${head} HEAD\0multi_ack symref=HEAD:refs/heads/main\n003f${head} refs/heads/main\n0000`);
      if (p === "/search/repositories") return Response.json({ total_count: 1, items: [{ full_name: "alice/sample-cube", private: false, default_branch: "main", stargazers_count: 5, owner: { login: "alice", id: 1 }, pushed_at: "2026-11-26T01:00:00Z" }] });
      for (const sha of [SHA, SHA2]) {
        if (p === `/raw/alice/sample-cube/${sha}/earthrt.json`) return Response.json(manifest(title));
        if (p === `/raw/alice/sample-cube/${sha}/models/cube.glb`) return new Response(GLB);
        if (p === `/raw/alice/sample-cube/${sha}/models/big.glb`) return new Response(`version https://git-lfs.github.com/spec/v1\noid sha256:${"c".repeat(64)}\nsize 4096\n`);
        if (p === `/media/alice/sample-cube/${sha}/models/big.glb`) return new Response(BIG);
        if (p === `/raw/alice/sample-cube/${sha}/page.html`) return new Response("<script>alert(1)</script>");
      }
      return new Response("not found", { status: 404 });
    },
  });
  persist = mkdtempSync(join(tmpdir(), "earthrt-api-"));
  // local only: wrangler must not reach for a proxy
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "all_proxy", "ALL_PROXY"]) delete process.env[k];
  process.env.WRANGLER_SEND_METRICS = "false";
  const env = { ...process.env, CI: "1" };
  for (const cmd of [["bun", "scripts/assets.ts"], ["node_modules/.bin/wrangler", "d1", "migrations", "apply", "earthrt", "--local", "--env", "local", "--persist-to", persist]]) {
    const r = Bun.spawnSync(cmd, { cwd: here, env, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}${r.stdout.toString()}`);
  }
  const base = `http://127.0.0.1:${gh.port}`;
  const port = 18790 + Math.floor(Math.random() * 1000);
  const vars = { GITHUB_API: base, GITHUB_RAW: `${base}/raw`, GITHUB_MEDIA: `${base}/media`, GITHUB_WEB: `${base}/web` };
  const proc = Bun.spawn(
    ["node_modules/.bin/wrangler", "dev", "--env", "local", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", persist, "--log-level", "warn", "--show-interactive-dev-session=false",
      ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])],
    { cwd: here, env, stdout: "pipe", stderr: "pipe" },
  );
  const url = `http://127.0.0.1:${port}`;
  worker = {
    proc, base: url,
    fetch: (path, init) => fetch(`${url}${path}`, init),
    stop: async () => { proc.kill(); await proc.exited; },
  };
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${url}/tiles/v1/meta.json`)).ok) break; } catch {}
    if (i > 200) throw new Error(`wrangler dev did not start: ${await new Response(proc.stderr as ReadableStream).text()}`);
    await Bun.sleep(150);
  }
}, 60_000);

afterAll(async () => {
  await worker?.stop();
  gh?.stop(true);
  if (persist) rmSync(persist, { recursive: true, force: true });
});

const call = (path: string, init: RequestInit & { token?: string } = {}) =>
  worker.fetch(path, { ...init, headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers as Record<string, string>) } } as never);
const ALICE = "tok_alice_0123456789abcdef", BOB = "tok_bob_0123456789abcdefgh";

describe("registry", () => {
  test("registering needs a token GitHub knows, and push access", async () => {
    expect((await call("/api/v1/places", { method: "POST", body: JSON.stringify({ repo: "alice/sample-cube" }) })).status).toBe(401);
    expect((await call("/api/v1/places", { method: "POST", token: "tok_nobody_0123456789abcdef", body: JSON.stringify({ repo: "alice/sample-cube" }) })).status).toBe(401);
    expect((await call("/api/v1/places", { method: "POST", token: BOB, body: JSON.stringify({ repo: "alice/sample-cube" }) })).status).toBe(403);
  });

  test("register, read, list by bbox and topic", async () => {
    const r = await call("/api/v1/places", { method: "POST", token: ALICE, body: JSON.stringify({ repo: "alice/sample-cube" }) });
    expect(r.status).toBe(201);
    const p = (await r.json()) as { id: string; sha: string; files: string; author: string; stars: number };
    expect(p.id).toBe("alice/sample-cube/sample-cube");
    expect(p.sha).toBe(SHA);
    expect(p.author).toBe("alice");
    expect(p.stars).toBe(3);
    expect(p.files).toMatch(new RegExp(`/p/alice/sample-cube/${SHA}/$`));
    const one = (await (await call("/api/v1/places/alice/sample-cube/sample-cube")).json()) as { manifest: { title: string } };
    expect(one.manifest.title).toBe("A sample cube");
    const inBox = (await (await call("/api/v1/places?bbox=135.7,34.9,135.8,35.1")).json()) as { places: { id: string; rank: number }[] };
    expect(inBox.places.map((x) => x.id)).toEqual(["alice/sample-cube/sample-cube"]);
    expect(inBox.places[0].rank).toBe(1);
    const outBox = (await (await call("/api/v1/places?bbox=-10,40,10,50")).json()) as { places: unknown[] };
    expect(outBox.places.length).toBe(0);
    const across = (await (await call("/api/v1/places?bbox=170,30,140,40")).json()) as { places: unknown[] };
    expect(across.places.length).toBe(1);
    const t = (await (await call("/api/v1/topics/site:sample-cube")).json()) as { default: string; places: unknown[] };
    expect(t.default).toBe("alice/sample-cube/sample-cube");
    const q = (await (await call("/api/v1/places?q=cube&kind=site")).json()) as { places: unknown[] };
    expect(q.places.length).toBe(1);
  });

  test("an invalid manifest is refused with its problems", async () => {
    title = "";
    head = SHA2;
    const r = await call("/api/v1/places/alice/sample-cube/sample-cube/refresh", { method: "POST", token: ALICE });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { problems: string[] }).problems.join()).toContain("title");
    title = "A sample cube, again";
  });

  test("refresh moves to the new head", async () => {
    const r = await call("/api/v1/places/alice/sample-cube/sample-cube/refresh", { method: "POST", token: BOB });
    expect(r.status).toBe(200);
    const p = (await r.json()) as { sha: string; author: string; manifest: { title: string } };
    expect(p.sha).toBe(SHA2);
    expect(p.author).toBe("alice");
    expect(p.manifest.title).toBe("A sample cube, again");
  });

  test("like, unlike, /me", async () => {
    let r = await call("/api/v1/places/alice/sample-cube/sample-cube/like", { method: "PUT", token: BOB });
    expect(((await r.json()) as { likes: number }).likes).toBe(1);
    r = await call("/api/v1/places/alice/sample-cube/sample-cube/like", { method: "PUT", token: BOB });
    expect(((await r.json()) as { likes: number }).likes).toBe(1);
    r = await call("/api/v1/places/alice/sample-cube/sample-cube/like", { method: "PUT", token: ALICE });
    expect(((await r.json()) as { likes: number }).likes).toBe(2);
    const me = (await (await call("/api/v1/me", { token: BOB })).json()) as { login: string; likes: string[] };
    expect(me.login).toBe("bob");
    expect(me.likes).toEqual(["alice/sample-cube/sample-cube"]);
    r = await call("/api/v1/places/alice/sample-cube/sample-cube/like", { method: "DELETE", token: BOB });
    expect(((await r.json()) as { likes: number }).likes).toBe(1);
    const one = (await (await call("/api/v1/places/alice/sample-cube/sample-cube")).json()) as { likes: number; score: number };
    expect(one.likes).toBe(1);
    expect(one.score).toBe(1 * 2 + 3);
    expect((await call("/api/v1/places/alice/sample-cube/nope/like", { method: "PUT", token: BOB })).status).toBe(404);
  });

  test("hourly discovery via the scheduled handler", async () => {
    const r = await worker.fetch("/cdn-cgi/local/scheduled?cron=17+*+*+*+*");
    expect(r.status).toBe(200);
    await Bun.sleep(500);
    const one = (await (await call("/api/v1/places/alice/sample-cube/sample-cube")).json()) as { stars: number; author: string; source: string };
    expect(one.stars).toBe(5);
    expect(one.author).toBe("alice");
    expect(one.source).toBe("api");
  });
});

describe("mirror", () => {
  test("serves a registered commit's files with safe types", async () => {
    const r = await call(`/p/alice/sample-cube/${SHA}/models/cube.glb`, { headers: { origin: "http://localhost:5173" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("model/gltf-binary");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(r.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(GLB);
    const again = await call(`/p/alice/sample-cube/${SHA}/models/cube.glb`, { headers: { origin: "https://evil.example" } });
    expect(again.headers.get("access-control-allow-origin")).toBeNull();
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(GLB);
  });
  test("follows Git LFS pointers", async () => {
    const r = await call(`/p/alice/sample-cube/${SHA2}/models/big.glb`);
    expect(r.status).toBe(200);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(BIG);
  });
  test("compressible files go out gzipped when asked", async () => {
    for (const how of ["gzip", "r2+gzip"]) {
      const r = await call(`/p/alice/sample-cube/${SHA2}/models/big.glb`, { headers: { "accept-encoding": "gzip" } });
      expect(r.status).toBe(200);
      expect(r.headers.get("x-earthrt")).toContain(how);
      expect(new Uint8Array(await r.arrayBuffer())).toEqual(BIG); // fetch decodes it
      await Bun.sleep(200);
    }
    const plain = await call(`/p/alice/sample-cube/${SHA2}/models/big.glb`, { headers: { "accept-encoding": "identity" } });
    expect(new Uint8Array(await plain.arrayBuffer())).toEqual(BIG);
  });
  test("release assets by @release/<tag>/<asset>", async () => {
    const r = await call(`/p/alice/sample-cube/${SHA}/@release/v0.1.0/15-1-2.ert`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(BIG);
    expect((await call(`/p/alice/sample-cube/${SHA}/@release/v0.1.0/nope.ert`)).status).toBe(404);
    expect((await call(`/p/alice/sample-cube/${SHA}/@release/v0.1.0/a/b.ert`)).status).toBe(400);
  });
  test("never a page; only registered commits; no escapes", async () => {
    const r = await call(`/p/alice/sample-cube/${SHA}/page.html`);
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.headers.get("content-security-policy")).toContain("sandbox");
    await r.arrayBuffer();
    expect((await call(`/p/alice/sample-cube/${"c".repeat(40)}/models/cube.glb`)).status).toBe(404);
    expect((await call(`/p/alice/sample-cube/${SHA}/models/..%2fearthrt.json`)).status).toBeGreaterThanOrEqual(400);
    expect((await call(`/p/alice/sample-cube/${SHA}/models/nope.glb`)).status).toBe(404);
  });
});

describe("routing", () => {
  test("meta, tile address errors, and the page", async () => {
    const meta = (await (await call("/tiles/v1/meta.json")).json()) as { gen: string; terrain: { maxZoom: number; n: number }; buildings: { regions: unknown[] }; attribution: string[] };
    expect(meta.gen).toMatch(/^g\d+$/);
    const g = meta.gen;
    expect(meta.terrain).toMatchObject({ maxZoom: 14, n: 65 });
    expect(meta.buildings.regions.length).toBeGreaterThanOrEqual(7);
    expect(meta.attribution.join()).toContain("OpenStreetMap");
    expect((await call("/tiles/v1/x1/terrain/0/0/0.c.ert")).status).toBe(404);
    expect((await call(`/tiles/v1/${g}/terrain/15/0/0.c.ert`)).status).toBe(404);
    expect((await call(`/tiles/v1/${g}/buildings/13/0/0.c.ert`)).status).toBe(404);
    expect((await call(`/tiles/v1/${g}/terrain/3/9/0.c.ert`)).status).toBe(404);
    // an older generation: its own tile if made then, else a redirect to the current one
    const old = await call(`/tiles/v1/g1/terrain/3/1/2.c.ert`, { redirect: "manual" });
    expect(old.status).toBe(302);
    expect(old.headers.get("location")).toBe(`/tiles/v1/${g}/terrain/3/1/2.c.ert`);
    expect((await call(`/tiles/v1/g999/terrain/3/1/2.c.ert`)).status).toBe(404);
    const page = await call("/");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("EarthRT");
  });
});
