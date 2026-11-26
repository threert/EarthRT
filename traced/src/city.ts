// A place's city tiles (SPEC § 5 `tiles`, `earthrt/tileset@2`): GLB tiles in the place's frame, a quadtree refined by
// screen-space error with replacement (core `selectCityTiles`: a tile, or all of its children once each is in). A tile
// is fetched, parsed ahead on the engine's worker (`preloadModel`), added as a still `GLTFModel` with the traced view's
// material functions bound by material name (`facade`: windows; `water`), and parked (moved out of sight, never
// hidden: RUNTIME "Streaming") while it is not shown.
import { GLTFModel, preloadModel, type Scene, type ShaderBinding } from "@threert/scene";
import { selectCityTiles, validateTileset, type Tileset, type TilesetTile, type V3 } from "../../packages/core/src/index.ts";
import { exists, readText, type Files } from "./source.ts";
import { cachePath } from "./tiles.ts";

interface CityTile {
  t: TilesetTile;
  state: "fetching" | "parsing" | "ready" | "failed";
  model?: GLTFModel;
  at: number;
  shown: boolean;
  touched: number;
}

const PARK: V3 = [0, -1e7, 0];

export class CityTiles {
  ts: Tileset | null = null;
  private tiles = new Map<string, CityTile>();
  private frameNo = 0;
  /** Where the tiles' files are: a URL base (the mirror at the place's commit, with tileset.json's folder) or a folder. */
  private base = "";
  private root = "";
  private folder = false;
  /** The content's height in the scene's frame (the place's origin above the anchor on the ellipsoid). */
  height = 0;
  sse = 2;
  viewportHeight = 720;
  maxResident = 260;
  stats = { shown: 0, resident: 0, wanted: 0, fetching: 0 };
  ready = false;

  constructor(private scene: Scene, private files: () => Files, private functions: Record<string, ShaderBinding>) {}

  /** `src`: the place's files' base URL (or folder); `uri`: tileset.json relative to the manifest. */
  open(src: { files: string | null; folder?: string }, uri: string, height: number): Promise<void> {
    this.close();
    this.height = height;
    this.folder = src.folder !== undefined;
    this.root = (src.folder ?? src.files ?? "").replace(/\/$/, "");
    const dir = uri.includes("/") ? uri.slice(0, uri.lastIndexOf("/") + 1) : "";
    this.base = `${this.root}/${dir}`.replace(/\/$/, "");
    const take = (text: string | null) => {
      if (!text) throw new Error(`${uri}: unreadable`);
      const ts = JSON.parse(text) as Tileset;
      const errs = validateTileset(ts);
      if (errs.length) console.log(`traced: ${uri}: ${errs.slice(0, 3).join("; ")}`);
      this.ts = ts;
    };
    if (this.folder) {
      take(readText(`${this.root}/${uri}`));
      return Promise.resolve();
    }
    const url = `${this.root}/${uri}`;
    return this.files().get(url, cachePath(url)).then((f) => {
      if (f.status !== 200) throw new Error(`${uri}: ${f.status}`);
      take(readText(cachePath(url)));
    });
  }

  private where(t: TilesetTile): { url: string; path: string } {
    // `@release/<tag>/<asset>`: a release's file, through the mirror at the place's commit (SPEC § 8)
    const rel = t.uri.startsWith("@release/");
    if (this.folder) return { url: "", path: `${rel ? this.root : this.base}/${t.uri}` };
    const url = `${rel ? this.root : this.base}/${t.uri}`;
    return { url, path: cachePath(url) };
  }

  /** Once a frame: the camera in the scene's frame. */
  update(camera: V3, fov: number) {
    this.frameNo++;
    if (!this.ts) return;
    const pos: [number, number, number] = [camera[0], camera[1] - this.height, camera[2]];
    const loaded = (key: string) => this.tiles.get(key)?.state === "ready";
    const sel = selectCityTiles(this.ts, { position: pos, fov, height: this.viewportHeight, sse: this.sse }, loaded);
    const show = new Set(sel.show.filter((t) => loaded(t.key)).map((t) => t.key));
    let fetching = 0;
    for (const t of sel.want) {
      if (this.tiles.has(t.key)) continue;
      const ct: CityTile = { t, state: "fetching", at: 0, shown: false, touched: this.frameNo };
      this.tiles.set(t.key, ct);
      const { url, path } = this.where(t);
      const got = this.folder ? Promise.resolve({ status: exists(path) ? 200 : 404 }) : this.files().get(url, path);
      void got.then(
        (f) => {
          if (this.tiles.get(t.key) !== ct) return;
          if (f.status !== 200) {
            ct.state = "failed";
            return;
          }
          preloadModel(path);
          ct.state = "parsing";
          ct.at = this.frameNo + 2;
        },
        () => {
          if (this.tiles.get(t.key) === ct) ct.state = "failed";
        },
      );
    }
    for (const ct of this.tiles.values()) {
      if (ct.state === "fetching") fetching++;
      // (parsed on the engine's worker meanwhile; then a still model, parked until it shows)
      if (ct.state === "parsing" && this.frameNo >= ct.at) {
        const { path } = this.where(ct.t);
        const m = new GLTFModel(path, { functions: this.functions });
        m.name = `city:${ct.t.key}`;
        ct.model = m;
        ct.state = "ready";
        this.place(ct, false);
        this.scene.add(m);
      }
      const want = show.has(ct.t.key);
      if (want) ct.touched = this.frameNo;
      if (ct.model && want !== ct.shown) this.place(ct, want);
    }
    // least recently shown out, past the budget
    if (this.tiles.size > this.maxResident) {
      const old = [...this.tiles.values()].filter((c) => !c.shown && c.state !== "fetching" && c.state !== "parsing").sort((a, b) => a.touched - b.touched);
      for (const c of old.slice(0, this.tiles.size - this.maxResident)) {
        c.model?.parent?.remove(c.model);
        this.tiles.delete(c.t.key);
      }
    }
    this.stats = { shown: show.size, resident: this.tiles.size, wanted: sel.want.length, fetching };
    this.ready = sel.want.length === 0 || [...this.tiles.values()].every((c) => c.state === "ready" || c.state === "failed");
  }

  private place(ct: CityTile, shown: boolean) {
    ct.shown = shown;
    const m = ct.model!;
    if (shown) m.position.set(0, this.height, 0);
    else m.position.set(PARK[0], PARK[1], PARK[2]);
  }

  close() {
    for (const c of this.tiles.values()) c.model?.parent?.remove(c.model);
    this.tiles.clear();
    this.ts = null;
    this.ready = false;
  }
}
