// SPDX-License-Identifier: Apache-2.0
/** Orders two versions as `x.y.z[-pre][+build]`: a negative number when `a` is older, 0 when
 *  they are the same release, positive when `a` is newer. Build metadata (`+…`) is dropped; a
 *  part counts by its leading digits (none: 0) and a missing part is 0; a prerelease
 *  (`0.9.0-rc.1`) comes before its release, and two prereleases of the same release are the
 *  same here. Enough to tell an older receiver from a newer one; not a full semver. The
 *  desktop app's version_cmp (lifecycle/supervisor.rs) does the same, and both are tested
 *  against shared/version-cases.json. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const s = v.trim().replace(/^v/, "").split("+")[0] ?? "";
    const dash = s.indexOf("-");
    const core = dash >= 0 ? s.slice(0, dash) : s;
    return { nums: core.split(".").map((n) => Number(/^\d*/.exec(n)?.[0] || 0)), pre: dash >= 0 };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  return Number(y.pre) - Number(x.pre);
}
