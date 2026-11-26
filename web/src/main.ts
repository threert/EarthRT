// EarthRT on the web: the page's boot script (index.html) has already asked for meta.json and the top pack; this
// starts the renderer, the tile workers and the navigation, and runs the frame loop.
import { ecefToGeodetic, geodeticToEcef, solarTime, sunDirection, type V3, type View } from "@earthrt/core";
import { parseLaunch, type Launch } from "./config.ts";
import { Globe, type TileObject } from "./render/globe.ts";
import { TilePool } from "./tiles/pool.ts";
import { TileManager, type TileMeta, type TileSource } from "./tiles/manager.ts";
import { DEV_META } from "./tiles/dev-source.ts";
import { gpuBudgetFor } from "./tiles/budget.ts";
import { Controls } from "./camera/controls.ts";
import { basis, DEG, fromVectors, geodetic, lookAt, minHeight, rotate, type CamState } from "./camera/math.ts";
import { Hud } from "./ui/hud.ts";
import { Places } from "./places/places.ts";
import { FlightRunner } from "./flight.ts";
import { Ui } from "./ui/ui.ts";
import { connectHost, serviceUrl } from "./host.ts";
import { Embed } from "./embed.ts";

declare global {
  interface Window {
    __ert?: { t0: number; meta: Promise<TileMeta | null>; top: Promise<ArrayBuffer | null>; api: string };
    earth?: App;
  }
}

// SPEC § 2: the web refines while a tile's error is over 6 px (8 on phones): at 2.5 a 3 km oblique view wants ~1,000
// tiles, at 6 about 290, and by eye they look the same (out/dev/r2).
const SSE_THRESHOLD = 6;

export class App {
  readonly launch: Launch;
  readonly globe: Globe;
  readonly pool: TilePool;
  tiles!: TileManager<TileObject>;
  controls!: Controls;
  readonly hud: Hud;
  places!: Places;
  flight!: FlightRunner;
  ui!: Ui;
  source!: TileSource;
  readonly canvas: HTMLCanvasElement;
  /** Simulated UTC time (ms) and whether it follows the clock. */
  time = Date.now();
  liveTime = true;
  /** Scene seconds a second while the time is not live (the host's `earth.time` rate). */
  timeRate = 0;
  /** The host's link (SPEC § 6.1), when embedded. */
  embed: Embed | null = null;
  paused = false;
  settings: { sse?: number; buildings: boolean; labels: boolean; quality: "web" | "app" } = { buildings: true, labels: true, quality: "web" };
  fov = 45;
  frameNo = 0;
  holes = 0;
  coarseFrames = 0;
  firstGlobeMs = -1;
  private last = performance.now();
  private started = performance.now();
  /** Probe hooks: frame records while recording. */
  record: { t: number; hole: boolean; coarse: number; shown: number; gpu: number; inFlight: number; alt: number }[] | null = null;
  mobile = matchMedia("(pointer: coarse)").matches;
  dpr = 1;
  /** 6 px on desktops, 8 on phones (slower networks, smaller GPUs), unless the page says otherwise. */
  get sse() { return this.settings.sse ?? this.launch.sse ?? (this.settings.quality === "app" ? 4 : this.mobile ? 8 : SSE_THRESHOLD); }
  /** A service URL as this page fetches it (in the app: through its `ert://` scheme). */
  svc(url: string) { return serviceUrl(url, this.launch.host === "app"); }
  private width = 1;
  private height = 1;

  constructor() {
    this.launch = parseLaunch(location.search);
    this.canvas = document.getElementById("globe") as HTMLCanvasElement;
    // in the app the page is snapshotted by the host's tests (WKWebView.takeSnapshot): keep the drawing buffer
    this.globe = new Globe(this.canvas, this.mobile ? 0 : 4, this.launch.host === "app");
    this.pool = new TilePool();
    this.pool.fetchInMain = this.launch.host === "app";
    this.hud = new Hud(this.launch.debug);
    const link = connectHost(this.launch.host, this.launch.parent);
    if (link) {
      this.embed = new Embed(this, link);
      document.documentElement.classList.add("embedded", `embedded-${link.kind}`);
    }
  }

  async start() {
    const boot = window.__ert;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.globe.precompute();
    this.source = await this.findSource(boot);
    const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    this.tiles = new TileManager(this.source, this.pool, this.globe, gpuBudgetFor(deviceMemory, this.mobile), 12);
    this.tiles.onStale = () => this.refreshSource();
    this.initTime();
    const ex = Number(new URLSearchParams(location.search).get("exposure"));
    if (ex > 0) this.globe.baseExposure = ex;
    this.controls = new Controls(this.canvas, {
      ray: (x, y) => this.globe.ray(x, y, basis(this.controls.state), this.width, this.height),
      ground: (lat, lon) => this.tiles.groundAt(lat, lon),
      floor: (lat, lon) => this.floorAt(lat, lon),
      changed: () => {},
      click: (x, y) => this.embed?.pick(x, y),
    }, this.initialView());
    this.places = new Places(this);
    this.flight = new FlightRunner(this);
    this.ui = new Ui(this);
    // the top pack: z0–z2 and the caps at once
    if (!this.source.dev && boot) {
      boot.top.then(async (buf) => {
        if (!buf) return;
        const tiles = await this.pool.unpack(buf);
        this.tiles.addBatch(tiles);
      }).catch((e) => console.warn("top pack", e));
    }
    this.hud.attribution(this.source.meta.attribution);
    requestAnimationFrame(this.frame);
    // after the first picture: the materials' detail, old caches
    setTimeout(() => {
      this.globe.makeNoise();
      this.dropOldCaches();
    }, 300);
    if (this.launch.place) this.places.open(this.launch.place, true);
    if (this.launch.fly) this.flight.startFrom(this.launch.fly.from, this.launch.fly.to);
    if (this.launch.dev) this.places.loadDev(this.launch.dev);
    this.embed?.ready();
  }

  /** The host covers the map (the traced view): no drawing, no fetching. */
  setPaused(p: boolean) {
    if (p === this.paused) return;
    this.paused = p;
    if (!p) {
      this.last = performance.now();
      requestAnimationFrame(this.frame);
    }
  }

  /** The host's settings (SPEC § 6.1): refinement, buildings, labels, and the app's budgets. */
  applySettings(s: { sse?: number; buildings?: boolean; labels?: boolean; quality?: "web" | "app" }) {
    if (s.sse !== undefined) this.settings.sse = Math.max(0.5, Math.min(32, s.sse));
    if (s.buildings !== undefined) this.settings.buildings = s.buildings;
    if (s.labels !== undefined) {
      this.settings.labels = s.labels;
      document.documentElement.classList.toggle("no-labels", !s.labels);
    }
    if (s.quality) {
      this.settings.quality = s.quality;
      const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
      // the app: a GPU budget of its own (1 GiB), the screen's full resolution, finer refinement (sse 4)
      this.tiles.gpuBudget = s.quality === "app" ? 1024 << 20 : gpuBudgetFor(deviceMemory, this.mobile);
      this.resize();
    }
  }

  private async findSource(boot: Window["__ert"]): Promise<TileSource> {
    const api = this.launch.api || "";
    let meta: TileMeta | null = null;
    if (!this.launch.devTiles) {
      try {
        meta = api && api !== boot?.api ? await fetch(this.svc(`${api}/tiles/v1/meta.json`)).then((r) => (r.ok ? r.json() : null)) : await (boot?.meta ?? null);
      } catch { meta = null; }
    }
    if (meta && meta.gen && meta.terrain) return this.serviceSource(meta, api);
    console.info("EarthRT: no tile service answered; using the dev tile source (AWS Terrain Tiles made into compact tiles here)");
    return { meta: DEV_META as TileMeta, dev: true, cache: null, url: (_layer, key) => `dev:terrain/${key}` };
  }

  private staleAt = 0;
  /** The service's generation moved on (a 404): read meta.json again and ask for the new generation's tiles from now
   *  on. What is loaded stays until the view replaces it. */
  private async refreshSource() {
    if (this.source.dev || performance.now() - this.staleAt < 10_000) return;
    this.staleAt = performance.now();
    const api = this.launch.api || "";
    const meta = await fetch(this.svc(`${api}/tiles/v1/meta.json`), { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null) as TileMeta | null;
    if (!meta?.gen || meta.gen === this.source.meta.gen) return;
    console.info(`EarthRT: tiles moved from ${this.source.meta.gen} to ${meta.gen}`);
    this.source = this.serviceSource(meta, api);
    this.tiles.source = this.source;
    this.hud.attribution(meta.attribution);
    this.dropOldCaches();
  }

  private serviceSource(meta: TileMeta, api: string): TileSource {
    const base = this.svc(`${api}/tiles/v1/${meta.gen}`);
    // (in the app its own disk cache keeps the files: Cache Storage takes http(s) only)
    return { meta, dev: false, cache: this.launch.host === "app" ? null : `earthrt-tiles-${meta.gen}`, url: (layer, key) => `${base}/${layer}/${key}.c.ert` };
  }

  private async dropOldCaches() {
    if (typeof caches === "undefined" || !this.source.cache) return;
    for (const k of await caches.keys()) if (k.startsWith("earthrt-tiles-") && k !== this.source.cache) caches.delete(k);
  }

  private initTime() {
    const l = this.launch;
    if (l.time !== undefined) {
      this.time = l.time;
      this.liveTime = false;
    }
  }

  /** Where the camera starts: `at`, else above the user's longitude (by their time zone), in daylight. */
  private initialView(): CamState {
    const at = this.launch.at;
    if (at) {
      const pitch = at.pitch ?? (at.alt > 100_000 ? -90 : -35);
      const s = { pos: geodeticToEcef(at.lat, at.lon, at.alt), heading: (at.heading ?? 0) * DEG, pitch: pitch * DEG };
      if (this.launch.hour !== undefined) this.setSolarHour(this.launch.hour, at.lon);
      return s;
    }
    const lon = Math.max(-180, Math.min(180, (-new Date().getTimezoneOffset() / 60) * 15));
    const lat = 22;
    if (this.launch.hour !== undefined) this.setSolarHour(this.launch.hour, lon);
    else if (this.launch.time === undefined) {
      const h = ((((Date.now() / 3600000 + lon / 15) % 24) + 24) % 24);
      // night where the user is: show the globe at late morning instead (the time control says so)
      if (h < 7.5 || h > 17) this.setSolarHour(10.5, lon);
    }
    return lookAt(lat, lon, 0, 19_000_000, 0, 0);
  }

  setSolarHour(hour: number, lon: number) {
    this.time = solarTime(Date.now(), lon, hour);
    this.liveTime = false;
  }

  /** The camera's floor at a point (SPEC/ARCHITECTURE § 4): a place's minDistance inside it, else 300 m. */
  floorAt(lat: number, lon: number): number {
    const ground = this.tiles.groundAt(lat, lon);
    const z = this.tiles.zoomAt(lat, lon);
    const placeMin = this.places?.minDistanceAt(lat, lon);
    return minHeight(ground, z, placeMin);
  }

  private resize() {
    const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
    this.width = w;
    this.height = h;
    this.dpr = this.launch.dpr ?? Math.min(window.devicePixelRatio || 1, this.settings.quality === "app" ? 3 : 2);
    this.globe.resize(w, h, this.dpr);
    // the vertical field of view: 45° in landscape; in portrait, wide enough to keep a landscape's sideways view
    const a = w / h;
    this.fov = a >= 1 ? 45 : Math.min(75, (2 * Math.atan((Math.tan((22.5 * Math.PI) / 180) * 0.8) / a) * 180) / Math.PI);
  }

  get size() { return { w: this.width, h: this.height }; }

  /** The camera this frame: the user's, or the flight's with the user's look. */
  cameraState(): CamState {
    if (this.flight.active) return this.flight.pose(this.controls.look);
    return this.controls.state;
  }

  view(s: CamState): View {
    const b = basis(s);
    return { position: s.pos, forward: b.forward, up: b.up, fov: this.fov * DEG, aspect: this.width / this.height, height: this.height };
  }

  private frame = (now: number) => {
    if (this.paused) return;
    requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.frameNo++;
    if (this.liveTime) this.time = Date.now();
    else if (this.timeRate) this.time += dt * 1000 * this.timeRate;
    else if (this.ui?.timePlaying) this.time += dt * 3600_000 * this.ui.timeSpeed;
    this.controls.update(dt);
    this.flight.update(dt);
    const s = this.cameraState();
    const b = basis(s);
    this.globe.setCamera(s.pos, b, this.fov);
    const lookahead = this.flight.lookaheadViews();
    const f = this.tiles.update(this.view(s), { threshold: this.sse, lookahead });
    this.places.update(s);
    this.globe.setSun(sunDirection(this.time));
    this.globe.buildingsMat.uniforms.uHoleCount.value = this.places.holes(this.globe.buildingsMat.uniforms.uHoles.value);
    this.globe.terrainMat.uniforms.uHoleCount.value = this.places.holes(this.globe.terrainMat.uniforms.uHoles.value, "terrain");
    this.globe.render(f.terrain, this.settings.buildings ? f.buildings : [], (now - this.started) / 1000);
    if (f.hole) this.holes++;
    if (f.coarse > 0) this.coarseFrames++;
    if (this.firstGlobeMs < 0 && !f.hole) {
      this.firstGlobeMs = performance.now();
      performance.mark("earthrt-first-globe");
      document.documentElement.classList.add("ready");
    }
    this.record?.push({ t: now, hole: f.hole, coarse: f.coarse, shown: f.terrain.length, gpu: this.tiles.gpuBytes, inFlight: this.tiles.stats.inFlight, alt: geodetic(s.pos).h });
    this.ui.frame(s);
    this.hud.update(this, dt);
    this.embed?.frame(now, dt);
  };

  /** Fly the camera to a view (search results, places, destinations). */
  goTo(s: CamState, done?: () => void) {
    this.flight.stop();
    this.controls.flyTo(s, done);
  }

  /** A view of a point from a range, keeping something of the current heading. */
  viewOf(lat: number, lon: number, h: number, range: number, headingDeg?: number, tiltDeg = 45): CamState {
    return lookAt(lat, lon, h, range, headingDeg !== undefined ? headingDeg * DEG : this.controls.state.heading, tiltDeg * DEG);
  }
}

export { ecefToGeodetic, fromVectors, rotate };
export type { V3 };

const app = new App();
window.earth = app;
app.start().catch((e) => {
  console.error(e);
  document.getElementById("veil")?.classList.add("failed");
});
