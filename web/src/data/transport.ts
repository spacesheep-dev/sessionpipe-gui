// SPDX-License-Identifier: Apache-2.0
// Everything that crosses the wire goes through a Transport: the real one speaks SSE and
// fetch to our own origin, the mock one (web/src/mock) simulates a server in the page.
import type {
  DetailQuery,
  Digest,
  DigestQuery,
  FeedPage,
  FeedQuery,
  FilesPage,
  FilesQuery,
  Info,
  Labels,
  LabelsPatch,
  SearchIndexStatus,
  SessionDetail,
  StreamMessage,
} from "@shared/api";
import { ROUTES } from "@shared/api";
import { apiUrl, type EventSourceLike, openEvents } from "../lib/net";
import type { SearchClient } from "../search/types";

export interface StreamHandlers {
  onMessage(m: StreamMessage): void;
  onOpen(): void;
  /** Called on each failed attempt with the delay before the next one. */
  onError(retryInMs: number): void;
}

export interface Transport {
  /** Opens the stream and keeps it open with backoff until the returned function is called. */
  openStream(h: StreamHandlers): () => void;
  info(): Promise<Info>;
  session(harness: string, id: string, q: DetailQuery): Promise<SessionDetail>;
  feed(q: FeedQuery): Promise<FeedPage>;
  /** The Review page: files changed since a time, a day's digest. */
  files(q: FilesQuery): Promise<FilesPage>;
  digest(q: DigestQuery): Promise<Digest>;
  forget(harness: string, id: string): Promise<void>;
  rotateToken(): Promise<{ sinkToken: string }>;
  demo(on: boolean): Promise<{ on: boolean }>;
  /** URL for the QR image, or null when there is none (mock). */
  qrUrl(): string | null;
  /** The person's colour labels, and a merge into them (`null` clears); the change also
   *  arrives as a `labels` stream frame on every page. */
  labels(): Promise<Labels>;
  patchLabels(p: LabelsPatch): Promise<Labels>;
  /** Session search (web/src/search): its client arrives with the search code itself. */
  sessionSearch(): Promise<SearchClient>;
}

/** Every StreamMessage kind: EventSource only delivers the named events listened for, so
 *  a kind missing here never reaches the page (a test checks it against StreamMessage). */
export const STREAM_KINDS = [
  "snapshot",
  "event",
  "session",
  "forgotten",
  "machine",
  "stats",
  "control",
  "viewers",
  "suggestion",
  "labels",
  "viewState",
  "searchIndex",
] as const satisfies readonly StreamMessage["kind"][];
/** Fails to compile while a StreamMessage kind is missing from STREAM_KINDS. */
const _everyKind: Exclude<StreamMessage["kind"], (typeof STREAM_KINDS)[number]> extends never ? true : never = true;
void _everyKind;

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string; reason?: string; message?: string };
      msg = body.message ?? body.error ?? body.reason ?? msg;
    } catch {
      // no body
    }
    throw new HttpError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const get = <T>(url: string) => fetch(apiUrl(url), { headers: { accept: "application/json" } }).then((r) => json<T>(r));
const post = <T>(url: string, body?: unknown) =>
  fetch(apiUrl(url), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => json<T>(r));

const enc = encodeURIComponent;
/** A query string from the defined, non-empty fields of a query object. */
const params = (q: object): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
  return p.toString();
};

export function createHttpTransport(): Transport {
  const searchFrames = new Set<(s: SearchIndexStatus) => void>();
  return {
    openStream(h) {
      let es: EventSourceLike | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let attempt = 0;
      let closed = false;
      const open = () => {
        if (closed) return;
        es = openEvents(ROUTES.ui.stream);
        for (const kind of STREAM_KINDS) {
          es.addEventListener(kind, (ev) => {
            try {
              const m = JSON.parse(ev.data) as StreamMessage;
              if (m.kind === "searchIndex") for (const l of searchFrames) l(m.status);
              h.onMessage(m);
            } catch (err) {
              console.warn("bad stream frame", kind, err);
            }
          });
        }
        es.onopen = () => {
          attempt = 0;
          h.onOpen();
        };
        es.onerror = () => {
          // A new EventSource always starts with a fresh snapshot, so we re-sync by
          // reopening instead of trusting the browser's own retry.
          es?.close();
          es = null;
          const delay = Math.min(15_000, 1000 * 2 ** attempt) * (0.8 + Math.random() * 0.4);
          attempt = Math.min(attempt + 1, 5);
          h.onError(delay);
          timer = setTimeout(open, delay);
        };
      };
      open();
      const onVisible = () => {
        if (document.visibilityState === "visible" && !es && timer) {
          clearTimeout(timer);
          open();
        }
      };
      document.addEventListener("visibilitychange", onVisible);
      return () => {
        closed = true;
        document.removeEventListener("visibilitychange", onVisible);
        if (timer) clearTimeout(timer);
        es?.close();
      };
    },
    info: () => get<Info>(ROUTES.ui.info),
    session: (harness, id, q) => {
      const p = new URLSearchParams();
      if (q.after !== undefined) p.set("after", String(q.after));
      if (q.before !== undefined) p.set("before", String(q.before));
      if (q.tail) p.set("tail", "1");
      if (q.limit !== undefined) p.set("limit", String(q.limit));
      if (q.slim) p.set("slim", "1");
      if (q.slim && q.preview !== undefined) p.set("preview", String(q.preview));
      if (q.agent) p.set("agent", q.agent);
      const qs = p.toString();
      return get<SessionDetail>(`${ROUTES.ui.session}/${enc(harness)}/${enc(id)}${qs ? `?${qs}` : ""}`);
    },
    feed: (q) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
      const qs = p.toString();
      return get<FeedPage>(`${ROUTES.ui.feed}${qs ? `?${qs}` : ""}`);
    },
    files: (q) => get<FilesPage>(`${ROUTES.ui.files}${params(q) ? `?${params(q)}` : ""}`),
    digest: (q) => get<Digest>(`${ROUTES.ui.digest}${params(q) ? `?${params(q)}` : ""}`),
    forget: (harness, id) => post<void>(`${ROUTES.ui.forget}/${enc(harness)}/${enc(id)}/forget`),
    rotateToken: () => post<{ sinkToken: string }>(ROUTES.ui.rotateToken),
    demo: (on) => post<{ on: boolean }>(ROUTES.ui.demo, { on }),
    qrUrl: () => apiUrl(ROUTES.ui.qr),
    labels: () => get<Labels>(ROUTES.ui.labels),
    patchLabels: (p) =>
      fetch(apiUrl(ROUTES.ui.labels), {
        method: "PATCH",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(p),
      }).then((r) => json<Labels>(r)),
    sessionSearch: () => import("../search/http").then((m) => m.httpSearch(searchFrames)),
  };
}
