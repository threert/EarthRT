// Registers a place with the EarthRT registry using your GitHub CLI login (`gh auth token`).
//   bun tools/register.ts <owner/repo> [--path dir] [--api https://earth.threert.dev]
//   bun tools/register.ts <owner/repo/id> --refresh | --like | --unlike
import { curl } from "./lib/bun-upstream.ts";

const args = process.argv.slice(2);
const opt = (f: string, d?: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const api = opt("--api", "https://earth.threert.dev")!.replace(/\/$/, "");
const target = args.find((a) => !a.startsWith("--") && a !== opt("--path") && a !== opt("--api"));
if (!target) { console.error("usage: bun tools/register.ts <owner/repo> [--path dir] [--api url]"); process.exit(2); }
const tok = Bun.spawnSync(["gh", "auth", "token"]).stdout.toString().trim();
if (!tok) { console.error("gh auth token: not logged in"); process.exit(1); }

async function call(method: string, path: string, body?: unknown) {
  // curl, with the token in a header read from stdin's environment, not the command line
  const p = Bun.spawn(["curl", "-sS", "-X", method, "-H", "@-", "-H", "content-type: application/json", ...(body ? ["--data-binary", JSON.stringify(body)] : []), "-w", "\n%{http_code}", `${api}/api/v1${path}`], { stdin: "pipe", stdout: "pipe" });
  p.stdin.write(`authorization: Bearer ${tok}\n`);
  p.stdin.end();
  const out = await new Response(p.stdout).text();
  const nl = out.lastIndexOf("\n");
  return { status: Number(out.slice(nl + 1)), text: out.slice(0, nl) };
}

let r;
if (args.includes("--refresh")) r = await call("POST", `/places/${target}/refresh`);
else if (args.includes("--like")) r = await call("PUT", `/places/${target}/like`);
else if (args.includes("--unlike")) r = await call("DELETE", `/places/${target}/like`);
else r = await call("POST", "/places", { repo: target, ...(opt("--path") ? { path: opt("--path") } : {}) });
console.log(r.status);
try { console.log(JSON.stringify(JSON.parse(r.text), null, 2)); } catch { console.log(r.text); }
process.exit(r.status < 300 ? 0 : 1);
void curl;
