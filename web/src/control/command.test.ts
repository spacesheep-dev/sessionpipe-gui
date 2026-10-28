// SPDX-License-Identifier: Apache-2.0
// The command string a page signs (command.ts): fields in the spec's order, no field a kind
// does not own, the pool's on its own pseudo-session.
import { POOL_SESSION } from "@shared/api";
import { describe, expect, it } from "vitest";
import { commandString } from "./command";

const M = "m_testmachine0000000001";

describe("commandString for a pool command", () => {
  it("names the pool's session and carries only the action's fields", () => {
    const on = JSON.parse(commandString(M, { kind: "pool", action: "on" }));
    expect(Object.keys(on)).toEqual(["v", "t", "machine", "kind", "session", "pool_action", "nonce", "iat"]);
    expect(on).toMatchObject({
      v: 1,
      t: "sessionpipe.control",
      machine: M,
      kind: "pool",
      session: POOL_SESSION,
      pool_action: "on",
    });
    expect(on.nonce).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    const order = JSON.parse(commandString(M, { kind: "pool", action: "order", order: ["b", "a"] }));
    expect(order).toMatchObject({ pool_action: "order", pool_order: ["b", "a"] });
    expect(order.pool_account).toBeUndefined();
    const done = JSON.parse(
      commandString(M, { kind: "pool", action: "login.complete", account: "login_1", code: "abc#state" }),
    );
    expect(done).toMatchObject({ pool_action: "login.complete", pool_account: "login_1", pool_code: "abc#state" });
    const off = JSON.parse(commandString(M, { kind: "pool", action: "off", account: "", code: "" }));
    expect(Object.keys(off)).not.toEqual(expect.arrayContaining(["pool_account", "pool_code"]));
  });
});
