// The scene's time: a UTC moment that runs at `rate` scene seconds a second (`traced.time`; `utc=` / `time=` in play).
import { solarTime } from "../../packages/core/src/index.ts";

export class Clock {
  private base = NaN;
  private at = 0;
  rate = 1;
  /** UTC ms at scene time `t` (s); the real clock (`now`) until something set it. */
  utc(t: number, now: number): number {
    if (isNaN(this.base)) {
      this.base = now;
      this.at = t;
    }
    return this.base + (t - this.at) * 1000 * this.rate;
  }
  set(utc: number, t: number, rate = this.rate) {
    this.base = utc;
    this.at = t;
    this.rate = rate;
  }
  /** A local solar hour at a longitude on the poses' day (2026-06-21). */
  setSolar(hour: number, lon: number, t: number, rate = this.rate) {
    this.set(solarTime(Date.UTC(2026, 5, 21), lon, hour), t, rate);
  }
  shift(ms: number, t: number, now: number) {
    this.set(this.utc(t, now) + ms, t);
  }
  solarHour(lon: number, t: number, now: number): number {
    const u = this.utc(t, now);
    return (((u / 3_600_000 + lon / 15) % 24) + 24) % 24;
  }
}
