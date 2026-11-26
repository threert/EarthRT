// @earthrt/core in the engine's QuickJS (ROADMAP S1's last check): the same computations as in Bun, printed as one JSON
// line each, compared by traced/test/core-quickjs.ts.
import {
  chooseVersions, decodeErt, ecefToGeodetic, encodeTerrainCompact, expandTerrain, encodeTerrainExpanded, readTerrainExpanded,
  FloatingOrigin, Flight, geodeticToEcef, gridNormals, selectTiles, sunDirection, terrainIndex, validatePlace, Scheduler,
  encodeBuildingsCompact, expandBuildings, encodeBuildingsExpanded, readBuildingsExpanded, tileAt,
} from "../../packages/core/src/index.ts";

export function run(log: (k: string, v: unknown) => void) {
  const r = (x: number) => Math.round(x * 1e6) / 1e6;
  log("ecef", geodeticToEcef(34.985, 135.758, 120).map(r));
  log("geo", Object.values(ecefToGeodetic(-3958204.1, 3349370.8, 3699022.3)).map(r));
  const o = new FloatingOrigin(35, 135.7);
  o.update(geodeticToEcef(35.2, 135.9, 3000));
  log("origin", { gen: o.generation, q: o.frame.quat.map(r), p: o.placeEcef([-3958204.1, 3349370.8, 3699022.3]).position.map(r) });
  const view = { position: geodeticToEcef(34.9, 135.76, 3000), forward: [0, 0, 0] as [number, number, number], up: [0, 0, 1] as [number, number, number], fov: Math.PI / 4, aspect: 16 / 9, height: 720 };
  const tgt = geodeticToEcef(35.0, 135.76, 0);
  const d = tgt.map((v, i) => v - view.position[i]);
  const l = Math.hypot(...d);
  view.forward = d.map((v) => v / l) as [number, number, number];
  const ready = new Set(["0/0/0", "cap/n", "cap/s", "1/1/0", "2/3/1"]);
  const sel = selectTiles(view, { threshold: 2, maxZoom: 14, info: (k) => (ready.has(k) ? { ready: true } : undefined) });
  log("select", { show: sel.show.length, want: sel.want.slice(0, 6).map((w) => [JSON.stringify(w.key), r(w.priority)]), touched: sel.touched.size });
  log("sun", sunDirection(Date.UTC(2026, 5, 21, 3)).map(r));
  const f = new Flight({ from: { lat: 34.985, lon: 135.758, alt: 1500 }, to: { lat: 37.77, lon: -122.42, alt: 1500 } });
  const p = f.at(f.duration / 3);
  log("flight", { d: r(f.distance), dur: r(f.duration), lat: r(p.lat), lon: r(p.lon), alt: r(p.alt) });
  // a terrain tile through the codec
  const n = 9, key = { z: 10, x: 897, y: 404 };
  const heights = new Float32Array(n * n).map((_, i) => 50 + (i % n) * 3 + Math.floor(i / n) * 2);
  const B = new Float32Array((n + 2) * (n + 2)).map((_, i) => 50 + (i % (n + 2)) * 3 + Math.floor(i / (n + 2)) * 2);
  const normals = gridNormals(key, n, B);
  const compact = encodeTerrainCompact({ key, n, heights, cls: new Uint8Array(n * n).fill(3), rgb: new Uint8Array(3 * n * n).fill(120), water: new Uint8Array(n * n), normals, skirt: 40, src: ["t"] });
  const mesh = expandTerrain(decodeErt(compact));
  const x = readTerrainExpanded(encodeTerrainExpanded(mesh, { skirt: 40, src: ["t"] }));
  log("terrain", { bytes: compact.length, pos: Array.from(x.positions.slice(0, 6)).map(r), nrm: Array.from(x.normals.slice(0, 3)).map(r), idx: terrainIndex(n).length, radius: r(x.radius) });
  const bc = encodeBuildingsCompact(tileAt(34.99, 135.76, 14), [{ rings: [[[34.99, 135.76], [34.99, 135.7602], [34.9902, 135.7602], [34.9902, 135.76]]], base: 40, height: 12 }], ["t"]);
  const bm = readBuildingsExpanded(encodeBuildingsExpanded(expandBuildings(decodeErt(bc)), ["t"]));
  log("buildings", { v: bm.positions.length / 3, t: bm.index.length / 3, p0: Array.from(bm.positions.slice(0, 3)).map(r) });
  log("place", validatePlace({ format: "earthrt/place@1", id: "abc", title: "x", kind: "site", anchor: { lat: 1, lon: 2 }, bounds: { radius: 5 }, content: [{ type: "glb", uri: "a.glb" }] }));
  const recs = [1, 2].map((i) => ({ id: `o/r/p${i}`, repo: "o/r", sha: "s", manifest: {} as never, files: "", author: "a", likes: i, stars: 0, topic: "city:kyoto", updated: "" }));
  log("choose", [...chooseVersions(recs).values()].map((p) => p.id));
  const s = new Scheduler<string>({ get: (url) => Promise.resolve(url) }, 2);
  s.want([{ id: "a", url: "A", priority: 1 }, { id: "b", url: "B", priority: 2 }, { id: "c", url: "C", priority: 3 }]);
  return s;
}
