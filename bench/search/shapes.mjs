// SPDX-License-Identifier: Apache-2.0
// Owned by: search perf. The query shapes the gate times (harness.ts) and replays against a
// server (run.mjs). `live` = typed in the page (the last word is a prefix).
/** @type {{ name: string; q: string; live?: boolean; sort?: "best" | "newest" }[]} */
export const SHAPES = [
  { name: "common word", q: "error" },
  { name: "two words", q: "test build" },
  { name: "four words", q: "please check the error" },
  { name: "rare word", q: "axolotlcodexask" },
  { name: "phrase common", q: '"the error"' },
  { name: "phrase three", q: '"fix the bug"' },
  { name: "phrase rare", q: '"purple elephant migration"' },
  { name: "prefix 2 live", q: "re", live: true },
  { name: "prefix 3 live", q: "ses", live: true },
  { name: "prefix 4 live", q: "sear", live: true },
  { name: "typing two words", q: "store eve", live: true },
  { name: "prefix typed", q: "migrat*" },
  { name: "camelCase rare", q: "quokkaSerializerFactory" },
  { name: "camelCase common", q: "errorCode" },
  { name: "path", q: "src/store" },
  { name: "file name", q: "review.ts" },
  { name: "exclusion", q: "error -test" },
  { name: "exclusion phrase", q: 'build -"the error"' },
  { name: "filter agent", q: "agent:codex error" },
  { name: "filter since", q: "since:30d test" },
  { name: "filter machine", q: "machine:build-box session" },
  { name: "in prompt", q: "in:prompt deploy" },
  { name: "browse", q: "agent:claude" },
  { name: "newest", q: "error", sort: "newest" },
  { name: "cjk", q: "検索" },
  { name: "diacritics", q: "Größe" },
];
