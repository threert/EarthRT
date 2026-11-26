# EarthRT architecture

EarthRT is a whole-Earth viewer built on [ThreeRT](https://github.com/meshy-dev/ThreeRT). One globe (the **trunk**)
covers every place on Earth down to the view from an aeroplane window. Cities, sites and rooms in finer detail are
**places**: each one a GitHub repository, registered at a spot on the map, pulled in by the index, and chosen among
when several people made the same city. The globe is drawn by a fast raster **map engine**, the same one on the web
and in the native **EarthRT app**; when you go into a place, the app draws it **path-traced** by ThreeRT (every light
traced, MetalFX or DLSS Ray Reconstruction as the denoiser). The app is also where places are made.

This document is the design and the reasons for it. The contracts the pieces share (frames, tiles, the place
manifest, the API, the messages between the pieces) are in [SPEC.md](SPEC.md); what is built and what comes next
is in [ROADMAP.md](ROADMAP.md).

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
  open data: AWS terrain tiles, GSI,                      │ https                     │ https
  ESA WorldCover, OSM (Protomaps), …  ───────────────────▶│                           │
                         ┌────────────────────────────────┴──────┐   ┌────────────────┴──────────────────────────┐
                         │ map engine (web/, three.js)           │   │ EarthRT app (native/, SwiftUI, macOS first)│
                         │ the globe: orbit, flights, aerial     │   │ ├ the map engine in a WKWebView, its tiles │
                         │ views, places as GLB; WebGPU/WebGL2   │   │ │ from the app's disk cache                │
                         │ in any browser at the domain          │◀──┤ ├ the traced view (traced/ on ThreeRT):     │
                         └───────────────────┬───────────────────┘   │ │ a place and its surroundings, path-traced│
                                             │                       │ └ native UI, offline, making places, agent │
                                             │                       └────────────────┬──────────────────────────┘
                                             └──────────── @earthrt/core ─────────────┘
                      geodesy, the floating frame, the tile scheme and files, tile selection, request scheduling,
                      flights, place resolution — plain TypeScript, the same in the browser, the WebView and QuickJS
```

## Decisions

### 1. Two renderers, each where it is best (decided with the user, 2026-11-26)

Seen from 1 km to 20,000 km up, what makes the picture is the atmosphere, the land's colour and relief, and
buildings that are a few pixels each. Path tracing's gifts (bounce light, soft shadows, reflections, light from
every lamp) are under a pixel there or behind the haze, while the work it needs is the most there is: thousands of
tiles streamed through acceleration structures, a camera that moves fast, and geometry finer than a pixel, which is
the denoiser's hardest case. Every globe that looks good (Google Earth, Cesium, flight simulators) is rasterised.
Inside a room, on a street, at a temple's gate, it is the other way round: there path tracing is what makes the
picture, and a rasteriser's flat light is what people see as fake.

The first build checked it, both renderers on the same tiles on the same day (ROADMAP status log): three.js showed
the globe in 0.47 s and flew Kyoto → San Francisco at 60 fps with no frame missing a tile, in 50–75 MB of GPU memory;
the path-traced globe had holes from orbit, a grey, noisy Kyoto from 3 km, and spent its time on the script's frame
budget and on engine changes to do what a rasteriser does by itself. The machiya, on the web, had a lamp that lit
nothing.

So EarthRT has two renderers and a clear line between them:

- **The map engine** (`web/`, three.js) draws the globe everywhere it is a map: from orbit to the aeroplane view,
  flights, city layers seen from the air, places as markers and as GLB models. It is written for this app (not
  ThreeRT's generic three.js view): an atmosphere seen from orbit and from the ground, a depth range from 1 m to
  40,000 km, water, terrain and building shading, and loading made for the web (§ 7). **It is the only globe
  renderer**: the website runs it in the browser, the native app runs the same build in a `WKWebView`, so a change
  to the globe's look is made once and shows everywhere.
- **The traced view** (`traced/`, a ThreeRT scene script) draws one place, path-traced, in the native app: its
  content (GLB models, its scene module, its city tiles) and its surroundings (the trunk's terrain and buildings for
  a kilometre or two around it, from the same tiles), under the same sun and sky as the map. The user goes into it
  from the map (**Enter**, or by going close enough to a place that has one) and back out to the map where they
  stand. This is where ThreeRT is the right tool and where its work goes: interiors, sites, a city at street level.

The web shows places too (their GLB, or a scene's baked `fallback`), and offers "Open in EarthRT" for the traced
view. Why not ThreeRT's wasm build for the web's traced view: WebGPU has no ray-tracing hardware and is not in every
browser; it may come later for small places.

Why the map engine in a WebView and not a second, native map renderer (wgpu): two globe renderers would mean every
improvement to the globe's look made twice, and two looks that drift apart; the web's must be excellent anyway,
because it is the open door. WebKit on macOS 26 has WebGPU (on Metal) and WebGL2. If measurements ever show the
WebView is what limits the app (memory on iOS, Windows), the shared core and tile files make a native map possible
then.

### 1a. The native app is EarthRT's own (decided by the user, 2026-11-26)

Not a package inside the ThreeRT client: EarthRT is its own product, with its own icon, window and native interface.
It has the shape of [threert/native-app-template](https://github.com/threert/native-app-template) (ThreeRT's
recommended way to embed the engine), in `native/`:

| part | what |
| --- | --- |
| `native/macos` | SwiftUI: the map (a `WKWebView` running the map engine's build, bundled with the app, its tiles served from the app's disk cache through a custom URL scheme), the traced view (a `CAMetalLayer`, shown over the map when a place is entered, with a cross-fade both ways), search, the place panel (versions ranked, eras, likes), flights, time of day, offline downloads, Graphics (the traced view's quality and denoiser: MetalFX or ThreeRT's), GitHub sign-in, Create / Remix / Publish, the Meshy panel, the agent panel |
| `native/core` | Rust static library: ThreeRT's `LiveCore` and a game session running `traced/`'s bundled script; its host channel answered natively (`assets.*` with ThreeRT's `assets` module, `net.fetch`, input, the `traced.*` family); the tile cache shared with the map; a small C ABI (`ert_*`) |
| `native/sidecar` | Bun: the agent bridge (ACP, as in the template: the user's own Claude Code or Codex in a side panel, on their own quota), building a place's scene module on save, Meshy and GitHub calls for making places |

The interface is the app's own (SwiftUI) in both views. The map engine and the app talk by the `earth.*` messages
over the WebView's script bridge (the same messages a page can use in an `<iframe>`), the traced view and the app by
`traced.*` messages over ThreeRT's host channel (SPEC § 6). macOS first; iOS shares the SwiftUI and the WebView; a
Windows app (WebView2 for the map, DLSS-RR for the traced view) follows the same split. Distribution: a Developer ID
signed and notarised download from the project's site, updates by Sparkle.

### 2. Coordinates: ECEF in doubles, a floating local frame in floats

GPUs are 32-bit. The Earth is 12,742 km across, and 32 bits hold about 7 digits.

- Everything is placed in **ECEF** (WGS84, metres, `float64`) on the CPU.
- What is drawn is in a **local frame**: east-up-south at an origin `O` on the ellipsoid, as three.js expects
  (x east, y up, z south; right-handed, Y up, metres). The camera stays within a short way of `O`; when it moves
  further (`max(2 km, altitude / 4)` sideways), `O` moves under it (a **rebase**) and every tile's transform is
  written again.
- **A tile's vertices are relative to its own centre** `C` (ECEF axes, `float32`). Its transform in the frame is
  the frame's rotation `R` (the same for every tile) and the translation `R·(C − O)`, computed in doubles. At the
  globe's scale a vertex is within about 0.5 m of where it belongs; near the camera, millimetres.
- The map engine uses a logarithmic depth buffer for 1 m to 40,000 km. The traced view needs no rebase at all: its
  frame is the place's (east-up-south at the anchor), and everything it draws is within a few kilometres; its sky is
  ThreeRT's physical atmosphere at the camera's height (`SkyAtmosphere.altitude`), with the sun the map has.
- **Handing over** between the two: the camera as ECEF position and orientation plus the time (SPEC § 6
  `earth.enter` / `traced.exit`), so the traced view starts exactly where the map was, and the map resumes where
  the traced view left.

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
  ~10–30 KB, for the map engine, which expands it in a worker in milliseconds) and *expanded* (the vertex arrays as
  ThreeRT takes them, for the traced view's surroundings, whose script runs in an interpreter and must not loop over
  vertices). The
  Worker expands compact tiles itself; both are cached at the edge.
- Building meshes and terrain meshes are made by the same core function on all three (Worker, web worker, and the
  bake tools), so a tile looks the same everywhere.

### 4. Places: GitHub repositories, registered on the map

A place is a repository with `earthrt.json` at its root (SPEC § 5): where it is (an anchor: latitude, longitude,
height, heading), how far it reaches (a radius or polygon), what kind it is (**city**, **site**, **interior**), what
it replaces of the trunk inside it (e.g. the trunk's buildings), and its content:

- **`glb`**: models placed in the place's local frame (east-up-south at the anchor). Drawn by the map engine (web
  and app) and by the traced view. A model made by Meshy is this.
- **`scene`**: a ThreeRT scene module (`export default function build(ctx)`), the same API as any ThreeRT game,
  built in the place's frame. The traced view runs it; the map engine draws its baked `fallback` GLB (running
  someone else's code on our origin waits for a sandboxed worker, ROADMAP).
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
puts the anchor in its `earthrt.json`, opens it in dev mode (SPEC § 7: the place shows on the map at its anchor
and in the traced view, and reloads on every save) and starts the user's own Claude Code or Codex in the agent panel, on their own
quota, with the project's AGENTS.md. The agent uses the template's tools: `tools/meshy.ts` (text or image to 3D
through the user's Meshy API key, the GLB sized and placed), `tools/place.ts`, `tools/check.ts`. The app's own
Meshy panel does the same for a user who just wants a model at a spot. **Publish** pushes to GitHub (a new
repository under the user's account, the `earthrt-place` topic) and registers it.

### 6. First-party cities are places too

First-party cities are repositories under `threert/` (`earth-<city>`), on the same contract as anyone's, so the
contract is exercised by its hardest users and the first party gets no private path. Their generators are
procedural from open data (OSM, PLATEAU where it exists, terrain), with GLB landmarks where a generator falls short.
A city is drawn by both renderers: from the air by the map engine (its tiles as GLB), at street level by the traced
view. Kyoto first and alone until it is good (the user, 2026-11-26).

### 7. Loading, for the web first

- First picture: the page's HTML, a small script and **one request for the globe's top two levels and the caps** (z0–z1
  packed, ~110 KB with brotli; z2's 16 tiles follow, ~14 KB each), before three.js's own code has finished loading the rest.
- Tiles by need: the core's selector ranks tiles by screen-space error and distance from the view's centre; the
  scheduler keeps a fixed number of requests in flight (HTTP/2), drops requests the view no longer wants
  (`AbortController`), retries with backoff, and adds what arrived under a per-frame budget.
- Decoding and meshing in a pool of web workers (transferable buffers); an LRU of GPU meshes under a byte budget;
  tiles kept in the Cache Storage API, so a second visit is local. Tile URLs are immutable (the version is in the
  path) and served with year-long cache headers.
- The app keeps every file on disk: the map engine in its WebView asks for tiles through the app's URL scheme and the
  app answers from its cache or the network (and keeps what it fetched); the traced view reads the same cache
  (`assets.*`). So a city once seen, or a flight prepared ("download for offline": every tile along a route at the
  detail the route needs), plays without the network.

### 8. Flights

A flight is drawn by the map engine. It is a fixed track: a great circle between two places with a climb, a cruise height and a descent, timed. The
camera rides it; the user looks around freely (yaw and pitch relative to the track). Because the track is known,
the tiles it will need are known ahead: the scheduler fetches them by when they will be needed, at a lower
priority than what is on screen, and a flight can be prepared for offline in full.

## What this asks of ThreeRT

| change | where | status |
| --- | --- | --- |
| `SkyAtmosphere.altitude` (the viewer's real altitude, re-baked in place when it changes) | meshy-dev/ThreeRT | merged (#282); the traced view uses it for rooftops, towers and hills |
| `assets` module (binary files into a cache directory, then `readAsset`) for embedding apps, and in `threert-render play` | meshy-dev/ThreeRT | merged (#283); the app's core links it, `play` is the traced view's development loop |
| texture slots freed when nothing names them | meshy-dev/ThreeRT | in progress; entering one place after another must not grow the texture pages |
| what interiors and street level need (lamps, glass, foliage, many lights at night) | meshy-dev/ThreeRT | the campaign, place by place |

## Repositories

| repository | what | visibility |
| --- | --- | --- |
| `threert/EarthRT` | this: core, the map engine (`web/`), the traced view (`traced/`), the native app (`native/`), the service, tools, the spec | public, MIT |
| `threert/earth-place-template` | the template for a place (scene, models, Meshy tool, AGENTS.md, checks) | public, template |
| `threert/earth-<city>` | first-party cities | public |
| anyone's | places | theirs |
