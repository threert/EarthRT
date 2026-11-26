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

Launch parameters (SPEC § 7): `at`, `place`, `fly`, `api`, `dev`; and for tests `debug`, `time` (ISO), `hour` (local solar),
`sse` (px), `flightSeconds`, `tiles=dev`, `lookahead=0`, `exposure`, `dpr`.

## Measured

`tools/probe-web.ts` (fresh Chrome profiles: first picture, bytes, tile latency, a 2-minute flight) and
`tools/shots-web.ts` (the poses in `tools/poses.json`).
