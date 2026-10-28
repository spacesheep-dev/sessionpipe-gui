// SPDX-License-Identifier: Apache-2.0
// Owned by: demo. A seeded generator (mulberry32) and the id shapes the harnesses use,
// so one seed gives the same demo twice.

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  /** [0, 1) */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  /** Milliseconds around `mean`, never below `min`, with a long tail now and then. */
  ms(mean: number, min = 1): number {
    const spread = mean * (0.4 + this.next() * 1.2);
    const tail = this.next() < 0.08 ? mean * 2 : 0;
    return Math.max(min, Math.round(spread + tail));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)] as T;
  }
  hex(n: number): string {
    let out = "";
    for (let i = 0; i < n; i++) out += "0123456789abcdef"[this.int(0, 15)];
    return out;
  }
  base62(n: number): string {
    const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let out = "";
    for (let i = 0; i < n; i++) out += a[this.int(0, 61)];
    return out;
  }
  /** A v4-shaped uuid: what Claude Code uses for session and prompt ids. */
  uuid(): string {
    const h = this.hex(32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${this.pick(["8", "9", "a", "b"])}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
  /** A v7-shaped uuid: what Codex uses for thread and turn ids. */
  uuid7(now: number): string {
    const t = Math.floor(now).toString(16).padStart(12, "0");
    const h = this.hex(20);
    return `${t.slice(0, 8)}-${t.slice(8, 12)}-7${h.slice(0, 3)}-${this.pick(["8", "9", "a", "b"])}${h.slice(3, 6)}-${h.slice(6, 18)}`;
  }
  /** Claude Code tool-use ids. */
  toolu(): string {
    return `toolu_01${this.base62(22)}`;
  }
  /** Claude Code's minted permission id (ADAPTERS.md: perm-<16 hex>). */
  perm(): string {
    return `perm-${this.hex(16)}`;
  }
  /** Claude Code subagent ids (17 hex). */
  agent(): string {
    return this.hex(17);
  }
  /** A ULID at `now`: the daemon's ask ids (CONTROL.md §13). The time part sorts with the
   *  clock; the random part comes from the seed, so the demo stays the same demo. */
  ulid(now: number): string {
    const a = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let t = Math.floor(now);
    let time = "";
    for (let i = 0; i < 10; i++) {
      time = a[t % 32] + time;
      t = Math.floor(t / 32);
    }
    let rand = "";
    for (let i = 0; i < 16; i++) rand += a[this.int(0, 31)];
    return time + rand;
  }
}
