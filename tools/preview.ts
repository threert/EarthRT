// Contact sheets of the trunk to judge it by eye (S2's check): the globe from orbit at several longitudes, and
// top-down tiles at fixed places. Tiles come from the service (--api) or are made locally (default).
//   bun tools/preview.ts globe [--z 3] [--size 768] [--out out/s2/globe.png] [--api https://earth.threert.dev]
//   bun tools/preview.ts tiles [--out out/s2/tiles.png] [--api …]
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { keyOf, parseKey, tileAt, type TileKey } from "../packages/core/src/index.ts";
import { makeTerrainTile } from "../service/src/gen/terrain.ts";
import { WorldCover } from "../service/src/gen/landcover.ts";
import { encodePng } from "../service/src/gen/png.ts";
import { MemoUpstream } from "../service/src/gen/upstream.ts";
import { BunUpstream, curl } from "./lib/bun-upstream.ts";
import { contactSheet, globe, topDown, view, type TileView } from "./lib/render.ts";

const args = process.argv.slice(2);
const opt = (f: string, d?: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const api = opt("--api");
const up = new MemoUpstream(new BunUpstream());
const lc = new WorldCover(up);
const gen = api ? JSON.parse(new TextDecoder().decode((await curl(`${api}/tiles/v1/meta.json`)).body)).gen : "";

async function tile(k: TileKey): Promise<Uint8Array> {
  if (api) {
    const r = await curl(`${api}/tiles/v1/${gen}/terrain/${keyOf(k)}.c.ert`);
    if (r.status !== 200) throw new Error(`${keyOf(k)}: ${r.status}`);
    return r.body;
  }
  return makeTerrainTile(up, k, lc);
}

async function pool<T>(items: T[], n: number, f: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await f(items[i++]); }));
}

const what = args[0] ?? "globe";
const out = opt("--out", `out/s2/${what}.png`)!;
mkdirSync(dirname(out), { recursive: true });

if (what === "globe") {
  const z = Number(opt("--z", "3")), size = Number(opt("--size", "640"));
  const keys: TileKey[] = [{ cap: "n" }, { cap: "s" }];
  for (let y = 0; y < 2 ** z; y++) for (let x = 0; x < 2 ** z; x++) keys.push({ z, x, y });
  const tiles = new Map<string, TileView>();
  const t0 = performance.now();
  await pool(keys, 8, async (k) => { tiles.set(keyOf(k), view(await tile(k), k)); });
  console.log(`${keys.length} tiles in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  const views = [
    { lat: 20, lon: 10, sun: [10, 0] }, { lat: 25, lon: 100, sun: [10, 90] }, { lat: 15, lon: -80, sun: [10, -70] },
    { lat: -20, lon: 140, sun: [-10, 130] }, { lat: 70, lon: 0, sun: [20, 20] }, { lat: -70, lon: 60, sun: [-20, 60] },
  ];
  const pics = views.map((v) => globe(tiles, z, v.lat, v.lon, size, v.sun[0], v.sun[1]));
  writeFileSync(out, await encodePng(contactSheet(pics, 3)));
  console.log(out);
} else {
  // fixed places, at orbit-scale zooms and close ones
  const places: [string, number, number, number][] = [
    ["Japan z5", 35, 136, 5], ["Himalaya z6", 28.0, 86.9, 6], ["Sahara z5", 23, 10, 5], ["Amazon z5", -5, -62, 5],
    ["Alps z8", 46.5, 8.5, 8], ["Kyoto z10", 35.0, 135.77, 10], ["Kyoto z12", 35.0, 135.77, 12], ["Kyoto z14", 34.985, 135.758, 14],
    ["Fuji z12", 35.36, 138.73, 12], ["SF Bay z10", 37.7, -122.3, 10], ["Netherlands z9", 52.3, 4.9, 9], ["Greenland z5", 72, -40, 5],
  ];
  const pics: ReturnType<typeof topDown>[] = new Array(places.length);
  await pool(places.map((p, i) => [p, i] as const), 4, async ([[name, lat, lon, z], i]) => {
    const k = tileAt(lat, lon, z);
    const t0 = performance.now();
    pics[i] = topDown(view(await tile(k), k), 384);
    console.log(`${name} ${keyOf(k)} ${(performance.now() - t0).toFixed(0)} ms`);
  });
  writeFileSync(out, await encodePng(contactSheet(pics, 4)));
  console.log(out);
}
void parseKey;
