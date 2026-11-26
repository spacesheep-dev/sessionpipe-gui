// SPDX-License-Identifier: Apache-2.0
// Structural SSR checks for NewSessionSheet: header Discard ghost button, removal of
// footer MoreButton, smart folder trigger + pin button, calm pool-aware quota states,
// options separator, and footer status dot.
import "../native/test-env";
import type { LimitsEntry, MachinePool, MachineSummary, SessionSummary } from "@shared/api";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const H = 3_600_000;

let mockMachines: MachineSummary[] = [];
let mockLimits: LimitsEntry[] = [];
let mockSessions = new Map<string, SessionSummary>();
let mockPhone = false;

vi.mock("../data/hooks", () => ({
  useMachines: () => mockMachines,
  useLimits: () => mockLimits,
  useListedSessions: () => mockSessions,
  useAppState: () => ({ snapshotAt: NOW }),
}));
vi.mock("../lib/device", () => ({
  usePhoneLayout: () => mockPhone,
  useSelectSheet: () => false,
  safeSides: () => ({ left: 0, right: 0 }),
}));
vi.mock("../lib/time", async (orig) => {
  const actual = await orig<typeof import("../lib/time")>();
  return { ...actual, useNow: () => NOW };
});
vi.mock("./hooks", () => ({
  useRpId: () => "localhost",
  useGrant: () => ({ exp: NOW + H, refresh: () => {} }),
}));
vi.mock("../account/sendable", () => ({
  useSendStates: () => () => ({ kind: "ok" }),
}));
vi.mock("./signer", async (orig) => {
  const actual = await orig<typeof import("./signer")>();
  return { ...actual, canSign: () => true, signerKind: () => "passkey", signHint: () => "" };
});
vi.mock("./api", async (orig) => {
  const actual = await orig<typeof import("./api")>();
  return { ...actual, wrongOriginHere: () => false };
});
vi.mock("./Attachments", async (orig) => {
  const actual = await orig<typeof import("./Attachments")>();
  return { ...actual, useSpacesheepRefused: () => false };
});

import { Sheet } from "./NewSessionSheet";

const makeMachine = (pool?: MachinePool, online = true): MachineSummary =>
  ({
    name: "studio",
    online,
    control: {
      machineId: "m_studio",
      online,
      keys: [],
      queued: 0,
      harnesses: ["claude-code", "codex"],
      folders: ["~/.bb-machines/startrise.example/checkouts/sessionpipe"],
      tilde: true,
      mode: "auto",
      files: true,
      start: {
        "claude-code": { permissions: ["read", "safe", "edits", "auto"], permission: "auto", anyModel: true },
        codex: { permissions: ["read", "safe", "auto"], permission: "auto", models: ["gpt-6-astra"] },
      },
      accounts: [{ harness: "claude-code", id: "acc-1", email: "alice@example.com" }],
      ...(pool ? { pool } : {}),
    },
  }) as unknown as MachineSummary;

const makeEntry = (accountId: string, usedPercent: number): LimitsEntry => ({
  key: `claude-code a:${accountId}`,
  harness: "claude-code",
  accountId,
  machine: "studio",
  machines: ["studio"],
  windows: [
    {
      id: "five_hour",
      usedPercent,
      windowMinutes: 300,
      resetsAt: new Date(NOW + 2 * H).toISOString(),
    },
  ],
  observedAt: new Date(NOW).toISOString(),
});

beforeEach(() => {
  mockPhone = false;
  mockSessions = new Map();
  mockLimits = [];
  mockMachines = [makeMachine()];
  localStorage.removeItem("sp.newSession.draft");
  localStorage.removeItem("sp.newSession.favFolders");
});

describe("NewSessionSheet UI polish", () => {
  it("renders native header with conditional Discard ghost button and no footer MoreButton", () => {
    const emptyHtml = renderToStaticMarkup(<Sheet target={{ machine: "studio", text: "" }} closing={false} />);
    expect(emptyHtml).toContain('class="ns-head"');
    expect(emptyHtml).toContain(">New session</h2>");
    expect(emptyHtml).not.toContain("data-ns-discard");
    expect(emptyHtml).not.toContain("ns-more");

    const draftHtml = renderToStaticMarkup(
      <Sheet target={{ machine: "studio", text: "Fix the failing test" }} closing={false} />,
    );
    expect(draftHtml).toContain("data-ns-discard");
    expect(draftHtml).toContain("btn btn--sm btn--ghost ns-head-discard");
    expect(draftHtml).toContain(">Discard</button>");
    expect(draftHtml).not.toContain("ns-more");
  });

  it("renders smart folder trigger (icon + basename + compactParent, no mono on trigger) and Pin button", () => {
    const html = renderToStaticMarkup(
      <Sheet
        target={{
          machine: "studio",
          cwd: "~/.bb-machines/startrise.example/checkouts/sessionpipe",
          text: "",
        }}
        closing={false}
      />,
    );
    expect(html).toContain("ns-sel ns-sel--folder");
    expect(html).not.toContain("ns-sel mono");
    expect(html).toContain('class="ns-folder-icon"');
    expect(html).toContain('<span class="ns-folder-name">sessionpipe</span>');
    expect(html).toContain('<span class="ns-folder-parent mono">~/…/checkouts</span>');
    expect(html).toContain('title="~/.bb-machines/startrise.example/checkouts/sessionpipe"');
    expect(html).toContain("data-ns-pin");
    expect(html).toContain('aria-label="Pin folder"');
  });

  it("renders calm neutral pool readiness when current account is out but failover accounts have room", () => {
    const pool: MachinePool = {
      on: true,
      harness: "claude-code",
      accounts: [
        { id: "acc-1", email: "alice@example.com", label: "Alice", enabled: true, status: "ready", current: true },
        { id: "acc-2", email: "bob@example.com", label: "Bob", enabled: true, status: "ready", current: false },
        {
          id: "acc-3",
          email: "carol@example.com",
          label: "Carol",
          enabled: true,
          status: "limited",
          current: false,
          until: new Date(NOW + 2 * H).toISOString(),
        },
      ],
    };
    mockMachines = [makeMachine(pool)];
    mockLimits = [makeEntry("acc-1", 100)];

    const html = renderToStaticMarkup(
      <Sheet target={{ machine: "studio", harness: "claude-code", text: "" }} closing={false} />,
    );
    expect(html).toContain("1 of 3 accounts ready");
    expect(html).toContain("ns-quota--neutral");
    expect(html).not.toContain("ns-quota--out");
    expect(html).not.toContain("ns-aside--out");
  });

  it("renders calm --needs-fg pill only when entire pool is exhausted", () => {
    const pool: MachinePool = {
      on: true,
      harness: "claude-code",
      accounts: [
        {
          id: "acc-1",
          email: "alice@example.com",
          label: "Alice",
          enabled: true,
          status: "limited",
          current: false,
          until: new Date(NOW + 2 * H).toISOString(),
        },
        {
          id: "acc-2",
          email: "bob@example.com",
          label: "Bob",
          enabled: true,
          status: "limited",
          current: false,
          until: new Date(NOW + 3 * H).toISOString(),
        },
      ],
    };
    mockMachines = [makeMachine(pool)];

    const html = renderToStaticMarkup(
      <Sheet target={{ machine: "studio", harness: "claude-code", text: "" }} closing={false} />,
    );
    expect(html).toContain("Pool used up · first back in 2 h");
    expect(html).toContain("ns-quota--out");
    expect(html).toContain('data-tone="out"');
  });

  it("renders options hairline separator and footer status dot for listening and offline states", () => {
    const liveHtml = renderToStaticMarkup(<Sheet target={{ machine: "studio", text: "" }} closing={false} />);
    expect(liveHtml).toContain('class="ns-opts-sep"');
    expect(liveHtml).toContain('class="ns-status-dot ns-status-dot--ok"');
    expect(liveHtml).toContain("studio is listening.");

    mockMachines = [makeMachine(undefined, false)];
    const offlineHtml = renderToStaticMarkup(<Sheet target={{ machine: "studio", text: "" }} closing={false} />);
    expect(offlineHtml).toContain('class="ns-status-dot ns-status-dot--ring"');
    expect(offlineHtml).toContain("studio is offline.");
  });
});
