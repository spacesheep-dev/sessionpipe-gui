// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. Serves the built web app (dist/web) as the router's fallback:
// files by path, index.html for anything else (the SPA routes), a cookie from `?k=`,
// and a short 401 page for a LAN visitor without the key.
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UI_KEY_COOKIE, UI_KEY_PARAM } from "../shared/api.js";
import type { Ctx, Handler, Reply } from "./http/router.js";
import { WORDMARK_CSS, wordmarkHtml } from "./ui/brand.js";

export const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** Where the built web app is: `dist/web` beside the bundled `dist/cli.js`, or, when
 *  running from source, the repo's `dist/web`. */
export function webDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const c of [path.join(here, "web"), path.join(here, "..", "dist", "web")]) if (existsSync(c)) return c;
  return path.join(here, "web");
}

export interface StaticOptions {
  uiAuth: (ctx: Ctx) => boolean;
  uiKey: () => string;
}

export function staticFiles(dir: string, opts: StaticOptions): Handler {
  return (ctx): Reply | undefined => {
    const { pathname } = ctx.url;
    if (pathname.startsWith("/api/") || pathname.startsWith("/.well-known/")) {
      return { status: 404, json: { reason: "not_found" } };
    }
    const method = ctx.req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") return { status: 405, json: { reason: "method_not_allowed" } };

    // `?k=<ui key>` on any page: set the cookie and come back without it in the URL.
    const k = ctx.url.searchParams.get(UI_KEY_PARAM);
    if (k !== null && k === opts.uiKey()) {
      const rest = new URLSearchParams(ctx.url.searchParams);
      rest.delete(UI_KEY_PARAM);
      const qs = rest.toString();
      return {
        status: 302,
        text: "",
        headers: {
          location: `${pathname}${qs ? `?${qs}` : ""}`,
          "set-cookie": `${UI_KEY_COOKIE}=${encodeURIComponent(k)}; Path=/; Max-Age=31536000; SameSite=Lax`,
          "cache-control": "no-store",
        },
      };
    }
    if (!opts.uiAuth(ctx)) return unauthorized();
    if (!existsSync(path.join(dir, "index.html"))) {
      return { status: 503, text: "The web app is not built: run `npm run build` (dist/web is missing).\n" };
    }

    let file = resolveFile(dir, pathname);
    if (!file) file = path.join(dir, "index.html");
    const ext = path.extname(file).toLowerCase();
    const immutable = pathname.startsWith("/assets/") && file !== path.join(dir, "index.html");
    const st = statSync(file);
    // Hashed assets never change; everything else (the fonts, the icons, the manifest, the
    // page) is asked about again each time, and a 304 answers when the file is the same.
    const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const headers: Record<string, string> = {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      etag,
    };
    if (!immutable && ctx.req.headers["if-none-match"] === etag) {
      ctx.res.writeHead(304, headers);
      ctx.res.end();
      return undefined;
    }
    headers["content-length"] = String(st.size);
    ctx.res.writeHead(200, headers);
    if (method === "HEAD") {
      ctx.res.end();
      return undefined;
    }
    createReadStream(file).pipe(ctx.res);
    return undefined;
  };
}

/** A file under `dir` for a request path, or null (missing, a directory, or outside). */
function resolveFile(dir: string, pathname: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const abs = path.resolve(dir, `.${path.posix.normalize(`/${rel}`)}`);
  if (abs !== dir && !abs.startsWith(dir + path.sep)) return null;
  try {
    return statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

function unauthorized(): Reply {
  return {
    status: 401,
    headers: { "cache-control": "no-store" },
    html: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>sessionpipe-gui · not signed in</title>
<meta name="color-scheme" content="light dark">
<style>:root{color-scheme:light dark;--bg:#ffffff;--bg-3:#f5f5f3;--line:#e4e4e1;--fg:#141414;--fg-3:#5c5c5a}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--bg-3:#222222;--line:#2a2a2a;--fg:#f5f5f3;--fg-3:#9a9a96}}
body{font:16px/1.5 system-ui,sans-serif;max-width:36em;margin:4em auto;padding:0 1.5em;background:var(--bg);color:var(--fg)}code{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:.92em;background:var(--bg-3);padding:.1em .3em;border-radius:3px}
header{padding-bottom:12px;border-bottom:1px solid var(--line)}${WORDMARK_CSS}</style>
<header>${wordmarkHtml()}</header>
<h1>This board needs its key</h1>
<p>You are reaching sessionpipe-gui from another device. Open it through the link or the QR code the terminal printed where it runs: that link carries the key (<code>?k=…</code>) and sets a cookie here, once.</p>
<p>From the machine itself, <code>http://localhost</code> needs no key.</p>
`,
  };
}
