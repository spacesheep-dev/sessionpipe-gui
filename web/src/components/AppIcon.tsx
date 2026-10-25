// SPDX-License-Identifier: Apache-2.0
// The app icon as Settings › About shows it: the mark on its ink tile, as the favicon and
// the installed app draw it (web/public/brand/favicon.svg), the same in both schemes, with
// a hairline edge on a dark ground so it does not sink (--brand-edge). Its own module, so
// only the lazy Settings chunk carries it.

export function AppIcon({ size = 64 }: { size?: number }) {
  return (
    <svg className="app-icon" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="15" fill="#141414" />
      <rect x="0.5" y="0.5" width="63" height="63" rx="14.5" fill="none" stroke="var(--brand-edge)" />
      <g transform="translate(9 9) scale(.71875)">
        <g fill="none" stroke="#454545" strokeLinecap="round" strokeWidth="7">
          <path d="M9 47C20 47 19 32 29 32M9 32H29M9 17C20 17 19 32 29 32" />
          <path d="M29 32H36" stroke="#dadada" />
        </g>
        <circle cx="51" cy="32" r="7.5" fill="#ff5a1f" />
      </g>
    </svg>
  );
}
