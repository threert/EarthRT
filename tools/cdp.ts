// Drives real Chrome (GPU on: ANGLE on Metal) over the DevTools protocol, a fresh profile each launch. Shared by
// tools/probe-web.ts and tools/shots-web.ts. Adapted from ThreeRT's tools/three/browser.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

class Cdp {
  private id = 0;
  private readonly calls = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  readonly listeners: ((method: string, params: any, session?: string) => void)[] = [];
  constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id !== undefined) {
        const c = this.calls.get(m.id);
        this.calls.delete(m.id);
        if (m.error) c?.fail(new Error(`${m.error.message} ${m.error.data ?? ""}`));
        else c?.ok(m.result);
      } else for (const l of this.listeners) l(m.method, m.params, m.sessionId);
    });
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    return new Promise((ok, fail) => {
      this.calls.set(id, { ok, fail });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

export interface Page {
  evaluate<T = unknown>(expression: string, timeoutMs?: number): Promise<T>;
  /** Waits until `expression` is truthy (polled). */
  waitFor(expression: string, timeoutMs?: number): Promise<void>;
  screenshot(file: string, quality?: number): Promise<void>;
  /** Network bytes (encoded) seen by the page and its workers since open. */
  netBytes(): number;
  mouse(type: "mousePressed" | "mouseMoved" | "mouseReleased", x: number, y: number, button?: "left" | "right" | "none", extra?: object): Promise<void>;
  wheel(x: number, y: number, deltaY: number): Promise<void>;
  close(): Promise<void>;
}

export interface Browser {
  open(url: string, opt?: { width?: number; height?: number; dpr?: number; mobile?: boolean }): Promise<Page>;
  close(): void;
}

export async function launch(opt: { log?: (s: string) => void; headless?: boolean; proxy?: string } = {}): Promise<Browser> {
  const log = opt.log ?? (() => {});
  const profile = mkdtempSync(join(tmpdir(), "earthrt-chrome-"));
  const proxy = opt.proxy ?? process.env.EARTHRT_PROXY ?? "http://127.0.0.1:7897";
  const args = [
    ...(opt.headless === false ? [] : ["--headless=new"]),
    "--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-webgl", "--no-first-run", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--disable-gpu-watchdog", "--window-size=1280,720", "--disable-breakpad", "--disable-crash-reporter", "--hide-scrollbars",
    ...(proxy ? [`--proxy-server=${proxy}`, "--proxy-bypass-list=127.0.0.1;localhost;<-loopback>"] : []),
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
  ];
  const proc: ChildProcess = spawn(CHROME, args, { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise<string>((ok, fail) => {
    let buf = "";
    const t = setTimeout(() => fail(new Error("Chrome did not start")), 20000);
    proc.stderr!.on("data", (d) => {
      buf += String(d);
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) { clearTimeout(t); ok(m[1]); }
    });
    proc.on("exit", (c) => fail(new Error(`Chrome exited (${c}): ${buf.slice(-2000)}`)));
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, fail) => {
    ws.addEventListener("open", ok, { once: true });
    ws.addEventListener("error", fail, { once: true });
  });
  const cdp = new Cdp(ws);
  cdp.listeners.push((method, p) => {
    if (method === "Runtime.consoleAPICalled") log(`[page ${p.type}] ${p.args.map((a: any) => a.value ?? a.description ?? "").join(" ")}`);
    else if (method === "Network.loadingFailed" && !p.canceled) log(`[net failed] ${p.errorText} ${p.blockedReason ?? ""} ${p.corsErrorStatus?.corsError ?? ""}`);
    else if (method === "Runtime.exceptionThrown") log(`[page exception] ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`);
  });
  return {
    async open(url, o = {}) {
      const width = o.width ?? 1280, height = o.height ?? 720;
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      let bytes = 0;
      const sessions = new Set<string>([sessionId]);
      cdp.listeners.push((method, p, s) => {
        if (method === "Network.loadingFinished" && s && sessions.has(s)) bytes += p.encodedDataLength ?? 0;
        if (method === "Target.attachedToTarget" && s === sessionId) {
          // workers: their own sessions; their network counts too
          const ws2 = p.sessionId as string;
          sessions.add(ws2);
          cdp.send("Network.enable", {}, ws2).catch(() => {});
          cdp.send("Runtime.enable", {}, ws2).catch(() => {});
          cdp.send("Runtime.runIfWaitingForDebugger", {}, ws2).catch(() => {});
        }
      });
      await cdp.send("Runtime.enable", {}, sessionId);
      await cdp.send("Page.enable", {}, sessionId);
      await cdp.send("Network.enable", {}, sessionId);
      await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: o.dpr ?? 1, mobile: !!o.mobile }, sessionId);
      if (o.mobile) await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, sessionId);
      await cdp.send("Page.navigate", { url }, sessionId);
      const page: Page = {
        async evaluate(expression, timeoutMs = 120_000) {
          const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs }, sessionId);
          if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
          return r.result.value;
        },
        async waitFor(expression, timeoutMs = 60_000) {
          const t0 = Date.now();
          for (;;) {
            const v = await page.evaluate(`(() => { try { return !!(${expression}); } catch { return false; } })()`).catch(() => false);
            if (v) return;
            if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${expression}`);
            await Bun.sleep(100);
          }
        },
        async screenshot(file, quality = 90) {
          const jpg = file.endsWith(".jpg");
          const r = await cdp.send("Page.captureScreenshot", jpg ? { format: "jpeg", quality } : { format: "png" }, sessionId);
          writeFileSync(file, Buffer.from(r.data, "base64"));
        },
        netBytes: () => bytes,
        async mouse(type, x, y, button = "left", extra = {}) {
          await cdp.send("Input.dispatchMouseEvent", { type, x, y, button, clickCount: type === "mouseMoved" ? 0 : 1, buttons: type === "mouseReleased" || button === "none" ? 0 : button === "right" ? 2 : 1, ...extra }, sessionId);
        },
        async wheel(x, y, deltaY) {
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY }, sessionId);
        },
        async close() {
          await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
        },
      };
      return page;
    },
    close() {
      try { ws.close(); } catch {}
      proc.kill("SIGTERM");
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} rmSync(profile, { recursive: true, force: true }); }, 1500);
    },
  };
}
