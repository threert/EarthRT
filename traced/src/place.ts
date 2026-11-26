// A place's content in the traced view (SPEC § 5): `glb` models (fetched into the cache, parsed ahead on the engine's
// worker with `preloadModel`, then added), a `scene` module (its CommonJS bundle compiled here, `@threert/scene`
// supplied: the engine's QuickJS has `new Function`), `fallback` GLBs never (they are for hosts that do not run the
// scene). The scene's frame is the place's own axes at the ellipsoid under the anchor; the content sits at the anchor's
// height in it (the ground there plus `anchor.height`, or that height above the ellipsoid).
import * as THREE from "@threert/scene";
import { GLTFModel, preloadModel, readAsset, type Object3D, type Scene } from "@threert/scene";
import { placeFrame, type PlaceManifest, type Quat, type V3 } from "../../packages/core/src/index.ts";
import { exists, readText, type Files } from "./source.ts";
import { CityTiles } from "./city.ts";
import { cityFunctions } from "./materials.ts";
import { cachePath } from "./tiles.ts";

/** What `traced.open` names: a registry record, or a folder under the asset root (dev). */
export interface PlaceSource {
  id: string;
  manifest: PlaceManifest;
  /** Base URL of the place's files (the registry's mirror), or null for a folder. */
  files: string | null;
  /** The folder under the asset root (dev: `dev/<name>/`). */
  folder?: string;
}

interface Item {
  obj: Object3D;
  local: { p: V3; q: Quat; s: V3 };
}

export class PlaceContent {
  source: PlaceSource | null = null;
  private items: Item[] = [];
  /** Models parsed ahead, added when their frame comes. */
  private pending: { at: number; path: string; local: Item["local"]; name: string }[] = [];
  private frameNo = 0;
  /** Height of the content's origin above the ellipsoid. */
  height = 0;
  total = 0;
  done = 0;
  failed: string[] = [];
  private gen = 0;

  /** The place's city tiles (content `tiles`), if it has them. */
  city: CityTiles;

  constructor(private scene: Scene, private files: () => Files, private solarHour: (lon: number) => number) {
    this.city = new CityTiles(scene, files, cityFunctions());
  }

  get ready() {
    return this.total > 0 && this.done >= this.total && this.pending.length === 0 && (!this.city.ts || this.city.ready);
  }

  /** Loads a place's content. `ground`: the terrain's height under the anchor (NaN if not known yet). */
  open(src: PlaceSource, ground: number) {
    this.close();
    const gen = ++this.gen;
    this.source = src;
    const m = src.manifest;
    this.height = this.heightFor(ground);
    const work = m.content.filter((c) => c.type === "glb" || c.type === "scene" || c.type === "tiles");
    this.total = work.length;
    this.done = 0;
    this.failed = [];
    const fetch = async (uri: string): Promise<string> => {
      if (src.folder !== undefined) {
        const path = `${src.folder.replace(/\/$/, "")}/${uri}`;
        if (!exists(path)) throw new Error(`${uri}: not in ${src.folder}`);
        return path;
      }
      const url = `${src.files}/${uri}`;
      const path = cachePath(url);
      const f = await this.files().get(url, path);
      if (f.status !== 200) throw new Error(`${uri}: ${f.status}`);
      return path;
    };
    for (const c of work) {
      void (async () => {
        if (c.type === "glb") {
          const path = await fetch(c.uri);
          if (gen !== this.gen) return;
          preloadModel(path);
          const s = typeof c.scale === "number" ? [c.scale, c.scale, c.scale] : (c.scale ?? [1, 1, 1]);
          // (added two frames on: the parse runs on the engine's worker meanwhile, not in a frame's commit)
          this.pending.push({ at: this.frameNo + 2, path, local: { p: (c.position ?? [0, 0, 0]) as V3, q: eulerDeg(c.rotation ?? [0, 0, 0]), s: s as V3 }, name: `place:${src.id}:${c.uri}` });
        } else if (c.type === "tiles") {
          await this.city.open(src, c.uri, this.height);
          if (gen !== this.gen) return this.city.close();
        } else if (c.type === "scene") {
          const path = await fetch(c.entry);
          const code = readText(path);
          if (!code) throw new Error(`${c.entry}: unreadable`);
          const base = path.slice(0, path.length - c.entry.length);
          const frame = placeFrame(m, this.height - (m.anchor.height ?? 0));
          const obj = await buildScene(code, { THREE, place: m, frame, readFile: (p: string) => readAsset(base + p), time: this.solarHour(m.anchor.lon) });
          if (gen !== this.gen) return;
          obj.name ||= `place:${src.id}:${c.entry}`;
          // (its own transform as built, in the place's frame: lifted to the anchor's height)
          const q = obj.quaternion;
          this.add({ obj, local: { p: [obj.position.x, obj.position.y, obj.position.z], q: [q.x, q.y, q.z, q.w], s: [obj.scale.x, obj.scale.y, obj.scale.z] } });
        }
        this.done++;
      })().catch((e) => {
        if (gen !== this.gen) return;
        this.done++;
        this.failed.push(String((e as Error)?.message ?? e));
        console.log(`traced: ${src.id}: ${(e as Error)?.message ?? e}`);
      });
    }
  }

  private heightFor(ground: number): number {
    const a = this.source!.manifest.anchor;
    return (a.height ?? 0) + (a.heightRef === "ellipsoid" ? 0 : isFinite(ground) ? ground : 0);
  }

  /** The ground under the anchor became known (or finer): the content moves onto it. */
  setGround(ground: number) {
    if (!this.source) return;
    const h = this.heightFor(ground);
    if (Math.abs(h - this.height) < 0.01) return;
    this.height = h;
    for (const it of this.items) this.place(it);
    this.city.height = h;
  }

  update() {
    this.frameNo++;
    for (let k = this.pending.length - 1; k >= 0; k--) {
      const p = this.pending[k];
      if (this.frameNo < p.at) continue;
      this.pending.splice(k, 1);
      const model = new GLTFModel(p.path);
      model.name = p.name;
      this.add({ obj: model, local: p.local });
    }
  }

  private add(it: Item) {
    this.items.push(it);
    this.place(it);
    this.scene.add(it.obj);
  }

  /** In the scene's frame: the content's origin straight above the frame's (the anchor), its own transform on it. */
  private place(it: Item) {
    it.obj.position.set(it.local.p[0], it.local.p[1] + this.height, it.local.p[2]);
    it.obj.quaternion.set(it.local.q[0], it.local.q[1], it.local.q[2], it.local.q[3]);
    it.obj.scale.set(it.local.s[0], it.local.s[1], it.local.s[2]);
  }

  close() {
    this.gen++;
    for (const it of this.items) it.obj.parent?.remove(it.obj);
    this.items = [];
    this.pending = [];
    this.city.close();
    this.source = null;
    this.total = this.done = 0;
  }

  /** The bounds' radius (m) when the place replaces the trunk's buildings, else 0. */
  cutRadiusOf(m: PlaceManifest): number {
    if (!m.replaces?.includes("buildings")) return 0;
    const b = m.bounds as { radius?: number; polygon?: [number, number][] };
    if (b.radius !== undefined) return b.radius;
    let r = 0;
    for (const [la, lo] of b.polygon ?? []) r = Math.max(r, Math.hypot((la - m.anchor.lat) * 111_320, (lo - m.anchor.lon) * 111_320 * Math.cos((m.anchor.lat * Math.PI) / 180)));
    return r;
  }
}

/** A `scene` content's bundle (CommonJS, `@threert/scene` external) built: `build(ctx)` (SPEC § 5). */
async function buildScene(code: string, ctx: Record<string, unknown>): Promise<Object3D> {
  const module = { exports: {} as Record<string, unknown> };
  const require = (name: string) => {
    if (name === "@threert/scene") return THREE;
    throw new Error(`a place's scene may require "@threert/scene" only (not "${name}")`);
  };
  const fn = new Function("module", "exports", "require", code) as (m: unknown, e: unknown, r: unknown) => void;
  fn(module, module.exports, require);
  const build = (module.exports.default ?? module.exports) as (c: unknown) => Object3D | Promise<Object3D>;
  if (typeof build !== "function") throw new Error("the scene module exports no build(ctx)");
  return await build(ctx);
}

/** Euler angles (degrees, XYZ: three.js's order) as a quaternion. */
export function eulerDeg(r: number[]): Quat {
  const [x, y, z] = r.map((d) => (d * Math.PI) / 360);
  const c1 = Math.cos(x), c2 = Math.cos(y), c3 = Math.cos(z), s1 = Math.sin(x), s2 = Math.sin(y), s3 = Math.sin(z);
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3];
}
