// Place projects (ARCHITECTURE § 5, SPEC § 7 "Dev mode"): a folder with an earthrt.json, made from the place template
// (Create here) or cloned from a place's repository (Remix), or any folder the user opens. One is open at a time: the
// sidecar watches it, builds its scene module on every save with the project's own `bun tools/build.ts`, and tells
// the app, which maps the folder into the globe's asset root as `dev/<name>/` and sends the globe `earth.dev`.
//
// The template's tools do the rest and are run as they are: `bun run place` (the anchor), `bun run check`,
// `bun run meshy`, `bun run register` (Publish).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { validatePlace } from "../../../packages/core/src/places.ts";
import { BUN, PLACES, TEMPLATE } from "./paths.ts";

type Json = Record<string, unknown>;

export interface Problem { file?: string; line?: number; message: string }

export interface PlaceBuild {
  seq: number;
  ok: boolean;
  problems: Problem[];
  ms: number;
  at: number;
  /** The manifest as it was at this build. */
  manifest?: Json;
}

export interface Project {
  folder: string;
  /** The folder's name under the asset root: `dev/<name>/`. */
  name: string;
  manifest: Json | null;
  /** `validatePlace`'s problems with the manifest. */
  problems: string[];
  /** owner/name of its GitHub remote, when it has one. */
  repo: string | null;
}

export interface PlaceEvents {
  opened(project: Project): void;
  built(build: PlaceBuild, project: Project): void;
  files(paths: string[]): void;
}

/** What a save that is not the scene's source looks like: written by builds and bakes, or not the place's. */
const IGNORED = /(^|\/)(node_modules|\.git|\.threert|dist|\.DS_Store)(\/|$)|\.part$/;

/** A slug for a folder and an id: lower-case letters, digits and dashes, 3–64 long (SPEC § 5's id). */
export function slug(text: string): string {
  const s = text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return s.length >= 3 ? s : `place-${s || Date.now().toString(36)}`.slice(0, 64);
}

/** A folder under `parent` named `base`, or `base-2`, `base-3`, … if it is taken. */
export function freeFolder(parent: string, base: string): string {
  let path = join(parent, base);
  for (let n = 2; existsSync(path); n++) path = join(parent, `${base}-${n}`);
  return path;
}

export interface Ran { code: number; out: string; err: string }

/** Runs a command in `cwd` and collects what it prints; `line` gets each line as it comes. */
export async function run(cmd: string[], cwd: string, env: Record<string, string> = {}, line?: (text: string, stream: "out" | "err") => void): Promise<Ran> {
  const child = Bun.spawn(cmd, { cwd, env: { ...process.env, NO_COLOR: "1", ...env } as Record<string, string>, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const read = async (stream: ReadableStream<Uint8Array>, which: "out" | "err") => {
    let all = "", rest = "";
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      all += text;
      if (line) {
        const parts = (rest + text).split("\n");
        rest = parts.pop() ?? "";
        for (const p of parts) line(p, which);
      }
    }
    if (line && rest) line(rest, which);
    return all;
  };
  const [out, err, code] = await Promise.all([read(child.stdout, "out"), read(child.stderr, "err"), child.exited]);
  return { code, out, err };
}

export function readProject(folder: string): Project {
  const file = join(folder, "earthrt.json");
  let manifest: Json | null = null, problems: string[] = [];
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
    problems = validatePlace(manifest);
  } catch (error) {
    problems = [existsSync(file) ? `earthrt.json: ${(error as Error).message}` : "no earthrt.json in the folder"];
  }
  let repo: string | null = null;
  try {
    const config = readFileSync(join(folder, ".git/config"), "utf8");
    const m = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(config)?.[1]?.match(/github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/);
    if (m) repo = `${m[1]}/${m[2]}`;
  } catch { /* not a repository */ }
  return { folder, name: slug(basename(folder)), manifest, problems, repo };
}

export class Places {
  project: Project | null = null;
  last: PlaceBuild | undefined;
  private seq = 0;
  private watcher: FSWatcher | undefined;
  private running: Promise<PlaceBuild> | undefined;
  private again = false;

  constructor(private readonly events: PlaceEvents, readonly placesDir = PLACES, readonly template = TEMPLATE) {}

  /** The place projects in ~/EarthRT/places (for the app's Places list). */
  list(): Project[] {
    if (!existsSync(this.placesDir)) return [];
    return readdirSync(this.placesDir)
      .map(name => join(this.placesDir, name))
      .filter(path => { try { return statSync(path).isDirectory() && existsSync(join(path, "earthrt.json")); } catch { return false; } })
      .map(readProject);
  }

  /** Opens a folder in dev mode: watched, built now and on every save. */
  async open(folder: string): Promise<Project> {
    const path = resolve(folder);
    if (!existsSync(join(path, "earthrt.json"))) throw new Error(`${path} is not a place: it has no earthrt.json`);
    this.close();
    this.project = readProject(path);
    this.last = undefined;
    this.events.opened(this.project);
    this.watch();
    await this.build();
    return this.project;
  }

  close(): void {
    this.watcher?.close();
    this.watcher = undefined;
    this.project = null;
  }

  /** Create here: the template copied into ~/EarthRT/places/<id>, a repository of its own, the anchor written. */
  async create(o: { lat: number; lon: number; title?: string; id?: string; kind?: string; radius?: number; heading?: number }, log?: (line: string) => void): Promise<Project> {
    if (!isFinite(o.lat) || !isFinite(o.lon) || Math.abs(o.lat) > 90 || Math.abs(o.lon) > 180) throw new Error("Create here needs a latitude and a longitude");
    const title = (o.title ?? "").trim() || "A new place";
    const id = slug(o.id ?? title);
    mkdirSync(this.placesDir, { recursive: true });
    const folder = freeFolder(this.placesDir, id);
    log?.(`Copying the place template into ${folder}`);
    const local = existsSync(this.template);
    const clone = await run(["git", "clone", "--depth", "1", "--quiet", ...(local ? [`file://${resolve(this.template)}`] : [this.template]), folder], this.placesDir);
    if (clone.code !== 0) throw new Error(`git clone ${this.template}: ${clone.err.trim() || clone.out.trim()}`);
    // A project of its own: the template's history is not the place's.
    rmSync(join(folder, ".git"), { recursive: true, force: true });
    await run(["git", "init", "--quiet", "-b", "main"], folder);
    const args = ["run", "place", "--at", `${o.lat.toFixed(6)},${o.lon.toFixed(6)}`, "--id", id, "--title", title];
    if (o.kind) args.push("--kind", o.kind);
    if (o.radius) args.push("--radius", String(Math.round(o.radius)));
    if (o.heading !== undefined) args.push("--heading", String(o.heading));
    log?.(`bun ${args.join(" ")}`);
    const placed = await run([BUN, ...args], folder);
    if (placed.code !== 0) throw new Error(`bun run place: ${placed.err.trim() || placed.out.trim()}`);
    await run(["git", "add", "-A"], folder);
    await run(["git", "-c", "user.name=EarthRT", "-c", "user.email=earthrt@users.noreply.github.com", "commit", "--quiet", "-m", `${title}: made from the EarthRT place template`], folder);
    return this.open(folder);
  }

  /** Remix: a place's repository cloned into ~/EarthRT/places/<name> (or opened, if it is there already). */
  async remix(repo: string, log?: (line: string) => void): Promise<Project> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`${repo} is not owner/name`);
    const name = repo.split("/")[1]!;
    const existing = join(this.placesDir, name);
    if (existsSync(join(existing, "earthrt.json")) && readProject(existing).repo === repo) return this.open(existing);
    mkdirSync(this.placesDir, { recursive: true });
    const folder = freeFolder(this.placesDir, name);
    log?.(`git clone https://github.com/${repo} ${folder}`);
    const clone = await run(["git", "clone", "--quiet", `https://github.com/${repo}.git`, folder], this.placesDir);
    if (clone.code !== 0) throw new Error(`git clone ${repo}: ${clone.err.trim()}`);
    return this.open(folder);
  }

  private watch(): void {
    const project = this.project;
    if (!project) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = new Set<string>();
    const fallback = this.fallbackPath();
    this.watcher = watch(project.folder, { recursive: true }, (_event, name) => {
      if (!name || IGNORED.test(String(name)) || String(name) === fallback) return;
      changed.add(String(name));
      clearTimeout(timer);
      timer = setTimeout(() => {
        const paths = [...changed];
        changed.clear();
        this.events.files(paths);
        if (paths.some(path => !/\.(md|txt)$/i.test(path))) void this.build();
      }, 150);
    });
  }

  /** The scene content's fallback GLB (bake writes it: not a change of the scene). */
  private fallbackPath(): string | undefined {
    const content = (this.project?.manifest?.content as Json[] | undefined) ?? [];
    const scene = content.find(c => c.type === "scene");
    return typeof scene?.fallback === "string" ? scene.fallback : undefined;
  }

  /** Builds the open project now (`bun tools/build.ts` in it); one asked for while one runs makes one more after. */
  build(): Promise<PlaceBuild> {
    if (!this.project) return Promise.reject(new Error("no place is open"));
    if (this.running) {
      this.again = true;
      return this.running.then(() => this.running ?? this.last!);
    }
    this.running = (async () => {
      let build: PlaceBuild;
      do {
        this.again = false;
        const project = this.project!;
        const t0 = performance.now();
        const seq = ++this.seq;
        const fresh = readProject(project.folder);
        Object.assign(project, { manifest: fresh.manifest, problems: fresh.problems });
        const problems: Problem[] = fresh.problems.map(message => ({ file: "earthrt.json", message }));
        const hasScene = ((fresh.manifest?.content as Json[] | undefined) ?? []).some(c => c.type === "scene");
        if (hasScene && existsSync(join(project.folder, "tools/build.ts"))) {
          const r = await run([BUN, "tools/build.ts"], project.folder);
          if (r.code !== 0) problems.push(...parseProblems(r.err || r.out, project.folder));
        }
        build = { seq, ok: problems.length === 0, problems, ms: Math.round(performance.now() - t0), at: Date.now(), manifest: fresh.manifest ?? undefined };
        this.last = build;
        this.events.built(build, project);
      } while (this.again && this.project);
      this.running = undefined;
      return build;
    })();
    return this.running;
  }

  /** `bun run <script> ...` in the open project, its lines streamed. */
  async script(args: string[], env: Record<string, string> = {}, line?: (text: string, stream: "out" | "err") => void): Promise<Ran> {
    if (!this.project) throw new Error("no place is open");
    return run([BUN, "run", ...args], this.project.folder, env, line);
  }
}

/** Build errors as problems: `file:line:col: message` lines (Bun's), else the text's lines. */
export function parseProblems(text: string, folder: string): Problem[] {
  const out: Problem[] = [];
  for (const raw of text.replace(/\x1b\[[0-9;]*m/g, "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(?:error: )?(.+?\.(?:ts|js|json)):(\d+)(?::\d+)?:?\s*(.*)$/.exec(line);
    if (m) out.push({ file: relative(folder, resolve(folder, m[1]!)), line: Number(m[2]), message: m[3] || line });
    else out.push({ message: line });
  }
  return out.slice(0, 20).length ? out.slice(0, 20) : [{ message: "the build failed" }];
}
