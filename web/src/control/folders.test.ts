// SPDX-License-Identifier: Apache-2.0
// The new-session sheet's folder list (folders.ts): `~` from the hello's home, the
// daemon's segment rule for "under", the order and the dedupe of recent folders.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  expandHome,
  FAV_FOLDERS_MAX,
  folderChoices,
  formatFolder,
  isFavoriteFolder,
  machineHome,
  normalizePath,
  readFavoriteFolders,
  tildify,
  toggleFavoriteFolder,
  typedFolder,
  under,
  unnamedHere,
} from "./folders";

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
  it("without it a ~/ folder can't be named here, which says nothing of the machine's folders", () => {
    // A session's own folder on a computer reached through spacesheep: the sheets start from
    // the machine's folders instead, and don't call it not allowed.
    expect(unnamedHere("~/notes", undefined)).toBe(true);
    expect(unnamedHere(" ~ ", null)).toBe(true);
    expect(unnamedHere("~/notes", home)).toBe(false);
    expect(unnamedHere("~/notes", HOME)).toBe(false);
    expect(unnamedHere("/Users/me/notes", undefined)).toBe(false);
    expect(unnamedHere("notes", undefined)).toBe(false);
    expect(unnamedHere("~notes", undefined)).toBe(false);
  });
});

describe("formatFolder", () => {
  it("splits long nested paths into basename, full parent, and middle-elided compactParent", () => {
    expect(formatFolder("~/.bb-machines/startrise.getbb.app/checkouts/sessionpipe")).toEqual({
      name: "sessionpipe",
      parent: "~/.bb-machines/startrise.getbb.app/checkouts",
      compactParent: "~/…/checkouts",
      full: "~/.bb-machines/startrise.getbb.app/checkouts/sessionpipe",
    });
    expect(formatFolder("/Users/alice/workspace/projects/acme/web")).toEqual({
      name: "web",
      parent: "/Users/alice/workspace/projects/acme",
      compactParent: "/…/projects/acme",
      full: "/Users/alice/workspace/projects/acme/web",
    });
  });
  it("keeps short parent paths verbatim and trims trailing slashes", () => {
    expect(formatFolder("~/acme/web/")).toEqual({
      name: "web",
      parent: "~/acme",
      compactParent: "~/acme",
      full: "~/acme/web",
    });
    expect(formatFolder("/srv/app///")).toEqual({
      name: "app",
      parent: "/srv",
      compactParent: "/srv",
      full: "/srv/app",
    });
    expect(formatFolder("/srv")).toEqual({
      name: "srv",
      parent: "/",
      compactParent: "/",
      full: "/srv",
    });
  });
  it("handles roots, Windows paths, and empty input cleanly", () => {
    expect(formatFolder("~")).toEqual({ name: "~", parent: "", compactParent: "", full: "~" });
    expect(formatFolder("~/")).toEqual({ name: "~", parent: "", compactParent: "", full: "~" });
    expect(formatFolder("/")).toEqual({ name: "/", parent: "", compactParent: "", full: "/" });
    expect(formatFolder("C:\\")).toEqual({ name: "C:\\", parent: "", compactParent: "", full: "C:\\" });
    expect(formatFolder("C:\\work")).toEqual({ name: "work", parent: "C:\\", compactParent: "C:\\", full: "C:\\work" });
    expect(formatFolder("C:\\Users\\alice\\very-long-workspace-folder\\checkouts\\app")).toEqual({
      name: "app",
      parent: "C:\\Users\\alice\\very-long-workspace-folder\\checkouts",
      compactParent: "C:\\…\\checkouts",
      full: "C:\\Users\\alice\\very-long-workspace-folder\\checkouts\\app",
    });
    expect(formatFolder("", "acme/web")).toEqual({ name: "web", parent: "", compactParent: "", full: "" });
  });
});

describe("favorite folders per machine", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stubStorage = (initial = new Map<string, string>()) => {
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => initial.get(k) ?? null,
      setItem: (k: string, v: string) => void initial.set(k, v),
      removeItem: (k: string) => void initial.delete(k),
    });
    return initial;
  };

  it("pins, unpins, isolates per machine, and caps at FAV_FOLDERS_MAX", () => {
    stubStorage();
    expect(readFavoriteFolders("studio")).toEqual([]);
    expect(toggleFavoriteFolder("studio", "/Users/alice/code/a/")).toEqual(["/Users/alice/code/a"]);
    expect(toggleFavoriteFolder("studio", "/Users/alice/code/b")).toEqual([
      "/Users/alice/code/b",
      "/Users/alice/code/a",
    ]);
    expect(isFavoriteFolder(readFavoriteFolders("studio"), "/Users/alice/code/a")).toBe(true);
    expect(readFavoriteFolders("macbook")).toEqual([]);
    // Unpinning removes it cleanly.
    expect(toggleFavoriteFolder("studio", "/Users/alice/code/a")).toEqual(["/Users/alice/code/b"]);
    expect(isFavoriteFolder(readFavoriteFolders("studio"), "/Users/alice/code/a")).toBe(false);
    // Capped at FAV_FOLDERS_MAX (12).
    for (let i = 0; i < FAV_FOLDERS_MAX + 4; i++) toggleFavoriteFolder("macbook", `/w/p${i}`);
    const favs = readFavoriteFolders("macbook");
    expect(favs).toHaveLength(FAV_FOLDERS_MAX);
    expect(favs[0]).toBe(`/w/p${FAV_FOLDERS_MAX + 3}`);
  });

  it("is resilient to missing or corrupt storage", () => {
    expect(readFavoriteFolders("studio")).toEqual([]);
    const store = stubStorage(new Map([["sp.newSession.favFolders", "{not valid json"]]));
    expect(readFavoriteFolders("studio")).toEqual([]);
    store.set("sp.newSession.favFolders", JSON.stringify(["wrong-shape"]));
    expect(readFavoriteFolders("studio")).toEqual([]);
  });

  it("orders pinned -> recent (deduped) -> allowed (deduped) in folderChoices", () => {
    const sessions = [
      { cwd: "~/acme/web", lastAt: "2026-10-23T10:00:00Z", machine: "studio", repo: "github.com/acme/web" },
      { cwd: "~/acme/api", lastAt: "2026-10-23T11:00:00Z", machine: "studio", repo: "github.com/acme/api" },
    ];
    const c = folderChoices({
      sessions,
      machine: "studio",
      folders: ["/Users/demo/acme/web", "/Users/demo/acme/api", "/Users/demo/acme/infra"],
      home: HOME,
      favorites: ["/Users/demo/acme/web", "/Users/demo/acme/infra", "/Users/demo/outside"],
    });
    expect(c.pinned).toEqual([
      { path: "/Users/demo/acme/web", display: "~/acme/web", repo: "acme/web" },
      { path: "/Users/demo/acme/infra", display: "~/acme/infra" },
    ]);
    expect(c.recent).toEqual([{ path: "/Users/demo/acme/api", display: "~/acme/api", repo: "acme/api" }]);
    expect(c.allowed).toEqual([]);
  });
});
