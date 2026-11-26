// The map engine embedded (SPEC § 6.1): in the native app's WKWebView (`host=app`: out by
// window.webkit.messageHandlers.earth.postMessage, in by window.earthrt.receive) or in a page's <iframe>
// (`parent=<origin>`: postMessage({ earthrt: msg }) both ways, only with that origin). With a host the map draws no
// interface of its own; it reports what it shows and does what the host asks.

export type HostMessage = { t: string; [k: string]: unknown };

export interface HostLink {
  readonly kind: "app" | "parent";
  send(msg: HostMessage): void;
  /** Set by the app: called with each message from the host. */
  onMessage: ((msg: HostMessage) => void) | null;
}

declare global {
  interface Window {
    webkit?: { messageHandlers?: { earth?: { postMessage(m: unknown): void } } };
    earthrt?: { receive(msg: HostMessage | string): void; queue?: HostMessage[] };
  }
}

/** The link to the host the page was opened with, or null (a plain page). */
export function connectHost(kind: "app" | "parent" | undefined, parentOrigin?: string): HostLink | null {
  if (kind === "app") {
    const link: HostLink = {
      kind: "app",
      onMessage: null,
      send(msg) {
        try { window.webkit?.messageHandlers?.earth?.postMessage(msg); } catch { /* no bridge (a browser with ?host=app) */ }
      },
    };
    // messages the app sent before the engine was ready (it may define window.earthrt.queue first)
    const early = window.earthrt?.queue ?? [];
    window.earthrt = {
      receive(m) {
        const msg = typeof m === "string" ? (JSON.parse(m) as HostMessage) : m;
        if (msg && typeof msg.t === "string") link.onMessage?.(msg);
      },
    };
    queueMicrotask(() => early.forEach((m) => window.earthrt!.receive(m)));
    return link;
  }
  if (kind === "parent" && parentOrigin) {
    const link: HostLink = {
      kind: "parent",
      onMessage: null,
      send(msg) {
        window.parent?.postMessage({ earthrt: msg }, parentOrigin);
      },
    };
    window.addEventListener("message", (e) => {
      if (e.origin !== parentOrigin || e.source !== window.parent) return;
      const msg = (e.data as { earthrt?: HostMessage })?.earthrt;
      if (msg && typeof msg.t === "string") link.onMessage?.(msg);
    });
    return link;
  }
  return null;
}

/**
 * A service URL as the page fetches it: in the app (`host=app`) every file of the service (tiles, /api/v1, the
 * mirror) goes through the app's URL scheme, `https://<host>/<path>` → `ert://<host>/<path>` (SPEC § 6.1).
 */
export function serviceUrl(url: string, app: boolean): string {
  return app && url.startsWith("https://") ? `ert://${url.slice("https://".length)}` : url;
}

/** Sends at most `perSecond` times a second, and only when the value's key changed. */
export class Throttle {
  private last = 0;
  private key = "";
  constructor(private readonly perSecond: number) {}
  due(key: string, now: number): boolean {
    if (key === this.key || now - this.last < 1000 / this.perSecond) return false;
    this.last = now;
    this.key = key;
    return true;
  }
}

/** Whether the camera is within a place's enterFrom (SPEC § 5): a city by the height above the ground inside its
 *  bounds, anything else by the distance from its anchor. */
export function nearPlace(kind: string, enterFrom: number, horizontal: number, heightAboveGround: number, anchorDistance: number, radius: number): { near: boolean; distance: number } {
  if (kind === "city") {
    const inside = horizontal <= radius;
    return { near: inside && heightAboveGround <= enterFrom, distance: inside ? heightAboveGround : Infinity };
  }
  return { near: anchorDistance <= enterFrom, distance: anchorDistance };
}
