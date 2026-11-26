import { describe, expect, test } from "bun:test";
import { ecefToGeodetic, geodeticToEcef, len, sub, type V3 } from "@earthrt/core";
import {
  altitude, basis, clampHeight, DEG, flyPath, fromVectors, grabRotation, lookAt, minHeight, orbit, raySphere, rotateAbout, zoomToward, type CamState,
} from "../src/camera/math.ts";
import { evictions, gpuBudgetFor, UploadBudget } from "../src/tiles/budget.ts";
import { parseLatLon, parseLaunch } from "../src/config.ts";
import { loadChoice, saveChoice, viewBox } from "../src/places/places.ts";
import { snapCenter, DETAIL_PERIOD } from "../src/tiles/gpu-format.ts";
import { screenSeconds } from "../src/flight.ts";

const near = (a: number, b: number, eps: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);
const nearV = (a: V3, b: V3, eps: number) => expect(len(sub(a, b))).toBeLessThanOrEqual(eps);

describe("camera math", () => {
  test("heading and pitch survive basis → vectors → state", () => {
    for (const [h, p] of [[0, -30], [90, -10], [200, -80], [359, 20], [45, -89.9]]) {
      const s: CamState = { pos: geodeticToEcef(35, 135.7, 3000), heading: h * DEG, pitch: p * DEG };
      const b = basis(s);
      const back = fromVectors(s.pos, b.forward, b.up);
      near(((back.heading - s.heading + 3 * Math.PI) % (2 * Math.PI)) - Math.PI, 0, 1e-6);
      near(back.pitch, s.pitch, 1e-9);
    }
  });

  test("looking straight down keeps its heading from the camera's up", () => {
    const s: CamState = { pos: geodeticToEcef(10, 20, 1e6), heading: 70 * DEG, pitch: -90 * DEG };
    const b = basis(s);
    const back = fromVectors(s.pos, b.forward, b.up);
    near(back.heading, 70 * DEG, 1e-6);
  });

  test("a grab brings the grabbed point under the cursor (the centre ray: a grab removes roll, which moves the rest a little)", () => {
    const s: CamState = { pos: geodeticToEcef(30, 100, 5e6), heading: 0, pitch: -90 * DEG };
    const grabbed = geodeticToEcef(32, 101, 0);
    const dir = basis(s).forward;
    const r = grabRotation(s, grabbed, dir)!;
    const after = rotateAbout(s, r.axis, r.angle);
    // the ray from the new camera along the rotated direction meets the grabbed point
    const hit = raySphere(after.pos, basisDir(s, after, dir), len(grabbed))!;
    nearV(hit, grabbed, 5e6 * 1e-4); // (looking straight down, heading comes from the up vector: ≤ 1e-4 rad)
    near(len(after.pos), len(s.pos), 1e-3); // a turn about the centre
  });

  test("zooming toward a point keeps it on the same ray and shortens the distance", () => {
    const s = lookAt(35, 135.76, 0, 10_000, 0, 50 * DEG);
    const target = geodeticToEcef(35, 135.76, 0);
    const z = zoomToward(s, target, 0.5);
    near(len(sub(z.pos, target)), 5000, 1e-3);
    nearV(basis(z).forward, basis(s).forward, 1e-9);
  });

  test("lookAt puts the camera at range and tilt from its target", () => {
    const s = lookAt(46, 7.6, 3000, 12_000, 200 * DEG, 60 * DEG);
    const t = geodeticToEcef(46, 7.6, 3000);
    near(len(sub(s.pos, t)), 12_000, 1e-3);
    const g = ecefToGeodetic(...s.pos);
    near(g.h, 3000 + 12_000 * Math.cos(60 * DEG), 20);
    // looking at the target
    const d = sub(t, s.pos), l = len(d);
    nearV(basis(s).forward, [d[0] / l, d[1] / l, d[2] / l], 1e-6);
  });

  test("orbit keeps the distance to the pivot and clamps the tilt", () => {
    const pivot = geodeticToEcef(35, 135.76, 0);
    const s = lookAt(35, 135.76, 0, 8000, 0, 30 * DEG);
    const o = orbit(s, pivot, 40 * DEG, 20 * DEG);
    near(len(sub(o.pos, pivot)), 8000, 1e-3);
    const o2 = orbit(s, pivot, 0, 90 * DEG);
    const g = ecefToGeodetic(...o2.pos);
    // tilt clamped at 82°: still above the ground
    expect(g.h).toBeGreaterThan(8000 * Math.cos(83 * DEG));
  });

  test("the floor: 300 m over the trunk, a place's minDistance inside it, more while the ground is coarse", () => {
    expect(minHeight(50, 14)).toBe(350);
    expect(minHeight(50, 14, 2)).toBe(52);
    expect(minHeight(50, 6)).toBeGreaterThan(350);
    expect(minHeight(NaN, -1)).toBe(3000);
    const s: CamState = { pos: geodeticToEcef(35, 135, 10), heading: 0, pitch: 0 };
    near(altitude(clampHeight(s, 400)), 400, 1e-3);
  });

  test("a fly-to starts and ends where asked, and rises on long hops", () => {
    const a = lookAt(35, 135.76, 0, 8000, 0, 40 * DEG), b = lookAt(37.77, -122.42, 0, 8000, 0, 40 * DEG);
    const p = flyPath(a, b);
    nearV(p.at(0).pos, a.pos, 1e-3);
    nearV(p.at(1).pos, b.pos, 1e-3);
    expect(altitude(p.at(0.5))).toBeGreaterThan(1e6);
    expect(p.duration).toBeLessThanOrEqual(6.5);
  });
});

function basisDir(before: CamState, after: CamState, dir: V3): V3 {
  // the same direction relative to the camera: decompose in the old basis, rebuild in the new one
  const b0 = basis(before), b1 = basis(after);
  const f = dir[0] * b0.forward[0] + dir[1] * b0.forward[1] + dir[2] * b0.forward[2];
  const u = dir[0] * b0.up[0] + dir[1] * b0.up[1] + dir[2] * b0.up[2];
  const r = dir[0] * b0.right[0] + dir[1] * b0.right[1] + dir[2] * b0.right[2];
  return [b1.forward[0] * f + b1.up[0] * u + b1.right[0] * r, b1.forward[1] * f + b1.up[1] * u + b1.right[1] * r, b1.forward[2] * f + b1.up[2] * u + b1.right[2] * r];
}

describe("budgets", () => {
  test("evictions drop the least recently used first and never what the view uses", () => {
    const rs = [{ key: "a", bytes: 10, lastUsed: 1 }, { key: "b", bytes: 10, lastUsed: 5 }, { key: "c", bytes: 10, lastUsed: 3 }, { key: "d", bytes: 10, lastUsed: 9 }];
    expect(evictions(rs, 40, 25, 9)).toEqual(["a", "c"]);
    expect(evictions(rs, 40, 0, 9)).toEqual(["a", "c", "b"]); // d is in use this frame
    expect(evictions(rs, 40, 0, 9, (k) => k === "a")).toEqual(["c", "b"]);
    expect(evictions(rs, 20, 25, 9)).toEqual([]);
  });

  test("uploads: at least one a frame, then within the bytes", () => {
    const u = new UploadBudget(100, 1000);
    const q = [{ bytes: 60 }, { bytes: 60 }, { bytes: 10 }];
    const done: number[] = [];
    expect(u.take(q, (t) => done.push(t.bytes))).toBe(1);
    expect(q.length).toBe(2);
    const big = [{ bytes: 500 }];
    expect(u.take(big, () => {})).toBe(1);
  });

  test("uploads stop when the frame's time is spent", () => {
    const u = new UploadBudget(1e9, 4);
    let t = 0;
    const q = Array.from({ length: 10 }, () => ({ bytes: 1 }));
    expect(u.take(q, () => { t += 3; }, () => t)).toBe(2);
  });

  test("GPU budget by device", () => {
    expect(gpuBudgetFor(undefined, false)).toBe(384 << 20);
    expect(gpuBudgetFor(undefined, true)).toBe(160 << 20);
    expect(gpuBudgetFor(2, true)).toBe(128 << 20);
    expect(gpuBudgetFor(8, false)).toBe(384 << 20);
  });

  test("tile centres snap to the detail period", () => {
    const c = snapCenter([-3958204.1, 3349370.8, 3699022.3]);
    for (const v of c) expect(Math.abs(v % DETAIL_PERIOD)).toBe(0);
    expect(Math.abs(c[0] + 3958204.1)).toBeLessThanOrEqual(DETAIL_PERIOD / 2);
  });
});

describe("launch parameters (SPEC § 7)", () => {
  test("at, place, fly, api, dev", () => {
    const l = parseLaunch("?at=35.0,135.76,3000,10,-25&place=threert/earth-kyoto/kyoto&fly=kyoto;37.77,-122.42&api=http://localhost:8790/&dev=http://127.0.0.1:8797/place/&debug");
    expect(l.at).toEqual({ lat: 35, lon: 135.76, alt: 3000, heading: 10, pitch: -25 });
    expect(l.place).toBe("threert/earth-kyoto/kyoto");
    expect(l.fly).toEqual({ from: "kyoto", to: "37.77,-122.42" });
    expect(l.api).toBe("http://localhost:8790");
    expect(l.dev).toBe("http://127.0.0.1:8797/place");
    expect(l.debug).toBe(true);
  });

  test("bad values are ignored", () => {
    const l = parseLaunch("?at=95,10&place=../x&fly=nowhere&api=javascript:alert(1)&sse=100");
    expect(l.at).toBeUndefined();
    expect(l.place).toBeUndefined();
    expect(l.fly).toBeUndefined();
    expect(l.api).toBe("");
    expect(l.sse).toBeUndefined();
  });

  test("lat,lon", () => {
    expect(parseLatLon(" 35.01, 135.77 ")).toEqual({ lat: 35.01, lon: 135.77 });
    expect(parseLatLon("135, 35")).toBeNull();
    expect(parseLatLon("Kyoto")).toBeNull();
  });
});

describe("places", () => {
  test("the user's version choice is kept", () => {
    const m = new Map<string, string>();
    const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    saveChoice({ "site:kyoto-tower": "a/b/kyoto-tower" }, st);
    expect(loadChoice(st)).toEqual({ "site:kyoto-tower": "a/b/kyoto-tower" });
    expect(loadChoice({ getItem: () => "{oops" })).toEqual({});
  });

  test("the view's box crosses the antimeridian and widens with latitude", () => {
    const b = viewBox(0, 179.9, 50_000);
    expect(b.west).toBeGreaterThan(b.east);
    const hi = viewBox(60, 0, 50_000), eq = viewBox(0, 0, 50_000);
    expect(hi.east - hi.west).toBeGreaterThan((eq.east - eq.west) * 1.9);
  });
});

describe("flights", () => {
  test("screen time grows with distance, within bounds", () => {
    expect(screenSeconds(5_000)).toBeGreaterThanOrEqual(20);
    expect(screenSeconds(8_300_000)).toBeLessThanOrEqual(110);
    expect(screenSeconds(8_300_000)).toBeGreaterThan(screenSeconds(500_000));
  });
});
