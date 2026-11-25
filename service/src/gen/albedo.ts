// Albedo (sRGB bytes) of a terrain vertex: procedural from its land class, the climate (latitude, altitude) and the
// slope, varied by a hash noise so a class is not one flat colour. Driven by real data, not photographs: a path tracer
// lights the land itself.

export const CLS = { unknown: 0, tree: 1, shrub: 2, grass: 3, crop: 4, built: 5, bare: 6, snow: 7, water: 8, wetland: 9, mangrove: 10, moss: 11 } as const;

/** ESA WorldCover value → our class (SPEC § 4). */
export function worldCoverClass(v: number): number {
  switch (v) {
    case 10: return 1;
    case 20: return 2;
    case 30: return 3;
    case 40: return 4;
    case 50: return 5;
    case 60: return 6;
    case 70: return 7;
    case 80: return 8;
    case 90: return 9;
    case 95: return 10;
    case 100: return 11;
    default: return 0;
  }
}

type RGB = [number, number, number];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };

/** Value noise in [0, 1) from integer lattice hashing (stable everywhere: the same in every tile). */
function hash(ix: number, iy: number, seed: number) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function noise(x: number, y: number, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed), c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}
/** Two octaves at a scale in degrees. */
const fbm = (lat: number, lon: number, deg: number, seed: number) => 0.65 * noise(lon / deg, lat / deg, seed) + 0.35 * noise((lon * 2.3) / deg, (lat * 2.3) / deg, seed + 7);

// Base colours, sRGB. Seen from orbit the land is darker than one expects: forests ~5-8 % albedo, crops ~10-15 %,
// deserts 30-40 %, fresh snow 80-90 %.
const FOREST_TROPIC: RGB = [24, 50, 22];
const FOREST_TEMPERATE: RGB = [34, 56, 28];
const FOREST_BOREAL: RGB = [30, 44, 32];
const SHRUB: RGB = [104, 98, 66];
const SHRUB_DRY: RGB = [150, 128, 92];
const GRASS: RGB = [92, 112, 52];
const GRASS_DRY: RGB = [156, 140, 92];
const CROP: RGB = [110, 118, 62];
const CROP_DRY: RGB = [150, 136, 96];
const BUILT: RGB = [122, 118, 112];
const SAND: RGB = [214, 178, 126];
const SAND_RED: RGB = [196, 132, 86];
const ROCK: RGB = [128, 116, 104];
const ROCK_DARK: RGB = [86, 80, 74];
const SNOW: RGB = [238, 241, 246];
const WETLAND: RGB = [58, 78, 50];
const MANGROVE: RGB = [30, 60, 34];
const MOSS: RGB = [118, 112, 84];
const TUNDRA: RGB = [104, 100, 76];
const SEA_ICE: RGB = [226, 232, 240];

/** How dry the climate is (0 wet … 1 arid) from latitude alone (the subtropical belts), with noise. */
function aridity(lat: number, lon: number) {
  const a = Math.abs(lat);
  const belt = smooth(10, 20, a) * (1 - smooth(32, 42, a));
  return clamp01(belt * 0.85 + (fbm(lat, lon, 6, 11) - 0.5) * 0.5);
}

/** Altitude of the permanent snow line at a latitude, m. */
export function snowLine(lat: number) {
  const a = Math.abs(lat);
  // ~5200 m in the tropics, ~4000 m at 35°, ~2000 m at 55°, sea level by 72° (Antarctica sits on its ice anyway)
  if (a < 20) return 5200;
  if (a < 35) return 5200 - (a - 20) * 80;
  if (a < 55) return 4000 - (a - 35) * 100;
  return Math.max(0, 2000 - (a - 55) * 118);
}

/**
 * The albedo of one vertex. `cls` its class (0 unknown: guessed from the climate), `h` the ground height (m; for water
 * the depth below the surface is `-depth`), `slope` 0 flat … 1 vertical (1 − n·up), `water` 0..1.
 */
export function albedo(cls: number, lat: number, lon: number, h: number, slope: number, water: number, depth: number, out: Uint8Array, at: number) {
  const a = Math.abs(lat);
  const n1 = fbm(lat, lon, 0.35, 1), n2 = fbm(lat, lon, 0.04, 2);
  let c: RGB;
  const arid = aridity(lat, lon);
  if (cls === 0) {
    // no land cover here: a guess from the climate
    if (a > 66) cls = CLS.moss;
    else if (a > 50) cls = CLS.tree;
    else if (arid > 0.62) cls = CLS.bare;
    else if (arid > 0.4) cls = CLS.shrub;
    else if (a < 12) cls = CLS.tree;
    else cls = n1 > 0.5 ? CLS.crop : CLS.tree;
  }
  switch (cls) {
    case CLS.tree: c = a < 23 ? FOREST_TROPIC : a < 48 ? mix(FOREST_TROPIC, FOREST_TEMPERATE, smooth(23, 35, a)) : mix(FOREST_TEMPERATE, FOREST_BOREAL, smooth(48, 60, a)); break;
    case CLS.shrub: c = mix(SHRUB, SHRUB_DRY, arid); break;
    case CLS.grass: c = mix(GRASS, GRASS_DRY, clamp01(arid * 1.2 + (a > 55 ? 0.2 : 0))); break;
    case CLS.crop: c = mix(CROP, CROP_DRY, clamp01(arid + (n2 - 0.5) * 0.6)); break;
    case CLS.built: c = BUILT; break;
    case CLS.bare: {
      // deserts sand-coloured, red in places (Sahara's east, Australia), rock elsewhere and at high latitudes
      const desert = smooth(0.2, 0.55, arid) * (1 - smooth(45, 55, a));
      c = mix(mix(ROCK, ROCK_DARK, n2 * 0.6), mix(SAND, SAND_RED, smooth(0.45, 0.75, fbm(lat, lon, 3, 5))), desert);
      break;
    }
    case CLS.snow: c = SNOW; break;
    case CLS.wetland: c = WETLAND; break;
    case CLS.mangrove: c = MANGROVE; break;
    case CLS.moss: c = mix(MOSS, TUNDRA, n1); break;
    default: c = mix(GRASS, SHRUB, 0.5);
  }
  if (cls !== CLS.snow && cls !== CLS.water && cls !== CLS.built) {
    // variation inside a class: ±12 % brightness, a little hue
    const v = 0.88 + 0.24 * n2, w = (n1 - 0.5) * 0.12;
    c = [c[0] * v * (1 + w), c[1] * v, c[2] * v * (1 - w)];
    // rock on steep slopes
    c = mix(c, mix(ROCK, ROCK_DARK, n2), smooth(0.16, 0.36, slope));
    // snow above the line, less where it is steep, patchy near the line
    const line = snowLine(lat) + (n1 - 0.5) * 500;
    const snow = smooth(line - 300, line + 200, h) * (1 - smooth(0.3, 0.55, slope));
    // Antarctica's and Greenland's ice sheets
    const sheet = lat < -60 || (lat > 60 && lon > -75 && lon < -10 && h > 900) ? 1 : 0;
    c = mix(c, SNOW, Math.max(snow, sheet * (1 - smooth(0.35, 0.6, slope))));
  }
  if (water > 0) {
    // the sea: blue by depth, sea ice toward the poles
    const d = Math.max(0, depth);
    let sea = mix([42, 98, 110], mix([12, 40, 74], [6, 22, 48], smooth(200, 4000, d)), smooth(2, 60, d));
    if (cls === CLS.water && d === 0) sea = [26, 58, 72]; // lakes and rivers
    const ice = lat > 0 ? smooth(77, 81, lat + (n1 - 0.5) * 3) : smooth(68, 72, -lat + (n1 - 0.5) * 3);
    sea = mix(sea, SEA_ICE, ice);
    c = mix(c, sea, water);
  }
  out[at] = Math.max(0, Math.min(255, Math.round(c[0])));
  out[at + 1] = Math.max(0, Math.min(255, Math.round(c[1])));
  out[at + 2] = Math.max(0, Math.min(255, Math.round(c[2])));
}

/** Sea ice fraction at a latitude (the class and the water byte follow it). */
export function seaIce(lat: number, lon: number) {
  const n1 = fbm(lat, lon, 0.35, 1);
  return lat > 0 ? smooth(77, 81, lat + (n1 - 0.5) * 3) : smooth(68, 72, -lat + (n1 - 0.5) * 3);
}
