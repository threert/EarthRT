# EarthRT service

One Cloudflare Worker (`earthrt`) for everything the globe needs from a server (ARCHITECTURE § 3, SPEC §§ 3, 4, 8):

| where | what |
| --- | --- |
| `https://earth.threert.dev/tiles/v1/…` | the trunk: terrain, land cover and buildings tiles, made on their first request from open data, kept in R2 (`earthrt-tiles`), cached at the edge |
| `https://earth.threert.dev/api/v1/…` | the places registry (D1 `earthrt`): register, list, topics, likes, `/me`; hourly discovery of the GitHub topic `earthrt-place` |
| `https://earth-files.threert.dev/p/<owner>/<repo>/<sha>/<path>` | the mirror: a place's files at a registered commit (user content never on the app's origin) |
| `https://earth.threert.dev/` | the web app (`web/dist`, static assets; a placeholder page until it exists) |

## Run it locally

```sh
bun install                         # at the repository root
cd service
bun run assets                      # web/dist (or the placeholder) → public/
bunx wrangler d1 migrations apply earthrt --local --env local
bunx wrangler dev --env local --port 8790
```

Then `http://localhost:8790/tiles/v1/meta.json`, `…/tiles/v1/g1/terrain/10/898/404.c.ert`, `…/api/v1/places`. Local
tiles are made by the same code from the same sources (your machine's network; this Mac needs
`HTTPS_PROXY=http://127.0.0.1:7897`), kept in the local R2 under `.wrangler/`. In `--env local` the mirror answers
on any host (`/p/…` on port 8790). Point the web page or the client at it with `api=http://localhost:8790`.

Coarse tiles (z ≤ 7) read a baked global land-cover raster from R2; locally it is empty unless you copy it in
(`bun tools/landcover.ts`, then `wrangler r2 object put … --local`), and those tiles fall back to a climate guess.

## Tests

```sh
bun run test        # generator (PNG, COG, terrain edges, caps, albedo, MVT → buildings) and the API in wrangler dev
                    # against a fake GitHub (register, auth, bbox, topics, likes, discovery, mirror, LFS)
```

## Tools (repository root)

| command | what |
| --- | --- |
| `bun tools/tile.ts 10/898/404 [--x] [--buildings] [--png out/x.png]` | make one tile locally with the Worker's generator; sizes, timings, a top-down preview |
| `bun tools/preview.ts globe [--api https://earth.threert.dev]` | the globe from orbit at six views (contact sheet) to judge colours by eye |
| `bun tools/preview.ts tiles [--api …]` | top-down tiles at fixed places (Japan, Himalaya, Sahara, Kyoto z10–z14, …) |
| `bun tools/landcover.ts [--upload]` | bake the global land-cover raster from WorldCover's COG overviews, put it in R2 |
| `bun tools/regions.ts [--only tokyo] [--upload]` | cut the building regions out of the latest Protomaps build (z15), put them in R2 |
| `bun tools/register.ts <owner/repo> [--api …]` | register a place with your `gh auth token`; `<owner/repo/id> --refresh / --like / --unlike` |

## Deploy

```sh
cd service
bun run assets
bunx wrangler d1 migrations apply earthrt --remote
bunx wrangler deploy
```

Resources (account `5e97b4b91f8abaf2de54de9f866bfcae`): Worker `earthrt` on the custom domains `earth.threert.dev`
and `earth-files.threert.dev`, R2 bucket `earthrt-tiles` (`tiles/v1/<gen>/…` the made tiles, `landcover/v1/…` the
baked raster, `buildings/v1/<region>.pmtiles` the extracts, `mirror/…` place files), D1 `earthrt`. Secrets
(`wrangler secret put`): `GITHUB_TOKEN` (optional: discovery's search and stars; writes always use the caller's own
token).

## How a tile is made

- **Terrain** (`src/gen/terrain.ts`): the Terrarium PNG of the same z/x/y (4 pixels a cell) and its eight neighbours;
  a vertex is the mean of the 4 × 4 pixels about it (heights, the share of water), and the bordered grid (one vertex
  beyond each edge) gives `gridNormals` what it needs, so both sides of an edge read the same pixels and agree.
  Water: a pixel is water where WorldCover says water, or where there is no land cover and it is below 0 m; the sea's
  surface is 0 m, inland water keeps its height, land below sea level stays land (polders).
- **Land cover** (`src/gen/landcover.ts`): z ≥ 8 reads ESA WorldCover's 3° COGs by range requests (`src/gen/cog.ts`,
  the overview whose pixel is no larger than the Terrarium pixel; deep sea skipped); z ≤ 7 reads the baked raster. A
  vertex takes the most common class of its 16 pixels.
- **Albedo** (`src/gen/albedo.ts`): procedural from the class, latitude (aridity belts, forest types), height (snow
  line by latitude), slope (rock) and a noise; the sea by depth, sea ice toward the poles.
- **Caps**: rings from 85.05° to the pole; the south one rises from the edge's heights to the ice at the pole
  (2835 m), the north one is sea ice at 0 m.
- **Buildings** (`src/gen/buildings.ts`): the four z15 vector tiles under a z14 tile from the region's PMTiles in R2,
  each piece clipped to its z15 tile (pieces of a building cut by an edge abut); height from `height`, else levels ×
  3.2 m, else a default by kind and footprint; base = the lowest terrain under the footprint (the z14 terrain tile).
- **Expanded** files are made from the compact ones by core's `expandTerrain` / `expandBuildings`.

Bump `GEN` in `src/tiles.ts` when what a tile holds changes: the new generation starts empty and fills as people look.
