// The EarthRT service: one Worker for the trunk tiles (/tiles), the registry (/api), the mirror (/p, on the files
// host) and the web app's static files (everything else).
import type { Env } from "./env.ts";
import { handleTiles } from "./tiles.ts";
import { handleApi, discover } from "./api/registry.ts";
import { handleMirror } from "./api/mirror.ts";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    const onFiles = !!env.FILES_HOST && url.hostname === env.FILES_HOST;
    if (p.startsWith("/p/")) {
      // user content only on the files host
      if (env.FILES_HOST && !onFiles) return Response.redirect(`https://${env.FILES_HOST}${p}${url.search}`, 301);
      return handleMirror(req, env, ctx, url);
    }
    if (onFiles) {
      if (p === "/" || p === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", { headers: { "content-type": "text/plain" } });
      return new Response("not found", { status: 404 });
    }
    if (p.startsWith("/tiles/")) return handleTiles(req, env, ctx, url);
    if (p === "/api" || p.startsWith("/api/")) {
      if (!p.startsWith("/api/v1")) return new Response("API versions: /api/v1", { status: 404 });
      return handleApi(req, env, url);
    }
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response("EarthRT", { headers: { "content-type": "text/plain" } });
  },

  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      discover(env).then(
        (r) => console.log("discovery", JSON.stringify(r)),
        (e) => console.error("discovery failed", e),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
