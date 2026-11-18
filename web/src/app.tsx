// SPDX-License-Identifier: Apache-2.0
// The app: the shell, the page for the route, the palette and the toasts. Two decisions
// live here. A first run lands on /setup before anything paints: on a device that has
// not seen setup, the board waits (blank under the shell) for the setup status instead of
// flashing and then redirecting. And Back puts a list page (Board, Inbox, Feed, Machines)
// back where it was left: its scroll here, its cursor in lib/keys.ts, its open trees in
// the settings that already keep them.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApprovePhonePage } from "./account/ApproveRoute";
import { KeyRefused } from "./components/KeyRefused";
import { PageBar } from "./components/PageBar";
import { Palette } from "./components/Palette";
import { Settings } from "./components/Settings";
import { OverPage, Shell } from "./components/Shell";
import { Toasts } from "./components/Toasts";
import { AddDevicePage } from "./control/AddDevice";
import { resetInfoCache } from "./control/api";
import { PairPage } from "./control/Pair";
import { useStartTitles } from "./control/Starting";
import { useAnswerableCount, useAppState } from "./data/hooks";
import { markRestoring } from "./lib/keys";
import { landingFor, type Opened } from "./lib/landing";
import { accountMode } from "./lib/net";
import { titlePrefix, useAttentionEffects } from "./lib/notify";
import { Link, navigate, parseRoute, usePath, useRoute } from "./lib/router";
import { getSettings } from "./lib/settings";
import { NEW_WORDS, thisPhone } from "./native/accountWords";
import { isShell } from "./native/shell";
import { Workflows } from "./orchestrate/workflows/Workflows";
import { Board } from "./pages/Board";
import { Connect } from "./pages/Connect";
import { Feed } from "./pages/Feed";
import { Inbox } from "./pages/Inbox";
import { Machines } from "./pages/Machines";
import { Review } from "./pages/Review";
import { Search } from "./pages/Search";
import { SessionPage } from "./pages/Session";
import { Setup } from "./pages/Setup";
import { Shortcuts } from "./pages/Shortcuts";
import { Themes } from "./pages/Themes";
import { Usage } from "./pages/Usage";
import { PhonePage } from "./phone/PhonePage";
import { markSetupSeen, refreshSetup, setupSeen, useSetupStatus } from "./setup/api";
import { needsSetup } from "./setup/steps";
import { fetchThemes, useThemes } from "./themes/host/registry";
import { ThemeRoute } from "./themes/host/ThemeRoute";

const TITLES: Record<string, string> = {
  board: "Board",
  inbox: "Inbox",
  feed: "Feed",
  review: "Review",
  workflows: "Workflows",
  workflow: "Workflow",
  workflowRun: "Run",
  search: "Search",
  machines: "Machines",
  usage: "Usage",
  connect: "Connect",
  setup: "Setup",
  session: "Session",
  pair: "Pair a machine",
  "add-device": "Add this device",
  phone: "Your phone",
  themes: "Views",
  settings: "Settings",
  shortcuts: "Keyboard shortcuts",
  missing: "Not found",
};

/** The address the app was opened at, read as the page loads: before the side panel puts
 *  the last visit's tabs back into it (Shell's boot effect runs before App's). */
const opened: Opened = {
  at: location.pathname + location.search,
  asked: !!(history.state as { asked?: unknown } | null)?.asked,
};

/** Once per page load: the app lands on the page the device chose (Settings › General ›
 *  Open on), where the rule says so (lib/landing.ts). The tabs put back come along
 *  (navigate keeps `?s=` and `&t=`), and a page the app has moved to since it opened (a
 *  first run's Setup) is left alone. */
let landed = false;
function landOnDefaultPage(): void {
  if (landed) return;
  landed = true;
  const page = landingFor(opened, getSettings().defaultPage);
  if (page && location.pathname === "/") navigate(page, { replace: true });
}

export function App() {
  const route = useRoute();
  const { connection, keyRefused, infoRev } = useAppState();
  // What Info says changed (the board's key): what was read of it is read again.
  useEffect(() => {
    if (!infoRev) return;
    resetInfoCache();
    void refreshSetup().catch(() => {});
  }, [infoRev]);
  const { themes } = useThemes();
  const themeName = route.name === "theme" ? themes.find((t) => t.id === route.id)?.name : undefined;
  // "(n) " ahead of every title while n answerable prompts are open (lib/notify.ts).
  const open = useAnswerableCount();
  useAttentionEffects();
  useEffect(() => {
    // On a spacesheep account that address is the page that approves this phone, and is
    // named (and announced) as that page names itself.
    const own = route.name === "add-device" && accountMode() ? NEW_WORDS.machinesApprove(thisPhone()) : undefined;
    document.title = `${titlePrefix(open)}${themeName ?? own ?? TITLES[route.name] ?? "sessionpipe"} · sessionpipe gui`;
  }, [route, themeName, open]);
  // To the top when the path changes (not on a `?s=` tab change, not on a stream-driven
  // render: `route` is a fresh object every render, so it cannot be the dependency);
  // back to where it was when Back brought a list page back.
  const pathname = usePath().split("?")[0] ?? "/";
  useScrollPlace(pathname);
  // The installed themes: at boot, and again each time the stream (re)connects, since a
  // reconnect may follow a restart with themes added or removed.
  // A spacesheep account has no receiver to install a view on: nothing to read.
  const account = accountMode();
  useEffect(() => {
    if (connection === "live" && !account) void fetchThemes();
  }, [connection, account]);
  useEffect(() => {
    if (!account) void fetchThemes();
  }, [account]);
  // First run: a brand-new machine (no event yet, TLS mode off, or its daemon not paired)
  // lands on /setup once per device; "Skip setup" or the first visit remembers it. Until
  // the status says which, a device that has not seen setup shows nothing under the shell
  // (for at most FIRST_RUN_WAIT_MS): never the board for a frame, then the redirect.
  const setup = useSetupStatus();
  // Every list names a session started here by its first message (lib/format.ts sessionTitle).
  useStartTitles();
  useEffect(() => landOnDefaultPage(), []);
  const [deciding, setDeciding] = useState(() => route.name === "board" && !setupSeen());
  useEffect(() => {
    if (!deciding) return;
    const t = window.setTimeout(() => setDeciding(false), FIRST_RUN_WAIT_MS);
    return () => window.clearTimeout(t);
  }, [deciding]);
  useLayoutEffect(() => {
    if (route.name !== "board") {
      if (deciding) setDeciding(false);
      return;
    }
    if (setup.local === false || setup.error) {
      setDeciding(false);
      return;
    }
    if (setup.local !== true || !setup.status) return;
    if (needsSetup(setup.status) && !setupSeen()) {
      markSetupSeen();
      navigate("/setup", { replace: true });
    }
    setDeciding(false);
  }, [route.name, setup.local, setup.status, setup.error, deciding]);
  // The receiver refused this page's key: the link is asked for again. In the native app
  // Settings (where its receivers are) opens over that page; no other page does.
  if (keyRefused)
    return route.name === "settings" && isShell() ? (
      <>
        <KeyRefused />
        <Settings />
      </>
    ) : (
      <KeyRefused />
    );
  // On an account, the pages that are a receiver's own doing are not pages at all.
  if (account && RECEIVER_ONLY.has(route.name))
    return (
      <Shell route={route}>
        <NoReceiver />
        <OverPage>
          <Palette />
          <Toasts />
        </OverPage>
      </Shell>
    );
  return (
    <Shell route={route}>
      {route.name === "board" && !deciding && <Board />}
      {route.name === "inbox" && <Inbox />}
      {route.name === "session" && (
        <SessionPage key={`${route.harness}:${route.id}`} harness={route.harness} id={route.id} />
      )}
      {route.name === "feed" && <Feed />}
      {route.name === "review" && <Review />}
      {route.name === "workflows" && <Workflows view="list" />}
      {route.name === "workflow" && <Workflows key={route.id} view="workflow" id={route.id} />}
      {route.name === "workflowRun" && <Workflows key={route.id} view="run" id={route.id} />}
      {route.name === "search" && <Search />}
      {route.name === "machines" && <Machines />}
      {route.name === "usage" && <Usage />}
      {route.name === "connect" && <Connect />}
      {route.name === "setup" && <Setup />}
      {route.name === "themes" && <Themes />}
      {route.name === "shortcuts" && <Shortcuts />}
      {route.name === "settings" && (
        <>
          <Board />
          <Settings />
        </>
      )}
      {route.name === "theme" && <ThemeRoute key={route.id} id={route.id} />}
      {route.name === "pair" && <PairPage key={route.code} code={route.code} />}
      {route.name === "add-device" &&
        // On a spacesheep account this is "Approve this iPhone": the phone's own key is
        // approved on spacesheep, not by a device of this receiver.
        (account ? <ApprovePhonePage /> : <AddDevicePage />)}
      {route.name === "phone" && <PhonePage />}
      {route.name === "missing" && <Missing path={route.path} />}
      <OverPage>
        <Palette />
        <Toasts />
      </OverPage>
    </Shell>
  );
}

/** The routes of pages only a receiver has: its workflows, its views, its address and
 *  token, its own setup, pairing a machine or a phone with it. */
const RECEIVER_ONLY: ReadonlySet<string> = new Set([
  "workflows",
  "workflow",
  "workflowRun",
  "connect",
  "setup",
  "themes",
  "theme",
  "pair",
  "phone",
]);

/** How long a first run waits for the setup status before it shows the board anyway. */
const FIRST_RUN_WAIT_MS = 3000;

/** Where each list page was scrolled to, by path, for Back. */
const scrolled = new Map<string, number>();
const LIST_PAGES = new Set(["board", "inbox", "feed", "machines", "search", "workflows"]);
/** Each history entry this page made is stamped with its place in the walk, so a path
 *  change can tell Back (an entry stamped earlier) from a new page (no stamp yet). The
 *  popstate event cannot: the router reads the URL on any render, and a live stream
 *  renders before popstate arrives. */
let walk = 0;
const STAMP = "__spguiWalk";
function arrivedByBack(): boolean {
  const at = (history.state as Record<string, unknown> | null)?.[STAMP];
  if (typeof at === "number" && at < walk) {
    walk = at;
    return true;
  }
  walk = typeof at === "number" ? at : walk + 1;
  if (typeof at !== "number") history.replaceState({ ...(history.state ?? {}), [STAMP]: walk }, "");
  return false;
}

/** Scroll on a path change: to the top, except a session page (it anchors itself) and a
 *  list page that Back brought back, which returns to where it was. The cursor follows
 *  in useListNav (lib/keys.ts), the open subagent trees and the Done group keep their own
 *  state. */
function useScrollPlace(pathname: string): void {
  // Remember the place of the page being left, as it scrolls.
  useEffect(() => {
    if (!LIST_PAGES.has(parseRoute(pathname).name)) return;
    let raf = 0;
    const on = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        scrolled.set(pathname, window.scrollY);
      });
    };
    window.addEventListener("scroll", on, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", on);
    };
  }, [pathname]);
  // Read once per path change, in the render that mounts the page (its cursor reads it).
  const seen = useRef<{ path: string; back: boolean } | null>(null);
  if (seen.current?.path !== pathname) seen.current = { path: pathname, back: arrivedByBack() };
  const back = seen.current.back && LIST_PAGES.has(parseRoute(pathname).name);
  markRestoring(back);
  // `back` is read for this path change only.
  useLayoutEffect(() => {
    const name = parseRoute(pathname).name;
    if (name === "session") return;
    const y = back ? scrolled.get(pathname) : undefined;
    if (y === undefined) {
      window.scrollTo({ top: 0 });
      return;
    }
    // The page paints its rows in this commit; the stream may add the last ones a frame
    // later, so the place is set now and once more after the next frame.
    window.scrollTo({ top: y });
    const raf = requestAnimationFrame(() => window.scrollTo({ top: y }));
    return () => cancelAnimationFrame(raf);
  }, [pathname]);
  useEffect(() => {
    markRestoring(false);
  });
}

/** A page only a receiver has, named by an address while the window shows a spacesheep
 *  account: one line that says so, and the way back to the board. */
function NoReceiver() {
  return (
    <div className="page missing">
      <PageBar title="Not available here" />
      <div className="state state--center" data-no-receiver>
        <h2 className="state-title">This needs a sessionpipe-gui server</h2>
        <p className="state-text">This app is showing a spacesheep account, which has none.</p>
        <div className="state-actions">
          <Link to="/" className="btn btn--primary">
            Go to Board
          </Link>
        </div>
      </div>
    </div>
  );
}

/** A path the app has no page for: an empty state where the page would be, and the way
 *  back to the board. Nothing is rendered under it. */
function Missing({ path }: { path: string }) {
  return (
    <div className="page missing">
      <PageBar title="Not found" />
      <div className="state state--center" data-missing>
        <h2 className="state-title">This page doesn't exist</h2>
        <p className="state-text">
          No page at <code>{path}</code>.
        </p>
        <div className="state-actions">
          <Link to="/" className="btn btn--primary">
            Go to Board
          </Link>
        </div>
      </div>
    </div>
  );
}
