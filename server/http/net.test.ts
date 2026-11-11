// SPDX-License-Identifier: Apache-2.0
import type os from "node:os";
import { describe, expect, it } from "vitest";
import { isLinkLocal, isLoopback, lanAddresses } from "./net.js";

const v4 = (address: string, internal = false): os.NetworkInterfaceInfo =>
  ({
    address,
    family: "IPv4",
    internal,
    netmask: "255.255.255.0",
    mac: "00:00:00:00:00:00",
    cidr: null,
  }) as os.NetworkInterfaceInfo;
const v6 = (address: string): os.NetworkInterfaceInfo =>
  ({
    address,
    family: "IPv6",
    internal: false,
    netmask: "ffff::",
    mac: "00:00:00:00:00:00",
    cidr: null,
    scopeid: 0,
  }) as os.NetworkInterfaceInfo;

describe("lanAddresses", () => {
  it("puts real interfaces first, virtual ones after, and a self-assigned 169.254 address last", () => {
    const list = lanAddresses({
      lo0: [v4("127.0.0.1", true)],
      en5: [v4("169.254.136.80")],
      en0: [v4("10.6.0.27"), v6("fe80::1")],
      bridge100: [v4("10.211.55.2")],
      en7: [v4("172.20.10.13")],
    });
    expect(list).toEqual(["172.20.10.13", "10.6.0.27", "10.211.55.2", "169.254.136.80"]);
    expect(list[0]).not.toMatch(/^169\.254\./);
  });
  it("reads the machine's own interfaces by default", () => {
    for (const ip of lanAddresses()) expect(isLoopback(ip)).toBe(false);
  });
  it("isLinkLocal and isLoopback", () => {
    expect(isLinkLocal("169.254.0.9")).toBe(true);
    expect(isLinkLocal("10.0.0.9")).toBe(false);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
  });
});
