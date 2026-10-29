// SPDX-License-Identifier: Apache-2.0
// The app: the shell, the page for the route, the palette and the toasts. Two decisions
// live here. A first run lands on /setup before anything paints: on a device that has
// not seen setup, the board waits (blank under the shell) for the setup status instead of
// flashing and then redirecting. And Back puts a list page (Board, Inbox, Feed, Machines)
// back where it was left: its scroll here, its cursor in lib/keys.ts, its open trees in
// the settings that already keep them.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PageBar } from "./components/PageBar";
import { Palette } from "./components/Palette";
import { Settings } from "./components/Settings";
import { Shell } from "./components/Shell";
import { Toasts } from "./components/Toasts";
import { AddDevicePage } from "./control/AddDevice";
import { PairPage } from "./control/Pair";
import { useStartTitles } from "./control/Starting";
import { useAnswerableCount, useAppState } from "./data/hooks";
import { markRestoring } from "./lib/keys";
import { titlePrefix, useAttentionEffects } from "./lib/notify";
import { Link, navigate, parseRoute, usePath, useRoute } from "./lib/router";
import { getSettings } from "./lib/settings";
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
import { markSetupSeen, setupSeen, useSetupStatus } from "./setup/api";
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

/** Once per page load: the app opened at its root lands on the page the device chose
 *  (Settings › General), unless the URL carries anything (a key, the mock, a split). */
let landed = false;
function landOnDefaultPage(): void {
  if (landed) return;
  landed = true;
  const page = getSettings().defaultPage;
  if (page === "/" || location.pathname !== "/" || location.search) return;
  navigate(page, { replace: true });
}

export function App() {
  const route = useRoute();
  const { connection } = useAppState();
  const { themes } = useThemes();
  const themeName = route.name === "theme" ? themes.find((t) => t.id === route.id)?.name : undefined;
  // "(n) " ahead of every title while n answerable prompts are open (lib/notify.ts).
  const open = useAnswerableCount();
  useAttentionEffects();
  useEffect(() => {
    document.title = `${titlePrefix(open)}${themeName ?? TITLES[route.name] ?? "sessionpipe"} · sessionpipe gui`;
  }, [route, themeName, open]);
  // To the top when the path changes (not on a `?s=` tab change, not on a stream-driven
  // render: `route` is a fresh object every render, so it cannot be the dependency);
  // back to where it was when Back brought a list page back.
  const pathname = usePath().split("?")[0] ?? "/";
  useScrollPlace(pathname);
  // The installed themes: at boot, and again each time the stream (re)connects, since a
  // reconnect may follow a restart with themes added or removed.
  useEffect(() => {
    if (connection === "live") void fetchThemes();
  }, [connection]);
  useEffect(() => {
    void fetchThemes();
  }, []);
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
      {route.name === "add-device" && <AddDevicePage />}
      {route.name === "phone" && <PhonePage />}
      {route.name === "missing" && <Missing path={route.path} />}
      <Palette />
      <Toasts />
    </Shell>
  );
}

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
