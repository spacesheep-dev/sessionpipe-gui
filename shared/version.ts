// SPDX-License-Identifier: Apache-2.0
/** Orders two versions as `x.y.z[-pre]`: a negative number when `a` is older, 0 when they
 *  are the same release, positive when `a` is newer. A missing part is 0 and a part that is
 *  no number counts as 0; a prerelease (`0.9.0-rc.1`) comes before its release, and two
 *  prereleases of the same release are the same here. Enough to tell an older receiver from
 *  a newer one; not a full semver. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.trim().replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre !== undefined };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  return Number(y.pre) - Number(x.pre);
}
