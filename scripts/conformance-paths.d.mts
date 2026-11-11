// SPDX-License-Identifier: Apache-2.0
// The types of conformance-paths.mjs, for the test that imports it.

/** The folders of sessionpipe's conformance/ this receiver runs. */
export declare const FOLDERS: string[];
/** Files directly under conformance/ that are copied too, by name. */
export declare const FILES: string[];
/** A path `git ls-tree` lists → where it lands under test/conformance/, or null when it is not one to write. */
export declare function fixtureRel(listed: unknown): string | null;
