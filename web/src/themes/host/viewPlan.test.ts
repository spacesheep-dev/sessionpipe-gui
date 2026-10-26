// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { viewPlan } from "./viewPlan";

const canvas = { id: "canvas", url: "/themes/canvas/", bundled: true };
const mine = { id: "my-view", url: "/themes/my-view/" };

describe("viewPlan", () => {
  it("a browser loads every view from the receiver, as before", () => {
    expect(viewPlan(canvas, false, "http://127.0.0.1:7373")).toEqual({
      kind: "page",
      base: "http://127.0.0.1:7373/themes/canvas/",
    });
    expect(viewPlan(mine, false, "http://127.0.0.1:7373")).toEqual({
      kind: "page",
      base: "http://127.0.0.1:7373/themes/my-view/",
    });
  });
  it("the app runs only the views it ships, from its own origin", () => {
    expect(viewPlan(canvas, true, "tauri://localhost")).toEqual({
      kind: "page",
      base: "tauri://localhost/themes/canvas/",
    });
    expect(viewPlan({ ...canvas, id: "office", url: "/themes/office/" }, true, "tauri://localhost").kind).toBe("page");
  });
  it("an installed view opens in its own window, never in the app's origin", () => {
    expect(viewPlan(mine, true, "tauri://localhost")).toEqual({ kind: "window", path: "/views/my-view" });
    // A person's own install of a bundled id overrides it: not the app's code, so a window.
    expect(viewPlan({ ...canvas, bundled: false }, true, "tauri://localhost").kind).toBe("window");
    // A bundled view the app doesn't carry.
    expect(viewPlan({ id: "garden", url: "/themes/garden/", bundled: true }, true, "tauri://localhost").kind).toBe(
      "window",
    );
  });
});
