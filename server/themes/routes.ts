// SPDX-License-Identifier: Apache-2.0
// Owned by: platform. The theme routes: the listing, the reload (loopback), per-theme
// state (a JSON document ≤ 256 KB under <stateDir>/themes-state/<id>.json) and the
// theme's own files at /themes/<id>/<file>. Everything needs uiAuth, like /api/ui.
// The state carries an ETag (a hash of the document), so a view on two devices can
// write with If-Match and merge instead of overwriting (412 `conflict`), and every write
// is announced (`onState`) so the other devices re-read it.
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { THEME_ID_RE, THEME_ROUTES } from "../../shared/theme-api.js";
import type { Ctx, Handler, Reply, Router } from "../http/router.js";
import { TYPES } from "../static.js";
import { FILES_PREFIX, publicTheme, type ThemeRegistry } from "./registry.js";

export const STATE_MAX_BYTES = 256 * 1024;

/** Revalidated on every load, so a linked theme under development shows its edits. */
const NO_CACHE = new Set([".js", ".mjs", ".css", ".json", ".map", ".html"]);

const EXTRA_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".md": "text/markdown; charset=utf-8",
};

export interface ThemeRouteDeps {
  registry: ThemeRegistry;
  uiAuth: (ctx: Ctx) => boolean;
  /** <stateDir>/themes-state */
  stateDir: string;
  /** Remember a view as off (or on again) in config.json; the registry is rescanned after. */
  setDisabled?: (id: string, off: boolean) => void;
  /** A view's state was written: its id and the new ETag (for the `viewState` frame). */
  onState?: (id: string, etag: string) => void;
}

/** The ETag of a state document's text; `"0"` stands for "nothing stored yet". */
export const stateEtag = (text: string | null): string =>
  text === null ? '"0"' : `"${createHash("sha256").update(text).digest("base64url").slice(0, 16)}"`;

export function registerThemes(router: Router, deps: ThemeRouteDeps): void {
  const guard =
    (h: Handler): Handler =>
    (ctx) =>
      deps.uiAuth(ctx) ? h(ctx) : { status: 401, json: { reason: "unauthorized" } };

  router.get(
    THEME_ROUTES.list,
    guard(
      (ctx): Reply => ({
        status: 200,
        headers: { "cache-control": "no-store" },
        json: { themes: deps.registry.list().map((t) => publicTheme(t, ctx.remote.loopback)) },
      }),
    ),
  );

  router.post(
    THEME_ROUTES.reload,
    guard((ctx): Reply => {
      if (!ctx.remote.loopback) return { status: 403, json: { reason: "loopback_only" } };
      const themes = deps.registry.scan().map((t) => publicTheme(t, true));
      return { status: 200, json: { themes } };
    }),
  );

  for (const verb of ["disable", "enable"] as const) {
    router.post(
      `${THEME_ROUTES.toggle}/:id/${verb}`,
      guard((ctx): Reply => {
        if (!ctx.remote.loopback) return { status: 403, json: { reason: "loopback_only" } };
        const id = ctx.params.id ?? "";
        if (!THEME_ID_RE.test(id)) return { status: 400, json: { reason: "bad_id" } };
        if (!deps.registry.has(id)) return { status: 404, json: { reason: "not_found" } };
        deps.setDisabled?.(id, verb === "disable");
        const themes = deps.registry.scan().map((t) => publicTheme(t, true));
        return { status: 200, json: { themes } };
      }),
    );
  }

  const stateFile = (id: string): string => path.join(deps.stateDir, `${id}.json`);
  const readState = (id: string): string | null => {
    try {
      return readFileSync(stateFile(id), "utf8");
    } catch {
      return null;
    }
  };
  const knownId = (ctx: Ctx): string | Reply => {
    const id = ctx.params.id ?? "";
    if (!THEME_ID_RE.test(id)) return { status: 400, json: { reason: "bad_id" } };
    if (!deps.registry.has(id)) return { status: 404, json: { reason: "not_found" } };
    return id;
  };

  router.get(
    `${THEME_ROUTES.state}/:id/state`,
    guard((ctx): Reply => {
      const id = knownId(ctx);
      if (typeof id !== "string") return id;
      const text = readState(id);
      if (text === null)
        return { status: 204, text: "", headers: { "cache-control": "no-store", etag: stateEtag(null) } };
      return {
        status: 200,
        text,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          etag: stateEtag(text),
        },
      };
    }),
  );

  router.add(
    "PUT",
    `${THEME_ROUTES.state}/:id/state`,
    guard(async (ctx): Promise<Reply> => {
      const id = knownId(ctx);
      if (typeof id !== "string") return id;
      // Refuse an announced oversize body before reading it, so the client sees the 413
      // instead of a reset socket; a chunked one is cut off at the limit by ctx.body.
      const announced = Number(ctx.req.headers["content-length"]);
      if (Number.isFinite(announced) && announced > STATE_MAX_BYTES)
        return { status: 413, json: { reason: "too_large" } };
      const body = await ctx.body(STATE_MAX_BYTES);
      let value: unknown;
      try {
        value = JSON.parse(body.toString("utf8"));
      } catch {
        return { status: 400, json: { reason: "malformed" } };
      }
      if (value === undefined) return { status: 400, json: { reason: "malformed" } };
      // Compare-and-set: another device wrote since this one read. The check and the
      // write run without an await between them, so two writers cannot both pass.
      const ifMatch = ctx.req.headers["if-match"];
      const have = stateEtag(readState(id));
      if (typeof ifMatch === "string" && ifMatch !== "*" && ifMatch !== have)
        return { status: 412, json: { reason: "conflict" }, headers: { etag: have } };
      mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 });
      const file = stateFile(id);
      const tmp = `${file}.${process.pid}.tmp`;
      const text = JSON.stringify(value);
      writeFileSync(tmp, text, { mode: 0o600 });
      renameSync(tmp, file);
      const etag = stateEtag(text);
      if (etag !== have) deps.onState?.(id, etag);
      return { status: 204, text: "", headers: { etag } };
    }),
  );

  const files = guard((ctx): Reply | undefined => {
    const id = ctx.params.id ?? "";
    const theme = THEME_ID_RE.test(id) ? deps.registry.get(id) : undefined;
    if (!theme) return { status: 404, json: { reason: "not_found" } };
    const file = resolveInside(theme.dir, ctx.params.rest ?? "");
    if (!file) return { status: 404, json: { reason: "not_found" } };
    const ext = path.extname(file).toLowerCase();
    ctx.res.writeHead(200, {
      "content-type": TYPES[ext] ?? EXTRA_TYPES[ext] ?? "application/octet-stream",
      "cache-control": NO_CACHE.has(ext) ? "no-cache" : "public, max-age=300",
      "content-length": String(statSync(file).size),
    });
    if (ctx.req.method === "HEAD") {
      ctx.res.end();
      return undefined;
    }
    createReadStream(file).pipe(ctx.res);
    return undefined;
  });
  router.get(`${FILES_PREFIX}/:id/*rest`, files);
  router.add("HEAD", `${FILES_PREFIX}/:id/*rest`, files);
}

/** A regular file under `dir` for a relative request path, or null. Symlinks are
 *  followed, then the real path must still be inside the (real) theme folder, so a
 *  theme can be a linked folder but can never hand out a file from outside itself. */
export function resolveInside(dir: string, rel: string): string | null {
  if (!rel || rel.includes("\0")) return null;
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.includes("\\"))) return null;
  let real: string;
  let root: string;
  try {
    root = realpathSync(dir);
    real = realpathSync(path.join(dir, ...parts));
    if (!statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real.startsWith(root + path.sep) ? real : null;
}
