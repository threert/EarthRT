// Place projects against a small stand-in for the place template (a git repository made here: an earthrt.json, a
// `place` script that writes the anchor, a `build` that bundles or fails): Create here, a build on every save,
// problems, Remix's refusal of a bad name, the server's check and Publish's dry run; GitHub's device flow on a fake
// fetch; what the agent may change in a place.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { access, makeScope } from "../src/agent/policy.ts";
import { devicePoll, deviceStart } from "../src/github.ts";
import { Places, freeFolder, parseProblems, readProject, run, slug, type PlaceBuild, type Project } from "../src/places.ts";
import { Server } from "../src/server.ts";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "earthrt-places-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const manifest = {
  format: "earthrt/place@1", id: "template", title: "A place", summary: "x", kind: "site",
  anchor: { lat: 0, lon: 0, height: 0, heightRef: "terrain", heading: 0 }, bounds: { radius: 30 },
  content: [{ type: "scene", entry: "dist/scene.js", source: "scene/main.ts", fallback: "assets/models/scene.glb" }],
  license: "CC0-1.0", credits: [],
};

async function makeTemplate(): Promise<string> {
  const t = join(tmp, "template");
  mkdirSync(join(t, "tools"), { recursive: true });
  mkdirSync(join(t, "scene"), { recursive: true });
  writeFileSync(join(t, "earthrt.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(t, "scene/main.ts"), "export default function build() { return null; }\n");
  writeFileSync(join(t, "package.json"), JSON.stringify({ scripts: { place: "bun tools/place.ts", build: "bun tools/build.ts", register: "bun tools/register.ts" } }));
  writeFileSync(join(t, "tools/place.ts"), `
    const a = process.argv.slice(2), f = (k: string) => a[a.indexOf(k) + 1];
    const m = JSON.parse(await Bun.file("earthrt.json").text());
    const [lat, lon] = f("--at").split(",").map(Number);
    Object.assign(m, { id: f("--id"), title: f("--title") }); m.anchor.lat = lat; m.anchor.lon = lon;
    await Bun.write("earthrt.json", JSON.stringify(m, null, 2));`);
  writeFileSync(join(t, "tools/build.ts"), `
    const src = await Bun.file("scene/main.ts").text();
    if (src.includes("BROKEN")) { console.error("scene/main.ts:2:5: error: Unexpected BROKEN"); process.exit(1); }
    await Bun.write("dist/scene.js", "// built\\n" + src);`);
  writeFileSync(join(t, "tools/register.ts"), `console.log("args " + process.argv.slice(2).join(" ")); console.log("token " + (process.env.GITHUB_TOKEN ? "yes" : "no"));`);
  for (const cmd of [["git", "init", "-q", "-b", "main"], ["git", "add", "-A"], ["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "t"]]) await run(cmd, t);
  return t;
}

function recorder() {
  const events: { opened: Project[]; built: PlaceBuild[]; files: string[][] } = { opened: [], built: [], files: [] };
  return { events, sink: { opened: (p: Project) => events.opened.push(p), built: (b: PlaceBuild) => events.built.push(b), files: (f: string[]) => events.files.push(f) } };
}

async function until(what: string, test: () => boolean, ms = 8000) {
  for (let t = 0; t < ms; t += 20) { if (test()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error(`timed out waiting for ${what}`);
}

describe("names", () => {
  test("slugs and free folders", () => {
    expect(slug("Kyoto Tea House")).toBe("kyoto-tea-house");
    expect(slug("Café  Élysée!")).toBe("cafe-elysee");
    expect(slug("京都").startsWith("place-")).toBe(true);
    mkdirSync(join(tmp, "taken"), { recursive: true });
    expect(freeFolder(tmp, "taken")).toBe(join(tmp, "taken-2"));
    expect(freeFolder(tmp, "free")).toBe(join(tmp, "free"));
  });
  test("build errors become problems", () => {
    expect(parseProblems("scene/main.ts:2:5: error: Unexpected x\n", "/p")).toEqual([{ file: "scene/main.ts", line: 2, message: "error: Unexpected x" }]);
    expect(parseProblems("something broke", "/p")).toEqual([{ message: "something broke" }]);
  });
});

describe("a place project", () => {
  test("Create here copies the template, writes the anchor, opens and builds it; saves build again", async () => {
    const template = await makeTemplate();
    const { events, sink } = recorder();
    const places = new Places(sink, join(tmp, "places"), template);
    const lines: string[] = [];
    const p = await places.create({ lat: 35.0037, lon: 135.7751, title: "Tea House" }, l => lines.push(l));
    expect(p.folder).toBe(join(tmp, "places", "tea-house"));
    expect(p.name).toBe("tea-house");
    expect(p.problems).toEqual([]);
    const m = JSON.parse(readFileSync(join(p.folder, "earthrt.json"), "utf8"));
    expect([m.id, m.title, m.anchor.lat, m.anchor.lon]).toEqual(["tea-house", "Tea House", 35.0037, 135.7751]);
    // its own repository, one commit, no history of the template's
    expect((await run(["git", "log", "--oneline"], p.folder)).out.trim().split("\n").length).toBe(1);
    expect(events.opened.length).toBe(1);
    expect(events.built.at(-1)).toMatchObject({ ok: true, problems: [] });
    expect(readFileSync(join(p.folder, "dist/scene.js"), "utf8")).toStartWith("// built");
    expect(places.list().map(x => x.name)).toEqual(["tea-house"]);
    // a save: built again; a broken one: its problem
    const before = events.built.length;
    await Bun.sleep(150);
    writeFileSync(join(p.folder, "scene/main.ts"), "export default function build() {\n  BROKEN\n}\n");
    await until("a build after the save", () => events.built.length > before && !events.built.at(-1)!.ok);
    expect(events.built.at(-1)!.problems[0]).toMatchObject({ file: "scene/main.ts", line: 2 });
    // writes of builds and bakes are not saves
    const n = events.built.length;
    writeFileSync(join(p.folder, "dist/other.js"), "x");
    await Bun.sleep(400);
    expect(events.built.length).toBe(n);
    // a second Create of the same name gets a folder of its own
    const q = await places.create({ lat: 1, lon: 2, title: "Tea House" });
    expect(q.folder).toBe(join(tmp, "places", "tea-house-2"));
    places.close();
  }, 30_000);

  test("a manifest that does not validate is a problem of the build", async () => {
    const folder = join(tmp, "bad");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "earthrt.json"), JSON.stringify({ ...manifest, content: [], anchor: { lat: 200, lon: 0 } }));
    const { events, sink } = recorder();
    const places = new Places(sink, tmp);
    await places.open(folder);
    expect(events.built.at(-1)!.ok).toBe(false);
    expect(events.built.at(-1)!.problems.every(p => p.file === "earthrt.json")).toBe(true);
    expect(readProject(folder).problems.length).toBeGreaterThan(0);
    places.close();
    await expect(places.open(tmp + "/nothing")).rejects.toThrow("no earthrt.json");
    await expect(places.remix("not a repo")).rejects.toThrow("owner/name");
    await expect(places.create({ lat: NaN, lon: 0 })).rejects.toThrow("latitude");
  });
});

describe("the server's place jobs", () => {
  test("check without the app: built and validated; Publish's dry run passes the token and --dry-run", async () => {
    const template = await makeTemplate();
    const server = new Server(join(tmp, "places-server"), template);
    const report0 = await server.check();
    expect(report0.ok).toBe(false);
    expect(report0.errors[0]).toContain("no place is open");
    await server.places.create({ lat: 35, lon: 135.7, title: "Check me" });
    const report = await server.check();
    expect(report).toMatchObject({ ok: true, app: "not connected", place: { id: "check-me" } });
    server.settings.githubToken = "tok";
    const lines: string[] = [];
    await expect(server.publish({ dryRun: true }, l => lines.push(l))).rejects.toThrow("owner/name");
    const r = await server.publish({ repo: "someone/earth-check-me", dryRun: true }, l => lines.push(l));
    expect(r.dryRun).toBe(true);
    expect(lines.some(l => l.includes("--create someone/earth-check-me") && l.includes("--dry-run"))).toBe(true);
    expect(lines).toContain("token yes");
    // the agent's preamble says where the place is and that there is no Meshy key
    expect(server.context()).toContain("\"Check me\" (site) at 35.00000, 135.70000");
    expect(server.context()).toContain("--mock");
    server.stop();
  }, 30_000);
});

describe("GitHub's device flow", () => {
  test("a code, then the token after a pending answer and a slow-down", async () => {
    const asked: string[] = [];
    const answers = [{ error: "authorization_pending" }, { error: "slow_down", interval: 1 }, { access_token: "gho_x" }];
    const f = (async (url: string, init: RequestInit) => {
      asked.push(`${url} ${init.body}`);
      if (url.endsWith("/device/code")) return Response.json({ device_code: "D", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
      return Response.json(answers.shift());
    }) as unknown as typeof fetch;
    const code = await deviceStart("Iv1.abc", f);
    expect(code.user_code).toBe("ABCD-1234");
    const slept: number[] = [];
    const token = await devicePoll("Iv1.abc", code, { f, sleep: async ms => { slept.push(ms); } });
    expect(token).toBe("gho_x");
    expect(slept).toEqual([5000, 5000, 1000]);
    expect(asked[0]).toContain('"scope":"public_repo"');
    await expect(deviceStart("", f)).rejects.toThrow("client id");
    const denied = (async () => Response.json({ error: "access_denied", error_description: "The user said no" })) as unknown as typeof fetch;
    await expect(devicePoll("x", code, { f: denied, sleep: async () => {} })).rejects.toThrow("The user said no");
  });
});

describe("what the agent may change in a place", () => {
  test("the scene and models, not the place's own tools", () => {
    const project = join(tmp, "scope");
    mkdirSync(project, { recursive: true });
    const scope = makeScope(project, project, []);
    expect(access(scope, join(project, "scene/main.ts"))).toBe("write");
    expect(access(scope, join(project, "earthrt.json"))).toBe("write");
    expect(access(scope, join(project, "assets/models/a.glb"))).toBe("write");
    for (const guarded of ["tools/build.ts", "earthrt/core/places.ts", "package.json", ".github/workflows/x.yml", ".git/config"]) expect(access(scope, join(project, guarded))).toBe("read");
    expect(access(scope, "/etc/hosts")).toBe("none");
  });
});
