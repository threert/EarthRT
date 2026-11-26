// The app's icon, made from the globe itself: a traced picture of the Earth from orbit (`earthrt shot --here` with
// the whole Earth in view), cut round and set on a night-sky tile in macOS's icon grid, at every size the asset
// catalog wants. Needs ImageMagick (`brew install imagemagick`).
//
//   bun native/tools/icon.ts <globe.png> [--x 0.5 --y 0.5 --r 0.42]     (the globe's centre and radius, in the
//                                                                          picture's height)
import { $ } from "bun";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const src = args.find(a => !a.startsWith("--") && !/^[\d.]+$/.test(a));
if (!src) { console.error("bun native/tools/icon.ts <globe.png>"); process.exit(1); }
const num = (k: string, d: number) => (args.includes(k) ? Number(args[args.indexOf(k) + 1]) : d);
const set = resolve(import.meta.dir, "../macos/App/Assets.xcassets/AppIcon.appiconset");
const tmp = resolve(import.meta.dir, "../.build/icon");
mkdirSync(tmp, { recursive: true });

const [w, h] = (await $`magick identify -format "%w %h" ${src}`.text()).split(" ").map(Number);
const cx = num("--x", 0.5) * w, cy = num("--y", 0.5) * h, r = num("--r", 0.42) * h;
// The globe, cut round (a soft edge), 700 px across.
const globe = join(tmp, "globe.png");
await $`magick ${src} -crop ${Math.round(2 * r)}x${Math.round(2 * r)}+${Math.round(cx - r)}+${Math.round(cy - r)} +repage -resize 700x700! ( -size 700x700 xc:black -fill white -draw "circle 350,350 350,2" -blur 0x1.2 ) -alpha off -compose CopyOpacity -composite ${globe}`;
// The tile: macOS's 824 px rounded square on a 1024 canvas, a night sky with a blue glow where the atmosphere is.
const icon = join(tmp, "icon-1024.png");
await $`magick -size 1024x1024 xc:none ( -size 824x824 gradient:#16244a-#03050c ) -geometry +100+100 -compose over -composite ( -size 1024x1024 xc:none -fill white -draw "roundrectangle 100,100 923,923 185,185" ) -compose DstIn -composite ( -size 1024x1024 xc:none -fill "rgba(90,160,255,0.55)" -draw "circle 512,512 512,148" -blur 0x22 ) -compose over -composite ( ${globe} ) -geometry +162+162 -compose over -composite ${icon}`;
const sizes: [number, number][] = [[16, 1], [16, 2], [32, 1], [32, 2], [128, 1], [128, 2], [256, 1], [256, 2], [512, 1], [512, 2]];
const images = [];
for (const [pt, scale] of sizes) {
  const name = `icon_${pt}x${pt}${scale === 2 ? "@2x" : ""}.png`;
  await $`magick ${icon} -resize ${pt * scale}x${pt * scale} ${join(set, name)}`;
  images.push({ idiom: "mac", scale: `${scale}x`, size: `${pt}x${pt}`, filename: name });
}
await Bun.write(join(set, "Contents.json"), JSON.stringify({ images, info: { author: "xcode", version: 1 } }, null, 2) + "\n");
console.log(`${set} (from ${src})`);
