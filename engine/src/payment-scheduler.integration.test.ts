import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withBypassContext, withOrgContext } from "./db.ts";
import { decidePaymentRun, runDuePaymentSchedules, submitPaymentRun } from "./payment-operations.ts";
import { createPaymentRun, PaymentError } from "./payments.ts";
import { postDocument } from "./posting.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "./test-fixtures.ts";

/**
 * Live-PostgreSQL durability and provenance proofs for the payment scheduler
 * (runDuePaymentSchedules). One occurrence = one due fire time of one schedule.
 *
 * The scheduler must never lose an occurrence, never strand an unlinked draft
 * run, never duplicate a run's instructions across retries or concurrent
 * ticks, and never impersonate the historical schedule author. These tests
 * force failures at each stage boundary (including simulated crashes between
 * committed stages) and assert the ledger in payment_schedule_occurrences
 * makes every state recoverable.
 */

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

interface ScheduleFixture {
  scheduleId: string;
  profileId: string;
  billId: string;
  operatorId: string;
  dueAt: Date;
}

async function seedScheduleFixture(
  org: ScratchOrg,
  options: {
    action?: "create_draft" | "submit_for_approval";
    createdBy?: string | null;
    requireRunApproval?: boolean;
    dueAt?: Date;
  } = {},
): Promise<ScheduleFixture> {
  return withBypass(async () => {
    const operatorId = await createScratchUser(org.orgId, "Payment operator", "payment_operator");
    const formatId = randomUUID();
    const profileId = randomUUID();
    const scheduleId = randomUUID();
    const billId = randomUUID();

    await db.execute(sql`
      insert into payment_formats
        (id, org_id, code, name, rail, direction, country, currency, created_by, updated_by)
      values
        (${formatId}, ${org.orgId}, ${`SCHED-${formatId.slice(0, 8)}`}, 'Scheduled EFT credit',
         'cpa005_credit', 'credit', 'CA', 'CAD', ${operatorId}, ${operatorId})`);
    await db.execute(sql`
      insert into payment_bank_profiles
        (id, org_id, name, bank_account_id, subsidiary_id, payment_format_id,
         currency, country, require_run_approval, created_by, updated_by)
      values
        (${profileId}, ${org.orgId}, 'Scheduled run profile', ${org.accounts.bank},
         ${org.subsidiaryId}, ${formatId}, 'CAD', 'CA',
         ${options.requireRunApproval ?? true}, ${operatorId}, ${operatorId})`);
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${billId}, ${org.orgId}, 'vendor_bill', 'draft', ${`BILL-SCHED-${billId.slice(0, 8)}`},
              ${org.subsidiaryId}, ${org.vendorId}, ${org.date}, 'CAD', '1',
              '125', '0', '125', ${operatorId})`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price,
         amount, tax_amount)
      values (${org.orgId}, ${billId}, 1, ${org.accounts.cogs}, '1', '125',
              '125', '0')`);
    // Source lines must be authored while their parent document is draft;
    // approve only after the complete fixture is present.
    await db.execute(sql`
      update documents set status = 'approved'
       where id = ${billId} and org_id = ${org.orgId}`);
    await postDocument(billId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    });

    const dueAt = options.dueAt ?? new Date(Date.now() - 60_000);
    await db.execute(sql`
      insert into payment_schedules
        (id, org_id, name, payment_bank_profile_id, cron, timezone,
         selection_criteria, action, next_run_at, is_active, created_by)
      values
        (${scheduleId}, ${org.orgId}, ${`Scheduled payments ${scheduleId.slice(0, 8)}`},
         ${profileId}, '*/5 * * * *', 'UTC',
         ${JSON.stringify({ dueThroughDays: 30 })}::jsonb,
         ${options.action ?? "submit_for_approval"}, ${dueAt}, true,
         ${options.createdBy === undefined ? operatorId : options.createdBy})`);

    return { scheduleId, profileId, billId, operatorId, dueAt };
  });
}

/**
 * Scoped forced-failure triggers — the same technique as the recurring-dedupe
 * suite: raise inside the database at one exact stage boundary so a crash
 * between committed stages is reproduced deterministically.
 */
async function failPaymentInstructionInserts(orgId: string): Promise<() => Promise<void>> {
  const suffix = orgId.replaceAll("-", "").slice(0, 12);
  const fn = `openbooks_test_fail_instr_${suffix}`;
  const trigger = `openbooks_test_fail_instr_${suffix}`;
  await db.execute(sql.raw(`
    create function public.${fn}() returns trigger
    language plpgsql as $$
    begin
      raise exception 'forced instruction failure';
    end
    $$
  `));
  await db.execute(sql.raw(`
    create trigger ${trigger}
    before insert on public.payment_instructions
    for each row when (new.org_id = '${orgId}'::uuid)
    execute function public.${fn}()
  `));
  return async () => {
    await db.execute(sql.raw(`drop trigger if exists ${trigger} on public.payment_instructions`));
    await db.execute(sql.raw(`drop function if exists public.${fn}()`));
  };
}

async function failDraftRunSubmissions(orgId: string): Promise<() => Promise<void>> {
  const suffix = orgId.replaceAll("-", "").slice(0, 12);
  const fn = `openbooks_test_fail_submit_${suffix}`;
  const trigger = `openbooks_test_fail_submit_${suffix}`;
  await db.execute(sql.raw(`
    create function public.${fn}() returns trigger
    language plpgsql as $$
    begin
      if old.status = 'draft' and new.status in ('pending_approval', 'approved') then
        raise exception 'forced submit failure';
      end if;
      return new;
    end
    $$
  `));
  await db.execute(sql.raw(`
    create trigger ${trigger}
    before update on public.payment_runs
    for each row when (new.org_id = '${orgId}'::uuid)
    execute function public.${fn}()
  `));
  return async () => {
    await db.execute(sql.raw(`drop trigger if exists ${trigger} on public.payment_runs`));
    await db.execute(sql.raw(`drop function if exists public.${fn}()`));
  };
}

async function failScheduleCursorAdvance(orgId: string): Promise<() => Promise<void>> {
  const suffix = orgId.replaceAll("-", "").slice(0, 12);
  const fn = `openbooks_test_fail_advance_${suffix}`;
  const trigger = `openbooks_test_fail_advance_${suffix}`;
  await db.execute(sql.raw(`
    create function public.${fn}() returns trigger
    language plpgsql as $$
    begin
      if new.next_run_at is distinct from old.next_run_at then
        raise exception 'forced cursor advance failure';
      end if;
      return new;
    end
    $$
  `));
  await db.execute(sql.raw(`
    create trigger ${trigger}
    before update on public.payment_schedules
    for each row when (new.org_id = '${orgId}'::uuid)
    execute function public.${fn}()
  `));
  return async () => {
    await db.execute(sql.raw(`drop trigger if exists ${trigger} on public.payment_schedules`));
    await db.execute(sql.raw(`drop function if exists public.${fn}()`));
  };
}

type OccurrenceRow = {
  id: string;
  status: string;
  payment_run_id: string | null;
  attempt_count: number;
};

async function occurrences(orgId: string, scheduleId: string): Promise<OccurrenceRow[]> {
  return withBypassContext(async () =>
    (await db.execute<OccurrenceRow>(sql`
      select id::text as id, status, payment_run_id::text as payment_run_id, attempt_count
        from payment_schedule_occurrences
       where org_id = ${orgId} and schedule_id = ${scheduleId}
       order by occurrence_at
    `)).rows);
}

async function scheduleRow(orgId: string, scheduleId: string) {
  const row = (await withBypassContext(() =>
    db.execute<{
      next_run_at: Date | string | null;
      last_run_at: Date | string | null;
      last_payment_run_id: string | null;
      last_result: Record<string, unknown> | null;
    }>(sql`
      select next_run_at, last_run_at, last_payment_run_id::text as last_payment_run_id, last_result
        from payment_schedules
       where id = ${scheduleId} and org_id = ${orgId}
    `))).rows[0];
  if (!row) return row;
  return {
    ...row,
    next_run_at: row.next_run_at === null ? null : new Date(row.next_run_at),
    last_run_at: row.last_run_at === null ? null : new Date(row.last_run_at),
  };
}

async function runRow(orgId: string, runId: string) {
  return withBypassContext(async () =>
    (await db.execute<{
      status: string;
      created_by: string | null;
      submitted_by: string | null;
      updated_by: string | null;
      source_schedule_id: string | null;
    }>(sql`
      select status, created_by::text as created_by, submitted_by::text as submitted_by,
             updated_by::text as updated_by, source_schedule_id::text as source_schedule_id
        from payment_runs
       where id = ${runId} and org_id = ${orgId}
    `)).rows[0]);
}

async function runEvents(orgId: string, runId: string) {
  return withBypassContext(async () =>
    (await db.execute<{
      event_type: string;
      actor_id: string | null;
      details: Record<string, unknown>;
    }>(sql`
      select event_type, actor_id::text as actor_id, details
        from payment_events
       where org_id = ${orgId} and payment_run_id = ${runId}
       order by created_at, id
    `)).rows);
}

async function instructionCount(orgId: string, runId: string): Promise<number> {
  return withBypassContext(async () =>
    Number((await db.execute<{ n: number }>(sql`
      select count(*)::int as n from payment_instructions
       where org_id = ${orgId} and payment_run_id = ${runId}
    `)).rows[0]!.n));
}

async function runsForSchedule(orgId: string, scheduleId: string): Promise<string[]> {
  return withBypassContext(async () =>
    (await db.execute<{ id: string }>(sql`
      select id::text as id from payment_runs
       where org_id = ${orgId} and source_schedule_id = ${scheduleId}
    `)).rows.map((r) => r.id));
}

test(
  "a scheduled submission is durable and carries system provenance, and a human checker can approve it",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      // NULL created_by: an imported schedule with no historical author. The
      // old scheduler fabricated the org UUID as a fake user actor here.
      const fixture = await seedScheduleFixture(org, { createdBy: null });
      const approverId = await withBypass(() =>
        createScratchUser(org.orgId, "Payment approver", "payment_approver"));

      const outcomes = await runDuePaymentSchedules();
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0]!.scheduleId, fixture.scheduleId);
      assert.equal(outcomes[0]!.selected, 1);
      assert.ok(outcomes[0]!.runId, "the scheduled tick reports its run");
      assert.equal(outcomes[0]!.error, undefined);
      const runId = outcomes[0]!.runId!;

      // The occurrence ledger: exactly one row, linked, submission complete.
      const occ = await occurrences(org.orgId, fixture.scheduleId);
      assert.equal(occ.length, 1);
      assert.equal(occ[0]!.status, "submitted");
      assert.equal(occ[0]!.payment_run_id, runId);

      // System provenance on the run itself — no user impersonated, no org
      // UUID in a user actor column.
      const run = await runRow(org.orgId, runId);
      assert.equal(run!.status, "pending_approval");
      assert.equal(run!.created_by, null);
      assert.equal(run!.submitted_by, null);
      assert.equal(run!.updated_by, null);
      assert.equal(run!.source_schedule_id, fixture.scheduleId);

      // Durable source markers on the lifecycle events, with null actors.
      const events = await runEvents(org.orgId, runId);
      const created = events.find((e) => e.event_type === "run_created");
      const submitted = events.find((e) => e.event_type === "run_submitted");
      assert.ok(created, "run_created event exists");
      assert.equal(created!.actor_id, null);
      assert.equal(created!.details.source, "payment_schedule");
      assert.equal(created!.details.scheduleId, fixture.scheduleId);
      assert.ok(created!.details.occurrenceAt, "run_created names the occurrence fire time");
      assert.ok(submitted, "run_submitted event exists");
      assert.equal(submitted!.actor_id, null);
      assert.equal(submitted!.details.source, "system");

      // The schedule's own bookkeeping: cursor advanced post-commit, run linked.
      const schedule = await scheduleRow(org.orgId, fixture.scheduleId);
      assert.ok(schedule!.next_run_at && schedule!.next_run_at > fixture.dueAt, "cursor advanced");
      assert.ok(schedule!.last_run_at, "last_run_at recorded");
      assert.equal(schedule!.last_payment_run_id, runId);
      assert.equal((schedule!.last_result as { runId?: string }).runId, runId);

      // Exactly one instruction set — no duplicates.
      assert.equal(await instructionCount(org.orgId, runId), 1);

      // Maker-checker: the system is the maker; any authenticated human is an
      // independent checker.
      await withOrgContext(org.orgId, () =>
        decidePaymentRun(runId, org.orgId, approverId, "approve"));
      const approved = await runRow(org.orgId, runId);
      assert.equal(approved!.status, "approved");
      assert.equal(approved!.submitted_by, null, "the maker stays the system");
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "a scheduled run never impersonates the historical schedule author — and that author remains an eligible checker",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const historicalAuthor = await withBypass(() =>
        createScratchUser(org.orgId, "Historical schedule author", "payment_author"));
      const fixture = await seedScheduleFixture(org, { createdBy: historicalAuthor });

      const outcomes = await runDuePaymentSchedules();
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0]!.scheduleId, fixture.scheduleId);
      assert.ok(outcomes[0]!.runId);
      const runId = outcomes[0]!.runId!;

      const run = await runRow(org.orgId, runId);
      assert.equal(run!.created_by, null, "the author is not recorded as the run creator");
      assert.equal(run!.submitted_by, null, "the author is not recorded as the submitter");
      assert.equal(run!.updated_by, null);
      for (const e of await runEvents(org.orgId, runId)) {
        assert.equal(e.actor_id, null, "no event is attributed to the author");
      }

      // The historical author was never the maker of this system submission,
      // so they are an independent human checker — not SOD-barred by their own
      // authorship of the schedule.
      await withOrgContext(org.orgId, () =>
        decidePaymentRun(runId, org.orgId, historicalAuthor, "approve"));
      const approved = await runRow(org.orgId, runId);
      assert.equal(approved!.status, "approved");
      assert.equal(approved!.submitted_by, null);
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "interactive create and submit retain the authenticated gate user, and the submitter still cannot self-approve",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const fixture = await seedScheduleFixture(org, { action: "create_draft" });
      const run = await withOrgContext(org.orgId, () =>
        createPaymentRun({
          orgId: org.orgId,
          createdBy: fixture.operatorId,
          paymentBankProfileId: fixture.profileId,
          billDocumentIds: [fixture.billId],
          scheduledFor: org.date,
        }));
      await withOrgContext(org.orgId, () =>
        submitPaymentRun(run.id, org.orgId, fixture.operatorId));

      const stored = await runRow(org.orgId, run.id);
      assert.equal(stored!.created_by, fixture.operatorId);
      assert.equal(stored!.submitted_by, fixture.operatorId);
      assert.equal(stored!.status, "pending_approval");

      const events = await runEvents(org.orgId, run.id);
      assert.equal(events.find((e) => e.event_type === "run_created")!.actor_id, fixture.operatorId);
      const submitted = events.find((e) => e.event_type === "run_submitted")!;
      assert.equal(submitted.actor_id, fixture.operatorId);
      assert.equal(submitted.details.source, "user");

      // Maker-checker is unchanged for interactive submissions.
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          decidePaymentRun(run.id, org.orgId, fixture.operatorId, "approve")),
        (error: unknown) =>
          error instanceof PaymentError
          && error.message === "the payment run submitter cannot approve the same run",
      );
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "a failure before the run commits loses nothing — the retry produces exactly one run",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    let dropFailureTrigger: () => Promise<void> = () => Promise.resolve();
    try {
      const fixture = await seedScheduleFixture(org);
      // Fail inside the creation transaction: the occurrence claim and every
      // run artifact roll back together — the old pre-create claim window
      // (cursor advanced, occurrence silently skipped) is gone.
      dropFailureTrigger = await withBypass(() => failPaymentInstructionInserts(org.orgId));

      const failed = await runDuePaymentSchedules();
      assert.equal(failed.length, 1);
      assert.ok(failed[0]!.error, "the failed tick reports an error");
      assert.equal((await occurrences(org.orgId, fixture.scheduleId)).length, 0,
        "no occurrence is claimed when creation rolls back");
      assert.deepEqual(await runsForSchedule(org.orgId, fixture.scheduleId), [],
        "no run exists");
      const afterFailure = await scheduleRow(org.orgId, fixture.scheduleId);
      assert.ok(afterFailure!.next_run_at && afterFailure!.next_run_at <= new Date(),
        "the cursor was NOT advanced — the occurrence is still due");
      assert.ok((afterFailure!.last_result as { error?: string }).error,
        "the failure is visible on the schedule");

      await dropFailureTrigger();
      dropFailureTrigger = () => Promise.resolve();

      const retried = await runDuePaymentSchedules();
      assert.equal(retried.length, 1);
      assert.equal(retried[0]!.selected, 1);
      assert.ok(retried[0]!.runId);
      const runId = retried[0]!.runId!;

      // Exactly once: one occurrence, one run, one instruction set.
      const occ = await occurrences(org.orgId, fixture.scheduleId);
      assert.equal(occ.length, 1);
      assert.equal(occ[0]!.payment_run_id, runId);
      assert.equal((await runsForSchedule(org.orgId, fixture.scheduleId)).length, 1);
      assert.equal(await instructionCount(org.orgId, runId), 1);
      const schedule = await scheduleRow(org.orgId, fixture.scheduleId);
      assert.equal(schedule!.last_payment_run_id, runId);
    } finally {
      await dropFailureTrigger();
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "a crash between the run commit and the cursor advance resumes that same occurrence — zero loss, no duplicate",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    let dropFailureTrigger: () => Promise<void> = () => Promise.resolve();
    try {
      const fixture = await seedScheduleFixture(org);
      // The run, its occurrence claim, and its instructions commit inside
      // createPaymentRun; then the process dies before the post-commit cursor
      // bookkeeping.
      dropFailureTrigger = await withBypass(() => failScheduleCursorAdvance(org.orgId));

      const crashed = await runDuePaymentSchedules();
      assert.equal(crashed.length, 1);
      assert.ok(crashed[0]!.error, "the interrupted tick surfaces the bookkeeping failure");

      // Durable state after the crash: run linked to its occurrence, cursor
      // NOT advanced (the schedule is still due), submission not yet run.
      const occ = await occurrences(org.orgId, fixture.scheduleId);
      assert.equal(occ.length, 1);
      assert.equal(occ[0]!.status, "awaiting_submit");
      const committedRunId = occ[0]!.payment_run_id!;
      assert.ok(committedRunId);
      assert.equal(await instructionCount(org.orgId, committedRunId), 1);
      const afterCrash = await scheduleRow(org.orgId, fixture.scheduleId);
      assert.ok(afterCrash!.next_run_at && afterCrash!.next_run_at <= new Date(),
        "the cursor was not advanced");

      await dropFailureTrigger();
      dropFailureTrigger = () => Promise.resolve();

      // The next tick finds the schedule still due; the bill is now reserved
      // by the committed run, so the tick must finish THAT occurrence instead
      // of skipping it or creating a second run.
      const resumed = await runDuePaymentSchedules();
      assert.equal(resumed.length, 1);
      assert.equal(resumed[0]!.runId, committedRunId,
        "the retry completes the same committed run");

      const occAfter = await occurrences(org.orgId, fixture.scheduleId);
      assert.equal(occAfter.length, 1, "still exactly one occurrence");
      assert.equal(occAfter[0]!.status, "submitted");
      assert.equal(occAfter[0]!.payment_run_id, committedRunId);
      assert.deepEqual(await runsForSchedule(org.orgId, fixture.scheduleId), [committedRunId]);
      assert.equal(await instructionCount(org.orgId, committedRunId), 1,
        "no duplicate instructions after resume");
      const schedule = await scheduleRow(org.orgId, fixture.scheduleId);
      assert.equal(schedule!.last_payment_run_id, committedRunId);
      assert.ok(schedule!.next_run_at && schedule!.next_run_at > fixture.dueAt,
        "the cursor advanced only after the occurrence was finished");
      const run = await runRow(org.orgId, committedRunId);
      assert.equal(run!.status, "pending_approval");
    } finally {
      await dropFailureTrigger();
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "a failed submission leaves a recoverable linked draft, resumes the same run, and goes terminal visibly after bounded retries",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    let dropFailureTrigger: () => Promise<void> = () => Promise.resolve();
    try {
      const fixture = await seedScheduleFixture(org);
      dropFailureTrigger = await withBypass(() => failDraftRunSubmissions(org.orgId));

      // Tick 1: the run commits and the cursor advances; submission fails.
      const first = await runDuePaymentSchedules();
      assert.equal(first.length, 1);
      assert.ok(first[0]!.runId);
      assert.ok(first[0]!.error, "the submission failure is reported");
      const runId = first[0]!.runId!;

      let occ = await occurrences(org.orgId, fixture.scheduleId);
      assert.equal(occ.length, 1);
      assert.equal(occ[0]!.status, "submit_failed");
      assert.equal(occ[0]!.payment_run_id, runId, "the draft stays linked — never an orphan");
      assert.equal(occ[0]!.attempt_count, 1);
      let run = await runRow(org.orgId, runId);
      assert.equal(run!.status, "draft");
      assert.equal(run!.submitted_by, null);

      // Tick 2 (schedule no longer due): recovery retries the submission and
      // fails again — same run, attempt counter advances.
      const second = await runDuePaymentSchedules();
      assert.equal(second.length, 0, "the schedule is no longer due");
      occ = await occurrences(org.orgId, fixture.scheduleId);
      assert.equal(occ[0]!.status, "submit_failed");
      assert.equal(occ[0]!.attempt_count, 2);
      assert.equal((await runsForSchedule(org.orgId, fixture.scheduleId)).length, 1);
      assert.equal(await instructionCount(org.orgId, runId), 1);

      // Tick 3: the retry budget is spent; the loss is terminal and loud.
      await runDuePaymentSchedules();
      occ = await occurrences(org.orgId, fixture.scheduleId);
      assert.equal(occ[0]!.status, "failed");
      assert.equal(occ[0]!.attempt_count, 3);
      assert.equal(occ[0]!.payment_run_id, runId, "the draft is still linked for takeover");
      const terminalSchedule = await scheduleRow(org.orgId, fixture.scheduleId);
      assert.match(
        String((terminalSchedule!.last_result as { error?: string }).error),
        /failed after 3 attempts/,
      );

      await dropFailureTrigger();
      dropFailureTrigger = () => Promise.resolve();

      // A terminal scheduler failure never retries silently — but the linked
      // draft is exactly where a human operator takes over as the maker.
      await withOrgContext(org.orgId, () => submitPaymentRun(runId, org.orgId, fixture.operatorId));
      run = await runRow(org.orgId, runId);
      assert.equal(run!.status, "pending_approval");
      assert.equal(run!.submitted_by, fixture.operatorId);
      assert.equal(await instructionCount(org.orgId, runId), 1);
    } finally {
      await dropFailureTrigger();
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "a crashed submission resumes on the next tick without the schedule being due again",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    let dropFailureTrigger: () => Promise<void> = () => Promise.resolve();
    try {
      const fixture = await seedScheduleFixture(org);
      // Reproduce the crash state exactly: run committed, cursor advanced,
      // occurrence left 'awaiting_submit', submission never attempted. The
      // submit-failure trigger makes submitPaymentRun itself fail inside the
      // FIRST tick, and the forced-advance state is what a hard kill between
      // the two committed stages leaves behind.
      dropFailureTrigger = await withBypass(() => failDraftRunSubmissions(org.orgId));

      const first = await runDuePaymentSchedules();
      assert.equal(first.length, 1);
      const runId = first[0]!.runId!;
      // Force the exact post-crash ledger state a hard kill would leave: the
      // occurrence believes submission is still pending.
      await withBypassContext(() => db.execute(sql`
        update payment_schedule_occurrences
           set status = 'awaiting_submit', attempt_count = 0
         where org_id = ${org.orgId} and schedule_id = ${fixture.scheduleId}
      `));

      await dropFailureTrigger();
      dropFailureTrigger = () => Promise.resolve();

      // The schedule is no longer due — only the occurrence recovery pass can
      // finish the submission, and it must resume the SAME run.
      const schedule = await scheduleRow(org.orgId, fixture.scheduleId);
      assert.ok(schedule!.next_run_at && schedule!.next_run_at > new Date(),
        "the schedule is no longer due");
      const resumed = await runDuePaymentSchedules();
      assert.equal(resumed.length, 0, "nothing new is due");

      const occ = await occurrences(org.orgId, fixture.scheduleId);
      assert.equal(occ.length, 1);
      assert.equal(occ[0]!.status, "submitted", "recovery finished the crashed submission");
      assert.equal(occ[0]!.payment_run_id, runId);
      const run = await runRow(org.orgId, runId);
      assert.equal(run!.status, "pending_approval");
      assert.equal(run!.submitted_by, null, "system submission retained its null actor");
      assert.equal(await instructionCount(org.orgId, runId), 1);
    } finally {
      await dropFailureTrigger();
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "concurrent ticks claim one occurrence and produce one run with one instruction set",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const fixture = await seedScheduleFixture(org);
      const now = new Date();

      const [a, b] = await Promise.all([
        runDuePaymentSchedules(now),
        runDuePaymentSchedules(now),
      ]);
      const runIds = new Set(
        [...a, ...b]
          .map((o) => o.runId)
          .filter((id): id is string => Boolean(id)),
      );
      assert.equal(runIds.size, 1, `both ticks observe the same run: ${[...runIds]}`);
      const runId = [...runIds][0]!;

      const occ = await occurrences(org.orgId, fixture.scheduleId);
      assert.equal(occ.length, 1, "exactly one occurrence was claimed");
      assert.equal(occ[0]!.payment_run_id, runId);
      assert.equal((await runsForSchedule(org.orgId, fixture.scheduleId)).length, 1);
      assert.equal(await instructionCount(org.orgId, runId), 1,
        "no duplicate instructions across concurrent ticks");
      const schedule = await scheduleRow(org.orgId, fixture.scheduleId);
      assert.equal(schedule!.last_payment_run_id, runId);
      assert.ok(schedule!.next_run_at && schedule!.next_run_at > fixture.dueAt);
      const run = await runRow(org.orgId, runId);
      assert.equal(run!.status, "pending_approval",
        "the single submission completed despite the race");
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "an empty selection records a completed occurrence and advances the cursor without creating a run",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const fixture = await seedScheduleFixture(org, { createdBy: null });
      // Remove every payable bill so the selection is empty.
      await withBypassContext(() => db.execute(sql`
        update documents
           set payment_hold_reason = 'held for test'
         where org_id = ${org.orgId} and id = ${fixture.billId}
      `));

      const outcomes = await runDuePaymentSchedules();
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0]!.selected, 0);
      assert.equal(outcomes[0]!.runId, undefined);

      const occ = await occurrences(org.orgId, fixture.scheduleId);
      assert.equal(occ.length, 1);
      assert.equal(occ[0]!.status, "completed");
      assert.equal(occ[0]!.payment_run_id, null);
      assert.deepEqual(await runsForSchedule(org.orgId, fixture.scheduleId), []);
      const schedule = await scheduleRow(org.orgId, fixture.scheduleId);
      assert.ok(schedule!.next_run_at && schedule!.next_run_at > fixture.dueAt,
        "the cursor advanced past the empty occurrence");
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
