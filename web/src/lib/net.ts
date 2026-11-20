// SPDX-License-Identifier: Apache-2.0
// The one place the page reaches a receiver. In a browser the page is served by the
// receiver itself: paths stay as they are and the live stream is a real EventSource.
// Inside the native app (window.sessionpipeShell, set by the shell before any script) the
// page is the app's own bundled UI and the shell is the network: every request goes to
// `${rxBase}${path}` (its rx: protocol), and the stream arrives over an IPC channel: the
// native adapter (native/shell.ts, loaded only there, before the transport starts) puts
// its opener in `shellStreams`. Switching receivers reloads the window, so all of this is
// read once.
//
// Every request a page makes of its backend goes through `apiFetch`, and nothing else
// fetches a receiver path (net.guard.test.ts). When the receiver this window shows is a
// spacesheep account (docs/rfcs/08, "The phone on an account") there is no receiver behind
// `rxBase`, only the account's doors: the page carries its own board (account/) and
// answers these requests itself, so none of them reaches the network.

/** What the page's transport needs of a live stream; EventSource is one. */
export interface EventSourceLike {
  addEventListener(kind: string, fn: (e: { data: string }) => void): void;
  onopen: (() => void) | null;
  onerror: ((e: { retryInMs?: number }) => void) | null;
  close(): void;
}

const shell = (
  globalThis as {
    sessionpipeShell?: {
      rxBase?: string | null;
      receiver?: { origin?: string; kind?: string; name?: string } | null;
    };
  }
).sessionpipeShell;
const base = shell?.rxBase || "";

/** A receiver URL for a root-relative path ("/api/ui/info"); anything else (another
 *  origin, a data: URL) is returned as it is. */
export const apiUrl = (path: string): string => (path[0] === "/" ? base + path : path);

/** The receiver this window shows is a spacesheep account: the page answers its own
 *  backend (account/backend.ts), and `rxBase` leads to the account's doors only. */
export const accountMode = (): boolean => shell?.receiver?.kind === "spacesheep" && base !== "";

/** What answers the page's requests instead of the network. */
export type ApiBackend = (path: string, init?: RequestInit) => Promise<Response>;
let backend: ApiBackend | null = null;
let backendCame: (b: ApiBackend) => void = () => {};
const backendComing = new Promise<ApiBackend>((resolve) => {
  backendCame = resolve;
});
/** The page's own backend, put in place before the app renders (main.tsx). */
export function setApiBackend(b: ApiBackend): void {
  backend = b;
  backendCame(b);
}

/** A request to the page's backend, by root-relative path: the receiver in a browser, the
 *  shell's `rx:` protocol in the app, the page itself on a spacesheep account. There a
 *  request made before the backend is in place waits for it: it never goes to `rxBase`,
 *  where no such route exists. */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  if (backend) return backend(path, init);
  if (accountMode()) return backendComing.then((b) => b(path, init));
  return fetch(apiUrl(path), init);
}

/** What an upload is: its bytes as an ArrayBuffer (never a Blob: the app's webview can
 *  hand one to the shell's rx: protocol as an empty stream), how far it got, and a way to
 *  stop it. */
export interface UploadInit {
  method?: "POST" | "PUT";
  headers: Record<string, string>;
  body: ArrayBuffer;
  signal?: AbortSignal;
  /** Bytes sent so far, of `total`; only where `uploadProgress()` says it is known. */
  onProgress?: (sent: number, total: number) => void;
}

/** An upload says how far it got: in a browser on the receiver's own page, whose
 *  XMLHttpRequest counts the bytes as they go. The app's shell and an account's page answer
 *  a request whole, so there only its size is known. */
export const uploadProgress = (): boolean =>
  !backend && !accountMode() && base === "" && typeof XMLHttpRequest === "function";

/** An upload to the page's backend, as `apiFetch`, with its progress where it is known.
 *  A network failure rejects with a TypeError, as fetch does; a stop with an AbortError. */
export function apiUpload(path: string, init: UploadInit): Promise<Response> {
  const { method = "POST", headers, body, signal, onProgress } = init;
  if (!uploadProgress()) return apiFetch(path, { method, headers, body, signal });
  return new Promise((resolve, reject) => {
    const stopped = () => new DOMException("The upload was stopped.", "AbortError");
    if (signal?.aborted) return reject(stopped());
    const x = new XMLHttpRequest();
    x.open(method, apiUrl(path));
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    x.responseType = "arraybuffer";
    x.upload.onprogress = (e) => onProgress?.(e.loaded, e.lengthComputable ? e.total : body.byteLength);
    x.onload = () => {
      if (x.status < 200 || x.status > 599) return reject(new TypeError("Failed to fetch"));
      const h = new Headers();
      for (const line of x
        .getAllResponseHeaders()
        .trim()
        .split(/[\r\n]+/)) {
        const at = line.indexOf(":");
        if (at > 0) h.append(line.slice(0, at).trim(), line.slice(at + 1).trim());
      }
      const empty = x.status === 204 || x.status === 304;
      resolve(new Response(empty ? null : (x.response as ArrayBuffer), { status: x.status, headers: h }));
    };
    x.onerror = () => reject(new TypeError("Failed to fetch"));
    x.onabort = () => reject(stopped());
    signal?.addEventListener("abort", () => x.abort(), { once: true });
    x.send(body);
  });
}

/** The receiver's own address, for a link a person copies or opens elsewhere (in the
 *  shell the page's origin is the app's). */
export const receiverOrigin = (): string => shell?.receiver?.origin || location.origin;

/** The name the app gives the receiver this window shows; undefined in a browser. */
export const receiverName = (): string | undefined => shell?.receiver?.name || undefined;

/** The account this window shows is on spacesheep.dev itself: what the page says of
 *  spacesheep's own rules (what it takes, what it never holds) is said only there. An
 *  account on another server of the same kind is that server's to speak for. */
export const onSpacesheepDev = (): boolean => accountMode() && receiverOrigin() === "https://spacesheep.dev";

/** A session's own page on the spacesheep account this window shows (`/sessions?s=<id>`
 *  there): the one address of the app's a person on an account can open or hand to
 *  somebody. The app's own paths (`/s/…`, `/feed`) are not pages spacesheep has. */
export const accountSessionUrl = (sessionId: string): string =>
  `${receiverOrigin()}/sessions?s=${encodeURIComponent(sessionId)}`;

/** The shell's stream opener, set by the native adapter. */
export const shellStreams: { open?: (path: string) => EventSourceLike } = {};

/** The receiver's live stream at `path`. */
export const openEvents = (path: string): EventSourceLike =>
  shellStreams.open ? shellStreams.open(path) : (new EventSource(path) as unknown as EventSourceLike);
