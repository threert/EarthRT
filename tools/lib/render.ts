// Quick previews of compact terrain tiles to judge colours by eye: top-down (albedo × sun), and a globe from orbit.
import { decodeErt, octDecode, srgbToLinear, gridLatLon, latToTileY, lonToTileX, MAX_LAT, enu, type Ert, type TileKey, type V3 } from "../../packages/core/src/index.ts";

const toSrgb = (l: number) => {
  const c = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
};

export interface TileView {
  key: TileKey;
  n: number;
  rgb: Float32Array; // linear, 3n²
  nrm: Float32Array; // 3n²
  water: Float32Array; // n²
  h: Float32Array;
}

export function view(bytes: Uint8Array, key: TileKey): TileView {
  const e: Ert = decodeErt(bytes);
  const n = e.header.n!, nn = n * n;
  const rgb = new Float32Array(3 * nn), nrm = new Float32Array(3 * nn), water = new Float32Array(nn), h = new Float32Array(nn);
  const c = e.chunks.rgb as Uint8Array, o = e.chunks.nrm as Int8Array, w = e.chunks.water as Uint8Array, hh = e.chunks.h as Uint16Array;
  for (let i = 0; i < nn; i++) {
    rgb[3 * i] = srgbToLinear(c[3 * i]); rgb[3 * i + 1] = srgbToLinear(c[3 * i + 1]); rgb[3 * i + 2] = srgbToLinear(c[3 * i + 2]);
    octDecode(o[2 * i], o[2 * i + 1], nrm, 3 * i);
    water[i] = w[i] / 255;
    h[i] = e.header.minH! + (hh[i] / 65535) * (e.header.maxH! - e.header.minH!);
  }
  return { key, n, rgb, nrm, water, h };
}

/** Bilinear sample at grid coordinates (fi row, fj column). */
function sample(t: TileView, fi: number, fj: number, out: Float32Array) {
  const n = t.n;
  fi = Math.max(0, Math.min(n - 1.0001, fi)); fj = Math.max(0, Math.min(n - 1.0001, fj));
  const i0 = Math.floor(fi), j0 = Math.floor(fj), a = fi - i0, b = fj - j0;
  const w00 = (1 - a) * (1 - b), w01 = (1 - a) * b, w10 = a * (1 - b), w11 = a * b;
  const v00 = i0 * n + j0, v01 = v00 + 1, v10 = v00 + n, v11 = v10 + 1;
  for (let k = 0; k < 3; k++) {
    out[k] = t.rgb[3 * v00 + k] * w00 + t.rgb[3 * v01 + k] * w01 + t.rgb[3 * v10 + k] * w10 + t.rgb[3 * v11 + k] * w11;
    out[3 + k] = t.nrm[3 * v00 + k] * w00 + t.nrm[3 * v01 + k] * w01 + t.nrm[3 * v10 + k] * w10 + t.nrm[3 * v11 + k] * w11;
  }
  out[6] = t.water[v00] * w00 + t.water[v01] * w01 + t.water[v10] * w10 + t.water[v11] * w11;
}

/** Linear colour of a surface point lit by the sun (a hemisphere sky for fill, a little sky glint on water). */
function shade(s: Float32Array, sun: V3, up: V3, view: V3 | null, out: number[]) {
  const l = Math.hypot(s[3], s[4], s[5]) || 1;
  const nx = s[3] / l, ny = s[4] / l, nz = s[5] / l;
  const ndl = Math.max(0, nx * sun[0] + ny * sun[1] + nz * sun[2]);
  const sky = 0.5 + 0.5 * (nx * up[0] + ny * up[1] + nz * up[2]);
  const day = Math.max(0, Math.min(1, (up[0] * sun[0] + up[1] * sun[1] + up[2] * sun[2]) * 4 + 0.3));
  const E = 2.6 * ndl + 0.35 * sky * day + 0.02;
  for (let k = 0; k < 3; k++) out[k] = s[k] * E;
  if (s[6] > 0 && view) {
    // the sun's glint on water
    const hx = sun[0] + view[0], hy = sun[1] + view[1], hz = sun[2] + view[2], hl = Math.hypot(hx, hy, hz) || 1;
    const spec = Math.pow(Math.max(0, (nx * hx + ny * hy + nz * hz) / hl), 400) * 6 * s[6];
    out[0] += spec; out[1] += spec; out[2] += spec * 0.95;
  }
}

/** Top-down picture of one tile (north up), sun from the north-west, 45° high. */
export function topDown(t: TileView, size = 512): { width: number; height: number; channels: number; data: Uint8Array } {
  const { lats, lons } = gridLatLon(t.key, t.n);
  const lat = lats[(t.n - 1) >> 1], lon = lons[(t.n - 1) >> 1];
  const { e, n, u } = enu(lat, lon);
  // from the north-west, 45° above the horizon
  const sun: V3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) sun[i] = -e[i] * 0.5 + n[i] * 0.5 + u[i] * Math.SQRT1_2;
  const data = new Uint8Array(size * size * 3), s = new Float32Array(7), c = [0, 0, 0];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    sample(t, (y / (size - 1)) * (t.n - 1), (x / (size - 1)) * (t.n - 1), s);
    shade(s, sun, u, u, c);
    const p = 3 * (y * size + x);
    data[p] = toSrgb(c[0] * 0.45); data[p + 1] = toSrgb(c[1] * 0.45); data[p + 2] = toSrgb(c[2] * 0.45);
  }
  return { width: size, height: size, channels: 3, data };
}

/**
 * The globe from orbit (orthographic), centred on lat0/lon0, lit by a sun at sunLat/sunLon. `tiles` holds the z tiles
 * (all 4^z) and the caps. Pixels off the Earth are black space with a thin blue limb.
 */
export function globe(tiles: Map<string, TileView>, z: number, lat0: number, lon0: number, size: number, sunLat: number, sunLon: number) {
  const data = new Uint8Array(size * size * 3);
  const { e, n, u } = enu(lat0, lon0);
  const sunU = enu(sunLat, sunLon).u;
  const s = new Float32Array(7), c = [0, 0, 0];
  const R = size * 0.46;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = (x - size / 2) / R, py = -(y - size / 2) / R, r2 = px * px + py * py;
    const p = 3 * (y * size + x);
    if (r2 > 1) {
      const glow = Math.max(0, 1 - (Math.sqrt(r2) - 1) * 30) * 0.5;
      data[p] = toSrgb(0.05 * glow); data[p + 1] = toSrgb(0.12 * glow); data[p + 2] = toSrgb(0.35 * glow);
      continue;
    }
    const pz = Math.sqrt(1 - r2);
    // the point on the unit sphere, ECEF axes
    const d: V3 = [e[0] * px + n[0] * py + u[0] * pz, e[1] * px + n[1] * py + u[1] * pz, e[2] * px + n[2] * py + u[2] * pz];
    const lat = (Math.asin(Math.max(-1, Math.min(1, d[2]))) * 180) / Math.PI, lon = (Math.atan2(d[1], d[0]) * 180) / Math.PI;
    let t: TileView | undefined, fi = 0, fj = 0;
    if (Math.abs(lat) > MAX_LAT) {
      t = tiles.get(lat > 0 ? "cap/n" : "cap/s");
      if (t) { fi = ((Math.abs(lat) - MAX_LAT) / (90 - MAX_LAT)) * (t.n - 1); fj = ((lon + 180) / 360) * (t.n - 1); }
    } else {
      const tx = lonToTileX(lon, z), ty = latToTileY(lat, z);
      const kx = Math.min(2 ** z - 1, Math.floor(tx)), ky = Math.min(2 ** z - 1, Math.floor(ty));
      t = tiles.get(`${z}/${kx}/${ky}`);
      if (t) { fi = (ty - ky) * (t.n - 1); fj = (tx - kx) * (t.n - 1); }
    }
    if (!t) { data[p] = 255; data[p + 1] = 0; data[p + 2] = 255; continue; }
    sample(t, fi, fj, s);
    shade(s, sunU, d, u, c);
    // a thin haze toward the limb
    const haze = Math.pow(1 - pz, 3) * 0.6;
    const dayside = Math.max(0, d[0] * sunU[0] + d[1] * sunU[1] + d[2] * sunU[2]);
    const hz = [0.12 * dayside, 0.22 * dayside, 0.5 * dayside];
    data[p] = toSrgb((c[0] * (1 - haze) + hz[0] * haze) * 0.45);
    data[p + 1] = toSrgb((c[1] * (1 - haze) + hz[1] * haze) * 0.45);
    data[p + 2] = toSrgb((c[2] * (1 - haze) + hz[2] * haze) * 0.45);
  }
  return { width: size, height: size, channels: 3, data };
}

/** Pictures side by side in a grid, with a gap. */
export function contactSheet(images: { width: number; height: number; data: Uint8Array }[], cols: number, gap = 6) {
  const w = images[0].width, h = images[0].height, rows = Math.ceil(images.length / cols);
  const W = cols * w + (cols + 1) * gap, H = rows * h + (rows + 1) * gap;
  const data = new Uint8Array(W * H * 3).fill(20);
  images.forEach((im, k) => {
    const ox = gap + (k % cols) * (w + gap), oy = gap + Math.floor(k / cols) * (h + gap);
    for (let y = 0; y < h; y++) data.set(im.data.subarray(y * w * 3, (y + 1) * w * 3), ((oy + y) * W + ox) * 3);
  });
  return { width: W, height: H, channels: 3, data };
}
