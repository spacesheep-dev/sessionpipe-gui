// SPDX-License-Identifier: Apache-2.0
// The new-session sheet's folder list (folders.ts): `~` from the hello's home, the
// daemon's segment rule for "under", the order and the dedupe of recent folders.
import { describe, expect, it } from "vitest";
import { expandHome, folderChoices, machineHome, normalizePath, tildify, typedFolder, under } from "./folders";

const HOME = "/Users/demo";

describe("expandHome and tildify", () => {
  it("expands ~ and ~/ with home, keeps absolute paths, refuses the rest", () => {
    expect(expandHome("~/acme/web", HOME)).toBe("/Users/demo/acme/web");
    expect(expandHome("~", HOME)).toBe("/Users/demo");
    expect(expandHome("/srv/app/", HOME)).toBe("/srv/app");
    expect(expandHome("~/acme", null)).toBeNull();
    expect(expandHome("acme/web", HOME)).toBeNull();
    expect(expandHome("~other/x", HOME)).toBeNull();
  });
  it("shows anything under home with ~", () => {
    expect(tildify("/Users/demo/acme/web", HOME)).toBe("~/acme/web");
    expect(tildify("/Users/demo", HOME)).toBe("~");
    expect(tildify("/Users/demox/a", HOME)).toBe("/Users/demox/a");
    expect(tildify("/srv/app", undefined)).toBe("/srv/app");
  });
  it("normalizes slashes", () => {
    expect(normalizePath("/a//b/")).toBe("/a/b");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("C:\\\\work\\\\")).toBe("C:\\work");
  });
});

describe("under: whole path segments", () => {
  it("allows the root and what is inside it, never a sibling that shares a prefix", () => {
    expect(under("/a/web", "/a/web")).toBe(true);
    expect(under("/a/web", "/a/web/app")).toBe(true);
    expect(under("/a/web/", "/a/web/app/")).toBe(true);
    expect(under("/a/web", "/a/webx")).toBe(false);
    expect(under("/a/web", "/a")).toBe(false);
    expect(under("/", "/anything")).toBe(true);
  });
});

describe("folderChoices", () => {
  const s = (cwd: string, lastAt: string, machine = "studio-mac", repo?: string) => ({ cwd, lastAt, machine, repo });
  it("recent first, newest first, deduped, at most 8, only under an allowed root; then the roots", () => {
    const sessions = [
      s("~/acme/web", "2026-10-23T10:00:00Z", "studio-mac", "github.com/acme/web"),
      s("~/acme/api", "2026-10-23T11:00:00Z", "studio-mac", "github.com/acme/api"),
      s("~/acme/web", "2026-10-23T09:00:00Z"),
      s("~/acme/webx", "2026-10-23T12:00:00Z"),
      s("~/elsewhere", "2026-10-23T12:30:00Z"),
      s("~/acme/web", "2026-10-23T13:00:00Z", "build-box"),
    ];
    const c = folderChoices({
      sessions,
      machine: "studio-mac",
      folders: ["/Users/demo/acme/web", "/Users/demo/acme/api", "/Users/demo/acme/infra"],
      home: HOME,
    });
    expect(c.recent).toEqual([
      { path: "/Users/demo/acme/api", display: "~/acme/api", repo: "acme/api" },
      { path: "/Users/demo/acme/web", display: "~/acme/web", repo: "acme/web" },
    ]);
    expect(c.allowed).toEqual([{ path: "/Users/demo/acme/infra", display: "~/acme/infra" }]);
  });
  it("skips ~ folders when the machine sent no home", () => {
    const c = folderChoices({
      sessions: [s("~/acme/web", "2026-10-23T10:00:00Z"), s("/srv/app", "2026-10-23T09:00:00Z")],
      machine: "studio-mac",
      folders: null,
    });
    expect(c.recent.map((x) => x.path)).toEqual(["/srv/app"]);
  });
  it("keeps eight", () => {
    const many = Array.from({ length: 12 }, (_, i) => s(`/w/p${i}`, `2026-10-23T10:${String(i).padStart(2, "0")}:00Z`));
    const c = folderChoices({ sessions: many, machine: "studio-mac", folders: ["/w"] });
    expect(c.recent).toHaveLength(8);
    expect(c.recent[0]!.path).toBe("/w/p11");
  });
});

describe("typedFolder", () => {
  const o = { folders: ["/Users/demo/acme/web"], home: HOME, machine: "studio-mac" };
  it("accepts a path inside a root, absolute or with ~", () => {
    expect(typedFolder("~/acme/web/app", o)).toEqual({ ok: true, path: "/Users/demo/acme/web/app" });
    expect(typedFolder("/Users/demo/acme/web", o)).toEqual({ ok: true, path: "/Users/demo/acme/web" });
  });
  it("refuses one outside, a sibling, a relative one, .. and ~ without home", () => {
    expect(typedFolder("/Users/demo/acme/webx", o)).toMatchObject({
      ok: false,
      reason: "studio-mac doesn't allow that folder",
    });
    expect(typedFolder("acme/web", o).ok).toBe(false);
    expect(typedFolder("/Users/demo/acme/web/../api", o).ok).toBe(false);
    expect(typedFolder("~/acme/web", { ...o, home: null }).ok).toBe(false);
    expect(typedFolder("", o)).toMatchObject({ ok: false, reason: "Choose a folder" });
  });
  it("takes any absolute path when the machine listed no folders", () => {
    expect(typedFolder("/srv/app", { machine: "old-box" })).toEqual({ ok: true, path: "/srv/app" });
  });
});

describe("a machine that expands ~/… itself (sessionpipe 0.10: no home folder in the hello)", () => {
  const home = machineHome({ tilde: true });
  it("is `~`, and nothing for a machine that doesn't", () => {
    expect(home).toBe("~");
    expect(machineHome({})).toBeUndefined();
    expect(machineHome(undefined)).toBeUndefined();
  });
  it("keeps a ~/ folder as it is, and leaves the allowed-folder check to the machine", () => {
    expect(expandHome("~/acme//web/", home)).toBe("~/acme/web");
    expect(tildify("~/acme/web", home)).toBe("~/acme/web");
    expect(tildify("/srv/app", home)).toBe("/srv/app");
    const o = { folders: ["/Users/demo/acme"], home, machine: "studio-mac" };
    expect(typedFolder("~/acme/web", o)).toEqual({ ok: true, path: "~/acme/web" });
    expect(typedFolder("/srv/app", o).ok).toBe(false);
    expect(typedFolder("~/acme/../x", o).ok).toBe(false);
    // A ~/ allowed folder and a ~/ path compare by segments as any two do.
    expect(typedFolder("~/elsewhere", { ...o, folders: ["~/acme"] }).ok).toBe(false);
    const c = folderChoices({
      sessions: [{ machine: "studio-mac", cwd: "~/acme/web", lastAt: "2026-10-23T10:00:00Z" }],
      machine: "studio-mac",
      folders: ["/Users/demo/acme"],
      home,
    });
    expect(c.recent).toEqual([{ path: "~/acme/web", display: "~/acme/web" }]);
  });
  it("without it a ~/ path asks for the full one", () => {
    expect(typedFolder("~/acme", { machine: "studio-mac" })).toMatchObject({
      ok: false,
      reason: "studio-mac needs the full path; type it starting with /",
    });
  });
});
