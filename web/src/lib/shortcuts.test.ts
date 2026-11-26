// SPDX-License-Identifier: Apache-2.0
// The board's answer keys: a and d are free there and stand before the Inbox's and the
// session's in the table, so the row under the board's cursor is asked first and a
// session open beside the board is never answered in its place.
import "../native/test-env";
import { describe, expect, it } from "vitest";
import { ACTIONS, conflictFor, hintFor } from "./shortcuts";

describe("board.allow and board.deny", () => {
  const at = (id: string) => ACTIONS.findIndex((a) => a.id === id);

  it("are the Inbox's keys and words, under Board", () => {
    for (const [id, key, verb] of [
      ["board.allow", "a", "Allow"],
      ["board.deny", "d", "Deny"],
    ] as const) {
      const action = ACTIONS[at(id)]!;
      expect(action).toMatchObject({ group: "Board", scope: "board", keys: [key] });
      expect(action.label).toBe(`${verb} the prompt under the cursor`);
      // What a menu shows beside the item (menu.css sets it in capitals).
      expect(hintFor(id)).toBe(key);
    }
  });

  it("clash with nothing live on the board", () => {
    expect(conflictFor("board.allow", "a")).toBeNull();
    expect(conflictFor("board.deny", "d")).toBeNull();
    // ⇧A stays Ask another agent's, on a session.
    expect(conflictFor("board.allow", "shift+a")).toBeNull();
  });

  it("are tried before the Inbox's and the session's, which share the keys", () => {
    for (const [mine, others] of [
      ["board.allow", ["inbox.allow", "session.allow"]],
      ["board.deny", ["inbox.deny", "session.deny"]],
    ] as const) {
      expect(at(mine)).toBeGreaterThanOrEqual(0);
      for (const other of others) expect(at(mine), `${mine} before ${other}`).toBeLessThan(at(other));
    }
  });
});

describe("Session tree actions", () => {
  it("registers the outliner chords under Session tree with no conflicts", () => {
    const ids = [
      "tree.moveIn",
      "tree.moveOut",
      "tree.pin",
      "tree.moveUnder",
      "tree.moveFolder",
      "tree.newFolder",
      "tree.unfoldAll",
      "tree.foldAll",
    ];
    for (const id of ids) {
      const a = ACTIONS.find((x) => x.id === id);
      expect(a, id).toBeDefined();
      expect(a?.group).toBe("Session tree");
      expect(a?.scope).toBe("lists");
      expect(conflictFor(id, a!.keys[0]!)).toBeNull();
    }
  });
});
