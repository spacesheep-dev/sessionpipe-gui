// SPDX-License-Identifier: Apache-2.0
// Owned by: web. The demo's label: while the mock transport runs (`?mock=1`, VITE_MOCK=1),
// every page carries a bar saying the sessions are made up, and the page is stamped
// `data-demo` so its styles can mark the rest. Plain DOM outside React, so no page, view
// or plugin frame can forget it: on 2026-11-08 someone opened "Try the demo", saw sessions
// on machines with real-looking names asking for Allow on a `git push`, and read it as
// strangers' agents on his screen.
import "../styles/demo.css";

export const DEMO_WORDS = {
  label: "Demo data",
  body: "These sessions are made up. Nothing here is a real machine, and Allow, Deny or a message goes nowhere.",
  short: "Made-up sessions. Buttons go nowhere.",
  exit: "Leave the demo",
} as const;

/** Puts the demo bar on the page (once) and marks the document as the demo. */
export function showDemoBanner(doc: Document = document): HTMLElement {
  const had = doc.querySelector<HTMLElement>("[data-demo-banner]");
  if (had) return had;
  doc.documentElement.dataset.demo = "1";
  const bar = doc.createElement("div");
  bar.className = "demo-banner";
  bar.setAttribute("role", "status");
  bar.dataset.demoBanner = "";
  const tag = doc.createElement("strong");
  tag.className = "demo-banner-tag";
  tag.textContent = DEMO_WORDS.label;
  const body = doc.createElement("span");
  body.className = "demo-banner-body";
  body.textContent = DEMO_WORDS.body;
  const short = doc.createElement("span");
  short.className = "demo-banner-short";
  short.textContent = DEMO_WORDS.short;
  const exit = doc.createElement("a");
  exit.className = "demo-banner-exit";
  exit.href = "/";
  exit.textContent = DEMO_WORDS.exit;
  bar.append(tag, body, short, exit);
  doc.body.prepend(bar);
  return bar;
}
