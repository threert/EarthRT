// The GPU layout of tiles, shared by the worker (which packs) and the renderer (which uploads). Positions stay f32
// relative to a centre snapped to a multiple of DETAIL_PERIOD in ECEF: the vertex position is then also the
// coordinate of the material's 3D detail noise (periodic in DETAIL_PERIOD), continuous across tiles at no cost.

/** Period of the detail noise, m (ECEF). Tile centres are snapped to multiples of it. */
export const DETAIL_PERIOD = 4096;

export interface PackedTerrain {
  kind: "terrain";
  key: string;
  /** Snapped centre (ECEF, doubles): positions are relative to it. */
  center: [number, number, number];
  radius: number;
  minH: number;
  maxH: number;
  n: number;
  /** f32 × 3 */
  position: Float32Array;
  /** i8 × 4 (normalised): unit normal in ECEF axes, w = water 0..127 */
  normal: Int8Array;
  /** u8 × 4 (normalised): albedo sRGB, a = land class */
  color: Uint8Array;
  /** the grid's heights (n × n), for the camera's floor and picking */
  heights: Float32Array;
  bytes: number;
  decodeMs: number;
  netMs: number;
  netBytes: number;
  cached: boolean;
}

export interface PackedBuildings {
  kind: "buildings";
  key: string;
  center: [number, number, number];
  radius: number;
  count: number;
  position: Float32Array;
  /** i8 × 4: normal, w unused */
  normal: Int8Array;
  /** u8 × 4: sRGB albedo, a = 255 wall / 0 roof */
  color: Uint8Array;
  index: Uint16Array | Uint32Array;
  bytes: number;
  decodeMs: number;
  netMs: number;
  netBytes: number;
  cached: boolean;
}

export interface EmptyTile {
  kind: "empty";
  key: string;
  netMs: number;
  netBytes: number;
  cached: boolean;
}

export type PackedTile = PackedTerrain | PackedBuildings | EmptyTile;

export function snapCenter(c: readonly number[]): [number, number, number] {
  const P = DETAIL_PERIOD;
  return [Math.round(c[0] / P) * P, Math.round(c[1] / P) * P, Math.round(c[2] / P) * P];
}

export function transferablesOf(t: PackedTile): ArrayBuffer[] {
  if (t.kind === "terrain") return [t.position.buffer, t.normal.buffer, t.color.buffer, t.heights.buffer] as ArrayBuffer[];
  if (t.kind === "buildings") return [t.position.buffer, t.normal.buffer, t.color.buffer, t.index.buffer] as ArrayBuffer[];
  return [];
}
