// The pool of tile workers (main thread side): round robin by least busy, requests abortable.
import type { PackedTile } from "./gpu-format.ts";
import type { WorkerRequest, WorkerResponse } from "./worker.ts";

declare const __WORKER_URL__: string;

type Pending = { ok: (v: any) => void; fail: (e: Error) => void; worker: number };

export class TilePool {
  private workers: Worker[] = [];
  private busy: number[] = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(size = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1))) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL(__WORKER_URL__, import.meta.url), { type: "module", name: `tiles-${i}` });
      w.onmessage = (e: MessageEvent<WorkerResponse>) => this.done(e.data);
      w.onerror = (e) => console.error("tile worker", e.message);
      this.workers.push(w);
      this.busy.push(0);
    }
  }

  get size() { return this.workers.length; }

  private pick() {
    let best = 0;
    for (let i = 1; i < this.busy.length; i++) if (this.busy[i] < this.busy[best]) best = i;
    return best;
  }

  private done(r: WorkerResponse) {
    const p = this.pending.get(r.id);
    if (!p) return;
    this.pending.delete(r.id);
    this.busy[p.worker]--;
    if (r.ok) p.ok("tile" in r ? r.tile : r.tiles);
    else p.fail(Object.assign(new Error(r.error), { status: r.status }));
  }

  /** A tile by URL; `signal.onabort` is set so the scheduler's drop reaches the worker's fetch. */
  get(url: string, layer: "terrain" | "buildings", cache: string | null, priority: "high" | "low" | "auto", signal?: { aborted: boolean; onabort?: () => void }): Promise<PackedTile> {
    const id = this.nextId++, w = this.pick();
    this.busy[w]++;
    return new Promise<PackedTile>((ok, fail) => {
      this.pending.set(id, { ok, fail, worker: w });
      if (signal) signal.onabort = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.busy[w]--;
        this.workers[w].postMessage({ op: "abort", id } satisfies WorkerRequest);
        fail(new Error("aborted"));
      };
      this.workers[w].postMessage({ op: "get", id, url, layer, cache, priority } satisfies WorkerRequest);
    });
  }

  /** Every tile of a pack (the top pack), decoded in one worker. */
  unpack(bytes: ArrayBuffer): Promise<PackedTile[]> {
    const id = this.nextId++, w = this.pick();
    this.busy[w]++;
    return new Promise((ok, fail) => {
      this.pending.set(id, { ok, fail, worker: w });
      this.workers[w].postMessage({ op: "unpack", id, bytes } satisfies WorkerRequest, [bytes]);
    });
  }
}
