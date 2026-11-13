// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. Where one of the small documents beside the store (the person's
// labels, their read marks, the accounts' usage limits) is kept between runs. The
// documents themselves (labelsCore.ts, marksCore.ts, limitsCore.ts) import nothing of
// Node's and are handed one of these by whoever opens them: the receiver keeps each in a
// file under its state dir (docFile.ts), a page that carries its own board keeps them
// where its account's documents are (docs/rfcs/08, "The documents").

export interface DocKeep {
  /** What was kept, as the JSON value it is; undefined with nothing kept. Throws when
   *  what is there cannot be read. */
  load(): unknown;
  /** Keep this value, whole. May throw: the document then stays as it was. */
  save(value: unknown): void;
  /** What `load` gave is not a document: put it aside, so the next save does not lose it. */
  setAside?(): void;
}
