// A stand-in for the service while it is not up: compact terrain tiles made in the worker from the public AWS
// Terrain Tiles (Terrarium PNGs, the service's own height source) with core's encodeTerrainCompact, so everything
// after the bytes is the real path. Land classes and colours are guessed from height, latitude and slope (the
// service has ESA WorldCover); good enough to look at, not data.
import { encodeTerrainCompact, gridLatLon, gridNormals, GRID, isCap, type TileKey } from "@earthrt/core";

export const TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
export const DEV_META = {
  v: 1,
  gen: "dev",
  terrain: { maxZoom: 14, n: GRID, skirt: 0 },
  buildings: { zoom: 14, regions: [] as { name: string; bbox: number[] }[] },
  attribution: ["Terrain: AWS Terrain Tiles (Mapzen: SRTM, GMTED2010, ETOPO1) — dev source, land cover guessed"],
};

/** Skirt depth for a level: deep enough to hide cracks between a tile and a coarser neighbour. */
export const skirtFor = (z: number) => Math.max(30, 40_000 / 2 ** Math.min(z, 14) * 1.2);

function hash(x: number, y: number) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x: number, y: number) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

const PALETTE: Record<number, [number, number, number]> = {
  1: [40, 62, 32], 2: [104, 98, 66], 3: [92, 110, 56], 4: [128, 124, 76], 5: [128, 124, 118], 6: [158, 142, 116],
  7: [236, 240, 245], 8: [18, 42, 66], 9: [62, 82, 60],
};

/**
 * A compact tile from a decoded Terrarium image (RGBA, `size`²) of the same z/x/y, or none (caps, missing tiles:
 * flat ocean or ice).
 */
export function devTerrainTile(key: TileKey, rgba: Uint8ClampedArray | Uint8Array | null, size = 256): Uint8Array {
  const n = GRID, nb = n + 2;
  const { lats, lons } = gridLatLon(key, n);
  const z = isCap(key) ? 0 : key.z;
  // bordered heights: one vertex beyond each edge, sampled from the same image (clamped)
  const bordered = new Float32Array(nb * nb);
  const raw = new Float32Array(nb * nb);
  const sample = (u: number, v: number) => {
    if (!rgba) return isCap(key) ? (key.cap === "s" ? 2800 : -3000) : -4000;
    const x = Math.min(size - 1, Math.max(0, u * size - 0.5)), y = Math.min(size - 1, Math.max(0, v * size - 0.5));
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(size - 1, x0 + 1), y1 = Math.min(size - 1, y0 + 1);
    const tx = x - x0, ty = y - y0;
    const h = (px: number, py: number) => {
      const i = 4 * (py * size + px);
      return rgba[i] * 256 + rgba[i + 1] + rgba[i + 2] / 256 - 32768;
    };
    return (h(x0, y0) * (1 - tx) + h(x1, y0) * tx) * (1 - ty) + (h(x0, y1) * (1 - tx) + h(x1, y1) * tx) * ty;
  };
  for (let i = -1; i <= n; i++) {
    for (let j = -1; j <= n; j++) {
      const h = sample(j / (n - 1), i / (n - 1));
      raw[(i + 1) * nb + (j + 1)] = h;
      bordered[(i + 1) * nb + (j + 1)] = Math.max(0, h);
    }
  }
  const normals = gridNormals(key, n, bordered);
  const nn = n * n;
  const heights = new Float32Array(nn), cls = new Uint8Array(nn), rgb = new Uint8Array(3 * nn), water = new Uint8Array(nn);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const v = i * n + j, h = raw[(i + 1) * nb + (j + 1)];
      const lat = lats[i], lon = lons[j], al = Math.abs(lat);
      const nz = normals[3 * v] * Math.cos((lat * Math.PI) / 180) * Math.cos((lon * Math.PI) / 180)
        + normals[3 * v + 1] * Math.cos((lat * Math.PI) / 180) * Math.sin((lon * Math.PI) / 180)
        + normals[3 * v + 2] * Math.sin((lat * Math.PI) / 180);
      const slope = Math.acos(Math.min(1, Math.max(-1, nz)));
      const isWater = isCap(key) ? key.cap === "n" : h <= 0.5;
      let c: number;
      if (isWater) c = 8;
      else {
        const snowline = Math.max(300, 5800 - 95 * Math.max(0, al - 22));
        const nv = vnoise(lon * 0.7, lat * 0.7) * 0.65 + vnoise(lon * 5, lat * 5) * 0.35;
        if (h > snowline + (nv - 0.5) * 500 || al > 70 && h > 300 || isCap(key)) c = slope > 0.9 ? 6 : 7;
        else if (slope > 0.75 || h > snowline - 500) c = 6;
        else if (al > 15 && al < 32 && nv < 0.45 && h < 1500) c = 6;
        else if (h < 250 && slope < 0.05) c = nv > 0.55 ? 4 : 3;
        else if (al > 58) c = nv > 0.5 ? 9 : 2;
        else c = nv > 0.4 ? 1 : 3;
      }
      cls[v] = c;
      water[v] = isWater ? 255 : 0;
      heights[v] = isWater ? 0 : h;
      const p = PALETTE[c];
      let k = 0.9 + 0.2 * vnoise(lon * 9 + 7, lat * 9);
      if (c === 8) k = Math.max(0.35, Math.min(1.6, 1.6 - Math.min(1, -h / 3000) * 1.1));
      rgb[3 * v] = Math.min(255, p[0] * k); rgb[3 * v + 1] = Math.min(255, p[1] * k); rgb[3 * v + 2] = Math.min(255, p[2] * (c === 8 ? Math.sqrt(k) : k));
    }
  }
  // water tiles' normals: the ellipsoid's up (heights were clamped to 0 already, gridNormals gave it)
  return encodeTerrainCompact({ key, n, heights, cls, rgb, water, normals, skirt: skirtFor(z), src: ["terrarium(dev)"] });
}
