// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. The indexer child: `sessionpipe-gui index --ipc --state <dir>
// [--search-home <dir>] [--no-history] [--hostname <name>]`, forked and niced by the service
// (D12). It talks over process.send (serialization "advanced"): ToIndexer in, FromIndexer
// out. It exits when told to stop, when the server goes away, or after 2 min of nothing to do.
import os from "node:os";
import path from "node:path";
import { eventsAdapter, historyAdapters, sourceEnv } from "../sources/index.js";
import type { FromIndexer, ToIndexer } from "../types.js";
import { Indexer } from "./indexer.js";
import { LockedError } from "./manifest.js";

export interface ChildArgs {
  stateDir: string;
  home?: string;
  history: boolean;
  hostname: string;
}

export function parseChildArgs(argv: string[]): ChildArgs {
  let stateDir = "";
  let home: string | undefined;
  let history = true;
  let hostname = os.hostname().replace(/\.(local|lan|home)$/i, "");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--state") stateDir = argv[++i] ?? "";
    else if (a === "--search-home") home = argv[++i];
    else if (a === "--no-history") history = false;
    else if (a === "--hostname") hostname = argv[++i] ?? hostname;
  }
  if (!stateDir) throw new Error("index --ipc needs --state <dir>");
  return { stateDir: path.resolve(stateDir), home, history, hostname };
}

export async function indexerChildMain(argv: string[]): Promise<void> {
  const send = (m: FromIndexer): void => {
    try {
      if (process.connected) process.send?.(m);
    } catch {}
  };
  let ix: Indexer | null = null;
  try {
    const a = parseChildArgs(argv);
    const env = sourceEnv({
      home: a.home ?? process.env.SPGUI_SEARCH_HOME,
      stateDir: a.stateDir,
      hostname: a.hostname,
    });
    ix = new Indexer(
      {
        dir: path.join(a.stateDir, "search"),
        env,
        adapters: [...historyAdapters(), eventsAdapter()],
        history: a.history,
        mode: "watch",
        onStatus: (status) => send({ t: "status", status }),
        onCommit: (source, gen) => send({ t: "committed", source, gen }),
      },
      { inProcess: false },
    );
    const it = ix;
    process.on("message", (m) => it.send(m as ToIndexer));
    process.on("disconnect", () => it.stop());
    process.on("SIGTERM", () => it.stop());
    await it.run();
  } catch (e) {
    const msg =
      e instanceof LockedError ? `the index is being written by another process (${e.pid})` : (e as Error).message;
    send({ t: "error", message: msg });
    process.exitCode = e instanceof LockedError ? 0 : 1;
  } finally {
    // let the last messages flush, then go
    setTimeout(() => process.exit(), 50).unref();
  }
}
