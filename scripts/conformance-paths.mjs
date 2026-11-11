// SPDX-License-Identifier: Apache-2.0
// Which paths of sessionpipe's conformance/ tree the sync (sync-conformance.mjs) may copy
// into test/conformance/, and where each lands. The tree it reads is somebody else's data:
// a path it lists is written only when it is one of ours by this rule, never because the
// tree said so. No side effects here, so the rule has a test (test/conformance.test.ts).

/** The folders this receiver runs, copied whole: only `.json` files directly inside. */
export const FOLDERS = ["control-vectors", "delivery"];

/** Files directly under conformance/ that are copied too, each by its name. None yet: a
 *  change that vendors one (control-attention.json, say) adds it here, and nothing else
 *  at that level is ever taken. */
export const FILES = [];

const IN_FOLDER = new RegExp(`^(?:${FOLDERS.join("|")})/[A-Za-z0-9][A-Za-z0-9._-]*\\.json$`);

/** A path as `git ls-tree` lists it (`conformance/<folder>/<name>.json`) → the path under
 *  test/conformance/ it is written to (`<folder>/<name>.json`), or null when it is not one
 *  to write: another folder, a folder inside a folder, a name that climbs (`..`), is
 *  absolute, starts with a dot or holds a slash, a backslash or anything else outside
 *  letters, digits and `._-`, or a file that is not `.json`. */
export function fixtureRel(listed) {
  if (typeof listed !== "string" || !listed.startsWith("conformance/")) return null;
  const rel = listed.slice("conformance/".length);
  return FILES.includes(rel) || IN_FOLDER.test(rel) ? rel : null;
}
