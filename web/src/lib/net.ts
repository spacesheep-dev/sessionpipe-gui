// SPDX-License-Identifier: Apache-2.0
// The one place the page reaches a receiver. In a browser the page is served by the
// receiver itself: paths stay as they are and the live stream is a real EventSource.
// Inside the native app (window.sessionpipeShell, set by the shell before any script) the
// page is the app's own bundled UI and the shell is the network: every request goes to
// `${rxBase}${path}` (its rx: protocol), and the stream arrives over an IPC channel: the
// native adapter (native/shell.ts, loaded only there, before the transport starts) puts
// its opener in `shellStreams`. Switching receivers reloads the window, so all of this is
// read once.

/** What the page's transport needs of a live stream; EventSource is one. */
export interface EventSourceLike {
  addEventListener(kind: string, fn: (e: { data: string }) => void): void;
  onopen: (() => void) | null;
  onerror: ((e: { retryInMs?: number }) => void) | null;
  close(): void;
}

const shell = (globalThis as { sessionpipeShell?: { rxBase?: string | null; receiver?: { origin?: string } | null } })
  .sessionpipeShell;
const base = shell?.rxBase || "";

/** A receiver URL for a root-relative path ("/api/ui/info"); anything else (another
 *  origin, a data: URL) is returned as it is. */
export const apiUrl = (path: string): string => (path[0] === "/" ? base + path : path);

/** The receiver's own address, for a link a person copies or opens elsewhere (in the
 *  shell the page's origin is the app's). */
export const receiverOrigin = (): string => shell?.receiver?.origin || location.origin;

/** The shell's stream opener, set by the native adapter. */
export const shellStreams: { open?: (path: string) => EventSourceLike } = {};

/** The receiver's live stream at `path`. */
export const openEvents = (path: string): EventSourceLike =>
  shellStreams.open ? shellStreams.open(path) : (new EventSource(path) as unknown as EventSourceLike);
