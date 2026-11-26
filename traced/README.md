# app/: the globe's scene script

The path-traced globe as a ThreeRT game script: the trunk streamed around the camera in a floating frame (ARCHITECTURE
§ 2), places, flights, the sun and the sky. EarthRT's native app (`native/`, ARCHITECTURE § 1a) runs it in the
engine's QuickJS; `threert-render play` runs it for development. It draws the globe and nothing else: the interface is
the app's, and the two talk over ThreeRT's host channel (SPEC § 6).

```bash
bun app/build.ts                 # app/dist/earth.js (+ earth.json: version, sha256, the engine commit it was built with)
bun app/test/core-quickjs.ts     # @earthrt/core gives the same answers in the engine's QuickJS as in Bun
bun tools/prefetch.ts --out out/real --global 4 --around 34.985,135.758,14,3 --buildings   # tiles for play, offline
engine/renderer/target/release/threert-render play app/dist/earth.js --assets out/real \
  --launch '{"at":"34.955,135.76,3000,0,-25","time":"15"}'
bun tools/shot.ts kyoto-3km alps-6km --online --earth --assets out/real    # stills at poses (tools/poses.json)
bun tools/probe-client.ts flight --online --assets out/real                  # frame times while streaming
```

## The contract with the app

**The bundle.** `app/dist/earth.js`: one classic script (an IIFE: the game, `@earthrt/core`, `@threert/scene`,
`@threert/gameplay` and the engine's node host), started as a game session (`GameSession::start(bundle, room, assets)`)
on an engine of the commit in `earth.json` or later. The room id may carry launch parameters (`at=…;time=…`), for
`play`; the app leaves it empty and sends `launch`.

**The asset root.** The script reads files with `readAsset(path)` under it:

| path | what |
| --- | --- |
| `cache/tiles/v1/meta.json`, `cache/tiles/v1/<gen>/{terrain,buildings}/<z>/<x>/<y>.x.ert` | trunk tiles (SPEC § 3–4): fetched there with `assets.fetch`, or prefetched (`tools/prefetch.ts`). Without `assets` in the caps the script reads what is there and asks for nothing |
| `cache/places/<sha>/<path>` | a place's files at a commit (from the registry's mirror) |
| `cache/dev/<v>/<path>` | a place under development served over http (`dev=<url>`), one folder a reload |
| `dev/<name>/…` | a place under development as a folder (the app's link to the project; `earth.dev`) |

**`launch`** (once, after setup): `params` as strings (SPEC § 7: `at`, `place`, `fly`, `api`, `time`, `utc`, plus
`width`, `height`: the view in pixels, for the refinement's screen-space error); `caps`: `"assets"` (the app answers
`assets.fetch`), `"earth"` (the app draws the interface: the script posts `earth.*` and draws no engine HUD). The app
also answers `net.fetch` (the registry's JSON, `meta.json`: https).

**Input.** `pointer: "free"`: the app sends the `input` message every frame (RUNTIME "Input"). Drag (Mouse0) moves
the globe under the pointer, Mouse2 or Shift + drag orbits about the view's centre, the wheel (pinch too) zooms toward
it; W A S D / arrows, Q E (turn), R F (tilt), Z X (down / up), Shift faster. A click that ends no drag is a pick.
During a flight: drag looks around, the wheel sets the speed, Space pauses. `[` `]` move the sun an hour.

**`earth.*`** (SPEC § 6). The script posts `earth.view` (≤ 10 a second, when the camera or the time moved),
`earth.places` (when the places in range or their state changed), `earth.selected` (after `earth.select` /
`earth.choose`), `earth.pick` (a click on the globe), `earth.flight` (on start and end, and once a second while
flying; the time along the track is `seconds`, since `t` is the message's type), `earth.status` (once a second:
`tiles: { shown, inFlight, queued, resident }`, `bytes`, `frameMs` = the script's own time a frame, smoothed, `gen`),
and `earth.prefetched`. It obeys `earth.goto`, `earth.gotoPlace`, `earth.select`, `earth.choose`, `earth.fly`
(`from` left out: from the camera), `earth.stop`, `earth.time` (`utc` or `solarHour`, `rate`: 0 holds the sun),
`earth.dev` (`path`, `manifest?`: sent again after each save, the place loads again), `earth.settings` (`sse`,
`buildings`), and for offline use:

| `t` | direction | fields | |
| --- | --- | --- | --- |
| `earth.prefetch` | app → script | `id`, `area?: { lat, lon, radius (m), maxZoom? }`, `flight?: { from, to } \| true` | fetch every tile the area (all levels to `maxZoom`, 14 by default) or every view along the flight (`true`: the current one) would show, 4 at a time beside the view's own |
| `earth.prefetched` | script → app | `id`, `done`, `total`, `bytes`, `failed`, `state` (`running`, `done`, `failed`, `canceled`) | twice a second while it runs, and at its end |
| `earth.prefetchCancel` | app → script | `id` | stop it |

**Rendering settings** (quality, the denoiser) are the app's (`LiveCore::set_rendering`); the script sets none.

**Without the app** (`threert-render play`, no `earth` cap): a small HUD (where the camera is, what is loading, the
nearest place's versions as a menu, `G`: a "fly to" menu); keys and launch parameters as above.

## What the frame costs

The script runs inside the engine's frame (QuickJS, 50 ms budget). Per frame it selects tiles (core `selectTiles`,
skipped while the view and the tiles are still), adds what arrived within a budget (`Trunk.budget`: 60 k triangles,
10 objects, 4 ms), moves tiles shown and parked, and unloads past `Trunk.maxTris` / `maxTiles`. A tile not shown is
parked (scaled down at the Earth's centre), never hidden: an object hidden when the scene is (re)built would rebuild
it when shown (RUNTIME "Streaming"). `tools/probe-client.ts` measures it on fixed routes.
