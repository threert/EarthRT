# EarthRT on the web

The globe in any browser: three.js (WebGL2), drawn from the same core as the app (`packages/core`). Orbit to the
aeroplane view, a physical atmosphere, buildings, places (GLB), flights.

```bash
cd web
bun run build          # → web/dist (static): index.html + static/*-<hash>.js
bun run dev            # http://127.0.0.1:8795, rebuilds on change; add -- --service https://earth.threert.dev
bun test ./test        # camera math, budgets, launch parameters, places
```

`web/dist` is served at the root of the service's host: `index.html` (no-cache) and `static/` (hashed, immutable).
Every path in the page is relative except the service's own (`/tiles/v1/…`, `/api/v1/…`), so the page works under any
base and beside other files at the root. Without a service (a static server, `?tiles=dev`) it makes compact tiles
itself from the AWS Terrain Tiles, so the decode path is the real one.

## In the app (SPEC § 6.1)

The native app bundles the same build and loads it in a `WKWebView`:

```bash
cd web && bun run build      # → web/dist: copy the whole folder into the app's resources
```

The app loads `ert://app/index.html?host=app&<launch parameters>` (all of the page's own paths are relative). With
`host=app`:

- no interface of its own (search, panel, buttons, time, attribution: the app's), markers stay;
- map → app by `window.webkit.messageHandlers.earth.postMessage(msg)`, app → map by `window.earthrt.receive(msg)`
  (a JSON string or an object; messages the app queues in `window.earthrt.queue` before the page runs are taken
  too); the map sends `{ t: "earth.ready" }` first;
- every service URL becomes `ert://<host>/<path>`: meta.json, tiles, the top pack, `/api/v1/…` and the registry's
  file bases (`https://earth-files.threert.dev/p/…` → `ert://earth-files.threert.dev/p/…`); the service defaults to
  `https://earth.threert.dev` (`api=` names another);
- tiles are fetched on the main thread and decoded in the workers (a worker's fetch may not reach a custom scheme);
  Cache Storage is not used (it takes http(s) only: the app's disk cache keeps the files);
- `preserveDrawingBuffer` is on (`WKWebView.takeSnapshot` in the app's tests).

`parent=<origin>` is the same for a page that frames the map in an `<iframe>` (postMessage both ways, that origin
only; the attribution line stays). `bun tools/embed-test.ts` drives `web/dev/embed.html`, which frames the map and
checks every message.

## How it is put together

| file | what |
| --- | --- |
| `index.html` | the markup, the CSS, and the boot script: it asks for `meta.json` and the top pack before the app's code arrives |
| `src/main.ts` | the app: renderer, tile workers, navigation, the frame loop |
| `src/tiles/` | `manager.ts` (core `selectTiles` + `Scheduler`, upload budget, GPU LRU), `worker.ts` (fetch through Cache Storage, decode with core, pack for the GPU), `pool.ts`, `budget.ts`, `dev-source.ts` |
| `src/render/` | `globe.ts` (meshes in core's floating frame, HDR target, log depth), `atmosphere*.ts` (Hillaire's tables + the composite: sky, aerial perspective, tone mapping), `materials.ts` (land detail by class, the sea's glint, buildings), `noise.ts` |
| `src/camera/` | `math.ts` (ECEF doubles: heading/pitch without roll, grab, zoom toward a point, orbit, fly-to, the floor) and `controls.ts` (mouse, touch, keyboard, inertia) |
| `src/places/places.ts` | registry queries, version choice, GLB content in the place's frame, buildings hidden inside places, dev places |
| `src/flight.ts` | core `Flight`, free look, look-ahead prefetch |
| `src/ui/` | search, place panel, markers, flight bar, time of day; `?debug` overlay |
| `src/host.ts`, `src/embed.ts` | embedded (SPEC § 6.1): the transports, `ert://` URLs, every `earth.*` message |

Launch parameters (SPEC § 7): `at`, `place`, `fly`, `api`, `dev`, `host=app`, `parent=<origin>`; and for tests `debug`, `time` (ISO), `hour` (local solar),
`sse` (px), `flightSeconds`, `tiles=dev`, `lookahead=0`, `exposure`, `dpr`.

## Measured

`tools/probe-web.ts` (fresh Chrome profiles: first picture, bytes, tile latency, a 2-minute flight) and
`tools/shots-web.ts` (the poses in `tools/poses.json`).
