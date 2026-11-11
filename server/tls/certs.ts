// SPDX-License-Identifier: Apache-2.0
// Owned by: tls. A local certificate authority and a server certificate for TLS mode,
// made with the `openssl` CLI (present on macOS and Linux; no dependency) under
// <stateDir>/tls/, 0700, every file 0600:
//
//   ca.key, ca.crt          P-256, 10 years, CN "sessionpipe-gui local CA · <hostname>"
//   server.key, server.crt  P-256, 825 days (the iOS ceiling), SANs: <hostname>.local,
//                           localhost, 127.0.0.1 and every LAN IPv4; re-issued by
//                           itself when that set changes (a new network) or it nears expiry
//
// The CA is what a phone installs once (GET /ca.crt, the /trust page); the server
// certificate is what the https side of the listener presents.
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const CA_DAYS = 3650;
export const SERVER_DAYS = 825;
/** Re-issue the server certificate when it has fewer days than this left. */
export const RENEW_BEFORE_DAYS = 30;

export class TlsError extends Error {
  readonly name = "TlsError";
}

export interface TlsMaterial {
  dir: string;
  hostname: string;
  /** Every name and address the server certificate is valid for, as `DNS:` / `IP:` entries. */
  sans: string[];
  caKeyPath: string;
  caCertPath: string;
  serverKeyPath: string;
  serverCertPath: string;
  /** PEM, for `https.createServer`. */
  key: string;
  cert: string;
  caCert: string;
  /** SHA-256 of the CA certificate's DER, `AB:CD:…`. */
  caFingerprint: string;
  serverFingerprint: string;
  caExpiresAt: string;
  serverExpiresAt: string;
  /** What `ensureCerts` did this time. */
  made: "nothing" | "server" | "all";
}

export interface EnsureOptions {
  /** The `.local` name; default `localHostname()`. */
  hostname?: string;
  /** LAN IPv4 addresses to put in the SAN set; default `lanAddresses()` by the caller. */
  addresses?: string[];
  /** The clock (tests). */
  now?: () => number;
}

/** `os.hostname()` with any `.local` suffix removed, lowercased, `.local` appended: the
 *  name mDNS answers for this machine (macOS advertises it itself; Linux needs avahi). */
export function localHostname(raw: string = os.hostname()): string {
  const base = raw
    .trim()
    .toLowerCase()
    .replace(/\.local\.?$/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "sessionpipe-gui"}.local`;
}

/** The SAN entries for a hostname and a set of LAN addresses, in a stable order. */
export function sanSet(hostname: string, addresses: string[]): string[] {
  const dns = new Set<string>([hostname.toLowerCase(), "localhost"]);
  const ips = new Set<string>(["127.0.0.1", ...addresses.filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a))]);
  return [...[...dns].map((d) => `DNS:${d}`), ...[...ips].map((ip) => `IP:${ip}`)];
}

/** Where Windows installers put openssl.exe without putting it on the PATH: Git for Windows
 *  (its usr\bin; only Git\cmd goes on the PATH, so a `cmd` folder there names a Git
 *  wherever it was installed) and `winget install ShiningLight.OpenSSL.Light`
 *  (OpenSSL-Win64\bin under Program Files, -ARM on arm64). */
export function windowsOpensslPaths(env: NodeJS.ProcessEnv): string[] {
  const join = path.win32.join;
  const gits = (env.PATH ?? env.Path ?? "")
    .split(";")
    .map((d) =>
      d
        .trim()
        .replace(/^"|"$/g, "")
        .replace(/[\\/]+$/, ""),
    )
    .filter((d) => /[\\/]cmd$/i.test(d))
    .map((d) => join(d, "..", "usr", "bin"));
  const roots = [env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"]].filter((r): r is string => Boolean(r));
  const dirs = [
    ...gits,
    ...roots.flatMap((r) =>
      ["Git\\usr\\bin", "OpenSSL-Win64\\bin", "OpenSSL-Win64-ARM\\bin", "OpenSSL-Win32\\bin"].map((d) => join(r, d)),
    ),
    ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, "Programs", "Git", "usr", "bin")] : []),
  ];
  return [...new Set(dirs.map((d) => join(d, "openssl.exe")))];
}

type Exec = (command: string, args: string[], cwd?: string) => void;
const exec: Exec = (command, args, cwd) => {
  execFileSync(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
};
const runsVersion = (command: string, run: Exec): boolean => {
  try {
    run(command, ["version"]);
    return true;
  } catch {
    return false;
  }
};

/** The Windows openssl found last, kept while its file is there: the setup page asks every
 *  two seconds, and each look would start it again. */
let found: string | undefined;

/** On Windows, an openssl.exe off the PATH that runs. Looked for again whenever there is
 *  none, so an install shows without restarting the receiver (which keeps its PATH). */
export function windowsOpenssl(env: NodeJS.ProcessEnv = process.env, run: Exec = exec): string | undefined {
  if (found && existsSync(found)) return found;
  found = windowsOpensslPaths(env).find((p) => runsVersion(p, run));
  return found;
}

/** The openssl to run: the one on the PATH, else on Windows one where its installers put it. */
export function opensslCommand(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  run: Exec = exec,
): string | undefined {
  if (runsVersion("openssl", run)) return "openssl";
  return platform === "win32" ? windowsOpenssl(env, run) : undefined;
}

/** Is there an openssl CLI to run? */
export function opensslAvailable(): boolean {
  return opensslCommand() !== undefined;
}

/** Runs openssl: the PATH's; when there is none, on Windows the one its installers left
 *  off the PATH. */
export function openssl(
  args: string[],
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  run: Exec = exec,
): void {
  const attempt = (command: string): boolean => {
    try {
      run(command, args, cwd);
      return true;
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { stderr?: Buffer };
      if (err.code === "ENOENT") return false;
      throw new TlsError(`openssl ${args[0]} failed: ${(err.stderr?.toString() ?? err.message).trim()}`);
    }
  };
  if (attempt("openssl")) return;
  const other = platform === "win32" ? windowsOpenssl(env, run) : undefined;
  if (other && attempt(other)) return;
  throw new TlsError(
    platform === "win32"
      ? "TLS mode needs the `openssl` command, and none was found on the PATH, in Git for Windows or in an OpenSSL folder under Program Files. Install Git for Windows, or run `winget install ShiningLight.OpenSSL.Light`."
      : "TLS mode needs the `openssl` command, which is not on the PATH. macOS and most Linux distributions ship it (brew install openssl / apt install openssl).",
  );
}

/** PEM → `AB:CD:…` SHA-256 of the DER, the form every OS's certificate viewer shows. */
export function fingerprint256(pem: string): string {
  return new X509Certificate(pem).fingerprint256;
}

/** Colon-free lowercase form, for comparing by eye on a phone that shows it that way. */
export const compactFingerprint = (fp: string): string => fp.replace(/:/g, "").toLowerCase();

/** The SAN entries a certificate carries, normalised to `DNS:x` / `IP:x`. */
export function certSans(pem: string): string[] {
  const san = new X509Certificate(pem).subjectAltName ?? "";
  return san
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^IP Address:/i, "IP:").replace(/^DNS:/i, "DNS:"));
}

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x) => b.includes(x));

function daysLeft(pem: string, now: number): number {
  return (new Date(new X509Certificate(pem).validTo).getTime() - now) / 86_400_000;
}

const expiry = (pem: string): string => new Date(new X509Certificate(pem).validTo).toISOString();

function secretWrite(file: string, data: string): void {
  writeFileSync(file, data, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Read what is on disk without touching it; null when either pair is missing. */
export function readCerts(dir: string): Omit<TlsMaterial, "made"> | null {
  const paths = materialPaths(dir);
  if (![paths.caKeyPath, paths.caCertPath, paths.serverKeyPath, paths.serverCertPath].every((f) => existsSync(f)))
    return null;
  const caCert = readFileSync(paths.caCertPath, "utf8");
  const cert = readFileSync(paths.serverCertPath, "utf8");
  const key = readFileSync(paths.serverKeyPath, "utf8");
  let sans: string[];
  let hostname: string;
  try {
    sans = certSans(cert);
    hostname = sans.find((s) => s.startsWith("DNS:") && s !== "DNS:localhost")?.slice(4) ?? localHostname();
    return {
      ...paths,
      hostname,
      sans,
      key,
      cert,
      caCert,
      caFingerprint: fingerprint256(caCert),
      serverFingerprint: fingerprint256(cert),
      caExpiresAt: expiry(caCert),
      serverExpiresAt: expiry(cert),
    };
  } catch {
    return null;
  }
}

function materialPaths(dir: string) {
  return {
    dir,
    caKeyPath: path.join(dir, "ca.key"),
    caCertPath: path.join(dir, "ca.crt"),
    serverKeyPath: path.join(dir, "server.key"),
    serverCertPath: path.join(dir, "server.crt"),
  };
}

/** Make the CA and the server certificate if missing, re-issue the server certificate
 *  when its SAN set no longer matches the hostname and addresses (or it nears expiry),
 *  and return everything the https server and the trust page need. Synchronous: it runs
 *  at boot, before the port is bound. */
export function ensureCerts(dir: string, opts: EnsureOptions = {}): TlsMaterial {
  const hostname = (opts.hostname ?? localHostname()).toLowerCase();
  const wanted = sanSet(hostname, opts.addresses ?? []);
  const now = opts.now?.() ?? Date.now();
  const paths = materialPaths(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  let made: TlsMaterial["made"] = "nothing";
  const haveCa = existsSync(paths.caKeyPath) && existsSync(paths.caCertPath) && caUsable(paths.caCertPath, now);
  if (!haveCa) {
    for (const f of Object.values(paths)) if (f !== dir) rmSync(f, { force: true });
    makeCa(dir, paths, hostname);
    made = "all";
  }

  let haveServer = existsSync(paths.serverKeyPath) && existsSync(paths.serverCertPath);
  if (haveServer) {
    try {
      const pem = readFileSync(paths.serverCertPath, "utf8");
      const issuedByUs = new X509Certificate(pem).checkIssued(new X509Certificate(readFileSync(paths.caCertPath)));
      haveServer = issuedByUs && sameSet(certSans(pem), wanted) && daysLeft(pem, now) > RENEW_BEFORE_DAYS;
    } catch {
      haveServer = false;
    }
  }
  if (!haveServer) {
    makeServer(dir, paths, hostname, wanted);
    if (made === "nothing") made = "server";
  }

  const m = readCerts(dir);
  if (!m) throw new TlsError(`the certificates under ${dir} could not be read back after writing them`);
  return { ...m, hostname, made };
}

function caUsable(caCertPath: string, now: number): boolean {
  try {
    return daysLeft(readFileSync(caCertPath, "utf8"), now) > RENEW_BEFORE_DAYS;
  } catch {
    return false;
  }
}

/** A minimal openssl config: `-addext` is not in every LibreSSL, a config file is. */
function caConfig(hostname: string): string {
  return [
    "[req]",
    "distinguished_name = dn",
    "prompt = no",
    "utf8 = yes",
    "string_mask = utf8only",
    "x509_extensions = v3_ca",
    "[dn]",
    `CN = sessionpipe-gui local CA · ${hostname}`,
    "O = sessionpipe-gui",
    "[v3_ca]",
    "basicConstraints = critical, CA:TRUE, pathlen:0",
    "keyUsage = critical, keyCertSign, cRLSign",
    "subjectKeyIdentifier = hash",
    "",
  ].join("\n");
}

function serverConfig(hostname: string, sans: string[]): string {
  return [
    "[req]",
    "distinguished_name = dn",
    "prompt = no",
    "utf8 = yes",
    "string_mask = utf8only",
    "[dn]",
    `CN = ${hostname}`,
    "O = sessionpipe-gui",
    "[v3_server]",
    "basicConstraints = critical, CA:FALSE",
    "keyUsage = critical, digitalSignature, keyEncipherment",
    "extendedKeyUsage = serverAuth",
    "subjectKeyIdentifier = hash",
    "authorityKeyIdentifier = keyid",
    `subjectAltName = ${sans.join(", ")}`,
    "",
  ].join("\n");
}

function makeCa(dir: string, p: ReturnType<typeof materialPaths>, hostname: string): void {
  const cnf = path.join(dir, "ca.cnf");
  secretWrite(cnf, caConfig(hostname));
  try {
    openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", p.caKeyPath], dir);
    chmodSync(p.caKeyPath, 0o600);
    openssl(
      [
        "req",
        "-x509",
        "-new",
        "-key",
        p.caKeyPath,
        "-config",
        cnf,
        "-extensions",
        "v3_ca",
        "-days",
        String(CA_DAYS),
        "-sha256",
        "-out",
        p.caCertPath,
      ],
      dir,
    );
    chmodSync(p.caCertPath, 0o600);
  } finally {
    rmSync(cnf, { force: true });
  }
}

function makeServer(dir: string, p: ReturnType<typeof materialPaths>, hostname: string, sans: string[]): void {
  const cnf = path.join(dir, "server.cnf");
  const csr = path.join(dir, "server.csr");
  const serial = path.join(dir, "ca.srl");
  secretWrite(cnf, serverConfig(hostname, sans));
  try {
    openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", p.serverKeyPath], dir);
    chmodSync(p.serverKeyPath, 0o600);
    openssl(["req", "-new", "-key", p.serverKeyPath, "-config", cnf, "-out", csr], dir);
    openssl(
      [
        "x509",
        "-req",
        "-in",
        csr,
        "-CA",
        p.caCertPath,
        "-CAkey",
        p.caKeyPath,
        "-CAcreateserial",
        "-CAserial",
        serial,
        "-days",
        String(SERVER_DAYS),
        "-sha256",
        "-extfile",
        cnf,
        "-extensions",
        "v3_server",
        "-out",
        p.serverCertPath,
      ],
      dir,
    );
    chmodSync(p.serverCertPath, 0o600);
  } finally {
    for (const f of [cnf, csr, serial]) rmSync(f, { force: true });
  }
}

/** Delete every file TLS mode made; the next `--tls` start makes them again (and the
 *  phones have to trust the new CA). */
export function resetCerts(dir: string): boolean {
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** The CA as a download for a phone: the PEM with a stable name. */
export function caDownloadName(hostname: string): string {
  return `sessionpipe-gui-${hostname.replace(/\.local$/, "")}.crt`;
}

/** sha256 of arbitrary bytes, `AB:CD:…` (tests compare the download with the file). */
export function sha256Colon(buf: Buffer): string {
  return (createHash("sha256").update(buf).digest("hex").toUpperCase().match(/../g) ?? []).join(":");
}
