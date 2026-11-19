// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. What `sessionpipe-gui` says when the receiver cannot listen: the
// flag to change (--host or --port) instead of Node's own message, for the errors a
// person can fix from the command line.

/** Where the receiver listens when no --host is given (createApp's default): every
 *  address of this machine. */
export const DEFAULT_HOST = "0.0.0.0";

/** The line for a listen error a flag can fix, or undefined for any other error. `host`
 *  and `port` are what the receiver tried to listen on. Only the bind on that port
 *  (syscall `listen`) and the lookup of `host` (`getaddrinfo` for that name) count: an
 *  EACCES from creating the state folder, say, is not the port's. */
export function listenErrorMessage(
  err: unknown,
  host: string,
  port: number,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const e = err as (NodeJS.ErrnoException & { hostname?: string; address?: string; port?: number }) | null;
  // "--host 0.0.0.0", not "leave it out": a service installed with --host keeps it on a
  // later `service install` that leaves the flag out.
  const otherHost = `try another --host, or --host ${DEFAULT_HOST} to listen on every address`;
  // Node leaves `port` off the error for port 0.
  const bind = e?.syscall === "listen" && (e.port ?? 0) === port;
  const lookup = e?.syscall === "getaddrinfo" && e.hostname === host;
  switch (bind || lookup ? e?.code : undefined) {
    case "EADDRINUSE":
      return `port ${port} is in use (try --port)`;
    case "EACCES":
      // Windows: a port in a range the system keeps (netsh int ipv4 show excludedportrange),
      // or one another program holds for itself. macOS opens a port below 1024 to any user
      // on every address, not on one. Elsewhere: a port below 1024.
      if (platform === "win32")
        return `port ${port} is reserved by Windows or held by another program (try another --port)`;
      if (platform === "darwin" && port < 1024)
        return `port ${port} is open to this user only on every address (try another --port, or --host ${DEFAULT_HOST})`;
      return `port ${port} is not open to this user (try another --port${port < 1024 ? "; ports below 1024 are kept for root" : ""})`;
    case "EADDRNOTAVAIL": {
      // A name that looked up to an address this machine lacks says which one it got.
      const got = e?.address && e.address !== host ? `, it looks up to ${e.address}` : "";
      return `--host ${host} is not an address of this machine${got} (${otherHost})`;
    }
    case "ENOTFOUND":
      return `--host ${host} is not a name this machine can look up (${otherHost})`;
    case "EAI_AGAIN":
      return `--host ${host} could not be looked up just now (${otherHost})`;
    default:
      return undefined;
  }
}
