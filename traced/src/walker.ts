// The traced view's camera (pointer "free": the pointer stays the user's). It starts where the map was (`traced.open`'s
// camera) and moves within reach of the place:
//   - drag: look around; right drag or Shift + drag: orbit about the place's anchor;
//   - W A S D / arrows: walk (faster the higher it is), Space / E up, C / Q down, Shift faster; the wheel: forward, back;
//   - Esc, or rising above the place's `enterFrom`: exit to the map (`traced.exit`).
// The camera keeps eye height over the terrain and stays within the surroundings' radius of the anchor. Its state is in
// the scene's frame (east-up-south at the anchor, turned by the place's heading): within a few kilometres the frame's
// up is the local up to a hundredth of a degree.
import type { Input } from "@threert/gameplay";
import { ecefToGeodetic, enu, geodeticToEcef, type Frame, type V3 } from "../../packages/core/src/index.ts";

const RAD = Math.PI / 180;
export interface GeoCamera {
  lat: number;
  lon: number;
  alt: number;
  heading: number;
  pitch: number;
  fov?: number;
}

export class Walker {
  /** Position in the scene's frame, m. */
  pos: V3 = [0, 2, 10];
  /** Yaw: degrees clockwise from the frame's forward (−z); pitch: degrees, up positive. */
  yaw = 0;
  pitch = -10;
  fov = 50;
  /** Eye height over the terrain, m. */
  eye = 1.7;
  reach = 1500;
  /** Height over the ground above which the user has left the place (its `enterFrom`). */
  exitAbove = Infinity;
  ground: (x: number, z: number) => number = () => 0;
  /** Set when the user asked to leave (Esc, or rose above `exitAbove`); the app is told once. */
  exit: "esc" | "rose" | null = null;
  private last: { u: number; v: number } | null = null;
  private vel: V3 = [0, 0, 0];
  private dolly = 0;
  moved = false;

  constructor(private frame: () => Frame, private heading: () => number) {}

  /** The camera from the map's (geodetic) into the frame. */
  setGeo(c: GeoCamera) {
    const f = this.frame();
    const p = f.point(geodeticToEcef(c.lat, c.lon, c.alt));
    this.pos = [p[0], p[1], p[2]];
    // (the heading and pitch are local to the camera's place; turned into the frame's, which is the anchor's)
    const { e, n, u } = enu(c.lat, c.lon);
    const h = c.heading * RAD, t = c.pitch * RAD;
    const d: V3 = [0, 0, 0];
    for (let i = 0; i < 3; i++) d[i] = (n[i] * Math.cos(h) + e[i] * Math.sin(h)) * Math.cos(t) + u[i] * Math.sin(t);
    const fd = f.dir(d);
    this.yaw = Math.atan2(fd[0], -fd[2]) / RAD;
    this.pitch = Math.asin(Math.max(-1, Math.min(1, fd[1]))) / RAD;
    if (c.fov) this.fov = c.fov;
    this.exit = null;
    this.vel = [0, 0, 0];
  }

  /** The camera as the map has it. */
  geo(): GeoCamera {
    const f = this.frame();
    const g = ecefToGeodetic(...f.pointToEcef(this.pos));
    const fwd = this.forward();
    const de = f.dirToEcef(fwd);
    const { e, n, u } = enu(g.lat, g.lon);
    const ce = de[0] * e[0] + de[1] * e[1] + de[2] * e[2], cn = de[0] * n[0] + de[1] * n[1] + de[2] * n[2], cu = de[0] * u[0] + de[1] * u[1] + de[2] * u[2];
    return { lat: g.lat, lon: g.lon, alt: g.h, heading: ((Math.atan2(ce, cn) / RAD) + 360) % 360, pitch: Math.asin(Math.max(-1, Math.min(1, cu))) / RAD, fov: this.fov };
  }

  forward(): V3 {
    const y = this.yaw * RAD, p = this.pitch * RAD;
    return [Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p)];
  }

  update(input: Input, dt: number) {
    this.moved = false;
    if (dt <= 0) return;
    if (input.pressed("Escape")) this.exit = "esc";
    const shift = input.down("Shift");
    const ptr = input.pointer;
    const drag = input.button(0) || input.button(2);
    if (drag && this.last) {
      const du = ptr.u - this.last.u, dv = ptr.v - this.last.v;
      if (du || dv) {
        this.moved = true;
        if (input.button(2) || shift) this.orbit(du * 180, -dv * 90);
        else {
          this.yaw = (this.yaw - du * this.fov * 1.6 + 360) % 360;
          this.pitch = Math.max(-89, Math.min(89, this.pitch + dv * this.fov));
        }
      }
    }
    this.last = drag ? { u: ptr.u, v: ptr.v } : null;
    const g0 = this.ground(this.pos[0], this.pos[2]);
    // (no terrain yet: as if 10 m up)
    const agl = isFinite(g0) ? Math.max(0.1, this.pos[1] - g0) : 10;
    const speed = Math.max(3, agl * 0.8) * (shift ? 4 : 1);
    const mv = input.move;
    const ax = mv.x || input.axis("Left", "Right"), ay = mv.y || input.axis("Down", "Up");
    const up = (input.down("Space") || input.down("E") ? 1 : 0) - (input.down("C") || input.down("Q") ? 1 : 0);
    const y = this.yaw * RAD;
    // (walking keeps its speed a moment: no jolt at the start and stop)
    const target: V3 = [(Math.sin(y) * ay + Math.cos(y) * ax) * speed, up * speed, (-Math.cos(y) * ay + Math.sin(y) * ax) * speed];
    const k = 1 - Math.exp(-dt * 10);
    for (let i = 0; i < 3; i++) this.vel[i] += (target[i] - this.vel[i]) * k;
    this.dolly += input.wheel * Math.max(2, agl * 0.25);
    const step = this.dolly * (1 - Math.exp(-dt * 10));
    this.dolly -= step;
    const f = this.forward();
    const d: V3 = [this.vel[0] * dt + f[0] * step, this.vel[1] * dt + f[1] * step, this.vel[2] * dt + f[2] * step];
    if (Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) > 1e-5) this.moved = true;
    this.pos = [this.pos[0] + d[0], this.pos[1] + d[1], this.pos[2] + d[2]];
    this.clamp();
  }

  /** Turns the camera about the anchor (the frame's origin), keeping its distance. */
  private orbit(dh: number, dp: number) {
    const [x, y, z] = this.pos;
    const g0 = this.ground(0, 0), g = isFinite(g0) ? g0 : 0;
    const oy = y - g;
    const r = Math.hypot(x, oy, z);
    let az = Math.atan2(x, z), el = Math.asin(Math.max(-1, Math.min(1, oy / Math.max(r, 1e-6))));
    az -= dh * RAD;
    el = Math.max(2 * RAD, Math.min(85 * RAD, el + dp * RAD));
    this.pos = [Math.sin(az) * Math.cos(el) * r, g + Math.sin(el) * r, Math.cos(az) * Math.cos(el) * r];
    // look at the anchor
    const fx = -this.pos[0], fy = g + 1 - this.pos[1], fz = -this.pos[2];
    const l = Math.hypot(fx, fy, fz) || 1;
    this.yaw = (Math.atan2(fx, -fz) / RAD + 360) % 360;
    this.pitch = Math.asin(fy / l) / RAD;
  }

  clamp() {
    const h = Math.hypot(this.pos[0], this.pos[2]);
    if (h > this.reach) {
      this.pos[0] *= this.reach / h;
      this.pos[2] *= this.reach / h;
    }
    const g = this.ground(this.pos[0], this.pos[2]);
    if (isFinite(g) && this.pos[1] < g + this.eye) this.pos[1] = g + this.eye;
    if (isFinite(g) && this.pos[1] - g > this.exitAbove && !this.exit) this.exit = "rose";
  }
}
