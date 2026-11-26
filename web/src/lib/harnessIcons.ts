// SPDX-License-Identifier: Apache-2.0
// Monochrome marks for the harnesses the board shows, drawn in currentColor next to
// text. Path data for Anthropic, OpenAI, Google Gemini and Cursor comes from simple-icons
// (https://simple-icons.org, 16.35.0; the path data is CC0). Antigravity's mark (the "A"
// arch) is redrawn in one colour from the app's own monochrome asset. The marks themselves
// are trademarks of Anthropic, OpenAI, Google and Anysphere, used here only to identify
// the software a session runs in, not to suggest affiliation or endorsement (see
// docs/brand.md, "Third-party marks", and sessionpipe's TRADEMARKS.md). Harnesses not
// listed here keep their two-letter monogram (lib/format.ts).

export interface HarnessIcon {
  /** Path data, filled with currentColor. */
  path: string;
  viewBox: string;
  /** The human name: "Claude Code", not "claude-code". */
  name: string;
}

export const HARNESS_ICONS: Record<string, HarnessIcon> = {
  "claude-code": {
    name: "Claude Code",
    viewBox: "0 0 24 24",
    path: "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z",
  },
  codex: {
    name: "Codex",
    viewBox: "0 0 24 24",
    path: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
  },
  "gemini-cli": {
    name: "Gemini CLI",
    viewBox: "0 0 24 24",
    path: "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81",
  },
  antigravity: {
    name: "Antigravity",
    // Wider than tall: the arch sits in a square box so it lines up with the others.
    viewBox: "10 12 92 92",
    path: "M89.754 92.75c4.667 3.5 11.667 1.167 5.25-5.25-19.25-18.667-15.167-70-39.083-70-23.917 0-19.834 51.333-39.084 70-7 7 .584 8.75 5.25 5.25C40.171 80.5 39.004 58.917 55.921 58.917c16.916 0 15.75 21.583 33.833 33.833Z",
  },
  cursor: {
    name: "Cursor",
    viewBox: "0 0 24 24",
    path: "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
  },
};

/** The icon's markup as a string, for views outside React (ThemeApi.format.harnessIcon). */
export function harnessIconSvg(harness: string, size = 14): { svg: string; name: string } | null {
  const icon = HARNESS_ICONS[harness];
  if (!icon) return null;
  return {
    name: icon.name,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${icon.viewBox}" role="img" aria-label="${icon.name}"><path fill="currentColor" d="${icon.path}"/></svg>`,
  };
}
