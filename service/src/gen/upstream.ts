// How the generator reads the outside world (terrain PNGs, COG byte ranges, PMTiles, our own R2 objects). The Worker
// and the Bun tools each give one: the generator itself never calls fetch, so both make the same tiles.

export interface Upstream {
  /** A whole file; null when it does not exist (404 / 403). */
  get(url: string): Promise<Uint8Array | null>;
  /** `length` bytes from `start`; null when the file does not exist. */
  range(url: string, start: number, length: number): Promise<Uint8Array | null>;
  /** Our own stored objects (R2 in the Worker, a directory for tools), by key. */
  getObject(key: string): Promise<Uint8Array | null>;
  /** A byte range of one of our objects (PMTiles extracts). */
  getObjectRange(key: string, start: number, length: number): Promise<Uint8Array | null>;
  putObject?(key: string, bytes: Uint8Array, contentType?: string): Promise<void>;
}

/** A small in-memory LRU (per isolate / process) in front of an Upstream. */
export class MemoUpstream implements Upstream {
  private memo = new Map<string, Promise<Uint8Array | null>>();
  private size = 0;
  constructor(private inner: Upstream, private budget = 48 << 20) {}

  private remember(key: string, make: () => Promise<Uint8Array | null>) {
    const hit = this.memo.get(key);
    if (hit) {
      this.memo.delete(key);
      this.memo.set(key, hit);
      return hit;
    }
    const p = make().then(
      (v) => {
        this.size += v?.byteLength ?? 0;
        while (this.size > this.budget && this.memo.size > 1) {
          const [k, old] = this.memo.entries().next().value!;
          this.memo.delete(k);
          old.then((o) => (this.size -= o?.byteLength ?? 0));
        }
        return v;
      },
      (e) => {
        this.memo.delete(key);
        throw e;
      },
    );
    this.memo.set(key, p);
    return p;
  }

  get(url: string) { return this.remember(`g ${url}`, () => this.inner.get(url)); }
  range(url: string, start: number, length: number) { return this.remember(`r ${url} ${start} ${length}`, () => this.inner.range(url, start, length)); }
  getObject(key: string) { return this.remember(`o ${key}`, () => this.inner.getObject(key)); }
  getObjectRange(key: string, start: number, length: number) { return this.remember(`or ${key} ${start} ${length}`, () => this.inner.getObjectRange(key, start, length)); }
  putObject(key: string, bytes: Uint8Array, contentType?: string) { return this.inner.putObject?.(key, bytes, contentType) ?? Promise.resolve(); }
}

/** fetch with retries on 5xx and network errors. */
export async function fetchRetry(url: string, init: RequestInit = {}, tries = 3): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, init);
      if (r.status < 500) return r;
      last = new Error(`${r.status} ${url}`);
      await r.body?.cancel();
    } catch (e) {
      last = e;
    }
    await new Promise((res) => setTimeout(res, 150 * (i + 1) ** 2));
  }
  throw last;
}
