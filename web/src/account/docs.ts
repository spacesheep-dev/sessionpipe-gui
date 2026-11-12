// SPDX-License-Identifier: Apache-2.0
// Owned by: web. The account's documents (docs/rfcs/08, "The documents"): what nothing
// upstream holds in this mode, the person's labels and read marks, the usage limits, the
// sends not yet settled. The native hub keeps each as a whole JSON value under the
// account's id (`acct_doc_get` / `acct_doc_set`); here each is a DocKeep (server/ui/
// docKeep.ts), which reads and writes at once: every document is read before anything
// opens one, and a save is handed to the hub behind it, the last value winning.
import type { DocKeep } from "../../../server/ui/docKeep";
import type { ShellCalls } from "./shell";

/** The documents a page keeps for its account. A name is a lowercase letter, then letters,
 *  digits or dashes; an account has at most eight. */
export const DOC_NAMES = ["labels", "marks", "limits", "sends"] as const;
export type DocName = (typeof DOC_NAMES)[number];

export interface AccountDocs {
  keep(name: DocName): DocKeep;
  /** Resolves when every save so far reached the hub (or failed). */
  flushed(): Promise<void>;
  /** The documents that could not be read or written, by name: kept in memory only. */
  failed(): DocName[];
}

export async function openDocs(calls: Pick<ShellCalls, "docGet" | "docSet">, id: string): Promise<AccountDocs> {
  const values = new Map<DocName, unknown>();
  const failed = new Set<DocName>();
  await Promise.all(
    DOC_NAMES.map(async (name) => {
      try {
        const v = await calls.docGet(id, name);
        if (v !== null && v !== undefined) values.set(name, v);
      } catch (e) {
        failed.add(name);
        console.warn(`[account] ${name} could not be read:`, e);
      }
    }),
  );
  const writing = new Map<DocName, Promise<void>>();
  const waiting = new Map<DocName, unknown>();
  const flush = (name: DocName): void => {
    if (writing.has(name) || !waiting.has(name)) return;
    const value = waiting.get(name);
    waiting.delete(name);
    const p = calls
      .docSet(id, name, value)
      .then(
        () => void failed.delete(name),
        (e) => {
          failed.add(name);
          console.warn(`[account] ${name} could not be kept:`, e);
        },
      )
      .then(() => {
        writing.delete(name);
        flush(name);
      });
    writing.set(name, p);
  };
  return {
    keep: (name) => ({
      load: () => values.get(name),
      save(value) {
        // Its own copy, as a file's would be: what the document changes next is not this.
        const copy = JSON.parse(JSON.stringify(value)) as unknown;
        values.set(name, copy);
        waiting.set(name, copy);
        flush(name);
      },
      // What was there is not a document: the next save replaces it, as the last write wins.
      setAside: () => void values.delete(name),
    }),
    async flushed() {
      while (writing.size) await Promise.all([...writing.values()]);
    },
    failed: () => [...failed],
  };
}
