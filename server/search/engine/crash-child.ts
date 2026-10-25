// SPDX-License-Identifier: Apache-2.0
// Owned by: search-engine. The crash test's victim (crash.test.ts bundles and forks it): the
// watch-mode indexer over a fake home while lines keep arriving and commits are forced, until
// the parent SIGKILLs it.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { fakeAdapter, fakeEnv, fakeLine } from "./fake.js";
import { startIndexer } from "./indexer.js";

const [home, state, seedArg] = process.argv.slice(2) as [string, string, string];
const env = fakeEnv(home, state);
const adapter = fakeAdapter("history");
const ix = startIndexer(
  { dir: join(state, "search"), env, adapters: [adapter], history: true, mode: "watch" },
  { inProcess: true, tickMs: 5, sweepMs: 40, idleExitMs: 60_000 },
);
let n = Number(seedArg) * 1_000_000;
const t = setInterval(() => {
  for (let k = 0; k < 20; k++) {
    const f = join(home, "fake", `s${n % 7}.jsonl`);
    appendFileSync(f, fakeLine({ k: n % 2 ? "p" : "r", text: `word${n} and some text`, at: 1_760_000_000_000 + n }));
    ix.send({ t: "hint", path: f });
    n++;
  }
  ix.send({ t: "commit" });
}, 3);
void ix.done.finally(() => clearInterval(t));
