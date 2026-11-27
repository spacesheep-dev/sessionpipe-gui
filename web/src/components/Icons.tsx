// SPDX-License-Identifier: Apache-2.0
// Owned by: web. The app's unified monochrome icon library: every stroked UI icon renders
// at an equal 1.25 px optical stroke width regardless of rendered size or viewBox grid
// (`opticalStroke`), with rounded caps and joins inspired by sessionpipe's brand mark.
import type { ReactNode } from "react";

/** Target effective rendered stroke width (CSS px) for every stroked UI icon. */
export const OPTICAL_STROKE_PX = 1.25;

/** ViewBox strokeWidth that produces an exact 1.25 px effective stroke at `size` px. */
export function opticalStroke(size: number, vb = 20): number {
  return Number(((OPTICAL_STROKE_PX * vb) / size).toFixed(2));
}

export interface IconProps {
  size?: number;
  className?: string;
}

/** Branded branching-pipe flow paths on the 20×20 grid: two inputs merging into one output,
 *  echoing sessionpipe's brand mark. Shared by Shell, WorkflowGlyph, and index.html boot. */
export const WORKFLOWS_ICON_PATHS: readonly string[] = [
  "M5 3.75a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 1 0 0-3.5Z",
  "M5 12.75a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 1 0 0-3.5Z",
  "M15 8.25a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 1 0 0-3.5Z",
  "M6.75 5.5C10.5 5.5 9.5 10 13.25 10",
  "M6.75 14.5C10.5 14.5 9.5 10 13.25 10",
];

/** Default glyph for an installed view without its own icon: a sleek geometric plug. */
export const PLUG_ICON: ReactNode = (
  <>
    <path d="M7.5 3.25v3.25M12.5 3.25v3.25" />
    <path d="M5.5 6.5h9v3a4.5 4.5 0 0 1-9 0v-3Z" />
    <path d="M10 14v3.25" />
  </>
);

/** Navigation and shell chrome paths on the 20×20 grid (stroked at `opticalStroke(size, 20)`
 *  except `moreDots`, which renders filled circles). */
export const NAV_ICON_PATHS = {
  /** Soft-rounded 2×2 bento grid. */
  board: (
    <>
      <rect x="3" y="3" width="6" height="6" rx="2" />
      <rect x="11" y="3" width="6" height="6" rx="2" />
      <rect x="3" y="11" width="6" height="6" rx="2" />
      <rect x="11" y="11" width="6" height="6" rx="2" />
    </>
  ),
  /** Rounded tray with angled shoulders and a centered lip dip. */
  inbox: (
    <>
      <path d="M3 11.5 4.85 5.1A1.9 1.9 0 0 1 6.68 3.75h6.64a1.9 1.9 0 0 1 1.83 1.35L17 11.5" />
      <path d="M3 11.5h4.2l1.2 1.8h3.2l1.2-1.8H17v2.75a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 3 14.25Z" />
    </>
  ),
  /** Optically centered magnifier. */
  search: (
    <>
      <circle cx="9.25" cy="9.25" r="5.5" />
      <path d="M13.2 13.2 17 17" />
    </>
  ),
  /** Branded live stream: staggered horizontal tracks with leading node and stream arrow. */
  feed: (
    <>
      <circle cx="4.25" cy="6" r="1.25" />
      <path d="M8 6h8.5" />
      <path d="M3.5 10h13" />
      <path d="M3.5 14h8.5" />
      <path d="M14.25 12 16.5 14l-2.25 2" />
    </>
  ),
  /** Rounded document frame with an inner check mark. */
  review: (
    <>
      <rect x="3.5" y="2.75" width="13" height="14.5" rx="2.25" />
      <path d="M7.25 10.25 9.25 12.25 13 8.25" />
    </>
  ),
  /** Branded branching pipe flow. */
  workflows: (
    <>
      {WORKFLOWS_ICON_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </>
  ),
  /** Studio monitor with vertical stem and wide base. */
  machines: (
    <>
      <rect x="2.75" y="3.75" width="14.5" height="9.75" rx="2.25" />
      <path d="M10 13.5v3" />
      <path d="M6.5 16.5h7" />
    </>
  ),
  /** Semicircular gauge with hub and needle. */
  usage: (
    <>
      <path d="M3.5 14.5a6.5 6.5 0 1 1 13 0" />
      <circle cx="10" cy="14" r="1.25" />
      <path d="M10.9 13.1 13.5 9.5" />
    </>
  ),
  /** Onboarding checklist: completed steps and one remaining dot. */
  setup: (
    <>
      <path d="M3.5 6 5 7.5 7.75 4.75" />
      <path d="M10.5 6h6" />
      <path d="M3.5 11.25 5 12.75 7.75 10" />
      <path d="M10.5 11.25h6" />
      <circle cx="5.25" cy="15.75" r="1.15" />
      <path d="M10.5 15.75h4.5" />
    </>
  ),
  /** Office building with doorway (fallback mark for the office view). */
  office: (
    <>
      <path d="M3.25 16.5V5.25a2 2 0 0 1 2-2h9.5a2 2 0 0 1 2 2V16.5" />
      <path d="M2.5 16.5h15" />
      <path d="M7.75 16.5v-4.75a1.25 1.25 0 0 1 1.25-1.25h2a1.25 1.25 0 0 1 1.25 1.25v4.75" />
    </>
  ),
  plug: PLUG_ICON,
  /** macOS-style sidebar window with two session ticks in the left column. */
  sidebarToggle: (
    <>
      <rect x="2.75" y="3.5" width="14.5" height="13" rx="2.75" />
      <path d="M7.75 3.5v13" />
      <path d="M5 7h1M5 9.75h1" />
    </>
  ),
  /** 8-ray Display sun with generous negative space. */
  displaySun: (
    <>
      <circle cx="10" cy="10" r="3.25" />
      <path d="M10 2.75v1.75M10 15.5v1.75M2.75 10h1.75M15.5 10h1.75M4.9 4.9l1.2 1.2M13.9 13.9l1.2 1.2M4.9 15.1l1.2-1.2M13.9 6.1l1.2-1.2" />
    </>
  ),
  /** Three slider tracks broken cleanly around open circular knobs. */
  settingsSliders: (
    <>
      <path d="M3.25 5.5h8.1M14.65 5.5h2.1M3.25 10h2.1M8.65 10h8.1M3.25 14.5h7.1M13.65 14.5h3.1" />
      <circle cx="13" cy="5.5" r="1.65" />
      <circle cx="7" cy="10" r="1.65" />
      <circle cx="12" cy="14.5" r="1.65" />
    </>
  ),
  /** Three harmonized filled dots (use inside a `fill="currentColor"` SVG). */
  moreDots: (
    <>
      <circle cx="4.5" cy="10" r="1.25" />
      <circle cx="10" cy="10" r="1.25" />
      <circle cx="15.5" cy="10" r="1.25" />
    </>
  ),
} as const satisfies Record<string, ReactNode>;

export type NavIconKey = keyof typeof NAV_ICON_PATHS;

function Svg({
  size,
  vb,
  className,
  fill = "none",
  children,
}: {
  size: number;
  vb: number;
  className?: string;
  fill?: string;
  children: ReactNode;
}) {
  return (
    <svg
      className={className}
      viewBox={`0 0 ${vb} ${vb}`}
      width={size}
      height={size}
      fill={fill}
      stroke="currentColor"
      strokeWidth={opticalStroke(size, vb)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

// ----- Navigation & shell chrome components -----

export function DisplaySunIcon({ size = 20, className }: IconProps) {
  return (
    <Svg size={size} vb={20} className={className}>
      {NAV_ICON_PATHS.displaySun}
    </Svg>
  );
}

export function SettingsSlidersIcon({ size = 20, className }: IconProps) {
  return (
    <Svg size={size} vb={20} className={className}>
      {NAV_ICON_PATHS.settingsSliders}
    </Svg>
  );
}

export function SidebarToggleIcon({ size = 20, className }: IconProps) {
  return (
    <Svg size={size} vb={20} className={className}>
      {NAV_ICON_PATHS.sidebarToggle}
    </Svg>
  );
}

export function PlugIcon({ size = 20, className }: IconProps) {
  return (
    <Svg size={size} vb={20} className={className}>
      {PLUG_ICON}
    </Svg>
  );
}

export function MachineIcon({ size = 20, className }: IconProps) {
  return (
    <Svg size={size} vb={20} className={className}>
      {NAV_ICON_PATHS.machines}
    </Svg>
  );
}

export function MoreDotsIcon({ size = 16, className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 20 20" width={size} height={size} fill="currentColor" aria-hidden="true">
      {NAV_ICON_PATHS.moreDots}
    </svg>
  );
}

// ----- Unified action & group icons -----

const FOLDER_CLOSED =
  "M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6a1.5 1.5 0 0 1 1.15.54l.6.72c.24.28.59.44.96.44h3.69A1.5 1.5 0 0 1 14 6.2v5.3A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5Z";

/** Canonical rounded folder icon (closed or open). */
export function FolderIcon({ open = false, size = 16, className }: IconProps & { open?: boolean }) {
  return (
    <Svg size={size} vb={16} className={className}>
      {open ? (
        <>
          <path d="M2 11.5v-7A1.5 1.5 0 0 1 3.5 3h2.6a1.5 1.5 0 0 1 1.15.54l.6.72c.24.28.59.44.96.44h3.19A1.5 1.5 0 0 1 13.5 6.2v.55" />
          <path d="M2 11.5 3.15 7.65A1.35 1.35 0 0 1 4.44 6.75h9.06a1 1 0 0 1 .96 1.28l-1.08 3.85A1.5 1.5 0 0 1 11.94 13H3.5A1.5 1.5 0 0 1 2 11.5Z" />
        </>
      ) : (
        <path d={FOLDER_CLOSED} />
      )}
    </Svg>
  );
}

/** Matches FolderIcon's exact silhouette with a centered `+` inside. */
export function NewFolderIcon({ size = 16, className }: IconProps) {
  return (
    <Svg size={size} vb={16} className={className}>
      <path d={FOLDER_CLOSED} />
      <path d="M8 7.1v3.6M6.2 8.9h3.6" />
    </Svg>
  );
}

/** Geometric workspace / repository cube for project groups. */
export function ProjectIcon({ size = 16, className }: IconProps) {
  return (
    <Svg size={size} vb={16} className={className}>
      <path d="M8 1.75 13.5 4.85v6.3L8 14.25 2.5 11.15v-6.3Z" />
      <path d="M8 8v6.25M8 8l5.5-3.15M8 8 2.5 4.85" />
    </Svg>
  );
}

/** Layered stack icon for toggling "Group by project". */
export function GroupProjectsIcon({ size = 16, className }: IconProps) {
  return (
    <Svg size={size} vb={16} className={className}>
      <path d="M8 2.25 13.75 5.35 8 8.45 2.25 5.35Z" />
      <path d="M2.25 8.35 8 11.45l5.75-3.1" />
      <path d="M2.25 11.15 8 14.25l5.75-3.1" />
    </Svg>
  );
}

/** Canonical vertical pin icon used for pinned sections and drop-to-pin zones. */
export function PinIcon({ size = 16, className }: IconProps) {
  return (
    <Svg size={size} vb={16} className={className}>
      <path d="M5.75 2.5h4.5l-.6 3.85 1.85 1.9v1.1H4.5v-1.1l1.85-1.9Z" />
      <path d="M8 9.35v4.4" />
    </Svg>
  );
}

/** Circle with centered `+` for "New session" in the session tree. */
export function PlusCircleIcon({ size = 16, className }: IconProps) {
  return (
    <Svg size={size} vb={20} className={className}>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6.75v6.5M6.75 10h6.5" />
    </Svg>
  );
}

/** Rounded compose square + diagonal pen for New session triggers. */
export function ComposeIcon({ size = 16, className }: IconProps) {
  return (
    <Svg size={size} vb={20} className={className}>
      <path d="M9.5 3.75H5.5a2 2 0 0 0-2 2v8.75a2 2 0 0 0 2 2h8.75a2 2 0 0 0 2-2V10.5" />
      <path d="M14.35 3.4a1.4 1.4 0 0 1 1.98 0l.27.27a1.4 1.4 0 0 1 0 1.98L10.35 11.9 7.75 12.25l.35-2.6Z" />
    </Svg>
  );
}

/** Open as page / pop-out square with diagonal arrow. */
export function OpenPageIcon({ size = 16, className }: IconProps) {
  return (
    <Svg size={size} vb={20} className={className}>
      <path d="M8.5 3.75H5.25a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V11.5" />
      <path d="M11.75 3.25h5v5" />
      <path d="M16.75 3.25 9.75 10.25" />
    </Svg>
  );
}

/** Symmetric dismiss `×`. */
export function CloseIcon({ size = 16, className }: IconProps) {
  return (
    <Svg size={size} vb={16} className={className}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  );
}

const CHEVRON_PATH: Record<"right" | "down" | "left" | "up", string> = {
  right: "M4.5 2.75 7.75 6 4.5 9.25",
  down: "M2.75 4.5 6 7.75 9.25 4.5",
  left: "M7.5 2.75 4.25 6 7.5 9.25",
  up: "M2.75 7.5 6 4.25 9.25 7.5",
};

/** Small directional chevron for disclosures, menus, selects, and chips. */
export function ChevronIcon({
  size = 12,
  direction = "right",
  className,
}: IconProps & { direction?: "right" | "down" | "left" | "up" }) {
  return (
    <Svg size={size} vb={12} className={className}>
      <path d={CHEVRON_PATH[direction]} />
    </Svg>
  );
}

/** Clean `+` glyph for inline add buttons. */
export function PlusIcon({ size = 14, className }: IconProps) {
  return (
    <Svg size={size} vb={16} className={className}>
      <path d="M8 3.25v9.5M3.25 8h9.5" />
    </Svg>
  );
}

/** Overlapping rounded sheets for Copy actions. */
export function CopyIcon({ size = 16, className }: IconProps) {
  return (
    <Svg size={size} vb={16} className={className}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.75" />
      <path d="M10.5 3.75V3.5A1.75 1.75 0 0 0 8.75 1.75H4.25A1.75 1.75 0 0 0 2.5 3.5v4.5a1.75 1.75 0 0 0 1.75 1.75h.25" />
    </Svg>
  );
}

/** Crisp check mark for Copy confirmation, menus, and selects. */
export function CheckIcon({ size = 16, className }: IconProps) {
  return (
    <Svg size={size} vb={16} className={className}>
      <path d="M3.25 8.5 6.5 11.75 12.75 4.5" />
    </Svg>
  );
}

/** Small search magnifier for toolbar search inputs. */
export function SearchIcon({ size = 14, className }: IconProps) {
  return (
    <Svg size={size} vb={16} className={className}>
      <circle cx="7.25" cy="7.25" r="4.5" />
      <path d="M10.55 10.55 13.75 13.75" />
    </Svg>
  );
}

/** Three tapered horizontal bars for Filter buttons. */
export function FilterIcon({ size = 14, className }: IconProps) {
  return (
    <Svg size={size} vb={16} className={className}>
      <path d="M2.5 4.25h11M4.75 8h6.5M6.75 11.75h2.5" />
    </Svg>
  );
}

/** Notification bell, optionally struck through while muted. */
export function BellIcon({ muted = false, size = 16, className }: IconProps & { muted?: boolean }) {
  return (
    <Svg size={size} vb={20} className={className}>
      <path d="M5.5 13.25V9a4.5 4.5 0 0 1 9 0v4.25l1.25 1.75H4.25Z" />
      <path d="M8.35 17a1.85 1.85 0 0 0 3.3 0" />
      {muted && <path d="M3.5 3.5l13 13" />}
    </Svg>
  );
}

/** Left navigation chevron for Back buttons. */
export function BackIcon({ size = 18, className }: IconProps) {
  return (
    <Svg size={size} vb={20} className={className}>
      <path d="M12.5 4.5 7 10l5.5 5.5" />
    </Svg>
  );
}

/** Upward send arrow for the composer. */
export function SendIcon({ size = 16, className }: IconProps) {
  return (
    <Svg size={size} vb={20} className={className}>
      <path d="M10 16V4.5M5.25 9.25 10 4.5l4.75 4.75" />
    </Svg>
  );
}

/** Media-style stop button: rounded square inside a ring. */
export function StopIcon({ size = 18, className }: IconProps) {
  return (
    <Svg size={size} vb={20} className={className}>
      <circle cx="10" cy="10" r="7.5" />
      <rect x="7.35" y="7.35" width="5.3" height="5.3" rx="1.25" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** Circular reload / refresh arrow. */
export function RefreshIcon({ size = 16, className }: IconProps) {
  return (
    <Svg size={size} vb={16} className={className}>
      <path d="M13 8a5 5 0 1 1-1.35-3.4" />
      <path d="M13 2.75v2.75h-2.75" />
    </Svg>
  );
}

/** Star glyph for pinning/favoriting folders. */
export function StarIcon({ filled = false, size = 14, className }: IconProps & { filled?: boolean }) {
  return (
    <Svg size={size} vb={16} className={className} fill={filled ? "currentColor" : "none"}>
      <path d="m8 2.25 1.74 3.52 3.88.57-2.81 2.74.66 3.87L8 11.12l-3.47 1.83.66-3.87-2.81-2.74 3.88-.57L8 2.25Z" />
    </Svg>
  );
}

/** Paperclip glyph for attaching files. */
export function PaperclipIcon({ size = 16, className }: IconProps) {
  return (
    <Svg size={size} vb={16} className={className}>
      <path d="M10.5 4.5 5.7 9.3a1.6 1.6 0 0 0 2.3 2.3l5.2-5.2a3.2 3.2 0 0 0-4.5-4.5L3.3 7.3a4.8 4.8 0 0 0 6.8 6.8l3.6-3.6" />
    </Svg>
  );
}

/** Shield with info mark for security/trust notes. */
export function ShieldInfoIcon({ size = 14, className }: IconProps) {
  return (
    <Svg size={size} vb={16} className={className}>
      <path d="M8 1.75 2.75 3.75v4.1c0 3.1 2.25 5.45 5.25 6.4 3-.95 5.25-3.3 5.25-6.4v-4.1L8 1.75Z" />
      <path d="M8 7.25v3" />
      <circle cx="8" cy="5.1" r="0.65" fill="currentColor" stroke="none" />
    </Svg>
  );
}
