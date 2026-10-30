// SPDX-License-Identifier: Apache-2.0
// Owned by: web. Entry: picks the transport (real, or the mock with VITE_MOCK=1 / ?mock=1),
// starts the store and renders the app.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { StoreContext } from "./data/hooks";
import { Store } from "./data/store";
import { createHttpTransport } from "./data/transport";
import { applySettings } from "./lib/theme";
// The stylesheets, one per surface, in cascade order. They land after every component's
// own CSS (select, menu, palette, control…), which is why they come after ./app: keep
// this block where it is. tokens.css stays one file (themes/host/api.ts reads it); the
// shared pieces come before the pages that use them; narrow.css and density.css patch
// what precedes them and stay last.
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/pull.css";
import "./styles/shared.css";
import "./styles/board.css";
import "./styles/brand.css";
import "./styles/session.css";
import "./styles/feed.css";
import "./styles/machines.css";
import "./styles/connect.css";
import "./styles/quick-settings.css";
import "./styles/more.css";
import "./styles/split.css";
import "./styles/tabstrip.css";
import "./styles/inbox.css";
import "./styles/notifications.css";
import "./styles/toasts.css";
import "./styles/review.css";
import "./styles/settings.css";
import "./styles/lens.css";
import "./styles/chat.css";
import "./styles/keyboard.css";
import "./styles/shortcuts.css";
import "./styles/transitions.css";
import "./styles/narrow.css";
import "./styles/density.css";

applySettings();

const isMockMode = () => import.meta.env.VITE_MOCK === "1" || new URLSearchParams(location.search).get("mock") === "1";

async function boot() {
  // Inside the native app: its adapter first (it may put up the welcome instead).
  const native = "sessionpipeShell" in window ? await import("./native/shell") : null;
  if (native && (await native.start())) return;
  const transport = isMockMode() ? (await import("./mock/index")).createMockTransport() : createHttpTransport();
  const store = new Store(transport);
  store.start();
  native?.markFirstSnapshot(store);
  // Install-only service worker (public/sw.js): it caches nothing. Secure contexts only,
  // which is where "Add to Home Screen" and the app badge exist anyway.
  if ("serviceWorker" in navigator && !isMockMode()) navigator.serviceWorker.register("/sw.js").catch(() => {});
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <StoreContext.Provider value={store}>
        <App />
      </StoreContext.Provider>
    </StrictMode>,
  );
}

void boot();
