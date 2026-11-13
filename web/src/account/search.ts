// SPDX-License-Identifier: Apache-2.0
// Owned by: web. Session search for a page that carries its own board (the phone on a
// spacesheep account): the reader search/inPage.ts runs, over the sessions the page's own
// store holds. It reads what the store's index keeps of each event (a prompt, a reply, one
// line a tool call), so it finds what this page has read from the relay and nothing else:
// a machine's own agent history never reaches an account.
import type { Labels, SearchIndexStatus, SessionSummary, StoredEvent } from "@shared/api";
import { type Doc, eventDocs, pageSearch, type Sess } from "../search/inPage";
import type { SearchClient } from "../search/types";

/** What the search reads of the store. */
export interface SearchedStore {
  snapshot(): { sessions: SessionSummary[] };
  /** A session's events as the index keeps them (server/store/core.ts slimEvents). */
  slimEvents(key: string): readonly StoredEvent[] | undefined;
}

export function accountSearch(store: SearchedStore, labels: () => Labels): SearchClient {
  /** Each session's documents, kept while its event count stays what it was. */
  const kept = new Map<string, { n: number; docs: Doc[] }>();
  const all = (): Sess[] => {
    const out: Sess[] = [];
    const seen = new Set<string>();
    for (const s of store.snapshot().sessions) {
      if (s.parentId) continue;
      seen.add(s.key);
      const events = store.slimEvents(s.key) ?? [];
      let k = kept.get(s.key);
      if (!k || k.n !== events.length) {
        const docs: Doc[] = [];
        for (const e of events) docs.push(...eventDocs(e));
        k = { n: events.length, docs };
        kept.set(s.key, k);
      }
      if (!k.docs.length) continue;
      out.push({
        harness: s.harness,
        id: s.id,
        source: "sessionpipe",
        title: s.title ?? "",
        machine: s.machine ?? "",
        repo: s.repo,
        cwd: s.cwd,
        docs: k.docs,
        summary: s,
      });
    }
    for (const key of kept.keys()) if (!seen.has(key)) kept.delete(key);
    return out;
  };
  const status = (): SearchIndexStatus => {
    const list = all();
    return {
      state: "ready",
      sessions: list.length,
      messages: list.reduce((n, s) => n + s.docs.length, 0),
      bytes: 0,
      updatedAt: new Date().toISOString(),
      // No machine's own history is here to read, and nothing here to rebuild or reveal.
      history: false,
      sources: list.length ? [{ harness: "sessionpipe", source: "sessionpipe", homes: [], sessions: list.length }] : [],
      local: false,
    };
  };
  // No machine is "this" one: the page runs on a phone.
  return pageSearch({ all, status, labels, here: "", listeners: new Set() });
}
