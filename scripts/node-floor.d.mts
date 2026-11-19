// SPDX-License-Identifier: Apache-2.0
// The types of node-floor.mjs, for server/cli.ts and the test that import it.

/** The range `^20.19.0 || >=22.12.0`, as a person reads it. */
export declare const NODE_FLOOR: string;
/** Whether Node `version` ("22.12.0", "v20.19.1") is inside `^20.19.0 || >=22.12.0`. */
export declare function nodeSupported(version: string): boolean;
