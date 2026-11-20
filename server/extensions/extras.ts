// SPDX-License-Identifier: Apache-2.0
// Owned by: platform. The catalogue (server/extensions/catalog.ts) with what is present,
// and the installer for an entry that is not bundled: the same per-kind installers
// `view|skin|plugin add` use, fed the npm name. Two doors: `sessionpipe-gui extras add
// <id|all>` (cli.ts) and, for the Views page, GET /api/ui/extras (the catalogue with what
// is installed; a bundled view, skin or plugin counts as installed) and
// POST /api/ui/extras/:id/install, this computer only, which streams the installer's lines as
// plain text and ends with `ok` or `failed`, or answers 409 for a bundled entry. Every
// official extension is bundled today, so the install door stays shut until the packages
// are published.
import { existsSync } from "node:fs";
import path from "node:path";
import { type ExtraEntry, type ExtrasResponse, ROUTES } from "../../shared/api.js";
import type { Ctx, Handler, Router } from "../http/router.js";
import { addPlugin } from "../plugins/install.js";
import { addSkin } from "../skins/install.js";
import { addTheme } from "../themes/install.js";
import { EXTRAS, findExtra } from "./catalog.js";
import { InstallError, type InstallResult } from "./install.js";
import { bundledDirs } from "./kind.js";

/** Where each kind is installed: <stateDir>/themes, /skins, /plugins (or the --*-dir overrides). */
export interface ExtrasDirs {
  themes: string;
  skins: string;
  plugins: string;
  /** Where the bundled views are (default dist/bundled/views); the bundled skins and
   *  plugins are its siblings (`../skins`, `../plugins`). */
  bundled?: string;
}

const MANIFEST = { view: "theme.json", skin: "skin.json", plugin: "plugin.json" } as const;

/** Install one catalogue entry from npm with the installer of its kind. */
export function installExtra(dirs: ExtrasDirs, entry: ExtraEntry): Promise<InstallResult> {
  switch (entry.kind) {
    case "skin":
      return addSkin(dirs.skins, entry.npm);
    case "plugin":
      return addPlugin(dirs.plugins, entry.npm);
    default:
      return addTheme(dirs.themes, entry.npm);
  }
}

/** Whether the entry's folder is there (a bundled one counts), without validating it. */
export function extraInstalled(dirs: ExtrasDirs, entry: ExtraEntry): boolean {
  const base = entry.kind === "skin" ? dirs.skins : entry.kind === "plugin" ? dirs.plugins : dirs.themes;
  if (existsSync(path.join(base, entry.id, MANIFEST[entry.kind]))) return true;
  return existsSync(path.join(bundledDirs(dirs.bundled)[entry.kind], entry.id, MANIFEST[entry.kind]));
}

export interface ExtrasRouteDeps {
  uiAuth: (ctx: Ctx) => boolean;
  dirs: ExtrasDirs;
  /** The installer; tests hand in a fake. */
  install?: (dirs: ExtrasDirs, entry: ExtraEntry) => Promise<InstallResult>;
  /** After a successful install: rescan that kind's registry so the page sees it. */
  after?: (kind: ExtraEntry["kind"]) => Promise<void> | void;
  /** The catalogue; the real one unless a test hands in another. */
  catalog?: readonly ExtraEntry[];
}

export function catalogResponse(dirs: ExtrasDirs, catalog: readonly ExtraEntry[] = EXTRAS): ExtrasResponse {
  return { extras: catalog.map((e) => ({ ...e, installed: extraInstalled(dirs, e) })) };
}

/** POST /api/ui/extras/:id/install. Exported so a test can call it with a made-up context. */
export function installHandler(deps: ExtrasRouteDeps): Handler {
  return async (ctx) => {
    if (!ctx.remote.thisComputer) return { status: 403, json: { reason: "loopback_only" } };
    const id = ctx.params.id ?? "";
    const entry = deps.catalog ? deps.catalog.find((e) => e.id === id) : findExtra(id);
    if (!entry) return { status: 404, json: { reason: "not_found" } };
    if (entry.bundled) return { status: 409, json: { reason: "bundled" } };
    ctx.res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    ctx.res.write(`installing ${entry.name} from npm (${entry.npm})…\n`);
    try {
      const r = await (deps.install ?? installExtra)(deps.dirs, entry);
      await deps.after?.(entry.kind);
      ctx.res.end(`${r.message}\nok\n`);
    } catch (e) {
      const msg = e instanceof InstallError ? e.message : ((e as Error).message ?? String(e));
      ctx.res.end(`${msg}\nfailed\n`);
    }
    return undefined;
  };
}

export function registerExtras(router: Router, deps: ExtrasRouteDeps): void {
  const guard =
    (h: Handler): Handler =>
    (ctx) =>
      deps.uiAuth(ctx) ? h(ctx) : { status: 401, json: { reason: "unauthorized" } };
  router.get(
    ROUTES.ui.extras,
    guard(() => ({
      status: 200,
      headers: { "cache-control": "no-store" },
      json: catalogResponse(deps.dirs, deps.catalog),
    })),
  );
  router.post(`${ROUTES.ui.extras}/:id/install`, guard(installHandler(deps)));
}
