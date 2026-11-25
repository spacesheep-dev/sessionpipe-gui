// SPDX-License-Identifier: Apache-2.0
// The window: a sidebar on the chrome ground (a labelled source list when there is room,
// a compact icon rail otherwise), a bottom tab bar on phones; a touch screen with room
// (lib/device.ts sizeClass "regular") has a sidebar of 44 pt rows in the tab bar's place,
// listing what the tab bar and More do (styles/regular.css). Carries the connection
// indicator, the display popover, and one entry per installed theme plugin
// (web/src/themes/host), routed to /t/<id>. The tab bar holds the first four pages and a
// More tab whose sheet lists the rest (pages, installed views, Display and Settings).
// Every sidebar entry has a right-click menu, and so does the sidebar itself (appearance,
// skin, mode); MenuHost here is the one context-menu policy for the whole app. On a phone
// it also keeps the status bar on the page's ground (theme-color), scrolls a page to its
// top when its tab is tapped again, mounts pull to refresh on the list pages
// (PullRefresh), and shows a dropped stream as a pill under the bar, which that same
// pull retries. The wide sidebar ends with what each account has left (UsageGlance.tsx);
// where those lines are not drawn Usage is a row, and the phone reaches it as More › Usage.
// Between the pages and the usage lines, the labelled sidebar and the touch app's sidebar
// list the sessions as a tree the person can arrange (SessionTree.tsx); the icon rail and
// the phone list none: the phone has the Board.

import { sessionKey } from "@shared/api";
import type { InstalledTheme } from "@shared/theme-api";
import {
  type CSSProperties,
  Fragment,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ComposeButton, NewSessionHost, useNewFromUrl, useStandaloneNewKey } from "../control/NewSession";
import { newSessionOpen, openNewSession } from "../control/newSessionState";
import { useAppState, useNeedsYouCount, useStore, useStreamMark } from "../data/hooks";
import { onPhoneLayout, phoneLayout, reachName, usePanelCovers, usePhoneLayout, useRegular } from "../lib/device";
import { useKeyboardInset } from "../lib/keyboardInset";
import { useGlobalKeys } from "../lib/keys";
import { lazyModule, whenIdle } from "../lib/lazy";
import { linkItems } from "../lib/menus";
import { reducedMotion, usePresence } from "../lib/motion";
import { accountMode } from "../lib/net";
import {
  Link,
  lastMove,
  navigate,
  openSettings,
  type Route,
  SETTINGS_PARAM,
  settingsHref,
  usePath,
  useSearchParam,
} from "../lib/router";
import { useReadyUpdate } from "../lib/selfUpdate";
import {
  getSettings as getAppSettings,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  setMode,
  setSettings,
  sidebarClamp,
  treeColumn,
  useAppSettings,
  useSimple,
} from "../lib/settings";
import { hintFor, isTyping, KeysOff, useShortcut, useShortcutMap } from "../lib/shortcuts";
import { getSkins, isPlain } from "../lib/skins";
import { closeSplit, leaveSplit, restoreSplit, useSplitKey, useSplitWidth } from "../lib/split";
import { getDisplaySettings as getDisplay, setSkin, setTheme, useSettings } from "../lib/theme";
import { NEW_WORDS } from "../native/accountWords";
import { WORKFLOWS_ICON_PATHS } from "../orchestrate/workflows/glyphs";
import { RunnerHost } from "../orchestrate/workflows/useRunner";
import { useSetupStatus } from "../setup/api";
import { setupComplete } from "../setup/steps";
import { reloadThemes, setThemeDisabled, useThemes } from "../themes/host/registry";
import { Mark } from "./Brand";
import { MenuHost, type MenuList, useContextMenu } from "./ContextMenu";
import type { MoreSheetProps } from "./MoreSheet";
import { MoveUnderHost } from "./MoveUnder";
import { openPalette } from "./Palette";
import { PULL_PAGES, PullRefresh } from "./PullRefresh";
import { GearIcon, QuickSettings } from "./QuickSettings";
import { SessionPanel } from "./SessionPanel";
import { SessionTree } from "./SessionTree";
import { Settings } from "./Settings";
import { ShortcutHelp } from "./ShortcutHelp";
import { TipHost } from "./Tip";
import { USAGE_ONE_LINE, UsageGlance, UsageLine, useGlanceShown } from "./UsageGlance";

/** Whether Setup had steps to go at the last visit: the rail draws its entry from this
 *  until the status answers, so nothing below it moves ~100 ms after the first paint. A
 *  device on its first visit has not set up yet, so it starts with the entry drawn. */
const SETUP_KEY = "sessionpipe-gui.rail.setup";
const readSetupHint = (): boolean => {
  try {
    return localStorage.getItem(SETUP_KEY) !== "0";
  } catch {
    return true;
  }
};
const writeSetupHint = (on: boolean): void => {
  try {
    localStorage.setItem(SETUP_KEY, on ? "1" : "0");
  } catch {
    // a private window: the entry just arrives a moment late
  }
};

/** What is drawn over the page and is not the page (the palette, the toasts): its keys stay
 *  live while the panel covers the page (a narrow window) and the page's own are off. */
export function OverPage({ children }: { children: ReactNode }) {
  return <KeysOff.Provider value={false}>{children}</KeysOff.Provider>;
}

/** Whether a media query matches, live. */
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const update = () => setOn(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return on;
}

/** Re-renders on window resize (the panel width is clamped to the viewport). */
function useResize(): void {
  const [, bump] = useState(0);
  useEffect(() => {
    const on = () => bump((n) => n + 1);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
}

/* Thin 1.5 px line icons on a 20 px grid. */
const ICON: Record<string, ReactNode> = {
  board: (
    <>
      <rect x="3" y="3" width="6" height="6" rx="1" />
      <rect x="11" y="3" width="6" height="6" rx="1" />
      <rect x="3" y="11" width="6" height="6" rx="1" />
      <rect x="11" y="11" width="6" height="6" rx="1" />
    </>
  ),
  /* A tray with its lip: the inbox. */
  inbox: (
    <>
      <path d="M3 11l2.2-6.5A1 1 0 0 1 6.2 4h7.6a1 1 0 0 1 1 .5L17 11" />
      <path d="M3 11h4l1 2h4l1-2h4v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 15.5z" />
    </>
  ),
  search: (
    <>
      <circle cx="8.75" cy="8.75" r="5.25" />
      <path d="M12.6 12.6 17 17" />
    </>
  ),
  feed: (
    <>
      <path d="M3 5h14" />
      <path d="M3 10h14" />
      <path d="M3 15h10" />
    </>
  ),
  review: (
    <>
      <path d="M3 5h8" />
      <path d="M3 10h5" />
      <path d="M3 15h4" />
      <circle cx="13.5" cy="12" r="3.5" />
      <path d="M16 14.5 18 16.5" />
    </>
  ),
  /* Three stacked short rules with a chevron: steps, and what follows them. */
  workflows: (
    <>
      {WORKFLOWS_ICON_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </>
  ),
  machines: (
    <>
      <rect x="2.5" y="4" width="15" height="10" rx="1.5" />
      <path d="M7 17h6" />
    </>
  ),
  /* A gauge: how much is left (Usage, a More row on a phone). */
  usage: (
    <>
      <path d="M3 14.5a7 7 0 0 1 14 0" />
      <path d="M10 14.5l3.2-4.2" />
    </>
  ),
  /* A short list with a check: the first-run steps. */
  setup: (
    <>
      <path d="M3 5.5l1.5 1.5 3-3" />
      <path d="M10 5.5h7" />
      <path d="M3 11l1.5 1.5 3-3" />
      <path d="M10 11h7" />
      <path d="M10 16.5h7" />
      <path d="M3.5 16.5h3" />
    </>
  ),
  /* A room with a door: the office theme, now a plugin (sessionpipe-gui-themes/packages/office), ships its
     own copy in its manifest; this one stays for anything that wants the same mark. */
  office: (
    <>
      <path d="M3 16.5V5a1.5 1.5 0 0 1 1.5-1.5h11A1.5 1.5 0 0 1 17 5v11.5" />
      <path d="M2.5 16.5h15" />
      <path d="M7.5 16.5v-5h5v5" />
    </>
  ),
};

/** Three sliders: the settings dialog (the gear is the appearance popover's). */
export function SlidersIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M3 5.5h14M3 10h14M3 14.5h14" />
      <circle cx="7" cy="5.5" r="1.8" fill="var(--bg)" />
      <circle cx="13" cy="10" r="1.8" fill="var(--bg)" />
      <circle cx="9" cy="14.5" r="1.8" fill="var(--bg)" />
    </svg>
  );
}

/* The default glyph for an installed theme without an icon: a plug. */
const PLUG_ICON = (
  <>
    <path d="M7 3v4" />
    <path d="M13 3v4" />
    <path d="M4.5 7h11v3a5.5 5.5 0 0 1-11 0z" />
    <path d="M10 15.5V18" />
  </>
);

interface NavItem {
  to: string;
  key: string;
  label: string;
  /** Our line-icon paths on the 20 px grid, or… */
  glyph: ReactNode;
  /** …the theme's own inline SVG from its manifest. */
  svg?: string;
  experimental?: boolean;
  /** Its group in the sidebar, which a hairline sets off from the one before: the lists
   *  (0), Feed and Review (1), Workflows and Machines (2), the views (3), the experimental
   *  views (4). None: the entry sits at the foot of the list, apart from the groups. */
  group?: number;
}

/* Connect is no entry: it is Machines' "Connect…", ⌘K's and `g c`. */
const BUILTIN: NavItem[] = [
  { to: "/", key: "board", label: "Board", glyph: ICON.board, group: 0 },
  { to: "/inbox", key: "inbox", label: "Inbox", glyph: ICON.inbox, group: 0 },
  { to: "/search", key: "search", label: "Search", glyph: ICON.search, group: 0 },
  { to: "/feed", key: "feed", label: "Feed", glyph: ICON.feed, group: 1 },
  { to: "/review", key: "review", label: "Review", glyph: ICON.review, group: 1 },
  { to: "/workflows", key: "workflows", label: "Workflows", glyph: ICON.workflows, group: 2 },
  { to: "/machines", key: "machines", label: "Machines", glyph: ICON.machines, group: 2 },
];

/** A manifest icon is inline SVG the theme author wrote; it is code of the same trust
 *  as the theme itself, but a script-bearing one is refused all the same. */
const safeSvg = (svg: string | undefined): string | null => {
  if (!svg) return null;
  const s = svg.trim();
  if (!/^<svg[\s>]/i.test(s) || /<script|on[a-z]+\s*=|javascript:|<foreignObject|<iframe/i.test(s)) return null;
  return s;
};

export const themeNavItem = (t: InstalledTheme): NavItem => {
  const svg = safeSvg(t.icon);
  return {
    to: `/t/${encodeURIComponent(t.id)}`,
    key: `t:${t.id}`,
    label: t.name || t.id,
    glyph: PLUG_ICON,
    svg: svg ?? undefined,
    experimental: t.experimental,
    group: t.experimental ? 4 : 3,
  };
};

/** The words say what is left to do, so the sidebar shows no dot beside them. */
const SETUP_ITEM: NavItem = { to: "/setup", key: "setup", label: "Finish setup", glyph: ICON.setup };

/** Usage is a sidebar row only where its lines are not drawn (the compact rail, the
 *  setting off, nothing reported yet, a short window), so it is there exactly once; on a
 *  phone it is a More row. After Machines, else before Finish setup, else last. */
const USAGE_ITEM: NavItem = { to: "/usage", key: "usage", label: "Usage", glyph: ICON.usage, group: 2 };
const withUsage = (pages: NavItem[]): NavItem[] => {
  const m = pages.findIndex((n) => n.key === "machines");
  const at = m >= 0 ? m + 1 : pages.findIndex((n) => n.key === "setup");
  return at < 0 ? [...pages, USAGE_ITEM] : [...pages.slice(0, at), USAGE_ITEM, ...pages.slice(at)];
};

/** The pages Simple mode keeps off the rail (still there through ⌘K and Settings). */
const ADVANCED_ONLY = new Set(["feed", "review"]);
/** The pages that are a receiver's own doing (its workflows): not offered where the
 *  window shows a spacesheep account, which has no receiver. */
const RECEIVER_ONLY = new Set(["workflows"]);

/** The page is the demo: the mock transport runs (mock/index.ts sets the mark), which is
 *  exactly when the yellow bar shows (mock/banner.ts). */
const inDemo = (): boolean => !!(globalThis as { __sessionpipeMock?: unknown }).__sessionpipeMock;

/** Builtins first, then installed themes, the experimental ones after a divider, then
 *  Finish setup while this machine is not set up (never in the demo, where nothing is a
 *  real machine). `simple` drops Feed, Review and the experimental views. */
export function navItems(
  themes: readonly InstalledTheme[],
  o: { setup?: boolean; simple?: boolean; account?: boolean } = {},
): NavItem[] {
  const plugins = themes
    .filter((t) => !t.error && !t.disabled)
    .map(themeNavItem)
    .filter((n) => !(o.simple && n.experimental));
  const builtin = BUILTIN.filter(
    (n) => !(o.simple && ADVANCED_ONLY.has(n.key)) && !(o.account && RECEIVER_ONLY.has(n.key)),
  );
  return [
    ...builtin,
    ...plugins.filter((n) => !n.experimental),
    ...plugins.filter((n) => n.experimental),
    ...(o.setup && !o.account && !inDemo() ? [SETUP_ITEM] : []),
  ];
}

/** A nav item's icon: the theme's own SVG when its manifest has one, else our line icon. */
function NavGlyph({ n }: { n: NavItem }) {
  if (n.svg)
    return <span className="nav-glyph nav-glyph--svg" aria-hidden="true" dangerouslySetInnerHTML={{ __html: n.svg }} />;
  return (
    <svg
      className="nav-glyph"
      viewBox="0 0 20 20"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {n.glyph}
    </svg>
  );
}

/** How many pages sit on the phone's tab bar before More. */
const TABS = 4;

const loopback = () => ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

/** The keymap action that goes to a nav item, for its chord in a menu and a tooltip. */
function navAction(n: NavItem, views: NavItem[]): string | undefined {
  if (n.key.startsWith("t:")) {
    const i = views.findIndex((v) => v.key === n.key);
    return i >= 0 && i < 9 ? `nav.view${i + 1}` : undefined;
  }
  return `nav.${n.key}`;
}

/** A sidebar entry's menu: open it (with its keys), in a new window, copy its link; a
 *  view adds managing, disabling and reloading the views (on the receiver machine). */
function navMenu(n: NavItem, action: string | undefined): MenuList {
  const view = n.key.startsWith("t:") ? n.key.slice(2) : null;
  const local = loopback();
  const onlyHere = local ? false : "Only on the machine running the receiver";
  return [
    { label: "Open", action, run: () => navigate(n.to) },
    ...linkItems(n.to),
    view && { sep: true },
    view && { label: "Manage views…", action: "nav.views", run: () => navigate("/themes") },
    view && { label: "Disable view", disabled: onlyHere, run: () => setThemeDisabled(view, true) },
    view && { label: "Reload views", disabled: onlyHere, run: () => reloadThemes() },
  ];
}

/** The sidebar's own menu (its background and its brand): the appearance, the skin, the
 *  mode, and the ways into Settings. */
function railMenu(): MenuList {
  const d = getDisplay();
  const skins = getSkins().skins.filter((k) => !k.error && !isPlain(k));
  const appearance = (v: "auto" | "light" | "dark", label: string) => ({
    label,
    radio: true,
    checked: d.appearance === v,
    run: () => setTheme(v),
  });
  return [
    {
      label: "Appearance",
      items: [appearance("auto", "System"), appearance("light", "Light"), appearance("dark", "Dark")],
    },
    {
      label: "Skin",
      items: skins.map((k) => ({ label: k.name, radio: true, checked: d.skin.id === k.id, run: () => setSkin(k) })),
    },
    {
      label: "Mode",
      items: [
        { label: "Simple", radio: true, checked: simpleNow(), run: () => setMode("simple") },
        { label: "Advanced", radio: true, checked: !simpleNow(), run: () => setMode("advanced") },
      ],
    },
    { sep: true },
    { label: "Command palette…", action: "palette.toggle", run: openPalette },
    {
      label: "Display…",
      run: () => document.querySelector<HTMLButtonElement>("nav.rail button[aria-label='Quick settings']")?.click(),
    },
    { label: "Settings…", run: () => openSettings() },
    { label: "Keyboard shortcuts", action: "nav.shortcuts", run: () => navigate("/shortcuts") },
  ];
}
/** Read at menu time, not render time. */
const simpleNow = (): boolean => getAppSettings().mode === "simple";

/** One page in the sidebar, the rail or the tab bar, with its menu and (in the rail) a
 *  tooltip that names its keys. */
function NavEntry({
  n,
  active,
  action,
  needs,
  tip,
  here,
  covered,
}: {
  n: NavItem;
  active: boolean;
  action: string | undefined;
  needs: number;
  tip: boolean;
  /** The page is open at exactly this entry's address: a tap again goes to its top, or,
   *  with the panel covering it (a narrow window), brings the page back. */
  here: boolean;
  covered: boolean;
}) {
  const menu = useContextMenu(() => navMenu(n, action), { title: () => n.label });
  const keys = action ? hintFor(action) : "";
  return (
    <Link
      to={n.to}
      plainClick={here ? (covered ? closeSplit : toTop) : undefined}
      className={["nav-link", active && "nav-link--on", n.group === undefined && "nav-link--pinned"]
        .filter(Boolean)
        .join(" ")}
      aria-current={active ? "page" : undefined}
      data-nav={n.key}
      data-tip={tip ? (keys ? `${n.label}   ${keys}` : n.label) : undefined}
      {...menu}
    >
      <NavGlyph n={n} />
      <span className="nav-label">{n.label}</span>
      {n.key === "inbox" && needs > 0 ? (
        <>
          <span className="nav-badge num" aria-hidden="true">
            {needs}
          </span>
          <span className="sr-only">
            , {needs} {needs === 1 ? "needs" : "need"} you
          </span>
        </>
      ) : null}
      {/* A quiet dot, not orange: steps to go is not a thing that needs you. */}
      {n.key === "setup" ? <span className="nav-dot" role="img" aria-label="steps to go" /> : null}
    </Link>
  );
}

/** A tab tapped again: its page goes back to the top, as a native tab bar's does. */
const toTop = () => window.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });

function MoreRow({ n, active, action }: { n: NavItem; active: string; action: string | undefined }) {
  const menu = useContextMenu(() => navMenu(n, action), { title: () => n.label });
  return (
    <li>
      <Link
        to={n.to}
        className="more-row"
        aria-current={active === n.key ? "page" : undefined}
        data-nav={n.key}
        {...menu}
      >
        <NavGlyph n={n} />
        <span className="more-row-name">{n.label}</span>
      </Link>
    </li>
  );
}

/** What More lists after the tabs: its pages (Usage among them), then the installed views. */
const moreLists = (items: NavItem[]): { pages: NavItem[]; plugins: NavItem[] } => ({
  pages: withUsage(items.filter((n) => !n.key.startsWith("t:"))),
  plugins: items.filter((n) => n.key.startsWith("t:")),
});

/** The fifth tab: a sheet with the entries the bar has no room for, as grouped lists:
 *  the pages, the installed views, then Display and Settings. Carries aria-current when
 *  the active page is inside. */
function MoreTab({
  items,
  active,
  views,
  regular,
  inSidebar = false,
}: {
  items: NavItem[];
  active: string;
  views: NavItem[];
  /** The sidebar is in the tab bar's place and lists it all. */
  regular: boolean;
  /** The touch sidebar's own More row (its pages are the iPad's four): it stays. */
  inSidebar?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [display, setDisplay] = useState(false);
  const { pages, plugins } = moreLists(items);
  const inside = [...pages, ...plugins].some((n) => n.key === active);
  const { mounted, closing } = usePresence(open);
  // A route change closes the sheet, whichever tab was tapped.
  useEffect(() => setOpen(false), [active]);
  // So does the sidebar taking the tab bar's place: a sheet left open never comes back by
  // itself when the screen is folded again.
  useEffect(() => {
    if (regular && !inSidebar) {
      setOpen(false);
      setDisplay(false);
    }
  }, [regular, inSidebar]);
  // The exit copy marks no page current: the tab itself carries that once it closes.
  const row = (n: NavItem) => <MoreRow key={n.key} n={n} active={closing ? "" : active} action={navAction(n, views)} />;
  return (
    <div className="more">
      <button
        type="button"
        className={`nav-link more-tab ${inside || open ? "nav-link--on" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-current={inside ? "page" : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-nav="more"
      >
        <svg className="nav-glyph" viewBox="0 0 20 20" width="20" height="20" fill="currentColor" aria-hidden="true">
          <circle cx="4" cy="10" r="1.6" />
          <circle cx="10" cy="10" r="1.6" />
          <circle cx="16" cy="10" r="1.6" />
        </svg>
        <span className="nav-label">More</span>
      </button>
      {mounted && (
        <MoreSheetHost
          open={open}
          closing={closing}
          onClose={() => setOpen(false)}
          onDisplay={() => {
            setOpen(false);
            setDisplay(true);
          }}
          lists={[pages.map(row), plugins.map(row)]}
        />
      )}
      <QuickSettings placement="tabbar" trigger={false} open={display} onOpenChange={setDisplay} />
    </div>
  );
}

/** The More sheet is a phone's alone: its code is fetched once the page has the phone
 *  layout, when it is idle after load or when a window is narrowed into it later (so the
 *  first tap opens it at once), never in a window that stays wide. The layout is listened
 *  to until the code is in: a fetch that failed is tried at the next narrowing. */
const moreSheet = lazyModule(() => import("./MoreSheet"));
if (typeof window !== "undefined")
  whenIdle(() => {
    const warm = () => {
      if (phoneLayout()) void moreSheet.preload().then(off, () => {});
    };
    const off = onPhoneLayout(warm);
    warm();
  });
function MoreSheetHost(p: MoreSheetProps) {
  const m = moreSheet.use();
  return m ? <m.MoreSheet {...p} /> : null;
}

/** The icon rail's width: the tokens' 72, the Mac app's 80 (its traffic lights sit over it). */
const railWidth = (): number => (document.documentElement.dataset.shell === "macos" ? 80 : 72);

const SideUsage = USAGE_ONE_LINE ? UsageLine : UsageGlance;

const LISTS = new Set(["board", "inbox", "search", "feed", "review", "workflows"]);
let fromList = "board";
/** The list a session page was opened from (PageBar's BackButton names it). */
export const listBehind = (): string => fromList;

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  useGlobalKeys();
  // Tooltips and menus show the live keys: re-render when the keymap changes.
  useShortcutMap();
  // A session page keeps the list it was opened from lit (Board when it was opened directly).
  if (LISTS.has(route.name)) fromList = route.name;
  const active =
    route.name === "session"
      ? fromList
      : route.name === "theme"
        ? `t:${route.id}`
        : route.name === "workflow" || route.name === "workflowRun"
          ? "workflows"
          : route.name;
  const needs = useNeedsYouCount();
  // The Setup entry, with its orange dot, while this machine (and only from this machine:
  // elsewhere the status is 403) still has steps to go.
  const setup = useSetupStatus();
  const known = setup.local === false || !!setup.status || !!setup.error;
  const showSetup = known ? setup.local === true && !!setup.status && !setupComplete(setup.status) : readSetupHint();
  useEffect(() => {
    if (known) writeSetupHint(showSetup);
  }, [known, showSetup]);
  const simple = useSimple();
  const account = accountMode();
  const themes = useThemes().themes;
  const nav = navItems(themes, { setup: showSetup, simple, account });
  // Every installed view, whichever the mode: `g 1` … `g 9` number them, and the phone's
  // More lists them.
  const views = navItems(themes, { setup: showSetup, account }).filter((n) => n.key.startsWith("t:"));
  const phone = usePhoneLayout();
  const regular = useRegular();
  // Display, from the sidebar's foot where the touch app has one; it goes with the sidebar.
  const [display, setDisplay] = useState(false);
  useEffect(() => {
    if (!regular) setDisplay(false);
  }, [regular]);
  useResize();
  // The phone's keyboard, wherever a field has the focus: --kb and data-kb on <html>
  // (lib/keyboardInset.ts), so a session's docked composer rides on the keys, a sheet makes
  // room under its fields, and a short screen folds its extras away while typing.
  useKeyboardInset();
  useThemeColor();
  useStreamMark();
  // Boot: the last visit's tabs when the URL carries none.
  useEffect(() => {
    restoreSplit();
  }, []);
  const splitOpen = useSplitKey() !== null;
  const splitWidth = useSplitWidth();
  // A computer's window: the icon rail at its edge, the sessions column beside it while the
  // window has room for it and the person has not hidden it, else over the page on asking.
  // The touch app's regular size keeps its own sidebar (the tree under its pages).
  const desktop = !phone && !regular;
  const { sidebarWidth, treeHidden } = useAppSettings();
  const column = treeColumn({
    window: window.innerWidth,
    rail: railWidth(),
    chosen: sidebarWidth,
    panel: splitOpen ? splitWidth : 0,
  });
  const columnShown = desktop && column.fits && !treeHidden;
  const [overlay, setOverlay] = useState(false);
  const overlayShown = desktop && overlay && !columnShown;
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const treeWidth = overlayShown
    ? Math.min(sidebarWidth, window.innerWidth - railWidth() - 48)
    : (liveWidth ?? column.width);
  useEffect(() => {
    document.documentElement.style.setProperty("--tree-w", `${treeWidth}px`);
  }, [treeWidth]);
  const toggleTree = useCallback(() => {
    if (!desktop) return false;
    if (column.fits) {
      setOverlay(false);
      setSettings({ treeHidden: !treeHidden });
    } else setOverlay((o) => !o);
  }, [desktop, column.fits, treeHidden]);
  useShortcut("sidebar.toggle", toggleTree);
  const railMenuProps = useContextMenu(railMenu, { title: () => "sessionpipe gui" });
  // A route change moves focus to the page (not on the first paint, where Tab must start
  // at the skip link), unless the new page put the caret in a field of its own (Search's),
  // and says the page's name through the live region.
  const mainRef = useRef<HTMLElement>(null);
  const [announce, setAnnounce] = useState("");
  const fullPath = usePath();
  const path = fullPath.split("?")[0] ?? "/";
  const settingsShown = useSearchParam(SETTINGS_PARAM) !== null;
  // The path last seen, not a first-run flag: StrictMode runs the effect twice on mount.
  const lastPath = useRef(path);
  useEffect(() => {
    if (lastPath.current === path) return;
    lastPath.current = path;
    const main = mainRef.current;
    const at = document.activeElement;
    // Only a field inside the page's own root: focus still moves on from the palette and
    // the toasts (in <main> too), and from the row a list put it on after Back.
    const placed = isTyping(at) && !!main?.contains(at) && !!at?.closest(".page");
    if (!placed) main?.focus({ preventScroll: true });
    const t = setTimeout(
      () => setAnnounce(document.title.replace(/ · sessionpipe gui$/, "").replace(/^\(\d+\) /, "")),
      60,
    );
    return () => clearTimeout(t);
  }, [path]);
  // New session: `c` anywhere outside a text field, `?new=1`, ⌘N in the installed app.
  useShortcut("newSession.open", () => {
    if (newSessionOpen()) return false;
    openNewSession();
  });
  useNewFromUrl(usePath());
  useStandaloneNewKey();
  // `g 1` … `g 9`: the n-th installed view, in Advanced's rail order.
  for (let i = 1; i <= 9; i++) {
    useShortcut(`nav.view${i}`, () => {
      const v = views[i - 1];
      if (!v) return false;
      navigate(v.to);
    });
  }
  // A window with a mouse under 840 px has no room for a session beside its page: the
  // panel covers the page (split.css), from the rail to the window's edge. The page under
  // it leaves the tab order and the accessibility tree until the panel closes or the
  // window widens, and its keys are off (KeysOff, below): the palette, the toasts and
  // Settings are in <main> too, and stay live. The focus goes from the page to the panel,
  // and back to the row it was on unless it has been put somewhere since.
  const covers = usePanelCovers() && splitOpen;
  const stillOpen = useRef(splitOpen);
  stillOpen.current = splitOpen;
  useEffect(() => {
    const main = mainRef.current;
    if (!main || !covers) return;
    const pages = () => main.querySelectorAll<HTMLElement>(":scope > :is(.page, .theme-page)");
    const at = document.activeElement as HTMLElement | null;
    const held = at && [...pages()].some((page) => page.contains(at)) ? at : null;
    const cover = () => {
      for (const el of pages()) el.setAttribute("inert", "");
    };
    cover();
    // From the page, or from nowhere in particular: not from the rail or something open.
    if (held || !at || at === document.body || at === main)
      document.querySelector<HTMLElement>("aside.panel")?.focus({ preventScroll: true });
    // A page that arrives under the panel (a lazy page's code).
    const arrivals = new MutationObserver(cover);
    arrivals.observe(main, { childList: true });
    return () => {
      arrivals.disconnect();
      for (const el of pages()) el.removeAttribute("inert");
      const now = document.activeElement;
      const free = !now || now === document.body || (!stillOpen.current && !!now.closest("aside.panel"));
      if (held?.isConnected && free) held.focus({ preventScroll: true });
    };
  }, [covers]);
  // A move away from a page the panel covered leaves the panel behind: the page asked for
  // is the one to see, not what was over the last. Not a redirect, nor Back and Forward,
  // which show what was there; and Settings is a window over the page, which moves no path.
  const under = useRef<{ path: string; covered: boolean } | null>(null);
  useEffect(() => {
    const was = under.current;
    under.current = { path, covered: covers };
    if (was?.covered && was.path !== path && lastMove() === "navigate") leaveSplit();
  }, [path, covers]);
  // Beside the sessions column the panel narrows first (treeColumn), so the column stays.
  const panelWidth = columnShown ? column.panel : splitWidth;
  const shellStyle = { "--split-width": `${splitOpen && !phone && !covers ? panelWidth : 0}px` } as CSSProperties;
  const entry = (n: NavItem, tip: boolean) => (
    <NavEntry
      key={n.key}
      n={n}
      active={active === n.key}
      action={navAction(n, views)}
      needs={needs}
      tip={tip}
      here={path === n.to || (n.key === "search" && active === "search")}
      covered={covers}
    />
  );
  // The tab bar keeps its four; Workflows is a page for the More sheet on a phone. More
  // lists every view: a phone has no ⌘K or `g` keys to reach the ones Simple leaves off.
  const tabs = nav.filter((n) => n.key !== "workflows").slice(0, TABS);
  const more = [...nav.filter((n) => !tabs.includes(n) && !n.key.startsWith("t:")), ...views];
  // Usage is in the sidebar once: its lines where they are drawn, a row otherwise. The
  // touch app's sidebar lists what the tab bar and More do, in their order.
  const glance = useGlanceShown() && (columnShown || overlayShown || regular);
  // One element while nothing it shows changes, so the tree (memo) does not redraw on
  // every route change, a search's keystrokes among them.
  const onUsage = route.name === "usage";
  const usageFoot = useMemo(() => (glance ? <SideUsage here={onUsage} /> : null), [glance, onUsage]);
  // The touch sidebar's pages are the iPad's four: Board, Inbox, Search and More (the rest
  // in More's sheet); the rail lists every page, Usage among them where its line is not drawn.
  const padPages = nav.filter((n) => n.key === "board" || n.key === "inbox" || n.key === "search");
  const padMore = [...nav.filter((n) => !padPages.includes(n) && !n.key.startsWith("t:")), ...views];
  const railNav = regular ? padPages : glance && columnShown ? nav : withUsage(nav);
  const firstView = railNav.findIndex((n) => n.key.startsWith("t:") && !n.experimental);
  // The app's update, downloaded and waiting ("0.8.5 is ready"): the foot's Settings button marks it.
  const update = useReadyUpdate();
  const splitKey = useSplitKey();
  const openKey = route.name === "session" ? sessionKey(route.harness, route.id) : splitKey;
  // The column over the page closes on Esc, a click outside it, and a session opening.
  const columnRef = useRef<HTMLElement>(null);
  useEffect(() => setOverlay(false), [openKey]);
  useEffect(() => {
    if (!overlayShown) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      e.preventDefault();
      setOverlay(false);
    };
    const down = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (columnRef.current?.contains(t) || t?.closest?.("[data-tree-toggle], .menu, .menu-sheet, [role=dialog]"))
        return;
      setOverlay(false);
    };
    window.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", down, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", down, true);
    };
  }, [overlayShown]);
  const pagesNav = (
    <div className="rail-nav">
      {railNav.map((n, i) => {
        // A hairline where the group changes; Finish setup sits apart, at the foot.
        const prev = railNav[i - 1];
        const split = !!prev && n.group !== undefined && n.group !== prev.group;
        const experimental = n.group === 4 && prev?.group !== 4;
        return (
          <Fragment key={n.key}>
            {split ? (
              experimental ? (
                /* Named for the rail, where the label below is not shown; data-nav keeps the divider's name for the tests. */
                <hr
                  className="rail-group"
                  data-nav="experimental"
                  title="Experimental views"
                  aria-label="Experimental views"
                />
              ) : (
                <hr className="rail-group" />
              )
            ) : null}
            {i === firstView ? (
              <div className="rail-section" aria-hidden="true">
                Views
              </div>
            ) : null}
            {experimental ? (
              <div className="rail-section" aria-hidden="true">
                Experimental
              </div>
            ) : null}
            {entry(n, !regular)}
          </Fragment>
        );
      })}
    </div>
  );
  return (
    <div
      className={`shell ${splitOpen && !phone ? "shell--split" : ""} ${columnShown ? "shell--tree" : ""}`}
      style={shellStyle}
    >
      {/* biome-ignore lint/a11y/useValidAnchor: a real in-page link to #main; the handler only keeps the hash out of the URL */}
      <a
        href="#main"
        className="skip"
        onClick={(e) => {
          e.preventDefault();
          mainRef.current?.focus();
        }}
      >
        Skip to content
      </a>
      <div className="sr-only" aria-live="polite" aria-atomic="true" data-announcer>
        {announce}
      </div>
      <ConnAnnouncer owned={route.name === "board" || route.name === "inbox"} />
      <nav
        className={`rail${regular ? " rail--tree" : ""}`}
        aria-label="Pages"
        data-tree-overlay={overlayShown ? "" : undefined}
        {...(regular ? {} : railMenuProps)}
      >
        <div className="rail-icons">
          <div className="rail-head">
            <Link to="/" className="rail-brand" title="sessionpipe gui">
              <Mark size={28} />
              <span className="rail-word brand-name" aria-hidden="true" />
              <span className="sr-only">sessionpipe gui</span>
            </Link>
            {/* New session is the column's first row where the column is drawn. */}
            {!regular && !columnShown && !overlayShown && <ComposeButton className="rail-compose" />}
          </div>
          {desktop && <TreeToggle shown={columnShown || overlayShown} over={!column.fits} onToggle={toggleTree} />}
          {regular ? null : pagesNav}
          {regular && (
            <SessionTree
              open={openKey}
              touch
              between={
                <div className="rail-nav rail-nav--pad">
                  {railNav.map((n) => entry(n, false))}
                  <MoreTab items={padMore} active={active} views={views} regular={regular} inSidebar />
                </div>
              }
              foot={usageFoot}
            />
          )}
          <div className="rail-foot">
            {regular && (
              <SideFoot
                display={display}
                setDisplay={setDisplay}
                settings={settingsShown}
                path={fullPath}
                update={update}
              />
            )}
            <ConnectionPill />
            {!account && (
              <Link
                to="/themes"
                className={`theme-btn ${route.name === "themes" ? "nav-link--on" : ""}`}
                data-tip="Views"
                data-tip-keys={hintFor("nav.views")}
                data-tip-side="top"
                aria-label="Views"
                aria-current={route.name === "themes" ? "page" : undefined}
              >
                <svg
                  viewBox="0 0 20 20"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  {PLUG_ICON}
                </svg>
              </Link>
            )}
            <QuickSettings placement="rail" />
            {/* An update that is downloaded and waits: the quiet dot, and the way to its row. */}
            <Link
              to={settingsHref(update ? "about" : null, fullPath)}
              plainClick={() => openSettings(update ? "about" : null)}
              className={`theme-btn ${settingsShown ? "nav-link--on" : ""}`}
              data-tip={update ? `Settings · ${update}` : "Settings"}
              data-tip-side="top"
              aria-label={update ? `Settings, ${update}` : "Settings"}
              aria-haspopup="dialog"
              aria-expanded={settingsShown}
              data-nav="settings"
            >
              <SlidersIcon />
              {update ? <span className="nav-dot" aria-hidden="true" /> : null}
            </Link>
          </div>
        </div>
        {(columnShown || overlayShown) && (
          <section className="tree-col" id="tree-col" ref={columnRef} aria-label="Sessions">
            <SessionTree open={openKey} touch={false} foot={usageFoot} />
          </section>
        )}
        {columnShown && (
          <RailEdge
            width={column.width}
            cap={Math.max(SIDEBAR_MIN, column.cap)}
            live={liveWidth}
            setLive={setLiveWidth}
          />
        )}
      </nav>
      {/* Ahead of the page in the DOM: Esc closes the first drawn [data-dismiss]
          (lib/keys.ts), and Settings is over whatever the page has open (a file, the panel). */}
      <SettingsHost />
      <main className={`main ${route.name === "theme" ? "main--bleed" : ""}`} id="main" ref={mainRef} tabIndex={-1}>
        {/* Off under Settings too: the page stays mounted under it, and no a, d or Enter
            may act on a row nobody can see. */}
        <KeysOff.Provider value={covers || settingsShown}>{children}</KeysOff.Provider>
      </main>
      <nav className="tabbar" aria-label="Pages">
        {tabs.map((n) => entry(n, false))}
        <MoreTab items={more} active={active} views={views} regular={regular} />
      </nav>
      {phone && <PhoneConn />}
      {phone && PULL_PAGES.has(route.name) && <PullRefresh main={mainRef} />}
      <SessionPanel phone={phone} />
      <ShortcutHelp />
      <LabelsHost />
      <MoveUnderHost />
      <NewSessionHost />
      {/* The workflows' signer: claims and signs a run's ready steps, whichever page is open. */}
      <RunnerHost />
      <MenuHost />
      <TipHost />
    </div>
  );
}

/** The rail's button that shows and hides the sessions column (⌃⌘S): beside the page
 *  where it fits, over the page where it does not (`over`). */
function TreeToggle({ shown, over, onToggle }: { shown: boolean; over: boolean; onToggle: () => void }) {
  const label = shown ? "Hide sessions" : "Show sessions";
  return (
    <div className="rail-nav rail-nav--toggle">
      <button
        type="button"
        className="nav-link tree-toggle"
        aria-label={label}
        aria-expanded={shown}
        aria-controls={shown ? "tree-col" : undefined}
        data-tip={over && !shown ? "Show sessions over the page" : label}
        data-tip-keys={hintFor("sidebar.toggle") || undefined}
        data-tip-side="right"
        data-tree-toggle=""
        data-on={shown ? "" : undefined}
        onClick={onToggle}
      >
        <svg
          className="nav-glyph"
          viewBox="0 0 20 20"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="2.5" y="3.5" width="15" height="13" rx="1.5" />
          <path d="M8 3.5v13" />
          <path d="M4.5 7h1.5M4.5 9.5h1.5M4.5 12h1.5" />
        </svg>
      </button>
    </div>
  );
}

/** How far an arrow key moves the sidebar's edge. */
const EDGE_STEP = 16;

/** The sessions column's edge, dragged to make it wider or narrower (SIDEBAR_MIN to
 *  SIDEBAR_MAX, and no wider than the window allows), as a Mac's sidebar is: a double-click
 *  puts it back at SIDEBAR_DEFAULT, and it is a window splitter for the keyboard (its value
 *  in pixels, ← and → by 16, Home and End). The width is this device's (lib/settings.ts),
 *  set on <html> as --tree-w (shell.css: the column's width; --rail stays the icon rail's);
 *  index.html sets it before the first paint. While the edge is dragged the width follows
 *  the pointer and is kept on release. */
function RailEdge({
  width,
  cap,
  live,
  setLive,
}: {
  /** The width drawn when not dragged: the person's, as far as the window allows. */
  width: number;
  /** The widest the window allows. */
  cap: number;
  live: number | null;
  setLive: (px: number | null) => void;
}) {
  const shown = live ?? width;
  const keep = (px: number) => setSettings({ sidebarWidth: sidebarClamp(Math.min(px, cap)) });
  return (
    // biome-ignore lint/a11y/useSemanticElements: a window splitter (WAI-ARIA), which <hr> cannot be: it takes the focus and a value
    <div
      className="rail-edge"
      role="separator"
      aria-orientation="vertical"
      aria-label="Sidebar width"
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={Math.min(SIDEBAR_MAX, cap)}
      aria-valuenow={shown}
      aria-valuetext={`${shown} pixels`}
      tabIndex={0}
      data-resizing={live !== null ? "" : undefined}
      onDoubleClick={() => keep(SIDEBAR_DEFAULT)}
      onKeyDown={(e) => {
        const to =
          e.key === "ArrowLeft"
            ? shown - EDGE_STEP
            : e.key === "ArrowRight"
              ? shown + EDGE_STEP
              : e.key === "Home"
                ? SIDEBAR_MIN
                : e.key === "End"
                  ? SIDEBAR_MAX
                  : null;
        if (to === null) return;
        e.preventDefault();
        e.stopPropagation();
        keep(to);
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const el = e.currentTarget;
        const start = e.clientX;
        const from = shown;
        let now = from;
        el.setPointerCapture(e.pointerId);
        document.documentElement.setAttribute("data-rail-resizing", "");
        const move = (ev: PointerEvent) => {
          now = Math.min(sidebarClamp(from + ev.clientX - start), cap);
          setLive(now);
        };
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
          document.documentElement.removeAttribute("data-rail-resizing");
          if (now !== from) keep(now);
          setLive(null);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
      }}
    />
  );
}

/** The touch app's sidebar ends as the More sheet does: Display, which opens its sheet,
 *  and Settings, in rows like the pages', with the sheet's glyphs. Settings carries the
 *  rail's dot for an update that waits, and leads to its row. */
function SideFoot({
  display,
  setDisplay,
  settings,
  path,
  update,
}: {
  display: boolean;
  setDisplay: (open: boolean) => void;
  /** Settings is open over the page. */
  settings: boolean;
  path: string;
  /** The app's update, downloaded and waiting ("0.8.5 is ready"), or null. */
  update: string | null;
}) {
  return (
    <>
      <button
        type="button"
        className={`nav-link ${display ? "nav-link--on" : ""}`}
        onClick={() => setDisplay(true)}
        aria-haspopup="dialog"
        aria-expanded={display}
        data-nav="display"
      >
        <span className="nav-glyph" aria-hidden="true">
          <GearIcon size={20} />
        </span>
        <span className="nav-label">Display</span>
      </button>
      <Link
        to={settingsHref(update ? "about" : null, path)}
        plainClick={() => openSettings(update ? "about" : null)}
        className={`nav-link ${settings ? "nav-link--on" : ""}`}
        aria-label={update ? `Settings, ${update}` : undefined}
        aria-haspopup="dialog"
        aria-expanded={settings}
        data-nav="settings"
      >
        <span className="nav-glyph" aria-hidden="true">
          <SlidersIcon size={20} />
        </span>
        <span className="nav-label">Settings</span>
        {update ? <span className="nav-dot" aria-hidden="true" /> : null}
      </Link>
      <QuickSettings placement="tabbar" trigger={false} open={display} onOpenChange={setDisplay} />
    </>
  );
}

/** Settings, over the page you are on while the address says `?settings=` (the page stays
 *  mounted under it, its scroll, its title and its lit row with it). */
function SettingsHost() {
  return useSearchParam(SETTINGS_PARAM) === null ? null : <Settings />;
}

/** How long a drop must last before it is shown: a blip is never drawn, nor said. */
const RECONNECT_GRACE_MS = 400;

/** The stream's state in words, after a short grace (a reconnect that lands within it is
 *  never shown): what to draw ("live" inside the grace) and its words, "Reconnecting…" or
 *  "Offline" when the device is. No seconds: the words change only when the state does.
 *  Before the first snapshot (`first`) there is nothing to reconnect to: a failure is
 *  "Can't reach studio-mac" (lib/device.ts reachName), the board's own words for it.
 *  One reading for the sidebar's dot, the page bar (PageBar.tsx ConnStatus), the phone's
 *  pill and what is spoken. A reader that mounts while the stream is already down (a page
 *  opened during a drop) says so at once: the grace is for a drop it watched begin. */
export function useConnection(): { as: string; label: string; down: boolean; first: boolean } {
  const { connection, snapshotAt } = useAppState();
  const first = !snapshotAt;
  const down = connection === "reconnecting" || connection === "offline";
  const [shown, setShown] = useState(down);
  useEffect(() => {
    if (!down) {
      setShown(false);
      return;
    }
    const t = window.setTimeout(() => setShown(true), RECONNECT_GRACE_MS);
    return () => window.clearTimeout(t);
  }, [down]);
  // Inside the grace, every reader still reads as it did: live, or still connecting.
  const was = useRef(connection);
  if (!down) was.current = connection;
  const as = down && !shown ? was.current : connection;
  const label =
    as === "live"
      ? "live"
      : as === "connecting"
        ? "Connecting…"
        : as === "offline"
          ? "Offline"
          : first
            ? NEW_WORDS.reachFailed(reachName())
            : "Reconnecting…";
  return { as, label, down: as === "reconnecting" || as === "offline", first };
}

/** The stream in the sidebar's foot: a dot in every state (solid while live, a ring while
 *  connecting or reconnecting, red when offline), named by its tooltip. The word "live"
 *  stays for assistive tech; a drop's words and its Retry are the page bar's
 *  (PageBar.tsx ConnStatus), so they are said once, and the foot never grows a line. */
export function ConnectionPill() {
  const { as, label } = useConnection();
  return (
    <span
      className={`conn conn--${as}`}
      data-tip={as === "live" ? "Live: updates arrive as they happen" : label}
      data-tip-side="top"
    >
      <span className="conn-dot" aria-hidden="true" />
      {as === "live" ? <span className="conn-label">{label}</span> : null}
    </span>
  );
}

/** What a screen reader hears of the stream, once per change: "Reconnecting." or
 *  "Offline." when a drop has outlasted the grace, and "Reconnected." when a drop it
 *  spoke of is over. A first connect says nothing; one that fails says "Can't reach
 *  studio-mac." and then "Connected.", except on a page whose own first load says it
 *  (`owned`: the Board's and the Inbox's, a live region of their own,
 *  components/NoConnection.tsx). Always mounted,
 *  beside the route announcer, so it speaks with the sidebar hidden and on a page with no
 *  bar; it is the only live region the stream has (the bar's words and the dot are not). */
function ConnAnnouncer({ owned }: { owned: boolean }) {
  const { as, first } = useConnection();
  const [said, setSaid] = useState("");
  // What it said of a failure: one before the first snapshot ("first") or a drop.
  const spoke = useRef<"first" | "drop" | null>(null);
  const quiet = first && owned;
  useEffect(() => {
    if (as === "reconnecting" || as === "offline") {
      if (quiet) return;
      spoke.current = first ? "first" : "drop";
      setSaid(
        as === "offline"
          ? NEW_WORDS.streamOfflineSpoken
          : first
            ? NEW_WORDS.reachFailedSpoken(reachName())
            : NEW_WORDS.streamReconnectingSpoken,
      );
    } else if (as === "live" && spoke.current) {
      setSaid(spoke.current === "first" ? NEW_WORDS.streamConnectedSpoken : NEW_WORDS.streamBackSpoken);
      spoke.current = null;
    }
  }, [as, first, quiet]);
  return (
    <div className="sr-only" role="status" aria-atomic="true" data-conn-announcer>
      {said}
    </div>
  );
}

/** The phone has no sidebar footer: a dropped stream is said in the bar's subtitle slot
 *  on a page with a large title (PageBar.tsx PhoneSub, where iOS keeps "Connecting…"),
 *  and on a page without one (a session) as this pill, floated under the bar's content;
 *  the whole pill is the Retry button, and while the stream is live there is none. The
 *  pill is always mounted on the phone and shell.css shows it only where no large title
 *  is on the page. The pull down a list that refreshes it (PullRefresh) is the other way
 *  to retry: the pill rides with the content (pull.css) and the reconnect is the same one. */
function PhoneConn() {
  const { as, label, down, first } = useConnection();
  const store = useStore();
  if (!down) return null;
  return (
    <button
      type="button"
      className={`phone-conn phone-conn--${as}`}
      onClick={() => store.reconnect()}
      aria-label={`${as === "offline" ? NEW_WORDS.streamOfflineSpoken : first ? NEW_WORDS.reachFailedSpoken(reachName()) : NEW_WORDS.streamReconnectingSpoken} Retry`}
    >
      <span className="conn-dot" aria-hidden="true" />
      <span className="phone-conn-label">{label}</span>
      <span className="phone-conn-act">Retry</span>
    </button>
  );
}

/** The status bar (and a desktop app's title bar) on the page's own ground: theme-color
 *  follows the applied skin and scheme, not only the OS's, so a forced Dark or Paper
 *  shows no light band at the top. Read as sRGB through a 1 px canvas, since a token may
 *  be oklch, which not every browser takes there. */
function useThemeColor(): void {
  const display = useSettings();
  useEffect(() => {
    void display;
    let raf = 0;
    const sync = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const g = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
        if (!g) return;
        g.fillStyle = getComputedStyle(document.body).backgroundColor;
        g.fillRect(0, 0, 1, 1);
        const [r = 0, gr = 0, b = 0] = g.getImageData(0, 0, 1, 1).data;
        const hex = `#${[r, gr, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
        for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
          m.removeAttribute("media");
          if (m.getAttribute("content") !== hex) m.setAttribute("content", hex);
        }
      });
    };
    sync();
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    mq?.addEventListener("change", sync);
    return () => {
      cancelAnimationFrame(raf);
      mq?.removeEventListener("change", sync);
    };
  }, [display]);
}

/** "Edit labels…" is a dialog: its code loads just after the first paint, not with it
 *  (it renders nothing until asked, so there is nothing to stand in for). */
const LabelsDialog = lazy(() => import("./LabelsDialog").then((m) => ({ default: m.LabelsDialog })));
function LabelsHost() {
  return (
    <Suspense fallback={null}>
      <LabelsDialog />
    </Suspense>
  );
}
