// SPDX-License-Identifier: Apache-2.0
import os from "node:os";

export function isLoopback(ip: string): boolean {
  const v = ip.replace(/^::ffff:/, "");
  return v === "127.0.0.1" || v === "::1" || v.startsWith("127.");
}

/** A self-assigned address (169.254/16): no DHCP answered on that link, so nothing else
 *  on the network reaches it. */
export const isLinkLocal = (ip: string): boolean => ip.startsWith("169.254.");

/** IPv4 addresses of this machine on its networks, most likely LAN first: real interfaces
 *  before virtual ones (Docker, VMs), and a self-assigned address last of all. */
export function lanAddresses(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const out: string[] = [];
  const last: string[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (isLinkLocal(a.address)) last.push(a.address);
      else if (/^(docker|br-|veth|utun|vmnet|bridge)/.test(name)) out.push(a.address);
      else out.unshift(a.address);
    }
  }
  return [...out, ...last];
}
