# EarthRT roadmap

The skeleton first: every layer working end to end, thin. Then a campaign that does not stop: more of the Earth,
more cities, a better picture. Each pull request says which item it moves and updates its status here.

How work is judged:
- **Looks** are judged by eye at fixed poses (the `poses` list in `tools/poses.json`), live, before and after side by
  side (`out/pr-<name>/<pose>-before-after.jpg`), in the client and on the web. Offline zooms do not count.
- **Loading** is measured, not guessed: `tools/probe-web.ts` (first picture, tiles in flight, p50/p95 tile latency,
  bytes, GPU memory) and `tools/probe-client.ts` (frame p50/p95/p99, commit time, tiles a frame) on a fixed route.
- The contracts are in [SPEC.md](SPEC.md); a change to one changes the spec in the same pull request.

## § 0 The skeleton

| step | what | done when | status |
| --- | --- | --- | --- |
| S1 | `@earthrt/core`: geodesy, floating frame, tile scheme, ERT, terrain and building meshing, selection, scheduler, flights, sun, places | tests pass in Bun; the same code runs in QuickJS (the client's script) | **done** (tests); QuickJS check with S4 |
| S2 | the service (`service/`): trunk tiles made on request (terrain + land cover + buildings), meta, top pack; the registry (D1), the mirror, likes, hourly discovery; deployed at `earth.threert.dev` | `curl` a tile anywhere on Earth in < 2 s cold, < 100 ms warm; register a repository with `gh auth token`; its files served from the mirror | open |
| S3 | the web engine (`web/`): orbit to aeroplane view, atmosphere, buildings, place markers, the place panel with versions and likes, GLB places, flights, the loading strategy | first picture < 2 s on a fresh profile; no holes while flying; a GLB place shows at its anchor | open |
| S4 | the client: engine `SkyAtmosphere.altitude`; client `assets.fetch`; the EarthRT package (`app/`) path-traced in ThreeRT for macOS (MetalFX from the Graphics menu); places (glb, scene); flights; tiles cached on disk | the globe from orbit to a street, traced, 60 fps at 1280 × 720 with MetalFX on an M3 Max; a flight Kyoto → San Francisco without holes | open |
| S5 | making places: `threert/earth-place-template` (dev mode, `tools/meshy.ts`, `tools/register.ts`, AGENTS.md); two sample places, two versions of one topic | a place made from the template by Claude Code in the client's Remix, registered, shown to a second machine | open |
| S6 | the first city: `threert/earth-kyoto` v0 (procedural from OSM: roof forms, trees, roads) | Kyoto from 1 km up, by eye, clearly better than the trunk | open |
| S7 | the domain and the launch: `earthrt.app` (to buy), README pictures, threert.dev link | the address opens the globe | open |

## § 1 The campaign

Ordered by what the user sees first. Items move up when a picture shows they matter more.

1. **The globe from orbit.** Atmosphere seen from space (limb, aerial perspective over land), oceans with the sun's
   glint, the night side with city lights (NASA Black Marble, public domain), clouds (a layer, later weather).
2. **The trunk's land.** WorldCover classes everywhere (S2 starts with them); material detail per class (fields,
   forests, rock, snow by slope and height); coasts and rivers from OSM water; terrain finer than z14 where open DEMs
   allow (Japan GSI 5 m, USGS 3DEP 1 m, EU national DEMs).
3. **Buildings everywhere.** Protomaps extracts region by region (start: the first-party cities' metros, then Japan,
   the US, Europe, China's east), then the planet; heights from Overture where OSM has none; roof shapes from OSM tags.
4. **First-party cities**, each a repository and a pose list: Kyoto (S6), Tokyo, New York, Shanghai, San Francisco,
   Paris, London, Rome, Barcelona, Amsterdam. Done for a city when its poses beat the trunk by eye and its walk-through
   holds the frame budget.
5. **Close views.** Street level inside a city place: walking along streets (a walk graph from OSM ways), interiors
   from places, eras (`@meiji`, `@showa`) switched in the place panel.
6. **Loading.** Web: first picture, bytes per view, memory; HTTP caching, the top pack, workers. Client: commit time a
   frame on flights, BLAS memory, eviction, offline packs ("download for a flight").
7. **Making and sharing.** Web sign-in (GitHub App), the scene content type on the web in a sandboxed worker, Meshy
   generation from the client's place panel, webhooks for instant refresh, reporting and hiding places.
8. **Other clients.** Windows (DLSS-RR) and iOS checks of the package; the Steam Deck and Android.

## Status log

- 2026-11-26: repository created; ARCHITECTURE, SPEC, this roadmap; S1 core with 20 tests.
