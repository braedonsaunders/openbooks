import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Background work must carry LEGAL tenant context.
 *
 * `engine/src/db.ts` denies by default: with no AsyncLocalStorage scope and no
 * host request resolver, every pooled query runs with `app.current_org = ''`
 * and `app.bypass_rls = 'off'`. The web request path registers a resolver
 * (web/lib/request-org.ts), but a `setInterval` tick and a BullMQ job callback
 * both run OUTSIDE any request store — so a scheduler or worker that touches
 * the database without crossing `withBypassContext` / `withOrgContext` /
 * `withOrg` reads ZERO ROWS AND RAISES NO ERROR.
 *
 * That failure mode is invisible in logs: the scan simply finds nothing to do
 * and the tick reports success. It once silently disabled every backup,
 * scheduled report, sandbox refresh, overhead publish, scheduled script,
 * payment schedule, flow timer, close automation and FX feed in production.
 *
 * These are source-shape assertions rather than runtime ones on purpose: the
 * defect is the ABSENCE of a boundary, which no unit test can observe without a
 * live RLS-enforcing database. Companion runtime proof lives in the bootstrap
 * RLS verification; this test is the cheap guard that keeps a new background
 * entry point from shipping without a boundary at all.
 */

/** The four sanctioned boundaries from `engine/src/db.ts`. `withBypass` is the
 *  pinned-transaction form of `withBypassContext`; `withOrg(null, …)` is what it
 *  delegates to, so both spellings are legitimate for org-spanning work. */
const CONTEXT_BOUNDARY = /withBypassContext\(|withOrgContext\(|withBypass\(|withOrg\(/;

/** Every background entry point, and the source file it lives in. */
const ENTRY_POINTS: Array<{ file: string; entry: string }> = [
  // In-web cron (web/instrumentation.node.ts → ensureScheduler)
  { file: "../scheduler.ts", entry: "export async function tick" },
  { file: "../sftp/import-job.ts", entry: "export async function runDueSftpImports" },
  { file: "../payment-operations.ts", entry: "export async function runDuePaymentSchedules" },
  { file: "../recurring.ts", entry: "export async function runDueRecurringSchedules" },
  { file: "../dunning.ts", entry: "export async function runDunning" },
  { file: "../subscription-billing.ts", entry: "export async function runDueSubscriptions" },
  { file: "../bank-feed-providers.ts", entry: "export async function runDueBankFeeds" },
  { file: "../flows/scheduled.ts", entry: "export async function runDueScheduledFlows" },
  { file: "../flows/gates.ts", entry: "export async function processGateTimers" },
  { file: "../close.ts", entry: "export async function recloseExpiredReopens" },
  { file: "../close.ts", entry: "export async function runDueCloseAutomations" },
  { file: "../fx-providers.ts", entry: "export async function runDueFxProviders" },
  { file: "../continuous-close.ts", entry: "export async function runDueContinuousCloseAgents" },
  // Standalone worker process (engine/src/worker/index.ts)
  { file: "./scheduler.ts", entry: "export async function tick" },
  { file: "./backup-scheduler.ts", entry: "export async function tick" },
  { file: "./sandbox-scheduler.ts", entry: "export async function tick" },
  { file: "./overhead-scheduler.ts", entry: "export async function tick" },
  { file: "../backup.ts", entry: "export async function executeBackupRun" },
  // BullMQ job handlers — a queue callback has no request store either
  { file: "./email-worker.ts", entry: "export function createEmailWorker" },
  { file: "./scripts-worker.ts", entry: "export function createScriptsWorker" },
  { file: "./ap-capture-worker.ts", entry: "export function createApCaptureWorker" },
  { file: "./close-delivery-worker.ts", entry: "export function createCloseDeliveryWorker" },
  { file: "./reports-worker.ts", entry: "export function createReportsWorker" },
];

/** Source of one exported function, up to the next top-level declaration. */
function entryBody(file: string, entry: string): string {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const start = source.indexOf(entry);
  assert.notEqual(start, -1, `${file} no longer declares ${entry}`);
  const after = source.slice(start + entry.length);
  const next = after.search(/\n(export |type |async function |function |const )/);
  return next === -1 ? after : after.slice(0, next);
}

for (const { file, entry } of ENTRY_POINTS) {
  const name = entry.replace(/^export (async )?function /, "");
  test(`${file} :: ${name} crosses an explicit tenant boundary`, () => {
    assert.match(
      entryBody(file, entry),
      CONTEXT_BOUNDARY,
      `${file} :: ${name} touches the database from a context-free callback. ` +
        "Wrap org-spanning discovery in withBypassContext and per-tenant work " +
        "in withOrgContext/withOrg, or RLS denies it silently.",
    );
  });
}

test("the deny-by-default contract that makes those boundaries load-bearing still holds", () => {
  const db = readFileSync(new URL("../db.ts", import.meta.url), "utf8");
  // applyGuc must keep treating "no context" as no authority. If this ever
  // becomes a bypass fallback, every assertion above stops meaning anything.
  assert.match(db, /const bypass = ctx\?\.bypass === true;/);
  assert.match(db, /const org = bypass \? "" : ctx\?\.orgId \?\? "";/);
});
