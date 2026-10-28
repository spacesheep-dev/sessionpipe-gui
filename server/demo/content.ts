// SPDX-License-Identifier: Apache-2.0
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: tool inputs quote TypeScript and workflow source as text
// Owned by: demo. What the pretend team works on: machines, repos, titles and the turn
// scripts each harness plays. Tool inputs and outputs copy the shapes the real hooks
// carry (conformance/harness/* in the sessionpipe repo). No real people, no real
// secrets: the one secret-looking line is already `[redacted]`, as secrets@1 leaves it.

export type HarnessName = "claude-code" | "codex" | "gemini-cli" | "antigravity" | "cursor";

export const MACHINE_NAMES = ["studio-mac", "build-box", "ci-runner", "lab-pi"] as const;

/** The machine sessionpipe 0.10's scenes run on, paired in demo mode (machine.ts): on its
 *  own, so the other demo machines stay as an unpaired receiver sees them. */
export const V010_MACHINE = "lab-mac";

export const HARNESS_VERSION: Record<HarnessName, string> = {
  "claude-code": "2.1.296",
  codex: "0.157.1",
  "gemini-cli": "0.48.2",
  antigravity: "1.21.9",
  cursor: "3.7.36",
};

export const MODELS: Record<HarnessName, readonly string[]> = {
  "claude-code": ["claude-fable-5-1", "claude-opus-5-5"],
  codex: ["gpt-5.4-codex"],
  "gemini-cli": ["gemini-3-pro"],
  antigravity: ["gemini-3-pro", "gemini-3-flash"],
  cursor: ["claude-fable-5-1", "gpt-5.5"],
};

export interface Repo {
  repo: string;
  cwd: string;
  branches: readonly string[];
}

export const REPOS: readonly Repo[] = [
  {
    repo: "github.com/acme/billing",
    cwd: "~/code/billing",
    branches: ["main", "feat/invoice-pdf", "fix/webhook-retry"],
  },
  { repo: "github.com/acme/infra", cwd: "~/work/infra", branches: ["main", "chore/pnpm-cache", "tf/aws-provider-6"] },
  { repo: "github.com/acme/docs-site", cwd: "~/code/docs-site", branches: ["main", "docs/2.4-changelog"] },
  { repo: "github.com/acme/mobile", cwd: "~/code/mobile", branches: ["main", "feat/offline-cart"] },
  { repo: "github.com/acme/search-api", cwd: "~/code/search-api", branches: ["main", "perf/bm25-cache"] },
  { repo: "gitlab.com/acme/data-pipeline", cwd: "~/work/data-pipeline", branches: ["main", "fix/late-events"] },
  // An IDE workspace (Antigravity) and a Cursor project.
  { repo: "github.com/acme/design-system", cwd: "~/code/design-system", branches: ["main", "feat/tokens-v2"] },
  { repo: "github.com/acme/notify-service", cwd: "~/code/notify-service", branches: ["main", "fix/digest-dedupe"] },
];

/** One tool call inside a turn. `say` is what the assistant has written by then
 *  (turn.progress grows with it); `paths` makes a files.changed follow the tool. */
export interface ToolStep {
  tool: string;
  input: unknown;
  output?: unknown;
  ms: number;
  ok?: boolean;
  error?: string;
  paths?: string[];
  say?: string;
  /** Antigravity's PostToolUse names no tool for this step (only stepIdx and error):
   *  a session.heartbeat stands in for its tool.ended. */
  unnamed?: boolean;
  /** Claude Code asks before running this one: an attention.needed stays open first. */
  permission?: string;
  /** The Agent / Task tool launches a subagent that runs these steps. Claude Code runs it
   *  inside the parent's session (`agent_id` on its tools): in the background when the
   *  call's output says `async_launched` (the parent's turn ends first, and a
   *  `<task-notification>` turn brings `result` back), otherwise while the call is open
   *  (`result` is the call's output). Other harnesses run it as a child session with
   *  `parent_id`, the spec's other shape. `think`: ms between its tools. */
  subagent?: SubagentScript;
  /** The context fills up right after this step: context.compacted, then a compact restart. */
  compactAfter?: boolean;
  /** This step is `sessionpipe ask <harness> "<text>"`: while the call is open the daemon
   *  runs the asked agent as a session of its own (`delegated_by` on its events) and
   *  brackets it with delegation.started / .ended on this session; the answer is the
   *  call's stdout. `ms` is ignored: the step lasts as long as the child does. */
  ask?: AskScript;
}

/** Another agent asked from inside a session (sessionpipe CONTROL.md §13). */
export interface AskScript {
  harness: HarnessName;
  /** The question, as the daemon records it (cut to 200 chars on delegation.started). */
  text: string;
  /** The child's turns; the last one's `final` is the answer. */
  turns: readonly TurnScript[];
}

/** A handoff (CONTROL.md §3.1 `reply_to`): a `start` signed from here with this session
 *  named as the one to answer into. The daemon starts the asked agent, relays its reply
 *  here as a framed prompt, and this session answers that with `followUp`. */
export interface HandoffScript {
  harness: HarnessName;
  text: string;
  turns: readonly TurnScript[];
  followUp: string;
}

export interface SubagentScript {
  type: string;
  steps: ToolStep[];
  /** Its last message: the synchronous call's output, or the notification's <result>. */
  result?: string;
  /** What the orchestrator says when a background agent reports back. */
  followUp?: string;
  think?: [number, number];
}

export interface TurnScript {
  prompt: string;
  steps: ToolStep[];
  final: string;
  /** The session learns a better title during this turn (title_source harness or custom). */
  title?: { text: string; source: "harness" | "custom" };
  /** The turn ends on an API error instead of a Stop. */
  error?: string;
  /** The turn never ends: the session goes quiet after its last step (a stale session). */
  abandon?: boolean;
  /** sessionpipe 0.10 `turn.ended.background`: work still in flight when its Stop fires. */
  background?: number;
  /** sessionpipe 0.10 `turn.started.submitted_by`: the harness's own word for who submitted it. */
  submittedBy?: string;
  /** sessionpipe 0.10 `turn.started.injected`: the prompt is a block the harness wrote. */
  injected?: boolean;
  /** Virtual ms the session waits after this turn (its background work running). */
  waitAfter?: number;
}

const bash = (stdout: string, stderr = "") => ({
  stdout,
  stderr,
  interrupted: false,
  isImage: false,
  noOutputExpected: false,
});
const read = (filePath: string, content: string, totalLines: number) => ({
  type: "text",
  file: { filePath, content, numLines: content.split("\n").length, startLine: 1, totalLines },
});
const edit = (filePath: string, oldString: string, newString: string) => ({
  filePath,
  oldString,
  newString,
  replaceAll: false,
  userModified: false,
});
const grepFiles = (filenames: string[]) => ({ mode: "files_with_matches", numFiles: filenames.length, filenames });
const grepLines = (content: string, numLines: number) => ({ mode: "content", numLines, content });

// ---------- Claude Code: github.com/acme/billing ----------

export const CLAUDE_TURNS: readonly TurnScript[] = [
  {
    prompt:
      "Our Stripe webhook handler keeps retrying when the signature check fails, which just hammers the queue. Find where retries are scheduled and make a bad signature a hard stop.",
    title: { text: "Webhook retry on bad signature", source: "harness" },
    steps: [
      {
        tool: "Grep",
        input: { pattern: "scheduleRetry|retryWebhook", path: "src", output_mode: "files_with_matches" },
        output: grepFiles(["src/webhooks/retry.ts", "src/webhooks/handler.ts", "src/queue/jobs.ts"]),
        ms: 38,
        say: "I'll start from where retries are scheduled.",
      },
      {
        tool: "Read",
        input: { file_path: "~/code/billing/src/webhooks/retry.ts" },
        output: read(
          "/Users/dev/code/billing/src/webhooks/retry.ts",
          "export function scheduleRetry(job: WebhookJob, err: unknown) {\n  const attempt = job.attempt + 1;\n  const delay = Math.min(2 ** attempt * 1000, 15 * 60_000);\n  return queue.enqueue({ ...job, attempt }, { delay });\n}\n",
          41,
        ),
        ms: 4,
        say: "I'll start from where retries are scheduled. `scheduleRetry` backs off exponentially but never looks at *why* the delivery failed.",
      },
      {
        tool: "Grep",
        input: { pattern: "SignatureVerificationError", path: "src", output_mode: "content", "-n": true },
        output: grepLines(
          "src/webhooks/verify.ts:12:export class SignatureVerificationError extends Error {}\nsrc/webhooks/handler.ts:44:    } catch (err) {\nsrc/webhooks/handler.ts:45:      await scheduleRetry(job, err);",
          3,
        ),
        ms: 29,
      },
      {
        tool: "Edit",
        input: {
          file_path: "~/code/billing/src/webhooks/handler.ts",
          old_string: "    } catch (err) {\n      await scheduleRetry(job, err);",
          new_string:
            "    } catch (err) {\n      if (err instanceof SignatureVerificationError) {\n        log.warn({ jobId: job.id }, 'webhook signature rejected; not retrying');\n        return;\n      }\n      await scheduleRetry(job, err);",
        },
        output: edit(
          "/Users/dev/code/billing/src/webhooks/handler.ts",
          "    } catch (err) {\n      await scheduleRetry(job, err);",
          "    } catch (err) {\n      if (err instanceof SignatureVerificationError) {\n        log.warn({ jobId: job.id }, 'webhook signature rejected; not retrying');\n        return;\n      }\n      await scheduleRetry(job, err);",
        ),
        ms: 6,
        paths: ["src/webhooks/handler.ts"],
        say: "I'll start from where retries are scheduled. `scheduleRetry` backs off exponentially but never looks at *why* the delivery failed. A rejected signature is now logged and dropped before any retry is queued.",
      },
      {
        tool: "Bash",
        input: { command: "npx vitest run src/webhooks", description: "Run the webhook test suite" },
        output: bash(
          " ✓ src/webhooks/handler.test.ts (9 tests) 212ms\n ✓ src/webhooks/retry.test.ts (4 tests) 51ms\n\n Test Files  2 passed (2)\n      Tests  13 passed (13)\n",
        ),
        ms: 2840,
      },
    ],
    final:
      "A webhook whose signature fails verification is no longer retried. `handler.ts` now catches `SignatureVerificationError` before `scheduleRetry`, logs the job id at warn level and returns; every other failure keeps the exponential backoff. The 13 webhook tests pass. Worth a follow-up: `scheduleRetry` caps at 15 minutes but has no attempt limit, so a permanently failing endpoint retries forever.",
  },
  {
    prompt: "node_modules is in a weird state after the Node 22 bump. Reinstall from the lockfile and rerun the suite.",
    steps: [
      {
        tool: "Bash",
        input: { command: "rm -rf node_modules && npm ci", description: "Reinstall dependencies from the lockfile" },
        permission: "rm -rf node_modules && npm ci",
        output: bash(
          "\nadded 412 packages, and audited 413 packages in 19s\n\n71 packages are looking for funding\n\nfound 0 vulnerabilities\n",
        ),
        ms: 19400,
        say: "Reinstalling from package-lock.json.",
      },
      {
        tool: "Bash",
        input: { command: "npm test 2>&1 | tail -20", description: "Run the full test suite" },
        output: bash(
          " Test Files  24 passed (24)\n      Tests  188 passed (188)\n   Start at  14:02:11\n   Duration  8.41s\n",
        ),
        ms: 9100,
        say: "Reinstalling from package-lock.json. Clean install done; running the suite.",
      },
    ],
    final:
      "Clean install from the lockfile (412 packages, no audit findings) and the full suite is green: 24 files, 188 tests in 8.4 s. The earlier failures were a stale `esbuild` binary built for Node 20.",
  },
  {
    prompt:
      "Where else do we format money without going through formatMoney()? Use a subagent to sweep the whole repo, then fix the ones in src/.",
    title: { text: "Billing: money formatting sweep", source: "custom" },
    steps: [
      {
        tool: "Agent",
        input: {
          description: "Find ad-hoc money formatting",
          prompt:
            "Search the repository for places that format currency amounts without calling formatMoney() from src/lib/money.ts: toFixed(2) on amounts, template strings with a currency symbol, Intl.NumberFormat with style currency. Report file:line and the expression for each.",
          subagent_type: "Explore",
        },
        output: {
          isAsync: true,
          status: "async_launched",
          agentId: "",
          description: "Find ad-hoc money formatting",
          resolvedModel: "claude-fable-5-1",
        },
        ms: 5,
        say: "A subagent is sweeping the repo for ad-hoc formatting while I look at the helper itself.",
        subagent: {
          type: "Explore",
          steps: [
            {
              tool: "Grep",
              input: { pattern: "toFixed\\(2\\)", output_mode: "content", "-n": true },
              output: grepLines(
                "src/invoices/render.ts:88:    `${(line.amount / 100).toFixed(2)} ${invoice.currency}`\nsrc/reports/monthly.ts:41:  total: (sum / 100).toFixed(2),\nscripts/backfill-totals.ts:17:  console.log(row.id, (row.cents / 100).toFixed(2));",
                3,
              ),
              ms: 44,
            },
            {
              tool: "Grep",
              input: { pattern: "Intl\\.NumberFormat", output_mode: "files_with_matches" },
              output: grepFiles(["src/lib/money.ts", "web/src/components/Price.tsx"]),
              ms: 31,
            },
            {
              tool: "Read",
              input: { file_path: "~/code/billing/web/src/components/Price.tsx", limit: 40 },
              output: read(
                "/Users/dev/code/billing/web/src/components/Price.tsx",
                "const fmt = new Intl.NumberFormat(undefined, { style: 'currency', currency });\nreturn <span>{fmt.format(cents / 100)}</span>;\n",
                38,
              ),
              ms: 3,
            },
          ],
          think: [14_000, 4000],
          result:
            "Four places skip formatMoney(): src/invoices/render.ts:88 and src/reports/monthly.ts:41 (toFixed(2)), scripts/backfill-totals.ts:17, and web/src/components/Price.tsx, which builds its own Intl.NumberFormat.",
          followUp:
            "The sweep is back: besides the two in src/ it found scripts/backfill-totals.ts and Price.tsx. Want me to move those onto formatMoney() too?",
        },
      },
      {
        tool: "Read",
        input: { file_path: "~/code/billing/src/lib/money.ts" },
        output: read(
          "/Users/dev/code/billing/src/lib/money.ts",
          "export function formatMoney(cents: number, currency: string, locale = 'en-US'): string {\n  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);\n}\n",
          12,
        ),
        ms: 3,
      },
      {
        tool: "Edit",
        input: {
          file_path: "~/code/billing/src/invoices/render.ts",
          old_string: "`${(line.amount / 100).toFixed(2)} ${invoice.currency}`",
          new_string: "formatMoney(line.amount, invoice.currency)",
        },
        output: edit(
          "/Users/dev/code/billing/src/invoices/render.ts",
          "`${(line.amount / 100).toFixed(2)} ${invoice.currency}`",
          "formatMoney(line.amount, invoice.currency)",
        ),
        ms: 5,
        paths: ["src/invoices/render.ts"],
        say: "The sweep found three spots: the invoice renderer, the monthly report, and a one-off script. Fixing the two under src/.",
      },
      {
        tool: "Edit",
        input: {
          file_path: "~/code/billing/src/reports/monthly.ts",
          old_string: "  total: (sum / 100).toFixed(2),",
          new_string: "  total: formatMoney(sum, report.currency),",
        },
        output: edit(
          "/Users/dev/code/billing/src/reports/monthly.ts",
          "  total: (sum / 100).toFixed(2),",
          "  total: formatMoney(sum, report.currency),",
        ),
        ms: 4,
        paths: ["src/reports/monthly.ts"],
      },
      {
        tool: "Bash",
        input: {
          command: "npm run typecheck && npx vitest run src/invoices src/reports",
          description: "Typecheck and run the affected tests",
        },
        output: bash(
          " ✓ src/invoices/render.test.ts (6 tests) 97ms\n ✓ src/reports/monthly.test.ts (3 tests) 40ms\n\n Test Files  2 passed (2)\n      Tests  9 passed (9)\n",
        ),
        ms: 6300,
      },
    ],
    final:
      "The sweep found three places formatting money by hand. The two under `src/` (invoice line rendering and the monthly report total) now call `formatMoney()`; typecheck and the 9 affected tests pass. `scripts/backfill-totals.ts` only prints to the console, so I left it. `web/src/components/Price.tsx` builds its own `Intl.NumberFormat` but gets the locale from the browser, which the helper does not take yet; say the word and I'll add a `locale` parameter and switch it over.",
  },
  {
    prompt:
      "Add a PDF export for invoices. Keep it server-side, no headless browser: a small layout with the line items table, totals and our footer. Put it behind GET /invoices/:id.pdf.",
    title: { text: "Invoice PDF export", source: "harness" },
    steps: [
      {
        tool: "WebSearch",
        input: { query: "pdfkit table layout line items example 2026" },
        output:
          "Web search results for query: pdfkit table layout line items example 2026\n\n1. PDFKit guide: text and layout — pdfkit.org/docs/text.html\n2. Building invoice PDFs with PDFKit — a walkthrough of a line-items table with running totals\n3. pdfkit-table (npm) — a thin table helper on top of PDFKit\n",
        ms: 4200,
        say: "Checking what the lightweight PDF options look like before I commit to one.",
      },
      {
        tool: "Read",
        input: { file_path: "~/code/billing/src/invoices/render.ts" },
        output: read(
          "/Users/dev/code/billing/src/invoices/render.ts",
          "export function renderInvoiceHtml(invoice: Invoice): string {\n  // …\n}\n",
          140,
        ),
        ms: 4,
        compactAfter: true,
      },
      {
        tool: "Write",
        input: {
          file_path: "~/code/billing/src/invoices/pdf.ts",
          content:
            "import PDFDocument from 'pdfkit';\nimport { formatMoney } from '../lib/money.js';\nimport type { Invoice } from './types.js';\n\nexport function renderInvoicePdf(invoice: Invoice): PDFKit.PDFDocument {\n  const doc = new PDFDocument({ size: 'A4', margin: 48 });\n  doc.fontSize(18).text(`Invoice ${invoice.number}`);\n  // … line items, totals, footer …\n  doc.end();\n  return doc;\n}\n",
        },
        output: {
          type: "create",
          filePath: "/Users/dev/code/billing/src/invoices/pdf.ts",
          content: "import PDFDocument from 'pdfkit';\n…",
        },
        ms: 4,
        paths: ["src/invoices/pdf.ts"],
        say: "Going with PDFKit directly: one file, no table helper. The renderer mirrors `renderInvoiceHtml` so the two stay in step.",
      },
      {
        tool: "Bash",
        input: { command: "npm run typecheck", description: "Typecheck the new renderer" },
        output: bash(
          "",
          "src/invoices/pdf.ts:9:14 - error TS2339: Property 'footerText' does not exist on type 'Invoice'.\n",
        ),
        ok: false,
        error:
          "Exit code 2\nsrc/invoices/pdf.ts:9:14 - error TS2339: Property 'footerText' does not exist on type 'Invoice'.",
        ms: 5100,
      },
      {
        tool: "Edit",
        input: {
          file_path: "~/code/billing/src/invoices/pdf.ts",
          old_string: "doc.fontSize(9).text(invoice.footerText);",
          new_string: "doc.fontSize(9).text(invoice.account.footerText ?? '');",
        },
        output: edit(
          "/Users/dev/code/billing/src/invoices/pdf.ts",
          "doc.fontSize(9).text(invoice.footerText);",
          "doc.fontSize(9).text(invoice.account.footerText ?? '');",
        ),
        ms: 3,
        paths: ["src/invoices/pdf.ts"],
      },
      {
        tool: "Bash",
        input: {
          command: "npm run typecheck && npx vitest run src/invoices",
          description: "Typecheck and test the invoice module",
        },
        output: bash(
          " ✓ src/invoices/render.test.ts (6 tests) 101ms\n ✓ src/invoices/pdf.test.ts (2 tests) 388ms\n\n Test Files  2 passed (2)\n      Tests  8 passed (8)\n",
        ),
        ms: 7200,
        say: "Going with PDFKit directly: one file, no table helper. The renderer mirrors `renderInvoiceHtml` so the two stay in step. Typecheck and tests pass; the route is next.",
      },
    ],
    final:
      "`src/invoices/pdf.ts` renders an invoice with PDFKit: header with the number and dates, the line-items table with `formatMoney` amounts, subtotal / tax / total, and the account footer. Two tests cover a one-line and a multi-page invoice. The footer text lives on the account, not the invoice, which the first typecheck caught. The route itself (`GET /invoices/:id.pdf`) is not wired yet.",
  },
  {
    prompt: "Now wire GET /invoices/:id.pdf into the API with the same auth as the HTML route.",
    error: "api_overloaded",
    steps: [
      {
        tool: "Read",
        input: { file_path: "~/code/billing/src/api/invoices.ts" },
        output: read(
          "/Users/dev/code/billing/src/api/invoices.ts",
          "router.get('/invoices/:id', requireAccount, async (req, res) => {\n  const invoice = await loadInvoice(req.params.id, req.account);\n  res.type('html').send(renderInvoiceHtml(invoice));\n});\n",
          62,
        ),
        ms: 3,
        say: "The HTML route is the template: same loader, same `requireAccount` guard.",
      },
      {
        tool: "Edit",
        input: {
          file_path: "~/code/billing/src/api/invoices.ts",
          old_string: "  res.type('html').send(renderInvoiceHtml(invoice));\n});",
          new_string:
            "  res.type('html').send(renderInvoiceHtml(invoice));\n});\n\nrouter.get('/invoices/:id.pdf', requireAccount, async (req, res) => {\n  const invoice = await loadInvoice(req.params.id, req.account);\n  res.type('application/pdf');\n  renderInvoicePdf(invoice).pipe(res);\n});",
        },
        output: edit(
          "/Users/dev/code/billing/src/api/invoices.ts",
          "  res.type('html').send(renderInvoiceHtml(invoice));\n});",
          "  res.type('html').send(renderInvoiceHtml(invoice));\n});\n\nrouter.get('/invoices/:id.pdf', requireAccount, …",
        ),
        ms: 5,
        paths: ["src/api/invoices.ts"],
      },
    ],
    final:
      "The HTML route is the template: same loader, same `requireAccount` guard. Added the `.pdf` route beneath it, streaming the PDFKit document straight to the response. I was about to add the route test when",
  },
  {
    prompt:
      "Is anyone else hitting the duplicate-invoice bug? Check our GitHub issues, then look at what the retry log says for the last run.",
    steps: [
      {
        tool: "mcp__github__search_issues",
        input: { q: "repo:acme/billing is:issue is:open duplicate invoice", per_page: 5 },
        output: [
          {
            type: "text",
            text: '{"total_count":2,"items":[{"number":418,"title":"Duplicate invoice created when webhook is redelivered","state":"open","comments":7},{"number":402,"title":"Idempotency key ignored on invoice.create","state":"open","comments":3}]}',
          },
        ],
        ms: 1180,
        say: "Two open issues describe it: #418 (webhook redelivery) and #402 (idempotency key ignored).",
      },
      {
        tool: "Bash",
        input: {
          command: "grep -n 'STRIPE_\\|DATABASE_URL' .env | head",
          description: "Check which Stripe account the retry log ran against",
        },
        output: bash("3:STRIPE_SECRET_KEY=[redacted]\n4:STRIPE_WEBHOOK_SECRET=[redacted]\n9:DATABASE_URL=[redacted]\n"),
        ms: 22,
      },
      {
        tool: "Read",
        input: { file_path: "~/code/billing/var/log/webhook-retry.log", offset: 1, limit: 30 },
        output: read(
          "/Users/dev/code/billing/var/log/webhook-retry.log",
          "2026-10-13T22:41:07Z evt_1R8 invoice.paid attempt=1 status=500\n2026-10-13T22:41:09Z evt_1R8 invoice.paid attempt=2 status=200\n2026-10-13T22:41:09Z invoice in_0931 created (second row for evt_1R8)\n",
          312,
        ),
        ms: 5,
        say: "Two open issues describe it: #418 (webhook redelivery) and #402 (idempotency key ignored). The log confirms the shape: attempt 1 fails after the insert, attempt 2 inserts again.",
      },
      {
        tool: "Bash",
        input: { command: "npx vitest run src/webhooks/idempotency.test.ts", description: "Run the idempotency tests" },
        output: bash(
          "",
          " FAIL  src/webhooks/idempotency.test.ts > second delivery of the same event is a no-op\nAssertionError: expected 2 to be 1\n",
        ),
        ok: false,
        error:
          "Exit code 1\n FAIL  src/webhooks/idempotency.test.ts > second delivery of the same event is a no-op\nAssertionError: expected 2 to be 1",
        ms: 1900,
      },
      {
        tool: "Edit",
        input: {
          file_path: "~/code/billing/src/webhooks/handler.ts",
          old_string: "  const invoice = await createInvoice(event.data);",
          new_string: "  const invoice = await createInvoice(event.data, { idempotencyKey: event.id });",
        },
        output: edit(
          "/Users/dev/code/billing/src/webhooks/handler.ts",
          "  const invoice = await createInvoice(event.data);",
          "  const invoice = await createInvoice(event.data, { idempotencyKey: event.id });",
        ),
        ms: 4,
        paths: ["src/webhooks/handler.ts"],
      },
      {
        tool: "Bash",
        input: { command: "npx vitest run src/webhooks", description: "Rerun the webhook tests" },
        output: bash(
          " ✓ src/webhooks/idempotency.test.ts (3 tests) 64ms\n ✓ src/webhooks/handler.test.ts (9 tests) 201ms\n\n Test Files  2 passed (2)\n      Tests  12 passed (12)\n",
        ),
        ms: 2600,
      },
    ],
    final:
      "Yes: #418 and #402 are the same bug seen from two sides. The retry log shows attempt 1 failing *after* the invoice insert and attempt 2 inserting again. `createInvoice` already accepts an idempotency key; the webhook handler just never passed one. It now passes the Stripe event id, the previously failing idempotency test passes, and the 12 webhook tests are green. I'd close #402 as a duplicate of #418 once this ships.",
  },
  {
    prompt: "Document the retry policy in the README, under a 'Webhooks' heading.",
    steps: [
      {
        tool: "Read",
        input: { file_path: "~/code/billing/docs/README.md" },
        ok: false,
        error: "File does not exist. Note: your current working directory is /Users/dev/code/billing.",
        output: null,
        ms: 3,
      },
      {
        tool: "Grep",
        input: { pattern: "^## ", path: "README.md", output_mode: "content", "-n": true },
        output: grepLines(
          "README.md:5:## Running locally\nREADME.md:31:## Configuration\nREADME.md:58:## Deploying",
          3,
        ),
        ms: 12,
        say: "There is no docs/README; the top-level README is the one. Adding the section after Configuration.",
      },
      {
        tool: "Edit",
        input: {
          file_path: "~/code/billing/README.md",
          old_string: "## Deploying",
          new_string:
            "## Webhooks\n\nStripe deliveries are retried with exponential backoff (2^n seconds, capped at 15 minutes). A delivery whose signature does not verify is dropped and logged, never retried. Deliveries are idempotent on the Stripe event id.\n\n## Deploying",
        },
        output: edit("/Users/dev/code/billing/README.md", "## Deploying", "## Webhooks\n\n…\n\n## Deploying"),
        ms: 4,
        paths: ["README.md"],
      },
    ],
    final:
      "Added a `## Webhooks` section to the top-level README (there is no `docs/README.md`) between Configuration and Deploying: the backoff schedule and cap, the hard stop on a bad signature, and idempotency on the event id.",
  },
  {
    prompt: "Run the linter and fix whatever it flags in src/.",
    steps: [
      {
        tool: "Bash",
        input: { command: "npx biome check src", description: "Lint the source tree" },
        output: bash(
          "",
          "src/reports/monthly.ts:12:7 lint/correctness/noUnusedVariables  This variable is unused.\n\nFound 1 error.\n",
        ),
        ok: false,
        error: "Exit code 1\nsrc/reports/monthly.ts:12:7 lint/correctness/noUnusedVariables  This variable is unused.",
        ms: 1400,
        say: "One finding: an unused variable left over from the formatting change.",
      },
      {
        tool: "Edit",
        input: {
          file_path: "~/code/billing/src/reports/monthly.ts",
          old_string: "  const cents = sum;\n",
          new_string: "",
        },
        output: edit("/Users/dev/code/billing/src/reports/monthly.ts", "  const cents = sum;\n", ""),
        ms: 3,
        paths: ["src/reports/monthly.ts"],
      },
      {
        tool: "Bash",
        input: { command: "npx biome check src", description: "Lint again" },
        output: bash("Checked 61 files in 180ms. No fixes applied.\n"),
        ms: 900,
      },
    ],
    final:
      "One finding, an unused `cents` left behind by the money-formatting change in `src/reports/monthly.ts`. Removed; `biome check src` is clean.",
  },
];

// ---------- Codex: github.com/acme/infra ----------

export const CODEX_TURNS: readonly TurnScript[] = [
  {
    prompt: "Why does the staging deploy take 14 minutes? Start with the GitHub Actions workflow.",
    steps: [
      {
        tool: "Bash",
        input: { command: "cat .github/workflows/deploy.yml" },
        output:
          "name: deploy\non:\n  push:\n    branches: [main]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: corepack enable\n      - run: pnpm install\n      - run: pnpm build\n      - run: pnpm test\n",
        ms: 15,
      },
      {
        tool: "Bash",
        input: { command: "gh run list --workflow deploy.yml --limit 5 --json durationMs,conclusion" },
        output:
          '[{"conclusion":"success","durationMs":842000},{"conclusion":"success","durationMs":811000},{"conclusion":"failure","durationMs":902000},{"conclusion":"success","durationMs":838000},{"conclusion":"success","durationMs":825000}]\n',
        ms: 2300,
      },
      {
        tool: "Bash",
        input: { command: "gh run view 7781 --log | grep -E '^build\\s+pnpm install' | tail -1" },
        output: "build\tpnpm install\t2026-10-13T09:12:44.0Z  Done in 9m 51s\n",
        ms: 4100,
      },
    ],
    final:
      "`pnpm install` alone is nearly 10 of the 14 minutes: the workflow has no cache step, so every run downloads the whole store. Adding `actions/cache` keyed on `pnpm-lock.yaml` for `~/.pnpm-store` should bring install under a minute. The build and test steps are about two minutes each and look fine.",
  },
  {
    prompt: "Add that cache step, keyed on the lockfile.",
    steps: [
      {
        tool: "Bash",
        input: {
          command:
            "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: .github/workflows/deploy.yml\n@@\n       - run: corepack enable\n+      - uses: actions/cache@v4\n+        with:\n+          path: ~/.pnpm-store\n+          key: pnpm-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}\n       - run: pnpm install\n*** End Patch\nEOF",
        },
        output: "Done!\n",
        ms: 40,
        paths: [".github/workflows/deploy.yml"],
      },
      {
        tool: "Bash",
        input: { command: "npx action-validator .github/workflows/deploy.yml && echo ok" },
        output: "ok\n",
        ms: 1800,
      },
    ],
    final:
      "Added an `actions/cache@v4` step before `pnpm install`, caching `~/.pnpm-store` under a key of the OS and the lockfile hash. The workflow validates. The first run after merge still pays the full install; the ones after it hit the cache.",
  },
  {
    prompt: "Bump the AWS provider to 6.x in the terraform modules and show me the plan.",
    steps: [
      {
        tool: "Bash",
        input: { command: "grep -rn 'hashicorp/aws' --include='*.tf' . | head" },
        output:
          './modules/vpc/versions.tf:5:      source  = "hashicorp/aws"\n./modules/eks/versions.tf:5:      source  = "hashicorp/aws"\n./envs/staging/versions.tf:6:      source  = "hashicorp/aws"\n',
        ms: 30,
      },
      {
        tool: "Bash",
        input: {
          command:
            "sed -i '' 's/version = \"~> 5.0\"/version = \"~> 6.0\"/' modules/*/versions.tf envs/*/versions.tf && git diff --stat",
        },
        output:
          " envs/staging/versions.tf   | 2 +-\n modules/eks/versions.tf    | 2 +-\n modules/vpc/versions.tf    | 2 +-\n 3 files changed, 3 insertions(+), 3 deletions(-)\n",
        ms: 60,
        paths: ["modules/vpc/versions.tf", "modules/eks/versions.tf", "envs/staging/versions.tf"],
      },
      {
        tool: "Bash",
        input: { command: "cd envs/staging && terraform init -upgrade -input=false 2>&1 | tail -3" },
        output:
          "- Installed hashicorp/aws v6.14.0 (signed by HashiCorp)\n\nTerraform has been successfully initialized!\n",
        ms: 14200,
      },
      {
        tool: "Bash",
        input: { command: "cd envs/staging && terraform plan -input=false -no-color 2>&1 | tail -4" },
        output:
          "Plan: 0 to add, 2 to change, 0 to destroy.\n\n─────────────────────────────────────────────────────────────────────────────\n\nNote: You didn't use the -out option to save this plan.\n",
        ms: 31000,
      },
    ],
    final:
      "Provider pinned to `~> 6.0` in the three `versions.tf` files; init pulled 6.14.0. The staging plan is 0 to add, 2 to change, 0 to destroy: both changes are the `aws_s3_bucket` resources picking up the new default for `object_lock_enabled`, which is a no-op in practice. Nothing is destroyed.",
  },
];

// ---------- Gemini CLI: github.com/acme/docs-site ----------

export const GEMINI_TURNS: readonly TurnScript[] = [
  {
    prompt: "The sidebar loses the active page after a client-side navigation. Find out why and fix it.",
    steps: [
      {
        tool: "grep_search",
        input: { pattern: "activePath|isActive", include: "src/components/**" },
        output:
          "Found 3 matches:\nsrc/components/Sidebar.tsx:14: const activePath = useMemo(() => window.location.pathname, []);\nsrc/components/Sidebar.tsx:31: isActive={item.href === activePath}\nsrc/components/NavItem.tsx:7: export function NavItem({ isActive, ...",
        ms: 48,
      },
      {
        tool: "read_file",
        input: { file_path: "src/components/Sidebar.tsx" },
        output:
          "import { useMemo } from 'react';\n\nexport function Sidebar({ items }: Props) {\n  const activePath = useMemo(() => window.location.pathname, []);\n  …\n}\n",
        ms: 4,
        say: "`activePath` is memoised with no dependencies, so it is read once at mount and never again.",
      },
      {
        tool: "replace",
        input: {
          file_path: "src/components/Sidebar.tsx",
          old_string: "  const activePath = useMemo(() => window.location.pathname, []);",
          new_string: "  const { pathname: activePath } = useLocation();",
        },
        output: "Successfully modified file: src/components/Sidebar.tsx (1 replacements).",
        ms: 6,
        paths: ["src/components/Sidebar.tsx"],
      },
      {
        tool: "run_shell_command",
        input: { command: "npm run build", description: "Build the site to make sure the change compiles" },
        permission: "npm run build",
        output:
          "vite v6.0.4 building for production...\n✓ 214 modules transformed.\ndist/index.html  1.12 kB\n✓ built in 3.41s\n",
        ms: 4800,
      },
    ],
    final:
      "The sidebar computed `activePath` from `window.location` inside a `useMemo` with an empty dependency list, so it never updated after the first render. It now reads `pathname` from the router's `useLocation()`, which re-renders on navigation. The site builds; I did not add a test because the components folder has none yet.",
  },
  {
    prompt: "Write the changelog entry for 2.4 from the merged PRs since the 2.3 tag.",
    steps: [
      {
        tool: "run_shell_command",
        input: {
          command: "git log v2.3.0..HEAD --merges --pretty='%s' | head -20",
          description: "List merged PRs since 2.3",
        },
        output:
          "Merge pull request #212 from acme/docs/search-shortcuts\nMerge pull request #209 from acme/docs/dark-mode-code-blocks\nMerge pull request #205 from acme/docs/sidebar-active-fix\nMerge pull request #201 from acme/docs/versioned-urls\n",
        ms: 90,
      },
      {
        tool: "read_file",
        input: { file_path: "CHANGELOG.md", limit: 20 },
        output: "# Changelog\n\n## 2.3.0 — 2026-09-02\n\n- Search index rebuilt on every deploy\n- …\n",
        ms: 3,
      },
      {
        tool: "write_file",
        input: {
          file_path: "CHANGELOG.md",
          content:
            "# Changelog\n\n## 2.4.0 — unreleased\n\n- Keyboard shortcuts for search (`/` to focus, `Esc` to close) (#212)\n- Code blocks follow the dark-mode toggle (#209)\n- Sidebar keeps the active page after client-side navigation (#205)\n- Versioned URLs: `/v2.3/…` keeps serving the previous docs (#201)\n\n## 2.3.0 — 2026-09-02\n…",
        },
        output: "Successfully overwrote file: CHANGELOG.md.",
        ms: 5,
        paths: ["CHANGELOG.md"],
      },
    ],
    final:
      "Four merged PRs since `v2.3.0`; the 2.4.0 entry lists each with its number: search shortcuts, dark-mode code blocks, the sidebar fix and versioned URLs. The heading says *unreleased* until you tag.",
  },
  {
    prompt:
      "Check that every page under docs/ has a description in its frontmatter and add a placeholder where one is missing.",
    steps: [
      {
        tool: "run_shell_command",
        input: {
          command: "for f in docs/**/*.md; do grep -L '^description:' \"$f\"; done",
          description: "Find pages without a description",
        },
        output: "docs/guides/webhooks.md\ndocs/reference/cli.md\n",
        ms: 120,
      },
      {
        tool: "google_web_search",
        input: { query: "meta description recommended length 2026" },
        output:
          "Search results: most guidance still recommends 120–155 characters so the description is not cut in result snippets.",
        ms: 2900,
      },
      {
        tool: "replace",
        input: {
          file_path: "docs/guides/webhooks.md",
          old_string: "title: Webhooks\n---",
          new_string:
            "title: Webhooks\ndescription: How webhook deliveries are signed, retried and made idempotent.\n---",
        },
        output: "Successfully modified file: docs/guides/webhooks.md (1 replacements).",
        ms: 5,
        paths: ["docs/guides/webhooks.md"],
      },
      {
        tool: "replace",
        input: {
          file_path: "docs/reference/cli.md",
          old_string: "title: CLI reference\n---",
          new_string: "title: CLI reference\ndescription: Every command and flag of the acme CLI.\n---",
        },
        output: "Successfully modified file: docs/reference/cli.md (1 replacements).",
        ms: 4,
        paths: ["docs/reference/cli.md"],
      },
    ],
    final:
      "Two pages had no description: `docs/guides/webhooks.md` and `docs/reference/cli.md`. Both now carry a one-sentence description under 155 characters; the rest of `docs/` already had one.",
  },
];

// ---------- Antigravity: github.com/acme/design-system (an IDE workspace) ----------
// Antigravity has no pre-tool hook and its PostToolUse carries no output, so a step's
// `input` is the toolCall.args the hook saw and there is no `output`; `unnamed` steps
// are the PostToolUse payloads that name no tool at all (a heartbeat on the wire).

export const ANTIGRAVITY_TURNS: readonly TurnScript[] = [
  {
    prompt:
      "The Button's focus ring disappears on the dark theme. Find which token it reads and fix it without touching the light theme.",
    steps: [
      {
        tool: "grep_search",
        input: { Query: "focus-ring", SearchPath: "packages/tokens", MatchPerLine: true },
        ms: 60,
        unnamed: true,
      },
      {
        tool: "read_file",
        input: { AbsolutePath: "~/code/design-system/packages/tokens/src/dark.css", StartLine: 1, EndLine: 60 },
        ms: 5,
      },
      {
        tool: "edit_file",
        input: {
          file_path: "~/code/design-system/packages/tokens/src/dark.css",
          old_string: "  --focus-ring: var(--color-brand-700);",
          new_string: "  --focus-ring: var(--color-brand-300);",
        },
        ms: 7,
      },
      {
        tool: "run_terminal_cmd",
        input: { CommandLine: "pnpm --filter @acme/tokens test -- --run", Cwd: "~/code/design-system" },
        ms: 6400,
        unnamed: true,
      },
    ],
    final:
      "On the dark theme `--focus-ring` pointed at `--color-brand-700`, which is within two lightness steps of the dark surface, so the ring was there but invisible. It now reads `--color-brand-300` in `dark.css` only; `light.css` is untouched. The tokens package tests pass, including the contrast check, which now reports 4.6:1 for the ring against the dark surface.",
  },
  {
    prompt: "Generate tokens.json from the CSS so the mobile team can consume it, and add a script for it.",
    steps: [
      {
        tool: "list_dir",
        input: { DirectoryPath: "~/code/design-system/packages/tokens/scripts" },
        ms: 4,
        unnamed: true,
      },
      {
        tool: "edit_file",
        input: {
          file_path: "~/code/design-system/packages/tokens/scripts/export-json.mjs",
          old_string: "",
          new_string:
            "import { readFileSync, writeFileSync } from 'node:fs';\nconst css = readFileSync('src/light.css', 'utf8') + readFileSync('src/dark.css', 'utf8');\nconst tokens = Object.fromEntries([...css.matchAll(/--([a-z0-9-]+):\\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));\nwriteFileSync('dist/tokens.json', JSON.stringify(tokens, null, 2));\n",
        },
        ms: 9,
      },
      {
        tool: "run_terminal_cmd",
        input: { CommandLine: "node scripts/export-json.mjs", Cwd: "~/code/design-system/packages/tokens" },
        ms: 420,
        ok: false,
        error: "ENOENT: no such file or directory, open 'dist/tokens.json'",
      },
      {
        tool: "edit_file",
        input: {
          file_path: "~/code/design-system/packages/tokens/scripts/export-json.mjs",
          old_string: "writeFileSync('dist/tokens.json'",
          new_string: "mkdirSync('dist', { recursive: true });\nwriteFileSync('dist/tokens.json'",
        },
        ms: 5,
      },
      {
        tool: "run_terminal_cmd",
        input: {
          CommandLine: "node scripts/export-json.mjs && wc -l dist/tokens.json",
          Cwd: "~/code/design-system/packages/tokens",
        },
        ms: 380,
        unnamed: true,
      },
    ],
    final:
      "`scripts/export-json.mjs` reads both theme files and writes every `--token: value` pair to `dist/tokens.json` (212 tokens). The first run failed because `dist/` did not exist yet; the script now creates it. Dark-theme values overwrite light ones in the flat map, so the mobile team gets one value per name; say if they want the two themes side by side instead.",
  },
];

// ---------- Cursor: github.com/acme/notify-service ----------
// Cursor's hooks carry `tool_input` as an object and `tool_output` as text; an edit is
// also reported by afterFileEdit, which is where the files.changed comes from.

export const CURSOR_TURNS: readonly TurnScript[] = [
  {
    prompt:
      "Digest emails go out twice when two cron workers overlap. Put a lock around the digest job so only one worker sends.",
    steps: [
      {
        tool: "Grep",
        input: { pattern: "sendDigest|digestJob", path: "src" },
        output:
          "src/jobs/digest.ts:18:export async function digestJob() {\nsrc/jobs/digest.ts:31:    await sendDigest(user);\nsrc/cron.ts:9:  schedule('*/15 * * * *', digestJob);\n",
        ms: 42,
      },
      {
        tool: "Read",
        input: { path: "src/jobs/digest.ts" },
        output:
          "export async function digestJob() {\n  const users = await usersDueForDigest();\n  for (const user of users) {\n    await sendDigest(user);\n    await markDigested(user.id);\n  }\n}\n",
        ms: 3,
      },
      {
        tool: "Edit",
        input: {
          path: "src/jobs/digest.ts",
          old_string: "export async function digestJob() {\n  const users = await usersDueForDigest();",
          new_string:
            "export async function digestJob() {\n  const lock = await redis.set('lock:digest', workerId, { NX: true, PX: 14 * 60_000 });\n  if (!lock) return;\n  const users = await usersDueForDigest();",
        },
        output: "Edited src/jobs/digest.ts",
        ms: 6,
        paths: ["src/jobs/digest.ts"],
      },
      {
        tool: "Shell",
        input: { command: "npx vitest run src/jobs", working_directory: "~/code/notify-service" },
        output: " ✓ src/jobs/digest.test.ts (5 tests) 143ms\n\n Test Files  1 passed (1)\n      Tests  5 passed (5)\n",
        ms: 3100,
      },
    ],
    final:
      "`digestJob` now takes a Redis lock (`SET lock:digest <workerId> NX PX 840000`) before it reads the due users and returns at once when another worker holds it. The 14-minute expiry sits under the 15-minute schedule, so a crashed worker never blocks the next run. The 5 digest tests pass; I did not add a test for the overlap itself because the suite has no second worker to stand up.",
  },
  {
    prompt:
      "Every HTML email template should have a plain-text twin next to it. Check them all and write the missing ones.",
    steps: [
      {
        tool: "Glob",
        input: { pattern: "templates/**/*.html" },
        output:
          "templates/digest.html\ntemplates/welcome.html\ntemplates/password-reset.html\ntemplates/invoice-ready.html\n",
        ms: 12,
      },
      {
        tool: "Task",
        input: {
          description: "Find templates without a .txt twin",
          prompt:
            "For each templates/**/*.html, check whether a .txt file with the same stem exists. List the ones that have none.",
        },
        output: "Missing: templates/password-reset.txt, templates/invoice-ready.txt",
        ms: 4,
        subagent: {
          type: "explore",
          steps: [
            {
              tool: "Glob",
              input: { pattern: "templates/**/*.txt" },
              output: "templates/digest.txt\ntemplates/welcome.txt\n",
              ms: 9,
            },
            {
              tool: "Read",
              input: { path: "templates/password-reset.html" },
              output:
                '<p>Someone asked to reset the password for {{email}}.</p>\n<p><a href="{{link}}">Reset it</a> within the next hour.</p>\n',
              ms: 3,
            },
          ],
        },
      },
      {
        tool: "Write",
        input: {
          path: "templates/password-reset.txt",
          contents: "Someone asked to reset the password for {{email}}.\n\nReset it within the next hour: {{link}}\n",
        },
        output: "Wrote templates/password-reset.txt",
        ms: 4,
        paths: ["templates/password-reset.txt"],
      },
      {
        tool: "Write",
        input: {
          path: "templates/invoice-ready.txt",
          contents: "Your invoice {{number}} for {{total}} is ready.\n\nView it: {{link}}\n",
        },
        output: "Wrote templates/invoice-ready.txt",
        ms: 4,
        paths: ["templates/invoice-ready.txt"],
      },
      {
        tool: "Shell",
        input: { command: "npm run lint:templates", working_directory: "~/code/notify-service" },
        output: "",
        ok: false,
        error: "templates/invoice-ready.txt: unknown placeholder {{total}} (did you mean {{amount}}?)\nExit code 1",
        ms: 900,
      },
      {
        tool: "Edit",
        input: {
          path: "templates/invoice-ready.txt",
          old_string: "for {{total}} is ready.",
          new_string: "for {{amount}} is ready.",
        },
        output: "Edited templates/invoice-ready.txt",
        ms: 3,
        paths: ["templates/invoice-ready.txt"],
      },
      {
        tool: "Shell",
        input: { command: "npm run lint:templates", working_directory: "~/code/notify-service" },
        output: "4 templates, 4 plain-text twins, 0 problems\n",
        ms: 850,
      },
    ],
    final:
      "Two of the four templates had no plain-text twin: `password-reset` and `invoice-ready`. Both now have one with the same placeholders as the HTML. The template linter caught that I had written `{{total}}` where the HTML uses `{{amount}}`; fixed, and it reports 4 templates, 4 twins, 0 problems.",
  },
];

/** Titles for the historical (backfilled) sessions. */
export const BACKFILL_TITLES: readonly { text: string; source: "custom" | "harness" | "first-ask" }[] = [
  { text: "Rate limiter for the public API", source: "harness" },
  { text: "Flaky checkout test", source: "custom" },
  { text: "Migrate sessions table to uuid", source: "harness" },
  { text: "Why is the nightly build red", source: "first-ask" },
  { text: "Offline cart sync", source: "harness" },
  { text: "Upgrade to Vite 6", source: "custom" },
  { text: "Can you explain the retry queue to me", source: "first-ask" },
  { text: "Search ranking regression", source: "harness" },
  { text: "Late events in the pipeline", source: "harness" },
  { text: "Docs: getting started rewrite", source: "custom" },
  { text: "Add the audit log export", source: "harness" },
  { text: "Fix the CSV import encoding", source: "first-ask" },
  { text: "Terraform drift in staging", source: "harness" },
  { text: "Onboarding emails", source: "custom" },
  { text: "Tighten the CSP header", source: "harness" },
  { text: "Make the invoice list paginate", source: "first-ask" },
];

/** The prompts a Claude Code session uses to come back to a backfilled session (source: resume). */
export const RESUME_TURN: TurnScript = {
  prompt: "Picking this back up: where did we leave the rate limiter? Summarise the state and run the tests.",
  steps: [
    {
      tool: "Bash",
      input: {
        command: "git log --oneline -5 && git status --short",
        description: "Recent commits and the working tree",
      },
      output: bash(
        "b31c2a7 limiter: token bucket per account\n9ad04f2 limiter: config and tests\n3f9e1c0 api: route plumbing\n M src/api/limiter.ts\n",
      ),
      ms: 45,
      say: "Two commits on the limiter and one uncommitted change in `src/api/limiter.ts`.",
    },
    {
      tool: "Bash",
      input: { command: "npx vitest run src/api/limiter.test.ts", description: "Run the limiter tests" },
      output: bash(
        " ✓ src/api/limiter.test.ts (7 tests) 88ms\n\n Test Files  1 passed (1)\n      Tests  7 passed (7)\n",
      ),
      ms: 2100,
    },
  ],
  final:
    "The limiter is a per-account token bucket (`b31c2a7`), with config and tests in the commit before it. The uncommitted change in `src/api/limiter.ts` adds the `Retry-After` header on a 429; the 7 tests pass with it. What's left is wiring the limiter into the router, which the earlier plan listed as the last step.",
};

/** Lines the silent session gets through before it goes quiet. */
export const SILENT_TURN: TurnScript = {
  abandon: true,
  prompt: "Profile the cart screen on a cold start and tell me where the first 800 ms go.",
  steps: [
    {
      tool: "Bash",
      input: {
        command: "npx react-native profile --cold-start --screen Cart --out /tmp/cart.trace",
        description: "Profile a cold start of the cart screen",
      },
      output: bash("trace written to /tmp/cart.trace (3.2 MB)\n"),
      ms: 24000,
      say: "Capturing a cold-start trace of the cart screen.",
    },
    {
      tool: "Read",
      input: { file_path: "/tmp/cart.trace", limit: 200 },
      output: read("/tmp/cart.trace", '{"traceEvents":[{"name":"Bundle load","dur":412000},…', 18000),
      ms: 7,
    },
  ],
  final: "",
};

/** Three reviewers at once (Claude Code): two in the background, one the orchestrator
 *  waits for. The background ones outlive the turn that launched them and report back
 *  through `<task-notification>` turns, as the recording (conformance/harness/claude-code)
 *  has them; one of their tools fails. */
export const PARALLEL_TURN: TurnScript = {
  prompt:
    "Before I merge the BM25 cache, review it from three angles at once with subagents: correctness of the invalidation, the hot-path performance, and what the tests miss.",
  title: { text: "Search: review the BM25 cache", source: "custom" },
  steps: [
    {
      tool: "Agent",
      input: {
        description: "Check cache invalidation",
        prompt:
          "Read src/rank/bm25-cache.ts and every caller. Find any path where an index write leaves a stale cached score. Report file:line and why.",
        subagent_type: "Explore",
      },
      output: { isAsync: true, status: "async_launched", agentId: "", description: "Check cache invalidation" },
      ms: 5,
      say: "Three reviewers are on it: invalidation and performance in the background, test coverage while I wait.",
      subagent: {
        type: "Explore",
        think: [16_000, 5000],
        steps: [
          {
            tool: "Grep",
            input: { pattern: "bm25Cache\\.(get|set|clear)", output_mode: "content", "-n": true },
            output: grepLines(
              "src/rank/bm25-cache.ts:14:  bm25Cache.set(key, score)\nsrc/index/write.ts:52:  bm25Cache.clear(docId)\nsrc/index/bulk.ts:88:  // TODO: bm25Cache",
              3,
            ),
            ms: 38,
          },
          {
            tool: "Read",
            input: { file_path: "~/code/search-api/src/index/bulk.ts", offset: 70, limit: 40 },
            output: read(
              "/Users/dev/code/search-api/src/index/bulk.ts",
              "export async function bulkIndex(docs: Doc[]) {\n  for (const d of docs) await writeDoc(d, { skipHooks: true });\n  // TODO: bm25Cache\n}\n",
              120,
            ),
            ms: 4,
          },
          {
            tool: "Grep",
            input: { pattern: "skipHooks", output_mode: "files_with_matches" },
            output: grepFiles(["src/index/bulk.ts", "src/index/write.ts", "scripts/reindex.ts"]),
            ms: 29,
          },
        ],
        result:
          "One stale path: bulkIndex() (src/index/bulk.ts:88) writes with skipHooks, so write.ts:52 never clears the cached score. scripts/reindex.ts goes through the same path.",
        followUp:
          "The invalidation review found one real hole: bulk indexing skips the hook that clears the cache. I'll clear it per document in bulkIndex().",
      },
    },
    {
      tool: "Agent",
      input: {
        description: "Profile the scoring hot path",
        prompt:
          "Run the search benchmark with and without the cache and tell me the p50/p99 difference and where the remaining time goes.",
        subagent_type: "general-purpose",
      },
      output: { isAsync: true, status: "async_launched", agentId: "", description: "Profile the scoring hot path" },
      ms: 4,
      subagent: {
        type: "general-purpose",
        think: [24_000, 6000],
        steps: [
          {
            tool: "Bash",
            input: { command: "npm run bench -- --filter score", description: "Benchmark scoring with the cache" },
            output: bash("score/cached     p50 1.8 ms  p99 6.4 ms\nscore/uncached   p50 4.9 ms  p99 21.0 ms\n"),
            ms: 31_000,
          },
          {
            tool: "Bash",
            input: { command: "npm run bench -- --filter score --profile", description: "Profile the cached path" },
            ok: false,
            error: "Error: --profile needs node --cpu-prof; run with NODE_OPTIONS=--cpu-prof",
            output: bash("", "Error: --profile needs node --cpu-prof; run with NODE_OPTIONS=--cpu-prof\n"),
            ms: 900,
          },
          {
            tool: "Bash",
            input: {
              command: "NODE_OPTIONS=--cpu-prof npm run bench -- --filter score",
              description: "Profile the cached path with a CPU profile",
            },
            output: bash("score/cached     p50 1.9 ms  p99 6.6 ms\nwrote CPU.20261022.cpuprofile\n"),
            ms: 34_000,
          },
        ],
        result:
          "The cache cuts scoring p50 from 4.9 ms to 1.8 ms and p99 from 21 ms to 6.4 ms. What remains is tokenising the query (about 60% of the cached path).",
        followUp:
          "Performance holds up: p99 drops from 21 ms to 6.4 ms. Query tokenising is the next thing to look at.",
      },
    },
    {
      tool: "Agent",
      input: {
        description: "List untested cache paths",
        prompt: "Compare src/rank/bm25-cache.ts with its tests and list the branches no test reaches.",
        subagent_type: "general-purpose",
      },
      ms: 3,
      subagent: {
        type: "general-purpose",
        think: [9000, 2500],
        steps: [
          {
            tool: "Read",
            input: { file_path: "~/code/search-api/src/rank/bm25-cache.test.ts" },
            output: read(
              "/Users/dev/code/search-api/src/rank/bm25-cache.test.ts",
              "it('returns the cached score', …)\nit('misses after clear()', …)\n",
              40,
            ),
            ms: 3,
          },
          {
            tool: "Bash",
            input: { command: "npx vitest run src/rank --coverage", description: "Coverage for the rank module" },
            output: bash("bm25-cache.ts | 71.4 | 50 | 80 | 71.4 | 22-27,41\n"),
            ms: 6200,
          },
        ],
        result:
          "Untested: the eviction branch (lines 22–27) and the size cap (line 41). Both caches paths that only run past 10 000 entries.",
      },
    },
    {
      tool: "Read",
      input: { file_path: "~/code/search-api/src/rank/bm25-cache.ts" },
      output: read(
        "/Users/dev/code/search-api/src/rank/bm25-cache.ts",
        "export const bm25Cache = new LruMap<string, number>({ max: 10_000 });\n",
        58,
      ),
      ms: 3,
    },
  ],
  final:
    "The coverage review is back: eviction (lines 22–27) and the size cap (line 41) have no tests. The invalidation and performance reviewers are still running in the background; I'll summarise them as they report.",
};

// ---------- sessionpipe 0.10 scenes (studio-mac, inherit mode) ----------

/** Background work (`turn.ended.background`): two commands left running at the Stop; the
 *  session waits on them, then wakes when the first finishes (Claude Code's own
 *  `<task-notification>`, `injected`), with one still in flight. */
export const BACKGROUND_TURNS: readonly TurnScript[] = [
  {
    prompt:
      "Run the integration suite in the background and keep an eye on the staging deploy; tell me when either one finishes.",
    title: { text: "Integration suite and staging deploy", source: "harness" },
    steps: [
      {
        tool: "Bash",
        input: {
          command: "npm run test:integration",
          description: "Run the integration suite",
          run_in_background: true,
        },
        output: { backgroundTaskId: "b7k2m9", stdout: "", stderr: "" },
        ms: 900,
        say: "Started the integration suite in the background.",
      },
      {
        tool: "Bash",
        input: {
          command: "kubectl rollout status deploy/billing -n staging --watch",
          description: "Watch the staging deploy",
          run_in_background: true,
        },
        output: { backgroundTaskId: "c4p8x1", stdout: "", stderr: "" },
        ms: 700,
      },
    ],
    final:
      "Both are running in the background: the integration suite (about six minutes) and a watch on the staging rollout. I'll report as each one finishes.",
    background: 2,
    waitAfter: 240_000,
  },
  {
    injected: true,
    prompt:
      '<task-notification>\n<task-id>b7k2m9</task-id>\n<status>completed</status>\n<summary>Background command "Run the integration suite" completed (exit code 0)</summary>\n</task-notification>',
    steps: [
      {
        tool: "Read",
        input: { file_path: "/tmp/claude/b7k2m9.output", limit: 40 },
        output: read("/tmp/claude/b7k2m9.output", "Tests: 412 passed, 412 total\nTime: 5m 48s", 2),
        ms: 6,
      },
    ],
    final:
      "The integration suite passed: 412 tests, no failures. The staging rollout is still going; I'm waiting on it.",
    background: 1,
    waitAfter: 180_000,
  },
];

/** A scheduled wake-up (`submitted_by: schedule_wakeup`): the person asked once, the
 *  harness's own schedule submits the next turn. */
export const SCHEDULED_TURNS: readonly TurnScript[] = [
  {
    prompt: "Every 30 minutes, check the nightly build and open an issue for any test that started failing.",
    steps: [
      {
        tool: "Bash",
        input: {
          command: "gh run list --workflow nightly --limit 1 --json conclusion",
          description: "Last nightly run",
        },
        output: bash('[{"conclusion":"success"}]\n'),
        ms: 1800,
      },
    ],
    final: "Last night's build passed. I'll check again in 30 minutes.",
    submittedBy: "user",
    waitAfter: 50_000,
  },
  {
    submittedBy: "schedule_wakeup",
    prompt: "Check the nightly build and open an issue for any test that started failing.",
    steps: [
      {
        tool: "Bash",
        input: {
          command: "gh run list --workflow nightly --limit 1 --json conclusion",
          description: "Last nightly run",
        },
        output: bash('[{"conclusion":"failure"}]\n'),
        ms: 1600,
        say: "The nightly build failed; looking at which tests.",
      },
      {
        tool: "Bash",
        input: { command: "gh run view --log-failed | tail -n 20", description: "Failed tests" },
        output: bash("FAIL test/invoices/proration.test.ts\n  ✕ prorates a mid-cycle downgrade (41 ms)\n"),
        ms: 2400,
      },
    ],
    final:
      "The nightly build failed on one test, `prorates a mid-cycle downgrade` in test/invoices/proration.test.ts. It passed the night before, so I opened an issue for it.",
  },
];

/** A run nobody attended (`session.attended: false`): a script's one-shot `claude -p`. */
export const UNATTENDED_TURN: TurnScript = {
  prompt: "Summarize the commits since v2.3.0 as release notes, one line each.",
  steps: [
    {
      tool: "Bash",
      input: { command: "git log v2.3.0..HEAD --oneline", description: "Commits since v2.3.0" },
      output: bash("a1f3c2e Prorate mid-cycle downgrades\n9be01d4 Retry webhooks with backoff\n"),
      ms: 400,
    },
  ],
  final: "- Mid-cycle downgrades are prorated.\n- Webhook deliveries retry with backoff.",
};

// ---------- agents that ask each other (sessionpipe ask, a handoff) ----------

const RETRY_DIFF =
  "diff --git a/src/webhooks/send.ts b/src/webhooks/send.ts\n@@ -18,7 +18,12 @@ export async function deliver(job: WebhookJob) {\n-  const delay = 30_000;\n+  // 1 s, 2 s, 4 s, 8 s, 16 s; five tries, then the dead-letter queue.\n+  const delay = Math.min(1000 * 2 ** job.attempt, 16_000);\n+  if (job.attempt >= 5) return deadLetter(job);\n";

/** What Codex answers when asked to review the backoff change (the ask's reply, and the
 *  handoff's too: the same question from two directions). */
const CODEX_REVIEW =
  'Two things I\'d change.\n\n1. Add jitter. Five failed deliveries to the same endpoint now retry in lockstep (1 s, 2 s, 4 s…), which is the thundering herd the backoff was meant to avoid. `delay * (0.5 + Math.random())` is enough.\n2. `job.attempt >= 5` checks the attempt *before* this delivery, so a job gets six tries, not five. Either compare against `attempt + 1` or say "six" in the comment.\n\nThe cap at 16 s is fine for a webhook. The dead-letter path reads right.';

/** Codex, asked for the review: its first prompt is the question as the daemon frames it
 *  (sim.ts adds the trailer), and it answers in one turn. */
export const CODEX_ASKED_TURN: TurnScript = {
  prompt:
    "Review the diff in src/webhooks/send.ts: exponential backoff on webhook retries. Say what you'd do differently.",
  title: { text: "Review: backoff on webhook retries", source: "harness" },
  steps: [
    {
      tool: "Bash",
      input: { command: "git diff -- src/webhooks/send.ts" },
      output: RETRY_DIFF,
      ms: 60,
    },
    {
      tool: "Bash",
      input: { command: "sed -n 1,40p src/webhooks/send.ts" },
      output:
        "import { deadLetter } from './dead-letter';\nimport type { WebhookJob } from './types';\n\nexport async function deliver(job: WebhookJob) {\n  …\n",
      ms: 20,
    },
  ],
  final: CODEX_REVIEW,
};

/** A Claude Code turn that asks Codex for a review through the daemon (`sessionpipe ask`
 *  in a Bash step), then applies the answer. */
export const ASK_TURN: TurnScript = {
  prompt:
    "Make the webhook sender retry with exponential backoff instead of a flat 30 s, then ask Codex for a second opinion on the diff before you commit.",
  title: { text: "Webhook retries with backoff", source: "harness" },
  steps: [
    {
      tool: "Read",
      input: { file_path: "~/code/billing/src/webhooks/send.ts" },
      output: read(
        "/Users/dev/code/billing/src/webhooks/send.ts",
        "export async function deliver(job: WebhookJob) {\n  try {\n    await post(job);\n  } catch (err) {\n    const delay = 30_000;\n    return queue.enqueue({ ...job, attempt: job.attempt + 1 }, { delay });\n  }\n}\n",
        36,
      ),
      ms: 5,
      say: "The retry delay is a flat 30 s in `deliver`; I'll make it exponential with a cap and a dead-letter after five tries.",
    },
    {
      tool: "Edit",
      input: {
        file_path: "~/code/billing/src/webhooks/send.ts",
        old_string: "    const delay = 30_000;",
        new_string:
          "    // 1 s, 2 s, 4 s, 8 s, 16 s; five tries, then the dead-letter queue.\n    const delay = Math.min(1000 * 2 ** job.attempt, 16_000);\n    if (job.attempt >= 5) return deadLetter(job);",
      },
      output: edit("~/code/billing/src/webhooks/send.ts", "    const delay = 30_000;", "    const delay = …"),
      ms: 9,
      paths: ["src/webhooks/send.ts"],
      say: "Backoff is in: 1 s, 2 s, 4 s, 8 s, 16 s, then the dead-letter queue. Asking Codex to review the diff.",
    },
    {
      tool: "Bash",
      input: {
        command:
          'sessionpipe ask codex "Review the diff in src/webhooks/send.ts: exponential backoff on webhook retries. Say what you\'d do differently."',
        description: "Ask Codex to review the diff",
      },
      ms: 0,
      ask: { harness: "codex", text: CODEX_ASKED_TURN.prompt, turns: [CODEX_ASKED_TURN] },
      say: "Codex is back: it wants jitter on the delay, and it caught an off-by-one in the try count. Both are right.",
    },
    {
      tool: "Edit",
      input: {
        file_path: "~/code/billing/src/webhooks/send.ts",
        old_string:
          "    const delay = Math.min(1000 * 2 ** job.attempt, 16_000);\n    if (job.attempt >= 5) return deadLetter(job);",
        new_string:
          "    const base = Math.min(1000 * 2 ** job.attempt, 16_000);\n    const delay = Math.round(base * (0.5 + Math.random()));\n    if (job.attempt + 1 >= 5) return deadLetter(job);",
      },
      output: edit("~/code/billing/src/webhooks/send.ts", "    const delay = Math.min(…", "    const base = …"),
      ms: 11,
      paths: ["src/webhooks/send.ts"],
    },
    {
      tool: "Bash",
      input: { command: "git commit -am 'webhooks: retry with exponential backoff and jitter'", description: "Commit" },
      output: bash(
        "[fix/webhook-retry 7c1e2d9] webhooks: retry with exponential backoff and jitter\n 1 file changed, 5 insertions(+), 2 deletions(-)\n",
      ),
      ms: 140,
    },
  ],
  final:
    "Done. Retries back off 1 s → 16 s with jitter and go to the dead-letter queue after five tries. I asked Codex to review the diff: it suggested the jitter (so a burst of failures doesn't retry in lockstep) and caught that the try count was off by one; both are in. Committed as `webhooks: retry with exponential backoff and jitter`.",
};

/** The session a handoff is asked from: one plain turn, then (sim.ts `handoff`) Codex's
 *  answer arrives as a framed prompt and this turn's `followUp` answers it. */
export const HANDOFF_PARENT_TURN: TurnScript = {
  prompt: "Switch the webhook sender's retries from a flat 30 s to exponential backoff, capped at 16 s.",
  title: { text: "Webhook backoff", source: "harness" },
  steps: [
    {
      tool: "Edit",
      input: {
        file_path: "~/code/billing/src/webhooks/send.ts",
        old_string: "    const delay = 30_000;",
        new_string:
          "    const delay = Math.min(1000 * 2 ** job.attempt, 16_000);\n    if (job.attempt >= 5) return deadLetter(job);",
      },
      output: edit("~/code/billing/src/webhooks/send.ts", "    const delay = 30_000;", "    const delay = …"),
      ms: 8,
      paths: ["src/webhooks/send.ts"],
    },
  ],
  final:
    "Retries now back off 1 s, 2 s, 4 s, 8 s, 16 s and stop after five tries, when the job goes to the dead-letter queue. The diff is in src/webhooks/send.ts; I haven't committed it.",
};

export const HANDOFF: HandoffScript = {
  harness: "codex",
  text: `Give a second opinion on the reply below. Point out what you'd do differently and why.\n\n---\n${HANDOFF_PARENT_TURN.final}`,
  turns: [
    {
      ...CODEX_ASKED_TURN,
      prompt: "",
      title: { text: "Second opinion on the webhook retry", source: "harness" },
    },
  ],
  followUp:
    "Codex is right on both counts. I've added jitter (`base * (0.5 + Math.random())`) and fixed the try count to compare `attempt + 1`, so a job gets exactly five tries. Still uncommitted; say the word and I'll commit.",
};
