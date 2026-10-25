// SPDX-License-Identifier: Apache-2.0
// Owned by: search-ui. The session search's client, as the page, ⌘K and the history
// transcript call it: the HTTP one (search/http.ts) speaks GET/POST /api/ui/search/*, the
// mock one (mock/search.ts) answers in the page. Both arrive with the search code itself
// (Transport.sessionSearch), so nothing of it is in the first load.
import type {
  SearchFacets,
  SearchIndexStatus,
  SearchRevealRequest,
  SearchSettings,
  SearchTranscript,
  SessionSearchPage,
  SessionSearchQuery,
} from "@shared/api";

/** GET /api/ui/search/transcript/:harness/:id: one of around / before / after (refs). */
export interface SearchTranscriptQuery {
  q?: string;
  around?: string;
  before?: string;
  after?: string;
  limit?: number;
}

export interface SearchClient {
  sessions(q: SessionSearchQuery, signal?: AbortSignal): Promise<SessionSearchPage>;
  transcript(harness: string, id: string, q: SearchTranscriptQuery, signal?: AbortSignal): Promise<SearchTranscript>;
  facets(signal?: AbortSignal): Promise<SearchFacets>;
  status(): Promise<SearchIndexStatus>;
  reindex(rebuild?: boolean): Promise<SearchIndexStatus>;
  settings(s: SearchSettings): Promise<SearchIndexStatus>;
  reveal(r: SearchRevealRequest): Promise<void>;
  /** `searchIndex` stream frames (without `local`), as they arrive. */
  onStatus(l: (s: SearchIndexStatus) => void): () => void;
}
