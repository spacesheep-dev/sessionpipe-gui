// SPDX-License-Identifier: Apache-2.0
// Owned by: search perf. Types of bench/search/gen.mjs for the TypeScript tests.
export interface Needle {
  q: string;
  keys: string[];
  kind: "must" | "never" | "soft";
  why: string;
  /** The indexes this answer holds for (default: both). */
  sources?: ("history" | "sessionpipe")[];
}
export interface GenManifest {
  profile: string;
  seed: number;
  now: string;
  bytes: number;
  diskBytes: number;
  files: number;
  zstd: "zlib" | "cmd" | "off";
  zstFiles: number;
  sessions: Record<string, number>;
  messages: number;
  textBytes: number;
  secrets: string[];
  needles: Needle[];
}
export interface GenOptions {
  out: string;
  profile?: "gate" | "real" | "dense" | "demo";
  size?: number;
  seed?: number;
  now?: number;
  zstd?: "auto" | "off";
  /** Median turns of a Claude / Codex session (default: the profile's). */
  turns?: [number, number];
}
export function generate(o: GenOptions): GenManifest;
export function parseSize(s: string): number;
