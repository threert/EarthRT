// The generator's Upstream for Bun tools: fetch (through HTTPS_PROXY when set) with a disk cache under out/cache,
// and a directory standing in for R2 (out/r2), or the real bucket through wrangler with --remote.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { Upstream } from "../../service/src/gen/upstream.ts";

/** GET through curl (Bun's fetch through the local proxy drops connections): status and body. */
export async function curl(url: string, range?: [number, number], headers: Record<string, string> = {}): Promise<{ status: number; body: Uint8Array }> {
  for (let attempt = 0; ; attempt++) {
    const args = ["curl", "-sS", "-L", "--max-time", "120", "-o", "-", "-w", "\n%{http_code}"];
    if (range) args.push("-r", `${range[0]}-${range[0] + range[1] - 1}`);
    for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
    args.push(url);
    const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const out = new Uint8Array(await new Response(p.stdout).arrayBuffer());
    await p.exited;
    let nl = out.length - 1;
    while (nl >= 0 && out[nl] !== 10) nl--;
    const status = Number(new TextDecoder().decode(out.subarray(nl + 1)));
    if ((status >= 500 || status === 0 || p.exitCode) && attempt < 4) { await Bun.sleep(500 * (attempt + 1)); continue; }
    return { status, body: out.subarray(0, Math.max(0, nl)) };
  }
}

const ROOT = join(import.meta.dir, "../../out");

export class BunUpstream implements Upstream {
  constructor(private cacheDir = join(ROOT, "cache"), private objectDir = join(ROOT, "r2")) {}
  private path(key: string) {
    const h = createHash("sha1").update(key).digest("hex");
    return join(this.cacheDir, h.slice(0, 2), h);
  }
  private async cached(key: string, make: () => Promise<Uint8Array | null>) {
    const p = this.path(key);
    if (existsSync(p)) {
      const b = readFileSync(p);
      return b.length === 1 && b[0] === 0 ? null : new Uint8Array(b);
    }
    const v = await make();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, v ?? new Uint8Array([0]));
    return v;
  }
  get(url: string) {
    return this.cached(url, async () => {
      const r = await curl(url);
      if (r.status === 404 || r.status === 403) return null;
      if (r.status !== 200) throw new Error(`${r.status} ${url}`);
      return r.body;
    });
  }
  range(url: string, start: number, length: number) {
    return this.cached(`${url}#${start}+${length}`, async () => {
      const r = await curl(url, [start, length]);
      if (r.status === 404 || r.status === 403) return null;
      if (r.status === 416) return new Uint8Array(0);
      if (r.status !== 200 && r.status !== 206) throw new Error(`${r.status} ${url}`);
      return r.status === 200 ? r.body.subarray(start, start + length) : r.body;
    });
  }
  async getObject(key: string) {
    const p = join(this.objectDir, key);
    return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
  }
  async getObjectRange(key: string, start: number, length: number) {
    const p = join(this.objectDir, key);
    if (!existsSync(p)) return null;
    const f = Bun.file(p);
    return new Uint8Array(await f.slice(start, start + length).arrayBuffer());
  }
  async putObject(key: string, bytes: Uint8Array) {
    const p = join(this.objectDir, key);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, bytes);
  }
}
