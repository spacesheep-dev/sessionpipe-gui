// SPDX-License-Identifier: Apache-2.0
// What the page sees, for a probe launch (lib.rs `probe`, SP_PROBE set): 2.5 s after it has
// loaded, put in the address's hash as `#probe=<JSON>`, which needs no IPC permission. The
// shell writes that address to <app data>/probe.txt, and mobile.yml's iPhone Duo step reads
// it. test/e2e/duo.spec.ts runs this file in a browser.
setTimeout(() => {
  const d = document.documentElement;
  // The system's insets as a stylesheet gets them: a box padded by env(safe-area-inset-*),
  // top, right, bottom, left (the order of test/e2e/duo.ts's DUO table).
  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;inset:0;visibility:hidden;pointer-events:none;" +
    "padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
  d.appendChild(box);
  const pad = getComputedStyle(box);
  const insets = [pad.paddingTop, pad.paddingRight, pad.paddingBottom, pad.paddingLeft].map(
    (px) => Number.parseFloat(px) || 0,
  );
  box.remove();
  const vv = window.visualViewport;
  const seen = {
    href: location.href,
    shell: d.dataset.shell,
    theme: d.dataset.theme,
    sp: window.sessionpipeShell && {
      receiver: window.sessionpipeShell.receiver,
      rxBase: window.sessionpipeShell.rxBase,
    },
    font: getComputedStyle(d).fontSize,
    // biome-ignore lint/performance/useDomNodeTextContent: the words as drawn, without what is hidden
    text: document.body.innerText.slice(0, 600),
    w: innerWidth,
    h: innerHeight,
    insets,
    sizeClass: d.dataset.sizeClass ?? null,
    coarse: matchMedia("(pointer: coarse)").matches,
    vv: vv ? [vv.width, vv.height] : null,
    dpr: devicePixelRatio,
    screen: [screen.width, screen.height],
    errors: window.__probeErrors || [],
  };
  const hash = `#probe=${encodeURIComponent(JSON.stringify(seen))}`;
  history.replaceState(history.state, "", location.pathname + location.search + hash);
}, 2500);
