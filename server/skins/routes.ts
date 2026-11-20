// SPDX-License-Identifier: Apache-2.0
// Owned by: platform. The skin routes: the listing (uiAuth), the reload (this computer) and
// a skin package's own files at /skins/<id>/<file>, with the same rules as a view's:
// the real path must stay inside the (real) folder, json and css revalidate on every
// load so a linked skin shows its edits, fonts are immutable.
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { SKIN_ID_RE, SKIN_ROUTES } from "../../shared/skin-api.js";
import type { Ctx, Handler, Reply, Router } from "../http/router.js";
import { TYPES } from "../static.js";
import { resolveInside } from "../themes/routes.js";
import { publicSkin, type SkinRegistry } from "./registry.js";

const NO_CACHE = new Set([".json", ".css", ".js", ".mjs", ".map", ".html", ".md"]);
const FONT = new Set([".woff2", ".woff", ".ttf", ".otf"]);

const EXTRA_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".md": "text/markdown; charset=utf-8",
};

export interface SkinRouteDeps {
  registry: SkinRegistry;
  uiAuth: (ctx: Ctx) => boolean;
}

export function registerSkins(router: Router, deps: SkinRouteDeps): void {
  const guard =
    (h: Handler): Handler =>
    (ctx) =>
      deps.uiAuth(ctx) ? h(ctx) : { status: 401, json: { reason: "unauthorized" } };

  router.get(
    SKIN_ROUTES.list,
    guard(
      (ctx): Reply => ({
        status: 200,
        headers: { "cache-control": "no-store" },
        json: { skins: deps.registry.list().map((s) => publicSkin(s, ctx.remote.thisComputer)) },
      }),
    ),
  );

  router.post(
    SKIN_ROUTES.reload,
    guard((ctx): Reply => {
      if (!ctx.remote.thisComputer) return { status: 403, json: { reason: "loopback_only" } };
      const skins = deps.registry.scan().map((s) => publicSkin(s, true));
      return { status: 200, json: { skins } };
    }),
  );

  const files = guard((ctx): Reply | undefined => {
    const id = ctx.params.id ?? "";
    const skin = SKIN_ID_RE.test(id) ? deps.registry.get(id) : undefined;
    if (!skin) return { status: 404, json: { reason: "not_found" } };
    const file = resolveInside(skin.dir!, ctx.params.rest ?? "");
    if (!file) return { status: 404, json: { reason: "not_found" } };
    const ext = path.extname(file).toLowerCase();
    ctx.res.writeHead(200, {
      "content-type": TYPES[ext] ?? EXTRA_TYPES[ext] ?? "application/octet-stream",
      "cache-control": NO_CACHE.has(ext)
        ? "no-cache"
        : FONT.has(ext)
          ? "public, max-age=31536000, immutable"
          : "public, max-age=300",
      "content-length": String(statSync(file).size),
    });
    if (ctx.req.method === "HEAD") {
      ctx.res.end();
      return undefined;
    }
    createReadStream(file).pipe(ctx.res);
    return undefined;
  });
  router.get(`${SKIN_ROUTES.files}/:id/*rest`, files);
  router.add("HEAD", `${SKIN_ROUTES.files}/:id/*rest`, files);
}
