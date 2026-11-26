// Land cover from ESA WorldCover 10 m 2021 v200 (CC BY 4.0): its 3° × 3° Cloud-Optimised GeoTIFFs on AWS, read by
// range requests, for fine tiles; for coarse ones a global raster baked from the COGs' overviews (tools/landcover.ts)
// and kept in R2.
import { inflate } from "./inflate.ts";
import { cogLevelFor, openCog, sampleCog, type Cog } from "./cog.ts";
import type { Upstream } from "./upstream.ts";
import type { LandCover } from "./terrain.ts";

export const WORLDCOVER = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map";

/** The file name of the 3° cell holding a point, e.g. N33E135 (its south-west corner). */
export function worldCoverCell(lat: number, lon: number): string {
  const la = Math.floor(lat / 3) * 3, lo = Math.floor(lon / 3) * 3;
  return `${la < 0 ? "S" : "N"}${String(Math.abs(la)).padStart(2, "0")}${lo < 0 ? "W" : "E"}${String(Math.abs(lo)).padStart(3, "0")}`;
}
export const worldCoverUrl = (cell: string) => `${WORLDCOVER}/ESA_WorldCover_10m_2021_v200_${cell}_Map.tif`;

// The global raster (R2): coarse (0.25°, one object) for z ≤ 3, fine (1/40°, 10° blocks) for z 4 … 7.
export const GLOBAL_PREFIX = "landcover/v1";
export const COARSE = { key: `${GLOBAL_PREFIX}/global-q4.bin.z`, perDeg: 4, w: 1440, h: 720 };
export const FINE = { perDeg: 40, block: 10 };
export const fineBlockKey = (lat0: number, lon0: number) => `${GLOBAL_PREFIX}/b40/${lat0}_${lon0}.bin.z`;

/** Degrees a pixel above which tiles read the global raster rather than the COGs (z ≤ 7 reads the raster). */
const COG_FROM = 360 / 2 ** 7 / 256 + 1e-9;

const inflated = new Map<string, Promise<Uint8Array | null>>();
function rasterObject(up: Upstream, key: string): Promise<Uint8Array | null> {
  let p = inflated.get(key);
  if (!p) {
    p = up.getObject(key).then((z) => (z ? inflate(z, "deflate") : null));
    inflated.set(key, p);
    if (inflated.size > 64) inflated.delete(inflated.keys().next().value!);
    p.catch(() => inflated.delete(key));
  }
  return p;
}

const cogs = new Map<string, Promise<Cog | null>>();
function cogOf(up: Upstream, cell: string) {
  let p = cogs.get(cell);
  if (!p) {
    p = openCog(up, worldCoverUrl(cell));
    cogs.set(cell, p);
    if (cogs.size > 256) cogs.delete(cogs.keys().next().value!);
    p.catch(() => cogs.delete(cell));
  }
  return p;
}

/** The share of bare land among the land cells within ±`r` cells (1/4°) of a point, from the coarse raster. */
export async function desertShare(up: Upstream, lats: Float64Array, lons: Float64Array, r = 3): Promise<Float32Array | null> {
  const g = await rasterObject(up, COARSE.key);
  if (!g) return null;
  const out = new Float32Array(lats.length);
  for (let k = 0; k < lats.length; k++) {
    const x = Math.floor((lons[k] + 180) * COARSE.perDeg), y = Math.floor((90 - lats[k]) * COARSE.perDeg);
    let land = 0, bare = 0;
    for (let dy = -r; dy <= r; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= COARSE.h) continue;
      for (let dx = -r; dx <= r; dx++) {
        const v = g[yy * COARSE.w + (((x + dx) % COARSE.w) + COARSE.w) % COARSE.w];
        if (v && v !== 80) { land++; if (v === 60) bare++; }
      }
    }
    out[k] = land ? bare / land : 0;
  }
  return out;
}

export class WorldCover implements LandCover {
  readonly src = ["worldcover"];
  constructor(private up: Upstream, private cells?: Set<string>) {}

  desertShare(lats: Float64Array, lons: Float64Array) { return desertShare(this.up, lats, lons); }

  async sample(lons: Float64Array, lats: Float64Array, degPerPixel: number, only?: Uint8Array): Promise<Uint8Array> {
    const out = new Uint8Array(lons.length);
    if (degPerPixel > COG_FROM) {
      await this.sampleGlobal(lons, lats, degPerPixel, out, only);
      return out;
    }
    const byCell = new Map<string, number[]>();
    for (let k = 0; k < lons.length; k++) {
      if (only && !only[k]) continue;
      const c = worldCoverCell(lats[k], lons[k]);
      if (this.cells && !this.cells.has(c)) continue;
      (byCell.get(c) ?? byCell.set(c, []).get(c)!).push(k);
    }
    await Promise.all(
      [...byCell].map(async ([cell, ks]) => {
        const cog = await cogOf(this.up, cell);
        if (!cog) return;
        const level = cogLevelFor(cog, degPerPixel);
        const lo = new Float64Array(ks.length), la = new Float64Array(ks.length), o = new Uint8Array(ks.length);
        ks.forEach((k, i) => { lo[i] = lons[k]; la[i] = lats[k]; });
        await sampleCog(this.up, cog, level, lo, la, o);
        ks.forEach((k, i) => (out[k] = o[i]));
      }),
    );
    return out;
  }

  private async sampleGlobal(lons: Float64Array, lats: Float64Array, degPerPixel: number, out: Uint8Array, only?: Uint8Array) {
    if (degPerPixel > 360 / 2 ** 4 / 256 + 1e-9) {
      const r = await rasterObject(this.up, COARSE.key);
      if (!r) return;
      for (let k = 0; k < lons.length; k++) {
        if (only && !only[k]) continue;
        const x = Math.min(COARSE.w - 1, Math.max(0, Math.floor((lons[k] + 180) * COARSE.perDeg)));
        const y = Math.min(COARSE.h - 1, Math.max(0, Math.floor((90 - lats[k]) * COARSE.perDeg)));
        out[k] = r[y * COARSE.w + x];
      }
      return;
    }
    const B = FINE.block, P = FINE.perDeg, S = B * P;
    const byBlock = new Map<string, number[]>();
    for (let k = 0; k < lons.length; k++) {
      if (only && !only[k]) continue;
      const lat0 = Math.floor(Math.min(89.999, lats[k]) / B) * B, lon0 = Math.floor(Math.min(179.999, lons[k]) / B) * B;
      const key = fineBlockKey(lat0, lon0);
      (byBlock.get(key) ?? byBlock.set(key, []).get(key)!).push(k);
    }
    await Promise.all(
      [...byBlock].map(async ([key, ks]) => {
        const r = await rasterObject(this.up, key);
        if (!r) return;
        for (const k of ks) {
          const lat0 = Math.floor(Math.min(89.999, lats[k]) / B) * B, lon0 = Math.floor(Math.min(179.999, lons[k]) / B) * B;
          const x = Math.min(S - 1, Math.floor((lons[k] - lon0) * P)), y = Math.min(S - 1, Math.floor((lat0 + B - lats[k]) * P));
          out[k] = r[y * S + x];
        }
      }),
    );
  }
}
