/** Schedule rows, plan lines, balances, compare-and-set updates and amortization journal entries. */
import { sql } from "drizzle-orm";
import { postEntry } from "../journal/post-entry.ts";
import { PostingError } from "../journal/posting-contracts.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { nextFreeEntryNumber } from "../records/entry-number.ts";
import { AmortizationError } from "./errors.ts";
import type { AmortizationMethod, AmortizationTermSource } from "./plan.ts";

export const AMORTIZATION_JOURNAL_ORIGIN = "expense_amortization";

export type ScheduleStatus = "draft" | "active" | "on_hold" | "completed" | "cancelled";
export type ScheduleSourceKind = "vendor_bill" | "journal" | "expense_report" | "manual";

export interface ScheduleDimensions {
  departmentId: string | null;
  projectId: string | null;
  locationId: string | null;
  classId: string | null;
  extraDims: Record<string, string | null>;
}

export interface StoredSchedule {
  id: string;
  orgId: string;
  scheduleNumber: string;
  status: ScheduleStatus;
  sourceKind: ScheduleSourceKind;
  sourceDocumentId: string | null;
  sourceLineId: string | null;
  templateId: string;
  method: AmortizationMethod;
  termSource: AmortizationTermSource;
  periodOffset: number;
  subsidiaryId: string;
  bookId: string;
  currency: string;
  totalAmount: bigint;
  openingAmortized: bigint;
  reversed: bigint;
  serviceStartOn: string;
  serviceEndOn: string;
  firstPeriodOn: string;
  deferralAccountId: string;
  destinationAccountId: string;
  dimensions: ScheduleDimensions;
  memo: string | null;
  holdReason: string | null;
  revision: number;
}

export interface PlanLine {
  id: string;
  planRevision: number;
  periodStart: string;
  periodEnd: string;
  weight: bigint;
  plannedAmount: bigint;
  destinationAccountId: string;
  status: "planned" | "posted";
  journalEntryId: string | null;
}

type ScheduleRow = {
  id: string;
  org_id: string;
  schedule_number: string;
  status: ScheduleStatus;
  source_kind: ScheduleSourceKind;
  source_document_id: string | null;
  source_line_id: string | null;
  template_id: string;
  method: AmortizationMethod;
  term_source: AmortizationTermSource;
  period_offset: number;
  subsidiary_id: string;
  book_id: string;
  currency: string;
  total_amount: string;
  opening_amortized_amount: string;
  reversed_amount: string;
  service_start_on: string;
  service_end_on: string;
  first_period_on: string;
  deferral_account_id: string;
  destination_account_id: string;
  department_id: string | null;
  project_id: string | null;
  location_id: string | null;
  class_id: string | null;
  extra_dims: Record<string, string | null> | null;
  memo: string | null;
  hold_reason: string | null;
  revision: number;
};

function fromRow(row: ScheduleRow): StoredSchedule {
  return {
    id: row.id,
    orgId: row.org_id,
    scheduleNumber: row.schedule_number,
    status: row.status,
    sourceKind: row.source_kind,
    sourceDocumentId: row.source_document_id,
    sourceLineId: row.source_line_id,
    templateId: row.template_id,
    method: row.method,
    termSource: row.term_source,
    periodOffset: row.period_offset,
    subsidiaryId: row.subsidiary_id,
    bookId: row.book_id,
    currency: row.currency,
    totalAmount: toUnits(row.total_amount),
    openingAmortized: toUnits(row.opening_amortized_amount),
    reversed: toUnits(row.reversed_amount),
    serviceStartOn: row.service_start_on,
    serviceEndOn: row.service_end_on,
    firstPeriodOn: row.first_period_on,
    deferralAccountId: row.deferral_account_id,
    destinationAccountId: row.destination_account_id,
    dimensions: {
      departmentId: row.department_id,
      projectId: row.project_id,
      locationId: row.location_id,
      classId: row.class_id,
      extraDims: row.extra_dims ?? {},
    },
    memo: row.memo,
    holdReason: row.hold_reason,
    revision: row.revision,
  };
}

const SCHEDULE_COLUMNS = sql`id, org_id, schedule_number, status, source_kind, source_document_id, source_line_id,
  template_id, method, term_source, period_offset, subsidiary_id, book_id, currency,
  total_amount::text as total_amount, opening_amortized_amount::text as opening_amortized_amount,
  reversed_amount::text as reversed_amount, service_start_on::text as service_start_on,
  service_end_on::text as service_end_on, first_period_on::text as first_period_on,
  deferral_account_id, destination_account_id, department_id, project_id, location_id, class_id,
  extra_dims, memo, hold_reason, revision`;

/** Load one schedule of the organization, row-locked when `lock` is set. */
export async function loadSchedule(
  runner: SqlExecutor,
  orgId: string,
  scheduleId: string,
  options: { lock?: boolean } = {},
): Promise<StoredSchedule> {
  const row = (
    await runner.execute<ScheduleRow>(
      sql`
    select ${SCHEDULE_COLUMNS} from expense_amortization_schedules
     where org_id = ${orgId} and id = ${scheduleId}
     ${options.lock ? sql`for update` : sql``}`,
      "objects",
    )
  )[0];
  if (!row) {
    throw new AmortizationError("The amortization schedule does not exist in this organization.", {
      status: 404,
      code: "amortization_schedule_unknown",
      remedy: "Open the schedule from Accounting → Amortization.",
    });
  }
  return fromRow(row);
}

/** Schedules sourced by a document, row-locked in a stable order. */
export async function lockSchedulesForDocument(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<StoredSchedule[]> {
  const rows = await runner.execute<ScheduleRow>(
    sql`
    select ${SCHEDULE_COLUMNS} from expense_amortization_schedules
     where org_id = ${orgId} and source_document_id = ${documentId}
     order by id
     for update`,
    "objects",
  );
  return rows.map(fromRow);
}

/** The live plan (planned and posted lines) in period order. */
export async function livePlanLines(
  runner: SqlExecutor,
  orgId: string,
  scheduleId: string,
): Promise<PlanLine[]> {
  const rows = await runner.execute<{
    id: string;
    plan_revision: number;
    period_start: string;
    period_end: string;
    weight: string;
    planned_amount: string;
    destination_account_id: string;
    status: "planned" | "posted";
    journal_entry_id: string | null;
  }>(
    sql`
    select id, plan_revision, period_start::text as period_start, period_end::text as period_end,
           weight::text as weight, planned_amount::text as planned_amount, destination_account_id,
           status, journal_entry_id
      from expense_amortization_schedule_lines
     where org_id = ${orgId} and schedule_id = ${scheduleId} and status in ('planned', 'posted')
     order by period_start`,
    "objects",
  );
  return rows.map((row) => ({
    id: row.id,
    planRevision: row.plan_revision,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    weight: BigInt(row.weight),
    plannedAmount: toUnits(row.planned_amount),
    destinationAccountId: row.destination_account_id,
    status: row.status,
    journalEntryId: row.journal_entry_id,
  }));
}

export interface ScheduleBalance {
  /** Amortization posted by plan lines. */
  posted: bigint;
  /** Amortized before the schedule (opening balances) or by plan lines, net of catch-up reversals. */
  amortized: bigint;
  /** Unamortized balance still held in the deferral account. */
  remaining: bigint;
  /** Planned, unposted amortization. */
  planned: bigint;
}

export function scheduleBalance(
  schedule: StoredSchedule,
  lines: readonly PlanLine[],
): ScheduleBalance {
  const posted = lines
    .filter((line) => line.status === "posted")
    .reduce((acc, line) => acc + line.plannedAmount, 0n);
  const planned = lines
    .filter((line) => line.status === "planned")
    .reduce((acc, line) => acc + line.plannedAmount, 0n);
  const amortized = schedule.openingAmortized + posted - schedule.reversed;
  const remaining = schedule.status === "cancelled" ? 0n : schedule.totalAmount - amortized;
  return { posted, amortized, remaining, planned };
}

export function nextPlanRevision(lines: readonly { planRevision: number }[]): number {
  return lines.reduce((max, line) => Math.max(max, line.planRevision), 0) + 1;
}

/**
 * Compare-and-set update: applies only while the stored revision is the one
 * the caller read, and advances it by one. A concurrent change refuses.
 */
export async function updateSchedule(
  runner: SqlExecutor,
  schedule: StoredSchedule,
  actorId: string | null,
  changes: {
    status?: ScheduleStatus;
    totalAmount?: bigint;
    reversed?: bigint;
    destinationAccountId?: string;
    holdReason?: string | null;
    completed?: boolean;
    cancelled?: boolean;
  },
): Promise<StoredSchedule> {
  const sets = [
    sql`revision = revision + 1`,
    sql`updated_at = now()`,
    sql`updated_by = ${actorId}`,
  ];
  if (changes.status !== undefined) sets.push(sql`status = ${changes.status}`);
  if (changes.totalAmount !== undefined)
    sets.push(sql`total_amount = ${fromUnits(changes.totalAmount)}::numeric`);
  if (changes.reversed !== undefined)
    sets.push(sql`reversed_amount = ${fromUnits(changes.reversed)}::numeric`);
  if (changes.destinationAccountId !== undefined)
    sets.push(sql`destination_account_id = ${changes.destinationAccountId}`);
  if (changes.holdReason !== undefined) sets.push(sql`hold_reason = ${changes.holdReason}`);
  if (changes.completed) sets.push(sql`completed_at = now()`);
  if (changes.cancelled) sets.push(sql`cancelled_at = now()`);
  const row = (
    await runner.execute<ScheduleRow>(
      sql`
    update expense_amortization_schedules
       set ${sql.join(sets, sql`, `)}
     where org_id = ${schedule.orgId} and id = ${schedule.id} and revision = ${schedule.revision}
    returning ${SCHEDULE_COLUMNS}`,
      "objects",
    )
  )[0];
  if (!row) {
    throw new AmortizationError(
      `Schedule ${schedule.scheduleNumber} changed while this action ran.`,
      {
        status: 409,
        code: "amortization_schedule_conflict",
        remedy: "Reload the schedule and apply the change again.",
      },
    );
  }
  return fromRow(row);
}

/** Refuse a stale caller: the revision it read must still be current. */
export function assertExpectedRevision(
  schedule: StoredSchedule,
  expectedRevision: number | undefined,
): void {
  if (expectedRevision !== undefined && expectedRevision !== schedule.revision) {
    throw new AmortizationError(
      `Schedule ${schedule.scheduleNumber} changed since it was opened.`,
      {
        status: 409,
        code: "amortization_schedule_conflict",
        remedy: "Reload the schedule, review the change, and apply it again.",
      },
    );
  }
}

/** Close planned lines (superseded by a re-forecast, or cancelled). */
export async function closePlannedLines(
  runner: SqlExecutor,
  orgId: string,
  lineIds: readonly string[],
  status: "superseded" | "cancelled",
): Promise<void> {
  if (lineIds.length === 0) return;
  const updated = await runner.execute<{ id: string }>(
    sql`
    update expense_amortization_schedule_lines
       set status = ${status}, closed_at = now()
     where org_id = ${orgId} and status = 'planned'
       and id = any(${`{${lineIds.join(",")}}`}::uuid[])
    returning id`,
    "objects",
  );
  if (updated.length !== lineIds.length) {
    throw new AmortizationError("A planned amortization line changed while this action ran.", {
      status: 409,
      code: "amortization_line_conflict",
      remedy: "Reload the schedule and apply the change again.",
    });
  }
}

export interface AmortizationLeg {
  accountId: string;
  /** Signed ledger units: positive debits, negative credits. */
  amount: bigint;
}

/**
 * Post one balanced amortization entry for a schedule through the journal
 * kernel, in the schedule's book, entity and functional currency, with the
 * schedule's dimensions on every leg. The idempotency key makes a retry
 * return the same entry; a closed period refuses with its remedy.
 */
export async function postScheduleEntry(
  runner: SqlExecutor,
  input: {
    schedule: StoredSchedule;
    postingDate: string;
    entrySuffix: string;
    idempotencyKey: string;
    memo: string;
    actorId: string | null;
    auditAction: string;
    legs: readonly AmortizationLeg[];
  },
): Promise<string> {
  const { schedule } = input;
  const period = await resolveCoveringPeriod(
    runner,
    schedule.orgId,
    input.postingDate,
    schedule.subsidiaryId,
  );
  if (!period) {
    throw new AmortizationError(`No accounting period covers ${input.postingDate}.`, {
      code: "amortization_period_missing",
      remedy: `Generate the accounting period covering ${input.postingDate} (Accounting → Period Close), then try again.`,
    });
  }
  const dims = schedule.dimensions;
  try {
    const posted = await postEntry(runner, {
      orgId: schedule.orgId,
      bookId: schedule.bookId,
      subsidiaryId: schedule.subsidiaryId,
      entryNumber: await nextFreeEntryNumber(
        runner as Parameters<typeof nextFreeEntryNumber>[0],
        schedule.orgId,
        `${schedule.scheduleNumber}-${input.entrySuffix}`,
      ),
      postingDate: input.postingDate,
      periodId: period.id,
      memo: input.memo,
      origin: AMORTIZATION_JOURNAL_ORIGIN,
      amountBasis: "book",
      accountBasis: "book",
      replicate: false,
      idempotencyKey: input.idempotencyKey,
      currency: schedule.currency,
      actorId: input.actorId,
      auditAction: input.auditAction,
      auditChanges: { scheduleId: schedule.id, scheduleNumber: schedule.scheduleNumber },
      lines: input.legs.map((leg) => ({
        accountId: leg.accountId,
        amount: fromUnits(leg.amount),
        currency: schedule.currency,
        txnAmount: fromUnits(leg.amount),
        memo: input.memo,
        departmentId: dims.departmentId,
        projectId: dims.projectId,
        locationId: dims.locationId,
        classId: dims.classId,
        extraDims: dims.extraDims,
      })),
    });
    return posted.entryId;
  } catch (error) {
    if (error instanceof PostingError) {
      throw new AmortizationError(
        `The amortization entry for ${schedule.scheduleNumber} was refused: ${error.message}`,
        {
          code: "amortization_posting_refused",
          remedy:
            "Resolve the ledger refusal (for example, reopen the period through Period Close or correct the account), then try again.",
        },
      );
    }
    throw error;
  }
}
