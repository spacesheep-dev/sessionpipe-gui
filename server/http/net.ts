// SPDX-License-Identifier: Apache-2.0
import os from "node:os";

export function isLoopback(ip: string): boolean {
  const v = ip.replace(/^::ffff:/, "");
  return v === "127.0.0.1" || v === "::1" || v.startsWith("127.");
}

/** Every address of this machine's interfaces, IPv4 and IPv6, zone ids dropped. */
export function ownAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces()))
    for (const a of addrs ?? []) out.push(a.address.replace(/%.*$/, ""));
  return out;
}

const plainIp = (ip: string): string => ip.replace(/^::ffff:/i, "").replace(/%.*$/, "");

/** A request from `ip` was made on this machine: loopback, or one of its own addresses
 *  (the Mac's browser reaching https://<name>.local:7373 arrives from the LAN address). */
export function isThisMachine(ip: string, addresses: string[] = ownAddresses()): boolean {
  if (isLoopback(ip)) return true;
  const p = plainIp(ip);
  return addresses.some((a) => plainIp(a) === p);
}

/** The one rule for "this computer" (SECURITY.md): what needs no key, sees the sink token,
 *  rotates it, makes a new board key, and runs Setup's actions. A request that did not come
 *  through the proxy and is from loopback; or, only when the receiver does not listen on
 *  loopback at all (`--host` bound it to one address that is not loopback: `bound`), one
 *  that did not come through the proxy and comes from that very address. With every
 *  address bound (`bound` null), or a loopback one, loopback alone is this computer. */
export function onThisComputer(remote: { ip: string; forwarded: boolean }, bound: string | null): boolean {
  if (remote.forwarded) return false;
  if (isLoopback(remote.ip)) return true;
  return bound !== null && !isLoopback(bound) && plainIp(remote.ip) === plainIp(bound);
}

/** A self-assigned address (169.254/16): no DHCP answered on that link, so nothing else
 *  on the network reaches it. */
export const isLinkLocal = (ip: string): boolean => ip.startsWith("169.254.");

/** An interface a container runtime or a hypervisor made, by the start of its name: the
 *  Docker, Podman, libvirt, LXC, LXD, Incus and Multipass bridges, Linux veth pairs, macOS
 *  utun and bridge interfaces, VMware and VirtualBox host-side adapters on any OS, Windows'
 *  "vEthernet (…)" switches (WSL 2, Hyper-V). Case-insensitive: Windows names mix case, and
 *  a localized Windows name changes the part in parentheses, not the prefix. A VPN's
 *  interface (tun0, wg0, Tailscale) counts as real. */
const VIRTUAL_NAME =
  /^(docker|podman|br-|veth|utun|vmnet|vmware|vboxnet|virtualbox|bridge|virbr|lxcbr|lxdbr|incusbr|mpqemubr|hyper-v)/i;

/** IPv4 addresses of this machine on its networks, most likely LAN first: real interfaces
 *  before virtual ones (Docker, WSL 2, Hyper-V, VirtualBox, VMware, libvirt, LXD), and a
 *  self-assigned address last of all. A virtual interface is never dropped: a Hyper-V
 *  external switch carries the host's own LAN address on "vEthernet (External…)", so a
 *  machine with nothing but virtual names still lists every address, in the OS's order. */
export function lanAddresses(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const out: string[] = [];
  const last: string[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (isLinkLocal(a.address)) last.push(a.address);
      else if (VIRTUAL_NAME.test(name)) out.push(a.address);
      else out.unshift(a.address);
    }
  }
  return [...out, ...last];
}
