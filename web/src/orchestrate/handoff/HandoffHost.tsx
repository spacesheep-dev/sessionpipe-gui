// SPDX-License-Identifier: Apache-2.0
// Owned by: orchestrate-web. The host that shows the Handoff sheet (HandoffSheet.tsx)
// for one session, mounted with that session's control (control/SessionControl.tsx) the
// way NewSession.tsx hosts its sheet in the shell: the sheet is fetched once the page is
// idle, so it costs the first load nothing and opens at once; asked for before that, an
// invisible field holds the keys typed meanwhile so none of them reaches the page.
import type { SessionKey } from "@shared/api";
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
  if (!mounted || !target) return null;
  if (!mod) return closing ? null : <KeyCatch />;
  return <mod.Sheet key={seq} open={target} closing={closing} />;
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
