// The materials' detail: a tileable 3D noise texture (64³ RGBA8). R and B smooth value noise (two seeds, a few
// octaves), G white noise per voxel (cells: fields, blocks), A ridged noise (rock). Periodic in 64 voxels, so it
// tiles with DETAIL_PERIOD in ECEF (tiles/gpu-format.ts).
import * as THREE from "three";

const S = 64;

function lattice(seed: number, period: number) {
  const v = new Float32Array(period * period * period);
  let h = seed >>> 0;
  for (let i = 0; i < v.length; i++) {
    h = Math.imul(h ^ (h >>> 15), 2246822519) + 0x9e3779b9;
    h = Math.imul(h ^ (h >>> 13), 3266489917);
    v[i] = ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }
  return v;
}

/** Value noise, period `p` lattice cells over the S voxels, sampled at voxel (x, y, z). */
function valueOctave(out: Float32Array, p: number, seed: number, amp: number, ridged = false) {
  const L = lattice(seed, p), k = p / S;
  const at = (i: number, j: number, l: number) => L[((i % p) * p + (j % p)) * p + (l % p)];
  for (let z = 0; z < S; z++) for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const fx = x * k, fy = y * k, fz = z * k;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    let tx = fx - ix, ty = fy - iy, tz = fz - iz;
    tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty); tz = tz * tz * (3 - 2 * tz);
    const a = at(ix, iy, iz) + (at(ix + 1, iy, iz) - at(ix, iy, iz)) * tx;
    const b = at(ix, iy + 1, iz) + (at(ix + 1, iy + 1, iz) - at(ix, iy + 1, iz)) * tx;
    const c = at(ix, iy, iz + 1) + (at(ix + 1, iy, iz + 1) - at(ix, iy, iz + 1)) * tx;
    const d = at(ix, iy + 1, iz + 1) + (at(ix + 1, iy + 1, iz + 1) - at(ix, iy + 1, iz + 1)) * tx;
    let n = (a + (b - a) * ty) + ((c + (d - c) * ty) - (a + (b - a) * ty)) * tz;
    if (ridged) n = 1 - Math.abs(n * 2 - 1);
    out[(z * S + y) * S + x] += n * amp;
  }
}

export function makeDetailNoise(): THREE.Data3DTexture {
  const n = S * S * S;
  const r = new Float32Array(n), b = new Float32Array(n), a = new Float32Array(n);
  valueOctave(r, 8, 1, 0.5); valueOctave(r, 16, 2, 0.3); valueOctave(r, 32, 3, 0.2);
  valueOctave(b, 4, 7, 0.5); valueOctave(b, 16, 8, 0.3); valueOctave(b, 64, 9, 0.2);
  valueOctave(a, 8, 11, 0.6, true); valueOctave(a, 32, 12, 0.4, true);
  const g = lattice(99, S);
  const data = new Uint8Array(4 * n);
  // stretch each smooth channel to use the byte range (its spread is narrow)
  const stretch = (v: Float32Array) => {
    let mean = 0, sd = 0;
    for (let i = 0; i < n; i++) mean += v[i] / n;
    for (let i = 0; i < n; i++) sd += (v[i] - mean) ** 2 / n;
    sd = Math.sqrt(sd);
    return (i: number) => Math.max(0, Math.min(255, Math.round(128 + ((v[i] - mean) / sd) * 52)));
  };
  const R = stretch(r), B = stretch(b), A = stretch(a);
  for (let i = 0; i < n; i++) {
    data[4 * i] = R(i);
    data[4 * i + 1] = Math.round(g[i] * 255);
    data[4 * i + 2] = B(i);
    data[4 * i + 3] = A(i);
  }
  const t = new THREE.Data3DTexture(data, S, S, S);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

/** A neutral stand-in until the noise is made (after the first picture). */
export function flatNoise(): THREE.Data3DTexture {
  const t = new THREE.Data3DTexture(new Uint8Array([128, 128, 128, 128]), 1, 1, 1);
  t.needsUpdate = true;
  return t;
}
