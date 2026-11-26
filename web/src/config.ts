// Launch parameters (SPEC § 7) from the page's query, and the built-in destinations.

export interface LatLon { lat: number; lon: number }

export interface Launch {
  at?: { lat: number; lon: number; alt: number; heading?: number; pitch?: number };
  place?: string;
  fly?: { from: string; to: string };
  /** Service base URL ('' = this origin). */
  api: string;
  dev?: string;
  debug: boolean;
  /** Use the dev tile source even when a service answers. */
  devTiles: boolean;
  /** Fixed time: UTC ms. */
  time?: number;
  /** Local solar hour at the camera's longitude (0..24), instead of now. */
  hour?: number;
  /** Seconds a flight takes on screen (default: scaled to ~90 s). */
  flightSeconds?: number;
  /** Device pixel ratio override (tests, screenshots). */
  dpr?: number;
  /** Screen-space error threshold, px (SPEC § 2: web 2.5; settings may scale it). */
  sse?: number;
  /** A flight fetches ahead of the camera (default; `lookahead=0` turns it off, for the probe's comparison). */
  lookahead: boolean;
  /** Embedded (SPEC § 6.1): `host=app` (the native app's WebView) or `parent=<origin>` (an <iframe>). */
  host?: "app" | "parent";
  parent?: string;
}

/** The service when the page is not on its origin (in the app, or another site's frame). */
export const DEFAULT_SERVICE = "https://earth.threert.dev";

const num = (s: string | undefined) => (s === undefined || s.trim() === "" ? NaN : Number(s));

export function parseLaunch(search: string): Launch {
  const q = new URLSearchParams(search);
  const out: Launch = { api: "", debug: q.has("debug"), devTiles: q.get("tiles") === "dev", lookahead: q.get("lookahead") !== "0" };
  const at = q.get("at");
  if (at) {
    const [lat, lon, alt, heading, pitch] = at.split(",").map((s) => num(s));
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      out.at = { lat, lon, alt: Number.isFinite(alt) ? Math.max(1, alt) : 20_000_000 };
      if (Number.isFinite(heading)) out.at.heading = heading;
      if (Number.isFinite(pitch)) out.at.pitch = Math.max(-90, Math.min(90, pitch));
    }
  }
  const place = q.get("place");
  if (place && /^[\w.-]+\/[\w.-]+\/[a-z0-9][a-z0-9-]{2,63}$/.test(place)) out.place = place;
  const fly = q.get("fly");
  if (fly && fly.includes(";")) {
    const [from, to] = fly.split(";");
    if (from.trim() && to.trim()) out.fly = { from: from.trim(), to: to.trim() };
  }
  const api = q.get("api");
  if (api && /^https?:\/\//.test(api)) out.api = api.replace(/\/+$/, "");
  const dev = q.get("dev");
  if (dev && /^https?:\/\//.test(dev)) out.dev = dev.replace(/\/+$/, "");
  const time = q.get("time");
  if (time) {
    const t = Date.parse(time);
    if (Number.isFinite(t)) out.time = t;
  }
  const hour = num(q.get("hour") ?? undefined);
  if (Number.isFinite(hour) && hour >= 0 && hour <= 24) out.hour = hour;
  const fs = num(q.get("flightSeconds") ?? undefined);
  if (Number.isFinite(fs) && fs > 0) out.flightSeconds = fs;
  const dpr = num(q.get("dpr") ?? undefined);
  if (Number.isFinite(dpr) && dpr > 0 && dpr <= 4) out.dpr = dpr;
  if (q.get("host") === "app") out.host = "app";
  const parent = q.get("parent");
  if (!out.host && parent && /^https?:\/\/[^/]+$/.test(parent.replace(/\/+$/, ""))) {
    out.host = "parent";
    out.parent = parent.replace(/\/+$/, "");
  }
  // embedded in the app, the page is not on the service's origin: the service is named
  if (out.host === "app" && !out.api) out.api = DEFAULT_SERVICE;
  const sse = num(q.get("sse") ?? undefined);
  if (Number.isFinite(sse) && sse >= 0.5 && sse <= 32) out.sse = sse;
  return out;
}

/** `lat,lon` → a point, else null. */
export function parseLatLon(s: string): LatLon | null {
  const m = s.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

export interface Destination {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** The view: from `range` m, heading and tilt in degrees. */
  range: number;
  heading: number;
  tilt: number;
}

export const DESTINATIONS: Destination[] = [
  { id: "kyoto", name: "Kyoto", lat: 34.9949, lon: 135.7850, range: 9000, heading: 0, tilt: 55 },
  { id: "tokyo", name: "Tokyo", lat: 35.6812, lon: 139.7671, range: 14000, heading: 20, tilt: 55 },
  { id: "new-york", name: "New York", lat: 40.7128, lon: -74.0060, range: 14000, heading: 30, tilt: 55 },
  { id: "shanghai", name: "Shanghai", lat: 31.2304, lon: 121.4737, range: 16000, heading: 0, tilt: 50 },
  { id: "san-francisco", name: "San Francisco", lat: 37.7749, lon: -122.4194, range: 16000, heading: 300, tilt: 55 },
  { id: "paris", name: "Paris", lat: 48.8566, lon: 2.3522, range: 12000, heading: 0, tilt: 50 },
  { id: "london", name: "London", lat: 51.5072, lon: -0.1276, range: 12000, heading: 0, tilt: 50 },
  { id: "alps", name: "The Alps (Matterhorn)", lat: 45.9763, lon: 7.6586, range: 16000, heading: 200, tilt: 65 },
];

export function findDestination(q: string): Destination | undefined {
  const s = q.trim().toLowerCase().replace(/\s+/g, "-");
  return DESTINATIONS.find((d) => d.id === s || d.name.toLowerCase() === q.trim().toLowerCase());
}
