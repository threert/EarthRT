// Budgets: what the GPU may hold (an LRU by bytes that never drops what the view uses) and how much arrives a frame.

export interface Resident {
  key: string;
  bytes: number;
  /** Frame number it was last touched by a view (shown, an ancestor of a shown tile, or wanted by a look-ahead). */
  lastUsed: number;
}

/**
 * Which residents to drop to fit `budget` bytes: least recently used first, never one used in `frame` (the current
 * view's) nor one in `keep`. Returns the keys to drop (it may not reach the budget if everything is in use).
 */
export function evictions(residents: Iterable<Resident>, total: number, budget: number, frame: number, keep?: (key: string) => boolean): string[] {
  if (total <= budget) return [];
  const old = [...residents].filter((r) => r.lastUsed < frame && !keep?.(r.key)).sort((a, b) => a.lastUsed - b.lastUsed || b.bytes - a.bytes);
  const out: string[] = [];
  for (const r of old) {
    if (total <= budget) break;
    out.push(r.key);
    total -= r.bytes;
  }
  return out;
}

/**
 * How many of a queue to upload this frame: at least one (so the queue always moves), then while the bytes stay within
 * `bytesPerFrame` and the time within `msPerFrame`.
 */
export class UploadBudget {
  constructor(public bytesPerFrame = 6 << 20, public msPerFrame = 4) {}

  take<T extends { bytes: number }>(queue: T[], upload: (t: T) => void, now: () => number = () => performance.now()): number {
    const t0 = now();
    let bytes = 0, n = 0;
    while (queue.length) {
      const next = queue[0];
      if (n > 0 && (bytes + next.bytes > this.bytesPerFrame || now() - t0 > this.msPerFrame)) break;
      queue.shift();
      upload(next);
      bytes += next.bytes;
      n++;
    }
    return n;
  }
}

/** A GPU byte budget for this device: a share of what the browser says about memory, within fixed bounds. */
export function gpuBudgetFor(deviceMemoryGB: number | undefined, mobile: boolean): number {
  const mb = mobile ? 160 : 384;
  const scaled = deviceMemoryGB ? Math.min(512, Math.max(128, deviceMemoryGB * 48)) : mb;
  return Math.round(Math.min(mb * 1.5, scaled)) << 20;
}
