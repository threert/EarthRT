// The page's controls: search (destinations, places, coordinates), place markers and the place panel (versions, eras,
// likes and stars, Go there, Open in EarthRT), flights (from → to, progress, free look), the sun's time, a readout.
// Plain DOM; the markup is in index.html.
import { geodeticToEcef, placeRadius, solarTime, topicBase, VISIBLE_FROM, type PlaceRecord } from "@earthrt/core";
import { DESTINATIONS, parseLatLon, type Destination } from "../config.ts";
import { geodetic, type CamState } from "../camera/math.ts";
import type { App } from "../main.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

type Result =
  | { kind: "dest"; d: Destination }
  | { kind: "place"; p: PlaceRecord }
  | { kind: "point"; lat: number; lon: number };

export function formatAlt(m: number): string {
  if (m >= 100_000) return `${Math.round(m / 1000).toLocaleString("en")} km`;
  if (m >= 10_000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m).toLocaleString("en")} m`;
}

export function formatHour(h: number): string {
  const hh = Math.floor(((h % 24) + 24) % 24), mm = Math.floor((h - Math.floor(h)) * 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** The deep link that opens the same view in the EarthRT app (SPEC § 7): the page's own parameters. */
export function appLink(params: Record<string, string>): string {
  const q = new URLSearchParams(params).toString();
  return `earthrt://open${q ? `?${q}` : ""}`;
}

export class Ui {
  timePlaying = false;
  timeSpeed = 1;
  private markerEls = new Map<string, HTMLButtonElement>();
  private panelPlace: PlaceRecord | null = null;
  private results: Result[] = [];
  private searchSeq = 0;
  private readoutAt = 0;

  constructor(private readonly app: App) {
    this.search($("search") as HTMLInputElement, $("results"), (r) => this.go(r));
    $("panel-close").onclick = () => this.hidePlace();
    $("fly-open").onclick = () => this.toggleFlyForm();
    $("fly-form").onsubmit = (e) => {
      e.preventDefault();
      const from = ($("fly-from") as HTMLInputElement).value.trim();
      const to = ($("fly-to") as HTMLInputElement).value.trim();
      if (!to) return;
      $("fly-form").hidden = true;
      if (!from || from.toLowerCase() === "here") {
        const g = geodetic(this.app.controls.state.pos);
        this.app.flight.startFrom(`${g.lat.toFixed(5)},${g.lon.toFixed(5)}`, to).then(() => {
          if (this.app.flight.active) this.app.flight.from = "Here";
        });
      } else this.app.flight.startFrom(from, to);
    };
    $("fly-pause").onclick = () => {
      this.app.flight.paused = !this.app.flight.paused;
      $("fly-pause").textContent = this.app.flight.paused ? "Resume" : "Pause";
    };
    $("fly-stop").onclick = () => this.app.flight.stop();
    $("fly-speed").onclick = () => {
      const f = this.app.flight;
      const k = f.timeScale;
      const next = $("fly-speed").textContent === "1×" ? 2 : $("fly-speed").textContent === "2×" ? 4 : 1;
      const prev = Number(($("fly-speed").textContent ?? "1").replace("×", "")) || 1;
      f.timeScale = (k / prev) * next;
      $("fly-speed").textContent = `${next}×`;
    };
    const slider = $("time") as HTMLInputElement;
    slider.oninput = () => {
      const g = geodetic(this.app.cameraState().pos);
      this.app.time = solarTime(this.app.time, g.lon, Number(slider.value));
      this.app.liveTime = false;
      this.updateTimeLabel();
    };
    $("time-now").onclick = () => {
      this.app.liveTime = true;
      this.app.time = Date.now();
    };
    $("attribution").onclick = () => $("attribution").classList.toggle("open");
    const dl = $("destinations");
    for (const d of DESTINATIONS) {
      const b = document.createElement("button");
      b.textContent = d.name;
      b.onclick = () => this.go({ kind: "dest", d });
      dl.appendChild(b);
    }
    $("open-app").onclick = () => (location.href = appLink(this.linkParams()));
  }

  /** What the page shows now, as launch parameters: the camera, the open place, the flight. */
  linkParams(): Record<string, string> {
    const s = this.app.cameraState(), g = geodetic(s.pos);
    const out: Record<string, string> = { at: `${g.lat.toFixed(5)},${g.lon.toFixed(5)},${Math.round(g.h)},${((s.heading * 180) / Math.PI).toFixed(1)},${((s.pitch * 180) / Math.PI).toFixed(1)}` };
    if (this.panelPlace && !this.panelPlace.id.startsWith("dev/")) out.place = this.panelPlace.id;
    const f = this.app.flight.flight;
    if (f) out.fly = `${f.plan.from.lat.toFixed(5)},${f.plan.from.lon.toFixed(5)};${f.plan.to.lat.toFixed(5)},${f.plan.to.lon.toFixed(5)}`;
    return out;
  }

  // ------------------------------------------------------------------------------------------------------ search

  private search(input: HTMLInputElement, list: HTMLElement, pick: (r: Result) => void) {
    let timer = 0;
    const render = () => {
      list.innerHTML = "";
      list.hidden = !this.results.length || document.activeElement !== input;
      for (const [i, r] of this.results.entries()) {
        const li = document.createElement("li");
        li.tabIndex = -1;
        li.dataset.i = String(i);
        li.innerHTML = r.kind === "dest" ? `<b>${esc(r.d.name)}</b><span>destination</span>`
          : r.kind === "place" ? `<b>${esc(r.p.manifest.title)}</b><span>${esc(r.p.manifest.kind)} · ${esc(r.p.author)}</span>`
          : `<b>${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}</b><span>coordinates</span>`;
        li.onpointerdown = (e) => {
          e.preventDefault();
          pick(r);
          input.blur();
          list.hidden = true;
        };
        list.appendChild(li);
      }
    };
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      const seq = ++this.searchSeq;
      const local: Result[] = [];
      const ll = parseLatLon(q);
      if (ll) local.push({ kind: "point", ...ll });
      if (q) for (const d of DESTINATIONS) if (d.name.toLowerCase().includes(q.toLowerCase())) local.push({ kind: "dest", d });
      this.results = local;
      render();
      if (q.length < 2 || !this.app.places.available) return;
      timer = window.setTimeout(() => {
        this.app.places.search(q).then((ps) => {
          if (seq !== this.searchSeq) return;
          this.results = [...local, ...ps.map((p) => ({ kind: "place" as const, p }))];
          render();
        }).catch(() => {});
      }, 200);
    });
    input.addEventListener("focus", render);
    input.addEventListener("blur", () => setTimeout(() => (list.hidden = true), 100));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && this.results[0]) {
        pick(this.results[0]);
        input.blur();
      } else if (e.key === "Escape") input.blur();
    });
  }

  go(r: Result) {
    if (r.kind === "dest") this.app.goTo(this.app.viewOf(r.d.lat, r.d.lon, this.ground(r.d.lat, r.d.lon), r.d.range, r.d.heading, r.d.tilt));
    else if (r.kind === "place") this.app.places.open(r.p.id, true);
    else this.app.goTo(this.app.viewOf(r.lat, r.lon, this.ground(r.lat, r.lon), 12_000, 0, 40));
  }

  private ground(lat: number, lon: number) {
    const h = this.app.tiles.groundAt(lat, lon);
    return Number.isFinite(h) ? h : 0;
  }

  toast(msg: string) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout((t as HTMLElement & { _t?: number })._t);
    (t as HTMLElement & { _t?: number })._t = window.setTimeout(() => (t.hidden = true), 4000);
  }

  // ------------------------------------------------------------------------------------------------- place panel

  showPlace(p: PlaceRecord) {
    this.panelPlace = p;
    const m = p.manifest;
    const panel = $("panel");
    panel.hidden = false;
    document.body.classList.add("panel-open");
    $("panel-title").textContent = m.title;
    $("panel-summary").textContent = m.summary ?? "";
    const repoUrl = p.repo.startsWith("dev/") ? null : `https://github.com/${p.repo}`;
    $("panel-meta").innerHTML = [
      `<span class="chip">${esc(m.kind)}</span>`,
      m.era ? `<span class="chip">${esc(m.era.label)}${m.era.year ? ` · ${m.era.year}` : ""}</span>` : "",
      `<span>by ${repoUrl ? `<a href="${esc(repoUrl)}" target="_blank" rel="noopener">${esc(p.author)}</a>` : esc(p.author)}</span>`,
      `<span title="likes on EarthRT">♥ ${p.likes}</span>`,
      `<span title="stars on GitHub">★ ${p.stars}</span>`,
    ].join("");
    const sceneOnly = m.content.every((c) => c.type !== "glb" && !(c.type === "scene" && c.fallback));
    const note = $("panel-note");
    note.hidden = !sceneOnly;
    note.textContent = sceneOnly ? "This place is a live scene. Open it in the EarthRT app to see it — the web shows its marker only." : "";
    $("panel-credits").textContent = [m.license, ...(m.credits ?? [])].filter(Boolean).join(" · ");
    $("panel-go").onclick = () => this.app.places.goTo(p);
    $("panel-fly").onclick = () => {
      const g = geodetic(this.app.controls.state.pos);
      this.app.flight.start({ lat: g.lat, lon: g.lon, name: "Here" }, { lat: m.anchor.lat, lon: m.anchor.lon, name: m.title });
    };
    $("panel-app").onclick = () => (location.href = appLink(p.id.startsWith("dev/") ? this.linkParams() : { place: p.id }));
    const versions = $("panel-versions");
    versions.innerHTML = `<li class="muted">Looking for other versions…</li>`;
    const eras = $("panel-eras");
    eras.innerHTML = "";
    this.app.places.versions(p.topic).then((list) => {
      if (this.panelPlace !== p) return;
      this.renderVersions(p, list);
    }).catch(() => (versions.innerHTML = `<li class="muted">No other versions.</li>`));
  }

  private renderVersions(p: PlaceRecord, list: PlaceRecord[]) {
    const versions = $("panel-versions"), eras = $("panel-eras");
    const chosen = this.app.places.chosen.get(topicBase(p.topic));
    // eras: the base topic and each @era, a chip each
    const topics = [...new Set(list.map((x) => x.topic))].sort((a, b) => (a.includes("@") ? 1 : 0) - (b.includes("@") ? 1 : 0) || a.localeCompare(b));
    eras.hidden = topics.length < 2;
    eras.innerHTML = "";
    for (const t of topics) {
      const b = document.createElement("button");
      const era = list.find((x) => x.topic === t)?.manifest.era;
      b.textContent = t.includes("@") ? era?.label ?? t.split("@")[1] : "Today";
      b.className = t === p.topic ? "on" : "";
      b.onclick = () => {
        const best = list.filter((x) => x.topic === t).sort((a, c) => (c.likes * 2 + c.stars) - (a.likes * 2 + a.stars))[0];
        if (best) {
          this.app.places.choose(best);
          this.showPlace(best);
        }
      };
      eras.appendChild(b);
    }
    versions.innerHTML = "";
    const same = list.filter((x) => x.topic === p.topic).sort((a, b) => (b.likes * 2 + b.stars) - (a.likes * 2 + a.stars));
    if (same.length < 2) {
      versions.innerHTML = `<li class="muted">The only version of ${esc(p.topic)} so far.</li>`;
      return;
    }
    for (const v of same) {
      const li = document.createElement("li");
      const shown = chosen?.id === v.id;
      li.className = shown ? "on" : "";
      li.innerHTML = `<b>${esc(v.manifest.title)}</b><span>${esc(v.author)} · ♥ ${v.likes} · ★ ${v.stars}</span>`;
      const b = document.createElement("button");
      b.textContent = shown ? "Shown" : "Show";
      b.disabled = shown;
      b.onclick = () => {
        this.app.places.choose(v);
        this.showPlace(v);
      };
      li.appendChild(b);
      versions.appendChild(li);
    }
  }

  hidePlace() {
    this.panelPlace = null;
    $("panel").hidden = true;
    document.body.classList.remove("panel-open");
  }

  // ------------------------------------------------------------------------------------------------------ flights

  private toggleFlyForm() {
    const f = $("fly-form");
    f.hidden = !f.hidden;
    if (!f.hidden) ($("fly-to") as HTMLInputElement).focus();
  }

  flightStarted() {
    $("flight").hidden = false;
    $("fly-pause").textContent = "Pause";
    $("fly-speed").textContent = "1×";
    document.body.classList.add("flying");
  }

  flightEnded() {
    $("flight").hidden = true;
    document.body.classList.remove("flying");
  }

  // ------------------------------------------------------------------------------------------------- every frame

  frame(s: CamState) {
    this.markers(s);
    const now = performance.now();
    if (now - this.readoutAt < 120) return;
    this.readoutAt = now;
    const g = geodetic(s.pos);
    $("readout").textContent = `${Math.abs(g.lat).toFixed(4)}°${g.lat >= 0 ? "N" : "S"} ${Math.abs(g.lon).toFixed(4)}°${g.lon >= 0 ? "E" : "W"} · ${formatAlt(g.h)}`;
    this.updateTimeLabel();
    const fi = this.app.flight.info();
    if (fi) {
      $("fly-route").textContent = `${fi.from} → ${fi.to}`;
      ($("fly-bar") as HTMLElement).style.width = `${(fi.progress * 100).toFixed(2)}%`;
      $("fly-info").textContent = `${formatAlt(fi.alt)} · ${Math.max(0, Math.ceil(fi.remaining))} s left · ${Math.round(fi.distance / 1000).toLocaleString("en")} km`;
    }
  }

  private updateTimeLabel() {
    const g = geodetic(this.app.cameraState().pos);
    const h = ((((this.app.time / 3600000 + g.lon / 15) % 24) + 24) % 24);
    const slider = $("time") as HTMLInputElement;
    if (document.activeElement !== slider) slider.value = h.toFixed(2);
    $("time-label").textContent = `${formatHour(h)} solar${this.app.liveTime ? " · now" : ""}`;
    $("time-now").hidden = this.app.liveTime;
  }

  private markers(s: CamState) {
    const layer = $("markers");
    const { w, h } = this.app.size;
    const g = geodetic(s.pos);
    const seen = new Set<string>();
    let count = 0;
    for (const p of this.app.places.markers()) {
      const m = p.manifest;
      const l = this.app.places.loaded.get(p.id);
      const ground = l?.ground ?? this.ground(m.anchor.lat, m.anchor.lon);
      const top = Math.min(placeRadius(m) * 0.3, 120);
      const ecef = geodeticToEcef(m.anchor.lat, m.anchor.lon, ground + (m.anchor.height ?? 0) + top);
      const pr = this.app.globe.project(ecef, w, h);
      // behind the Earth: the anchor's up faces away from the camera
      const toCam = [s.pos[0] - ecef[0], s.pos[1] - ecef[1], s.pos[2] - ecef[2]];
      const r = Math.hypot(ecef[0], ecef[1], ecef[2]);
      const horizon = (ecef[0] * toCam[0] + ecef[1] * toCam[1] + ecef[2] * toCam[2]) / r > 0;
      const far = pr.dist > Math.max(3_000_000, (m.visibleFrom ?? VISIBLE_FROM[m.kind]) * 400);
      if (!pr.front || !horizon || far || pr.x < -50 || pr.y < -50 || pr.x > w + 50 || pr.y > h + 50 || count > 80) continue;
      count++;
      seen.add(p.id);
      let el = this.markerEls.get(p.id);
      if (!el) {
        el = document.createElement("button");
        el.className = "marker";
        el.innerHTML = `<i></i><span>${esc(m.title)}</span>`;
        el.onclick = () => this.showPlace(p);
        layer.appendChild(el);
        this.markerEls.set(p.id, el);
      }
      el.style.transform = `translate(${pr.x.toFixed(1)}px, ${pr.y.toFixed(1)}px)`;
      el.classList.toggle("near", pr.dist < (m.visibleFrom ?? VISIBLE_FROM[m.kind]) * 3);
      el.classList.toggle("loading", l?.state === "loading");
    }
    for (const [id, el] of this.markerEls) if (!seen.has(id)) {
      el.remove();
      this.markerEls.delete(id);
    }
  }
}
