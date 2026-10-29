// SPDX-License-Identifier: Apache-2.0
// One session's view, used by the Session page and by the side panel. The view itself
// (the timeline, the chat, the composer: components/SessionBody.tsx) is its own chunk, so
// the board's first paint doesn't carry it: it is fetched once the app is idle, or at the
// first session opened before that, which meanwhile shows what a session shows while its
// events load (the bar, nothing under it). What other surfaces read off a mounted view
// (the strip's Allow / Deny as menu items) stays here, in the app's own chunk.
import { type SessionSummary, sessionKey } from "@shared/api";
import { lazy, type RefObject, Suspense } from "react";
import { useSeen } from "../data/hooks";
import { isPlanReview, toolLabel } from "../lib/format";
import { back } from "../lib/router";
import type { MenuList } from "./ContextMenu";
import { BackButton, PageBar } from "./PageBar";

export interface SessionViewProps {
  harness: string;
  id: string;
  /** "page": the window scrolls and the title bar is part of the view.
   *  "panel": the panel scrolls (`scrollRef`) and carries the title itself. */
  mode: "page" | "panel";
  scrollRef?: RefObject<HTMLElement | null>;
  /** The summary as soon as it is known (the panel header shows it). */
  onSession?: (s: SessionSummary) => void;
  /** After Forget succeeded; the page goes to the board by default. */
  onForgotten?: () => void;
  /** The panel's agent tab: the view opens on this subagent's block. On a page it is the
   *  URL's `?agent=`. */
  agent?: string;
}

const load = () => import("./SessionBody");
const Body = lazy(() => load().then((m) => ({ default: m.SessionBody })));
// Warm the chunk once the app has painted and is idle, so opening a session stays instant.
if (typeof window !== "undefined") {
  const warm = () => void load().catch(() => {});
  if ("requestIdleCallback" in window) window.requestIdleCallback(warm, { timeout: 3000 });
  else setTimeout(warm, 1500);
}

export function SessionView(props: SessionViewProps) {
  // On the page it is what the person is looking at; the panel marks its active tab.
  useSeen(props.mode === "page" ? sessionKey(props.harness, props.id) : null);
  return (
    <Suspense fallback={<SessionLoading mode={props.mode} />}>
      <Body {...props} />
    </Suspense>
  );
}

/** A session whose events are on their way: the page's bar (back, and the title said to
 *  a screen reader), nothing under it; the panel shows nothing of its own. */
export function SessionLoading({ mode, rootRef }: { mode: "page" | "panel"; rootRef?: RefObject<HTMLDivElement> }) {
  return (
    <div className={`page session ${mode === "panel" ? "session--panel" : ""}`} ref={rootRef}>
      {mode === "page" && (
        <PageBar
          title={<span className="sr-only">Loading session…</span>}
          back={<BackButton onClick={() => back("/")} />}
          large={false}
        />
      )}
    </div>
  );
}

/** Allow / Deny for an open permission as menu items that press the strip's own buttons,
 *  so a menu answers through the one signed send (and its one-answer memory) the strip
 *  uses; disabled with the strip's reason when it cannot. `root` is the view (or the
 *  panel's active body); the first open prompt unless `attentionId` names one. */
export function answerItems(root: HTMLElement | null, s: SessionSummary, attentionId?: string): MenuList {
  const rows = [...(root?.querySelectorAll<HTMLElement>(".ctl-answer[data-attention]") ?? [])];
  const row = attentionId ? rows.find((r) => r.dataset.attention === attentionId) : rows[0];
  const allow = row?.querySelector<HTMLButtonElement>(".btn--allow");
  const deny = row?.querySelector<HTMLButtonElement>(".btn--deny");
  if (!row || !allow || !deny) return [];
  const tool = s.openAttentions.find((a) => a.attentionId === row.dataset.attention)?.tool;
  const name = tool ? ` ${toolLabel(tool)}` : "";
  // A plan review's pair: the strip's own two buttons, by their own names.
  const plan = isPlanReview({ kind: "permission", tool });
  // Either button can be off on its own (Approve plan while the composer holds a note, Keep
  // planning with one over 2,000 characters): its item says so rather than pressing a
  // button that cannot go.
  const own = allow.getAttribute("aria-description");
  const why =
    allow.disabled && !own
      ? row.querySelector(".ctl-answer-note")?.textContent?.trim() || "This prompt cannot be answered from here"
      : undefined;
  const allowWhy = why ?? (allow.disabled ? own || true : undefined);
  const denyWhy = why ?? (deny.disabled ? deny.getAttribute("aria-description") || true : undefined);
  return [
    {
      label: plan ? "Approve plan" : `Allow${name}`,
      action: "session.allow",
      disabled: allowWhy,
      run: () => allow.click(),
    },
    {
      label: plan ? "Keep planning" : `Deny${name}`,
      action: "session.deny",
      disabled: denyWhy,
      run: () => deny.click(),
    },
  ];
}
