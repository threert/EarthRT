# EarthRT

**The whole Earth, path-traced.** A globe built from open data, with cities, sites and rooms that anyone makes in a
GitHub repository and puts on the map. In any browser at its own address; path-traced in the
[ThreeRT](https://github.com/meshy-dev/ThreeRT) client, every light traced, MetalFX or DLSS Ray Reconstruction
denoising.

> Status: the skeleton is being built ([docs/ROADMAP.md](docs/ROADMAP.md)). Nothing here is stable yet.

## How it fits together

- **The trunk** is one globe for every place on Earth, down to the view from an aeroplane window: terrain, land
  cover and buildings from open data (AWS Terrain Tiles, ESA WorldCover, OpenStreetMap), made into tiles the first
  time anyone looks at a spot and kept after that.
- **Places** are repositories with an `earthrt.json` at the root: where they are, how far they reach, and what they
  hold (GLB models, a ThreeRT scene module, or a city's own tiles). Register one, or give the repository the
  `earthrt-place` topic, and the index pulls it in. When several people make the same city, the best liked is shown and the
  others are a click away; eras (Kyoto in the Meiji era, in the Shōwa era) are versions too.
- **Two renderers, one core.** `packages/core` is the logic both share: geodesy, a floating frame for 32-bit GPUs,
  which tiles a view needs, how tiles are read, flights, choosing versions. `web/` draws it with three.js; `app/` is
  a ThreeRT package that the client path-traces.
- **Making places** happens in the ThreeRT client: remix a place or start from
  [the template](https://github.com/threert/earth-place-template), and your own Claude Code or Codex builds it, with
  Meshy for the models; it shows inside the globe as it changes.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and [docs/SPEC.md](docs/SPEC.md) for the contracts.

## Layout

| path | what |
| --- | --- |
| `packages/core` | `@earthrt/core`, plain TypeScript, no DOM: runs in browsers, Workers, Bun and the client's QuickJS |
| `service` | the Cloudflare Worker: trunk tiles, the places registry, the GitHub mirror, the web app's files |
| `web` | the web engine (three.js) |
| `app` | the ThreeRT package (the client) |
| `tools` | baking, probes, registration, deployment |
| `engine` | ThreeRT, as a submodule |

```bash
git clone --recursive https://github.com/threert/EarthRT && cd EarthRT
bun install
bun test ./packages/core/test
```

## Data and credits

Terrain: AWS Terrain Tiles (Mapzen; SRTM, GMTED2010, ETOPO1 and national sources). Land cover: ESA WorldCover 10 m
2021 (CC BY 4.0). Buildings and map data: © OpenStreetMap contributors (ODbL), via Protomaps. Every tile names its
sources, and the apps show the attributions.

## Licence

MIT, © 2026 Meshy LLC. Places are their authors', under the licences they state.
