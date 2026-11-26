// Fills service/public with the web app's build (web/dist) or, until there is one, the placeholder page.
import { cpSync, existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const here = join(import.meta.dir, "..");
const dist = join(here, "../web/dist");
const out = join(here, "public");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const from = existsSync(join(dist, "index.html")) ? dist : join(here, "placeholder");
cpSync(from, out, { recursive: true });
// the page is always revalidated; hashed files are immutable
writeFileSync(join(out, "_headers"), `/
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache
/static/*
  Cache-Control: public, max-age=31536000, immutable
`);
console.log(`assets: ${from} → ${out}`);
