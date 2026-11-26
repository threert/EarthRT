// The sidecar's door: one HTTP and WebSocket server on the loopback. Every request carries the token the sidecar made
// at start (the app gets it with the port on the sidecar's first line of output, the `earthrt` command line from
// .build/server.json); a request from a web page (it has an Origin) is refused: the agent runs commands as the user.
// From threert/native-app-template's sidecar (MIT, Meshy LLC), with place projects in place of the template's scene.
//
//   WS   /app?token=…                 the app: JSON messages both ways (native/README.md has the table)
//   GET  /api/state | /api/logs       POST /api/check | /api/shot | /api/send | /api/app     the `earthrt` command line
//        (header `Authorization: Bearer <token>`)
import type { ServerWebSocket } from "bun";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Handler } from "./agent/types.ts";
import { deviceStart, devicePoll, ghToken, whoami } from "./github.ts";
import { API, BUILD, SERVER_FILE } from "./paths.ts";
import { Places, type PlaceBuild, type Problem, type Project } from "./places.ts";

type Json = Record<string, unknown>;
type Socket = ServerWebSocket<{ role: string }>;

export interface LogLine { level: string; text: string; at: number }
export interface RuntimeError { where: string; message: string; at: number }

/** What the app saw when the globe loaded a build of the open place (`runtime.place`). */
export interface PlaceLoad { seq: number; loaded: boolean; errors: string[]; at: number }

export interface CheckReport {
  ok: boolean;
  place: { folder: string; id?: string } | null;
  build: { ok: boolean; problems: Problem[]; ms: number } | null;
  app: "loaded" | "failed" | "not connected" | "timeout";
  errors: string[];
  logs: LogLine[];
  stats?: Json | null;
}

/** The agent panel's words in EarthRT. */
export const PANEL = {
  title: "Agent",
  intro: "Your own Claude Code or Codex, working in this place's folder. It edits the scene, the place reloads in the globe on every save.",
  placeholder: "Describe what to build here…",
  suggestions: [
    "Build a small wooden tea house with a lantern by its door",
    "Add a stone garden with a few maple trees around the anchor",
    "Light it for the evening: paper lanterns that glow at dusk",
  ],
};

export class Server {
  /** What every request must carry. */
  readonly token = randomBytes(24).toString("hex");
  readonly places: Places;
  readonly handlers = new Map<string, Handler>();
  readonly stateParts: (() => Json)[] = [];
  private readonly sockets = new Set<Socket>();
  private server!: ReturnType<typeof Bun.serve>;
  private stateTimer: ReturnType<typeof setTimeout> | undefined;
  private pending = new Map<number, (answer: Json) => void>();
  private nextRequest = 1;
  private nextTask = 1;
  /** The project changed (the agent bridge starts over in the new one). */
  onProject: ((project: Project | null) => void) | undefined;
  stats: Json | null = null;
  errors: RuntimeError[] = [];
  logs: LogLine[] = [];
  loads: PlaceLoad[] = [];
  private loadWaiters: { seq: number; resolve: (l: PlaceLoad | null) => void }[] = [];
  /** Settings the app hands over (from its Keychain): the Meshy key, the GitHub token, the OAuth App's client id. */
  settings: { meshyKey?: string; githubToken?: string; githubClientId?: string } = {};

  constructor(placesDir?: string, template?: string) {
    this.places = new Places({
      opened: project => { this.broadcast({ t: "place.opened", project }); this.onProject?.(project); this.stateChanged(); },
      built: (build, project) => { this.broadcast({ t: "place.built", ...this.buildState(build), project }); this.stateChanged(); },
      files: paths => this.broadcast({ t: "place.files", paths }),
    }, placesDir, template);
    this.stateParts.push(() => ({ place: { project: this.places.project, build: this.buildState(this.places.last) }, panel: PANEL }));
    this.on("runtime.error", m => this.pushError({ where: String(m.where ?? "?"), message: String(m.message ?? ""), at: Date.now() }));
    this.on("runtime.logs", m => this.pushLogs(((m.lines as Json[]) ?? []).map(l => ({ level: String(l.level ?? "log"), text: String(l.text ?? ""), at: Date.now() }))));
    this.on("runtime.stats", m => { this.stats = (m.stats as Json) ?? null; });
    this.on("runtime.place", m => this.placeLoaded({ seq: Number(m.seq ?? 0), loaded: m.loaded === true, errors: ((m.errors as unknown[]) ?? []).map(String), at: Date.now() }));
    this.on("answer", m => { const done = this.pending.get(Number(m.id)); if (done) { this.pending.delete(Number(m.id)); done(m); } });
    this.on("settings", m => {
      for (const k of ["meshyKey", "githubToken", "githubClientId"] as const) if (typeof m[k] === "string") this.settings[k] = (m[k] as string) || undefined;
      // (The agent's environment: the template's `bun run meshy` reads MESHY_API_KEY.)
      if (this.settings.meshyKey) process.env.MESHY_API_KEY = this.settings.meshyKey; else delete process.env.MESHY_API_KEY;
    });
    // ----- place projects -----
    this.on("place.list", (_m, reply) => reply({ t: "place.list", projects: this.places.list() }));
    this.on("place.open", (m, reply) => this.task("open", reply, () => this.places.open(String(m.folder ?? ""))));
    this.on("place.close", () => { this.places.close(); this.onProject?.(null); this.broadcast({ t: "place.closed" }); this.stateChanged(); });
    this.on("place.create", (m, reply) => this.task("create", reply, log => this.places.create({
      lat: Number(m.lat), lon: Number(m.lon), title: m.title as string | undefined, id: m.id as string | undefined,
      kind: m.kind as string | undefined, radius: m.radius as number | undefined, heading: m.heading as number | undefined,
    }, log)));
    this.on("place.remix", (m, reply) => this.task("remix", reply, log => this.places.remix(String(m.repo ?? ""), log)));
    this.on("place.build", async () => { await this.places.build(); });
    this.on("place.check", (_m, reply) => this.task("check", reply, async log => {
      const r = await this.places.script(["check"], {}, text => log(text));
      if (r.code !== 0) throw new Error("bun run check found problems");
      return { ok: true };
    }));
    this.on("place.publish", (m, reply) => this.task("publish", reply, log => this.publish({ repo: m.repo as string | undefined, dryRun: m.dryRun !== false }, log)));
    this.on("meshy.generate", (m, reply) => this.task("meshy", reply, log => this.meshy(m, log)));
    // ----- GitHub -----
    this.on("github.whoami", (_m, reply) => this.task("github", reply, async () => {
      const gh = this.settings.githubToken ? null : await ghToken();
      const token = this.settings.githubToken ?? gh;
      if (!token) return { signedIn: false };
      const user = await whoami(token);
      // (gh's token goes to the app for likes, in memory: it is gh's to keep.)
      return { signedIn: true, via: gh ? "gh" : "app", user, ...(gh ? { ghToken: gh } : {}) };
    }));
    this.on("github.signin", (m, reply) => this.task("github.signin", reply, async log => {
      const clientId = String(m.clientId ?? this.settings.githubClientId ?? process.env.EARTHRT_GITHUB_CLIENT_ID ?? "");
      const code = await deviceStart(clientId);
      this.broadcast({ t: "github.device", userCode: code.user_code, uri: code.verification_uri, expires: code.expires_in });
      log(`Enter ${code.user_code} at ${code.verification_uri}`);
      const token = await devicePoll(clientId, code);
      const user = await whoami(token);
      this.settings.githubToken = token;
      return { token, user };
    }));
  }

  private buildState(build: PlaceBuild | undefined): Json | null {
    return build ? { seq: build.seq, ok: build.ok, problems: build.problems, ms: build.ms, manifest: build.manifest ?? null } : null;
  }

  private pushError(e: RuntimeError): void {
    this.errors.push(e);
    if (this.errors.length > 100) this.errors.splice(0, this.errors.length - 100);
  }

  private pushLogs(lines: LogLine[]): void {
    this.logs.push(...lines);
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
  }

  private placeLoaded(l: PlaceLoad): void {
    this.loads.push(l);
    if (this.loads.length > 50) this.loads.shift();
    for (const w of this.loadWaiters.filter(w => w.seq <= l.seq)) w.resolve(l);
    this.loadWaiters = this.loadWaiters.filter(w => w.seq > l.seq);
  }

  /** Resolves when the app says how build `seq` loaded (or null after `ms`). */
  waitPlace(seq: number, ms: number): Promise<PlaceLoad | null> {
    const known = this.loads.find(l => l.seq >= seq);
    if (known) return Promise.resolve(known);
    return new Promise(resolve => {
      const w = { seq, resolve: (l: PlaceLoad | null) => { clearTimeout(timer); resolve(l); } };
      const timer = setTimeout(() => { this.loadWaiters = this.loadWaiters.filter(x => x !== w); resolve(null); }, ms);
      this.loadWaiters.push(w);
    });
  }

  /** A long job for the app: `task {id, kind, state, line?, result?, error?}` as it goes; the reply is its id. */
  task(kind: string, reply: (m: Json) => void, job: (log: (line: string) => void) => Promise<unknown>): Promise<void> {
    const id = this.nextTask++;
    reply({ t: "task", id, kind, state: "running" });
    const log = (line: string) => this.broadcast({ t: "task", id, kind, state: "running", line });
    return job(log).then(
      result => this.broadcast({ t: "task", id, kind, state: "done", result: result ?? null }),
      error => this.broadcast({ t: "task", id, kind, state: "failed", error: String(error instanceof Error ? error.message : error) }),
    );
  }

  /** Publish (ARCHITECTURE § 5): `bun run register` in the project, `--create owner/name` the first time. A dry
   *  run (the default) checks and says what it would do; nothing is created or pushed. */
  async publish(o: { repo?: string; dryRun: boolean }, log: (line: string) => void): Promise<Json> {
    const project = this.places.project;
    if (!project) throw new Error("no place is open");
    const token = this.settings.githubToken ?? await ghToken();
    if (!token) throw new Error("Sign in to GitHub first (Settings → Account), or `gh auth login`");
    const args = ["register", "--api", API];
    if (!project.repo) {
      if (!o.repo || !/^[\w.-]+\/[\w.-]+$/.test(o.repo)) throw new Error("Publish needs a repository name: owner/name");
      args.push("--create", o.repo);
    }
    if (o.dryRun) args.push("--dry-run");
    log(`bun run ${args.join(" ")}${o.dryRun ? "" : "  (creates a public repository and registers it)"}`);
    let url: string | undefined;
    const r = await this.places.script(args, { GITHUB_TOKEN: token, EARTHRT_API: API }, text => {
      log(text);
      url ??= /https:\/\/earth\.threert\.dev\/\S+/.exec(text)?.[0];
    });
    if (r.code !== 0) throw new Error((r.err.trim().split("\n").pop() ?? "") || "bun run register failed");
    return { dryRun: o.dryRun, url: url ?? null };
  }

  /** The Meshy panel: `bun run meshy text|image … --name --height --at` in the project, with the user's key (or
   *  `--mock`, Meshy's stand-in, when there is none). */
  async meshy(m: Json, log: (line: string) => void): Promise<Json> {
    if (!this.places.project) throw new Error("Open a place first: a model goes into a place");
    const mode = m.mode === "image" ? "image" : "text";
    const input = String(mode === "image" ? m.image ?? "" : m.prompt ?? "").trim();
    if (!input) throw new Error(mode === "image" ? "Choose a picture" : "Describe the model");
    const name = String(m.name ?? "").trim() || input.split(/\s+/).slice(0, 3).join("-").toLowerCase().replace(/[^a-z0-9-]/g, "") || "model";
    const args = ["meshy", mode, input, "--name", name];
    if (Number(m.height) > 0) args.push("--height", String(m.height));
    if (Array.isArray(m.at) && m.at.length === 2) args.push("--at", `${Number(m.at[0])},${Number(m.at[1])}`);
    const key = this.settings.meshyKey;
    const mock = m.mock === true || !key;
    if (mock) args.push("--mock");
    log(`bun run ${args.join(" ")}${mock ? "  (no Meshy key: Meshy's stand-in, a placeholder)" : ""}`);
    const r = await this.places.script(args, key ? { MESHY_API_KEY: key } : {}, text => log(text));
    if (r.code !== 0) throw new Error((r.err.trim().split("\n").pop() ?? "") || "bun run meshy failed");
    return { name, mock, file: `assets/models/${name}.glb` };
  }

  on(type: string, handler: Handler): void { this.handlers.set(type, handler); }

  get project(): string { return this.places.project?.folder ?? ""; }

  /** A few lines about the place for the agent's prompt. */
  context(): string {
    const lines: string[] = [];
    const p = this.places.project;
    const m = p?.manifest as { title?: string; anchor?: { lat: number; lon: number }; kind?: string } | null | undefined;
    if (m?.anchor) lines.push(`The place: "${m.title ?? p!.name}" (${m.kind ?? "site"}) at ${m.anchor.lat.toFixed(5)}, ${m.anchor.lon.toFixed(5)}.`);
    const build = this.places.last;
    if (build && !build.ok) lines.push(`The last build failed:\n${build.problems.slice(0, 5).map(p => `  ${p.file ?? ""}${p.line ? `:${p.line}` : ""} ${p.message}`).join("\n")}`);
    const load = this.loads.at(-1);
    if (load && load.errors.length) lines.push(`The app said when it loaded the place:\n${load.errors.slice(0, 3).map(e => `  ${e}`).join("\n")}`);
    if (this.settings.meshyKey) lines.push("The user gave the app a Meshy key: `bun run meshy` uses it (it costs their credits: say how many models you are about to make).");
    else lines.push("There is no Meshy key in the app: `bun run meshy` works only with --mock (a placeholder); make models in code, or ask the user for a key (the app's Meshy panel).");
    return lines.join("\n");
  }

  state(): Json {
    return Object.assign({ t: "state" }, ...this.stateParts.map(part => part()));
  }

  stateChanged(): void {
    clearTimeout(this.stateTimer);
    this.stateTimer = setTimeout(() => this.broadcast(this.state()), 30);
  }

  broadcast(message: Json): void {
    const text = JSON.stringify(message);
    for (const socket of this.sockets) socket.send(text);
  }

  get appConnected(): boolean { return this.sockets.size > 0; }

  ask(message: Json, ms = 30_000): Promise<Json | null> {
    if (!this.appConnected) return Promise.resolve(null);
    const id = this.nextRequest++;
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null); }, ms);
      this.pending.set(id, answer => { clearTimeout(timer); resolve(answer); });
      this.broadcast({ ...message, id });
    });
  }

  private async handle(message: Json, reply: (m: Json) => void): Promise<void> {
    const handler = this.handlers.get(String(message.t));
    if (!handler) { reply({ t: "error", message: `unknown message ${String(message.t)}` }); return; }
    try { await handler(message, reply); } catch (error) { reply({ t: "error", message: String(error instanceof Error ? error.message : error) }); }
  }

  /** `earthrt check`: builds the place, validates its manifest, and waits for the app to load the build. */
  async check(): Promise<CheckReport> {
    const project = this.places.project;
    const report: CheckReport = { ok: false, place: null, build: null, app: "not connected", errors: [], logs: [] };
    if (!project) { report.errors.push("no place is open in the app"); return report; }
    const since = Date.now();
    const build = await this.places.build();
    report.place = { folder: project.folder, id: project.manifest?.id as string | undefined };
    report.build = { ok: build.ok, problems: build.problems, ms: build.ms };
    if (build.ok && this.appConnected) {
      const load = await this.waitPlace(build.seq, 25_000);
      report.app = !load ? "timeout" : load.loaded && !load.errors.length ? "loaded" : "failed";
      report.errors = load?.errors ?? [];
      report.logs = this.logs.filter(l => l.at >= since && (/error|warn/.test(l.level) || /dev place|place .*:/.test(l.text))).slice(-20);
      report.errors.push(...this.errors.filter(e => e.at >= since).map(e => `[${e.where}] ${e.message}`));
    }
    report.stats = this.stats;
    report.ok = build.ok && report.errors.length === 0 && (report.app === "loaded" || report.app === "not connected");
    return report;
  }

  async listen(file = SERVER_FILE): Promise<number> {
    this.server = Bun.serve<{ role: string }, never>({
      hostname: "127.0.0.1",
      port: Number(process.env.EARTHRT_SIDECAR_PORT ?? 0),
      fetch: async (request, server) => {
        const url = new URL(request.url);
        if (request.headers.has("origin")) return new Response("forbidden", { status: 403 });
        const token = url.searchParams.get("token") ?? request.headers.get("authorization")?.replace(/^Bearer /, "");
        if (token !== this.token) return new Response("forbidden", { status: 403 });
        if (url.pathname === "/app") {
          return server.upgrade(request, { data: { role: "app" } }) ? undefined : new Response("upgrade failed", { status: 400 });
        }
        try { return await this.api(url, request); } catch (error) {
          return Response.json({ error: String(error instanceof Error ? error.message : error) }, { status: 500 });
        }
      },
      websocket: {
        open: socket => { this.sockets.add(socket); socket.send(JSON.stringify(this.state())); },
        close: socket => { this.sockets.delete(socket); },
        message: (socket, data) => {
          let message: Json;
          try { message = JSON.parse(String(data)); } catch { return; }
          void this.handle(message, reply => socket.send(JSON.stringify(reply)));
        },
      },
    });
    const port = this.server.port!;
    mkdirSync(dirname(file), { recursive: true });
    rmSync(file, { force: true });
    writeFileSync(file, JSON.stringify({ port, pid: process.pid, token: this.token }) + "\n", { mode: 0o600 });
    return port;
  }

  stop(): void { this.server?.stop(true); this.places.close(); }

  private async api(url: URL, request: Request): Promise<Response> {
    let body: Json = {};
    if (request.method === "POST") {
      const text = await request.text();
      try { body = text.trim() ? JSON.parse(text) : {}; } catch { return Response.json({ error: `the body is not JSON: ${text.slice(0, 200)}` }, { status: 400 }); }
    }
    switch (url.pathname) {
      case "/api/state": return Response.json({ ...this.state(), app: this.appConnected, stats: this.stats });
      case "/api/check": return Response.json(await this.check());
      case "/api/logs": return Response.json({ logs: this.logs.slice(-Number(url.searchParams.get("n") ?? 50)), errors: this.errors.slice(-10) });
      case "/api/shot": {
        // What the globe shows: at the open place's start (or a camera in its frame), once the tiles are in.
        const path = typeof body.path === "string" ? body.path : join(BUILD, "shots", `shot-${Date.now()}.png`);
        mkdirSync(dirname(path), { recursive: true });
        const answer = await this.ask({ t: "app.snapshot", path, wait: Number(body.wait ?? 2), ...(body.camera ? { camera: body.camera } : {}), ...(body.view ? { view: body.view } : {}), place: body.place !== false }, 90_000);
        if (answer?.error) return Response.json({ error: answer.error }, { status: 500 });
        return answer ? Response.json(answer) : Response.json({ error: "the app is not running (or did not answer)" }, { status: 503 });
      }
      case "/api/send": {
        if (!this.appConnected) return Response.json({ error: "the app is not running" }, { status: 503 });
        const messages = Array.isArray(body.messages) ? body.messages : [body.message ?? body];
        this.broadcast({ t: "app.send", messages });
        return Response.json({ sent: messages.length });
      }
      case "/api/app": {
        if (typeof body.t !== "string" || !body.t.startsWith("app.")) return Response.json({ error: "a request for the app needs a type: {\"t\": \"app.…\", ...}" }, { status: 400 });
        const answer = await this.ask(body, 60_000);
        return answer ? Response.json(answer) : Response.json({ error: "the app is not running (or did not answer)" }, { status: 503 });
      }
      default: return new Response("not found", { status: 404 });
    }
  }
}
