// SPDX-License-Identifier: Apache-2.0
import { useEffect } from "react";
import { Palette } from "./components/Palette";
import { Settings } from "./components/Settings";
import { Shell } from "./components/Shell";
import { Toasts } from "./components/Toasts";
import { AddDevicePage } from "./control/AddDevice";
import { PairPage } from "./control/Pair";
import { useAnswerableCount, useAppState } from "./data/hooks";
import { titlePrefix, useAttentionEffects } from "./lib/notify";
import { Link, navigate, parseRoute, usePath, useRoute } from "./lib/router";
import { getSettings } from "./lib/settings";
import { Board } from "./pages/Board";
import { Connect } from "./pages/Connect";
import { Feed } from "./pages/Feed";
import { Inbox } from "./pages/Inbox";
import { Machines } from "./pages/Machines";
import { Review } from "./pages/Review";
import { SessionPage } from "./pages/Session";
import { Setup } from "./pages/Setup";
import { Shortcuts } from "./pages/Shortcuts";
import { Themes } from "./pages/Themes";
import { PhonePage } from "./phone/PhonePage";
import { markSetupSeen, setupSeen, useSetupStatus } from "./setup/api";
import { needsSetup } from "./setup/steps";
import { fetchThemes, useThemes } from "./themes/host/registry";
import { ThemePage } from "./themes/host/ThemePage";

const TITLES: Record<string, string> = {
  board: "Board",
  inbox: "Inbox",
  feed: "Feed",
  review: "Review",
  machines: "Machines",
  connect: "Connect",
  setup: "Setup",
  session: "Session",
  pair: "Pair a machine",
  "add-device": "Add this device",
  phone: "Your phone",
  themes: "Views",
  settings: "Settings",
  shortcuts: "Keyboard shortcuts",
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
  // render: `route` is a fresh object every render, so it cannot be the dependency).
  const pathname = usePath().split("?")[0] ?? "/";
  useEffect(() => {
    if (parseRoute(pathname).name !== "session") window.scrollTo({ top: 0 });
  }, [pathname]);
  // The installed themes: at boot, and again each time the stream (re)connects, since a
  // reconnect may follow a restart with themes added or removed.
  useEffect(() => {
    if (connection === "live") void fetchThemes();
  }, [connection]);
  useEffect(() => {
    void fetchThemes();
  }, []);
  // First run: a brand-new machine (no event yet, TLS mode off, or its daemon not paired)
  // lands on /setup once per device; "Skip setup" or the first visit remembers it.
  const setup = useSetupStatus();
  useEffect(() => landOnDefaultPage(), []);
  useEffect(() => {
    if (route.name !== "board" || setup.local !== true || !setup.status) return;
    if (!needsSetup(setup.status) || setupSeen()) return;
    markSetupSeen();
    navigate("/setup", { replace: true });
  }, [route.name, setup.local, setup.status]);
  return (
    <Shell route={route}>
      {route.name === "board" && <Board />}
      {route.name === "inbox" && <Inbox />}
      {route.name === "session" && (
        <SessionPage key={`${route.harness}:${route.id}`} harness={route.harness} id={route.id} />
      )}
      {route.name === "feed" && <Feed />}
      {route.name === "review" && <Review />}
      {route.name === "machines" && <Machines />}
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
      {route.name === "theme" && <ThemePage key={route.id} id={route.id} />}
      {route.name === "pair" && <PairPage key={route.code} code={route.code} />}
      {route.name === "add-device" && <AddDevicePage />}
      {route.name === "phone" && <PhonePage />}
      {route.name === "missing" && (
        <>
          <p className="page-note" data-missing>
            No page at {route.path}. <Link to="/">Board →</Link>
          </p>
          <Board />
        </>
      )}
      <Palette />
      <Toasts />
    </Shell>
  );
}
