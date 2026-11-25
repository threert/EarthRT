import { describe, expect, test } from "bun:test";
import Pbf from "pbf";
import { decodeErt, expandBuildings, expandTerrain, encodeTerrainCompact, gridNormals, latToTileY, lonToTileX, tileYToLat, type TileKey } from "@earthrt/core";
import { decodePng, encodePng } from "../src/gen/png.ts";
import { deflate } from "../src/gen/inflate.ts";
import { openCog, readCogTile, sampleCog, cogLevelFor } from "../src/gen/cog.ts";
import { makeTerrainTile, skirtFor } from "../src/gen/terrain.ts";
import { clipRing, buildingHeight, makeBuildingsTile, REGIONS, regionObject } from "../src/gen/buildings.ts";
import { worldCoverCell } from "../src/gen/landcover.ts";
import { albedo, snowLine, CLS } from "../src/gen/albedo.ts";
import type { Upstream } from "../src/gen/upstream.ts";

// ------------------------------------------------------------------------------------------------ fixtures

/** An Upstream over a map of URLs / object keys (no network). */
class FakeUpstream implements Upstream {
  calls: string[] = [];
  constructor(public files: Map<string, Uint8Array>) {}
  async get(url: string) { this.calls.push(url); return this.files.get(url) ?? null; }
  async range(url: string, start: number, length: number) { this.calls.push(`${url}#${start}`); const f = this.files.get(url); return f ? f.subarray(start, start + length) : null; }
  async getObject(key: string) { return this.files.get(key) ?? null; }
  async getObjectRange(key: string, start: number, length: number) { const f = this.files.get(key); return f ? f.subarray(start, start + length) : null; }
}

/** A PNG with a chosen filter on each row (encodePng writes filter 0 only). */
async function pngWithFilters(w: number, h: number, spp: number, px: Uint8Array, filters: number[]): Promise<Uint8Array> {
  const stride = w * spp, raw = new Uint8Array(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    const f = filters[y % filters.length];
    raw[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const x = px[y * stride + i];
      const a = i >= spp ? px[y * stride + i - spp] : 0, b = y ? px[(y - 1) * stride + i] : 0, c = y && i >= spp ? px[(y - 1) * stride + i - spp] : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      raw[y * (stride + 1) + 1 + i] = (x - pred) & 255;
    }
  }
  // borrow encodePng's chunk writer: encode a dummy, then swap its IDAT
  const z = await deflate(raw, "deflate");
  const base = await encodePng({ width: w, height: h, channels: spp, data: px });
  // rebuild: signature + IHDR (33 bytes) + new IDAT + IEND
  const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Uint8Array) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const idat = new Uint8Array(12 + z.length), dv = new DataView(idat.buffer);
  dv.setUint32(0, z.length); idat.set([73, 68, 65, 84], 4); idat.set(z, 8); dv.setUint32(8 + z.length, crc(idat.subarray(4, 8 + z.length)));
  const head = base.subarray(0, 33), iend = base.subarray(base.length - 12);
  const out = new Uint8Array(head.length + idat.length + iend.length);
  out.set(head); out.set(idat, head.length); out.set(iend, head.length + idat.length);
  return out;
}

/** Terrarium encoding of heights (m) as an RGB PNG. */
async function terrariumPng(heights: (x: number, y: number) => number): Promise<Uint8Array> {
  const px = new Uint8Array(256 * 256 * 3);
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const v = heights(x, y) + 32768, i = 3 * (y * 256 + x);
    px[i] = Math.floor(v / 256); px[i + 1] = Math.floor(v) % 256; px[i + 2] = Math.round((v - Math.floor(v)) * 256);
  }
  return pngWithFilters(256, 256, 3, px, [0, 1, 2, 3, 4]);
}

/** A tiled, deflated, 8-bit TIFF with one overview: a WorldCover-like COG of a 3° cell. */
async function makeCog(w: number, tile: number, value: (x: number, y: number) => number, origin: [number, number], res: number): Promise<Uint8Array> {
  const levels = [w, w / 2];
  const tiles: Uint8Array[][] = [];
  for (const lw of levels) {
    const across = Math.ceil(lw / tile), list: Uint8Array[] = [];
    for (let ty = 0; ty < across; ty++) for (let tx = 0; tx < across; tx++) {
      const px = new Uint8Array(tile * tile);
      for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) {
        const gx = tx * tile + x, gy = ty * tile + y, f = w / lw;
        px[y * tile + x] = gx < lw && gy < lw ? value(gx * f, gy * f) : 0;
      }
      list.push(await deflate(px, "deflate"));
    }
    tiles.push(list);
  }
  // layout: header, IFD0 (+ arrays), IFD1 (+ arrays), tile data
  const parts: number[] = [];
  const buf = new Uint8Array(1 << 20), dv = new DataView(buf.buffer);
  buf.set([0x49, 0x49, 42, 0]);
  let at = 8;
  const ifdAt: number[] = [];
  const dataStart = 4096;
  let dataAt = dataStart;
  const offsets: number[][] = tiles.map((l) => l.map((t) => { const o = dataAt; buf.set(t, o); dataAt += t.length; return o; }));
  dv.setUint32(4, at, true);
  for (let l = 0; l < levels.length; l++) {
    const lw = levels[l], n = tiles[l].length;
    const entries: [number, number, number, number[]][] = [
      [254, 4, 1, [l ? 1 : 0]], [256, 3, 1, [lw]], [257, 3, 1, [lw]], [258, 3, 1, [8]], [259, 3, 1, [8]], [277, 3, 1, [1]],
      [322, 3, 1, [tile]], [323, 3, 1, [tile]], [324, 4, n, offsets[l]], [325, 4, n, tiles[l].map((t) => t.length)],
    ];
    if (!l) entries.push([33550, 12, 3, [res, res, 0]], [33922, 12, 6, [0, 0, 0, origin[0], origin[1], 0]]);
    ifdAt.push(at);
    dv.setUint16(at, entries.length, true);
    let extra = at + 2 + entries.length * 12 + 4;
    entries.forEach(([tag, type, count, vals], i) => {
      const e = at + 2 + i * 12, size = (type === 3 ? 2 : type === 4 ? 4 : 8) * count;
      dv.setUint16(e, tag, true); dv.setUint16(e + 2, type, true); dv.setUint32(e + 4, count, true);
      const where = size <= 4 ? e + 8 : extra;
      if (size > 4) { dv.setUint32(e + 8, extra, true); extra += size; }
      vals.forEach((v, k) => (type === 3 ? dv.setUint16(where + 2 * k, v, true) : type === 4 ? dv.setUint32(where + 4 * k, v, true) : dv.setFloat64(where + 8 * k, v, true)));
    });
    const next = (extra + 1) & ~1;
    dv.setUint32(at + 2 + entries.length * 12, l + 1 < levels.length ? next : 0, true);
    at = next;
  }
  void parts;
  return buf.slice(0, dataAt);
}

// ------------------------------------------------------------------------------------------------ PNG

describe("png", () => {
  test("decodes every filter type, RGB and gray", async () => {
    for (const spp of [1, 3, 4]) {
      const w = 17, h = 11, px = new Uint8Array(w * h * spp);
      for (let i = 0; i < px.length; i++) px[i] = (i * 37 + (i >> 3) * 11) & 255;
      const png = await pngWithFilters(w, h, spp, px, [0, 1, 2, 3, 4]);
      const img = await decodePng(png);
      expect(img.width).toBe(w);
      expect(img.channels).toBe(spp);
      expect(Array.from(img.data)).toEqual(Array.from(px));
    }
  });
  test("encodePng round trip", async () => {
    const px = new Uint8Array(8 * 5 * 3).map((_, i) => i * 7);
    const img = await decodePng(await encodePng({ width: 8, height: 5, channels: 3, data: px }));
    expect(Array.from(img.data)).toEqual(Array.from(px));
  });
  test("refuses what is not a PNG", async () => {
    await expect(decodePng(new Uint8Array(64))).rejects.toThrow("not a PNG");
  });
});

// ------------------------------------------------------------------------------------------------ COG

describe("cog", () => {
  test("reads IFDs, overviews, georeference and samples by range", async () => {
    const w = 512, url = "https://x/test.tif";
    const cog = await makeCog(w, 128, (x, y) => (x < 256 ? 10 : 40) + (y < 256 ? 0 : 40), [135, 36], 3 / w);
    const up = new FakeUpstream(new Map([[url, cog]]));
    const c = (await openCog(up, url))!;
    expect(c.levels.length).toBe(2);
    expect(c.levels[0].width).toBe(512);
    expect(c.levels[1].width).toBe(256);
    expect(c.originX).toBe(135);
    expect(c.originY).toBe(36);
    expect(c.resX).toBeCloseTo(3 / 512, 12);
    const t = (await readCogTile(up, c, 0, 3, 0))!;
    expect(t[0]).toBe(40);
    expect(cogLevelFor(c, 3 / 512)).toBe(0);
    expect(cogLevelFor(c, 3 / 200)).toBe(1);
    const lons = new Float64Array([135.5, 137.5, 135.5, 137.5, 140]), lats = new Float64Array([35.5, 35.5, 33.5, 33.5, 35]);
    for (const level of [0, 1]) {
      const out = new Uint8Array(5).fill(255);
      await sampleCog(up, c, level, lons, lats, out, 0);
      expect(Array.from(out.subarray(0, 4))).toEqual([10, 40, 50, 80]);
      expect(out[4]).toBe(255); // outside: untouched
    }
  });
  test("WorldCover cell names", () => {
    expect(worldCoverCell(35.0, 135.77)).toBe("N33E135");
    expect(worldCoverCell(-1, -59)).toBe("S03W060");
    expect(worldCoverCell(51.5, -0.1)).toBe("N51W003");
  });
});

// ------------------------------------------------------------------------------------------------ terrain

describe("terrain", () => {
  const TER = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
  /** A world at zoom z where height is a function of the global pixel position. */
  async function world(z: number, keys: [number, number][], h: (gx: number, gy: number) => number) {
    const m = new Map<string, Uint8Array>();
    for (const [x, y] of keys) m.set(`${TER}/${z}/${x}/${y}.png`, await terrariumPng((px, py) => h(x * 256 + px, y * 256 + py)));
    return new FakeUpstream(m);
  }
  const around = (x: number, y: number) => { const k: [number, number][] = []; for (let dy = -1; dy <= 2; dy++) for (let dx = -1; dx <= 2; dx++) k.push([x + dx, y + dy]); return k; };

  test("neighbours' shared edges have the same heights and normals", async () => {
    const z = 10, x = 898, y = 404;
    const up = await world(z, around(x, y), (gx, gy) => 300 + 200 * Math.sin(gx / 37) * Math.cos(gy / 23) + (gx % 7));
    const a = expandTerrain(decodeErt(await makeTerrainTile(up, { z, x, y }, null)));
    const b = expandTerrain(decodeErt(await makeTerrainTile(up, { z, x: x + 1, y }, null)));
    const c = expandTerrain(decodeErt(await makeTerrainTile(up, { z, x, y: y + 1 }, null)));
    const n = 65;
    const ca = decodeErt(await makeTerrainTile(up, { z, x, y }, null));
    const quant = (ca.header.maxH! - ca.header.minH!) / 65535 + 1e-3;
    for (let i = 0; i < n; i++) {
      // east edge of a = west edge of b; south edge of a = north edge of c
      expect(Math.abs(a.heights[i * n + n - 1] - b.heights[i * n])).toBeLessThan(2 * quant + 0.01);
      expect(Math.abs(a.heights[(n - 1) * n + i] - c.heights[i])).toBeLessThan(2 * quant + 0.01);
      for (let k = 0; k < 3; k++) {
        expect(Math.abs(a.normals[3 * (i * n + n - 1) + k] - b.normals[3 * (i * n) + k])).toBeLessThan(0.02);
        expect(Math.abs(a.normals[3 * ((n - 1) * n + i) + k] - c.normals[3 * i + k])).toBeLessThan(0.02);
      }
    }
  });

  test("a vertex is the mean of the 4 × 4 pixels about it; the sea is water at 0 m", async () => {
    const z = 6, x = 10, y = 30;
    // the west half land at 100 m, the east half sea at −500 m
    const up = await world(z, around(x, y), (gx) => (gx < x * 256 + 128 ? 100 : -500));
    const t = decodeErt(await makeTerrainTile(up, { z, x, y }, null));
    const m = expandTerrain(t);
    const water = t.chunks.water as Uint8Array, cls = t.chunks.cls as Uint8Array, rgb = t.chunks.rgb as Uint8Array;
    expect(m.heights[10 * 65 + 5]).toBeCloseTo(100, 1);
    expect(m.heights[10 * 65 + 60]).toBeCloseTo(0, 1);
    // the shore vertex (pixel 128 is its corner): half land, half water
    expect(m.heights[10 * 65 + 32]).toBeCloseTo(50, 1);
    expect(water[10 * 65 + 32]).toBe(128);
    expect(water[10 * 65 + 60]).toBe(255);
    expect(cls[10 * 65 + 60]).toBe(CLS.water);
    // deep sea is dark blue
    expect(rgb[3 * (10 * 65 + 60) + 2]).toBeGreaterThan(rgb[3 * (10 * 65 + 60)]);
    expect(t.header.skirt).toBe(skirtFor({ z, x, y }));
    expect(t.header.src).toEqual(["terrarium"]);
  });

  test("the antimeridian wraps and the poles clamp", async () => {
    const z = 2;
    const keys: [number, number][] = [];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) keys.push([x, y]);
    const up = await world(z, keys, (gx, gy) => (gx + gy) % 300);
    const west = await makeTerrainTile(up, { z, x: 0, y: 0 }, null);
    expect(decodeErt(west).header.key).toBe("2/0/0");
    expect(up.calls.some((c) => c.endsWith("/2/3/0.png"))).toBe(true); // west of x 0 is x 3
    expect(up.calls.some((c) => c.includes("/2/0/-1") || c.includes("/2/0/4"))).toBe(false);
  });

  test("caps: the south one rises to the pole's ice, the north one is sea ice", async () => {
    const keys: [number, number][] = [];
    for (let x = 0; x < 8; x++) keys.push([x, 0], [x, 7]);
    const up = await world(3, keys, (_gx, gy) => (gy < 1024 ? -3000 : 1500));
    const s = decodeErt(await makeTerrainTile(up, { cap: "s" }, null));
    const ms = expandTerrain(s);
    expect(ms.heights[64 * 65]).toBeCloseTo(2835, 0);
    expect(ms.heights[0]).toBeCloseTo(1500, 0);
    const nn = decodeErt(await makeTerrainTile(up, { cap: "n" }, null));
    expect((nn.chunks.cls as Uint8Array)[100]).toBe(CLS.snow);
    // normals point up (away from the Earth's centre) on both
    for (const t of [ms, expandTerrain(nn)]) {
      const c = t.center, v = 40 * 65 + 20;
      const px = t.positions[3 * v] + c[0], py = t.positions[3 * v + 1] + c[1], pz = t.positions[3 * v + 2] + c[2];
      expect(px * t.normals[3 * v] + py * t.normals[3 * v + 1] + pz * t.normals[3 * v + 2]).toBeGreaterThan(0);
    }
  });
});

describe("albedo", () => {
  test("snow line falls toward the poles", () => {
    expect(snowLine(0)).toBeGreaterThan(snowLine(40));
    expect(snowLine(40)).toBeGreaterThan(snowLine(65));
  });
  test("forest dark green, desert sand, snow white, deep sea dark blue", () => {
    const o = new Uint8Array(3);
    albedo(CLS.tree, 50, 10, 300, 0, 0, 0, o, 0);
    expect(o[1]).toBeGreaterThan(o[0]); expect(o[1]).toBeLessThan(90);
    albedo(CLS.bare, 23, 10, 400, 0, 0, 0, o, 0);
    expect(o[0]).toBeGreaterThan(150); expect(o[0]).toBeGreaterThan(o[2]);
    albedo(CLS.grass, 30, 86, 7000, 0.05, 0, 0, o, 0);
    expect(Math.min(o[0], o[1], o[2])).toBeGreaterThan(220);
    albedo(CLS.water, 0, -150, 0, 0, 1, 4000, o, 0);
    expect(o[2]).toBeGreaterThan(o[0]); expect(o[2]).toBeLessThan(80);
  });
});

// ------------------------------------------------------------------------------------------------ buildings

/** A minimal MVT writer: one `buildings` layer of polygons in tile units. */
function mvt(features: { rings: [number, number][][]; props: Record<string, string | number> }[], extent = 4096): Uint8Array {
  const keys: string[] = [], values: (string | number)[] = [];
  const kidx = (k: string) => { let i = keys.indexOf(k); if (i < 0) { keys.push(k); i = keys.length - 1; } return i; };
  const vidx = (v: string | number) => { let i = values.indexOf(v); if (i < 0) { values.push(v); i = values.length - 1; } return i; };
  const zz = (n: number) => (n << 1) ^ (n >> 31);
  const pbf = new Pbf();
  pbf.writeMessage(3, (_: unknown, p: Pbf) => {
    p.writeVarintField(15, 2);
    p.writeStringField(1, "buildings");
    for (const f of features) {
      p.writeMessage(2, (_: unknown, q: Pbf) => {
        const tags: number[] = [];
        for (const [k, v] of Object.entries(f.props)) tags.push(kidx(k), vidx(v));
        q.writePackedVarint(2, tags);
        q.writeVarintField(3, 3);
        const g: number[] = [];
        let cx = 0, cy = 0;
        for (const ring of f.rings) {
          g.push((1 & 7) | (1 << 3), zz(ring[0][0] - cx), zz(ring[0][1] - cy));
          cx = ring[0][0]; cy = ring[0][1];
          g.push((2 & 7) | ((ring.length - 1) << 3));
          for (const [x, y] of ring.slice(1)) { g.push(zz(x - cx), zz(y - cy)); cx = x; cy = y; }
          g.push(7 | (1 << 3));
        }
        q.writePackedVarint(4, g);
      }, null);
    }
    for (const k of keys) p.writeStringField(3, k);
    for (const v of values) p.writeMessage(4, (_: unknown, q: Pbf) => (typeof v === "string" ? q.writeStringField(1, v) : Number.isInteger(v) ? q.writeVarintField(4, v) : q.writeDoubleField(3, v)), null);
    p.writeVarintField(5, extent);
  }, null);
  return pbf.finish();
}

/** A PMTiles v3 archive (uncompressed tiles, one root directory) holding the given z/x/y tiles. */
function pmtiles(tiles: { z: number; x: number; y: number; data: Uint8Array }[]): Uint8Array {
  const zxyToId = (z: number, x: number, y: number) => {
    let acc = 0;
    for (let t = 0; t < z; t++) acc += 4 ** t;
    // Hilbert d of (x, y) at order z
    let d = 0, rx: number, ry: number, xx = x, yy = y;
    for (let s = 2 ** (z - 1); s > 0; s = Math.floor(s / 2)) {
      rx = (xx & s) > 0 ? 1 : 0; ry = (yy & s) > 0 ? 1 : 0;
      d += s * s * ((3 * rx) ^ ry);
      if (ry === 0) { if (rx === 1) { xx = s - 1 - xx; yy = s - 1 - yy; } [xx, yy] = [yy, xx]; }
    }
    return acc + d;
  };
  const entries = tiles.map((t) => ({ id: zxyToId(t.z, t.x, t.y), data: t.data })).sort((a, b) => a.id - b.id);
  const dataParts: Uint8Array[] = [];
  let off = 0;
  const dir: { id: number; off: number; len: number }[] = [];
  for (const e of entries) { dir.push({ id: e.id, off, len: e.data.length }); dataParts.push(e.data); off += e.data.length; }
  const v: number[] = [];
  const varint = (n: number) => { while (n >= 128) { v.push((n & 127) | 128); n = Math.floor(n / 128); } v.push(n); };
  varint(dir.length);
  let last = 0;
  for (const d of dir) { varint(d.id - last); last = d.id; }
  for (const _ of dir) varint(1);
  for (const d of dir) varint(d.len);
  dir.forEach((d, i) => varint(i > 0 && d.off === dir[i - 1].off + dir[i - 1].len ? 0 : d.off + 1));
  const root = new Uint8Array(v);
  const meta = new TextEncoder().encode("{}");
  const H = 127, rootAt = H, metaAt = rootAt + root.length, dataAt = metaAt + meta.length;
  const out = new Uint8Array(dataAt + off);
  const dv = new DataView(out.buffer);
  out.set(new TextEncoder().encode("PMTiles"), 0);
  out[7] = 3;
  const u64 = (at: number, n: number) => dv.setBigUint64(at, BigInt(n), true);
  u64(8, rootAt); u64(16, root.length); u64(24, metaAt); u64(32, meta.length); u64(40, 0); u64(48, 0);
  u64(56, dataAt); u64(64, off); u64(72, dir.length); u64(80, dir.length); u64(88, dir.length);
  out[96] = 1; out[97] = 1; out[98] = 1; out[99] = 1; out[100] = 0; out[101] = 15;
  out.set(root, rootAt); out.set(meta, metaAt);
  let at = dataAt;
  for (const p of dataParts) { out.set(p, at); at += p.length; }
  return out;
}

describe("buildings", () => {
  test("clipRing keeps the inside of a tile", () => {
    const r = clipRing([{ x: -10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 40 }, { x: -10, y: 40 }], 4096);
    expect(r.every((p) => p.x >= 0)).toBe(true);
    expect(r.length).toBe(4);
    expect(clipRing([{ x: -10, y: -10 }, { x: -5, y: -10 }, { x: -5, y: -5 }], 4096)).toEqual([]);
  });
  test("heights from tags, levels, or a default by kind", () => {
    expect(buildingHeight({ height: 42 }, 0, 100, 0.5).height).toBe(42);
    expect(buildingHeight({ "building:levels": 10 }, 0, 100, 0.5).height).toBeCloseTo(33, 5);
    const house = buildingHeight({}, 1, 80, 0.5).height;
    expect(house).toBeGreaterThan(5); expect(house).toBeLessThan(10);
    expect(buildingHeight({ height: 30, min_height: 10 }, 0, 100, 0.5).minHeight).toBe(10);
  });
  test("MVT in a PMTiles extract → a compact tile on the terrain, pieces clipped at z15 edges", async () => {
    const r = REGIONS.find((g) => g.key === "kansai")!;
    // Kyoto station's z14 tile and its four z15 children
    const lat = 34.985, lon = 135.758;
    const z = 14, x = Math.floor(lonToTileX(lon, z)), y = Math.floor(latToTileY(lat, z));
    const subs = [[2 * x, 2 * y], [2 * x + 1, 2 * y], [2 * x, 2 * y + 1], [2 * x + 1, 2 * y + 1]];
    const files = subs.map(([sx, sy], i) => ({
      z: 15, x: sx, y: sy,
      data: mvt([
        { rings: [[[100, 100], [300, 100], [300, 300], [100, 300], [100, 100]]], props: { height: 20 + i, kind: "building" } },
        // crosses the tile's east edge (the buffer): clipped to the tile
        { rings: [[[4000, 2000], [4200, 2000], [4200, 2200], [4000, 2200], [4000, 2000]]], props: { kind: "building", kind_detail: "house" } },
        // a courtyard
        { rings: [[[1000, 1000], [1600, 1000], [1600, 1600], [1000, 1600], [1000, 1000]], [[1200, 1200], [1200, 1400], [1400, 1400], [1400, 1200], [1200, 1200]]], props: { height: 12 } },
      ]),
    }));
    const up = new FakeUpstream(new Map([[regionObject(r), pmtiles(files)]]));
    // flat terrain at 30 m for the tile
    const n = 65, heights = new Float32Array(n * n).fill(30), normals = new Float32Array(3 * n * n);
    const terrain = async (k: TileKey) => encodeTerrainCompact({ key: k, n, heights, cls: new Uint8Array(n * n), rgb: new Uint8Array(3 * n * n), water: new Uint8Array(n * n), normals, skirt: 10, src: [] });
    void gridNormals;
    const bytes = await makeBuildingsTile(up, { z, x, y }, terrain);
    expect(bytes).not.toBeNull();
    const e = decodeErt(bytes!);
    expect(e.header.count).toBe(12);
    const hgt = e.chunks.hgt as Uint16Array, base = e.chunks.base as Float32Array, rb = e.chunks.rb as Uint32Array, xy = e.chunks.xy as Int16Array, rn = e.chunks.rn as Uint32Array;
    expect(Array.from(base).every((b) => Math.abs(b - 30) < 0.01)).toBe(true);
    expect([200, 210, 220, 230].every((h) => Array.from(hgt).includes(h))).toBe(true);
    // the courtyard building has two rings
    expect(Array.from(rb).some((v, i) => i < e.header.count! && rb[i + 1] - v === 2)).toBe(true);
    // clipped: no vertex further than the tile's half width (+ a metre) from its centre
    const half = (40075016.7 / 2 ** 14) * Math.cos((tileYToLat(y + 0.5, 14) * Math.PI) / 180) / 2;
    for (let i = 0; i < xy.length; i++) expect(Math.abs(xy[i] / 8)).toBeLessThan(half * 1.01 + 1);
    expect(rn.length).toBe(rb[e.header.count!]);
    const mesh = expandBuildings(e);
    expect(mesh.index.length).toBeGreaterThan(0);
    // outside every region: null (204)
    expect(await makeBuildingsTile(up, { z: 14, x: 0, y: 0 }, terrain)).toBeNull();
  });
});
