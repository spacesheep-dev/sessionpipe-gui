// SPDX-License-Identifier: Apache-2.0
// Owned by: orchestrate-web. The host that shows the Handoff sheet (HandoffSheet.tsx)
// for one session, mounted with that session's control (control/SessionControl.tsx) the
// way NewSession.tsx hosts its sheet in the shell: the sheet is fetched once the page is
// idle, so it costs the first load nothing and opens at once; asked for before that, an
// invisible field holds the keys typed meanwhile so none of them reaches the page.
// The sheet is rendered into document.body, as PoolAddSheet's is. Inside .sess-ctl, the
// transcript's measure and the bar's sticky layer would cut its scrim to a band beside
// the sidebar. It goes there in an element of its own, as a menu's sheet does
// (ContextMenu.tsx MenuHost): a phone's drag marks the sheet's parent (lib/motion.ts
// useSheetDrag), and a mark left on the body would take the dim from every other sheet.
import type { SessionKey } from "@shared/api";
import { createPortal } from "react-dom";
import { useContextMenu } from "../../components/ContextMenu";
import { lazyModule, whenIdle } from "../../lib/lazy";
import { usePresence } from "../../lib/motion";
import { closeHandoff, useHandoff, useHostLead } from "./handoffState";

const sheetModule = lazyModule(() => import("./HandoffSheet"));
whenIdle(() => void sheetModule.preload().catch(() => {}));

export function HandoffHost({ session }: { session: SessionKey }) {
  const { open, target, seq } = useHandoff();
  const lead = useHostLead(session);
  const mine = open && lead && target?.session === session;
  const mod = sheetModule.use();
  // Kept for its exit (sheet-lift on a desktop, sheet-down on a phone), then let go.
  const { mounted, closing } = usePresence(mine);
  // A right-click on the sheet or its scrim still climbs React's tree to the bar, whose
  // menu would open over the dimmed window: the sheet takes it first, and has no menu.
  // Only the handler, not `data-menu`: a long-press in the sheet stays nothing.
  const { onContextMenu } = useContextMenu(() => null);
  if (!mounted || !target) return null;
  if (!mod) return closing ? null : <KeyCatch />;
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: not a control; it keeps the sheet's right-click from the bar's menu
    <div className="hs-host" key={seq} onContextMenu={onContextMenu}>
      <mod.Sheet open={target} closing={closing} />
    </div>,
    document.body,
  );
}

/** The stand-in while the sheet may still be loading: a field no one sees, holding focus,
 *  so a key typed meanwhile is not the page's. */
function KeyCatch() {
  return (
    <input
      className="sr-only"
      aria-label="Ask another agent"
      // biome-ignore lint/a11y/noAutofocus: it stands in for the sheet, which takes focus as it opens
      autoFocus
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") closeHandoff();
      }}
    />
  );
}
