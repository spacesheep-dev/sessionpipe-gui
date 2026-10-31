// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  type Event,
  failureWords,
  hostLabel,
  INITIAL,
  isScanning,
  isUnreachable,
  parsePayload,
  phoneNoun,
  type Step,
  step,
  trustBrowser,
  WORDS,
} from "./onboarding";

const run = (events: Event[], from: Step = INITIAL): Step => events.reduce(step, from);

describe("parsePayload: the code the camera saw, or what the person typed", () => {
  it("takes the Connect page's code, its key kept", () => {
    const p = parsePayload("http://10.0.0.128:7397/?k=uik_abc123");
    expect(p).toEqual({ ok: true, url: "http://10.0.0.128:7397/?k=uik_abc123", host: "10.0.0.128", trust: false });
  });
  it("takes https, a port or none, a .local name, and reads the computer's name from it", () => {
    expect(parsePayload("https://studio-mac.local:7397/?k=uik_x")).toMatchObject({ ok: true, host: "studio-mac" });
    expect(parsePayload("https://studio-mac.tailnet-abc.ts.net/?k=uik_x")).toMatchObject({
      ok: true,
      url: "https://studio-mac.tailnet-abc.ts.net/?k=uik_x",
      host: "studio-mac.tailnet-abc.ts.net",
    });
    expect(parsePayload("http://studio-mac.local:7373")).toMatchObject({
      ok: true,
      url: "http://studio-mac.local:7373/",
    });
  });
  it("takes a bare host:port when typed, with .local and all, and drops a fragment", () => {
    expect(parsePayload("studio-mac.local:7373")).toEqual({
      ok: true,
      url: "http://studio-mac.local:7373/",
      host: "studio-mac",
      trust: false,
    });
    expect(parsePayload("  192.168.1.20:7373  ")).toMatchObject({ ok: true, url: "http://192.168.1.20:7373/" });
    expect(parsePayload("studio-mac")).toMatchObject({ ok: true, url: "http://studio-mac/" });
    expect(parsePayload("http://studio-mac.local:7373/#x")).toMatchObject({
      ok: true,
      url: "http://studio-mac.local:7373/",
    });
  });
  it("reads the TLS form of the code, the /trust link, as one to trust first", () => {
    expect(parsePayload("https://studio-mac.local:7373/trust?k=uik_abc")).toEqual({
      ok: true,
      url: "https://studio-mac.local:7373/trust?k=uik_abc",
      host: "studio-mac",
      trust: true,
    });
    expect(parsePayload("https://10.0.0.128:7397/trust/", { scanned: true })).toMatchObject({ ok: true, trust: true });
  });
  it("refuses what is not a receiver link", () => {
    for (const raw of ["", "   ", "mailto:x@example.com", "WIFI:S:home;T:WPA;P:pw;;", "http://", "otpauth://totp/x"])
      expect(parsePayload(raw).ok).toBe(false);
    expect(parsePayload("").ok).toBe(false);
    expect(parsePayload("ftp://studio-mac.local/")).toMatchObject({ ok: false });
    expect(parsePayload("http://10.0.0.128:7397/inbox")).toMatchObject({ ok: false });
  });
  it("a scanned code must spell its scheme: a word, a Wi-Fi code or an otpauth link isn't from sessionpipe", () => {
    for (const raw of [
      "hello",
      "studio-mac.local:7373",
      "WIFI:S:home;T:WPA;P:pw;;",
      "otpauth://totp/x?secret=y",
      "a b",
    ])
      expect(parsePayload(raw, { scanned: true })).toMatchObject({ ok: false, reason: "not-sessionpipe" });
    expect(parsePayload("http://10.0.0.128:7397/?k=uik_abc", { scanned: true }).ok).toBe(true);
  });
  it("hostLabel", () => {
    expect(hostLabel("http://studio-mac.local:7373/")).toBe("studio-mac");
    expect(hostLabel("https://[fe80::1]:7373/")).toBe("fe80::1");
    expect(hostLabel("nonsense")).toBe("nonsense");
  });
});

describe("the steps", () => {
  it("starts on the welcome; the help card opens and closes there only", () => {
    expect(INITIAL).toEqual({ kind: "welcome", help: false });
    expect(run([{ type: "help", open: true }])).toEqual({ kind: "welcome", help: true });
    expect(
      run([
        { type: "help", open: true },
        { type: "help", open: false },
      ]),
    ).toEqual(INITIAL);
    expect(run([{ type: "address" }, { type: "help", open: true }]).kind).toBe("address");
  });

  it("Scan asks for the camera, then scans; a refusal is its own screen; a dismissed alert goes back", () => {
    const asking = run([{ type: "scan" }]);
    expect(asking).toEqual({ kind: "scan", status: "asking" });
    expect(isScanning(asking)).toBe(false);
    const scanning = step(asking, { type: "camera", standing: "granted" });
    expect(scanning).toEqual({ kind: "scan", status: "scanning" });
    expect(isScanning(scanning)).toBe(true);
    expect(step(asking, { type: "camera", standing: "denied" })).toEqual({ kind: "denied" });
    expect(step(asking, { type: "camera", standing: "prompt" })).toEqual(INITIAL);
    // The camera's word means nothing outside the scan.
    expect(step(INITIAL, { type: "camera", standing: "granted" })).toEqual(INITIAL);
  });

  it("a good code connects, with the computer's name; a cancelled scan goes back to the welcome", () => {
    const scanning: Step = { kind: "scan", status: "scanning" };
    expect(step(scanning, { type: "scanned", text: "http://studio-mac.local:7397/?k=uik_abc" })).toEqual({
      kind: "connecting",
      url: "http://studio-mac.local:7397/?k=uik_abc",
      host: "studio-mac",
      from: "scan",
    });
    expect(step(scanning, { type: "scanned", text: null })).toEqual(INITIAL);
    expect(step(INITIAL, { type: "scanned", text: "http://x/?k=1" })).toEqual(INITIAL);
  });

  it("a code that isn't from sessionpipe says so, and Scan again scans again", () => {
    const scanning: Step = { kind: "scan", status: "scanning" };
    const bad = step(scanning, { type: "scanned", text: "WIFI:S:home;;" });
    expect(bad.kind).toBe("bad-code");
    expect(step(bad, { type: "scan" })).toEqual({ kind: "scan", status: "asking" });
    expect(step(bad, { type: "address" })).toEqual({ kind: "address", value: "", error: null });
    expect(step(bad, { type: "back" })).toEqual(INITIAL);
  });

  it("the TLS code: the trust page first, then Connect goes on to the receiver", () => {
    const scanning: Step = { kind: "scan", status: "scanning" };
    const t = step(scanning, { type: "scanned", text: "https://studio-mac.local:7373/trust?k=uik_abc" });
    expect(t).toEqual({
      kind: "trust",
      url: "https://studio-mac.local:7373/trust?k=uik_abc",
      host: "studio-mac",
      opened: false,
    });
    // The second beat: the app came back from the browser.
    const back = step(t, { type: "returned" });
    expect(back).toEqual({ ...t, opened: true });
    expect(step(back, { type: "returned" })).toEqual(back);
    expect(step(INITIAL, { type: "returned" })).toEqual(INITIAL);
    expect(step({ kind: "denied" }, { type: "returned" })).toEqual({ kind: "denied" });
    expect(step(back, { type: "connect" })).toEqual({
      kind: "connecting",
      url: "https://studio-mac.local:7373/trust?k=uik_abc",
      host: "studio-mac",
      from: "scan",
    });
    expect(step(t, { type: "back" })).toEqual(INITIAL);
    expect(step(t, { type: "scan" })).toEqual({ kind: "scan", status: "asking" });
  });

  it("a scan that fails (no camera, not granted) is its own plain screen, the address its way out", () => {
    const scanning: Step = { kind: "scan", status: "scanning" };
    const failed = step(scanning, { type: "scan-failed", error: new Error("No camera available on this device") });
    expect(failed).toEqual({ kind: "no-camera", message: "No camera available on this device" });
    expect(step(scanning, { type: "scan-failed", error: {} })).toEqual({
      kind: "no-camera",
      message: WORDS.noCamera.title,
    });
    expect(step(failed, { type: "address" })).toEqual({ kind: "address", value: "", error: null });
    expect(step(failed, { type: "back" })).toEqual(INITIAL);
    expect(step(INITIAL, { type: "scan-failed", error: new Error("x") })).toEqual(INITIAL);
  });

  it("the refused camera offers Settings or the address", () => {
    const denied: Step = { kind: "denied" };
    expect(step(denied, { type: "address" })).toEqual({ kind: "address", value: "", error: null });
    expect(step(denied, { type: "scan" })).toEqual({ kind: "scan", status: "asking" });
    expect(step(denied, { type: "back" })).toEqual(INITIAL);
  });

  it("the address step: typing clears the error, Connect reads it or says why not", () => {
    let s = run([{ type: "address" }]);
    expect(s).toEqual({ kind: "address", value: "", error: null });
    s = step(s, { type: "connect" });
    expect(s).toMatchObject({ kind: "address", error: WORDS.addressStep.notOne });
    s = step(s, { type: "typed", value: "studio-mac.local:7373" });
    expect(s).toEqual({ kind: "address", value: "studio-mac.local:7373", error: null });
    s = step(s, { type: "connect" });
    expect(s).toEqual({
      kind: "connecting",
      url: "http://studio-mac.local:7373/",
      host: "studio-mac",
      from: "address",
    });
    // Typing outside the step changes nothing.
    expect(step(INITIAL, { type: "typed", value: "x" })).toEqual(INITIAL);
    // Asking for the step while in it keeps what was typed.
    const typed: Step = { kind: "address", value: "abc", error: null };
    expect(step(typed, { type: "address" })).toBe(typed);
  });

  it("connecting: the shell's answer ends it, its refusal is said in plain words, Cancel is not an error", () => {
    const c: Step = { kind: "connecting", url: "http://studio-mac.local:7373/", host: "studio-mac", from: "scan" };
    expect(step(c, { type: "connected" })).toEqual({ kind: "done", host: "studio-mac" });
    const failed = step(c, { type: "error", error: new Error("connection refused (os error 61)") });
    expect(failed).toEqual({ ...c, kind: "failed", message: WORDS.failed.unreachable("studio-mac") });
    expect(step(c, { type: "error", error: new Error("That key was refused.") })).toMatchObject({
      kind: "failed",
      message: "That key was refused.",
    });
    expect(step(c, { type: "error", error: { message: "" } })).toMatchObject({
      message: WORDS.failed.unreachable("studio-mac"),
    });
    // Cancel in the shell's own sheet: back where the address came from.
    expect(step(c, { type: "error", error: new Error("cancelled") })).toEqual(INITIAL);
    expect(step({ ...c, from: "address" }, { type: "error", error: "cancelled" })).toEqual({
      kind: "address",
      value: "http://studio-mac.local:7373/",
      error: null,
    });
    // Nothing interrupts a connection in flight.
    for (const ev of [{ type: "back" }, { type: "scan" }, { type: "address" }] as Event[]) expect(step(c, ev)).toBe(c);
    expect(step(c, { type: "retry" })).toBe(c);
  });

  it("a failure offers Try again (the same address) and, after a scan, the address", () => {
    const f: Step = {
      kind: "failed",
      url: "http://studio-mac.local:7373/",
      host: "studio-mac",
      message: WORDS.failed.unreachable("studio-mac"),
      from: "address",
    };
    expect(step(f, { type: "retry" })).toEqual({
      kind: "connecting",
      url: f.url,
      host: "studio-mac",
      from: "address",
    });
    // Back to the address step with the address still in the field.
    expect(step(f, { type: "address" })).toEqual({ kind: "address", value: f.url, error: null });
    expect(step({ ...f, from: "scan" }, { type: "address" })).toEqual({ kind: "address", value: "", error: null });
    expect(step(f, { type: "back" })).toEqual(INITIAL);
    expect(step(f, { type: "scan" })).toEqual({ kind: "scan", status: "asking" });
  });

  it("done is final", () => {
    const d: Step = { kind: "done", host: "studio-mac" };
    for (const ev of [{ type: "back" }, { type: "scan" }, { type: "address" }, { type: "connected" }] as Event[])
      expect(step(d, ev)).toBe(d);
  });
});

describe("the words", () => {
  it("knows an unreachable computer by any of the shell's phrasings", () => {
    for (const m of [
      "connection refused",
      "Connection timed out",
      "failed to connect to studio-mac.local",
      "dns error: failed to lookup address",
      "ECONNREFUSED 10.0.0.128:7397",
      "No route to host",
      "the network is unreachable",
    ])
      expect(isUnreachable(new Error(m)), m).toBe(true);
    expect(isUnreachable(new Error("That key was refused."))).toBe(false);
    expect(failureWords(new Error("connection refused"), "studio-mac")).toBe(
      "Check that sessionpipe is running on studio-mac and that both are on the same Wi-Fi (or the same tailnet).",
    );
    expect(failureWords(undefined, "studio-mac")).toBe(WORDS.failed.unreachable("studio-mac"));
    expect(failureWords(new Error("That key was refused."), "studio-mac")).toBe("That key was refused.");
  });
  it("names the phone and the computer in the connected sheet", () => {
    expect(phoneNoun("ios")).toBe("this iPhone");
    expect(phoneNoun("android")).toBe("this phone");
    expect(WORDS.connected.body("ios", "studio-mac")).toBe(
      "Reading works now. To answer prompts from this iPhone, studio-mac has to approve it once.",
    );
    expect(WORDS.connected.where("studio-mac")).toBe("On studio-mac: Machines › studio-mac › Devices › Approve.");
    expect(WORDS.connected.ask("studio-mac")).toBe("Ask studio-mac to approve");
    expect(trustBrowser("ios")).toBe("Safari");
    expect(trustBrowser("android")).toBe("your browser");
    expect(WORDS.trust.body("studio-mac", trustBrowser("android"))).toBe(
      "Your browser opens a page that installs studio-mac's certificate. Follow it, then come back here.",
    );
    expect(WORDS.trust.open("Safari")).toBe("Open in Safari");
    expect(WORDS.trust.title("studio-mac")).toBe("Trust studio-mac on this phone");
    expect(WORDS.connecting("studio-mac")).toBe("Connecting to studio-mac…");
    expect(WORDS.failed.title("studio-mac")).toBe("Couldn't reach studio-mac");
  });
});
