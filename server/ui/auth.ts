// SPDX-License-Identifier: Apache-2.0
// Who may use the UI API and the page: this computer (http/net.ts onThisComputer), or anyone who
// presents the UI key, as the `spgui` cookie the page sets or as `?k=` in the URL
// (the QR code carries it).
import { UI_KEY_COOKIE, UI_KEY_PARAM } from "../../shared/api.js";
import type { Ctx } from "../http/router.js";
import { secretEquals } from "../http/secret.js";

export function uiAuth(ctx: Ctx, uiKey: string): boolean {
  if (ctx.remote.thisComputer) return true;
  if (!uiKey) return false;
  // In constant time (http/secret.ts): every LAN visitor brings a guess here.
  if (secretEquals(ctx.url.searchParams.get(UI_KEY_PARAM), uiKey)) return true;
  return secretEquals(ctx.cookies()[UI_KEY_COOKIE], uiKey);
}

/** The `(ctx) => boolean` form control and the static server take; the key is read
 *  on every call so a rotated key applies at once. */
export const uiAuthFor =
  (uiKey: () => string) =>
  (ctx: Ctx): boolean =>
    uiAuth(ctx, uiKey());
