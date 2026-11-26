# EarthRT architecture

EarthRT is a whole-Earth viewer built on [ThreeRT](https://github.com/meshy-dev/ThreeRT). One globe (the **trunk**)
covers every place on Earth down to the view from an aeroplane window. Cities, sites and rooms in finer detail are
**places**: each one a GitHub repository, registered at a spot on the map, pulled in by the index, and chosen among
when several people made the same city. A web page at the project's domain shows the globe in any browser; the
**EarthRT app**, a native app of its own (macOS first), shows the same globe path-traced (every light traced, MetalFX
or DLSS Ray Reconstruction as the denoiser) and is where places are made.

This document is the design and the reasons for it. The contracts the pieces share (frames, tiles, the place
manifest, the API, the host messages) are in [SPEC.md](SPEC.md); what is built and what comes next is in
[ROADMAP.md](ROADMAP.md).

```
            GitHub                                    Cloudflare (one Worker, R2, D1, Cache)
  ┌──────────────────────────┐            ┌─────────────────────────────────────────────────────────┐
  │ place repos (anyone's)   │  index ◀── │ /api/v1   places registry: register, discover (topic),   │
  │   earthrt.json + GLB /   │  mirror ──▶│           versions ranked by likes + stars, likes        │
  │   scene.ts / tiles       │            │ /p/…      repo files at a commit, mirrored into R2       │
  │ first-party cities       │            │ /tiles/v1 the trunk: terrain + land cover + buildings,   │
  │   threert/earth-<city>   │            │           made on first request from open data, kept     │
  └──────────────────────────┘            │ /         the web app, the native app's downloads      │
                                          └───────────────▲───────────────────────────▲─────────────┘
  open data: Mapzen/AWS terrain tiles,                    │                           │
  ESA WorldCover, OSM (Protomaps), …  ───────────────────▶│                           │
                                                          │ https                     │ https (assets.fetch)
                                   ┌──────────────────────┴───────┐   ┌───────────────┴──────────────────────┐
                                   │ web engine (three.js)        │   │ EarthRT app (native: SwiftUI on macOS │
                                   │ raster, WebGPU or WebGL2     │   │ first, iOS and Windows later): ThreeRT│
                                   │ workers decode, LRU, cache   │   │ path-traced, MetalFX / DLSS-RR, disk  │
                                   │ GLB places, fly, pick        │   │ cache, flights, making places + agent │
                                   └──────────────┬───────────────┘   └───────────────┬───────────────────────┘
                                                  └─────────── @earthrt/core ─────────┘
                                  geodesy, the floating frame, tile selection, request scheduling, tile codec,
                                  flights, place resolution — plain TypeScript, the same on both hosts
```

## Decisions

### 1. One core, two renderers

The globe's logic is written once (`packages/core`, plain TypeScript with no DOM and no engine imports): which tiles
a view needs, in what order to fetch them, how a tile's bytes become vertex arrays, where everything sits relative
to the camera, how a flight moves, which version of a place to show. Two hosts draw it:

- **The EarthRT app** (`native/`) embeds ThreeRT and runs `app/`, the globe's scene script (a game in ThreeRT's
  sense: `defineGame`, `@threert/scene`), in the engine's QuickJS; the script turns tiles into `Mesh`es and places
  into `GLTFModel`s or scene modules, and the engine traces them. This is where the picture is best: path tracing,
  the sky's own atmosphere, water that reflects it, the app's Graphics settings (MetalFX denoising on Apple GPUs,
  DLSS-RR on NVIDIA when there is a Windows app).
- **The web engine** (`web/`) is three.js, written for this app and not ThreeRT's generic three.js view: the
  generic view maps ThreeRT materials one for one, and a globe needs its own shaders (an atmosphere seen from orbit,
  a logarithmic depth range from 1 m to 40,000 km, water) and its own loading (below). It draws the same tiles and
  the same places by the same core.

Why not the engine's own wasm build in the browser: WebGPU has no ray-tracing hardware, the engine's software
traversal pays a scene rebuild on every streamed tile, and WebGPU is not in every browser. The web is the open door
(fast first picture, any device), the app is the upgrade. The page offers "Open in EarthRT" (`earthrt://…`, the same
view; SPEC § 7) and the app's download.

### 1a. The native app is EarthRT's own (decided by the user, 2026-11-26)

Not a package inside the ThreeRT client: EarthRT is its own product, with its own icon, window and native interface.
It has the shape of [threert/native-app-template](https://github.com/threert/native-app-template) (ThreeRT's
recommended way to embed the engine), in `native/`:

| part | what |
| --- | --- |
| `native/core` | Rust static library: ThreeRT's `LiveCore` and a game session running `app/`'s bundled script; the host channel answered natively (`assets.fetch` into the app's disk cache, `net.fetch`, input, the `earth.*` family: SPEC § 6); a small C ABI (`ert_*`) |
| `native/macos` | SwiftUI: the globe view on a `CAMetalLayer`; search; the place panel (versions ranked, eras, likes); flights; time of day; offline downloads; Graphics (quality, denoiser: MetalFX or ThreeRT's); GitHub sign-in; Create, Remix and Publish; the Meshy panel; the agent panel |
| `native/sidecar` | Bun: the agent bridge (ACP, as in the template: the user's own Claude Code or Codex in a side panel, on their own quota), building a place's scene module on save, Meshy and GitHub calls for making places |

The interface over the picture is the app's own (SwiftUI), not the engine's HUD: the globe script reports what it
shows (`earth.view`, `earth.places`, `earth.selected`, …) and the app sends what the user asks (`earth.goto`,
`earth.choose`, `earth.fly`, …). macOS first; iOS shares the SwiftUI; a Windows app (DLSS-RR) follows the same
core. Distribution: a Developer ID signed and notarised download from the project's site, updates by Sparkle.

### 2. Coordinates: ECEF in doubles, a floating local frame in floats

GPUs and the engine's transforms are 32-bit. The Earth is 12,742 km across, and 32 bits hold about 7 digits.

- Everything is placed in **ECEF** (WGS84, metres, `float64`) on the CPU.
- What is drawn is in a **local frame**: east-up-south at an origin `O` on the ellipsoid, as three.js expects
  (x east, y up, z south; right-handed, Y up, metres). The camera stays within a short way of `O`; when it moves
  further (`max(2 km, altitude / 4)` sideways), `O` moves under it (a **rebase**): every tile's transform is
  written again (a TLAS update: instances only, no geometry), the sun's direction turns with the frame.
- **A tile's vertices are relative to its own centre** `C` (ECEF axes, `float32`). Its transform in the frame is
  the frame's rotation `R` (the same for every tile) and the translation `R·(C − O)`, computed in doubles. At the
  globe's scale a vertex is within about 0.5 m of where it belongs; near the camera, millimetres.
- **The sky** is ThreeRT's physical atmosphere, which depends on the viewer's altitude and the sun's angle to the
  local zenith only. With `y` = the local up at `O` and the camera's real altitude given to it (engine change:
  `SkyAtmosphere.altitude`, ROADMAP), the same model serves a street and low orbit.
- Ray tracing has no depth buffer, so the app has no near/far problem; the web uses a logarithmic depth buffer.

### 3. The trunk: made from open data on first request

The trunk is a quadtree of **Web Mercator tiles** (`z/x/y`, the scheme of every open terrain and map tile set, so
sources line up with tiles without resampling across tile edges), z0 to z14 for terrain (~38 m between vertices at
z14 on the equator, finer toward the poles), with two **polar caps** for what Mercator leaves out (north and south
of 85.05°).

A tile is not baked ahead for the whole planet (z0–z14 is 358 million tiles). The Worker makes a tile the first time
anyone asks for it, from the sources, and keeps it in R2; afterwards it is a file. This is the data loading layer the
project keeps optimising: what a tile holds, which sources feed it, how fine it goes, are all versions of the tile
endpoint (`/tiles/v1/…`), and a new version starts empty and fills itself as people look.

- **Terrain**: heights from the AWS Terrain Tiles (Mapzen Terrarium: SRTM, GMTED, ETOPO1, national DEMs; open data,
  attribution), bathymetry included; the surface drawn at sea level where the land is under it (water).
- **Land cover**: ESA WorldCover 10 m (CC BY 4.0), read straight from its Cloud-Optimised GeoTIFFs on AWS by range
  requests, gives each vertex a class; the colour and the material's detail come from the class, the climate
  (latitude, altitude) and the slope: **procedural, driven by real data**, not photographs. Photographs bake in a
  sun that is not the scene's; a path tracer lights the land itself.
- **Buildings**: OpenStreetMap footprints and heights (Protomaps extracts in R2, ODbL), extruded at z14, with
  heights from tags or a plausible default. This gives the aeroplane view over any city in the extracts; extracts
  grow region by region (ROADMAP).
- **Two encodings of every tile** (SPEC § 4): *compact* (quantised heights, class and colour bytes, footprints:
  ~10–30 KB, for the web, which expands it in a worker in milliseconds) and *expanded* (the vertex arrays as the
  engine takes them, for the native app, whose script runs in an interpreter and must not loop over vertices). The
  Worker expands compact tiles itself; both are cached at the edge.
- Building meshes and terrain meshes are made by the same core function on all three (Worker, web worker, and the
  bake tools), so a tile looks the same everywhere.

### 4. Places: GitHub repositories, registered on the map

A place is a repository with `earthrt.json` at its root (SPEC § 5): where it is (an anchor: latitude, longitude,
height, heading), how far it reaches (a radius or polygon), what kind it is (**city**, **site**, **interior**), what
it replaces of the trunk inside it (e.g. the trunk's buildings), and its content:

- **`glb`**: models placed in the place's local frame (east-up-south at the anchor). Runs on the web and in the
  app. A model made by Meshy is this.
- **`scene`**: a ThreeRT scene module (`export default function build(ctx)`), the same API as any ThreeRT game,
  built in the place's frame. App only for now (the web shows its baked `fallback` GLB): on the web it would be
  someone else's code on our origin; it comes there in a sandboxed worker later (ROADMAP).
- **`tiles`**: a city-sized tile set in the trunk's format (finer levels, z15–z18), produced by the repository's
  own generator and published as release files (GitHub Releases hold the bytes; the index mirrors them).

**Registering** (`POST /api/v1/places`, or the `earthrt-place` topic on GitHub, which the index's hourly crawl picks up):
the index reads `earthrt.json` at the repository's head, checks it, records the commit, and from then on serves the
place's files at that commit from its mirror (`/p/<owner>/<repo>/<sha>/…`: GitHub is read once a file, R2 serves it
after). A new commit is a new version of the place after a refresh (a button, a webhook, the crawl).

**Several of the same.** Places say which **topic** they are an alternative for (`city:kyoto`, `city:kyoto@meiji`
for an era) or are grouped by overlap. For each topic the app and the page show one: the user's own choice, else the one
ranked first by likes (EarthRT's own) plus the repository's stars. The place panel lists the others, and an era is
just another topic the user can switch to.

**Close views are earned.** Without a place, the trunk stops at the aeroplane view (the camera keeps a minimum
height over the terrain that eases with the trunk's detail). A place lets the camera go as close as its content
allows, down to walking in a room.

### 5. Making places: in the app, with the user's own agent

In the app: pick a spot (or a building) → **Create here**, or open a place → **Remix**. The app makes a project from
the place template (`threert/earth-place-template`) or clones the place's repository (`~/EarthRT/places/<name>`),
puts the anchor in its `earthrt.json`, opens it in dev mode (SPEC § 7: the place shows inside the globe at its
anchor and reloads on every save) and starts the user's own Claude Code or Codex in the agent panel, on their own
quota, with the project's AGENTS.md. The agent uses the template's tools: `tools/meshy.ts` (text or image to 3D
through the user's Meshy API key, the GLB sized and placed), `tools/place.ts`, `tools/check.ts`. The app's own
Meshy panel does the same for a user who just wants a model at a spot. **Publish** pushes to GitHub (a new
repository under the user's account, the `earthrt-place` topic) and registers it.

### 6. First-party cities are places too

Kyoto, Tokyo, New York, Shanghai, San Francisco and a few European cities are repositories under `threert/`
(`earth-<city>`), on the same contract as anyone's, so the contract is exercised by its hardest users and the first
party gets no private path. Their generators are procedural from open data (OSM, PLATEAU where it exists, terrain),
with GLB landmarks where a generator falls short.

### 7. Loading, for the web first

- First picture: the page's HTML, a small script and **one request for the globe's top two levels and the caps** (z0–z1
  packed, ~110 KB with brotli; z2's 16 tiles follow, ~14 KB each), before three.js's own code has finished loading the rest.
- Tiles by need: the core's selector ranks tiles by screen-space error and distance from the view's centre; the
  scheduler keeps a fixed number of requests in flight (HTTP/2), drops requests the view no longer wants
  (`AbortController`), retries with backoff, and adds what arrived under a per-frame budget.
- Decoding and meshing in a pool of web workers (transferable buffers); an LRU of GPU meshes under a byte budget;
  tiles kept in the Cache Storage API, so a second visit is local. Tile URLs are immutable (the version is in the
  path) and served with year-long cache headers.
- The app caches every file on disk (`assets.fetch` writes into its cache), so a city once seen, or a
  flight prepared ("download for offline": every tile along a route at the detail the route needs), plays without
  the network.

### 8. Flights

A flight is a fixed track: a great circle between two places with a climb, a cruise height and a descent, timed. The
camera rides it; the user looks around freely (yaw and pitch relative to the track). Because the track is known,
the tiles it will need are known ahead: the scheduler fetches them by when they will be needed, at a lower
priority than what is on screen, and a flight can be prepared for offline in full.

## What this asks of ThreeRT

| change | where | why |
| --- | --- | --- |
| `SkyAtmosphere.altitude` (the viewer's real altitude, re-baked in place when it changes) | meshy-dev/ThreeRT | a floating frame keeps the camera near y = 0; the sky must see 10 km or 400 km |
| `assets.fetch` host family, as a library piece an embedding app reuses, and in `threert-render play` | meshy-dev/ThreeRT | binary tiles into a cache directory, then `readAsset`; the EarthRT app's core links it, `play` is the development loop |
| texture slots freed when nothing names them | meshy-dev/ThreeRT | GLB places come and go; the texture pages must not only grow |
| streaming budget per frame, measured on a globe | meshy-dev/ThreeRT, `app/` | thousands of tiles over a flight |

## Repositories

| repository | what | visibility |
| --- | --- | --- |
| `threert/EarthRT` | this: core, the globe's scene script (`app/`), the native app (`native/`), the web engine, the service, tools, the spec | public, MIT |
| `threert/earth-place-template` | the template for a place (scene, models, Meshy tool, AGENTS.md, checks) | public, template |
| `threert/earth-<city>` | first-party cities | public |
| anyone's | places | theirs |
