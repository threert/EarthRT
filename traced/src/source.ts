// Where tile and place files come from (SPEC § 6): the client's `assets.fetch` (a download into the package's cache,
// then `readAsset`) when the app lists "assets" in `launch.caps`; else the asset root as it is (a directory prefetched
// by tools/prefetch.ts, `threert-render play --assets <dir>`), where a file is there or it is not.
import { host } from "@threert/gameplay";
import { readAsset } from "@threert/scene";

/** What a request came to: `status` 200 (the file is at `path`), 204 (nothing there: no building data), else failed. */
export interface Fetched {
  path: string;
  status: number;
  size: number;
  cached: boolean;
}

export interface Signal {
  aborted: boolean;
  onabort?: () => void;
}

export interface Files {
  /** True when files come over the network (the client's `assets.fetch`). */
  readonly online: boolean;
  /** Gets `url` into `path` (under the asset root, starting with `cache/`). */
  get(url: string, path: string, signal?: Signal): Promise<Fetched>;
}

/** Whether a file is under the asset root (reads its first byte). */
export function exists(path: string): boolean {
  try {
    readAsset(path, 0, 1);
    return true;
  } catch {
    return false;
  }
}

/** The asset root as it is: a prefetched directory, or a package's cache filled before. */
export class LocalFiles implements Files {
  readonly online = false;
  get(_url: string, path: string): Promise<Fetched> {
    // (a missing tile is "nothing there": offline, nothing will come; a missing building tile is the 204 it was)
    return Promise.resolve(exists(path) ? { path, status: 200, size: 0, cached: true } : { path, status: 404, size: 0, cached: true });
  }
}

type Answer = { t: "assets.fetched"; id: string; path: string; status: number; size: number; cached: boolean; error?: string };

/** The client's `assets.fetch` (SPEC § 6). A file already fetched (in this run) is answered without asking again. */
export class AssetsFetch implements Files {
  readonly online = true;
  private next = 0;
  private waiting = new Map<string, { resolve: (f: Fetched) => void; reject: (e: Error) => void }>();
  /** Paths known to be in the cache (fetched this run, or found there): no request. */
  private have = new Set<string>();
  stats = { requests: 0, cached: 0, failed: 0, bytes: 0 };

  constructor() {
    host.on("assets.fetched", (m) => {
      const a = m as unknown as Answer;
      const w = this.waiting.get(a.id);
      if (!w) return;
      this.waiting.delete(a.id);
      if (a.cached) this.stats.cached++;
      if (a.status === 200) {
        this.have.add(a.path);
        this.stats.bytes += a.size ?? 0;
        w.resolve({ path: a.path, status: 200, size: a.size, cached: a.cached });
      } else if (a.status === 204 || a.status === 404) {
        w.resolve({ path: a.path, status: a.status, size: 0, cached: a.cached });
      } else {
        this.stats.failed++;
        w.reject(new Error(`${a.status} ${a.error ?? ""}`.trim()));
      }
    });
  }

  get(url: string, path: string, signal?: Signal): Promise<Fetched> {
    if (this.have.has(path)) return Promise.resolve({ path, status: 200, size: 0, cached: true });
    const id = `a${++this.next}`;
    this.stats.requests++;
    return new Promise<Fetched>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      host.post({ t: "assets.fetch", id, url, path });
      if (signal) {
        signal.onabort = () => {
          if (!this.waiting.has(id)) return;
          this.waiting.delete(id);
          host.post({ t: "assets.cancel", id });
          reject(new Error("canceled"));
        };
      }
    });
  }

  get pending() {
    return this.waiting.size;
  }
}

/** One HTTP request through the app (`net.fetch`), its body as text. */
let fetches = 0;
const fetchWaiting = new Map<string, (m: { status: number; body: string; error?: string }) => void>();
let fetchListening = false;
export function netFetch(url: string): Promise<{ status: number; body: string; error?: string }> {
  if (!fetchListening) {
    fetchListening = true;
    host.on("net.fetched", (m) => {
      const w = fetchWaiting.get(m.id);
      if (!w) return;
      fetchWaiting.delete(m.id);
      w(m);
    });
  }
  const id = `earth-${++fetches}`;
  return new Promise((resolve) => {
    fetchWaiting.set(id, resolve);
    if (!host.post({ t: "net.fetch", id, url })) {
      fetchWaiting.delete(id);
      resolve({ status: 0, body: "", error: "no app answers net.fetch here" });
    }
  });
}

/** A file under the asset root as text (ASCII / UTF-8 JSON), or null. */
export function readText(path: string): string | null {
  try {
    const b = new Uint8Array(readAsset(path));
    return new TextDecoderLite().decode(b);
  } catch {
    return null;
  }
}

/** UTF-8 to a string (QuickJS has no TextDecoder). */
class TextDecoderLite {
  decode(b: Uint8Array): string {
    let s = "";
    for (let i = 0; i < b.length; ) {
      const c = b[i++];
      if (c < 0x80) s += String.fromCharCode(c);
      else if (c < 0xe0) s += String.fromCharCode(((c & 0x1f) << 6) | (b[i++] & 0x3f));
      else if (c < 0xf0) s += String.fromCharCode(((c & 0x0f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f));
      else {
        const cp = ((c & 0x07) << 18) | ((b[i++] & 0x3f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f);
        s += String.fromCodePoint(cp);
      }
    }
    return s;
  }
}
