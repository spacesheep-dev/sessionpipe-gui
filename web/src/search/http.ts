// SPDX-License-Identifier: Apache-2.0
// Owned by: search-ui. The session search over our own origin (SEARCH-SPEC.md §3.4): every
// GET can be aborted (the page aborts the query a keystroke made stale), the POSTs are this
// machine's only and answer 403 `local_only` elsewhere. The status frames come from the
// one stream the transport already holds open.
import type { SearchIndexStatus, SessionSearchQuery } from "@shared/api";
import { ROUTES } from "@shared/api";
import { HttpError } from "../data/transport";
import { apiUrl } from "../lib/net";
import type { SearchClient, SearchTranscriptQuery } from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string; reason?: string; message?: string };
      msg = body.error ?? body.reason ?? body.message ?? msg;
    } catch {
      // no body
    }
    throw new HttpError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const get = <T>(url: string, signal?: AbortSignal) =>
  fetch(apiUrl(url), { headers: { accept: "application/json" }, signal }).then((r) => json<T>(r));
const post = <T>(url: string, body: unknown) =>
  fetch(apiUrl(url), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  }).then((r) => json<T>(r));

/** A query string from the set fields; booleans as 1. */
export function searchParams(q: object): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === "" || v === false || v === null) continue;
    p.set(k, v === true ? "1" : String(v));
  }
  return p.toString();
}

const enc = encodeURIComponent;

export function httpSearch(frames: Set<(s: SearchIndexStatus) => void>): SearchClient {
  return {
    sessions: (q: SessionSearchQuery, signal) => get(`${ROUTES.ui.searchSessions}?${searchParams(q)}`, signal),
    transcript: (harness, id, q: SearchTranscriptQuery, signal) => {
      const qs = searchParams(q);
      return get(`${ROUTES.ui.searchTranscript}/${enc(harness)}/${enc(id)}${qs ? `?${qs}` : ""}`, signal);
    },
    facets: (signal) => get(ROUTES.ui.searchFacets, signal),
    status: () => get(ROUTES.ui.searchStatus),
    reindex: (rebuild = false) => post(ROUTES.ui.searchReindex, { rebuild }),
    settings: (s) => post(ROUTES.ui.searchSettings, s),
    reveal: (r) => post(ROUTES.ui.searchReveal, r),
    onStatus: (l) => {
      frames.add(l);
      return () => {
        frames.delete(l);
      };
    },
  };
}
