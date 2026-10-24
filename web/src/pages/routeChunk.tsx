// SPDX-License-Identifier: Apache-2.0
// The pages a person opens now and then (Setup, Connect, Machines, /phone, pairing, Views,
// Shortcuts, Settings) stay out of the first load. Each route's module is fetched once the
// app is idle after load (lib/lazy.ts), so opening it later is as instant as before; asked
// for sooner, the page's own bar stands in for the few milliseconds the local fetch takes
// (the same frame the page itself would paint first), never a spinner.
import { PageBar } from "../components/PageBar";
import { type LazyModule, lazyModule, whenIdle } from "../lib/lazy";

/** A route's module, warmed when the app is idle, or at once when `now` (the page a first
 *  run is about to open). */
export function routeChunk<T>(load: () => Promise<T>, now = false): LazyModule<T> {
  const mod = lazyModule(load);
  const warm = () => void mod.preload().catch(() => {});
  if (now) warm();
  else whenIdle(warm);
  return mod;
}

/** The page's frame and title while its module arrives: what it paints first anyway. */
export function PageStandIn({ className, title }: { className: string; title: string }) {
  return (
    <div className={`page page--doc ${className}`} aria-busy="true">
      <PageBar title={title} />
    </div>
  );
}
