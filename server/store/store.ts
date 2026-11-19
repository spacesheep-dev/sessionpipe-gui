// SPDX-License-Identifier: Apache-2.0
// Owned by: server-core. The server's store: the store's core (store/core.ts) over the
// append-only JSONL files under <stateDir>/events (store/files.ts).
import { StoreCore, type StoreOptions } from "./core.js";
import { EventFiles } from "./files.js";

export * from "./core.js";

export class Store extends StoreCore {
  constructor(dir: string, opts: StoreOptions = {}) {
    super(dir, opts, new EventFiles(dir));
  }
}
