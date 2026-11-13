// SPDX-License-Identifier: Apache-2.0
// Owned by: web. The backend of the account this window shows, where the rest of the page
// can find it without loading it: start.ts sets it once it is up. Nothing here but a
// variable, so a page that shows no account pays nothing for asking.
import type { AccountBackend } from "./backend";

let current: AccountBackend | null = null;

/** The backend of the account this window shows, once it is up; null anywhere else. */
export const accountBackend = (): AccountBackend | null => current;
export const setAccountBackend = (b: AccountBackend | null): void => {
  current = b;
};
