import { sql } from "drizzle-orm";
import { toUnits } from "../money/money.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";
import { businessToday } from "../platform/business-date.ts";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import { computeNextRunAt } from "../scripting/scripting.ts";
import { submitPaymentRun } from "./operations-runs.ts";
import { createPaymentRun } from "./run-creation.ts";

/**
 * Lifecycle of one claimed payment-schedule occurrence (one due fire time of
 * one schedule), recorded durably in payment_schedule_occurrences.
 *
 *   CLAIM    — createPaymentRun inserts (or adopts) the occurrence row and
 *              links the run inside the run's own creation transaction, so the
 *              claim, the run, its payments, and its instructions commit or
 *              roll back together. The old claim-then-create window that could
 *              permanently skip a due occurrence is gone.
 *   CURSOR   — payment_schedules.next_run_at advances only AFTER that commit,
 *              in the same update that links last_payment_run_id and records
 *              last_result. A crash before the advance leaves the occurrence
 *              ledger as the recovery path, never a lost occurrence.
 *   SUBMIT   — "submit_for_approval" schedules submit the linked run with
 *              system provenance (a null actor, never the historical schedule
 *              author). A failed or crashed submission leaves the occurrence
 *              'submit_failed' next to its linked draft — recoverable by the
 *              next tick resuming THAT run, never an orphan and never a
 *              duplicate set of instructions.
 */
type PaymentScheduleOccurrenceStatus =
  "draft_created" | "awaiting_submit" | "submit_failed" | "submitted" | "completed" | "failed";

/** Initial submission plus recovery retries before a failing submission is terminal. */
const MAX_OCCURRENCE_SUBMIT_ATTEMPTS = 3;

type DuePaymentSchedule = {
  id: string;
  org_id: string;
  payment_bank_profile_id: string;
  cron: string;
  timezone: string;
  selection_criteria: Record<string, unknown>;
  action: string;
  currency: string;
  subsidiary_id: string | null;
  next_run_at: Date;
};

/** Raw `db.execute` timestamps arrive as Date or driver text depending on path. */
function asOccurrenceDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

type PaymentScheduleOccurrence = {
  status: PaymentScheduleOccurrenceStatus;
  payment_run_id: string | null;
  attempt_count: number;
  result: Record<string, unknown> | null;
};

export async function runDuePaymentSchedules(
  now = new Date(),
): Promise<Array<{ scheduleId: string; runId?: string; selected: number; error?: string }>> {
  // Submission recovery first: occurrences whose run committed but whose
  // submission failed or crashed are resumed by ledger state — the SAME linked
  // run, never a new one.
  await recoverPaymentScheduleOccurrences();
  // Finding which tenants have a payment schedule due spans organizations, so
  // the scan and its claim cross an explicit trusted boundary; selecting bills
  // and creating the run happen inside that tenant's own scope. A scheduler tick
  // holds no request store — without these, RLS denies by default and no
  // scheduled payment run is ever created.
  // bypass: scheduler-tick — due payment schedules are found across every production organization.
  const schedules = await withBypassContext(() =>
    db.execute<DuePaymentSchedule>(
      sql`
    select s.id, s.org_id, s.payment_bank_profile_id, s.cron, s.timezone, s.selection_criteria,
           s.action, p.currency, p.subsidiary_id, s.next_run_at as "next_run_at"
      from payment_schedules s
      join payment_bank_profiles p on p.id = s.payment_bank_profile_id and p.org_id = s.org_id and p.is_active
      join orgs o on o.id = s.org_id and o.env_kind = 'production'
     where s.is_active and s.next_run_at <= ${now}
     order by s.next_run_at
  `,
      "objects",
    ),
  );
  // Raw `db.execute` timestamps arrive as Date or driver text depending on path.
  const due = schedules.map((row) => ({ ...row, next_run_at: asOccurrenceDate(row.next_run_at) }));
  const outcomes: Array<{ scheduleId: string; runId?: string; selected: number; error?: string }> =
    [];
  for (const schedule of due) {
    try {
      outcomes.push(await processDuePaymentSchedule(schedule, now));
    } catch (error) {
      const result = {
        scheduleId: schedule.id,
        selected: 0,
        error: error instanceof Error ? error.message : String(error),
      };
      outcomes.push(result);
      // Creation failed before any durable occurrence claim: record the
      // failure for operators but leave the cursor untouched, so the next
      // tick retries the occurrence instead of silently dropping it.
      await withOrgContext(schedule.org_id, () =>
        db.execute(
          sql`update payment_schedules set last_result = ${JSON.stringify(result)}::jsonb where id = ${schedule.id} and org_id = ${schedule.org_id}`,
        ),
      );
    }
  }
  return outcomes;
}

async function processDuePaymentSchedule(
  schedule: DuePaymentSchedule,
  now: Date,
): Promise<{ scheduleId: string; runId?: string; selected: number; error?: string }> {
  const occurrenceAt = schedule.next_run_at;
  const next = computeNextRunAt(schedule.cron, now, schedule.timezone);
  const criteria = schedule.selection_criteria ?? {};
  return withOrgContext(schedule.org_id, async () => {
    // The org's calendar day bounds due bills and stamps the created run.
    const businessDate = await businessToday(schedule.org_id);
    const selected = await selectScheduledBills(schedule, criteria, businessDate);
    if (selected.length === 0) {
      // A prior tick may have committed this occurrence's run before the
      // cursor advanced (a crash between commit and bookkeeping). Its bills
      // are now reserved, so the fresh selection is empty — finish that
      // occurrence instead of recording an empty one over it.
      const existing = await loadPaymentScheduleOccurrence(
        schedule.org_id,
        schedule.id,
        occurrenceAt,
      );
      if (existing?.payment_run_id) {
        return finishLinkedOccurrence(schedule, occurrenceAt, next, existing, now);
      }
      const result = { scheduleId: schedule.id, selected: 0 };
      const inserted = await db.execute<{ id: string }>(
        sql`
        insert into payment_schedule_occurrences (org_id, schedule_id, occurrence_at, status, result)
        values (${schedule.org_id}, ${schedule.id}, ${occurrenceAt}, 'completed', ${JSON.stringify(result)}::jsonb)
        -- A concurrent occurrence is re-read below so an empty selection cannot hide its linked run.
        on conflict (org_id, schedule_id, occurrence_at) do nothing
        returning id`,
        "objects",
      );
      if (inserted.length === 0) {
        const raced = await loadPaymentScheduleOccurrence(
          schedule.org_id,
          schedule.id,
          occurrenceAt,
        );
        if (!raced)
          throw new PaymentError("Payment schedule occurrence disappeared; retry the schedule.");
        if (raced.payment_run_id)
          return finishLinkedOccurrence(schedule, occurrenceAt, next, raced, now);
        if (raced.status !== "completed") {
          throw new PaymentError(
            `Payment schedule occurrence is ${raced.status}; review its outcome before retrying the schedule.`,
          );
        }
      }
      await advancePaymentScheduleCursor(schedule, next, now, null, result);
      return result;
    }
    // The occurrence claim, the run, its payments, and its instructions commit
    // atomically inside createPaymentRun; a concurrent tick adopts the
    // winner's run through the same occurrence key instead of duplicating it.
    // System provenance throughout: the historical schedule author is never
    // the recorded actor of an automated selection.
    const run = await createPaymentRun({
      allowedSubsidiaryIds: null,
      orgId: schedule.org_id,
      createdBy: null,
      paymentBankProfileId: schedule.payment_bank_profile_id,
      billDocumentIds: selected,
      scheduledFor: businessDate,
      sourceScheduleId: schedule.id,
      selectionCriteria: criteria,
      maximumRunAmount:
        criteria.maximumRunAmount == null || criteria.maximumRunAmount === ""
          ? null
          : String(criteria.maximumRunAmount),
      sourceOccurrence: {
        scheduleId: schedule.id,
        occurrenceAt,
        status: schedule.action === "submit_for_approval" ? "awaiting_submit" : "draft_created",
      },
    });
    const result: { scheduleId: string; runId?: string; selected: number; error?: string } = {
      scheduleId: schedule.id,
      runId: run.id,
      selected: selected.length,
    };
    // The cursor advances only now — after the run, its payments, and its
    // instructions are durably committed and linked to the occurrence.
    await advancePaymentScheduleCursor(schedule, next, now, run.id, result);
    if (schedule.action === "submit_for_approval") {
      const submitted = await submitOccurrenceRun(
        schedule.org_id,
        schedule.id,
        occurrenceAt,
        run.id,
      );
      if (submitted.error) result.error = submitted.error;
    }
    return result;
  });
}

/** Due posted vendor bills matching the schedule's criteria, capped by maximumRunAmount. */
async function selectScheduledBills(
  schedule: DuePaymentSchedule,
  criteria: Record<string, unknown>,
  businessDate: string,
): Promise<string[]> {
  const dueDays = Math.max(0, Math.min(3650, Number(criteria.dueThroughDays ?? 0)));
  const minimum = String(criteria.minimumAmount ?? "0");
  const maximum =
    criteria.maximumRunAmount == null || criteria.maximumRunAmount === ""
      ? null
      : String(criteria.maximumRunAmount);
  const candidates = await db.execute<{ id: string; open_balance: string }>(
    sql`
    select d.id, d.open_balance
      from documents d
     where d.org_id = ${schedule.org_id} and d.kind = 'vendor_bill' and d.status = 'posted'
       and d.payment_hold_reason is null and d.open_balance > 0
       and d.open_balance >= ${minimum}
       and d.currency = ${schedule.currency}
       and (${schedule.subsidiary_id}::uuid is null or d.subsidiary_id = ${schedule.subsidiary_id})
       and coalesce(d.due_date, d.document_date) <= (${businessDate}::date + ${dueDays}::integer)
     order by coalesce(d.due_date, d.document_date), d.document_number
  `,
    "objects",
  );
  const selected: string[] = [];
  let accumulated = 0n;
  const cap = maximum ? toUnits(maximum) : null;
  for (const bill of candidates) {
    const amount = toUnits(bill.open_balance);
    if (cap !== null && accumulated + amount > cap) continue;
    selected.push(bill.id);
    accumulated += amount;
  }
  return selected;
}

async function loadPaymentScheduleOccurrence(
  orgId: string,
  scheduleId: string,
  occurrenceAt: Date,
): Promise<PaymentScheduleOccurrence | null> {
  return (
    (
      await db.execute<PaymentScheduleOccurrence>(
        sql`
    select status, payment_run_id::text as payment_run_id, attempt_count, result
      from payment_schedule_occurrences
     where org_id = ${orgId} and schedule_id = ${scheduleId} and occurrence_at = ${occurrenceAt}
  `,
        "objects",
      )
    )[0] ?? null
  );
}

/**
 * Post-commit bookkeeping for an occurrence that already has a run: advance
 * the cursor (idempotently — a concurrent tick may have advanced it), link
 * last_payment_run_id, and finish any pending submission.
 */
async function finishLinkedOccurrence(
  schedule: DuePaymentSchedule,
  occurrenceAt: Date,
  next: Date | null,
  existing: PaymentScheduleOccurrence,
  now: Date,
): Promise<{ scheduleId: string; runId?: string; selected: number; error?: string }> {
  const runId = existing.payment_run_id!;
  const priorSelected =
    typeof existing.result?.selected === "number" ? existing.result.selected : 0;
  const result = { scheduleId: schedule.id, runId, selected: priorSelected };
  await advancePaymentScheduleCursor(schedule, next, now, runId, result);
  if (
    schedule.action === "submit_for_approval" &&
    (existing.status === "awaiting_submit" || existing.status === "submit_failed")
  ) {
    await submitOccurrenceRun(schedule.org_id, schedule.id, occurrenceAt, runId);
  }
  return result;
}

/**
 * Advance the cron cursor only after the occurrence's side effects are
 * durable. The `next_run_at <= now` guard makes the advance idempotent under
 * concurrent ticks: once one tick advances, the row is no longer due and
 * later updates no-op.
 */
async function advancePaymentScheduleCursor(
  schedule: DuePaymentSchedule,
  next: Date | null,
  now: Date,
  runId: string | null,
  result: Record<string, unknown>,
): Promise<void> {
  await db.execute(sql`
    update payment_schedules set
      next_run_at = ${next},
      last_run_at = ${now},
      last_payment_run_id = coalesce(${runId}::uuid, last_payment_run_id),
      last_result = ${JSON.stringify(result)}::jsonb
     where id = ${schedule.id} and org_id = ${schedule.org_id}
       and next_run_at <= ${now}
  `);
}

/**
 * Submit (or finish submitting) the run linked to one occurrence, with system
 * provenance. Idempotent and race-safe: only a run in a state that proves
 * submission progressed satisfies the occurrence. Rejected, cancelled,
 * rolled-back, or otherwise terminal non-success states fail visibly.
 */
async function submitOccurrenceRun(
  orgId: string,
  scheduleId: string,
  occurrenceAt: Date,
  runId: string,
): Promise<{ error?: string }> {
  const occurrence = await loadPaymentScheduleOccurrence(orgId, scheduleId, occurrenceAt);
  if (!occurrence || occurrence.payment_run_id !== runId) return {};
  if (occurrence.status !== "awaiting_submit" && occurrence.status !== "submit_failed") return {};
  const run = (
    await db.execute<{ status: string }>(
      sql`
    select status from payment_runs where id = ${runId} and org_id = ${orgId}
  `,
      "objects",
    )
  )[0];
  if (!run) return {};
  if (isPaymentRunSubmissionSuccess(run.status)) {
    await markOccurrenceSubmitted(orgId, scheduleId, occurrenceAt, runId);
    return {};
  }
  if (run.status !== "draft") {
    return recordOccurrenceRunFailure(
      orgId,
      scheduleId,
      occurrenceAt,
      runId,
      run.status,
      `linked payment run is ${run.status}; scheduled submission cannot continue`,
    );
  }
  try {
    await submitPaymentRun(runId, orgId, null);
    await markOccurrenceSubmitted(orgId, scheduleId, occurrenceAt, runId);
    return {};
  } catch (error) {
    // A concurrent submitter may have moved the run into a success-equivalent
    // state while ours failed. Terminal non-success states remain failures.
    const after = (
      await db.execute<{ status: string }>(
        sql`
      select status from payment_runs where id = ${runId} and org_id = ${orgId}
    `,
        "objects",
      )
    )[0]?.status;
    if (after && isPaymentRunSubmissionSuccess(after)) {
      await markOccurrenceSubmitted(orgId, scheduleId, occurrenceAt, runId);
      return {};
    }
    if (after && after !== "draft") {
      return recordOccurrenceRunFailure(
        orgId,
        scheduleId,
        occurrenceAt,
        runId,
        after,
        `linked payment run is ${after}; scheduled submission cannot continue`,
      );
    }
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    const attempts = occurrence.attempt_count + 1;
    const terminal = attempts >= MAX_OCCURRENCE_SUBMIT_ATTEMPTS;
    // The run stays linked and recoverable — never an orphan. Terminal
    // failure is stamped visibly instead of retried forever.
    await db.execute(sql`
      update payment_schedule_occurrences set
        status = ${terminal ? "failed" : "submit_failed"},
        attempt_count = ${attempts},
        result = ${JSON.stringify({ scheduleId, runId, error: message })}::jsonb,
        updated_at = now()
       where org_id = ${orgId} and schedule_id = ${scheduleId} and occurrence_at = ${occurrenceAt}
         and payment_run_id = ${runId}
         and status in ('awaiting_submit', 'submit_failed')
    `);
    if (terminal) {
      await db.execute(sql`
        update payment_schedules
           set last_result = ${JSON.stringify({ scheduleId, runId, error: `scheduled submission failed after ${attempts} attempts: ${message}` })}::jsonb
         where id = ${scheduleId} and org_id = ${orgId}
      `);
    }
    return { error: `scheduled submission failed (attempt ${attempts}): ${message}` };
  }
}

function isPaymentRunSubmissionSuccess(status: string): boolean {
  return [
    "pending_approval",
    "approved",
    "processing",
    "generated",
    "delivered",
    "partially_failed",
    "confirmed",
    "settled",
    "returned",
  ].includes(status);
}

async function recordOccurrenceRunFailure(
  orgId: string,
  scheduleId: string,
  occurrenceAt: Date,
  runId: string,
  runStatus: string,
  message: string,
): Promise<{ error: string }> {
  const error = message.slice(0, 500);
  const result = { scheduleId, runId, runStatus, error };
  await db.execute(sql`
    update payment_schedule_occurrences set
      status = 'failed',
      result = ${JSON.stringify(result)}::jsonb,
      updated_at = now()
     where org_id = ${orgId} and schedule_id = ${scheduleId} and occurrence_at = ${occurrenceAt}
       and payment_run_id = ${runId}
       and status in ('awaiting_submit', 'submit_failed')
  `);
  await db.execute(sql`
    update payment_schedules
       set last_result = ${JSON.stringify(result)}::jsonb
     where id = ${scheduleId} and org_id = ${orgId}
  `);
  return { error };
}

async function markOccurrenceSubmitted(
  orgId: string,
  scheduleId: string,
  occurrenceAt: Date,
  runId: string,
): Promise<void> {
  await db.execute(sql`
    update payment_schedule_occurrences set status = 'submitted', updated_at = now()
     where org_id = ${orgId} and schedule_id = ${scheduleId} and occurrence_at = ${occurrenceAt}
       and payment_run_id = ${runId}
       and status in ('awaiting_submit', 'submit_failed')
  `);
}

/**
 * Resume submissions whose occurrence run committed but whose submission
 * failed or crashed: the ledger row names the exact run to finish, so recovery
 * resumes it instead of creating a duplicate. Bounded by
 * MAX_OCCURRENCE_SUBMIT_ATTEMPTS; a terminal failure is durable on the row.
 */
async function recoverPaymentScheduleOccurrences(): Promise<void> {
  // bypass: scheduler-tick — unfinished schedule occurrences are found across every production organization.
  const pending = await withBypassContext(() =>
    db.execute<{ orgId: string; scheduleId: string; runId: string; occurrenceAt: Date | string }>(
      sql`
      select o.org_id as "orgId", o.schedule_id as "scheduleId",
             o.payment_run_id::text as "runId", o.occurrence_at as "occurrenceAt"
        from payment_schedule_occurrences o
        join payment_schedules s on s.id = o.schedule_id and s.org_id = o.org_id and s.is_active
        join orgs org on org.id = o.org_id and org.env_kind = 'production'
       where o.payment_run_id is not null
         and (
           (o.status = 'awaiting_submit')
           or (o.status = 'submit_failed' and o.attempt_count < ${MAX_OCCURRENCE_SUBMIT_ATTEMPTS})
         )
       order by o.occurrence_at
       limit 100
  `,
      "objects",
    ),
  );
  for (const row of pending) {
    try {
      await withOrgContext(row.orgId, () =>
        submitOccurrenceRun(
          row.orgId,
          row.scheduleId,
          asOccurrenceDate(row.occurrenceAt),
          row.runId,
        ),
      );
    } catch (error) {
      console.error(
        `[payment-scheduler] occurrence submission recovery failed for schedule ${row.scheduleId}:`,
        error,
      );
    }
  }
}
