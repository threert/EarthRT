// The attribution line, and with ?debug the overlay: tiles shown / in flight / queued, bytes, decode ms, GPU MB, fps.
import type { App } from "../main.ts";

export class Hud {
  private readonly el: HTMLElement | null;
  private readonly attr = document.getElementById("attribution");
  private acc = 0;
  private frames = 0;
  fps = 0;

  constructor(debug: boolean) {
    this.el = debug ? document.getElementById("debug") : null;
    if (this.el) this.el.hidden = false;
  }

  attribution(lines: string[]) {
    if (this.attr) this.attr.textContent = lines.join(" · ");
  }

  update(app: App, dt: number) {
    this.acc += dt;
    this.frames++;
    if (this.acc < 0.25) return;
    this.fps = this.frames / this.acc;
    this.acc = 0;
    this.frames = 0;
    if (!this.el) return;
    const s = app.tiles.stats;
    const lat = [...s.latencies].sort((a, b) => a - b);
    const pct = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))].toFixed(0) : "–");
    const boot = window.__ert?.t0 ?? 0;
    this.el.textContent = [
      `${this.fps.toFixed(0)} fps  ${app.globe.gpuInfo().replace(/^ANGLE \(|\)$/g, "").slice(0, 48)}`,
      `tiles shown ${s.shown}  buildings ${s.buildingsShown}  in flight ${s.inFlight}  queued ${s.queued}`,
      `resident ${s.resident}  GPU ${(s.gpuBytes / 1048576).toFixed(1)} / ${(app.tiles.gpuBudget / 1048576).toFixed(0)} MB`,
      `net ${(s.netBytes / 1048576).toFixed(2)} MB  ${s.requests} req  ${s.cacheHits} cached  fail ${s.failures}`,
      `latency p50 ${pct(0.5)} ms  p95 ${pct(0.95)} ms  decode ${(s.decodeMs / Math.max(1, s.decoded)).toFixed(1)} ms/tile`,
      `first globe ${app.firstGlobeMs > 0 ? (app.firstGlobeMs - boot).toFixed(0) + " ms" : "…"}  holes ${app.holes}  coarse ${app.coarseFrames}`,
      `source ${app.source.dev ? "dev (Terrarium)" : app.source.meta.gen}  places ${app.places.chosen.size} (${app.places.loaded.size} loaded)`,
    ].join("\n");
  }
}
