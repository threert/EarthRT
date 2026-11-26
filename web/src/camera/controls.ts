// Google-Earth-like navigation: drag grabs the globe (rotates it at altitude, pans near the ground), the wheel and a
// pinch zoom toward the cursor, right-drag / ctrl-drag / two fingers turn and tilt about the point looked at,
// double-click flies in, the keyboard moves too; drags carry on with inertia. In a flight, dragging looks around.
import { ecefToGeodetic, len, norm, sub, type V3 } from "@earthrt/core";
import {
  altitude, basis, centerTarget, clampHeight, DEG, flyPath, geodetic, grabRotation, lookAt, orbit, rayEllipsoid,
  rotateAbout, zoomToward, type CamState,
} from "./math.ts";

export interface ControlsHost {
  /** Unit ray direction (ECEF) through a pixel of the canvas (CSS px). */
  ray(x: number, y: number): V3;
  /** Ground height at a point (m above the ellipsoid; NaN when unknown). */
  ground(lat: number, lon: number): number;
  /** Lowest the camera may be at a point. */
  floor(lat: number, lon: number): number;
  /** Something moved (render again). */
  changed(): void;
  /** A click without a drag (CSS px). */
  click?(x: number, y: number): void;
}

type Drag =
  | { kind: "grab"; grabbed: V3; x: number; y: number }
  | { kind: "spin"; x: number; y: number }
  | { kind: "orbit"; pivot: V3; x: number; y: number }
  | { kind: "look"; x: number; y: number };

export class Controls {
  state: CamState;
  /** While a flight runs: yaw and pitch of the look relative to the track (radians). */
  look = { yaw: 0, pitch: -10 * DEG };
  flying = false;
  private drag: Drag | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { d: number; a: number; mid: { x: number; y: number }; pivot: V3 | null } | null = null;
  private inertia: { axis: V3; rate: number; pivot?: V3; kind: "grab" | "heading" } | null = null;
  private lastMove: { t: number; axis: V3; angle: number } | null = null;
  private fly: { at: (t: number) => CamState; duration: number; t: number; done?: () => void } | null = null;
  private keys = new Set<string>();
  enabled = true;

  constructor(private readonly el: HTMLElement, private readonly host: ControlsHost, initial: CamState) {
    this.state = initial;
    el.addEventListener("pointerdown", this.onDown);
    el.addEventListener("pointermove", this.onMove);
    el.addEventListener("pointerup", this.onUp);
    el.addEventListener("pointercancel", this.onUp);
    el.addEventListener("wheel", this.onWheel, { passive: false });
    el.addEventListener("dblclick", this.onDbl);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("keydown", (e) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, select")) return;
      this.keys.add(e.key.toLowerCase());
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener("blur", () => this.keys.clear());
  }

  /** The point under a pixel: the ray against the terrain (ellipsoid raised to the ground there, refined twice). */
  pick(x: number, y: number): V3 | null {
    const d = this.host.ray(x, y);
    return this.pickRay(this.state.pos, d);
  }

  pickRay(o: V3, d: V3): V3 | null {
    let h = 0;
    let p = rayEllipsoid(o, d, h);
    for (let i = 0; i < 3 && p; i++) {
      const g = ecefToGeodetic(p[0], p[1], p[2]);
      const gh = this.host.ground(g.lat, g.lon);
      if (!Number.isFinite(gh) || Math.abs(gh - h) < 0.5) break;
      h = gh;
      p = rayEllipsoid(o, d, h) ?? p;
    }
    return p;
  }

  private stopMotion() {
    this.inertia = null;
    this.fly = null;
  }

  private down: { x: number; y: number; t: number; moved: number } | null = null;

  private onDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    this.down = this.pointers.size === 0 ? { x: e.offsetX, y: e.offsetY, t: performance.now(), moved: 0 } : null;
    this.el.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    this.stopMotion();
    if (this.pointers.size === 2) {
      this.startPinch();
      this.drag = null;
      return;
    }
    if (this.flying) {
      this.drag = { kind: "look", x: e.offsetX, y: e.offsetY };
      return;
    }
    const orbitDrag = e.button === 2 || e.ctrlKey || e.shiftKey || e.button === 1;
    if (orbitDrag) {
      const pivot = this.pick(this.el.clientWidth / 2, this.el.clientHeight / 2) ?? centerTarget(this.state);
      this.drag = { kind: "orbit", pivot, x: e.offsetX, y: e.offsetY };
      return;
    }
    const grabbed = this.pick(e.offsetX, e.offsetY);
    this.drag = grabbed ? { kind: "grab", grabbed, x: e.offsetX, y: e.offsetY } : { kind: "spin", x: e.offsetX, y: e.offsetY };
  };

  private startPinch() {
    const [a, b] = [...this.pointers.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), a: Math.atan2(b.y - a.y, b.x - a.x), mid, pivot: this.pick(mid.x, mid.y) };
  }

  private onMove = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    if (this.down) this.down.moved = Math.max(this.down.moved, Math.hypot(e.offsetX - this.down.x, e.offsetY - this.down.y));
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (this.pinch && this.pointers.size === 2) return this.movePinch();
    const d = this.drag;
    if (!d) return;
    const dx = e.offsetX - d.x, dy = e.offsetY - d.y;
    if (d.kind === "grab") {
      const r = grabRotation(this.state, d.grabbed, this.host.ray(e.offsetX, e.offsetY));
      if (r && r.angle > 0) {
        this.state = this.applyFloor(rotateAbout(this.state, r.axis, r.angle));
        this.recordMove(r.axis, r.angle);
      } else if (!r) {
        // past the horizon: turn the globe by the drag instead
        this.spinBy(dx, dy);
      }
    } else if (d.kind === "spin") this.spinBy(dx, dy);
    else if (d.kind === "orbit") {
      this.state = this.applyFloor(orbit(this.state, d.pivot, dx * 0.006, -dy * 0.005), true);
      this.recordMove([0, 0, 0], dx * 0.006);
    } else if (d.kind === "look") {
      this.look.yaw -= dx * 0.004;
      this.look.pitch = Math.max(-85 * DEG, Math.min(60 * DEG, this.look.pitch - dy * 0.004));
    }
    d.x = e.offsetX;
    d.y = e.offsetY;
    this.host.changed();
  };

  private spinBy(dx: number, dy: number) {
    const b = basis(this.state);
    const alt = Math.max(1, altitude(this.state));
    const k = Math.min(0.01, (alt / 6.4e6) * 0.002);
    const angle = Math.hypot(dx, dy) * k;
    if (!angle) return;
    // dragging right turns the globe so the near side moves right: about the camera's up and right
    const ax = norm([
      -b.up[0] * dx - b.right[0] * dy,
      -b.up[1] * dx - b.right[1] * dy,
      -b.up[2] * dx - b.right[2] * dy,
    ]);
    this.state = this.applyFloor(rotateAbout(this.state, ax, angle));
    this.recordMove(ax, angle);
  }

  private recordMove(axis: V3, angle: number) {
    const t = performance.now();
    if (this.lastMove && t - this.lastMove.t < 1) {
      this.lastMove.angle += angle;
      return;
    }
    this.lastMove = { t, axis, angle };
  }

  private movePinch() {
    const p = this.pinch!;
    const [a, b] = [...this.pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (this.flying) {
      this.look.yaw -= (mid.x - p.mid.x) * 0.004;
    } else {
      const target = p.pivot ?? centerTarget(this.state);
      // pinch: zoom toward the fingers' middle
      if (d > 0 && p.d > 0) this.zoomAt(target, p.d / d);
      // twist: heading; both fingers up or down: tilt
      this.state = this.applyFloor(orbit(this.state, target, -(ang - p.a), -(mid.y - p.mid.y) * 0.005), true);
      // the middle moving: grab
      if (p.pivot) {
        const r = grabRotation(this.state, p.pivot, this.host.ray(mid.x, mid.y));
        if (r && r.angle > 0) this.state = this.applyFloor(rotateAbout(this.state, r.axis, r.angle));
      }
    }
    p.d = d;
    p.a = ang;
    p.mid = mid;
    this.host.changed();
  }

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    const d0 = this.down;
    this.down = null;
    if (d0 && this.pointers.size === 0 && d0.moved < 5 && performance.now() - d0.t < 500 && e.button === 0) this.host.click?.(e.offsetX, e.offsetY);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 1) {
      // one finger left: continue as a grab from there
      const [p] = [...this.pointers.values()];
      const grabbed = this.flying ? null : this.pick(p.x, p.y);
      this.drag = this.flying ? { kind: "look", x: p.x, y: p.y } : grabbed ? { kind: "grab", grabbed, x: p.x, y: p.y } : null;
      return;
    }
    const d = this.drag;
    this.drag = null;
    const m = this.lastMove;
    this.lastMove = null;
    if (!d || !m || performance.now() - m.t > 80) return;
    if (d.kind === "grab" || d.kind === "spin") {
      const dt = Math.max(16, performance.now() - m.t + 16) / 1000;
      this.inertia = { axis: m.axis, rate: m.angle / dt, kind: "grab" };
    }
  };

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    if (this.flying) return;
    this.stopMotion();
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const f = Math.exp(Math.max(-1, Math.min(1, dy * 0.0016)));
    const target = this.pick(e.offsetX, e.offsetY) ?? centerTarget(this.state);
    this.zoomAt(target, f);
    this.host.changed();
  };

  /** Zoom toward a point by a factor of the distance, stopping at the floor and at 40,000 km out. */
  zoomAt(target: V3, f: number) {
    const dist = len(sub(this.state.pos, target));
    const maxDist = 4e7;
    f = Math.min(f, maxDist / Math.max(1, dist));
    let next = zoomToward(this.state, target, f);
    const g = geodetic(next.pos);
    const floor = this.host.floor(g.lat, g.lon);
    if (f < 1 && g.h < floor) {
      // as close as the floor allows along the same ray
      const cur = altitude(this.state);
      const tg = geodetic(target);
      const span = cur - tg.h;
      const k = span > 0 ? Math.max(0, Math.min(1, (floor - tg.h) / span)) : 1;
      next = zoomToward(this.state, target, Math.max(f, k));
    }
    this.state = this.applyFloor(next);
  }

  private onDbl = (e: MouseEvent) => {
    if (!this.enabled || this.flying) return;
    const p = this.pick(e.offsetX, e.offsetY);
    if (!p) return;
    const g = geodetic(p);
    const range = Math.max(300, len(sub(this.state.pos, p)) / (e.shiftKey || e.altKey ? 0.33 : 3));
    const b = this.state;
    const tilt = Math.min(60 * DEG, Math.max(0, Math.PI / 2 + b.pitch));
    this.flyTo(lookAt(g.lat, g.lon, g.h, range, b.heading, tilt));
  };

  /** Puts the camera there at once (the host resuming the map after the traced view). */
  jump(to: CamState) {
    this.inertia = null;
    this.fly = null;
    this.state = to;
  }

  flyTo(to: CamState, done?: () => void, duration?: number) {
    const p = flyPath(this.state, to);
    this.inertia = null;
    this.fly = { at: p.at, duration: duration ?? p.duration, t: 0, done };
  }

  get animating() { return !!this.fly || !!this.inertia || this.keys.size > 0; }

  private applyFloor(s: CamState, orbitMove = false): CamState {
    const g = geodetic(s.pos);
    const floor = this.host.floor(g.lat, g.lon);
    if (g.h >= floor) return s;
    // orbiting below the floor: refuse the move (it would tilt into a hill); others: lift
    return orbitMove ? this.state : clampHeight(s, floor);
  }

  /** Advances inertia, a fly-to and the keyboard by dt seconds. True when the camera moved. */
  update(dt: number): boolean {
    if (!this.enabled) return false;
    let moved = false;
    if (this.fly) {
      const f = this.fly;
      f.t = Math.min(1, f.t + dt / f.duration);
      this.state = this.applyFloor(f.at(f.t));
      moved = true;
      if (f.t >= 1) {
        this.fly = null;
        f.done?.();
      }
    }
    if (this.inertia && !this.drag) {
      const i = this.inertia;
      const angle = i.rate * dt;
      this.state = this.applyFloor(rotateAbout(this.state, i.axis, angle));
      i.rate *= Math.exp(-dt * 4);
      if (Math.abs(i.rate) < 1e-7) this.inertia = null;
      moved = true;
    }
    if (this.keys.size && !this.flying) moved = this.keyboard(dt) || moved;
    if (this.flying && this.keys.size) {
      const k = this.keys, r = 1.2 * dt;
      if (k.has("arrowleft") || k.has("a")) this.look.yaw += r;
      if (k.has("arrowright") || k.has("d")) this.look.yaw -= r;
      if (k.has("arrowup") || k.has("w")) this.look.pitch = Math.min(60 * DEG, this.look.pitch + r);
      if (k.has("arrowdown") || k.has("s")) this.look.pitch = Math.max(-85 * DEG, this.look.pitch - r);
      moved = true;
    }
    return moved;
  }

  private keyboard(dt: number): boolean {
    const k = this.keys;
    const alt = Math.max(50, altitude(this.state));
    const b = basis(this.state);
    let moved = false;
    // pan: about the Earth's centre, by a share of the height a second
    const pan = Math.min(0.5, (alt * 0.8 * dt) / 6.37e6);
    const fwdGround = norm(sub(b.forward, scaleDot(b.forward, this.state.pos)));
    const up = norm(this.state.pos);
    const axisF = norm(cross3(up, fwdGround)), axisR = fwdGround;
    const turn = (axis: V3, a: number) => { this.state = this.applyFloor(rotateAbout(this.state, axis, a)); moved = true; };
    if (k.has("arrowup") || k.has("w")) turn(axisF, pan);
    if (k.has("arrowdown") || k.has("s")) turn(axisF, -pan);
    if (k.has("arrowleft") || k.has("a")) turn(axisR, -pan);
    if (k.has("arrowright") || k.has("d")) turn(axisR, pan);
    const pivot = (k.has("q") || k.has("e") || k.has("r") || k.has("f")) ? this.pick(this.el.clientWidth / 2, this.el.clientHeight / 2) ?? centerTarget(this.state) : null;
    if (pivot && k.has("q")) { this.state = this.applyFloor(orbit(this.state, pivot, -dt, 0), true); moved = true; }
    if (pivot && k.has("e")) { this.state = this.applyFloor(orbit(this.state, pivot, dt, 0), true); moved = true; }
    if (pivot && k.has("r")) { this.state = this.applyFloor(orbit(this.state, pivot, 0, dt * 0.8), true); moved = true; }
    if (pivot && k.has("f")) { this.state = this.applyFloor(orbit(this.state, pivot, 0, -dt * 0.8), true); moved = true; }
    if (k.has("=") || k.has("+") || k.has("-") || k.has("_")) {
      const t = this.pick(this.el.clientWidth / 2, this.el.clientHeight / 2) ?? centerTarget(this.state);
      this.zoomAt(t, Math.exp((k.has("-") || k.has("_") ? 1 : -1) * dt * 1.5));
      moved = true;
    }
    return moved;
  }
}

function scaleDot(f: V3, pos: V3): V3 {
  const u = norm(pos);
  const d = f[0] * u[0] + f[1] * u[1] + f[2] * u[2];
  return [u[0] * d, u[1] * d, u[2] * d];
}
function cross3(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
