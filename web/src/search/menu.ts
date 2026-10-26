// SPDX-License-Identifier: Apache-2.0
// Owned by: search-ui. A result's menu (ux-search.md §5.2): open it, copy what a person
// pastes elsewhere (the resume line, the link, the ID, the transcript's path), reveal it on
// this machine, narrow the search to its repo or machine, and its colour label. Items that
// cannot apply are absent, never disabled: Reveal only for a viewer on this machine and a
// session that ran here; a resume line only where one is verified (Claude Code, Codex),
// else "Copy session ID" / "Copy conversation ID".
import type { SearchIndexStatus, SessionMatch, SessionSearchHit } from "@shared/api";
import { setFilter } from "@shared/searchQuery";
import type { MenuItem, MenuList } from "../components/ContextMenu";
import type { Store } from "../data/store";
import { copyText } from "../lib/clipboard";
import { labelMenu } from "../lib/labels";
import { absoluteUrl } from "../lib/menus";
import { receiverOrigin } from "../lib/net";
import { sessionPath } from "../lib/router";
import { pushToast } from "../lib/toasts";
import { type OpenMode, openResult, resultLink } from "./open";
import type { SearchClient } from "./types";
import { harnessName, idWord, macWord } from "./words";

/** A quiet confirmation that something reached the clipboard. */
export function copied(what: string): void {
  pushToast({
    id: `copy|${Date.now()}`,
    kind: "delivered",
    sticky: false,
    title: `Copied ${what}`,
    label: "copied",
    at: Date.now(),
    ms: 2400,
  });
}

export const copyAs = (what: string, text: string): Promise<void> => copyText(text).then(() => copied(what));

/** "Reveal … in Finder" on a Mac, "Show … in Explorer" on Windows, "Show folder" elsewhere. */
function revealWords(what: "folder" | "transcript"): string {
  const p = typeof navigator !== "undefined" ? (navigator.platform ?? "") : "";
  if (/Mac/.test(p)) return what === "folder" ? "Reveal folder in Finder" : "Reveal transcript in Finder";
  if (/Win/.test(p)) return what === "folder" ? "Show folder in Explorer" : "Show transcript in Explorer";
  return what === "folder" ? "Show folder" : "Show transcript";
}

const phone = () => typeof matchMedia === "function" && matchMedia("(max-width: 839px)").matches;

export interface RowMenuContext {
  store: Store;
  client: SearchClient | null;
  status: SearchIndexStatus | null;
  q: string;
  /** Rewrites the page's query (More from <repo>). */
  setQuery: (q: string) => void;
  /** Opens the row with its find bar on. */
  find: (m: SessionMatch) => void;
  from: () => DOMRect | undefined;
}

export function copyResume(m: SessionMatch): boolean {
  if (m.resume) {
    void copyAs("resume command", m.resume);
    return true;
  }
  void copyAs(idWord(m.harness), m.id);
  return true;
}

function reveal(ctx: RowMenuContext, m: SessionMatch, what: "folder" | "transcript"): void {
  ctx.client?.reveal({ harness: m.harness, id: m.id, what }).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    pushToast({
      id: `reveal|${Date.now()}`,
      kind: "error",
      sticky: false,
      title: /gone|not_here|404/.test(msg) ? `That folder is no longer on this Mac.` : "Couldn't reveal it",
      label: "error",
      at: Date.now(),
      ms: 4000,
    });
  });
}

const repoShortName = (repo: string | undefined) => repo?.split("/").filter(Boolean).pop() ?? "";

export function rowMenu(m: SessionMatch, ctx: RowMenuContext): MenuList {
  const open = (mode: OpenMode) => () => openResult(m, m.hits[0], ctx.q, mode, ctx.from());
  const latest = () => {
    if (m.summary) openResult(m, undefined, ctx.q, "page");
    else openResult(m, m.hits[m.hits.length - 1], ctx.q, "page");
  };
  const canReveal = !phone() && ctx.status?.local === true && m.thisMachine;
  const repo = repoShortName(m.repo);
  const withToken = (key: "repo" | "machine", value: string) => ctx.setQuery(setFilter(ctx.q, key, value));
  const items: (MenuItem | null | false)[] = [
    { label: "Open", keys: "↵", run: open("page") },
    !phone() && { label: "Open beside", keys: "⇧↵", run: open("beside") },
    { label: "Open at the latest", run: latest },
    { sep: true },
    m.resume
      ? { label: "Copy resume command", keys: "⌘C", run: () => void copyAs("resume command", m.resume!) }
      : { label: `Copy ${idWord(m.harness)}`, run: () => void copyAs(idWord(m.harness), m.id) },
    {
      label: "Copy link",
      run: () => void copyAs("link", new URL(resultLink(m, m.hits[0], ctx.q), receiverOrigin()).href),
    },
    m.resume ? { label: `Copy ${idWord(m.harness)}`, run: () => void copyAs(idWord(m.harness), m.id) } : null,
    !phone() && m.transcriptPath
      ? { label: "Copy transcript path", run: () => void copyAs("transcript path", m.transcriptPath!) }
      : null,
    { sep: true },
    canReveal && m.cwd ? { label: revealWords("folder"), run: () => reveal(ctx, m, "folder") } : null,
    canReveal && m.transcriptPath
      ? { label: revealWords("transcript"), run: () => reveal(ctx, m, "transcript") }
      : null,
    { sep: true },
    { label: "Find in this session…", run: () => ctx.find(m) },
    repo ? { label: `More from ${repo}`, run: () => withToken("repo", repo) } : null,
    // History from the server's own machine is "this Mac" (machine:this), as the row says.
    m.machine
      ? m.source === "history" && m.thisMachine
        ? { label: `More from this ${macWord()}`, run: () => withToken("machine", "this") }
        : { label: `More from ${m.machine}`, run: () => withToken("machine", m.machine!) }
      : null,
    m.summary ? { sep: true } : null,
    m.summary ? labelMenu(ctx.store, [m.key]) : null,
  ];
  return items;
}

/** A snippet line's own menu: open at that moment, or copy the whole message. */
export function snippetMenu(
  m: SessionMatch,
  hit: SessionSearchHit,
  ctx: RowMenuContext,
  wholeText: () => Promise<string>,
): MenuList {
  return [
    { label: "Open at this match", run: () => openResult(m, hit, ctx.q, "page") },
    !phone() && { label: "Open beside at this match", run: () => openResult(m, hit, ctx.q, "beside", ctx.from()) },
    { sep: true },
    { label: "Copy text", run: () => void wholeText().then((t) => copyAs("text", t)) },
  ];
}

export const menuTitle = (m: SessionMatch) => m.title;
export const menuSubtitle = (m: SessionMatch) =>
  [harnessName(m.harness), m.source === "history" && m.thisMachine ? `this ${macWord()}` : m.machine]
    .filter(Boolean)
    .join(" · ");

/** The history transcript's own page path, for its menu's "Copy link". */
export const historyLink = (m: SessionMatch) => absoluteUrl(sessionPath(m.harness, m.id));
