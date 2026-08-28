import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { runDueRecurringSchedules, runScheduleNow } from "./recurring.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  seedApprovalFlow,
  type ScratchOrg,
} from "./test-fixtures.ts";

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

/**
 * Force the final lineage insert to fail after the document and its lines have
 * been written. The UUID-scoped trigger cannot affect another schedule, and
 * returning cleanup keeps the test database pristine when an assertion throws.
 */
async function failOccurrenceLineageInsert(scheduleId: string): Promise<() => Promise<void>> {
  const suffix = scheduleId.replaceAll("-", "").slice(0, 12);
  const functionName = `openbooks_test_fail_recurring_${suffix}`;
  const triggerName = `openbooks_test_fail_recurring_${suffix}`;
  await db.execute(sql.raw(`
    create function public.${functionName}() returns trigger
    language plpgsql as $$
    begin
      raise exception 'forced recurring lineage failure';
    end
    $$
  `));
  await db.execute(sql.raw(`
    create trigger ${triggerName}
    before insert on public.recurring_occurrence_documents
    for each row when (new.schedule_id = '${scheduleId}'::uuid)
    execute function public.${functionName}()
  `));
  return async () => {
    await db.execute(sql.raw(`
      drop trigger if exists ${triggerName} on public.recurring_occurrence_documents
    `));
    await db.execute(sql.raw(`drop function if exists public.${functionName}()`));
  };
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
        runScheduleNow(scheduleId, actorId, org.date),
        runScheduleNow(scheduleId, actorId, org.date),
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
  "scheduled generation uses system provenance instead of the historical template author",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const historicalAuthor = await createScratchUser(org.orgId, "Historical author", "admin");
      const scheduleId = await seedInvoiceSchedule(org, historicalAuthor);

      const run = await runDueRecurringSchedules(org.date);
      assert.equal(run.failed, 0);
      assert.equal(run.posted, 1);
      const documentId = run.documents[0]!.documentId;
      const provenance = (await db.execute<{
        documentCreatedBy: string | null;
        submittedBy: string | null;
        lineCreatedBy: string | null;
        lineageCreatedBy: string | null;
        scheduleId: string;
        occurrenceOn: string;
        custom: Record<string, string>;
        auditActor: string | null;
        auditSource: string | null;
      }>(sql`
        select d.created_by::text as "documentCreatedBy",
               d.submitted_by::text as "submittedBy",
               line.created_by::text as "lineCreatedBy",
               occurrence.created_by::text as "lineageCreatedBy",
               occurrence.schedule_id::text as "scheduleId",
               occurrence.occurrence_on::text as "occurrenceOn",
               d.custom,
               audit.actor_id::text as "auditActor",
               audit.changes->>'source' as "auditSource"
          from documents d
          join document_lines line on line.document_id = d.id and line.org_id = d.org_id
          join recurring_occurrence_documents occurrence
            on occurrence.document_id = d.id and occurrence.org_id = d.org_id
          left join audit_log audit
            on audit.row_id = d.id and audit.org_id = d.org_id
           and audit.table_name = 'documents' and audit.action = 'post'
         where d.id = ${documentId} and d.org_id = ${org.orgId}
      `)).rows[0]!;
      assert.equal(provenance.documentCreatedBy, null, "the scheduler never impersonates the template author");
      assert.equal(provenance.submittedBy, null, "system submission retains a null actor");
      assert.equal(provenance.lineCreatedBy, null, "generated lines carry the same system actor");
      assert.equal(provenance.lineageCreatedBy, null, "immutable occurrence lineage carries the system actor");
      assert.equal(provenance.scheduleId, scheduleId);
      assert.equal(provenance.occurrenceOn, org.date);
      assert.equal(provenance.custom.actorKind, "system");
      assert.equal(provenance.custom.actorReason, "recurring schedule");
      assert.equal(provenance.custom.recurringRunSource, "scheduler");
      assert.equal(provenance.custom.recurringScheduleId, scheduleId);
      assert.equal(provenance.custom.recurringOccurrenceOn, org.date);
      assert.equal(provenance.auditActor, null);
      assert.equal(provenance.auditSource, "recurring_schedule");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "run now attributes document, lines, lineage, submission, and posting audit to its authenticated actor",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const historicalAuthor = await createScratchUser(org.orgId, "Historical author", "admin");
      const currentActor = await createScratchUser(org.orgId, "Current actor", "admin");
      const scheduleId = await seedInvoiceSchedule(org, historicalAuthor);

      const run = await runScheduleNow(scheduleId, currentActor, org.date);
      assert.equal(run.posted, true);
      const provenance = (await db.execute<{
        documentCreatedBy: string | null;
        submittedBy: string | null;
        lineCreatedBy: string | null;
        lineageCreatedBy: string | null;
        custom: Record<string, string>;
        auditActor: string | null;
        auditSource: string | null;
      }>(sql`
        select d.created_by::text as "documentCreatedBy",
               d.submitted_by::text as "submittedBy",
               line.created_by::text as "lineCreatedBy",
               occurrence.created_by::text as "lineageCreatedBy",
               d.custom,
               audit.actor_id::text as "auditActor",
               audit.changes->>'source' as "auditSource"
          from documents d
          join document_lines line on line.document_id = d.id and line.org_id = d.org_id
          join recurring_occurrence_documents occurrence
            on occurrence.document_id = d.id and occurrence.org_id = d.org_id
          left join audit_log audit
            on audit.row_id = d.id and audit.org_id = d.org_id
           and audit.table_name = 'documents' and audit.action = 'post'
         where d.id = ${run.documentId} and d.org_id = ${org.orgId}
      `)).rows[0]!;
      assert.equal(provenance.documentCreatedBy, currentActor);
      assert.equal(provenance.submittedBy, currentActor);
      assert.equal(provenance.lineCreatedBy, currentActor);
      assert.equal(provenance.lineageCreatedBy, currentActor);
      assert.equal(provenance.custom.recurringRunSource, "run_now");
      assert.equal(provenance.custom.recurringScheduleId, scheduleId);
      assert.equal(provenance.auditActor, currentActor);
      assert.equal(provenance.auditSource, "recurring_run_now");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "a null-author imported template auto-posts with system provenance",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const scheduleOwner = await createScratchUser(org.orgId, "Schedule owner", "admin");
      await seedInvoiceSchedule(org, scheduleOwner, { templateCreatedBy: null });

      const run = await runDueRecurringSchedules(org.date);
      assert.equal(run.failed, 0);
      assert.equal(run.posted, 1);
      const generated = (await db.execute<{
        status: string;
        createdBy: string | null;
        lineCreatedBy: string | null;
        actorKind: string | null;
      }>(sql`
        select d.status, d.created_by::text as "createdBy",
               line.created_by::text as "lineCreatedBy",
               d.custom->>'actorKind' as "actorKind"
          from documents d
          join document_lines line on line.document_id = d.id and line.org_id = d.org_id
         where d.id = ${run.documents[0]!.documentId} and d.org_id = ${org.orgId}
      `)).rows[0]!;
      assert.deepEqual(generated, {
        status: "posted",
        createdBy: null,
        lineCreatedBy: null,
        actorKind: "system",
      });
      assert.equal(await journalEntryCount(org.orgId), 1);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "scheduler approval targeting fails closed when a flow requires a human submitter",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const historicalAuthor = await createScratchUser(org.orgId, "Historical author", "admin");
      await seedInvoiceSchedule(org, historicalAuthor);
      await seedApprovalFlow(org.orgId, {
        subjectKind: "customer_invoice",
        assignees: [{ type: "submitter" }],
        mode: "any",
      });

      const run = await runDueRecurringSchedules(org.date);
      assert.equal(run.failed, 1);
      assert.equal(run.generated, 0);
      const state = (await db.execute<{ lastError: string | null; documents: number; lineage: number }>(sql`
        select schedule.last_error as "lastError",
               (select count(*)::int from documents d
                 where d.org_id = schedule.org_id and d.id <> schedule.template_document_id) as documents,
               (select count(*)::int from recurring_occurrence_documents occurrence
                 where occurrence.org_id = schedule.org_id) as lineage
          from recurring_schedules schedule
         where schedule.org_id = ${org.orgId}
      `)).rows[0]!;
      assert.match(state.lastError ?? "", /approval could not be routed/);
      assert.equal(state.documents, 0, "a system submission never bypasses an unresolved approval gate");
      assert.equal(state.lineage, 0, "the refused generation consumes no occurrence");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "a forced lineage failure rolls back the generated document, lines, and lineage together",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Scheduler", "admin");
      const scheduleId = await seedInvoiceSchedule(org, actorId);
      const templateId = (await db.execute<{ id: string }>(sql`
        select template_document_id::text as id from recurring_schedules where id = ${scheduleId}
      `)).rows[0]!.id;
      // Throw at the final lineage insert, after the cloned header and lines
      // and even auto-posting have run. The outer org transaction must unwind
      // the complete accounting unit, including the occurrence claim.
      const removeFailure = await failOccurrenceLineageInsert(scheduleId);
      const run = await (async () => {
        try {
          return await runDueRecurringSchedules(org.date);
        } finally {
          await removeFailure();
        }
      })();
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
      const persisted = (await db.execute<{ documents: number; lines: number; lineage: number }>(sql`
        select
          (select count(*)::int from documents where org_id = ${org.orgId} and id <> ${templateId}) as documents,
          (select count(*)::int from document_lines where org_id = ${org.orgId} and document_id <> ${templateId}) as lines,
          (select count(*)::int from recurring_occurrence_documents where org_id = ${org.orgId}) as lineage
      `)).rows[0]!;
      assert.deepEqual(persisted, { documents: 0, lines: 0, lineage: 0 },
        "the failed lineage write leaves no partial document, line, or lineage evidence");

      // The crash-window regression: whatever killed the first attempt (here a
      // mid-generation throw; equally a SIGKILL — no durable claim exists to
      // strand), the next tick must complete the SAME occurrence exactly once.
      await db.execute(sql`
        update recurring_schedules set last_error = null where id = ${scheduleId}
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
      await seedInvoiceSchedule(org, actorId);
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

test(
  "occurrence lineage rejects cross-tenant schedule and document references",
  { skip: !DB },
  async () => {
    const owner = await createScratchOrg();
    const foreign = await createScratchOrg();
    try {
      const ownerActor = await createScratchUser(owner.orgId, "Owner scheduler", "admin");
      const foreignActor = await createScratchUser(foreign.orgId, "Foreign scheduler", "admin");
      const ownerScheduleId = await seedInvoiceSchedule(owner, ownerActor);
      const foreignScheduleId = await seedInvoiceSchedule(foreign, foreignActor);
      const ownerTemplateId = (await db.execute<{ id: string }>(sql`
        select template_document_id::text as id
          from recurring_schedules
         where id = ${ownerScheduleId}
      `)).rows[0]!.id;
      const foreignTemplateId = (await db.execute<{ id: string }>(sql`
        select template_document_id::text as id
          from recurring_schedules
         where id = ${foreignScheduleId}
      `)).rows[0]!.id;

      await assert.rejects(
        db.execute(sql`
          insert into recurring_occurrence_documents
            (org_id, schedule_id, occurrence_on, document_id)
          values (${owner.orgId}, ${foreignScheduleId}, '2026-07-15', ${ownerTemplateId})
        `),
        (error: unknown) => /foreign key|recurring_occurrence_schedule_fk/i.test(
          [error, (error as { cause?: unknown })?.cause].map(String).join(": "),
        ),
        "a lineage row cannot name another tenant's schedule",
      );

      await assert.rejects(
        db.execute(sql`
          insert into recurring_occurrence_documents
            (org_id, schedule_id, occurrence_on, document_id)
          values (${owner.orgId}, ${ownerScheduleId}, '2026-08-15', ${foreignTemplateId})
        `),
        (error: unknown) => /foreign key|recurring_occurrence_document_fk/i.test(
          [error, (error as { cause?: unknown })?.cause].map(String).join(": "),
        ),
        "a lineage row cannot name another tenant's document",
      );

      const persisted = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n
          from recurring_occurrence_documents
         where org_id = ${owner.orgId}
      `)).rows[0]!;
      assert.equal(Number(persisted.n), 0, "rejected cross-tenant rows leave no lineage evidence");
    } finally {
      await dropScratchOrgReporting(owner.orgId);
      await dropScratchOrgReporting(foreign.orgId);
    }
  },
);
