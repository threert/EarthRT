// The map engine and its host (SPEC § 6.1): what the map reports (earth.view, places, selected, pick, near, flight,
// status) and what it does when the host asks (goto, gotoPlace, select, choose, fly, stop, time, dev, pause,
// settings). Hosted, the map draws no interface of its own: the host's does.
import { ENTER_FROM, geodeticToEcef, haversine, placeRadius, solarTime, topicBase, type PlaceManifest, type PlaceRecord } from "@earthrt/core";
import { DEG, geodetic } from "./camera/math.ts";
import { nearPlace, Throttle, type HostLink, type HostMessage } from "./host.ts";
import type { App } from "./main.ts";

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const r = (v: number, d = 6) => Math.round(v * 10 ** d) / 10 ** d;

export class Embed {
  private view = new Throttle(10);
  private placesKey = "";
  private near = new Set<string>();
  private lastStatus = 0;
  private lastFlight = 0;
  private flightState: "idle" | "flying" | "done" = "idle";
  private frameMs: number[] = [];
  private errorsSeen = 0;
  selected: string | null = null;

  constructor(private readonly app: App, readonly link: HostLink) {
    link.onMessage = (m) => {
      try {
        this.receive(m);
      } catch (e) {
        console.warn("earth.* from the host", m, e);
      }
    };
  }

  send(msg: HostMessage) {
    this.link.send(msg);
  }

  /** Once the engine runs: the host may send its choices, settings and time now. */
  ready() {
    this.send({ t: "earth.ready", v: 1 });
  }

  // ------------------------------------------------------------------------------------------------- map → host

  /** Every frame (after it is drawn). */
  frame(now: number, dt: number) {
    const app = this.app;
    this.frameMs.push(dt * 1000);
    if (this.frameMs.length > 120) this.frameMs.shift();
    const s = app.cameraState();
    const g = geodetic(s.pos);
    const ground = app.tiles.groundAt(g.lat, g.lon);
    const key = [r(g.lat), r(g.lon), r(g.h, 1), r(s.heading, 4), r(s.pitch, 4), app.fov, Math.round(app.time / 60_000)].join();
    if (this.view.due(key, now)) {
      this.send({
        t: "earth.view", lat: g.lat, lon: g.lon, alt: g.h, heading: ((s.heading / DEG) % 360 + 360) % 360, pitch: s.pitch / DEG,
        fov: app.fov, ground: Number.isFinite(ground) ? ground : null, utc: app.time,
      });
    }
    this.places(g, ground);
    this.flight(now);
    if (now - this.lastStatus > 1000) {
      this.lastStatus = now;
      const st = app.tiles.stats;
      const errors = st.lastErrors.slice(this.errorsSeen);
      this.errorsSeen = st.lastErrors.length;
      const ms = [...this.frameMs].sort((a, b) => a - b);
      this.send({
        t: "earth.status", tiles: { shown: st.shown, inFlight: st.inFlight, queued: st.queued }, bytes: st.netBytes,
        gpuMB: Math.round(app.tiles.gpuBytes / 1048576), frameMs: ms.length ? r(ms[Math.floor(ms.length / 2)], 1) : 0,
        ...(errors.length ? { errors } : {}),
      });
    }
  }

  private places(g: { lat: number; lon: number; h: number }, ground: number) {
    const app = this.app;
    const list = app.places.markers().map((p) => {
      const m = p.manifest;
      const l = app.places.loaded.get(p.id);
      const horizontal = haversine(g.lat, g.lon, m.anchor.lat, m.anchor.lon);
      const anchorH = (l?.ground ?? 0) + (m.anchor.height ?? 0);
      const distance = Math.hypot(horizontal, g.h - anchorH);
      return { p, horizontal, distance, loaded: l?.state === "ready" };
    });
    const key = list.map((x) => `${x.p.id}:${x.loaded ? 1 : 0}`).sort().join("|");
    if (key !== this.placesKey) {
      this.placesKey = key;
      this.send({
        t: "earth.places",
        list: list.map(({ p, distance, loaded }) => ({
          id: p.id, title: p.manifest.title, kind: p.manifest.kind, topic: p.topic, anchor: p.manifest.anchor, chosen: true, loaded, distance: Math.round(distance),
        })),
      });
    }
    // earth.near: once each time the camera comes within a place's enterFrom
    const hag = Number.isFinite(ground) ? g.h - ground : g.h;
    for (const x of list) {
      const m = x.p.manifest as PlaceManifest & { enterFrom?: number };
      const n = nearPlace(m.kind, m.enterFrom ?? ENTER_FROM[m.kind], x.horizontal, hag, x.distance, placeRadius(m));
      if (n.near && !this.near.has(x.p.id)) {
        this.near.add(x.p.id);
        this.send({ t: "earth.near", id: x.p.id, distance: Math.round(n.distance * 10) / 10 });
      } else if (!n.near) this.near.delete(x.p.id);
    }
  }

  private flight(now: number) {
    const f = this.app.flight;
    const info = f.info();
    if (info) {
      if (this.flightState !== "flying" || now - this.lastFlight > 1000) {
        this.flightState = "flying";
        this.lastFlight = now;
        this.send({ t: "earth.flight", state: "flying", ...this.flightFields() });
      }
    } else if (this.flightState === "flying") {
      this.flightState = "done";
      this.send({ t: "earth.flight", state: "done" });
      this.flightState = "idle";
    }
  }

  private flightFields() {
    const f = this.app.flight;
    const p = f.flight!.plan;
    // (`t` is the message's type: the flight's time is `time`, its length `duration`, seconds of flight time)
    return { time: f.t, duration: f.flight!.duration, progress: f.progress, from: { lat: p.from.lat, lon: p.from.lon, alt: p.from.alt, name: f.from }, to: { lat: p.to.lat, lon: p.to.lon, alt: p.to.alt, name: f.to } };
  }

  /** The user picked a place on the map (a marker) or none. */
  async select(p: PlaceRecord | null) {
    this.selected = p?.id ?? null;
    if (!p) return this.send({ t: "earth.selected", id: null, versions: [] });
    const chosen = this.app.places.chosen.get(topicBase(p.topic));
    let versions: PlaceRecord[] = [p];
    try { versions = await this.app.places.versions(p.topic); } catch { /* the registry is away: this one */ }
    this.send({
      t: "earth.selected", id: p.id,
      versions: versions.map((v) => ({ id: v.id, title: v.manifest.title, author: v.author, likes: v.likes, stars: v.stars, topic: v.topic, ...(v.manifest.era ? { era: v.manifest.era } : {}), chosen: chosen?.id === v.id })),
    });
  }

  /** A click on the globe (no drag): where, and the place there if any. */
  pick(x: number, y: number) {
    const pt = this.app.controls.pick(x, y);
    if (!pt) return;
    const g = geodetic(pt);
    let place: string | undefined;
    for (const p of this.app.places.markers()) {
      const m = p.manifest;
      if (haversine(g.lat, g.lon, m.anchor.lat, m.anchor.lon) <= placeRadius(m)) place = p.id;
    }
    this.send({ t: "earth.pick", lat: g.lat, lon: g.lon, h: g.h, ...(place ? { place } : {}) });
  }

  // ------------------------------------------------------------------------------------------------- host → map

  receive(m: HostMessage) {
    const app = this.app;
    switch (m.t) {
      case "earth.goto": {
        const lat = num(m.lat), lon = num(m.lon), alt = num(m.alt);
        if (lat === undefined || lon === undefined || alt === undefined) return;
        const heading = (num(m.heading) ?? app.controls.state.heading / DEG) * DEG, pitch = (num(m.pitch) ?? -35) * DEG;
        if (num(m.fov)) app.fov = num(m.fov)!;
        const s = { pos: geodeticToEcef(lat, lon, alt), heading, pitch };
        app.flight.stop();
        const seconds = num(m.seconds);
        if (seconds === 0) app.controls.jump(s);
        else app.controls.flyTo(s, undefined, seconds);
        return;
      }
      case "earth.gotoPlace":
        if (typeof m.id === "string") app.places.open(m.id, true);
        return;
      case "earth.select": {
        const id = typeof m.id === "string" ? m.id : null;
        if (!id) return void this.select(null);
        app.places.get(id).then((p) => this.select(p)).catch(() => {});
        return;
      }
      case "earth.choose":
        if (typeof m.topic === "string" && typeof m.id === "string") app.places.setChoice(m.topic, m.id);
        return;
      case "earth.fly": {
        const end = (v: unknown) => (typeof v === "string" ? v : v && typeof v === "object" ? v as { lat: number; lon: number; alt?: number } : null);
        const from = end(m.from), to = end(m.to);
        if (!from || !to) return;
        app.flight.startFrom(from, to, { cruise: num(m.cruise), speed: num(m.speed) });
        return;
      }
      case "earth.stop":
        app.flight.stop();
        return;
      case "earth.time": {
        const rate = num(m.rate);
        if (num(m.utc) !== undefined) app.time = num(m.utc)!;
        else if (num(m.solarHour) !== undefined) app.time = solarTime(app.time, geodetic(app.cameraState().pos).lon, num(m.solarHour)!);
        app.liveTime = false;
        app.timeRate = rate ?? 0;
        return;
      }
      case "earth.dev":
        if (typeof m.base === "string" && m.manifest && typeof m.manifest === "object") app.places.showDev(m.base, m.manifest as PlaceManifest);
        return;
      case "earth.pause":
        app.setPaused(!!m.paused);
        return;
      case "earth.settings":
        app.applySettings({
          sse: num(m.sse), buildings: typeof m.buildings === "boolean" ? m.buildings : undefined,
          labels: typeof m.labels === "boolean" ? m.labels : undefined, quality: m.quality === "app" || m.quality === "web" ? m.quality : undefined,
        });
        return;
    }
  }
}
