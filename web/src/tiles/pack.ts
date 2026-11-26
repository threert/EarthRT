// Compact ERT tiles → the GPU layout (gpu-format.ts). Runs in the tile workers; the meshing is core's
// (expandTerrain, expandBuildings), this only re-centres and quantises what the GPU does not need in f32.
import { decodeErt, expandBuildings, expandTerrain, skirtSource, type Ert } from "@earthrt/core";
import { snapCenter, type PackedBuildings, type PackedTerrain } from "./gpu-format.ts";

const meta = { decodeMs: 0, netMs: 0, netBytes: 0, cached: false };

export function packTerrain(file: ArrayBuffer | Uint8Array): PackedTerrain {
  const t0 = performance.now();
  const ert: Ert = decodeErt(file);
  const m = expandTerrain(ert);
  const n = m.n, nn = n * n, V = nn + 4 * n;
  const center = snapCenter(m.center);
  const dx = m.center[0] - center[0], dy = m.center[1] - center[1], dz = m.center[2] - center[2];
  const position = new Float32Array(3 * V);
  for (let v = 0; v < V; v++) {
    position[3 * v] = m.positions[3 * v] + dx;
    position[3 * v + 1] = m.positions[3 * v + 1] + dy;
    position[3 * v + 2] = m.positions[3 * v + 2] + dz;
  }
  const rgb = ert.chunks.rgb as Uint8Array, cls = ert.chunks.cls as Uint8Array, water = ert.chunks.water as Uint8Array;
  const normal = new Int8Array(4 * V), color = new Uint8Array(4 * V);
  for (let v = 0; v < V; v++) {
    const g = v < nn ? v : skirtSource(n, v - nn);
    normal[4 * v] = Math.round(m.normals[3 * v] * 127);
    normal[4 * v + 1] = Math.round(m.normals[3 * v + 1] * 127);
    normal[4 * v + 2] = Math.round(m.normals[3 * v + 2] * 127);
    normal[4 * v + 3] = water[g] >> 1;
    color[4 * v] = rgb[3 * g];
    color[4 * v + 1] = rgb[3 * g + 1];
    color[4 * v + 2] = rgb[3 * g + 2];
    color[4 * v + 3] = cls[g];
  }
  const radius = m.radius + Math.hypot(dx, dy, dz);
  const bytes = position.byteLength + normal.byteLength + color.byteLength;
  return {
    kind: "terrain", key: m.key, center, radius, minH: m.minH, maxH: m.maxH, n,
    position, normal, color, heights: m.heights, bytes, ...meta, decodeMs: performance.now() - t0,
  };
}

const toSrgb = (l: number) => Math.round(255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055));

export function packBuildings(bytes: ArrayBuffer | Uint8Array): PackedBuildings {
  const t0 = performance.now();
  const ert = decodeErt(bytes);
  const m = expandBuildings(ert);
  const V = m.positions.length / 3;
  const center = snapCenter(m.center);
  const dx = m.center[0] - center[0], dy = m.center[1] - center[1], dz = m.center[2] - center[2];
  const position = new Float32Array(3 * V), normal = new Int8Array(4 * V), color = new Uint8Array(4 * V);
  // (colour lookups repeat per building: a small cache of linear → sRGB)
  const lut = new Map<number, number>();
  const srgb = (l: number) => {
    let s = lut.get(l);
    if (s === undefined) lut.set(l, (s = toSrgb(l)));
    return s;
  };
  for (let v = 0; v < V; v++) {
    position[3 * v] = m.positions[3 * v] + dx;
    position[3 * v + 1] = m.positions[3 * v + 1] + dy;
    position[3 * v + 2] = m.positions[3 * v + 2] + dz;
    const nx = m.normals[3 * v], ny = m.normals[3 * v + 1], nz = m.normals[3 * v + 2];
    normal[4 * v] = Math.round(nx * 127);
    normal[4 * v + 1] = Math.round(ny * 127);
    normal[4 * v + 2] = Math.round(nz * 127);
    color[4 * v] = srgb(m.colors[3 * v]);
    color[4 * v + 1] = srgb(m.colors[3 * v + 1]);
    color[4 * v + 2] = srgb(m.colors[3 * v + 2]);
    // walls have a horizontal normal; roofs point up along the tile's centre direction
    const up = (nx * m.center[0] + ny * m.center[1] + nz * m.center[2]) / (Math.hypot(...m.center) || 1);
    color[4 * v + 3] = up > 0.7 ? 0 : 255;
  }
  const index = V < 65536 ? Uint16Array.from(m.index) : new Uint32Array(m.index);
  const bytesOut = position.byteLength + normal.byteLength + color.byteLength + index.byteLength;
  return {
    kind: "buildings", key: m.key, center, radius: m.radius + Math.hypot(dx, dy, dz), count: m.count,
    position, normal, color, index, bytes: bytesOut, ...meta, decodeMs: performance.now() - t0,
  };
}
