// SPDX-License-Identifier: Apache-2.0
// The phone's first run (NATIVE-SPEC §3.9, the phone's side of /phone): the app found no
// receiver, so it walks the person from the welcome to a board in as few screens as it
// can. Every decision is here, apart from the React (PhoneOnboarding.tsx) and the shell
// (scanner.ts, bridge.ts): the step machine, the reading of what the camera saw or the
// person typed, the words, and the failure lines. Tested on its own (onboarding.test.ts).
import { isCancel } from "./logic";

// ----- the words, in one place -----

/** The phone, as the sheet names it ("this iPhone", "this phone"). */
export type Phone = "ios" | "android";
export const phoneNoun = (p: Phone | null): string => (p === "android" ? "this phone" : "this iPhone");

export const WORDS = {
  name: "sessionpipe",
  lede: "Every coding agent you run, on one board.",
  scan: "Scan the code on your computer",
  address: "Enter an address",
  addressInstead: "Enter the address instead",
  demo: "Try the demo",
  noServer: "No sessionpipe on your computer yet?",
  install: {
    title: "Three steps on your computer",
    steps: [
      { label: "Install sessionpipe there", caption: "In a terminal, or from sessionpipe.org/gui." },
      { label: "Open Connect", caption: "It shows a code for this phone." },
      { label: "Come back here and scan it", caption: "The board opens on this phone." },
    ],
    site: "https://sessionpipe.org/gui",
    done: "Done",
  },
  scanning: {
    caption: "On your computer, open sessionpipe → Connect and point the camera at the code",
    cancel: "Cancel",
  },
  denied: {
    title: "sessionpipe can't use the camera",
    body: "Turn it on in Settings to scan the code on your computer.",
    settings: "Open Settings",
  },
  badCode: {
    title: "That code isn't from sessionpipe",
    again: "Scan again",
  },
  noCamera: {
    title: "The camera isn't available",
  },
  trust: {
    title: (host: string) => `${host} uses a certificate of its own`,
    body: "Trust it once on this phone, then connect. The trust page opens in Safari.",
    bodyAndroid: "Trust it once on this phone, then connect. The trust page opens in your browser.",
    open: "Open the trust page",
    connect: "Connect",
  },
  connecting: (host: string) => `Connecting to ${host}…`,
  failed: {
    title: (host: string) => `Couldn't reach ${host}`,
    unreachable: "Make sure the phone and the computer are on the same Wi-Fi, or both on your tailnet.",
    retry: "Try again",
  },
  addressStep: {
    title: "Your computer's address",
    caption: "It's under Connect in sessionpipe on your computer.",
    placeholder: "studio-mac.local:7373",
    connect: "Connect",
    notOne: "That isn't an address. Try studio-mac.local:7373, or the link under Connect.",
  },
  back: "Back",
  connected: {
    title: "You're in.",
    body: (phone: Phone | null, computer: string) =>
      `To answer prompts from ${phoneNoun(phone)}, approve it once on ${computer}: Machines → Devices → Approve ${phoneNoun(phone)}.`,
    bodyNoSigner: "Reading works now. Sending from the app comes with a build that signs.",
    notify: "Notify me when a session needs me",
    askNow: "Ask now",
    later: "Later",
  },
} as const;

// ----- reading a code or a typed address -----

export type PayloadRefusal = "empty" | "not-sessionpipe";

export type Payload =
  /** `trust`: the TLS form of the code, `https://host:port/trust?k=…` (the receiver can't
   *  be reached until the phone trusts the certificate that page installs). */
  { ok: true; url: string; host: string; trust: boolean } | { ok: false; reason: PayloadRefusal; message: string };

const REFUSALS: Record<PayloadRefusal, string> = {
  empty: WORDS.addressStep.notOne,
  "not-sessionpipe": "Only the code under Connect in sessionpipe opens the board here.",
};

const refuse = (reason: PayloadRefusal): Payload => ({ ok: false, reason, message: REFUSALS[reason] });

/** The computer's name from its address: the hostname without `.local`, or the IP. */
export function hostLabel(url: string): string {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h.replace(/\.local$/i, "") || url;
  } catch {
    return url;
  }
}

/** What the camera saw, or what the person typed, as `rx_add` takes it (handed over as it
 *  is). A receiver link is `http(s)://host[:port]/?k=…` (the Connect page's code, its `?k=`
 *  kept: it is the UI key the shell holds), or its TLS form `https://host:port/trust?k=…`,
 *  read as `trust`; a typed address may be a bare `host[:port]`, `.local` names included.
 *  Anything else (a Wi-Fi code, a word, another scheme, a deep path) is refused. A scanned
 *  code must spell its scheme: a bare word in a QR is not an address. */
export function parsePayload(raw: string, opts: { scanned?: boolean } = {}): Payload {
  let s = raw.trim();
  if (!s) return refuse("empty");
  if (/\s/.test(s)) return refuse(opts.scanned ? "not-sessionpipe" : "empty");
  const schemed = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  if (!schemed) {
    // Another scheme without slashes (mailto:, otpauth:, a Wi-Fi code); a host's `:port` is not one.
    if (opts.scanned || /^[a-z][a-z0-9+.-]*:(?![0-9])/i.test(s))
      return refuse(opts.scanned ? "not-sessionpipe" : "empty");
    s = `http://${s}`;
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return refuse(opts.scanned ? "not-sessionpipe" : "empty");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return refuse(opts.scanned ? "not-sessionpipe" : "empty");
  if (!u.hostname) return refuse(opts.scanned ? "not-sessionpipe" : "empty");
  const trust = /^\/trust\/?$/.test(u.pathname);
  if (!trust && u.pathname !== "/" && u.pathname !== "") return refuse(opts.scanned ? "not-sessionpipe" : "empty");
  u.hash = "";
  return { ok: true, url: u.href, host: hostLabel(u.href), trust };
}

// ----- the steps -----

export type CameraStanding = "granted" | "denied" | "prompt";

export type Step =
  | { kind: "welcome"; help: boolean }
  /** The camera is being asked for (the system alert), then running. */
  | { kind: "scan"; status: "asking" | "scanning" }
  | { kind: "denied" }
  /** The scan itself failed (no camera on this device, the plugin's words kept). */
  | { kind: "no-camera"; message: string }
  | { kind: "bad-code"; message: string }
  /** The TLS form of the code: the trust page first, then Connect. */
  | { kind: "trust"; url: string; host: string }
  | { kind: "address"; value: string; error: string | null }
  | { kind: "connecting"; url: string; host: string; from: "scan" | "address" }
  | { kind: "failed"; url: string; host: string; message: string; from: "scan" | "address" }
  /** `rx_select` went through: the shell is replacing this window. */
  | { kind: "done"; host: string };

export type Event =
  | { type: "help"; open: boolean }
  | { type: "scan" }
  | { type: "camera"; standing: CameraStanding }
  /** The scan ended: the code's text, or null when cancelled. */
  | { type: "scanned"; text: string | null }
  /** The scan threw (scanner.ts: no camera, not granted, a scan over a scan). */
  | { type: "scan-failed"; error: unknown }
  | { type: "address" }
  | { type: "typed"; value: string }
  | { type: "connect" }
  | { type: "connected" }
  | { type: "error"; error: unknown }
  | { type: "retry" }
  | { type: "back" };

export const INITIAL: Step = { kind: "welcome", help: false };

const text = (e: unknown): string =>
  e instanceof Error
    ? e.message
    : typeof e === "string"
      ? e
      : e && typeof e === "object" && "message" in e
        ? String((e as { message: unknown }).message)
        : "";

/** A connection that never got through (a refused port, a name that didn't resolve, a
 *  timeout): the shell's words for it vary, the person's next step doesn't. */
export const isUnreachable = (e: unknown): boolean =>
  /\b(unreachable|connection refused|timed? ?out|timeout|no route|not resolve|failed to lookup|dns|network|offline|connect(ion)? (failed|error|reset)|failed to connect|could ?n.t connect|host not found|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH)\b/i.test(
    text(e),
  );

/** The failure, in plain words. */
export function failureWords(e: unknown): string {
  if (isUnreachable(e)) return WORDS.failed.unreachable;
  const t = text(e).trim();
  return t || WORDS.failed.unreachable;
}

export function step(prev: Step, ev: Event): Step {
  switch (ev.type) {
    case "help":
      return prev.kind === "welcome" ? { kind: "welcome", help: ev.open } : prev;
    case "scan":
      // From the welcome, a bad code, a refusal or a failure: the camera again.
      if (prev.kind === "connecting" || prev.kind === "done") return prev;
      return { kind: "scan", status: "asking" };
    case "camera":
      if (prev.kind !== "scan") return prev;
      if (ev.standing === "granted") return { kind: "scan", status: "scanning" };
      if (ev.standing === "denied") return { kind: "denied" };
      // The alert was dismissed without an answer: back where they were.
      return INITIAL;
    case "scanned": {
      if (prev.kind !== "scan") return prev;
      if (ev.text === null) return INITIAL;
      const p = parsePayload(ev.text, { scanned: true });
      if (!p.ok) return { kind: "bad-code", message: p.message };
      if (p.trust) return { kind: "trust", url: p.url, host: p.host };
      return { kind: "connecting", url: p.url, host: p.host, from: "scan" };
    }
    case "scan-failed":
      return prev.kind === "scan" ? { kind: "no-camera", message: text(ev.error) || WORDS.noCamera.title } : prev;
    case "address":
      if (prev.kind === "connecting" || prev.kind === "done") return prev;
      if (prev.kind === "address") return prev;
      return { kind: "address", value: prev.kind === "failed" && prev.from === "address" ? prev.url : "", error: null };
    case "typed":
      return prev.kind === "address" ? { kind: "address", value: ev.value, error: null } : prev;
    case "connect": {
      if (prev.kind === "trust") return { kind: "connecting", url: prev.url, host: prev.host, from: "scan" };
      if (prev.kind !== "address") return prev;
      const p = parsePayload(prev.value);
      return p.ok
        ? { kind: "connecting", url: p.url, host: p.host, from: "address" }
        : { kind: "address", value: prev.value, error: p.message };
    }
    case "connected":
      return prev.kind === "connecting" ? { kind: "done", host: prev.host } : prev;
    case "error": {
      if (prev.kind !== "connecting") return prev;
      // Cancel in the shell's own sheet: not a failure, back where the address came from.
      if (isCancel(ev.error))
        return prev.from === "address" ? { kind: "address", value: prev.url, error: null } : INITIAL;
      return { kind: "failed", url: prev.url, host: prev.host, message: failureWords(ev.error), from: prev.from };
    }
    case "retry":
      return prev.kind === "failed" ? { kind: "connecting", url: prev.url, host: prev.host, from: prev.from } : prev;
    case "back":
      if (prev.kind === "connecting" || prev.kind === "done") return prev;
      return INITIAL;
  }
}

/** Whether a step shows the camera through the page (the viewfinder is drawn over it). */
export const isScanning = (s: Step): boolean => s.kind === "scan" && s.status === "scanning";
