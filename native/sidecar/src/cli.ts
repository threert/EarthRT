// `earthrt`: the EarthRT app's command line, for the coding agent working in a place's folder (and for people). Talks
// to the running app's sidecar over HTTP (its port and token are in the build folder's server.json).
//
//   earthrt check               build the place, validate earthrt.json, have the app's globe load it; exit 1 on a problem
//   earthrt shot [file.png]     save what the globe shows as a PNG: at the place's start, once its tiles are in
//                  [--camera '{"position":[x,y,z],"target":[x,y,z]}']   from elsewhere, in the place's frame (m)
//                  [--window]   the whole window: the globe with the app's panels over it
//                  [--here]     where the camera is now (not flown to the place)
//   earthrt logs [-n 50]        the globe's recent console lines and errors
//   earthrt state               the place, its last build, the agent (JSON)
//   earthrt send '<json>'       a host-channel message for the globe (`earth.goto`, `earth.time`, …: SPEC § 6)
//   earthrt app '<json>'        a request for the app, as tests drive it: app.pointer {u, v, click | button, down},
//                               app.key {key, hold?}, app.wheel {notches}, app.panel {panel, show}, app.prompt {text},
//                               app.shot {path} (= shot --window), app.open {url} (an earthrt:// link), app.search {q},
//                               app.select {place}, app.choose {place}, app.fly {from?, to}, app.time {hour}, app.pick {lat, lon},
//                               app.create {lat, lon, title}, app.click {x, y}, app.window {size?, appearance?}, app.state
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const BUILD = process.env.EARTHRT_BUILD ?? join(process.env.EARTHRT_ROOT ?? resolve(import.meta.dir, "../../.."), "native/.build");
const [command = "help", ...args] = process.argv.slice(2);

function server(): { port: number; token: string } {
  try { return JSON.parse(readFileSync(join(BUILD, "server.json"), "utf8")); } catch {
    console.error("The EarthRT app is not running (no sidecar): open it, then try again.");
    process.exit(2);
  }
}

async function call(path: string, body?: unknown): Promise<any> {
  const { port, token } = server();
  const headers = { authorization: `Bearer ${token}` };
  const response = await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) }).catch(() => {
    console.error("The EarthRT app is not running (its sidecar did not answer): open it, then try again.");
    process.exit(2);
  });
  const json = await response.json();
  if (!response.ok) { console.error(json.error ?? response.statusText); process.exit(1); }
  return json;
}

/** The window as the screen shows it (`screencapture -l`: needs the display awake and this terminal's Screen
 *  Recording permission), else composed offscreen by the app (glass and vibrancy come out flat). */
async function windowShot(path: string): Promise<{ path: string; width: number; height: number }> {
  const w = await call("/api/app", { t: "app.window" });
  if (w.number) {
    const r = Bun.spawnSync(["screencapture", "-x", "-o", "-l", String(w.number), path]);
    if (r.exitCode === 0 && Bun.file(path).size > 50_000) {
      const size = Bun.spawnSync(["sips", "-g", "pixelWidth", "-g", "pixelHeight", path]).stdout.toString();
      const n = (k: string) => Number(new RegExp(`${k}: (\\d+)`).exec(size)?.[1] ?? 0);
      return { path, width: n("pixelWidth"), height: n("pixelHeight") };
    }
  }
  return call("/api/app", { t: "app.shot", path });
}

const flag = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const where = (p: { file?: string; line?: number }) => p.file ? `${p.file}${p.line ? `:${p.line}` : ""} ` : "";

switch (command) {
  case "check": {
    const r = await call("/api/check", {});
    if (!r.place) { console.log(`✗ ${r.errors[0] ?? "no place is open"}`); process.exit(1); }
    if (!r.build.ok) {
      console.log("✗ the place does not build:");
      for (const p of r.build.problems) console.log(`  ${where(p)}${p.message}`);
    } else console.log(`✓ built and validated in ${r.build.ms} ms`);
    if (r.build.ok) {
      if (r.app === "loaded") console.log("✓ the app's globe loaded this build of the place");
      else if (r.app === "not connected") console.log("· the app is not open: not loaded (build and manifest only)");
      else console.log(`✗ the globe did not load it (${r.app})`);
    }
    for (const e of r.errors) console.log(`✗ ${e}`);
    for (const l of r.logs) console.log(`  console.${l.level}: ${l.text}`);
    if (r.stats) console.log(`· ${Math.round(r.stats.fps)} fps, GPU ${Number(r.stats.gpuMs).toFixed(1)} ms, globe script ${Number(r.stats.scriptMs).toFixed(1)} ms`);
    console.log(r.ok ? "OK" : "FAILED");
    process.exit(r.ok ? 0 : 1);
  }
  case "shot": {
    const file = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "--camera");
    let camera: unknown;
    if (flag("--camera")) {
      try { camera = JSON.parse(flag("--camera")!); } catch { console.error("--camera takes JSON: '{\"position\":[0,1.6,8],\"target\":[0,1,0]}'"); process.exit(1); }
    }
    const r = args.includes("--window")
      ? await windowShot(resolve(file ?? `shot-window-${Date.now()}.png`))
      : await call("/api/shot", { ...(file ? { path: resolve(file) } : {}), ...(camera ? { camera } : {}), place: !args.includes("--here") });
    console.log(`${r.path} (${r.width}x${r.height})`);
    break;
  }
  case "logs": {
    const n = args.includes("-n") ? Number(flag("-n")) : 50;
    const r = await call(`/api/logs?n=${n}`);
    for (const l of r.logs) console.log(`${l.level.padEnd(5)} ${l.text}`);
    for (const e of r.errors) console.log(`error [${e.where}] ${e.message}`);
    break;
  }
  case "state": console.log(JSON.stringify(await call("/api/state"), null, 2)); break;
  case "send": {
    let message: unknown;
    try { message = JSON.parse(args.join(" ")); } catch { console.error("earthrt send takes a JSON message: earthrt send '{\"t\":\"earth.time\",\"solarHour\":17}'"); process.exit(1); }
    console.log(JSON.stringify(await call("/api/send", Array.isArray(message) ? { messages: message } : { message })));
    break;
  }
  case "app": {
    let request: unknown;
    try { request = JSON.parse(args.join(" ")); } catch { console.error("earthrt app takes a JSON request: earthrt app '{\"t\":\"app.key\",\"key\":\"W\"}'"); process.exit(1); }
    console.log(JSON.stringify(await call("/api/app", request)));
    break;
  }
  default:
    console.log(readFileSync(import.meta.path, "utf8").split("\n").filter(l => l.startsWith("//")).map(l => l.slice(3)).join("\n"));
}
