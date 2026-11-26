import { describe, expect, test } from "bun:test";
import {
  chooseVersions, decodeErp, decodeErt, encodeBuildingsCompact, encodeErp, encodeErt, encodeTerrainCompact, ecefToGeodetic, expandBuildings,
  expandTerrain, encodeTerrainExpanded, readTerrainExpanded, Flight, FloatingOrigin, Frame, geodeticToEcef, gridLatLon, gridNormals, haversine,
  latToTileY, octDecode, octEncode, parseKey, keyOf, selectTiles, Scheduler, sunDirection, terrainIndex, tileAt, tileBounds, tileCenter, tileYToLat,
  validatePlace, validateTileset, selectCityTiles, type PlaceRecord, type Tileset, type V3,
} from "../src/index.ts";

const close = (a: number, b: number, eps: number) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("geodesy", () => {
  test("ECEF round trip under a millimetre", () => {
    for (const [lat, lon, h] of [[35.0116, 135.7681, 50], [-33.9, 151.2, 0], [89.9, 10, 1200], [0, -179.9, -400], [-89.99, 0, 2800]]) {
      const p = geodeticToEcef(lat, lon, h);
      const g = ecefToGeodetic(p[0], p[1], p[2]);
      close(g.lat, lat, 1e-8);
      close(g.lon, lon, 1e-8);
      close(g.h, h, 1e-3);
    }
  });
  test("frame axes: east, up, south", () => {
    const f = new Frame(35, 135);
    const east = geodeticToEcef(35, 135.001, 0), north = geodeticToEcef(35.001, 135, 0), up = geodeticToEcef(35, 135, 100);
    const e = f.point(east), n = f.point(north), u = f.point(up);
    expect(e[0]).toBeGreaterThan(90);
    close(e[2], 0, 0.1);
    expect(n[2]).toBeLessThan(-100); // north is −z
    close(u[1], 100, 1e-6);
  });
  test("heading turns forward clockwise from north", () => {
    const f = new Frame(10, 20, 0, 90);
    const east = geodeticToEcef(10, 20.001, 0);
    const p = f.point(east);
    expect(p[2]).toBeLessThan(-100); // east is forward (−z) at heading 90
  });
  test("quatOf maps a place frame's axes", () => {
    const view = new Frame(35, 135), place = new Frame(35.01, 135.01, 0, 30);
    const q = view.quatOf(place);
    // rotate the place's +x by q and compare with the place's +x expressed in the view frame
    const v: V3 = [1, 0, 0];
    const [x, y, z, w] = q;
    const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
    const r = [v[0] + w * t[0] + (y * t[2] - z * t[1]), v[1] + w * t[1] + (z * t[0] - x * t[2]), v[2] + w * t[2] + (x * t[1] - y * t[0])];
    const want = view.dir(place.rx);
    for (let i = 0; i < 3; i++) close(r[i], want[i], 1e-9);
  });
});

describe("tiles", () => {
  test("Mercator y and latitude agree", () => {
    for (const lat of [0, 35.0116, -60, 85]) close(tileYToLat(latToTileY(lat, 10), 10), lat, 1e-9);
    const k = tileAt(35.0116, 135.7681, 14);
    const b = tileBounds(k);
    expect(b.south).toBeLessThan(35.0116);
    expect(b.north).toBeGreaterThan(35.0116);
    expect(keyOf(parseKey(keyOf(k)))).toBe(keyOf(k));
  });
  test("grid edges are shared with the neighbour", () => {
    const a = gridLatLon({ z: 5, x: 10, y: 12 }), b = gridLatLon({ z: 5, x: 11, y: 12 });
    expect(a.lons[64]).toBe(b.lons[0]);
  });
  test("terrain index: grid and skirt triangles face outward", () => {
    const n = 5;
    const idx = terrainIndex(n);
    expect(idx.length).toBe(((n - 1) * (n - 1) + 4 * (n - 1)) * 6);
    expect(Math.max(...idx)).toBe(n * n + 4 * n - 1);
  });
});

function syntheticTerrain(key = { z: 12, x: 3593, y: 1621 }) {
  const n = 65;
  const bordered = new Float32Array((n + 2) * (n + 2));
  for (let i = 0; i < n + 2; i++) for (let j = 0; j < n + 2; j++) bordered[i * (n + 2) + j] = 100 + 50 * Math.sin(i / 7) * Math.cos(j / 9);
  const heights = new Float32Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) heights[i * n + j] = bordered[(i + 1) * (n + 2) + j + 1];
  const normals = gridNormals(key, n, bordered);
  const rgb = new Uint8Array(3 * n * n).fill(120), cls = new Uint8Array(n * n).fill(3), water = new Uint8Array(n * n);
  return { key, n, heights, normals, rgb, cls, water, skirt: 50, src: ["test"] };
}

describe("ERT", () => {
  test("encode and decode chunks", () => {
    const f = encodeErt({ v: 1, layer: "terrain", key: "0/0/0", enc: "compact", center: [1, 2, 3], radius: 4, src: ["京都"] }, { a: new Float32Array([1.5, 2.5]), b: new Uint8Array([7]) });
    const e = decodeErt(f);
    expect(e.header.src![0]).toBe("京都");
    expect(Array.from(e.chunks.a)).toEqual([1.5, 2.5]);
    expect(Array.from(e.chunks.b)).toEqual([7]);
    const pack = decodeErp(encodeErp([f, f]));
    expect(pack.length).toBe(2);
    expect(decodeErt(pack[1]).header.radius).toBe(4);
  });
  test("octahedral normals within a degree", () => {
    const o = new Int8Array(2), out = new Float32Array(3);
    for (const v of [[0, 0, 1], [0.6, -0.8, 0], [0.3, 0.3, -0.905], [-1, 0, 0]] as V3[]) {
      const l = Math.hypot(...v);
      octEncode(v[0] / l, v[1] / l, v[2] / l, o, 0);
      octDecode(o[0], o[1], out, 0);
      expect(out[0] * v[0] / l + out[1] * v[1] / l + out[2] * v[2] / l).toBeGreaterThan(Math.cos((1.2 * Math.PI) / 180));
    }
  });
  test("terrain: compact → expanded → read keeps positions", () => {
    const src = syntheticTerrain();
    const compact = encodeTerrainCompact(src);
    expect(compact.byteLength).toBeLessThan(40_000);
    const mesh = expandTerrain(decodeErt(compact));
    // a vertex back to geodetic: its height within the quantisation step
    const c = mesh.center, v = 33 * 65 + 20;
    const p = ecefToGeodetic(mesh.positions[3 * v] + c[0], mesh.positions[3 * v + 1] + c[1], mesh.positions[3 * v + 2] + c[2]);
    close(p.h, src.heights[v], 0.01);
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      const d = Math.hypot(mesh.positions[3 * i], mesh.positions[3 * i + 1], mesh.positions[3 * i + 2]);
      expect(d).toBeLessThanOrEqual(mesh.radius);
    }
    const expanded = encodeTerrainExpanded(mesh, { skirt: 50, src: ["test"] });
    const back = readTerrainExpanded(expanded);
    expect(back.positions[3 * v]).toBe(mesh.positions[3 * v]);
    // normals point up-ish
    const up = geodeticToEcef(35, 135.7, 1);
    const l = Math.hypot(...up);
    expect((back.normals[3 * v] * up[0] + back.normals[3 * v + 1] * up[1] + back.normals[3 * v + 2] * up[2]) / l).toBeGreaterThan(0.9);
  });
  test("terrain triangles face away from the Earth's centre", () => {
    const mesh = expandTerrain(decodeErt(encodeTerrainCompact(syntheticTerrain())));
    const P = mesh.positions, I = mesh.index, c = mesh.center;
    let bad = 0;
    for (let t = 0; t < (64 * 64 * 2); t++) {
      const [a, b, d] = [I[3 * t], I[3 * t + 1], I[3 * t + 2]];
      const ab = [P[3 * b] - P[3 * a], P[3 * b + 1] - P[3 * a + 1], P[3 * b + 2] - P[3 * a + 2]];
      const ad = [P[3 * d] - P[3 * a], P[3 * d + 1] - P[3 * a + 1], P[3 * d + 2] - P[3 * a + 2]];
      const n = [ab[1] * ad[2] - ab[2] * ad[1], ab[2] * ad[0] - ab[0] * ad[2], ab[0] * ad[1] - ab[1] * ad[0]];
      const out = [P[3 * a] + c[0], P[3 * a + 1] + c[1], P[3 * a + 2] + c[2]];
      if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] <= 0) bad++;
    }
    expect(bad).toBe(0);
  });
  test("buildings: extruded walls face out, roofs up", () => {
    const key = tileAt(35.0116, 135.7681, 14);
    const sq = (lat: number, lon: number, d: number): [number, number][] => [[lat, lon], [lat, lon + d], [lat + d, lon + d], [lat + d, lon]];
    const ccw = sq(35.0116, 135.7681, 0.0002);
    const cw = [...sq(35.012, 135.768, 0.0003)].reverse();
    const file = encodeBuildingsCompact(key, [
      { rings: [ccw], base: 40, height: 12 },
      { rings: [cw, sq(35.0121, 135.7681, 0.0001)], base: 41, height: 30, wall: [220, 200, 180] },
    ], ["osm"]);
    const m = expandBuildings(decodeErt(file));
    expect(m.count).toBe(2);
    expect(m.index.length % 3).toBe(0);
    const up = geodeticToEcef(35.0116, 135.7681, 0);
    const ul = Math.hypot(...up);
    let roofsUp = 0, roofsDown = 0;
    for (let t = 0; t < m.index.length / 3; t++) {
      const [a, b, c] = [m.index[3 * t], m.index[3 * t + 1], m.index[3 * t + 2]];
      const P = m.positions;
      const ab = [P[3 * b] - P[3 * a], P[3 * b + 1] - P[3 * a + 1], P[3 * b + 2] - P[3 * a + 2]];
      const ac = [P[3 * c] - P[3 * a], P[3 * c + 1] - P[3 * a + 1], P[3 * c + 2] - P[3 * a + 2]];
      const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      const dn = (n[0] * m.normals[3 * a] + n[1] * m.normals[3 * a + 1] + n[2] * m.normals[3 * a + 2]);
      expect(dn).toBeGreaterThan(0); // the winding agrees with the normal
      const vertical = (n[0] * up[0] + n[1] * up[1] + n[2] * up[2]) / ul / Math.hypot(...n);
      if (vertical > 0.99) roofsUp++;
      if (vertical < -0.99) roofsDown++;
    }
    expect(roofsUp).toBeGreaterThan(0);
    expect(roofsDown).toBe(0);
  });
});

describe("selection", () => {
  test("from orbit, coarse tiles; near the ground, fine ones near the camera", () => {
    const ready = new Set<string>();
    const info = (k: string) => ({ ready: ready.has(k), minH: 0, maxH: 1000 });
    const orbit = { position: geodeticToEcef(35, 135, 20_000_000), forward: [0, 0, 0] as V3, up: [0, 0, 1] as V3, fov: 0.8, aspect: 1.6, height: 1080 };
    const p = orbit.position, l = Math.hypot(...p);
    orbit.forward = [-p[0] / l, -p[1] / l, -p[2] / l];
    // nothing loaded: z0 is wanted first
    let s = selectTiles(orbit, { threshold: 2, maxZoom: 14, info });
    expect(s.want[0].key).toEqual({ z: 0, x: 0, y: 0 });
    // load everything wanted a few rounds: the view settles on low zooms
    for (let round = 0; round < 8; round++) {
      for (const w of selectTiles(orbit, { threshold: 2, maxZoom: 14, info }).want) ready.add(keyOf(w.key));
    }
    s = selectTiles(orbit, { threshold: 2, maxZoom: 14, info });
    const maxZ = Math.max(...s.show.map((k) => ("z" in k ? k.z : 0)));
    expect(maxZ).toBeLessThanOrEqual(6);
    expect(s.show.length).toBeGreaterThan(4);
    // and the far side of the Earth is culled
    expect(s.show.some((k) => "z" in k && k.z >= 3 && Math.abs(tileBounds(k).west - (-45)) < 1 && tileBounds(k).north < -30)).toBe(false);
  });
  test("aeroplane view refines to z14 under the camera", () => {
    const ready = new Set<string>();
    const info = (k: string) => ({ ready: ready.has(k), minH: 0, maxH: 500 });
    const pos = geodeticToEcef(35.0, 135.75, 3000);
    const target = geodeticToEcef(35.03, 135.75, 0);
    const d = [target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]] as V3, dl = Math.hypot(...d);
    const view = { position: pos, forward: [d[0] / dl, d[1] / dl, d[2] / dl] as V3, up: geodeticToEcef(0, 0, 0).map((_, i) => pos[i] / Math.hypot(...pos)) as V3, fov: 1.0, aspect: 1.6, height: 1080 };
    for (let round = 0; round < 20; round++) for (const w of selectTiles(view, { threshold: 2, maxZoom: 14, info }).want) ready.add(keyOf(w.key));
    const s = selectTiles(view, { threshold: 2, maxZoom: 14, info });
    expect(s.want.length).toBe(0);
    expect(Math.max(...s.show.map((k) => ("z" in k ? k.z : 0)))).toBe(14);
    expect(s.show.length).toBeLessThan(600);
  });
});

describe("selection under a city", () => {
  test("minZoom refines a region to a zoom whatever the error", () => {
    const pos = geodeticToEcef(35, 135.76, 2_000_000);
    const view = { position: pos, forward: [-pos[0] / Math.hypot(...pos), -pos[1] / Math.hypot(...pos), -pos[2] / Math.hypot(...pos)] as [number, number, number], up: [0, 0, 1] as [number, number, number], fov: 0.8, aspect: 1.5, height: 720 };
    const info = () => ({ ready: true, minH: 0, maxH: 100 });
    const plain = selectTiles(view, { threshold: 6, maxZoom: 14, info });
    const kyoto = tileAt(35, 135.76, 14);
    // the tiles that hold Kyoto's z14 tile: refined to z14
    const holds = (k: { z: number; x: number; y: number }) => k.z <= 14 && kyoto.x >> (14 - k.z) === k.x && kyoto.y >> (14 - k.z) === k.y;
    const forced = selectTiles(view, { threshold: 6, maxZoom: 14, info, minZoom: (k) => (holds(k) ? 14 : 0) });
    expect(plain.show.some((k) => "z" in k && k.z === 14)).toBe(false);
    expect(forced.show.some((k) => "z" in k && k.z === 14 && k.x === kyoto.x && k.y === kyoto.y)).toBe(true);
  });
});

describe("scheduler", () => {
  test("highest priority first, dropped when unwanted, retried after failure", async () => {
    const started: string[] = [];
    const resolvers = new Map<string, (v: string) => void>();
    const rejecters = new Map<string, (e: unknown) => void>();
    const s = new Scheduler<string>({ get: (url) => new Promise((res, rej) => { started.push(url); resolvers.set(url, res); rejecters.set(url, rej); }) }, 2);
    s.want([{ id: "a", url: "a", priority: 1 }, { id: "b", url: "b", priority: 3 }, { id: "c", url: "c", priority: 2 }]);
    expect(started).toEqual(["b", "c"]);
    s.want([{ id: "a", url: "a", priority: 1 }, { id: "b", url: "b", priority: 3 }]);
    expect(started).toEqual(["b", "c", "a"]);
    resolvers.get("b")!("B");
    rejecters.get("a")!(new Error("x"));
    await new Promise((r) => setTimeout(r, 0));
    const got = s.take();
    expect(got.map((g) => g.id).sort()).toEqual(["a", "b"]);
    expect(got.find((g) => g.id === "b")!.result).toBe("B");
  });
  test("a finished request is not started again before the next want()", async () => {
    let n = 0;
    const s = new Scheduler<string>({ get: (url) => { n++; return Promise.resolve(url); } }, 4);
    s.want([{ id: "a", url: "a", priority: 1 }]);
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(n).toBe(1);
    expect(s.take().map((g) => g.id)).toEqual(["a"]);
  });
});

describe("flight, sun, places", () => {
  test("a flight from Kyoto to San Francisco", () => {
    const f = new Flight({ from: { lat: 35.0116, lon: 135.7681, alt: 500 }, to: { lat: 37.7749, lon: -122.4194, alt: 500 } });
    expect(f.distance).toBeGreaterThan(8_000_000);
    const mid = f.at(f.duration / 2);
    expect(mid.alt).toBe(10_000);
    expect(mid.lat).toBeGreaterThan(40); // the great circle bends north over the Pacific
    close(f.at(f.duration).lat, 37.7749, 1e-6);
    expect(f.lookahead(0, 60, 10).length).toBe(6);
  });
  test("the sun is over the Tropic of Cancer at the June solstice, noon UTC near Greenwich", () => {
    const d = sunDirection(Date.UTC(2026, 5, 21, 12, 0));
    const lat = (Math.asin(d[2]) * 180) / Math.PI, lon = (Math.atan2(d[1], d[0]) * 180) / Math.PI;
    close(lat, 23.44, 0.1);
    close(lon, 0, 1.5);
  });
  test("manifest check", () => {
    const ok = { format: "earthrt/place@1", id: "gion-machiya", title: "A machiya", kind: "interior", anchor: { lat: 35, lon: 135.7 }, bounds: { radius: 30 }, content: [{ type: "glb", uri: "models/a.glb" }] };
    expect(validatePlace(ok)).toEqual([]);
    expect(validatePlace({ ...ok, content: [{ type: "glb", uri: "../x.glb" }] }).length).toBe(1);
    expect(validatePlace({ ...ok, content: [{ type: "glb", uri: "https://x/a.glb" }] }).length).toBe(1);
    expect(validatePlace({ ...ok, topic: "city:Kyoto" }).length).toBe(1);
    expect(validatePlace({ ...ok, content: [{ type: "scene", entry: "dist/scene.js", fallback: "assets/models/scene.glb" }] })).toEqual([]);
    expect(validatePlace({ ...ok, content: [{ type: "scene", entry: "dist/scene.js", fallback: "assets/scene.gltf" }] }).length).toBe(1);
  });
  test("versions: choice, else the best ranked", () => {
    const rec = (id: string, likes: number, stars: number, topic = "city:kyoto"): PlaceRecord => ({ id, repo: id, sha: "x", manifest: {} as never, files: "", author: "a", likes, stars, topic, updated: "2026-11-26" });
    const list = [rec("a/a/kyoto", 3, 0), rec("b/b/kyoto", 1, 10), rec("c/c/kyoto", 0, 0, "city:kyoto@meiji")];
    expect(chooseVersions(list).get("city:kyoto")!.id).toBe("b/b/kyoto");
    expect(chooseVersions(list, { "city:kyoto": "c/c/kyoto" }).get("city:kyoto")!.id).toBe("c/c/kyoto");
    expect(haversine(35, 135, 35, 135.01)).toBeGreaterThan(900);
  });
  test("floating origin rebases when the camera strays", () => {
    const o = new FloatingOrigin(35, 135);
    expect(o.update(geodeticToEcef(35.001, 135, 100))).toBe(false);
    expect(o.update(geodeticToEcef(35.1, 135, 100))).toBe(true);
    const t = o.placeEcef(tileCenter({ z: 14, x: 14378, y: 6485 }));
    expect(Math.hypot(...t.position)).toBeLessThan(20_000_000);
  });
});

describe("enterFrom", () => {
  test("checked and defaulted by kind", async () => {
    const { ENTER_FROM } = await import("../src/places.ts");
    const ok = { format: "earthrt/place@1", id: "gion-machiya", title: "A machiya", kind: "interior", anchor: { lat: 35, lon: 135.7 }, bounds: { radius: 30 }, content: [{ type: "glb", uri: "assets/a.glb" }] };
    expect(validatePlace({ ...ok, enterFrom: 60 })).toEqual([]);
    expect(validatePlace({ ...ok, enterFrom: -1 }).length).toBe(1);
    expect(ENTER_FROM.interior).toBe(80);
  });
});

describe("city tiles (tileset@2)", () => {
  const ts: Tileset = {
    format: "earthrt/tileset@2",
    frame: "place",
    root: ["13/0/0"],
    materials: { wall: { roughness: 0.8 } },
    tiles: [
      { key: "13/0/0", uri: "tiles/13/0/0.glb", center: [0, 0, 0], radius: 3000, error: 8, children: ["15/0/0", "15/1/0"] },
      { key: "15/0/0", uri: "tiles/15/0/0.glb", center: [-500, 0, 0], radius: 700, error: 0.6 },
      { key: "15/1/0", uri: "@release/v1/15-1-0.glb", center: [500, 0, 0], radius: 700, error: 0.6 },
    ],
  };
  test("a valid tileset passes; problems are named", () => {
    expect(validateTileset(ts)).toEqual([]);
    expect(validateTileset({ ...ts, root: ["13/9/9"] })).toEqual(["root: 13/9/9 is not a tile"]);
    expect(validateTileset({ ...ts, tiles: [{ ...ts.tiles[0], uri: "../x.glb", children: [] }] }).length).toBe(1);
  });
  test("far: the root; near: its children once they are in", () => {
    const far = selectCityTiles(ts, { position: [0, 20000, 0], fov: Math.PI / 4, height: 720, sse: 2 });
    expect(far.show.map((t) => t.key)).toEqual(["13/0/0"]);
    const near = selectCityTiles(ts, { position: [0, 800, 0], fov: Math.PI / 4, height: 720, sse: 2 });
    expect(near.show.map((t) => t.key).sort()).toEqual(["15/0/0", "15/1/0"]);
    const loading = selectCityTiles(ts, { position: [0, 800, 0], fov: Math.PI / 4, height: 720, sse: 2 }, (k) => k !== "15/1/0");
    expect(loading.show.map((t) => t.key)).toEqual(["13/0/0"]);
    expect(loading.want.map((t) => t.key)).toEqual(["15/1/0"]);
  });
  test("a place with tiles is anchored on the ellipsoid", () => {
    const m = { format: "earthrt/place@1", id: "kyoto", title: "Kyoto", kind: "city", anchor: { lat: 35, lon: 135.76, heightRef: "ellipsoid", height: 0 }, bounds: { radius: 9000 }, content: [{ type: "tiles", uri: "tiles/tileset.json" }] };
    expect(validatePlace(m)).toEqual([]);
    expect(validatePlace({ ...m, anchor: { lat: 35, lon: 135.76 } }).length).toBe(1);
  });
});
