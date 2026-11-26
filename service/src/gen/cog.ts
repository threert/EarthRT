// A minimal Cloud-Optimised GeoTIFF reader: the IFDs (full resolution and overviews), tile offsets, deflate or
// uncompressed tiles of 8-bit single-band data, read by HTTP range requests. Enough for ESA WorldCover.
import { inflate } from "./inflate.ts";
import type { Upstream } from "./upstream.ts";

export interface CogLevel {
  width: number;
  height: number;
  tileW: number;
  tileH: number;
  offsets: number[];
  counts: number[];
  compression: number;
  predictor: number;
}

export interface Cog {
  url: string;
  levels: CogLevel[]; // 0 full resolution, then overviews (coarser)
  /** georeference of level 0: pixel (0, 0)'s top-left corner and pixel size, degrees */
  originX: number;
  originY: number;
  resX: number;
  resY: number;
}

const HEAD = 65536;

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };

/** Reads a COG's structure (one range request for its first 64 KiB, more if the IFDs reach further). */
export async function openCog(up: Upstream, url: string): Promise<Cog | null> {
  let head = await up.range(url, 0, HEAD);
  if (!head) return null;
  const read = async (off: number, len: number): Promise<DataView> => {
    if (off + len > head!.length) {
      const more = await up.range(url, off, len);
      if (!more) throw new Error(`COG read beyond file: ${url}`);
      return new DataView(more.buffer, more.byteOffset, more.byteLength);
    }
    return new DataView(head!.buffer, head!.byteOffset + off, len);
  };
  const dv0 = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const le = dv0.getUint16(0) === 0x4949;
  const magic = dv0.getUint16(2, le);
  if (magic !== 42) throw new Error(`not a classic TIFF (${magic}): ${url}`);
  let ifd = dv0.getUint32(4, le);
  const levels: CogLevel[] = [];
  let geo: { originX: number; originY: number; resX: number; resY: number } | null = null;
  while (ifd) {
    const cnt = (await read(ifd, 2)).getUint16(0, le);
    const ent = await read(ifd + 2, cnt * 12 + 4);
    const tags = new Map<number, number[]>();
    for (let i = 0; i < cnt; i++) {
      const tag = ent.getUint16(i * 12, le), type = ent.getUint16(i * 12 + 2, le), n = ent.getUint32(i * 12 + 4, le);
      const size = (TYPE_SIZE[type] ?? 1) * n;
      const vals: number[] = [];
      const src = size <= 4 ? new DataView(ent.buffer, ent.byteOffset + i * 12 + 8, 4) : await read(ent.getUint32(i * 12 + 8, le), size);
      // only the numeric tags we need are decoded; ASCII and others are skipped
      if (![256, 257, 258, 259, 277, 317, 322, 323, 324, 325, 254, 33550, 33922].includes(tag)) continue;
      for (let k = 0; k < n; k++) {
        if (type === 3) vals.push(src.getUint16(k * 2, le));
        else if (type === 4) vals.push(src.getUint32(k * 4, le));
        else if (type === 12) vals.push(src.getFloat64(k * 8, le));
        else if (type === 1) vals.push(src.getUint8(k));
        else if (type === 16) vals.push(Number(src.getBigUint64(k * 8, le)));
      }
      tags.set(tag, vals);
    }
    ifd = ent.getUint32(cnt * 12, le);
    const bits = tags.get(258)?.[0] ?? 8, spp = tags.get(277)?.[0] ?? 1;
    if (bits !== 8 || spp !== 1) throw new Error(`COG: only 8-bit single band (${bits} bits, ${spp} samples)`);
    if (!tags.has(322)) throw new Error("COG: not tiled");
    if ((tags.get(254)?.[0] ?? 0) & 4) continue; // a mask
    levels.push({
      width: tags.get(256)![0], height: tags.get(257)![0], tileW: tags.get(322)![0], tileH: tags.get(323)![0],
      offsets: tags.get(324)!, counts: tags.get(325)!, compression: tags.get(259)?.[0] ?? 1, predictor: tags.get(317)?.[0] ?? 1,
    });
    if (!geo && tags.has(33550) && tags.has(33922)) {
      const s = tags.get(33550)!, t = tags.get(33922)!;
      geo = { resX: s[0], resY: s[1], originX: t[3] - t[0] * s[0], originY: t[4] + t[1] * s[1] };
    }
  }
  if (!geo) throw new Error(`COG without georeference: ${url}`);
  return { url, levels, ...geo };
}

/** One tile of a level, decompressed (tileW × tileH bytes); null where the file has no data for it. */
export async function readCogTile(up: Upstream, cog: Cog, level: number, tx: number, ty: number): Promise<Uint8Array | null> {
  const L = cog.levels[level];
  const across = Math.ceil(L.width / L.tileW);
  const i = ty * across + tx;
  const off = L.offsets[i], len = L.counts[i];
  if (!len) return null;
  const raw = await up.range(cog.url, off, len);
  if (!raw) return null;
  let px: Uint8Array;
  if (L.compression === 1) px = raw;
  else if (L.compression === 8 || L.compression === 32946) px = await inflate(raw, "deflate");
  else throw new Error(`COG compression ${L.compression} not supported`);
  if (L.predictor === 2) for (let y = 0; y < L.tileH; y++) for (let x = 1; x < L.tileW; x++) px[y * L.tileW + x] += px[y * L.tileW + x - 1];
  return px;
}

/** The coarsest level whose pixels are no larger than `deg` degrees. */
export function cogLevelFor(cog: Cog, deg: number): number {
  let best = 0;
  for (let l = 0; l < cog.levels.length; l++) {
    const res = cog.resX * (cog.levels[0].width / cog.levels[l].width);
    if (res <= deg) best = l;
  }
  return best;
}

/**
 * Samples a level at many points (lon/lat in degrees). Points outside the file get `fill`. Reads each needed tile once.
 */
export async function sampleCog(up: Upstream, cog: Cog, level: number, lons: Float64Array, lats: Float64Array, out: Uint8Array, fill = 0, only?: Uint8Array) {
  const L = cog.levels[level];
  const f = cog.levels[0].width / L.width;
  const rx = cog.resX * f, ry = cog.resY * f;
  const across = Math.ceil(L.width / L.tileW);
  const need = new Map<number, number[]>();
  for (let k = 0; k < lons.length; k++) {
    if (only && !only[k]) continue;
    const px = Math.floor((lons[k] - cog.originX) / rx), py = Math.floor((cog.originY - lats[k]) / ry);
    if (px < 0 || py < 0 || px >= L.width || py >= L.height) continue;
    const t = Math.floor(py / L.tileH) * across + Math.floor(px / L.tileW);
    (need.get(t) ?? need.set(t, []).get(t)!).push(k);
  }
  await Promise.all(
    [...need].map(async ([t, ks]) => {
      const tx = t % across, ty = Math.floor(t / across);
      const tile = await readCogTile(up, cog, level, tx, ty);
      for (const k of ks) {
        if (!tile) { out[k] = fill; continue; }
        const px = Math.floor((lons[k] - cog.originX) / rx) - tx * L.tileW, py = Math.floor((cog.originY - lats[k]) / ry) - ty * L.tileH;
        out[k] = tile[py * L.tileW + px];
      }
    }),
  );
}
