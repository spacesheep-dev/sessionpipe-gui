// SPDX-License-Identifier: Apache-2.0
// Owned by: platform. The plugin routes: the listing (uiAuth, secrets masked), the
// reload, the settings save and the enable / disable switch (all for this computer only: settings
// hold tokens, and reloading or enabling runs code). Registered from app.ts beside the
// theme routes.
import { PLUGIN_ID_RE, PLUGIN_ROUTES } from "../../shared/plugin-api.js";
import type { Ctx, Handler, Reply, Router } from "../http/router.js";
import type { PluginHost } from "./host.js";
import { SettingsError } from "./settings.js";

export const SETTINGS_MAX_BYTES = 64 * 1024;

export interface PluginRouteDeps {
  host: PluginHost;
  uiAuth: (ctx: Ctx) => boolean;
  /** Demo mode: plugins stay inactive; the listing says so. */
  demo?: boolean;
}

export function registerPlugins(router: Router, deps: PluginRouteDeps): void {
  const guard =
    (h: Handler): Handler =>
    (ctx) =>
      deps.uiAuth(ctx) ? h(ctx) : { status: 401, json: { reason: "unauthorized" } };

  router.get(
    PLUGIN_ROUTES.list,
    guard(
      (ctx): Reply => ({
        status: 200,
        headers: { "cache-control": "no-store" },
        json: { plugins: deps.host.list(ctx.remote.thisComputer), demo: deps.demo === true },
      }),
    ),
  );

  router.post(
    PLUGIN_ROUTES.reload,
    guard(async (ctx): Promise<Reply> => {
      if (!ctx.remote.thisComputer) return { status: 403, json: { reason: "loopback_only" } };
      await deps.host.reload();
      return { status: 200, json: { plugins: deps.host.list(true), demo: deps.demo === true } };
    }),
  );

  for (const verb of ["disable", "enable"] as const) {
    router.post(
      `${PLUGIN_ROUTES.toggle}/:id/${verb}`,
      guard(async (ctx): Promise<Reply> => {
        if (!ctx.remote.thisComputer) return { status: 403, json: { reason: "loopback_only" } };
        const id = ctx.params.id ?? "";
        if (!PLUGIN_ID_RE.test(id)) return { status: 400, json: { reason: "bad_id" } };
        try {
          await deps.host.setEnabled(id, verb === "enable");
        } catch (e) {
          if (/^no plugin/.test((e as Error).message)) return { status: 404, json: { reason: "not_found" } };
          throw e;
        }
        return { status: 200, json: { plugins: deps.host.list(true), demo: deps.demo === true } };
      }),
    );
  }

  router.add(
    "PUT",
    `${PLUGIN_ROUTES.settings}/:id/settings`,
    guard(async (ctx): Promise<Reply> => {
      if (!ctx.remote.thisComputer) return { status: 403, json: { reason: "loopback_only" } };
      const id = ctx.params.id ?? "";
      if (!PLUGIN_ID_RE.test(id)) return { status: 400, json: { reason: "bad_id" } };
      let body: unknown;
      try {
        body = await ctx.json(SETTINGS_MAX_BYTES);
      } catch {
        return { status: 400, json: { reason: "malformed" } };
      }
      if (!body || typeof body !== "object" || Array.isArray(body))
        return { status: 400, json: { reason: "malformed" } };
      try {
        const settings = await deps.host.saveSettings(id, body as Record<string, unknown>);
        return { status: 200, json: { settings } };
      } catch (e) {
        if (e instanceof SettingsError)
          return { status: 400, json: { reason: "bad_value", field: e.field, message: e.message } };
        if (/^no plugin/.test((e as Error).message)) return { status: 404, json: { reason: "not_found" } };
        throw e;
      }
    }),
  );
}
