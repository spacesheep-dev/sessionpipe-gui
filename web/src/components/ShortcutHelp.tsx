// SPDX-License-Identifier: Apache-2.0
// `?` on any page opens the shortcut help (ShortcutHelpDialog.tsx, fetched once the page is
// idle, so it costs the first load nothing). Here: the key that opens it, the small chip
// that shows the first key of a sequence while the second is awaited ("g …"), and the
// pieces the Shortcuts page and Settings share (a binding as caps, the actions grouped).
// Mounted once, in the shell.
import { Fragment, useEffect, useState } from "react";
import { lazyModule, whenIdle } from "../lib/lazy";
import { usePresence } from "../lib/motion";
import { type Action, formatBinding, usePendingChord, useShortcut } from "../lib/shortcuts";
import { Kbd } from "./bits";

const dialogModule = lazyModule(() => import("./ShortcutHelpDialog"));
whenIdle(() => void dialogModule.preload().catch(() => {}));

/** One binding as chips: <kbd>g</kbd> <kbd>f</kbd>; `caps` draws each as a key cap. A space
 *  between the chips makes the text read "g f", as a button's name says it, not "gf"; the
 *  row is inline-flex, where a space between items is never drawn. */
export function Keys({
  binding,
  className = "",
  caps = false,
}: {
  binding: string;
  className?: string;
  caps?: boolean;
}) {
  const parts = formatBinding(binding);
  return (
    <span className={`${caps ? "kbd-row" : "keys"} ${className}`}>
      {parts.map((p, i) => (
        <Fragment key={`${p}-${i}`}>
          {i > 0 && " "}
          {caps ? <Kbd>{p}</Kbd> : <kbd>{p}</kbd>}
        </Fragment>
      ))}
    </span>
  );
}

/** Actions grouped in the order they are declared, the views' groups last. */
export function groupActions(actions: readonly Action[]): { group: string; actions: Action[] }[] {
  const out: { group: string; actions: Action[] }[] = [];
  for (const a of actions) {
    let g = out.find((x) => x.group === a.group);
    if (!g) {
      g = { group: a.group, actions: [] };
      out.push(g);
    }
    g.actions.push(a);
  }
  return out;
}

export function ChordHint() {
  const pending = usePendingChord();
  if (!pending) return null;
  return (
    <div className="chord-hint" role="status" aria-live="polite">
      <kbd>{pending}</kbd> <span>then…</span>
    </div>
  );
}

export function ShortcutHelp() {
  const [open, setOpen] = useState(false);
  useShortcut("help.toggle", () => setOpen((o) => !o));
  // A route change closes it.
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener("popstate", close);
    return () => window.removeEventListener("popstate", close);
  }, []);
  const mod = dialogModule.use();
  const { mounted, closing } = usePresence(open);
  return (
    <>
      <ChordHint />
      {mounted && mod && <mod.HelpDialog onClose={() => setOpen(false)} closing={closing} />}
    </>
  );
}
