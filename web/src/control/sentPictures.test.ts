// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  forgetSentPictures,
  keepSentPicture,
  picturesToDrop,
  SENT_PICTURES_KEEP_MS,
  SENT_PICTURES_MAX_BYTES,
  sentPicturesDb,
  sentPictureUrl,
} from "./sentPictures";

const MB = 1024 * 1024;
const DAY = 86_400_000;

describe("the pictures a page keeps of what it sent", () => {
  it("keeps 30 days and 50 MB at most, the oldest out first", () => {
    expect(SENT_PICTURES_KEEP_MS).toBe(30 * DAY);
    expect(SENT_PICTURES_MAX_BYTES).toBe(50 * MB);
    const now = 100 * DAY;
    const kept = [
      { sha: "c", size: 20 * MB, at: now - 1 * DAY },
      { sha: "a", size: 20 * MB, at: now - 3 * DAY },
      { sha: "b", size: 20 * MB, at: now - 2 * DAY },
    ];
    // 60 MB together: the oldest goes, and 40 MB is within the bound.
    expect(picturesToDrop(kept, now)).toEqual(["a"]);
    expect(picturesToDrop(kept.slice(0, 2), now)).toEqual([]);
    // Past 30 days a picture goes whatever room there is.
    expect(picturesToDrop([{ sha: "old", size: 1, at: now - 31 * DAY }, ...kept.slice(0, 1)], now)).toEqual(["old"]);
    expect(picturesToDrop([], now)).toEqual([]);
  });

  it("where there is no IndexedDB, keeps them for the page's life and draws them from there", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
    expect(await sentPictureUrl("none-of-these")).toBeNull();
    await keepSentPicture("kiwi-sha", bytes, "image/png");
    const url = await sentPictureUrl("kiwi-sha");
    expect(url).toMatch(/^blob:/);
    const blob = await (await fetch(url!)).blob();
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array(bytes));
  });

  it("are the account's on an account, deleted when it leaves the phone; a board has one for its origin", async () => {
    expect(sentPicturesDb()).toBe("sent-pictures");
    expect(sentPicturesDb("acct-one")).toBe("sessionpipe.sent-pictures.acct-one");
    const deleted: string[] = [];
    const idb = { deleteDatabase: (name: string) => void deleted.push(name) } as unknown as IDBFactory;
    forgetSentPictures("acct-one", idb);
    expect(deleted).toEqual(["sessionpipe.sent-pictures.acct-one"]);
    // Another account's going is nothing to what a board keeps.
    await keepSentPicture("board-sha", new Uint8Array([1]).buffer, "image/png");
    expect(await sentPictureUrl("board-sha")).toMatch(/^blob:/);
    forgetSentPictures("acct-one", undefined);
  });
});

describe("on a spacesheep account, once the account leaves the phone", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("the page holds none of them, revokes what it drew from, and keeps no more", async () => {
    vi.stubGlobal("sessionpipeShell", {
      v: 1,
      rxBase: "rx://account",
      receiver: { kind: "spacesheep", id: "acct-one", origin: "https://spacesheep.example.com" },
    });
    vi.resetModules();
    const m = await import("./sentPictures");
    expect(m.sentPicturesDb()).toBe("sessionpipe.sent-pictures.acct-one");
    await m.keepSentPicture("kiwi-sha", new Uint8Array([1, 2]).buffer, "image/png");
    const url = (await m.sentPictureUrl("kiwi-sha"))!;
    expect(url).toMatch(/^blob:/);
    const revoked: string[] = [];
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation((u) => void revoked.push(u));
    const deleted: string[] = [];
    m.forgetSentPictures("acct-one", { deleteDatabase: (n: string) => void deleted.push(n) } as unknown as IDBFactory);
    revoke.mockRestore();
    expect(deleted).toEqual(["sessionpipe.sent-pictures.acct-one"]);
    expect(revoked).toEqual([url]);
    expect(await m.sentPictureUrl("kiwi-sha")).toBeNull();
    await m.keepSentPicture("birch-sha", new Uint8Array([3]).buffer, "image/png");
    expect(await m.sentPictureUrl("birch-sha")).toBeNull();
  });
});
