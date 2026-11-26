// Builds EarthRT for macOS from a checkout: the globe's script (app/ → app/dist/earth.js), the Rust core (the engine
// inside), the Xcode project (xcodegen) and the app. Shaped like threert/native-app-template's tools/macos.ts.
//
//   bun native/tools/macos.ts [--run] [--open <earthrt://…>] [--no-core] [--no-bundle] [--debug]
//                             [--web <dist>] [--traced <traced.js>] [--out <dir>]
//
// --web / --traced: the map engine's build and the traced view's script from elsewhere (another branch's work copy),
// carried inside the app; --out: a copy of the built app there (e.g. out/), which keeps working when this checkout
// is rebuilt.
//
// Prints the .app. --run quits a copy that runs and opens the new one (--open: with a link, as a click on the web's
// "Open in EarthRT" would). Needs Rust (rustup: the engine pins its toolchain), Xcode 16+, xcodegen
// (`brew install xcodegen`) and Bun.
import { $ } from "bun";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const native = join(root, "native");
const args = process.argv.slice(2);
const flag = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };

if (!existsSync(join(root, "engine/renderer/Cargo.toml"))) {
  console.error("engine/ is empty: run `git submodule update --init` first");
  process.exit(1);
}
const step = (s: string) => console.log(`\x1b[1m${s}\x1b[0m`);

if (!existsSync(join(native, "sidecar/node_modules"))) await $`bun install --frozen-lockfile`.cwd(join(native, "sidecar"));
if (!args.includes("--no-bundle")) {
  // The map: the web's map engine (web/), built into web/dist (the app loads it as ert://app/).
  if (!existsSync(join(root, "node_modules"))) await $`bun install`.cwd(root).quiet();
  if (existsSync(join(root, "web/tools/build.ts"))) {
    if (!existsSync(join(root, "web/node_modules"))) await $`bun install`.cwd(join(root, "web")).quiet();
    step("web: the map engine (web/tools/build.ts)");
    await $`bun web/tools/build.ts`.cwd(root);
  } else console.log("(no web/ yet: the app says the map engine's build is missing)");
  // The traced view: traced/'s script, bundled with the engine's tools (esbuild from the engine's packages).
  if (existsSync(join(root, "traced/build.ts"))) {
    if (!existsSync(join(root, "engine/node_modules/esbuild"))) {
      step("engine: bun install (the bundler for the traced view's script)");
      await $`bun install`.cwd(join(root, "engine")).quiet();
    }
    step("traced: the traced view's script (traced/build.ts)");
    await $`bun traced/build.ts`.cwd(root);
  } else console.log("(no traced/ yet: the app's Enter says the traced view's script is missing)");
}
if (!args.includes("--no-core")) {
  step("core: cargo build --release (the first build takes a few minutes)");
  await $`cargo build --release`.cwd(join(native, "core")).env(env);
}
step("macos: xcodegen + xcodebuild");
await $`xcodegen generate --quiet`.cwd(join(native, "macos"));
const configuration = args.includes("--debug") ? "Debug" : "Release";
const build = await $`xcodebuild -project EarthRT.xcodeproj -scheme EarthRT -configuration ${configuration} -derivedDataPath ${join(native, ".build/xcode")} build`
  .cwd(join(native, "macos")).quiet().nothrow();
if (build.exitCode !== 0) {
  const text = build.stdout.toString() + build.stderr.toString();
  console.error(text.split("\n").filter(line => /error:|BUILD FAILED/.test(line)).slice(0, 40).join("\n"));
  process.exit(1);
}
let app = join(native, `.build/xcode/Build/Products/${configuration}/EarthRT.app`);
// Builds from elsewhere, carried in the app (Paths.swift reads Resources/web and Resources/traced when the checkout has none).
const web = flag("--web"), traced = flag("--traced");
if (web) await $`rm -rf ${join(app, "Contents/Resources/web")} && ditto ${web} ${join(app, "Contents/Resources/web")}`;
if (traced) await $`mkdir -p ${join(app, "Contents/Resources/traced")} && cp ${traced} ${join(app, "Contents/Resources/traced/traced.js")}`;
if (web || traced) await $`codesign --force --sign - ${app}`.quiet();
const outDir = flag("--out");
if (outDir) {
  const copy = join(resolve(outDir), "EarthRT.app");
  await $`rm -rf ${copy} && ditto ${app} ${copy}`;
  app = copy;
}
console.log(app);
if (args.includes("--run") || flag("--open")) {
  // One copy at a time: two would share the sidecar's server file and the asset root.
  await $`pkill -f ${app + "/Contents/MacOS/"}`.nothrow().quiet();
  await Bun.sleep(500);
  // (Registers the URL scheme with Launch Services too: earthrt:// links open this build.)
  await $`/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f ${app}`.nothrow().quiet();
  const link = flag("--open");
  if (link) await $`open -a ${app} ${link}`;
  else await $`open -n ${app}`;
}
