// SPDX-License-Identifier: Apache-2.0
// Owned by: search sources. The redaction fast path must equal sessionpipe-core's own
// redactSecrets on every input: it may only skip a text redactSecrets would not change.
import { readFileSync } from "node:fs";
import { RULESET_SECRETS, redactSecrets } from "sessionpipe-core";
import { describe, expect, it } from "vitest";
import { redact } from "./text.js";

const R = (n: number, chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789") => {
  let s = "";
  for (let i = 0; i < n; i++) s += chars[(i * 7 + n * 13) % chars.length];
  return s;
};
const HEX = "0123456789abcdef";
const UP = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
/** One sample of every rule in secrets@1. */
const SECRETS = [
  `-----BEGIN RSA PRIVATE KEY-----\n${R(40)}\n-----END RSA PRIVATE KEY-----`,
  `AKIA${R(16, UP)}`,
  `ghp_${R(36)}`,
  `github_pat_${R(40)}`,
  `glpat-${R(24)}`,
  `xoxb-${R(14)}`,
  `https://hooks.slack.com/services/T000/B000/${R(24)}`,
  `https://discord.com/api/webhooks/1234567/${R(30)}`,
  `sk-ant-${R(40)}`,
  `sk_live_${R(24)}`,
  `whsec_${R(28)}`,
  `AIza${R(35)}`,
  `ya29.${R(30)}`,
  `1//0${R(40)}`,
  `GOCSPX-${R(28)}`,
  `xai-${R(40)}`,
  `gsk_${R(40)}`,
  `pplx-${R(40)}`,
  `hf_${R(40)}`,
  `pcsk_${R(40)}`,
  `npm_${R(36)}`,
  `pypi-${R(60)}`,
  `SG.${R(20)}.${R(20)}`,
  `shpat_${R(32, HEX)}`,
  `dop_v1_${R(64, HEX)}`,
  `lin_api_${R(40)}`,
  `ntn_${R(45)}`,
  `sbp_${R(40, HEX)}`,
  `figd_${R(36)}`,
  `dp.pt.${R(36)}`,
  `grn_${R(28)}`,
  `ss_${R(40, HEX)}`,
  `123456789:AA${R(33)}`,
  `eyJ${R(20)}.eyJ${R(20)}.${R(20)}`,
  "postgres://admin:S3cr3t-Pa55@db.internal:5432/app",
  `Authorization: Bearer ${R(32)}`,
  "DB_PASSWORD=x9!kQ2zzLp",
  "STRIPE_KEY = 'rk9Lm2Qx8Zp4'",
  "the password is Tr0ub4dor-x9Q",
  'apiKey: "Zq81mLkP0vXy"',
  "client_secret=Hj28Ks91Lq",
];
const WORDS =
  "the retry webhook delivery fix build test deploy src/a.ts --flag x=1 key: value TOKEN tokenizer passes :// https://example.com".split(
    " ",
  );

describe("redaction fast path", () => {
  it("is bound to the ruleset it was checked against", () => {
    expect(RULESET_SECRETS).toBe("secrets@1");
    // The pattern list this file mirrors: a new pattern needs a new trigger in MAYBE_SECRET.
    const src = readFileSync(new URL("../../../node_modules/sessionpipe-core/dist/index.js", import.meta.url), "utf8");
    const block = /var TOKEN_PATTERNS = \[([\s\S]*?)\n\];/.exec(src)?.[1] ?? "";
    expect(block.split("\n").filter((l) => /^\s*\/.*\/g,?\s*$/.test(l))).toHaveLength(34);
  });

  it("every rule's sample is redacted exactly as core does", () => {
    for (const s of SECRETS) {
      for (const t of [s, `see ${s} here`, `${s}\n`, s.toUpperCase(), s.toLowerCase()]) {
        expect(redact(t)).toBe(redactSecrets(t));
      }
      expect(redact(`note ${s} end`)).not.toBe(`note ${s} end`);
    }
  });

  it("equals core on thousands of mixed texts", () => {
    let seed = 11;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    let skipped = 0;
    for (let i = 0; i < 5000; i++) {
      const parts: string[] = [];
      const n = 1 + rnd(12);
      for (let k = 0; k < n; k++) {
        const r = rnd(10);
        parts.push(
          r === 0 ? (SECRETS[rnd(SECRETS.length)] ?? "") : r === 1 ? R(5 + rnd(50)) : (WORDS[rnd(WORDS.length)] ?? ""),
        );
      }
      const t = parts.join(rnd(3) ? " " : "");
      const want = redactSecrets(t);
      expect(redact(t)).toBe(want);
      if (want === t) skipped++;
    }
    expect(skipped).toBeGreaterThan(0);
  });

  it("plain prose takes the fast path and comes back as is", () => {
    const t = "Round invoice totals to the cent before tax, then rerun the suite.";
    expect(redact(t)).toBe(t);
  });
});
