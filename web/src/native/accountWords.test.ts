// SPDX-License-Identifier: Apache-2.0
// A device not approved yet is said one way: one sentence and one way on, written once
// (accountWords.new.ts) and read by every place that says it. And the device is named
// one way too: "iPhone", "iPad" where the shell says so, "phone" on Android.
import "./test-env";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { deviceWords, setupLabel } from "../control/signer";
import { deviceNoun } from "../lib/device";
import { NEW_WORDS as N, SEND, START, ThisPhone, thisPhone } from "./accountWords";
import { phoneNoun } from "./onboarding";

const g = globalThis as Record<string, unknown>;
const shell = (platform: string, device?: string) => {
  g.sessionpipeShell = { platform, ...(device ? { device } : {}) };
};
afterEach(() => {
  delete g.sessionpipeShell;
});

describe("a device not approved yet", () => {
  it("is one sentence and one way on, the same object wherever it is said", () => {
    shell("ios");
    // Under the message box and under a prompt (SEND.long), New session and Ask another
    // agent (START): the one sentence, not a copy of it.
    expect(SEND.long.notYet).toBe(N.notApproved);
    expect(START.notApproved).toBe(N.notApproved);
    expect(N.notApproved(ThisPhone())).toBe("This iPhone can't send yet.");
    // The way on, wherever it is a button or a link.
    expect(setupLabel()).toBe(N.approveThis(thisPhone()));
    expect(setupLabel()).toBe("Approve this iPhone");
  });

  it("says no fifth way: the old wordings are gone from the words and every screen", () => {
    const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const OLD = [/can'?t answer yet/i, /isn'?t approved yet/i, /Approve \$\{phone\} to send/, /answerNotYet/];
    const files = (readdirSync(SRC, { recursive: true }) as string[]).filter(
      (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f),
    );
    expect(files).toContain(path.join("native", "accountWords.new.ts"));
    // The one name let through: the Mac's own sentence off an account (a browser's too),
    // unchanged there. Only its definition is skipped, so no account sentence can drift back.
    const OFF_ACCOUNT = /^ {2}offAccountNotYet: .*$/m;
    expect(N.offAccountNotYet("This Mac")).toBe("This Mac can't answer yet");
    const found = files.flatMap((f) => {
      const read = readFileSync(path.join(SRC, f), "utf8");
      const text = f === path.join("native", "accountWords.new.ts") ? read.replace(OFF_ACCOUNT, "") : read;
      return OLD.filter((re) => re.test(text)).map((re) => `${f}: ${re}`);
    });
    expect(found).toEqual([]);
  });
});

describe("the device's name", () => {
  it("is iPhone on an iPhone, iPad on an iPad, phone on Android", () => {
    shell("ios");
    expect([deviceNoun(), thisPhone(), ThisPhone(), phoneNoun("ios")]).toEqual([
      "iPhone",
      "this iPhone",
      "This iPhone",
      "this iPhone",
    ]);
    expect(deviceWords()).toMatchObject({ this: "this iPhone", its: "this iPhone's", app: "iPhone app" });
    shell("ios", "ipad");
    expect([deviceNoun(), thisPhone(), ThisPhone(), phoneNoun("ios")]).toEqual([
      "iPad",
      "this iPad",
      "This iPad",
      "this iPad",
    ]);
    expect(deviceWords()).toMatchObject({ this: "this iPad", its: "this iPad's", app: "iPad app" });
    expect(N.notApproved(ThisPhone())).toBe("This iPad can't send yet.");
    expect(setupLabel()).toBe("Approve this iPad");
    // Android keeps what it says, whatever a contract carries.
    shell("android", "ipad");
    expect([deviceNoun(), thisPhone(), phoneNoun("android")]).toEqual(["phone", "this phone", "this phone"]);
    expect(deviceWords()).toMatchObject({ this: "this phone", app: "Android app" });
    expect(setupLabel()).toBe("Approve this phone");
    // The Mac app and a browser: "this Mac", as the signer's words always read there.
    shell("macos");
    expect(thisPhone()).toBe("this Mac");
    delete g.sessionpipeShell;
    expect(deviceNoun()).toBe("Mac");
  });
});
