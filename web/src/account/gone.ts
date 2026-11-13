// SPDX-License-Identifier: Apache-2.0
// Owned by: web. What is left on this phone of an account that is no longer on it. An
// account is disconnected in its own window, which removes what the page kept (backend.ts
// `drop`); but one can also go while no window shows it (replaced by another connect at
// the same origin, disconnected from another window, a restored backup with no key), and
// then nothing runs to clean up after it. So every window of the app that knows of
// accounts asks the hub once, as it opens, which accounts are here, and removes what
// belongs to any other: the cached sessions (one IndexedDB database an account id) and,
// when the storage was last written beside an account that is gone, the page's own
// (local.ts). Asked of the hub and found unanswerable, it removes nothing.
import { sweepCaches } from "./cache";
import { ownerOf, wipeLocal } from "./local";
import type { AccountStatus } from "./shell";

export interface Swept {
  /** The cache databases deleted, by name. */
  caches: string[];
  /** The storage keys removed. */
  local: string[];
}

export async function sweepGone(
  status: () => Promise<AccountStatus>,
  o: { idb?: IDBFactory; wipe?: () => string[]; owner?: () => string | null } = {},
): Promise<Swept> {
  let here: string[];
  try {
    here = (await status()).accounts.map((a) => a.id);
  } catch {
    return { caches: [], local: [] };
  }
  const caches = await sweepCaches(here, o.idb ?? globalThis.indexedDB);
  const owner = (o.owner ?? ownerOf)();
  const local = owner !== null && !here.includes(owner) ? (o.wipe ?? wipeLocal)() : [];
  return { caches, local };
}
