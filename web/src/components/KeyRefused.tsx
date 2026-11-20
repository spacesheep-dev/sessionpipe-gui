// SPDX-License-Identifier: Apache-2.0
// The page when the receiver refuses its key (data/store.ts `keyRefused`): it asks for
// the board's link again. Drawn by app.tsx in place of the whole shell, so it says one
// thing, at the measure of the other empty states (EmptyState) and the page's gutter. In a browser: where
// the link is. In the phone app: the same, and the first run's own camera
// (PhoneOnboarding, opened at the scan), which keeps the new key for this receiver and
// opens the board again. In the desktop app (and a phone with no camera): Receivers…,
// Settings › App's list, where the board's link is added again. "Try again" opens the stream again (the link opened in another
// tab of this browser, say).
import { lazy, Suspense, useState } from "react";
import { useStore } from "../data/hooks";
import { KEY_REFUSED } from "../lib/keyWords";
import { navigate } from "../lib/router";
import { features, shellInfo } from "../native/shell";
import { EmptyState } from "./bits";

const Onboarding = lazy(() => import("../native/PhoneOnboarding").then((m) => ({ default: m.Onboarding })));

/** Settings › App, where the app's receivers are listed and one is added again (app.tsx
 *  draws that page, and only that one, while the key is refused). */
export const RECEIVERS_PATH = "/settings?section=app";

export function KeyRefused() {
  const store = useStore();
  const [scanning, setScanning] = useState(false);
  const shell = shellInfo();
  const phone = shell?.platform === "ios" || shell?.platform === "android";
  const scan = !!shell && phone && features().has("scanner");
  if (scanning && shell)
    return (
      <Suspense fallback={null}>
        <Onboarding info={shell} start={{ kind: "scan", status: "asking" }} />
      </Suspense>
    );
  return (
    <main className="key-refused" id="main" data-key-refused>
      <EmptyState
        center
        title={KEY_REFUSED.title}
        actions={
          <>
            {scan && (
              <button type="button" className="btn btn--primary" onClick={() => setScanning(true)}>
                {KEY_REFUSED.scan}
              </button>
            )}
            {shell && !scan && (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => navigate(RECEIVERS_PATH)}
                data-key-refused-receivers
              >
                {KEY_REFUSED.receivers}
              </button>
            )}
            <button type="button" className={shell ? "btn btn--ghost" : "btn"} onClick={() => store.reconnect()}>
              {KEY_REFUSED.again}
            </button>
          </>
        }
      >
        <p>{!shell ? KEY_REFUSED.browser : scan ? KEY_REFUSED.phone : KEY_REFUSED.app}</p>
      </EmptyState>
    </main>
  );
}
