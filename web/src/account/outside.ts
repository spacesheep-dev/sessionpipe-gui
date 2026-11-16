// SPDX-License-Identifier: Apache-2.0
// Owned by: web. An address the app is about to hand to the browser, when it was given to
// the page rather than made by it (the hub's `devicesUrl`, a `revokeUrl`): it is opened
// only when it is an https address on the account's own origin. Anything else is not the
// account's page, whatever it says it is.

/** `url` when it is an https address on `origin`; else null. */
export function ownUrl(url: string | undefined | null, origin: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.origin === new URL(origin).origin ? url : null;
  } catch {
    return null;
  }
}
