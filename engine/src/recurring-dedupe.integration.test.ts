import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { runDueRecurringSchedules, runScheduleNow } from "./recurring.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting, type ScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Seed an auto-post customer-invoice template plus a due monthly schedule.
 * The scratch org has the full posting spine (open July 2026 period, AR/bank
 * control accounts, revenue account), so a generated document posts like a
 * hand-entered one.
 */
async function seedInvoiceSchedule(
  org: ScratchOrg,
  actorId: string,
  opts: { templateCreatedBy?: string | null; autoPost?: boolean } = {},
): Promise<string> {
  const templateId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, document_date, due_date, currency,
       subtotal, tax_total, total, party_id, created_by)
    values (${templateId}, ${org.orgId}, 'customer_invoice', 'draft', ${"TPL-" + templateId.slice(0, 8)},
            ${org.date}, ${org.date}, 'CAD', '100.00', '0.00', '100.00', ${org.customerId},
            ${opts.templateCreatedBy === undefined ? actorId : opts.templateCreatedBy})
  `);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, description, quantity, unit, unit_price, amount, created_by)
    values (${org.orgId}, ${templateId}, 1, ${org.accounts.revenue}, 'Recurring service',
            '1', 'ea', '100.00', '100.00', ${actorId})
  `);
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into recurring_schedules
      (id, org_id, template_document_id, cadence, next_run_on, auto_post, is_active, name, created_by)
    values (${scheduleId}, ${org.orgId}, ${templateId}, 'monthly', ${org.date},
            ${opts.autoPost ?? true}, true, 'Dedupe fixture', ${actorId})
  `);
  return scheduleId;
}

async function postedInvoiceCount(orgId: string): Promise<number> {
  const r = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from documents
     where org_id = ${orgId} and kind = 'customer_invoice' and status = 'posted'
  `));
  return Number(r.rows[0]!.n);
}

async function journalEntryCount(orgId: string): Promise<number> {
  const r = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from journal_entries where org_id = ${orgId}
  `));
  return Number(r.rows[0]!.n);
}

/** Re-create the defect window: the claim was rolled back AFTER a posted document committed. */
async function restoreClaim(scheduleId: string, occurrenceOn: string): Promise<void> {
  await db.execute(sql`
    update recurring_schedules
       set next_run_on = ${occurrenceOn}, is_active = true, last_run_at = null
     where id = ${scheduleId}
  `);
}

test(
  "a tick retrying an already-posted occurrence replays the same document instead of re-posting",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Scheduler", "admin");
      const scheduleId = await seedInvoiceSchedule(org, actorId);

      const first = await runDueRecurringSchedules(org.date);
      assert.equal(first.failed, 0);
      assert.equal(first.generated, 1);
      assert.equal(first.posted, 1);
      const firstDoc = first.documents[0]!.documentId;
      assert.equal(await postedInvoiceCount(org.orgId), 1);
      assert.equal(await journalEntryCount(org.orgId), 1);

      // The exact pre-fix double-post state: success bookkeeping failed after
      // the post, and the catch restored next_run_on to the occurrence date.
      await restoreClaim(scheduleId, org.date);
      const second = await runDueRecurringSchedules(org.date);
      assert.equal(second.failed, 0);
      assert.equal(second.generated, 1, "the retried tick still reports the replayed generation");
      assert.equal(second.posted, 1, "the replay reports the committed posted state");
      assert.equal(
        second.documents[0]!.documentId,
        firstDoc,
        "the retry replays the occurrence-guard document, never mints a second one",
      );
      assert.equal(await postedInvoiceCount(org.orgId), 1, "exactly one invoice exists for the occurrence");
      assert.equal(await journalEntryCount(org.orgId), 1, "the ledger was hit exactly once");

      const guard = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from recurring_occurrence_documents where org_id = ${org.orgId}
      `));
      assert.equal(Number(guard.rows[0]!.n), 1);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "concurrent generations of the same occurrence converge on one document",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Scheduler", "admin");
      const scheduleId = await seedInvoiceSchedule(org, actorId);

      // A "run now" racing another "run now" — both enter generateFromTemplate
      // for the same occurrence date; the schedule row lock serializes them and
      // the loser replays the winner's committed guard row.
      const [a, b] = await Promise.all([
        runScheduleNow(scheduleId, org.date),
        runScheduleNow(scheduleId, org.date),
      ]);
      assert.equal(a.documentId, b.documentId, "both callers observe the same document");
      assert.equal(await postedInvoiceCount(org.orgId), 1);
      assert.equal(await journalEntryCount(org.orgId), 1);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "an interrupted generation consumes nothing — the next tick retries and completes it",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Scheduler", "admin");
      // auto_post with no attributable creator throws mid-generation — AFTER
      // the occurrence was claimed inside the same transaction. Atomicity
      // makes that indistinguishable from a hard process kill: nothing about
      // the claim may become durable.
      const scheduleId = await seedInvoiceSchedule(org, actorId, { templateCreatedBy: null });

      const run = await runDueRecurringSchedules(org.date);
      assert.equal(run.failed, 1);
      const state = (await db.execute<{ nextRunOn: string; lastError: string | null; isActive: boolean; runCount: number; lastDocumentId: string | null }>(sql`
        select next_run_on as "nextRunOn", last_error as "lastError", is_active as "isActive",
               run_count as "runCount", last_document_id as "lastDocumentId"
          from recurring_schedules where id = ${scheduleId}
      `));
      assert.equal(state.rows[0]!.nextRunOn, org.date, "the occurrence stays due for the next tick");
      assert.ok(state.rows[0]!.lastError, "last_error names the failure");
      assert.equal(state.rows[0]!.isActive, true, "the schedule was not deactivated by the failure");
      assert.equal(state.rows[0]!.runCount, 0, "no success bookkeeping leaked from the failed tick");
      assert.equal(state.rows[0]!.lastDocumentId, null);
      assert.equal(await postedInvoiceCount(org.orgId), 0);
      assert.equal(await journalEntryCount(org.orgId), 0);
      const guard = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from recurring_occurrence_documents where org_id = ${org.orgId}
      `));
      assert.equal(Number(guard.rows[0]!.n), 0, "a failed generation never consumes the occurrence");

      // The crash-window regression: whatever killed the first attempt (here a
      // mid-generation throw; equally a SIGKILL — no durable claim exists to
      // strand), the next tick must complete the SAME occurrence exactly once.
      await db.execute(sql`
        update recurring_schedules set last_error = null where id = ${scheduleId}
      `);
      const templateId = (await db.execute<{ id: string }>(sql`
        select template_document_id as id from recurring_schedules where id = ${scheduleId}
      `)).rows[0]!.id;
      await db.execute(sql`
        update documents set created_by = ${actorId} where id = ${templateId}
      `);
      const retry = await runDueRecurringSchedules(org.date);
      assert.equal(retry.failed, 0);
      assert.equal(retry.generated, 1, "the retried tick generates the missed occurrence");
      assert.equal(retry.posted, 1);
      assert.equal(await postedInvoiceCount(org.orgId), 1, "exactly one invoice ever exists");
      assert.equal(await journalEntryCount(org.orgId), 1, "the ledger was hit exactly once");
      const retriedState = (await db.execute<{ nextRunOn: string; runCount: number }>(sql`
        select next_run_on as "nextRunOn", run_count as "runCount" from recurring_schedules where id = ${scheduleId}
      `));
      assert.notEqual(retriedState.rows[0]!.nextRunOn, org.date, "the claim now advances");
      assert.equal(retriedState.rows[0]!.runCount, 1);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "occurrence lineage is append-only outside a sandbox wipe",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Scheduler", "admin");
      const scheduleId = await seedInvoiceSchedule(org, actorId);
      await runDueRecurringSchedules(org.date);
      await assert.rejects(
        db.execute(sql`
          update recurring_occurrence_documents set occurrence_on = '2030-01-01' where org_id = ${org.orgId}
        `),
        (error: unknown) => {
          // Drizzle wraps driver errors; the guard's message rides on .cause.
          const text = [error, (error as { cause?: unknown })?.cause].map(String).join(": ");
          return /immutable/.test(text);
        },
        "guard lineage must refuse UPDATE outside a sandbox wipe",
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
