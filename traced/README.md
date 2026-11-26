# traced/: the traced view

One place path-traced with its surroundings (ARCHITECTURE § 1): its content (`glb` models, its `scene` module; later
its city `tiles`) and the trunk's terrain and buildings around it, under the map's sun and sky. A ThreeRT scene
script: EarthRT's native app runs it in its `LiveCore` when the user enters a place from the map, and
`threert-render play` runs it alone for development. The globe itself is the map engine's (`web/`), not this.

```bash
bun traced/build.ts             # traced/dist/traced.js (+ traced.json: version, sha256, the engine commit it was built with)
bun traced/test/core-quickjs.ts # @earthrt/core gives the same answers in the engine's QuickJS as in Bun
bun tools/shot.ts machiya tower tower-lowpoly tower-air [--reconstruction builtin]   # stills under out/s4/
engine/renderer/target/release/threert-render play traced/dist/traced.js --assets out/real \
  --launch '{"place":"threert/earth-sample-gion-machiya/gion-machiya","time":"15"}' --reconstruction metalfx-denoised,builtin
```

## The contract with the app

**The bundle**: `traced/dist/traced.js`, one classic script (the scene script, `@earthrt/core`, `@threert/scene`,
`@threert/gameplay`, the engine's node host), for an engine of the commit in `traced.json` or later
(`SkyAtmosphere.altitude`, meshy-dev/ThreeRT #282). Started as a game session on the app's asset root; the room id is
not used.

**The asset root.** The script reads with `readAsset` under it and asks for files with `assets.fetch`:

| path | what |
| --- | --- |
| `cache/<host>/<path>` | the file of `https://<host>/<path>` (query left out): trunk tiles `cache/earth.threert.dev/tiles/v1/<gen>/{terrain,buildings}/<z>/<x>/<y>.x.ert` and `…/tiles/v1/meta.json`, a place's files `cache/earth-files.threert.dev/p/<owner>/<repo>/<sha>/<file>`. The map's `ert://` handler keeps the same files, so either fills the cache for the other |
| `dev/<name>…/` | a place under development, the app's link to the project's folder (`traced.open {dev: {path}}`); read as it is, never fetched |

**`launch`** (once, after setup): `params` (`width`, `height`: the view, pixels; in play also the stand-ins below),
`caps`: `"assets"` (the app answers `assets.fetch`), `"traced"` (the app draws the interface: no engine HUD). Then
`view {width, height}` on every resize. The script asks for nothing before `traced.open` but the tiles' `meta.json`
(retried 1, 2, 4 … 60 s apart while it fails; the cached copy meanwhile).

**`traced.*`** (SPEC § 6.2). The app sends `traced.open` (`place`: the registry's record `{id, manifest, files}`, or
`dev: {path, manifest?}`; `camera: {lat, lon, alt, heading, pitch, fov}`; `utc`; `surroundings: {radius}`), sent again
for a dev reload; `traced.time {utc, rate?}`; `traced.close`. The script posts `traced.loading {done, total, bytes}`
(4 a second while it loads), `traced.ready {id}` (the place's content and every surrounding tile in: from then the
denoiser's history is the only wait), `traced.view` (≤ 10 a second), `traced.exit {camera, why}` (`why`: `esc`, or
`rose` above the place's `enterFrom`), `traced.status {frameMs, scale, reconstruction, errors?}` (once a second).

**Input.** `pointer: "free"`: drag looks around, right drag or Shift + drag orbits about the anchor, W A S D / arrows
walk (faster the higher), Space / E up, C / Q down, Shift faster, the wheel moves forward and back, `[` `]` move the
sun an hour, Esc exits. The camera keeps eye height (1.7 m) over the terrain and stays within the surroundings' radius.

**Rendering settings** (quality, the denoiser) are the app's (`LiveCore::set_rendering`); the script sets none. On
the Kyoto places ThreeRT's own denoiser is cleaner than MetalFX's joint denoiser today (out/s4/machiya*.png).

**In play** (no `traced` cap): launch parameters stand in for `traced.open`: `place=<owner>/<repo>/<id>` (asked of the
registry) or `dev=<folder under the asset root>`, `at=lat,lon,alt[,heading,pitch]` (else the place's `start`),
`utc=<ISO or ms>` or `time=<local solar hour>` (holds the sun), `api=<url>`, `radius=<m>`; a small HUD.

## What it draws

- **The frame**: east-up-south at the anchor on the ellipsoid, turned by the place's heading (SPEC § 1): no rebase,
  everything within a few kilometres. The content sits at the anchor's height (the ground there plus `anchor.height`).
- **The surroundings**: the trunk's expanded tiles, a fixed cover about the anchor (z14 terrain and buildings within
  `radius`, 1.5 km by default; each ring beyond a level coarser, out to 120 km), made a frame budget at a time
  (60 k triangles, 12 objects, 5 ms); a buildings tile over 8 k triangles goes in parts (ranged reads of an index slice
  and the vertices it names). Buildings inside the place's bounds are cut out when it `replaces` them.
- **The content**: `glb` models fetched, parsed ahead (`preloadModel`) and added two frames on; a `scene` module's
  CommonJS bundle compiled with `new Function` and built with `@threert/scene` supplied (`ctx.time`: local solar
  hours); `fallback` GLBs are never drawn (they are for hosts that do not run scenes).
- **Sun and sky**: the real sun for the map's time, ThreeRT's physical atmosphere at the camera's height.
