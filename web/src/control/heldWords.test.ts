// SPDX-License-Identifier: Apache-2.0
// The held notice's words: the receiver's reason as one sentence, and where no notice can
// confirm a hold, a refusal that says where one can.
import "../native/test-env";
import { describe, expect, it } from "vitest";
import { ControlError } from "./api";
import { HELD_WORDS, heldFrom, heldReason } from "./heldWords";
import { sendErrorWords } from "./words";

describe("held words", () => {
  it("the reason is the receiver's, as one sentence", () => {
    expect(heldReason("it reads like an instruction to delete files")).toBe(
      "It reads like an instruction to delete files.",
    );
    expect(heldReason("  It ends already.  ")).toBe("It ends already.");
    expect(heldReason("")).toBe(HELD_WORDS.noReason);
    expect(HELD_WORDS.confirm("your passkey")).toBe("Confirm with your passkey");
    expect(HELD_WORDS.confirm("Touch ID")).toBe("Confirm with Touch ID");
  });

  it("the reason is said to be the receiver's, and a confirm held again says so", () => {
    expect(HELD_WORDS.says(heldFrom("spacesheep.dev"), heldReason("it reads like a wipe"))).toBe(
      "spacesheep.dev says: “It reads like a wipe.”",
    );
    expect(HELD_WORDS.says(heldFrom(null), heldReason("are you sure?"))).toBe(
      "This computer's sessionpipe says: “Are you sure?”",
    );
    expect(HELD_WORDS.still(heldFrom("spacesheep.dev"))).toBe(
      "Still held. spacesheep.dev didn't take the confirmation.",
    );
  });

  it("a hold where no notice can confirm it says where one can", () => {
    expect(sendErrorWords(new ControlError(422, "held", "confirm_required"))).toBe(
      "not sent · held for you to confirm; send it from the session's page to confirm it",
    );
  });
});
