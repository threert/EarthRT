// Camera math in ECEF doubles (no DOM, no three.js): the camera is a position and a heading and pitch relative to the
// local east-north-up there (so it never rolls), and every gesture is a rigid motion of it.
import { cross, dot, ecefToGeodetic, enu, geodeticToEcef, greatCircle, haversine, len, norm, scale, sub, add, type V3 } from "@earthrt/core";

export interface CamState {
  /** ECEF, m. */
  pos: V3;
  /** Radians clockwise from north. */
  heading: number;
  /** Radians above the horizon (−π/2 looks straight down). */
  pitch: number;
}

export interface Basis {
  forward: V3;
  up: V3;
  right: V3;
}

export const DEG = Math.PI / 180;
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

/** The camera's axes in ECEF. */
export function basis(s: CamState): Basis {
  const g = ecefToGeodetic(s.pos[0], s.pos[1], s.pos[2]);
  const { e, n, u } = enu(g.lat, g.lon);
  const ch = Math.cos(s.heading), sh = Math.sin(s.heading), cp = Math.cos(s.pitch), sp = Math.sin(s.pitch);
  const fh: V3 = add(scale(n, ch), scale(e, sh));
  const forward = add(scale(fh, cp), scale(u, sp));
  const right: V3 = add(scale(e, ch), scale(n, -sh));
  const up = cross(right, forward);
  return { forward, up, right };
}

/** Heading and pitch of a forward (and up, when looking straight down) at a position. */
export function fromVectors(pos: V3, forward: V3, up: V3): CamState {
  const g = ecefToGeodetic(pos[0], pos[1], pos[2]);
  const { e, n, u } = enu(g.lat, g.lon);
  const f = norm(forward);
  const pitch = Math.asin(clamp(dot(f, u), -1, 1));
  let heading: number;
  // looking (nearly) straight up or down, the heading is where the camera's up points (or away from it)
  if (Math.cos(pitch) > 1e-4) heading = Math.atan2(dot(f, e), dot(f, n));
  else heading = pitch < 0 ? Math.atan2(dot(up, e), dot(up, n)) : Math.atan2(-dot(up, e), -dot(up, n));
  return { pos: [...pos] as V3, heading, pitch };
}

/** Rotates v about a unit axis by an angle (Rodrigues). */
export function rotate(v: V3, axis: V3, angle: number): V3 {
  const c = Math.cos(angle), s = Math.sin(angle), d = dot(axis, v);
  const x = cross(axis, v);
  return [v[0] * c + x[0] * s + axis[0] * d * (1 - c), v[1] * c + x[1] * s + axis[1] * d * (1 - c), v[2] * c + x[2] * s + axis[2] * d * (1 - c)];
}

/** A rigid rotation of the camera about an axis through a point (the Earth's centre by default). */
export function rotateAbout(s: CamState, axis: V3, angle: number, pivot: V3 = [0, 0, 0]): CamState {
  if (!angle) return s;
  const b = basis(s);
  const pos = add(pivot, rotate(sub(s.pos, pivot), axis, angle));
  return fromVectors(pos, rotate(b.forward, axis, angle), rotate(b.up, axis, angle));
}

/** Where a ray meets a sphere about the Earth's centre (the nearer hit in front), or null. */
export function raySphere(o: V3, d: V3, r: number): V3 | null {
  const b = dot(o, d), c = dot(o, o) - r * r, disc = b * b - c;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const t = -b - s > 0 ? -b - s : -b + s;
  if (t <= 0) return null;
  return add(o, scale(d, t));
}

/** Where a ray meets the ellipsoid raised by `h` metres (scaled-sphere trick), or null. */
export function rayEllipsoid(o: V3, d: V3, h = 0): V3 | null {
  const a = 6378137 + h, b = 6356752.314245 + h;
  const k = a / b;
  const os: V3 = [o[0], o[1], o[2] * k], ds = norm([d[0], d[1], d[2] * k]);
  const p = raySphere(os, ds, a);
  return p ? [p[0], p[1], p[2] / k] : null;
}

/**
 * Grab: the camera turns about the Earth's centre so that `grabbed` (a point on the globe, ECEF) lies on the ray `dir`
 * from the camera. Returns the axis and angle (to keep for inertia) or null when the ray misses its sphere.
 */
export function grabRotation(s: CamState, grabbed: V3, dir: V3): { axis: V3; angle: number } | null {
  const r = len(grabbed);
  const hit = raySphere(s.pos, dir, r);
  if (!hit) return null;
  const a = norm(hit), b = norm(grabbed);
  const ax = cross(a, b);
  const sl = len(ax);
  if (sl < 1e-12) return { axis: [0, 0, 1], angle: 0 };
  return { axis: scale(ax, 1 / sl), angle: Math.atan2(sl, dot(a, b)) };
}

/** Moves the camera toward (f < 1) or away from (f > 1) a point, keeping its orientation. */
export function zoomToward(s: CamState, target: V3, f: number): CamState {
  const b = basis(s);
  const pos = add(target, scale(sub(s.pos, target), f));
  return fromVectors(pos, b.forward, b.up);
}

/** Height of the camera above the ellipsoid, m. */
export const altitude = (s: CamState) => ecefToGeodetic(s.pos[0], s.pos[1], s.pos[2]).h;
export const geodetic = (p: V3) => ecefToGeodetic(p[0], p[1], p[2]);

/**
 * Orbit about a pivot on the ground: `dHeading` turns about the pivot's up, `dTilt` tilts away from (positive) or
 * toward the pivot's zenith. The tilt (angle between the pivot's up and the camera's offset) stays in [0, maxTilt].
 */
export function orbit(s: CamState, pivot: V3, dHeading: number, dTilt: number, maxTilt = 82 * DEG): CamState {
  const g = geodetic(pivot);
  const up = enu(g.lat, g.lon).u;
  let out = rotateAbout(s, up, -dHeading, pivot);
  if (dTilt) {
    const off = sub(out.pos, pivot);
    const tilt = Math.acos(clamp(dot(norm(off), up), -1, 1));
    const next = clamp(tilt + dTilt, 0.0, maxTilt);
    const d = next - tilt;
    if (Math.abs(d) > 1e-9) {
      let axis = cross(up, norm(off));
      if (len(axis) < 1e-9) axis = basis(out).right; // straight above the pivot: tilt about the camera's right
      out = rotateAbout(out, norm(axis), d, pivot);
    }
  }
  return out;
}

/** The camera looking at a ground point from `range` metres, heading and tilt (0 = from straight above). */
export function lookAt(lat: number, lon: number, h: number, range: number, heading: number, tilt: number): CamState {
  const t = geodeticToEcef(lat, lon, h);
  const { e, n, u } = enu(lat, lon);
  const fh: V3 = add(scale(n, Math.cos(heading)), scale(e, Math.sin(heading)));
  const dir = add(scale(u, Math.cos(tilt)), scale(fh, -Math.sin(tilt)));
  const pos = add(t, scale(dir, range));
  const forward = scale(dir, -1);
  const right: V3 = add(scale(e, Math.cos(heading)), scale(n, -Math.sin(heading)));
  return fromVectors(pos, forward, cross(right, forward));
}

/** The point the camera's centre looks at on the ellipsoid raised to `h` (or the closest point to the camera when the
 *  view misses the Earth). */
export function centerTarget(s: CamState, h = 0): V3 {
  const b = basis(s);
  return rayEllipsoid(s.pos, b.forward, h) ?? (() => {
    const g = geodetic(s.pos);
    return geodeticToEcef(g.lat, g.lon, h);
  })();
}

const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * A fly-to: the camera from one state to another along the great circle, rising over long hops (up to a quarter of the
 * distance, capped). Returns the state at t (0..1, eased) and the duration in seconds.
 */
export function flyPath(a: CamState, b: CamState) {
  const ga = geodetic(a.pos), gb = geodetic(b.pos);
  const d = haversine(ga.lat, ga.lon, gb.lat, gb.lon);
  const peak = Math.min(Math.max(ga.h, gb.h, d * 0.35), 8_000_000);
  const duration = clamp(1.2 + Math.log10(1 + d / 1000) * 1.1, 1.2, 6.5);
  const dh = wrapPi(b.heading - a.heading), dp = b.pitch - a.pitch;
  const at = (t: number): CamState => {
    const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    const p = greatCircle(ga.lat, ga.lon, gb.lat, gb.lon, e);
    // heights blend in log space (orbit ↔ ground), with a rise in the middle for long hops
    const la = Math.log(Math.max(1, ga.h)), lb = Math.log(Math.max(1, gb.h));
    const base = Math.exp(la + (lb - la) * e);
    const rise = Math.max(0, peak - Math.max(ga.h, gb.h)) * Math.sin(Math.PI * e);
    const h = base + rise;
    // look down more in the middle of a long hop
    const down = Math.sin(Math.PI * e) * clamp(d / 2e6, 0, 1);
    const pitch = (a.pitch + dp * e) * (1 - down) + -Math.PI / 2 * down;
    return { pos: geodeticToEcef(p.lat, p.lon, h), heading: a.heading + dh * e, pitch };
  };
  return { at, duration };
}

/**
 * The lowest the camera may be at a point: the ground plus a clearance that is the trunk's (aeroplane view: 300 m) or a
 * place's `minDistance`, larger while the ground there is only known coarsely (a tile of zoom z spans 40,000 km / 2^z).
 */
export function minHeight(ground: number, loadedZoom: number, placeMin?: number): number {
  const g = Number.isFinite(ground) ? ground : 0;
  const coarse = loadedZoom < 0 ? 3000 : Math.min(3000, (40_075_016 / 2 ** loadedZoom / 64) * 0.5);
  const clearance = placeMin !== undefined ? Math.max(placeMin, 0.3) : 300;
  return g + Math.max(clearance, placeMin !== undefined ? clearance : coarse);
}

/** Lifts the camera along its local up so it is at least `floor` m above the ellipsoid. */
export function clampHeight(s: CamState, floor: number): CamState {
  const g = geodetic(s.pos);
  if (g.h >= floor) return s;
  return { ...s, pos: geodeticToEcef(g.lat, g.lon, floor) };
}

/** Heading's shortest turn, for tests and smooth blending. */
export const angleDiff = wrapPi;
