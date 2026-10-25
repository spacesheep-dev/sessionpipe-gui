// SPDX-License-Identifier: Apache-2.0
// Owned by: search-ui. Settings ▸ Data's search rows (ux-search.md §10): whether search
// reads this machine's own agent history (default on; turning it off deletes that index,
// after asking), and the index's size, age and Rebuild. This machine only: a viewer
// elsewhere reads the setting as text.
import { type ReactNode, useEffect, useState } from "react";
import { Toggle } from "../components/bits";
import { confirmAction } from "../components/ContextMenu";
import { useStore } from "../data/hooks";
import { useNow } from "../lib/time";
import { forgetAnswers, noteStatus, useSearchClient, useSearchStatus } from "./client";
import { bytesWord, macWord, updatedWord } from "./words";

type GroupC = (p: { label?: string; note?: ReactNode; children: ReactNode }) => ReactNode;
type RowC = (p: { label: ReactNode; hint?: ReactNode; children?: ReactNode }) => ReactNode;

export function SearchDataGroup({ Group, Row }: { Group: GroupC; Row: RowC }) {
  const store = useStore();
  const client = useSearchClient();
  const [machine, setMachine] = useState<string | undefined>();
  useEffect(() => {
    store.transport.info().then(
      (i) => setMachine(i.hostname),
      () => {},
    );
  }, [store]);
  const status = useSearchStatus(client);
  const now = useNow("coarse");
  if (!status) return null;
  const toggle = async (on: boolean) => {
    if (!client) return;
    if (!on) {
      const ok = await confirmAction({
        title: "Stop reading agent history?",
        body: "Sessions from before sessionpipe leave search. The index for them is deleted.",
        action: "Turn off",
      });
      if (!ok) return;
    }
    forgetAnswers();
    noteStatus(await client.settings({ history: on }));
  };
  const rebuild = async () => {
    if (!client) return;
    const ok = await confirmAction({
      title: "Rebuild the search index?",
      body: "It reads everything again, about 2 minutes. Search keeps working meanwhile.",
      action: "Rebuild",
    });
    if (!ok) return;
    forgetAnswers();
    noteStatus(await client.reindex(true));
  };
  return (
    <Group label="Search">
      <Row
        label={`Search this ${macWord()}'s agent history`}
        hint="Reads Claude Code, Codex and Antigravity logs here, read-only, so search finds older sessions, even offline."
      >
        {status.local ? (
          <Toggle on={status.history} onChange={(on) => void toggle(on)} label="Search this machine's agent history" />
        ) : (
          <span className="settings-value">
            {status.history ? "On" : "Off"}, set on {machine ?? "the receiver's machine"}
          </span>
        )}
      </Row>
      <Row
        label="Search index"
        hint={
          <span className="num">
            {bytesWord(status.bytes)}
            {status.updatedAt ? ` · updated ${updatedWord(status.updatedAt, now)}` : ""}
            {status.state === "first-run" ? ` · reading, ${Math.round((status.progress ?? 0) * 100)} %` : ""}
          </span>
        }
      >
        {status.local ? (
          <button type="button" className="btn btn--sm" onClick={() => void rebuild()}>
            Rebuild…
          </button>
        ) : undefined}
      </Row>
    </Group>
  );
}
