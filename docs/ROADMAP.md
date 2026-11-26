# EarthRT roadmap

The skeleton first: every layer working end to end, thin. Then a campaign that does not stop: more of the Earth,
more cities, a better picture. Each pull request says which item it moves and updates its status here.

How work is judged:
- **Looks** are judged by eye at fixed poses (the `poses` list in `tools/poses.json`), live, before and after side by
  side (`out/pr-<name>/<pose>-before-after.jpg`), in the app and on the web. Offline zooms do not count.
- **Loading** is measured, not guessed: `tools/probe-web.ts` (first picture, tiles in flight, p50/p95 tile latency,
  bytes, GPU memory) and `tools/probe-app.ts` (frame p50/p95/p99, commit time, tiles a frame) on a fixed route.
- The contracts are in [SPEC.md](SPEC.md); a change to one changes the spec in the same pull request.

## § 0 The skeleton

| step | what | done when | status |
| --- | --- | --- | --- |
| S1 | `@earthrt/core`: geodesy, floating frame, tile scheme, ERT, terrain and building meshing, selection, scheduler, flights, sun, places | tests pass in Bun; the same code runs in QuickJS (the app's script) | **done** (tests); QuickJS check with S4 |
| S2 | the service (`service/`): trunk tiles made on request (terrain + land cover + buildings), meta, top pack; the registry (D1), the mirror, likes, hourly discovery; deployed at `earth.threert.dev` | `curl` a tile anywhere on Earth in < 2 s cold, < 100 ms warm; register a repository with `gh auth token`; its files served from the mirror | open |
| S3 | the web engine (`web/`): orbit to aeroplane view, atmosphere, buildings, place markers, the place panel with versions and likes, GLB places, flights, the loading strategy | first picture < 2 s on a fresh profile; no holes while flying; a GLB place shows at its anchor | open |
| S4 | the path-traced globe: engine `SkyAtmosphere.altitude`, `assets.fetch` (a library piece + `threert-render play`), texture slots freed; the globe's scene script (`app/`) streaming the trunk, places (glb, scene), flights, the `earth.*` messages (SPEC § 6) | in `threert-render play`: orbit to a street, traced, 60 fps at 1280 × 720 with MetalFX on an M3 Max; a flight Kyoto → San Francisco without holes | open |
| S4n | the EarthRT app for macOS (`native/`: Rust core + SwiftUI + Bun sidecar, the shape of threert/native-app-template): the globe view, search, the place panel (versions, eras, likes), flights, time, offline downloads, Graphics (MetalFX / ThreeRT denoiser), GitHub sign-in, Create / Remix / Publish with the agent panel and Meshy, `earthrt://` links; signed and notarised | the app opens from a `earthrt://` link of the page, flies Kyoto → San Francisco, and a place made in it by Claude Code shows in the globe as it changes | open (decided 2026-11-26: a native app of its own, not the ThreeRT client) |
| S5 | making places: `threert/earth-place-template` (dev mode, `tools/meshy.ts`, `tools/register.ts`, AGENTS.md); two sample places, two versions of one topic | a place made from the template by Claude Code in the app's agent panel, registered, shown to a second machine | open |
| S6 | the first city: `threert/earth-kyoto` v0 (procedural from OSM: roof forms, trees, roads) | Kyoto from 1 km up, by eye, clearly better than the trunk | open |
| S7 | the domain and the launch: `earthrt.app` (to buy), the app's download and updates, README pictures, threert.dev link | the address opens the globe; the app downloads from it | open |

## § 1 The campaign

Ordered by what the user sees first. Items move up when a picture shows they matter more.

1. **The globe from orbit.** Atmosphere seen from space (limb, aerial perspective over land), oceans with the sun's
   glint, the night side with city lights (NASA Black Marble, public domain), clouds (a layer, later weather).
2. **The trunk's land.** WorldCover classes everywhere (S2 starts with them); material detail per class (fields,
   forests, rock, snow by slope and height); coasts and rivers from OSM water; terrain finer than z14 where open DEMs
   allow (Japan GSI 5 m, USGS 3DEP 1 m, EU national DEMs).
3. **Buildings everywhere.** Protomaps extracts region by region (seven metro regions so far; no more until Kyoto is
   good), then the planet; heights from Overture where OSM has none; roof shapes from OSM tags.
4. **Kyoto first, and only Kyoto for now** (the user, 2026-11-26: no spreading to other cities until Kyoto is
   good). `threert/earth-kyoto`, judged at `kyoto-3km`, `kyoto-1km` and closer poses; done when those beat the trunk
   by eye and a walk-through holds the frame budget. Tokyo, New York, Shanghai, San Francisco and Europe come after,
   one at a time, on what Kyoto proved.
5. **Close views.** Street level inside a city place: walking along streets (a walk graph from OSM ways), interiors
   from places, eras (`@meiji`, `@showa`) switched in the place panel.
6. **Loading.** Web: first picture, bytes per view, memory; HTTP caching, the top pack, workers. App: commit time a
   frame on flights, BLAS memory, eviction, offline packs ("download for a flight").
7. **Making and sharing.** Web sign-in (GitHub App), the scene content type on the web in a sandboxed worker, Meshy
   generation from the app's place panel, webhooks for instant refresh, reporting and hiding places.
8. **Other platforms.** The app on iOS (the same SwiftUI) and Windows (DLSS-RR), then Linux.

## Status log

- 2026-11-26: repository created; ARCHITECTURE, SPEC, this roadmap; S1 core with 20 tests.
- 2026-11-26: S2's terrain live at earth.threert.dev (#2); a scene's fallback GLB (#1). The user decided the
  path-traced side is EarthRT's own native app, not a package in the ThreeRT client: ARCHITECTURE § 1a, SPEC §§ 6–7
  (`earth.*` messages, dev mode in the app), S4 split into S4 (the traced globe) and S4n (the app).
- 2026-11-26: focus on Kyoto (the user): no other cities until Kyoto is good; S6 started (`threert/earth-kyoto`).
