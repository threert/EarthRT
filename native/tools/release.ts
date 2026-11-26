// A distributable EarthRT for macOS: the app with everything it runs carried inside (the sidecar and its packages,
// @earthrt/core's sources it imports, the globe's script, the engine's presets, a Bun), signed with a Developer ID and
// the hardened runtime, notarized and stapled, in a .dmg that is notarized and stapled too. Local only: it publishes
// nothing.
//
//   bun native/tools/release.ts [--sign "Developer ID Application: …"] [--notarize <keychain profile>] [--no-build]
//
// Defaults: the TypeSafe Limited Developer ID and the THREERT_NOTARY profile. Without the profile (a locked screen
// cannot read it), THREERT_ASC_KEY (a .p8 path), THREERT_ASC_KEY_ID and THREERT_ASC_ISSUER are used. --notarize none
// signs only. Output: native/.build/release/EarthRT-<version>-macos-arm64.dmg
import { $ } from "bun";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const native = join(root, "native");
const args = process.argv.slice(2);
const flag = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const identity = flag("--sign") ?? "Developer ID Application: TypeSafe Limited (9FDAZCRAN3)";
const profile = flag("--notarize") ?? "THREERT_NOTARY";
const step = (s: string) => console.log(`\x1b[1m${s}\x1b[0m`);

if (!args.includes("--no-build")) await $`bun ${join(native, "tools/macos.ts")}`.cwd(root);
const built = join(native, ".build/xcode/Build/Products/Release/EarthRT.app");
const version = /MARKETING_VERSION:\s*"?([\d.]+)/.exec(readFileSync(join(native, "macos/project.yml"), "utf8"))?.[1] ?? "0.0.0";
const out = join(native, ".build/release");
const app = join(out, "EarthRT.app");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
step(`copy the app (${version})`);
await $`ditto ${built} ${app}`;

// ----- what the app runs, inside it: Contents/Resources/earthrt (Paths.swift reads it there) -----
step("carry the sidecar, @earthrt/core, the globe's script, the presets and Bun");
const res = join(app, "Contents/Resources/earthrt");
const copy = (from: string, to = from) => cpSync(join(root, from), join(res, to), { recursive: true, dereference: true, filter: p => !/\/(\.build|test|\.DS_Store)(\/|$)/.test(p) });
copy("native/sidecar/src");
copy("native/sidecar/package.json");
copy("native/sidecar/bun.lock");
copy("packages/core/src");
copy("app/dist/earth.js");
copy("engine/presets");
await $`bun install --production --frozen-lockfile`.cwd(join(res, "native/sidecar")).quiet();
mkdirSync(join(res, "bin"), { recursive: true });
const bun = (await $`which bun`.text()).trim();
cpSync(bun, join(res, "bin/bun"), { dereference: true });
// The packaged sidecar finds the repository's layout under Resources/earthrt; Info.plist's EarthRTRoot (a build's
// checkout) must not point at this machine.
await $`/usr/libexec/PlistBuddy -c "Delete :EarthRTRoot" ${join(app, "Contents/Info.plist")}`.nothrow().quiet();

// ----- signing: nested code first, then the app -----
step(`sign with ${identity}`);
const ent = join(out, "bun.entitlements");
// Bun's JavaScriptCore JIT needs these under the hardened runtime.
writeFileSync(ent, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
<key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
`);
const nested = (await $`find ${res} -type f ( -name "*.node" -o -name "*.dylib" )`.text()).split("\n").filter(Boolean);
for (const f of nested) await $`codesign --force --timestamp --options runtime --sign ${identity} ${f}`.quiet();
await $`codesign --force --timestamp --options runtime --entitlements ${ent} --sign ${identity} ${join(res, "bin/bun")}`.quiet();
await $`codesign --force --timestamp --options runtime --sign ${identity} ${app}`.quiet();
await $`codesign --verify --deep --strict --verbose=2 ${app}`.quiet();

async function notarize(file: string) {
  if (profile === "none") return;
  const auth = await $`xcrun notarytool history --keychain-profile ${profile}`.nothrow().quiet();
  const how = auth.exitCode === 0
    ? ["--keychain-profile", profile]
    : ["--key", process.env.THREERT_ASC_KEY ?? "", "--key-id", process.env.THREERT_ASC_KEY_ID ?? "", "--issuer", process.env.THREERT_ASC_ISSUER ?? ""];
  if (how[1] === "") throw new Error(`notarization: the keychain profile ${profile} cannot be read and THREERT_ASC_KEY / _KEY_ID / _ISSUER are not set`);
  step(`notarize ${file.split("/").pop()} (a few minutes)`);
  const r = await $`xcrun notarytool submit ${file} ${how} --wait --output-format json`.nothrow().quiet();
  const j = JSON.parse(r.stdout.toString() || "{}");
  if (j.status !== "Accepted") {
    console.error(r.stdout.toString(), r.stderr.toString());
    if (j.id) console.error((await $`xcrun notarytool log ${j.id} ${how}`.nothrow().text()));
    throw new Error(`notarization: ${j.status ?? "failed"}`);
  }
}

// The app first (stapled, so it opens offline from the dmg or after it is copied out), then the dmg.
const zip = join(out, "EarthRT.zip");
await $`ditto -c -k --keepParent ${app} ${zip}`;
await notarize(zip);
if (profile !== "none") await $`xcrun stapler staple ${app}`.quiet();
rmSync(zip);

step("make the dmg");
const dmg = join(out, `EarthRT-${version}-macos-arm64.dmg`);
const stage = join(out, "dmg");
mkdirSync(stage);
await $`ditto ${app} ${join(stage, "EarthRT.app")}`;
await $`ln -s /Applications ${join(stage, "Applications")}`;
await $`hdiutil create -volname EarthRT -srcfolder ${stage} -ov -format UDZO ${dmg}`.quiet();
rmSync(stage, { recursive: true });
await $`codesign --force --timestamp --sign ${identity} ${dmg}`.quiet();
await notarize(dmg);
if (profile !== "none") {
  await $`xcrun stapler staple ${dmg}`.quiet();
  await $`spctl --assess --type open --context context:primary-signature -v ${dmg}`.nothrow();
  await $`spctl --assess --type execute -v ${app}`.nothrow();
}
console.log(dmg);
if (!existsSync(dmg)) process.exit(1);
