// The package in the engine's headless live view (`threert-render live`), with this script as the app: the host
// channel as JSON lines (RUNTIME "The host channel"). With `online`, the driver answers `assets.fetch` (SPEC § 6:
// downloads into the asset root) and `net.fetch` itself, and lists "assets" in the launch's caps: the client's path,
// before the client has it. Without, the package reads the asset root as it is (a prefetched directory).
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, rmSync, statSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { waitGpuLock, releaseGpuLock } from "../../engine/tools/lib/bench.ts";

export const root = resolve(import.meta.dirname, "../..");
export const bin = process.env.THREERT_BIN ?? join(root, "engine/renderer/target/release/threert-render");

export interface LiveOptions {
  /** Asset root (default out/tiles). */
  assets?: string;
  launch?: Record<string, string>;
  online?: boolean;
  /** Also list "traced" in the caps (as the app does: no HUD; the script's traced.* posts land in `posts`). */
  traced?: boolean;
  width?: number;
  height?: number;
  /** --scale (default auto). */
  scale?: string;
  frameLog?: string;
  env?: Record<string, string>;
  /** Reconstruction (default metalfx-denoised,builtin). */
  reconstruction?: string;
  quiet?: boolean;
}

export interface Live {
  lines: string[];
  send(cmd: object): void;
  wait(pred: (l: string) => boolean, ms?: number): Promise<string>;
  snapshot(path: string, after?: number): Promise<void>;
  quit(): Promise<void>;
  fetches: { n: number; bytes: number; ms: number[] };
  /** What the script posted that the driver does not answer (earth.*, hud). */
  posts: { t: string; [k: string]: unknown }[];
}

const curlArgs = (url: string) => ["-s", "-L", "--max-time", "60", ...(process.env.HTTPS_PROXY && !/^http:\/\/(127\.|localhost)/.test(url) ? ["-x", process.env.HTTPS_PROXY] : [])];

export async function startLive(bundle: string, o: LiveOptions = {}): Promise<Live> {
  await waitGpuLock("earthrt-live");
  const assets = resolve(o.assets ?? join(root, "out/tiles"));
  const args = ["live", bundle, "--assets", assets, "--presets", join(root, "engine/presets"), "--width", String(o.width ?? 1280), "--height", String(o.height ?? 720), "--scale", o.scale ?? "auto"];
  args.push("--launch", JSON.stringify(o.launch ?? {}));
  if (o.online || o.traced) args.push("--caps", ["files", "store", ...(o.online ? ["assets"] : []), ...(o.traced ? ["traced"] : [])].join(","));
  if (o.frameLog) {
    rmSync(o.frameLog, { force: true });
    args.push("--frame-log", o.frameLog);
  }
  const env = { ...process.env, THREERT_RECONSTRUCTION: o.reconstruction ?? "metalfx-denoised,builtin", ...o.env };
  const p = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env });
  const lines: string[] = [];
  let waiters: [(l: string) => boolean, (l: string) => void][] = [];
  const onLine = (l: string) => {
    lines.push(l);
    if (!o.quiet && (l.startsWith("[game]") || /error|panic|fallback|rebuild/i.test(l))) console.log("  " + l.slice(0, 300));
    waiters = waiters.filter(([pred, res]) => (pred(l) ? (res(l), false) : true));
  };
  createInterface({ input: p.stderr! }).on("line", onLine);
  const send = (c: object) => p.stdin!.write(JSON.stringify(c) + "\n");
  const fetches = { n: 0, bytes: 0, ms: [] as number[] };
  const posts: Live["posts"] = [];
  // the app's side of the channel
  const pending: { t: string; id: string; url: string; path?: string }[] = [];
  let running = 0;
  const pump = () => {
    while (running < 16 && pending.length) {
      const m = pending.shift()!;
      running++;
      const t0 = Date.now();
      if (m.t === "assets.fetch") {
        const dest = join(assets, m.path!);
        if (existsSync(dest)) {
          running--;
          send({ cmd: "host", messages: [{ t: "assets.fetched", id: m.id, path: m.path, status: 200, size: statSync(dest).size, cached: true }] });
          continue;
        }
        mkdirSync(dirname(dest), { recursive: true });
        const tmp = `${dest}.part${m.id}`;
        execFile("curl", [...curlArgs(m.url), "-o", tmp, "-w", "%{http_code}", m.url], (err, out) => {
          running--;
          const status = err ? 0 : Number(String(out).trim());
          let size = 0;
          if (status === 200 && existsSync(tmp)) {
            renameSync(tmp, dest);
            size = statSync(dest).size;
            fetches.n++;
            fetches.bytes += size;
            fetches.ms.push(Date.now() - t0);
          } else rmSync(tmp, { force: true });
          send({ cmd: "host", messages: [{ t: "assets.fetched", id: m.id, path: m.path, status, size, cached: false, ...(err ? { error: String(err.message).slice(0, 200) } : {}) }] });
          pump();
        });
      } else {
        execFile("curl", [...curlArgs(m.url), "-w", "\n%{http_code}", m.url], { maxBuffer: 64 << 20 }, (err, out) => {
          running--;
          const s = String(out);
          const k = s.lastIndexOf("\n");
          const status = err ? 0 : Number(s.slice(k + 1));
          send({ cmd: "host", messages: [{ t: "net.fetched", id: m.id, status, body: status ? s.slice(0, k) : "", ...(err ? { error: String(err.message).slice(0, 200) } : {}) }] });
          pump();
        });
      }
    }
  };
  createInterface({ input: p.stdout! }).on("line", (l) => {
    if (!l.startsWith("{")) return;
    try {
      const j = JSON.parse(l) as { host?: { t: string; id: string; url: string; path?: string }[] };
      for (const m of j.host ?? []) {
        if (m.t !== "assets.fetch" && m.t !== "net.fetch" && m.t !== "assets.cancel") posts.push(m as never);
        if (m.t === "assets.fetch" || m.t === "net.fetch") pending.push(m);
        else if (m.t === "assets.cancel") {
          const k = pending.findIndex((x) => x.id === m.id);
          if (k >= 0) pending.splice(k, 1);
        }
      }
      pump();
    } catch {
      // not ours
    }
  });
  const exited = new Promise<void>((r) => p.on("exit", () => r()));
  const wait = (pred: (l: string) => boolean, ms = 300_000) =>
    new Promise<string>((res, rej) => {
      const hit = lines.find(pred);
      if (hit) return res(hit);
      const t = setTimeout(() => rej(new Error(`timed out (${lines.slice(-3).join(" | ")})`)), ms);
      waiters.push([pred, (l) => (clearTimeout(t), res(l))]);
      void exited.then(() => rej(new Error(`exited (${lines.slice(-5).join(" | ")})`)));
    });
  await wait((l) => l.includes("fps on") || l.startsWith("live:"), 300_000).catch((e) => {
    releaseGpuLock();
    throw e;
  });
  return {
    lines,
    send,
    wait,
    fetches,
    posts,
    async snapshot(path, after = 24) {
      mkdirSync(dirname(path), { recursive: true });
      rmSync(path, { force: true });
      send({ cmd: "snapshot", path: resolve(path), after });
      await wait((l) => l.includes(resolve(path)) || l.includes(path), 120_000).catch(() => {});
      for (let k = 0; k < 50 && !existsSync(path); k++) await new Promise((r) => setTimeout(r, 100));
    },
    async quit() {
      send({ cmd: "quit" });
      const t = setTimeout(() => p.kill(), 10_000);
      await exited;
      clearTimeout(t);
      releaseGpuLock();
    },
  };
}

/** Poses (tools/poses.json) as launch params. */
export function poseParams(p: { lat: number; lon: number; alt: number; heading: number; pitch: number; time?: number }): Record<string, string> {
  return { at: [p.lat, p.lon, p.alt, p.heading, p.pitch].join(","), ...(p.time !== undefined ? { time: String(p.time) } : {}) };
}
