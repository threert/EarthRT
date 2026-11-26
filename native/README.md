# The EarthRT app

EarthRT's own native app (ARCHITECTURE § 1a): the whole Earth path-traced by [ThreeRT](https://github.com/meshy-dev/ThreeRT),
places from GitHub, and places made in it with your own coding agent. macOS first. It has the shape of
[threert/native-app-template](https://github.com/threert/native-app-template) (MIT, Meshy LLC), from which its core,
sidecar and Swift plumbing were taken.

```
native/
  core/     Rust static library: ThreeRT's LiveCore running the globe's script (app/dist/earth.js) on a CAMetalLayer;
            the host channel answered natively: assets.* (the engine's AssetFetcher, into the disk cache), net.fetch,
            input; everything else (the earth.* family) goes to the app. C ABI: ert_* (macos/App/Core.h)
  macos/    SwiftUI: the window (sidebar, the globe, the inspector, the toolbar), menus, Settings, the console;
            xcodegen spec in project.yml
  sidecar/  Bun: place projects (Create here, Remix, builds on save, Publish, Meshy), GitHub sign-in, the agent bridge
            (ACP: the user's Claude Code or Codex), the `earthrt` command line
  tools/    macos.ts (build and run), release.ts (signed, notarized dmg), icon.ts (the icon, from the traced globe)
```

## Build and run

Needs macOS 14+ on Apple silicon (M3 or later traces with the GPU's ray-tracing hardware), Xcode 16+,
[xcodegen](https://github.com/yonaskolb/XcodeGen), [Rust](https://rustup.rs), [Bun](https://bun.sh) 1.3+.

```bash
git clone --recursive https://github.com/threert/EarthRT && cd EarthRT
bun native/tools/macos.ts --run                                     # builds app/ + core + app, opens it
bun native/tools/macos.ts --open "earthrt://open?at=35.0,135.76,3000"   # opens it on a link
```

`--no-core` skips the Rust build when only Swift changed, `--no-bundle` skips the globe's script.

In the globe: drag to move the Earth, right-drag (or Control-drag) to orbit, scroll or pinch to zoom, W A S D to fly,
click a spot for its card (Go Closer, Download Area, **Create Here**). ⌘0 the whole Earth, ⌘L fly, ⌘. stop a flight,
⌘[ ⌘] the sun, ⌥⌘I the inspector, ⌘1–3 Place / Create / Agent, ⇧⌘C copy a link to the view, ⌥⌘C the console.

## How the parts talk

| from → to | what |
| --- | --- |
| globe → app | `earth.view`, `earth.places`, `earth.selected`, `earth.pick`, `earth.flight`, `earth.status`, `earth.prefetched` (SPEC § 6) |
| app → globe | `earth.goto`, `earth.gotoPlace`, `earth.select`, `earth.choose`, `earth.fly`, `earth.stop`, `earth.time`, `earth.dev`, `earth.settings`, `earth.prefetch(Cancel)` |
| core → app | `rt.ready`, `rt.fatal`, `rt.error`, `rt.stats` (fps, GPU, the reconstruction that ran), `rt.snapshot`, `log` |
| app → sidecar | `place.create {lat, lon, title, kind, radius}`, `place.remix {repo}`, `place.open {folder}`, `place.close`, `place.build`, `place.check`, `place.publish {repo, dryRun}`, `meshy.generate`, `github.whoami`, `github.signin`, `settings {meshyKey, githubToken, githubClientId}`, `runtime.*` (what the globe said), `agent.*`, `answer` |
| sidecar → app | `state`, `place.opened`, `place.built {seq, ok, problems, manifest}`, `place.files`, `task {id, kind, state, line?, result?, error?}`, `github.device`, `agent.*`, `app.*` (test hooks) |

**Dev mode.** The sidecar builds the open place with its own `bun tools/build.ts` on every save; the app links the
folder into the globe's asset root as `dev/<name>-<n>/` (a new link each build, so nothing reads a stale file) and
sends `earth.dev {path, manifest}`; when the globe lists the place as shown, the app tells the sidecar
(`runtime.place`), which is what `earthrt check` waits for.

**The asset root** is `~/Library/Application Support/EarthRT/root`: `cache/` links to `~/Library/Caches/EarthRT` (every
tile and place file the globe fetched: the offline store; Settings → Storage), `dev/` holds the places in dev mode.

**Network.** The core's requests (tiles, places, the registry's JSON) go through the system's HTTPS proxy when one is
set, and `net.fetch` tries directly when the proxy cannot connect. The sidecar's (git, gh, Meshy) get the proxy in
`HTTPS_PROXY`.

## The agent

The inspector's Agent tab is the template's ACP bridge: the user's own Claude Code (`acceptEdits`) or Codex
(`workspace-write`), on their quota, in the place's folder, with the place's AGENTS.md. Without asking it may write
the place's files (not `tools/`, `earthrt/`, `package.json`, `.git`, `.github`), read the place, EarthRT and the
engine, and run `earthrt …` and read-only commands; anything else is a permission card. Its command line:

```bash
earthrt check            # build the place, validate earthrt.json, have the globe load it (exit 1 on a problem)
earthrt shot out.png     # what the globe shows at the place (--camera '{"position":[x,y,z],"target":[x,y,z]}')
earthrt logs | state | send '<earth.* message>' | app '<test request>'
```

## Testing

```bash
cd native/core && cargo test --release     # the host channel: routing, launch, net.fetch, the cache's size
cd native/sidecar && bun test              # the agent bridge (a fake ACP agent), the policy, places, GitHub, the server
```

With the app running, `native/.build/bin/earthrt app '<json>'` drives it as a person would: `app.select {place}`,
`app.choose {place}`, `app.fly {from, to}`, `app.open {url}`, `app.pick {lat, lon}`, `app.create {lat, lon, title}`,
`app.prompt {text}`, `app.panel {panel, show, sheet}`, `app.click {x, y}` (through the window's own event dispatch),
`app.window {size, appearance}`, `app.state`; `earthrt shot --window <file>` saves the window (the screen's own picture
when the display is awake and the terminal may record it, else composed offscreen).

## Releasing

`bun native/tools/release.ts` builds, carries the sidecar, @earthrt/core, the globe's script, the engine's presets and
a Bun inside the app, signs everything with the Developer ID (hardened runtime; Bun with the JIT entitlements),
notarizes and staples the app, then the dmg: `native/.build/release/EarthRT-<version>-macos-arm64.dmg`. It uploads
nothing. GitHub sign-in in a release needs EarthRT's OAuth App client id (Settings → Accounts, or
`EARTHRT_GITHUB_CLIENT_ID`); without it the app uses `gh`'s login.
