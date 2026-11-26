// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. The one comparison of a secret a caller brings (the sink token,
// the UI key, a machine's pairing token, the local door's run secret) with the one this
// server holds. `===` stops at the first byte that differs, so how long a wrong guess takes
// tells a caller on the network how much of it was right; this takes as long whatever the
// guess, and whatever its length.
import { createHash, timingSafeEqual } from "node:crypto";

/** Equal secrets, in constant time whatever their lengths; never two empty ones. */
export function secretEquals(a: string | undefined | null, b: string): boolean {
  // An empty secret matches nothing, an empty one included.
  if (a === undefined || a === null || a === "" || b === "") return false;
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(a), h(b));
}
