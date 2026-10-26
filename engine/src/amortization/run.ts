/**
 * Amortization run: post every due plan line of active schedules through
 * the journal kernel — DR the line's destination account, CR the schedule's
 * deferral account, with the schedule's dimensions — exactly once per line.
 *
 * A line is due when its month ends on or before the run's cutoff (a
 * period's end date or an as-of date). It posts on its month-end date into
 * the period covering it, in the schedule's book. A line whose period is
 * closed, or whose book no longer posts, is skipped and reported with its
 * remedy; nothing else in the run is affected. Re-running is safe: posted
 * lines are no longer planned, and the journal idempotency key returns the
 * same entry if a retried unit reaches the kernel again.
 */
import { sql } from "drizzle-orm";
import { fromUnits, toUnits } from "../money/money.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { lockLedgerSetupFence } from "../organization/ledger-setup-fence.ts";
import { arePeriodModulesOpen, canonicalPeriodLabel } from "../periods/period-policy.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { businessToday } from "../platform/business-date.ts";
import { isIsoCalendarDate } from "../platform/civil-date.ts";
import {
  db,
  orgContext,
  withBypass,
  withOrg,
  withOrgTransaction,
  withTransactionSavepoint,
  type SqlExecutor,
} from "../platform/db.ts";
import { AMORTIZATION_FEATURE_KEY, AmortizationError } from "./errors.ts";
import {
  assertAmortizationFeature,
  recordScheduleEvent,
  requireAmortizationAuthority,
  writeAmortizationAudit,
} from "./internal.ts";
import {
  closePlannedLines,
  livePlanLines,
  loadSchedule,
  postScheduleEntry,
  scheduleBalance,
  updateSchedule,
} from "./schedule-store.ts";

export interface AmortizationRunProblem {
  scheduleId: string;
  scheduleNumber: string;
  periodStart: string;
  code: string;
  message: string;
  remedy: string;
}

export interface AmortizationRunResult {
  cutoff: string;
  posted: number;
  /** Ledger total posted, as a canonical decimal string per currency. */
  totals: Record<string, string>;
  entries: {
    scheduleId: string;
    scheduleNumber: string;
    periodStart: string;
    amount: string;
    currency: string;
    entryId: string;
  }[];
  completed: string[];
  problems: AmortizationRunProblem[];
}

type DueLine = {
  line_id: string;
  schedule_id: string;
  schedule_number: string;
  period_start: string;
  period_end: string;
  planned_amount: string;
  destination_account_id: string;
  book_id: string;
  subsidiary_id: string;
};

/** Planned lines of active schedules due by the cutoff, in a stable order. */
async function dueLines(
  runner: SqlExecutor,
  orgId: string,
  cutoff: string,
  scope: { subsidiaryIds: ReadonlySet<string> | null; scheduleIds?: readonly string[] },
): Promise<DueLine[]> {
  const subsidiaryFilter = scope.subsidiaryIds
    ? sql`and s.subsidiary_id = any(${`{${[...scope.subsidiaryIds].join(",")}}`}::uuid[])`
    : sql``;
  const scheduleFilter =
    scope.scheduleIds && scope.scheduleIds.length > 0
      ? sql`and s.id = any(${`{${scope.scheduleIds.join(",")}}`}::uuid[])`
      : sql``;
  return await runner.execute<DueLine>(
    sql`
    select l.id as line_id, s.id as schedule_id, s.schedule_number, l.period_start::text as period_start,
           l.period_end::text as period_end, l.planned_amount::text as planned_amount,
           l.destination_account_id, s.book_id, s.subsidiary_id
      from expense_amortization_schedule_lines l
      join expense_amortization_schedules s on s.org_id = l.org_id and s.id = l.schedule_id
     where l.org_id = ${orgId} and l.status = 'planned' and s.status = 'active'
       and l.period_end <= ${cutoff}
       ${subsidiaryFilter} ${scheduleFilter}
     order by s.schedule_number, l.period_start`,
    "objects",
  );
}

/** Resolve a run cutoff: a period's end, or an explicit as-of date. */
async function resolveCutoff(
  runner: SqlExecutor,
  orgId: string,
  input: { periodId?: string | null; asOf?: string | null },
): Promise<string> {
  if (input.periodId) {
    const period = (
      await runner.execute<{ ends_on: string }>(
        sql`
      select ends_on::text as ends_on from accounting_periods where org_id = ${orgId} and id = ${input.periodId}`,
        "objects",
      )
    )[0];
    if (!period) {
      throw new AmortizationError("The period does not exist in this organization.", {
        status: 404,
        code: "amortization_period_unknown",
        remedy: "Choose a period of this organization.",
      });
    }
    return period.ends_on;
  }
  if (input.asOf) {
    if (!isIsoCalendarDate(input.asOf)) {
      throw new AmortizationError("The as-of date must be a valid YYYY-MM-DD date.", {
        code: "amortization_date_invalid",
        remedy: "Enter the as-of date as YYYY-MM-DD.",
      });
    }
    return input.asOf;
  }
  throw new AmortizationError("Choose the period or the as-of date to amortize through.", {
    code: "amortization_cutoff_missing",
    remedy: "Pick a period (or an as-of date) and run again.",
  });
}

/**
 * Post one due line. Returns the entry, or a problem when the period is
 * closed or missing for the schedule's book. The schedule row is locked so
 * concurrent runs and schedule changes serialize; a line no longer planned
 * (posted by a concurrent run, or superseded) is skipped silently.
 */
async function postDueLine(
  runner: SqlExecutor,
  orgId: string,
  actorId: string | null,
  due: DueLine,
): Promise<
  | { entryId: string; amount: string; currency: string; completed: boolean }
  | AmortizationRunProblem
  | null
> {
  const schedule = await loadSchedule(runner, orgId, due.schedule_id, { lock: true });
  if (schedule.status !== "active") return null;
  const line = (
    await runner.execute<{ status: string }>(
      sql`
    select status from expense_amortization_schedule_lines
     where org_id = ${orgId} and id = ${due.line_id}
     for update`,
      "objects",
    )
  )[0];
  if (!line || line.status !== "planned") return null;
  const problem = (code: string, message: string, remedy: string): AmortizationRunProblem => ({
    scheduleId: schedule.id,
    scheduleNumber: schedule.scheduleNumber,
    periodStart: due.period_start,
    code,
    message,
    remedy,
  });
  const period = await resolveCoveringPeriod(runner, orgId, due.period_end, schedule.subsidiaryId);
  if (!period) {
    return problem(
      "amortization_period_missing",
      `No accounting period covers ${due.period_end}.`,
      `Generate the accounting period covering ${due.period_end}, then run amortization again.`,
    );
  }
  const book = (
    await runner.execute<{ is_active: boolean; posts_gl: boolean }>(
      sql`
    select is_active, posts_gl from accounting_books where org_id = ${orgId} and id = ${schedule.bookId}`,
      "objects",
    )
  )[0];
  if (!book?.is_active || !book.posts_gl) {
    return problem(
      "amortization_book_inactive",
      `The schedule's book no longer posts to the general ledger.`,
      "Reactivate the book in Company Settings → Accounting books, or cancel the schedule with a write-off in an active book.",
    );
  }
  if (
    !(await arePeriodModulesOpen(runner, {
      orgId,
      periodId: period.id,
      bookId: schedule.bookId,
      subsidiaryIds: [schedule.subsidiaryId],
      modules: ["gl"],
    }))
  ) {
    // The covering period is always a regular period (the resolver excludes adjustments).
    const periodLabel = canonicalPeriodLabel({
      fiscalYear: period.fiscal_year,
      periodNumber: period.period_number,
      adjustment: false,
    });
    return problem(
      "amortization_period_closed",
      `Period ${periodLabel} is closed for this schedule's entity and book.`,
      `Reopen ${periodLabel} through a reopen request, or move the unposted amount into an open period by changing the schedule's remaining term.`,
    );
  }
  const amount = (
    await runner.execute<{ planned_amount: string }>(
      sql`
    select planned_amount::text as planned_amount from expense_amortization_schedule_lines
     where org_id = ${orgId} and id = ${due.line_id}`,
      "objects",
    )
  )[0]!.planned_amount;
  const units = toUnits(amount);
  if (units === 0n) {
    // A rounded-to-zero line has no ledger entry and cannot enter posted history.
    await closePlannedLines(runner, orgId, [due.line_id], "superseded");
    return null;
  }
  const entryId = await postScheduleEntry(runner, {
    schedule,
    postingDate: due.period_end,
    entrySuffix: due.period_start.slice(0, 7),
    idempotencyKey: `expense-amortization:line:${due.line_id}`,
    memo: `Amortization ${schedule.scheduleNumber} ${due.period_start.slice(0, 7)}`,
    actorId,
    auditAction: "amortization.post",
    legs: [
      { accountId: due.destination_account_id, amount: units },
      { accountId: schedule.deferralAccountId, amount: -units },
    ],
  });
  const updated = await runner.execute<{ id: string }>(
    sql`
    update expense_amortization_schedule_lines
       set status = 'posted', journal_entry_id = ${entryId}, posted_at = now(), posted_by = ${actorId}
     where org_id = ${orgId} and id = ${due.line_id} and status = 'planned'
    returning id`,
    "objects",
  );
  if (updated.length !== 1) {
    throw new AmortizationError(
      `Plan line ${due.period_start.slice(0, 7)} of ${schedule.scheduleNumber} changed while it posted.`,
      {
        status: 409,
        code: "amortization_line_conflict",
        remedy: "Run amortization again.",
      },
    );
  }
  const lines = await livePlanLines(runner, orgId, schedule.id);
  const balance = scheduleBalance(schedule, lines);
  let completed = false;
  if (balance.planned === 0n && balance.remaining === 0n) {
    await updateSchedule(runner, schedule, actorId, { status: "completed", completed: true });
    await recordScheduleEvent(runner, {
      orgId,
      scheduleId: schedule.id,
      kind: "completed",
      reason: "The final planned period posted; the deferral is fully amortized.",
      effectiveOn: due.period_end,
      before: { status: "active" },
      after: { status: "completed", amortized: fromUnits(balance.amortized) },
      actorId,
    });
    completed = true;
  }
  return { entryId, amount: fromUnits(units), currency: schedule.currency, completed };
}

async function runOnRunner(
  runner: SqlExecutor,
  orgId: string,
  actorId: string | null,
  cutoff: string,
  scope: { subsidiaryIds: ReadonlySet<string> | null; scheduleIds?: readonly string[] },
): Promise<AmortizationRunResult> {
  // Acquire the setup fence before schedule locks so book activation can
  // capture schedules and ledger copies without an inverted lock order.
  await lockLedgerSetupFence(runner, orgId, "shared");
  const result: AmortizationRunResult = {
    cutoff,
    posted: 0,
    totals: {},
    entries: [],
    completed: [],
    problems: [],
  };
  const totals = new Map<string, bigint>();
  const blockedSchedules = new Set<string>();
  for (const due of await dueLines(runner, orgId, cutoff, scope)) {
    // A schedule whose earlier period is blocked keeps its later periods
    // unposted too: amortization posts in period order.
    if (blockedSchedules.has(due.schedule_id)) continue;
    let outcome: Awaited<ReturnType<typeof postDueLine>>;
    try {
      outcome = await withTransactionSavepoint(runner, () =>
        postDueLine(runner, orgId, actorId, due),
      );
    } catch (error) {
      if (!(error instanceof AmortizationError)) throw error;
      outcome = {
        scheduleId: due.schedule_id,
        scheduleNumber: due.schedule_number,
        periodStart: due.period_start,
        code: error.code,
        message: error.message,
        remedy: error.remedy,
      };
    }
    if (outcome === null) continue;
    if ("code" in outcome) {
      result.problems.push(outcome);
      blockedSchedules.add(due.schedule_id);
      continue;
    }
    result.posted += 1;
    totals.set(outcome.currency, (totals.get(outcome.currency) ?? 0n) + toUnits(outcome.amount));
    result.entries.push({
      scheduleId: due.schedule_id,
      scheduleNumber: due.schedule_number,
      periodStart: due.period_start,
      amount: outcome.amount,
      currency: outcome.currency,
      entryId: outcome.entryId,
    });
    if (outcome.completed) result.completed.push(due.schedule_id);
  }
  for (const [currency, total] of totals) result.totals[currency] = fromUnits(total);
  return result;
}

/**
 * Operator run through a period end or an as-of date, optionally for chosen
 * schedules. Requires amortization.manage; a subsidiary-restricted actor
 * amortizes only the schedules of the subsidiaries the role reaches.
 */
export async function runExpenseAmortization(input: {
  orgId: string;
  actorId: string;
  periodId?: string | null;
  asOf?: string | null;
  scheduleIds?: readonly string[];
}): Promise<AmortizationRunResult> {
  return withOrgTransaction(input.orgId, async () => {
    await assertAmortizationFeature(db, input.orgId);
    const allowed = await requireAmortizationAuthority(
      db,
      input.orgId,
      input.actorId,
      null,
      "amortization.manage",
    );
    const cutoff = await resolveCutoff(db, input.orgId, input);
    const result = await runOnRunner(db, input.orgId, input.actorId, cutoff, {
      subsidiaryIds: allowed,
      scheduleIds: input.scheduleIds,
    });
    await recordRunAudit(db, input.orgId, input.actorId, result, false);
    return result;
  });
}

async function recordRunAudit(
  runner: SqlExecutor,
  orgId: string,
  actorId: string | null,
  result: AmortizationRunResult,
  scheduled: boolean,
): Promise<void> {
  if (result.posted === 0 && result.problems.length === 0) return;
  await writeAmortizationAudit(runner, {
    orgId,
    table: "expense_amortization_schedules",
    rowId: orgId,
    action: "amortization.run",
    actorId,
    changes: {
      scheduled,
      cutoff: result.cutoff,
      posted: result.posted,
      totals: result.totals,
      problems: result.problems.map((problem) => ({
        schedule: problem.scheduleNumber,
        period: problem.periodStart,
        code: problem.code,
      })),
    },
  });
}

export interface AmortizationScanResult {
  orgs: number;
  posted: number;
  orgErrors: { orgId: string; error: string }[];
  problems: { orgId: string; problems: AmortizationRunProblem[] }[];
}

/**
 * Scheduler scan: for every organization with Expense amortization and its
 * automatic posting switched on, post the lines due through the business
 * day. One organization's failure is recorded against it and never stops
 * the others. An ambient tenant context confines the scan to that tenant.
 */
export async function runDueExpenseAmortization(asOf?: string): Promise<AmortizationScanResult> {
  const result: AmortizationScanResult = { orgs: 0, posted: 0, orgErrors: [], problems: [] };
  const scopedOrgId = orgContext.getStore()?.orgId;
  const orgScope = scopedOrgId ? sql`and s.org_id = ${scopedOrgId}` : sql``;
  // bypass: scheduler-tick — the unscoped scan finds organizations with due
  // amortization across every tenant; each one then runs in its own scope.
  const candidates = await withBypass(
    async () =>
      await db.execute<{ org_id: string }>(
        sql`
      select distinct s.org_id
        from expense_amortization_schedules s
        join expense_amortization_schedule_lines l on l.org_id = s.org_id and l.schedule_id = s.id
       where s.status = 'active' and l.status = 'planned' and l.period_end <= current_date ${orgScope}
       order by s.org_id`,
        "objects",
      ),
  );
  for (const { org_id: orgId } of candidates) {
    try {
      const enabled = await withOrg(
        orgId,
        async () =>
          (await orgFeatureEnabled(orgId, AMORTIZATION_FEATURE_KEY)) &&
          (await orgFeatureEnabled(orgId, "expenseAmortizationAutoRun")),
      );
      if (!enabled) continue;
      result.orgs += 1;
      const cutoff = asOf ?? (await withOrg(orgId, () => businessToday(orgId)));
      const run = await withOrgTransaction(orgId, async () => {
        await assertAmortizationFeature(db, orgId);
        const outcome = await runOnRunner(db, orgId, null, cutoff, { subsidiaryIds: null });
        await recordRunAudit(db, orgId, null, outcome, true);
        return outcome;
      });
      result.posted += run.posted;
      if (run.problems.length > 0) result.problems.push({ orgId, problems: run.problems });
    } catch (error) {
      result.orgErrors.push({
        orgId,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
      });
    }
  }
  return result;
}
