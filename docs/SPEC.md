# EarthRT contracts

What the pieces of EarthRT agree on. Change a contract here first, in the same pull request as the code that
follows it. Version numbers are in every format, so an old client meets a new service and knows it.

1. [Frames](#1-frames)
2. [The tile scheme](#2-the-tile-scheme)
3. [Tile addresses](#3-tile-addresses)
4. [Tile files (ERT)](#4-tile-files-ert)
5. [The place manifest (`earthrt.json`)](#5-the-place-manifest-earthrtjson)
6. [Host messages](#6-host-messages)
7. [Launch parameters and dev mode](#7-launch-parameters-and-dev-mode)
8. [The registry API](#8-the-registry-api)

## 1. Frames

- **Geodetic**: WGS84 (`a = 6378137`, `f = 1/298.257223563`), latitude and longitude in degrees, height in metres
  above the ellipsoid. Heights from terrain sources are above mean sea level; the difference (the geoid, ±100 m) is
  ignored in v1 and every height is treated as above the ellipsoid.
- **ECEF**: metres, `float64`, the usual axes (x through 0° N 0° E, z through the north pole).
- **Local frame** at an origin `O` (latitude φ₀, longitude λ₀, on the ellipsoid): **x = east, y = up, z = south**
  (three.js and glTF: right-handed, Y up, metres). `R` is the rotation from ECEF axes to it:
  `x = E·d, y = U·d, z = −N·d` for an ECEF offset `d` from `O`, with `E, N, U` the east, north and up unit vectors at
  `O`. `core/src/geo.ts` `Frame`.
- **Rebase**: the host keeps the camera near `O`. When the camera's horizontal distance from `O` exceeds
  `max(2000 m, altitude / 4)`, `O` becomes the point under the camera and every transform is written again.
- **A tile or a place in the frame**: its own centre `C` (ECEF, doubles) and its vertices relative to `C`. Its
  transform is rotation `R · Rₒ` and translation `R · (C − O)`, where `Rₒ` is the object's own rotation in ECEF
  (identity for tiles: their vertices are in ECEF axes; a place's is its anchor's frame, below).
- **A place's frame**: east-up-south at its anchor (as the local frame, at the anchor instead of `O`), turned about
  its up axis by `heading` degrees: its −z (forward) points `heading` degrees clockwise from north.

## 2. The tile scheme

- **Web Mercator quadtree**: tile `z/x/y` as in XYZ map tiles (x east from −180°, y south from +85.0511°). The trunk's
  terrain goes from z0 to `meta.terrain.maxZoom` (14 in v1); z0 is the whole world in one tile.
- **Polar caps**: `cap/n` (north of 85.0511°) and `cap/s` (south of −85.0511°), one tile each, shown with the z0..z3
  tiles that border them.
- **Grid**: `n × n` vertices (`n = 65` in v1), uniform in Mercator x and y, row 0 the north edge, column 0 the west
  edge; the outer rows and columns are shared with the neighbours (same positions). Each tile has a **skirt**: its
  perimeter again, `skirt` metres lower, so cracks between tiles of different levels are hidden.
- **Refinement**: a tile is replaced by its four children when the view asks for more detail (SSE, below) and all four
  are loaded; until then the parent shows.
- **Screen-space error**: a tile's geometric error is `size / (n − 1) · 1.5`, `size` its width in metres at its centre's
  latitude; it is refined while `error · viewportHeight / (2 · distance · tan(fov / 2))` exceeds the host's
  threshold (web 2.5 px, client 2 px; settings may scale it).
- **Buildings**: one tile per z14 terrain tile (`meta.buildings.zoom`), shown while that terrain tile or a child of it
  shows. A building is in the tile of its centroid.

## 3. Tile addresses

All under the service host (`https://earth.threert.dev` in v1).

| address | what | cache |
| --- | --- | --- |
| `/tiles/v1/meta.json` | `{ v, gen, terrain: { maxZoom, n, skirt }, buildings: { zoom, regions: [{ name, bbox }] }, attribution: [..] }` | 5 min |
| `/tiles/v1/<gen>/terrain/<z>/<x>/<y>.<enc>.ert` | a terrain tile, `enc` = `c` (compact) or `x` (expanded) | immutable |
| `/tiles/v1/<gen>/terrain/cap/<n\|s>.<enc>.ert` | a polar cap | immutable |
| `/tiles/v1/<gen>/terrain/top.c.erp` | z0–z2 compact, packed (21 tiles + 2 caps) | immutable |
| `/tiles/v1/<gen>/buildings/<z>/<x>/<y>.<enc>.ert` | a buildings tile; `204` where there is no building data | immutable |

`gen` is the generation of the generator (`g1`, `g2`, …): a change to what tiles hold bumps it, and clients read it
from `meta.json`. A missing tile is made on its first request (it may take a second) and kept.

## 4. Tile files (ERT)

Little-endian.

```
offset 0      "ERT1"                 4 bytes, ASCII
offset 4      u32 L                  header length in bytes, a multiple of 8
offset 8      header                 JSON, ASCII only (non-ASCII escaped), padded with spaces to L
offset 8 + L  body                   the chunks; each chunk's offset (from the body's start) is a multiple of 8
```

The header:

```jsonc
{
  "v": 1,
  "layer": "terrain",                 // "terrain" | "buildings"
  "key": "12/3593/1621",              // or "cap/n", "cap/s"
  "enc": "compact",                   // "compact" | "expanded"
  "center": [-3958204.1, 3349370.8, 3699022.3],   // C, ECEF (doubles)
  "radius": 7310.2,                   // bounding sphere about C holding every vertex (skirts included)
  "minH": 12.0, "maxH": 845.25,       // terrain: heights above the ellipsoid, m
  "n": 65, "skirt": 180.0,            // terrain
  "count": 1830,                      // buildings
  "chunks": { "h": { "type": "u16", "offset": 0, "count": 4225 }, ... },
  "src": ["terrarium", "worldcover"]  // sources it was made from (attribution in meta.json)
}
```

Chunk types: `u8`, `i8`, `u16`, `i16`, `u32`, `f32`, `f64`. `count` is in elements.

### Terrain, compact

| chunk | type | count | what |
| --- | --- | --- | --- |
| `h` | u16 | n² | height = `minH + h / 65535 · (maxH − minH)`, the water's surface where `water` is set |
| `nrm` | i8 | 2n² | unit normal, ECEF axes, octahedral (`core` `octEncode`): computed by the service from the heights beyond the tile's edge too, so neighbours' edges agree |
| `cls` | u8 | n² | land class (below) |
| `rgb` | u8 | 3n² | albedo, sRGB, made by the service from the class, the climate and the slope |
| `water` | u8 | n² | 255 water, 0 land (in between at shores) |

### Terrain, expanded

`V = n² + 4n` vertices: the grid (row-major), then the skirt: the north edge west to east, the east edge north to
south, the south edge east to west, the west edge south to north (`n` each, corners repeated).

| chunk | type | count | what |
| --- | --- | --- | --- |
| `pos` | f32 | 3V | position relative to `C`, ECEF axes |
| `nrm` | f32 | 3V | unit normal, ECEF axes (a skirt vertex has its edge vertex's) |
| `col` | f32 | 3V | albedo, linear |
| `uv` | f32 | 2V | u = water (0..1), v = class / 255 |

The index is the same for every tile and not in the file: `terrainIndex(n)` (core), counter-clockwise seen from
outside the Earth.

### Land classes

| value | class | ESA WorldCover |
| --- | --- | --- |
| 0 | unknown | — |
| 1 | tree cover | 10 |
| 2 | shrubland | 20 |
| 3 | grassland | 30 |
| 4 | cropland | 40 |
| 5 | built-up | 50 |
| 6 | bare / sparse | 60 |
| 7 | snow and ice | 70 |
| 8 | water | 80 |
| 9 | wetland | 90 |
| 10 | mangroves | 95 |
| 11 | moss and lichen | 100 |

### Buildings, compact

Footprints in the east-north plane at `C` (the tile's centre on the ellipsoid), in eighths of a metre.

| chunk | type | count | what |
| --- | --- | --- | --- |
| `rb` | u32 | count + 1 | building `b` has rings `rb[b] .. rb[b+1] − 1`; the first is the outer ring, the rest holes |
| `rn` | u32 | rings | vertices of each ring (not closed: the last vertex is not the first again) |
| `xy` | i16 | 2 · vertices | east, north × 8 |
| `base` | f32 | count | the ground under it, m above the ellipsoid (the lowest terrain under its footprint) |
| `hgt` | u16 | count | height of the roof above `base`, decimetres |
| `minh` | u16 | count | where the walls start above `base` (OSM `min_height`), decimetres |
| `kind` | u8 | count | 0 other, 1 house, 2 apartments, 3 commercial, 4 industrial, 5 religious, 6 civic, 7 tower |
| `roof` | u8 | count | 0 flat, 1 gabled, 2 hipped, 3 pyramidal, 4 dome, 5 skillion (v1 draws all flat) |
| `wall` | u8 | 3 · count | wall albedo, sRGB |
| `rcol` | u8 | 3 · count | roof albedo, sRGB |

### Buildings, expanded

| chunk | type | count | what |
| --- | --- | --- | --- |
| `pos` | f32 | 3V | relative to `C`, ECEF axes |
| `nrm` | f32 | 3V | ECEF axes |
| `col` | f32 | 3V | linear albedo |
| `uv` | f32 | 2V | walls: u = metres along the wall, v = metres above `base`; roofs: east, north metres |
| `idx` | u32 | 3T | triangles, counter-clockwise seen from outside |

### Packs (ERP)

`"ERP1"`, u32 count, then per tile: u32 byte length, u32 zero, the ERT file padded to a multiple of 8 (so every
file starts at a multiple of 8).

## 5. The place manifest (`earthrt.json`)

At the root of a place's repository (or under the path it was registered with).

```jsonc
{
  "format": "earthrt/place@1",
  "id": "gion-machiya",                 // [a-z0-9][a-z0-9-]{2,63}; unique in the repository
  "title": "A machiya in Gion",
  "summary": "One line for the map and the list.",
  "kind": "interior",                   // "city" | "site" | "interior"
  "topic": "site:gion-machiya",         // optional; what it is an alternative for. Default "<kind>:<id>".
                                        // Cities: "city:<name>" or "city:<name>@<era>", e.g. "city:kyoto@meiji"
  "anchor": { "lat": 35.00366, "lon": 135.77512, "height": 0, "heightRef": "terrain", "heading": 0 },
                                        // heightRef: "terrain" (above the trunk's ground there) | "ellipsoid"
  "bounds": { "radius": 30 },           // m about the anchor, or { "polygon": [[lat, lon], ...] }
  "visibleFrom": 1500,                  // m from the anchor at which it loads; default city 30000, site 3000, interior 300
  "replaces": ["buildings"],            // trunk layers hidden inside the bounds while it shows
  "minDistance": 0.3,                   // closest the camera may come to its content, m (default 1)
  "era": { "label": "Meiji", "year": 1900 },            // optional
  "content": [
    { "type": "glb", "uri": "models/machiya.glb", "position": [0, 0, 0], "rotation": [0, 90, 0], "scale": 1 },
    { "type": "scene", "entry": "dist/scene.js", "source": "scene/main.ts", "fallback": "assets/models/scene.glb" },
    { "type": "tiles", "uri": "tiles/tileset.json" }
  ],
  "start": { "position": [0, 1.6, 6], "target": [0, 1.4, 0] },   // "Go there": camera in the place's frame
  "license": "CC-BY-4.0",
  "credits": ["Model made with Meshy", "© OpenStreetMap contributors"]
}
```

- **`glb`**: `position` (m), `rotation` (Euler degrees, XYZ), `scale` (number or [x, y, z]) in the place's frame. A
  GLB under 64 MiB; textures are its own. Shown on the web (three.js) and in the client. Units as ThreeRT reads a
  GLB: metres, and emission (`emissiveFactor` × `KHR_materials_emissive_strength`) in nits, so a lamp is lit in the
  client; the web scales emission by its own exposure.
- **`scene`**: `entry` is a CommonJS bundle (`format: "cjs"`, `@threert/scene` external, which the loader passes
  to its `require`) whose default export is `build(ctx)`; `ctx` is `{ THREE: <@threert/scene>, place, frame,
  readFile(path): ArrayBuffer, time }` (`time`: the local solar time at the anchor, hours), and `build` returns an `Object3D` in the place's frame (or a promise of
  one). `source` names the TypeScript it was built from. Client only in v1; the web shows the place's `glb`
  content and its marker. `fallback` (optional) is a GLB of the same thing, drawn by a host that does not run scene
  modules (the web in v1) in the scene's place; a host that runs the scene does not draw it. The place template makes
  it from the scene module itself (`bun run bake`: its meshes, materials and lights as glTF).
- **`tiles`**: `tileset.json` = `{ "format": "earthrt/tileset@1", "layer": "terrain" | "buildings" | "mesh",
  "zoom": [15, 18], "tiles": "tiles/{z}/{x}/{y}.{enc}.ert", "keys": ["15/29021/12970", ...] }`: ERT files as § 4,
  in ECEF (not the place's frame), drawn instead of the trunk's inside the bounds.
- Paths are relative to the manifest; no `..`, no absolute paths, no URLs (everything comes through the mirror).
- The index refuses a manifest that does not pass `validatePlace` (core).

## 6. Host messages

The client and EarthRT's package talk over ThreeRT's host channel (ThreeRT `docs/RUNTIME.md`, "The host channel").
EarthRT needs one family beyond what the client has:

| `t` | direction | fields | |
| --- | --- | --- | --- |
| `assets.fetch` | game → app | `id`, `url`, `path`, `sha256?` | download `url` (https, the client's network policy) to `path` under the package's asset root; `path` starts with `cache/` |
| `assets.fetched` | app → game | `id`, `path`, `status`, `size`, `cached`, `error?` | done: `readAsset(path)` reads it. `status` the HTTP status (0 failed, `error` says why); `cached` when it was there already (same `url`, or same `sha256`) |
| `assets.cancel` | game → app | `id` | forget a request that has not finished |

An app that has it lists `"assets"` in `launch.caps`. At most 16 requests are under way; more wait in order. A
response body may be up to 64 MiB.

## 7. Launch parameters and dev mode

The package and the web page read the same parameters (the client's launch `params`, the page's query):

| parameter | what |
| --- | --- |
| `at=lat,lon,alt[,heading,pitch]` | start the camera there (degrees, metres) |
| `place=<owner>/<repo>/<id>` | open a place (fly there, load it) |
| `fly=<from>;<to>` | start a flight (`lat,lon` or a place id each) |
| `api=<url>` | another service (a local `wrangler dev`) |
| `dev=<url>` | a place under development: its `earthrt.json` and files are read from `<url>` instead of the mirror |

**Dev mode.** A place project (`threert/earth-place-template`) is itself an EarthRT package: its entry is EarthRT's
with the project's own `earthrt.json` given as the dev place, and its files are the package's assets. So
`threert dev` in the project shows the globe, flies to the place, and reloads it on every save, in the client and in
the page, with no special network rule.

## 8. The registry API

JSON over HTTPS at `/api/v1`. Writes take `Authorization: Bearer <GitHub token>` (a `gh auth token`, or the web
sign-in's): the service asks GitHub who it is and whether it may push to the repository, and keeps neither token
nor anything else of the account but its login and id.

| method and path | what |
| --- | --- |
| `GET /places?bbox=w,s,e,n&kind=&topic=&q=&limit=` | places whose bounds meet the box, each with its topic's rank |
| `GET /places/<owner>/<repo>/<id>` | one place: the manifest, the commit, `files` (the mirror's base URL), likes, stars, author |
| `GET /topics/<topic>` | the places of a topic, best first (`likes + stars`), and which is the default |
| `POST /places` `{ repo: "owner/name", path? }` | register: reads `earthrt.json` at the default branch's head, checks it, records the commit. Needs push access |
| `POST /places/<owner>/<repo>/<id>/refresh` | read the repository again (a new commit is a new version) |
| `PUT` / `DELETE /places/<owner>/<repo>/<id>/like` | like, unlike (any signed-in GitHub account) |
| `GET /me` | who the token is |

Files: `GET /p/<owner>/<repo>/<sha>/<path>` serves the file at that commit (read from GitHub once, then from R2;
Git LFS files followed), immutable, with the type of a model or of data, never of a page.

Discovery: every hour the service searches GitHub for repositories with the topic `earthrt-place` and registers those whose
`earthrt.json` passes, under the repository owner's name.
