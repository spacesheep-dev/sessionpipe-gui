// SPDX-License-Identifier: Apache-2.0
// The clipboard, with the hidden-textarea fallback for an origin that has no async
// clipboard (plain http on a LAN address).

/** Puts text on the clipboard (with the textarea fallback for an insecure origin). */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}
