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
  it("sorts Windows' WSL, Hyper-V, VirtualBox and VMware adapters after Wi-Fi", () => {
    const list = lanAddresses({
      "Wi-Fi": [v4("192.168.1.20"), v6("fe80::1")],
      "vEthernet (WSL)": [v4("172.20.16.1")],
      "vEthernet (Default Switch)": [v4("172.28.0.1")],
      "VirtualBox Host-Only Network": [v4("192.168.56.1")],
      "VMware Network Adapter VMnet8": [v4("192.168.146.1")],
      "Loopback Pseudo-Interface 1": [v4("127.0.0.1", true)],
    });
    expect(list).toEqual(["192.168.1.20", "172.20.16.1", "172.28.0.1", "192.168.56.1", "192.168.146.1"]);
  });
  it("sorts Linux's libvirt, LXD, Incus, LXC, Multipass, Podman and Docker bridges after the wireless interface", () => {
    const list = lanAddresses({
      lo: [v4("127.0.0.1", true)],
      wlp3s0: [v4("192.168.1.30"), v6("fe80::2")],
      virbr0: [v4("192.168.122.1")],
      lxdbr0: [v4("10.10.10.1")],
      incusbr0: [v4("10.20.20.1")],
      lxcbr0: [v4("10.0.3.1")],
      mpqemubr0: [v4("10.30.30.1")],
      podman0: [v4("10.88.0.1")],
      docker0: [v4("172.17.0.1")],
    });
    expect(list).toEqual([
      "192.168.1.30",
      "192.168.122.1",
      "10.10.10.1",
      "10.20.20.1",
      "10.0.3.1",
      "10.30.30.1",
      "10.88.0.1",
      "172.17.0.1",
    ]);
  });
  it("matches a virtual name whatever its case; a localized Windows name keeps its prefix", () => {
    const list = lanAddresses({
      WLAN: [v4("192.168.178.20")],
      "vEthernet (Standardswitch)": [v4("172.28.0.1")],
      "VIRTUALBOX HOST-ONLY NETWORK": [v4("192.168.56.1")],
      vboxnet0: [v4("192.168.57.1")],
    });
    expect(list).toEqual(["192.168.178.20", "172.28.0.1", "192.168.56.1", "192.168.57.1"]);
  });
  it("keeps every address when all interfaces are virtual, as under a Hyper-V external switch", () => {
    // Bridging Wi-Fi through an external switch moves the host's LAN address onto
    // "vEthernet (External Switch)": nothing real is left to come first, and nothing is dropped.
    const list = lanAddresses({
      "vEthernet (External Switch)": [v4("192.168.1.20")],
      "vEthernet (WSL)": [v4("172.20.16.1")],
    });
    expect(list).toEqual(["192.168.1.20", "172.20.16.1"]);
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
