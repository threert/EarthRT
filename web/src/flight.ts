// Flights (ARCHITECTURE § 8): core's Flight track, the camera on it with the user's free look, played faster than real
// time, and the views it will need soon handed to the tile manager as look-ahead (lower priority, kept from eviction).
import { cross, Flight, type View } from "@earthrt/core";
import { findDestination, parseLatLon, type LatLon } from "./config.ts";
import { basis, DEG, fromVectors, geodetic, lookAt, rotate, type CamState } from "./camera/math.ts";
import type { App } from "./main.ts";

/** Seconds on screen for a flight of `d` metres: short hops quick, long ones about a minute and a half. */
export function screenSeconds(d: number): number {
  return Math.min(110, Math.max(20, 20 + Math.log10(1 + d / 10_000) * 30));
}

export class FlightRunner {
  flight: Flight | null = null;
  /** Seconds along the track (flight time). */
  t = 0;
  timeScale = 1;
  paused = false;
  from = "";
  to = "";
  onEnd: (() => void) | null = null;

  constructor(private readonly app: App) {}

  get active() { return !!this.flight; }
  get progress() { return this.flight ? this.t / this.flight.duration : 0; }

  /** A point from `lat,lon`, a destination's name, or a place's id. */
  async resolve(s: string): Promise<(LatLon & { name: string }) | null> {
    const ll = parseLatLon(s);
    if (ll) return { ...ll, name: s };
    const d = findDestination(s);
    if (d) return { lat: d.lat, lon: d.lon, name: d.name };
    if (/^[\w.-]+\/[\w.-]+\/[a-z0-9-]+$/.test(s)) {
      const p = await this.app.places.get(s).catch(() => null);
      if (p) return { lat: p.manifest.anchor.lat, lon: p.manifest.anchor.lon, name: p.manifest.title };
    }
    const hits = await this.app.places.search(s).catch(() => []);
    if (hits[0]) return { lat: hits[0].manifest.anchor.lat, lon: hits[0].manifest.anchor.lon, name: hits[0].manifest.title };
    return null;
  }

  async startFrom(from: string, to: string) {
    const [a, b] = await Promise.all([this.resolve(from), this.resolve(to)]);
    if (!a || !b) {
      this.app.ui?.toast(`Can't find ${!a ? from : to}`);
      return;
    }
    this.start(a, b);
  }

  start(a: LatLon & { name?: string }, b: LatLon & { name?: string }) {
    const ga = this.app.tiles.groundAt(a.lat, a.lon), gb = this.app.tiles.groundAt(b.lat, b.lon);
    const alt0 = (Number.isFinite(ga) ? ga : 0) + 1500, alt1 = (Number.isFinite(gb) ? gb : 0) + 1500;
    this.flight = new Flight({ from: { lat: a.lat, lon: a.lon, alt: alt0 }, to: { lat: b.lat, lon: b.lon, alt: alt1 } });
    this.t = 0;
    this.paused = false;
    this.from = a.name ?? `${a.lat.toFixed(3)}, ${a.lon.toFixed(3)}`;
    this.to = b.name ?? `${b.lat.toFixed(3)}, ${b.lon.toFixed(3)}`;
    const secs = this.app.launch.flightSeconds ?? screenSeconds(this.flight.distance);
    this.timeScale = this.flight.duration / secs;
    this.app.controls.look = { yaw: 0, pitch: -12 * DEG };
    this.app.controls.flying = true;
    this.app.ui?.flightStarted();
  }

  stop() {
    if (!this.flight) return;
    // hand the camera back where the flight left it
    this.app.controls.state = this.pose(this.app.controls.look);
    this.flight = null;
    this.app.controls.flying = false;
    this.app.ui?.flightEnded();
    this.onEnd?.();
  }

  update(dt: number) {
    if (!this.flight || this.paused) return;
    this.t = Math.min(this.flight.duration, this.t + dt * this.timeScale);
    if (this.t >= this.flight.duration) {
      const end = this.flight.plan.to;
      const s = this.pose(this.app.controls.look);
      this.stop();
      // settle into a look at the destination
      this.app.controls.state = s;
      this.app.controls.flyTo(lookAt(end.lat, end.lon, 0, 6000, s.heading, 55 * DEG));
    }
  }

  /** The camera on the track at `t` with a look (yaw, pitch relative to the track). */
  poseAt(t: number, look: { yaw: number; pitch: number }): CamState {
    const p = this.flight!.at(t);
    const right = cross(p.forward, p.up);
    const f1 = rotate(p.forward, p.up, look.yaw), r1 = rotate(right, p.up, look.yaw);
    const f2 = rotate(f1, r1, look.pitch), u2 = rotate(p.up, r1, look.pitch);
    return fromVectors(p.position, f2, u2);
  }

  pose(look: { yaw: number; pitch: number }): CamState {
    return this.poseAt(this.t, look);
  }

  /** Views the flight will have over the next ~12 s on screen, every ~2 s. */
  lookaheadViews(): View[] | undefined {
    if (!this.flight || this.paused) return undefined;
    const out: View[] = [];
    const { w, h } = this.app.size;
    const horizon = 12 * this.timeScale, step = 2 * this.timeScale;
    for (let s = this.t + step; s <= Math.min(this.flight.duration, this.t + horizon); s += step) {
      const c = this.poseAt(s, { yaw: this.app.controls.look.yaw, pitch: this.app.controls.look.pitch });
      const b = basis(c);
      // a wider view than the screen's: the user may look around
      out.push({ position: c.pos, forward: b.forward, up: b.up, fov: Math.min(100, this.app.fov * 1.4) * DEG, aspect: w / h, height: h });
    }
    return out;
  }

  /** Where the flight is (for the progress bar). */
  info() {
    if (!this.flight) return null;
    const p = this.flight.at(this.t);
    const g = geodetic(p.position);
    return { progress: this.progress, alt: g.h, remaining: (this.flight.duration - this.t) / this.timeScale, from: this.from, to: this.to, distance: this.flight.distance };
  }
}
