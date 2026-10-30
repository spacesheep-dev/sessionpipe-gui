// SPDX-License-Identifier: Apache-2.0
// The window: a sidebar on the chrome ground (a labelled source list when there is room,
// a compact icon rail otherwise), a bottom tab bar on phones. Carries the connection
// indicator, the display popover, and one entry per installed theme plugin
// (web/src/themes/host), routed to /t/<id>. The tab bar holds the first four pages and a
// More tab whose sheet lists the rest (pages, installed views, Display and Settings).
// Every sidebar entry has a right-click menu, and so does the sidebar itself (appearance,
// skin, mode); MenuHost here is the one context-menu policy for the whole app. On a phone
// it also keeps the status bar on the page's ground (theme-color), scrolls a page to its
// top when its tab is tapped again, mounts pull to refresh on the list pages
// (PullRefresh), and shows a dropped stream as a pill under the bar, which that same
// pull retries. The wide sidebar ends with what each account has left (UsageGlance.tsx),
// which the phone reaches as More › Usage.
import type { InstalledTheme } from "@shared/theme-api";
import { type CSSProperties, Fragment, lazy, type ReactNode, Suspense, useEffect, useRef, useState } from "react";
import { ComposeButton, NewSessionHost, useNewFromUrl, useStandaloneNewKey } from "../control/NewSession";
import { newSessionOpen, openNewSession } from "../control/newSessionState";
import { useAnswerableCount, useAppState, useStore } from "../data/hooks";
import { useGlobalKeys } from "../lib/keys";
import { lazyModule, whenIdle } from "../lib/lazy";
import { linkItems } from "../lib/menus";
import { reducedMotion, usePresence } from "../lib/motion";
import { Link, navigate, type Route, usePath } from "../lib/router";
import { getSettings as getAppSettings, setMode, useSimple } from "../lib/settings";
import { hintFor, useShortcut, useShortcutMap } from "../lib/shortcuts";
import { getSkins, isPlain } from "../lib/skins";
import { restoreSplit, useSplitKey, useSplitWidth } from "../lib/split";
import { getDisplaySettings as getDisplay, setSkin, setTheme, useSettings } from "../lib/theme";
import { useNow } from "../lib/time";
import { WORKFLOWS_ICON_PATHS } from "../orchestrate/workflows/glyphs";
import { RunnerHost } from "../orchestrate/workflows/useRunner";
import { useSetupStatus } from "../setup/api";
import { setupComplete } from "../setup/steps";
import { reloadThemes, setThemeDisabled, useThemes } from "../themes/host/registry";
import { Mark } from "./Brand";
import { MenuHost, type MenuList, useContextMenu } from "./ContextMenu";
import type { MoreSheetProps } from "./MoreSheet";
import { openPalette } from "./Palette";
import { PULL_PAGES, PullRefresh } from "./PullRefresh";
import { QuickSettings } from "./QuickSettings";
import { SessionPanel } from "./SessionPanel";
import { ShortcutHelp } from "./ShortcutHelp";
import { TipHost } from "./Tip";
import { UsageGlance } from "./UsageGlance";

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

/** The phone layout: a tab bar, sheets, large titles (tokens.css switches at the same width). */
export const PHONE_QUERY = "(max-width: 839px)";

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
  connect: (
    <>
      <path d="M8.5 11.5l3-3" />
      <path d="M7 13l-1.5 1.5a2.5 2.5 0 0 1-3.5-3.5L4 9" />
      <path d="M13 7l1.5-1.5a2.5 2.5 0 0 1 3.5 3.5L16 11" />
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
}

const BUILTIN: NavItem[] = [
  { to: "/", key: "board", label: "Board", glyph: ICON.board },
  { to: "/inbox", key: "inbox", label: "Inbox", glyph: ICON.inbox },
  { to: "/search", key: "search", label: "Search", glyph: ICON.search },
  { to: "/feed", key: "feed", label: "Feed", glyph: ICON.feed },
  { to: "/review", key: "review", label: "Review", glyph: ICON.review },
  { to: "/workflows", key: "workflows", label: "Workflows", glyph: ICON.workflows },
  { to: "/machines", key: "machines", label: "Machines", glyph: ICON.machines },
  { to: "/connect", key: "connect", label: "Connect", glyph: ICON.connect },
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
  };
};

const SETUP_ITEM: NavItem = { to: "/setup", key: "setup", label: "Setup", glyph: ICON.setup };

/** Usage is no rail item (the sidebar's Usage lines lead there): on a phone it is a More
 *  row, after Machines. */
const USAGE_ITEM: NavItem = { to: "/usage", key: "usage", label: "Usage", glyph: ICON.usage };
const withUsage = (pages: NavItem[]): NavItem[] => {
  const at = pages.findIndex((n) => n.key === "connect");
  return at < 0 ? [...pages, USAGE_ITEM] : [...pages.slice(0, at), USAGE_ITEM, ...pages.slice(at)];
};

/** The pages Simple mode keeps off the rail (still there through ⌘K and /settings). */
const ADVANCED_ONLY = new Set(["feed", "review"]);

/** Builtins first (Setup among them while this machine is not set up), then installed
 *  themes, the experimental ones of both after a divider. `simple` drops Feed and Review. */
export function navItems(themes: readonly InstalledTheme[], o: { setup?: boolean; simple?: boolean } = {}): NavItem[] {
  const plugins = themes.filter((t) => !t.error && !t.disabled).map(themeNavItem);
  const builtin = o.simple ? BUILTIN.filter((n) => !ADVANCED_ONLY.has(n.key)) : BUILTIN;
  const all = [...builtin, ...(o.setup ? [SETUP_ITEM] : []), ...plugins];
  return [...all.filter((n) => !n.experimental), ...all.filter((n) => n.experimental)];
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
    { label: "Settings…", run: () => navigate("/settings") },
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
}: {
  n: NavItem;
  active: boolean;
  action: string | undefined;
  needs: number;
  tip: boolean;
  /** The page is open at exactly this entry's address: a tap again goes to its top. */
  here: boolean;
}) {
  const menu = useContextMenu(() => navMenu(n, action), { title: () => n.label });
  const keys = action ? hintFor(action) : "";
  return (
    <Link
      to={n.to}
      plainClick={here ? toTop : undefined}
      className={`nav-link ${active ? "nav-link--on" : ""}`}
      aria-current={active ? "page" : undefined}
      data-nav={n.key}
      data-tip={tip ? (keys ? `${n.label}   ${keys}` : n.label) : undefined}
      {...menu}
    >
      <NavGlyph n={n} />
      <span className="nav-label">{n.label}</span>
      {n.key === "inbox" && needs > 0 ? (
        <span className="nav-badge num" role="img" aria-label={`${needs} need you`}>
          {needs}
        </span>
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

/** The fifth tab: a sheet with the entries the bar has no room for, as grouped lists:
 *  the pages, the installed views, then Display and Settings. Carries aria-current when
 *  the active page is inside. */
function MoreTab({ items, active, views }: { items: NavItem[]; active: string; views: NavItem[] }) {
  const [open, setOpen] = useState(false);
  const [display, setDisplay] = useState(false);
  const plugins = items.filter((n) => n.key.startsWith("t:"));
  const pages = withUsage(items.filter((n) => !n.key.startsWith("t:")));
  const inside = [...pages, ...plugins].some((n) => n.key === active);
  const { mounted, closing } = usePresence(open);
  // A route change closes the sheet, whichever tab was tapped.
  useEffect(() => setOpen(false), [active]);
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

/** The More sheet is a phone's alone: its code is fetched when a phone is idle after load
 *  (so the first tap opens it at once), never on a desktop. */
const moreSheet = lazyModule(() => import("./MoreSheet"));
if (typeof window !== "undefined" && window.matchMedia?.(PHONE_QUERY).matches)
  whenIdle(() => void moreSheet.preload().catch(() => {}));
function MoreSheetHost(p: MoreSheetProps) {
  const m = moreSheet.use();
  return m ? <m.MoreSheet {...p} /> : null;
}

/** The sidebar's two forms: the labelled one from 1200 px (1360 with the panel open). */
function useSideForm(splitOpen: boolean): boolean {
  const wide = useMedia("(min-width: 1200px)");
  const wider = useMedia("(min-width: 1360px)");
  return wider || (wide && !splitOpen);
}

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
  const needs = useAnswerableCount();
  // The Setup entry, with its orange dot, while this machine (and only from this machine:
  // elsewhere the status is 403) still has steps to go.
  const setup = useSetupStatus();
  const known = setup.local === false || !!setup.status || !!setup.error;
  const showSetup = known ? setup.local === true && !!setup.status && !setupComplete(setup.status) : readSetupHint();
  useEffect(() => {
    if (known) writeSetupHint(showSetup);
  }, [known, showSetup]);
  const simple = useSimple();
  const nav = navItems(useThemes().themes, { setup: showSetup, simple });
  const phone = useMedia(PHONE_QUERY);
  useResize();
  useThemeColor();
  // Boot: the last visit's tabs when the URL carries none.
  useEffect(() => {
    restoreSplit();
  }, []);
  const splitOpen = useSplitKey() !== null;
  const splitWidth = useSplitWidth();
  const side = useSideForm(splitOpen && !phone);
  const railMenuProps = useContextMenu(railMenu, { title: () => "sessionpipe gui" });
  // A route change moves focus to the page (not on the first paint, where Tab must start
  // at the skip link) and says the page's name through the live region.
  const mainRef = useRef<HTMLElement>(null);
  const [announce, setAnnounce] = useState("");
  const path = usePath().split("?")[0] ?? "/";
  // The path last seen, not a first-run flag: StrictMode runs the effect twice on mount.
  const lastPath = useRef(path);
  useEffect(() => {
    if (lastPath.current === path) return;
    lastPath.current = path;
    mainRef.current?.focus({ preventScroll: true });
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
  // `g 1` … `g 9`: the n-th installed view, in rail order.
  const views = nav.filter((n) => n.key.startsWith("t:"));
  for (let i = 1; i <= 9; i++) {
    useShortcut(`nav.view${i}`, () => {
      const v = views[i - 1];
      if (!v) return false;
      navigate(v.to);
    });
  }
  const shellStyle = { "--split-width": `${splitOpen && !phone ? splitWidth : 0}px` } as CSSProperties;
  const entry = (n: NavItem, tip: boolean) => (
    <NavEntry
      key={n.key}
      n={n}
      active={active === n.key}
      action={navAction(n, views)}
      needs={needs}
      tip={tip}
      here={path === n.to || (n.key === "search" && active === "search")}
    />
  );
  const firstView = nav.findIndex((n) => n.key.startsWith("t:") && !n.experimental);
  // The tab bar keeps its four; Workflows is a page for the More sheet on a phone.
  const tabs = nav.filter((n) => n.key !== "workflows").slice(0, TABS);
  return (
    <div
      className={`shell ${splitOpen && !phone ? "shell--split" : ""} ${side && !phone ? "shell--side" : ""}`}
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
      <nav className="rail" aria-label="Pages" {...railMenuProps}>
        <div className="rail-head">
          <Link to="/" className="rail-brand" title="sessionpipe gui">
            <Mark size={28} />
            <span className="rail-word brand-name" aria-hidden="true" />
            <span className="sr-only">sessionpipe gui</span>
          </Link>
          <ComposeButton className="rail-compose" />
        </div>
        <div className="rail-nav">
          {nav.map((n, i) => (
            <Fragment key={n.key}>
              {i === firstView ? (
                <div className="rail-section" aria-hidden="true">
                  Views
                </div>
              ) : null}
              {n.experimental && !nav[i - 1]?.experimental ? (
                <>
                  {/* A hairline in the rail; in the sidebar the label below. data-nav keeps the divider's name for the tests. */}
                  <hr
                    className="rail-group"
                    data-nav="experimental"
                    title="Experimental views"
                    aria-label="Experimental views"
                  />
                  <div className="rail-section" aria-hidden="true">
                    Experimental
                  </div>
                </>
              ) : null}
              {entry(n, !side)}
            </Fragment>
          ))}
        </div>
        {side && !phone && <UsageGlance here={route.name === "usage"} />}
        <div className="rail-foot">
          <ConnectionPill />
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
          <QuickSettings placement="rail" />
          <Link
            to="/settings"
            className={`theme-btn ${route.name === "settings" ? "nav-link--on" : ""}`}
            data-tip="Settings"
            data-tip-side="top"
            aria-label="Settings"
            aria-current={route.name === "settings" ? "page" : undefined}
            data-nav="settings"
          >
            <SlidersIcon />
          </Link>
        </div>
      </nav>
      <main className={`main ${route.name === "theme" ? "main--bleed" : ""}`} id="main" ref={mainRef} tabIndex={-1}>
        {children}
      </main>
      <nav className="tabbar" aria-label="Pages">
        {tabs.map((n) => entry(n, false))}
        <MoreTab items={nav.filter((n) => !tabs.includes(n))} active={active} views={views} />
      </nav>
      {phone && <PhoneConn />}
      {phone && PULL_PAGES.has(route.name) && <PullRefresh main={mainRef} />}
      <SessionPanel phone={phone} />
      <ShortcutHelp />
      <LabelsHost />
      <NewSessionHost />
      {/* The workflows' signer: claims and signs a run's ready steps, whichever page is open. */}
      <RunnerHost />
      <MenuHost />
      <TipHost />
    </div>
  );
}

/** How long a drop must last before it is shown: a blip never flickers the footer. */
const RECONNECT_GRACE_MS = 400;

/** The stream's state as the footer says it: what to draw ("live" inside the grace) and
 *  its words. "Reconnecting · 4 s" once a drop has lasted 400 ms, "Offline" when the
 *  device is. */
/** The stream's state in words, after a short grace (a reconnect that lands within it is
 *  never shown). The phone's bar reads it too (PageBar.tsx PhoneSub). */
export function useConnection(): { as: string; label: string; down: boolean } {
  const { connection, retryAt } = useAppState();
  const down = connection === "reconnecting" || connection === "offline";
  const [shown, setShown] = useState(!down);
  useEffect(() => {
    if (!down) {
      setShown(true);
      return;
    }
    setShown(false);
    const t = window.setTimeout(() => setShown(true), RECONNECT_GRACE_MS);
    return () => window.clearTimeout(t);
  }, [down]);
  // The countdown ticks only while there is one.
  const now = useNow(retryAt && shown ? "fine" : "off");
  const wait = retryAt ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0;
  // Inside the grace, the footer still reads as it did.
  const as = down && !shown ? "live" : connection;
  const label =
    as === "live"
      ? "live"
      : as === "connecting"
        ? "Connecting…"
        : as === "offline"
          ? "Offline"
          : wait > 0
            ? `Reconnecting · ${wait} s`
            : "Reconnecting…";
  return { as, label, down: as === "reconnecting" || as === "offline" };
}

/** The stream, honestly: nothing to read while live (a quiet dot; the word stays for
 *  assistive tech), its words and Retry now once it drops. The board keeps its rows
 *  through a drop. */
export function ConnectionPill() {
  const { as, label, down } = useConnection();
  const store = useStore();
  return (
    <span
      className={`conn conn--${as}`}
      role="status"
      aria-live="polite"
      data-tip={as === "live" ? "Live: updates arrive as they happen" : label}
      data-tip-side="top"
    >
      <span className="conn-dot" aria-hidden="true" />
      <span className="conn-label">{label}</span>
      {down ? (
        <button type="button" className="conn-retry" onClick={() => store.reconnect()}>
          Retry now
        </button>
      ) : null}
    </span>
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
  const { as, label, down } = useConnection();
  const store = useStore();
  if (!down) return null;
  return (
    <button
      type="button"
      className={`phone-conn phone-conn--${as}`}
      onClick={() => store.reconnect()}
      aria-label={`${label}. Retry now`}
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
