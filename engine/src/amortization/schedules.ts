import { loadBookProfile, resolveBookBases } from "../journal/book-basis.ts";
import { applyBookAccountMaps, BookAccountMapError } from "../journal/book-account-maps.ts";
import { BookTranslationError } from "../journal/book-translation.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { lockLedgerSetupFence } from "../organization/ledger-setup-fence.ts";
/**
 * Schedule lifecycle: manual schedules for opening prepaid balances, and the
 * governed changes every schedule takes — activate, hold and resume, change
 * the remaining term or the destination account from a period, reduce for a
 * credit, and cancel. Each change locks the schedule, checks the caller's
 * revision, records an event with its reason and before/after state, and
 * posts any catch-up through the journal kernel. Posted plan lines are never
 * rewritten: a change re-forecasts only the unposted periods from the
 * period it takes effect.
 */
import { sql } from "drizzle-orm";
import { fromUnits } from "../money/money.ts";
import { activePostingPrimaryBookId } from "../platform/accounting-books.ts";
import { businessTodayInTx } from "../platform/business-date.ts";
import {
  addCalendarDays,
  addMonthsStart,
  isIsoCalendarDate,
  startOfMonth,
} from "../platform/civil-date.ts";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { AmortizationError } from "./errors.ts";
import {
  amortizationCurrencyExponent,
  assertAmortizationFeature,
  insertPlanLines,
  ledgerUnits,
  nextScheduleNumber,
  recordScheduleEvent,
  requireAmortizationAuthority,
  requireReason,
} from "./internal.ts";
import {
  buildAmortizationPlan,
  planQuantum,
  reforecastAmortizationPlan,
  resolveAmortizationTerm,
  termWeights,
  type PlannedPeriod,
} from "./plan.ts";
import {
  assertExpectedRevision,
  closePlannedLines,
  livePlanLines,
  loadSchedule,
  nextPlanRevision,
  postScheduleEntry,
  scheduleBalance,
  updateSchedule,
  type PlanLine,
  type ScheduleDimensions,
  type StoredSchedule,
} from "./schedule-store.ts";
import {
  assertDeferralAccount,
  assertDestinationAccount,
  loadTemplateVersion,
  resolveTemplateVersion,
} from "./templates.ts";

function requireDate(value: string, label: string): string {
  if (!isIsoCalendarDate(value)) {
    throw new AmortizationError(`${label} must be a valid YYYY-MM-DD date.`, {
      code: "amortization_date_invalid",
      remedy: `Enter ${label} as YYYY-MM-DD.`,
    });
  }
  return value;
}

function requirePeriodStart(value: string, label: string): string {
  requireDate(value, label);
  return startOfMonth(value);
}

/** Lock, gate and authorize one schedule for a governed change. */
async function openScheduleForChange(
  runner: SqlExecutor,
  input: { orgId: string; actorId: string; scheduleId: string; expectedRevision?: number },
): Promise<StoredSchedule> {
  await assertAmortizationFeature(runner, input.orgId);
  await lockLedgerSetupFence(runner, input.orgId, "shared");
  const schedule = await loadSchedule(runner, input.orgId, input.scheduleId, { lock: true });
  await requireAmortizationAuthority(
    runner,
    input.orgId,
    input.actorId,
    schedule.subsidiaryId,
    "amortization.manage",
  );
  assertExpectedRevision(schedule, input.expectedRevision);
  return schedule;
}

function stateOf(schedule: StoredSchedule, lines: readonly PlanLine[]): Record<string, unknown> {
  const balance = scheduleBalance(schedule, lines);
  return {
    status: schedule.status,
    revision: schedule.revision,
    totalAmount: fromUnits(schedule.totalAmount),
    amortized: fromUnits(balance.amortized),
    remaining: fromUnits(balance.remaining),
    destinationAccountId: schedule.destinationAccountId,
    holdReason: schedule.holdReason,
    plan: lines.map((line) => ({
      period: line.periodStart.slice(0, 7),
      amount: fromUnits(line.plannedAmount),
      status: line.status,
      accountId: line.destinationAccountId,
    })),
  };
}

/** The first period a change may take effect: after the last posted period. */
function assertChangePeriod(
  schedule: StoredSchedule,
  lines: readonly PlanLine[],
  fromPeriod: string,
): void {
  const lastPosted = lines.filter((line) => line.status === "posted").at(-1);
  if (lastPosted && fromPeriod <= lastPosted.periodStart) {
    throw new AmortizationError(
      `Schedule ${schedule.scheduleNumber} has posted amortization through ${lastPosted.periodStart.slice(0, 7)}; a change can take effect only in a later period.`,
      {
        code: "amortization_change_period_posted",
        remedy: `Choose ${addMonthsStart(lastPosted.periodStart, 1).slice(0, 7)} or later as the period the change takes effect.`,
      },
    );
  }
}

/**
 * Supersede planned lines and plan `amount` from `fromPeriod`. With `fold`,
 * every unposted line is replaced, so earlier unposted periods (a closed
 * month, a missed run) move into the new plan; without it, planned periods
 * before `fromPeriod` stay as they are.
 */
async function replan(
  runner: SqlExecutor,
  schedule: StoredSchedule,
  lines: readonly PlanLine[],
  input: {
    fromPeriod: string;
    amount: bigint;
    newLastPeriod?: string | null;
    destinationAccountId: string;
    actorId: string;
    fold: boolean;
  },
): Promise<PlannedPeriod[]> {
  const replaced = lines.filter(
    (line) => line.status === "planned" && (input.fold || line.periodStart >= input.fromPeriod),
  );
  const template = await loadTemplateVersion(runner, schedule.orgId, schedule.templateId);
  const exponent = await amortizationCurrencyExponent(runner, schedule.currency);
  const plan = reforecastAmortizationPlan({
    policy: template.policy,
    currentPlan: replaced.map((line) => ({ periodStart: line.periodStart, weight: line.weight })),
    remaining: input.amount,
    fromPeriod: input.fromPeriod,
    newLastPeriod: input.newLastPeriod ?? null,
    quantum: planQuantum(input.amount, exponent),
  });
  const replacedIds = new Set(replaced.map((line) => line.id));
  const keptPlanned = new Set(
    lines
      .filter((line) => line.status === "planned" && !replacedIds.has(line.id))
      .map((line) => line.periodStart),
  );
  const posted = new Set(
    lines.filter((line) => line.status === "posted").map((line) => line.periodStart),
  );
  const collision = plan.find(
    (period) => keptPlanned.has(period.periodStart) || posted.has(period.periodStart),
  );
  if (collision) {
    throw new AmortizationError(
      `Period ${collision.periodStart.slice(0, 7)} of ${schedule.scheduleNumber} is already planned.`,
      {
        code: "amortization_period_collision",
        remedy: "Choose a later period for the change to take effect.",
      },
    );
  }
  await closePlannedLines(
    runner,
    schedule.orgId,
    replaced.map((line) => line.id),
    "superseded",
  );
  const weights = new Map(replaced.map((line) => [line.periodStart, line.weight]));
  await insertPlanLines(runner, {
    orgId: schedule.orgId,
    scheduleId: schedule.id,
    planRevision: nextPlanRevision(lines),
    lines: plan.map((period) => ({
      ...period,
      weight: input.newLastPeriod ? 1n : (weights.get(period.periodStart) ?? 1n),
    })),
    destinationAccountId: input.destinationAccountId,
    actorId: input.actorId,
  });
  return plan;
}

// ---------------------------------------------------------------------------
// Manual schedules
// ---------------------------------------------------------------------------

export interface CreateManualScheduleInput {
  orgId: string;
  actorId: string;
  templateId: string;
  subsidiaryId: string;
  bookId?: string | null;
  /** Deferred amount in the selected book's currency (ledger decimal). */
  totalAmount: string;
  /** Already amortized before the schedule (opening balances). */
  openingAmortizedAmount?: string;
  serviceStartOn: string;
  serviceEndOn?: string | null;
  /** First period this schedule amortizes (YYYY-MM-01); defaults to the term's first period. */
  amortizeFromPeriod?: string | null;
  destinationAccountId?: string | null;
  dimensions?: Partial<ScheduleDimensions>;
  memo?: string | null;
  reason: string;
}

/**
 * Record a manual schedule (for example, a prepaid balance carried in from
 * another system) as a draft. It posts nothing: the balance is already in
 * the deferral account. The plan spreads the unamortized amount (total less
 * the opening amortized amount) over the term from the chosen first period.
 * Activation starts amortization.
 */
export async function createManualSchedule(
  input: CreateManualScheduleInput,
): Promise<{ scheduleId: string; scheduleNumber: string }> {
  const reason = requireReason(input.reason);
  requireDate(input.serviceStartOn, "the service start date");
  if (input.serviceEndOn) requireDate(input.serviceEndOn, "the service end date");
  const total = ledgerUnits(input.totalAmount, "the deferred amount");
  const opening = ledgerUnits(input.openingAmortizedAmount ?? "0", "the amount already amortized");
  if (total <= 0n) {
    throw new AmortizationError("The deferred amount must be positive.", {
      code: "amortization_amount_not_positive",
      remedy: "Enter the prepaid balance above zero.",
    });
  }
  if (opening < 0n || opening >= total) {
    throw new AmortizationError(
      "The amount already amortized must be zero or more and less than the deferred amount.",
      {
        code: "amortization_opening_invalid",
        remedy:
          "Enter the amortization recorded before this schedule; a fully amortized balance needs no schedule.",
      },
    );
  }
  return withOrgTransaction(input.orgId, async () => {
    await assertAmortizationFeature(db, input.orgId);
    await lockLedgerSetupFence(db, input.orgId, "shared");
    await requireAmortizationAuthority(
      db,
      input.orgId,
      input.actorId,
      input.subsidiaryId,
      "amortization.manage",
    );
    const subsidiary = (
      await db.execute<{ base_currency: string; is_active: boolean | null }>(
        sql`
      select base_currency, is_active from subsidiaries where org_id = ${input.orgId} and id = ${input.subsidiaryId}`,
        "objects",
      )
    )[0];
    if (!subsidiary || subsidiary.is_active === false) {
      throw new AmortizationError(
        "The subsidiary does not exist in this organization or is inactive.",
        {
          status: 404,
          code: "amortization_subsidiary_unknown",
          remedy: "Choose an active subsidiary of this organization.",
        },
      );
    }
    const template = await resolveTemplateVersion(
      db,
      input.orgId,
      input.templateId,
      input.serviceStartOn,
    );
    await assertDeferralAccount(db, input.orgId, template.deferralAccountId);
    const destinationAccountId = input.destinationAccountId || template.destinationAccountId;
    if (!destinationAccountId) {
      throw new AmortizationError("A manual schedule needs a destination account.", {
        code: "amortization_destination_missing",
        remedy:
          "Choose the expense account the prepaid amount amortizes into, or set a default destination on the template.",
      });
    }
    if (destinationAccountId === template.deferralAccountId) {
      throw new AmortizationError(
        "The destination account must differ from the deferral account.",
        {
          code: "amortization_destination_is_deferral",
          remedy: "Choose the expense account the prepaid amount amortizes into.",
        },
      );
    }
    await assertDestinationAccount(db, input.orgId, destinationAccountId, "The schedule");
    const term = resolveAmortizationTerm(template.policy, {
      serviceStartOn: input.serviceStartOn,
      serviceEndOn: input.serviceEndOn ?? null,
      transactionDate: input.serviceStartOn,
    });
    const fromPeriod = input.amortizeFromPeriod
      ? requirePeriodStart(input.amortizeFromPeriod, "the first period")
      : term.firstPeriodOn;
    const bookId = input.bookId ?? (await activePostingPrimaryBookId(input.orgId, db));
    if (!bookId) {
      throw new AmortizationError("No active primary posting book.", {
        code: "amortization_book_missing",
        remedy: "Activate a primary posting book in Company Settings → Accounting books.",
      });
    }
    const book = await loadBookProfile(db, input.orgId, bookId);
    const available = (
      await db.execute<{ id: string }>(
        sql`select id from accounting_books where org_id = ${input.orgId} and id = ${bookId} and is_active and posts_gl for share`,
        "objects",
      )
    )[0];
    if (!book || !available)
      throw new AmortizationError(
        "The selected accounting book is not an active posting book of this organization.",
        { status: 404 },
      );
    if (!book.isPrimary && !(await lockAndCheckOrgFeature(db, input.orgId, "multiBookAccounting")))
      throw new AmortizationError("Multi-book accounting is off.", {
        remedy:
          "Turn on Multi-book accounting in Company Settings → Features, or choose the primary book.",
      });
    const basis = (
      await resolveBookBases(db, {
        orgId: input.orgId,
        book,
        subsidiaryIds: [input.subsidiaryId],
        postingDate: fromPeriod,
      })
    ).get(input.subsidiaryId)!;
    const mapped = book.isPrimary
      ? {
          lines: [
            { accountId: template.deferralAccountId, subsidiaryId: input.subsidiaryId },
            { accountId: destinationAccountId, subsidiaryId: input.subsidiaryId },
          ],
        }
      : await applyBookAccountMaps(db, {
          orgId: input.orgId,
          bookId,
          bookLabel: book.code,
          postingDate: fromPeriod,
          entryLabel: "Manual amortization schedule",
          lines: [
            { accountId: template.deferralAccountId, subsidiaryId: input.subsidiaryId },
            { accountId: destinationAccountId, subsidiaryId: input.subsidiaryId },
          ],
        });
    const deferralAccountId = mapped.lines[0]!.accountId;
    const bookDestinationAccountId = mapped.lines[1]!.accountId;
    await assertDeferralAccount(db, input.orgId, deferralAccountId);
    await assertDestinationAccount(db, input.orgId, bookDestinationAccountId, "The schedule");
    const exponent = await amortizationCurrencyExponent(db, basis.bookCurrency);
    const remaining = total - opening;
    const fullPlan = buildAmortizationPlan(
      template.policy,
      term,
      total,
      planQuantum(total, exponent),
    );
    const weights = termWeights(template.policy, term);
    const plan =
      opening === 0n && fromPeriod === term.firstPeriodOn
        ? fullPlan.map((period, index) => ({ ...period, weight: weights[index]! }))
        : reforecastAmortizationPlan({
            policy: template.policy,
            currentPlan: fullPlan.map((period, index) => ({
              periodStart: period.periodStart,
              weight: weights[index]!,
            })),
            remaining,
            fromPeriod,
            quantum: planQuantum(remaining, exponent),
          }).map((period) => ({
            ...period,
            weight: weights[fullPlan.findIndex((p) => p.periodStart === period.periodStart)] ?? 1n,
          }));
    const dims = input.dimensions ?? {};
    const scheduleNumber = await nextScheduleNumber(db, input.orgId);
    const row = (
      await db.execute<{ id: string }>(
        sql`
      insert into expense_amortization_schedules
        (org_id, schedule_number, status, source_kind, template_id, method, term_source, period_offset,
         subsidiary_id, book_id, currency, total_amount, opening_amortized_amount,
         service_start_on, service_end_on, first_period_on, deferral_account_id, destination_account_id,
         department_id, project_id, location_id, class_id, extra_dims, memo, created_by, updated_by)
      values (${input.orgId}, ${scheduleNumber}, 'draft', 'manual', ${template.id}, ${template.policy.method},
        ${template.policy.termSource}, ${template.policy.periodOffset}, ${input.subsidiaryId}, ${bookId},
        ${basis.bookCurrency}, ${fromUnits(total)}::numeric, ${fromUnits(opening)}::numeric,
        ${term.startOn}, ${term.endOn}, ${plan[0]?.periodStart ?? term.firstPeriodOn},
        ${deferralAccountId}, ${bookDestinationAccountId},
        ${dims.departmentId ?? null}, ${dims.projectId ?? null}, ${dims.locationId ?? null}, ${dims.classId ?? null},
        ${JSON.stringify(dims.extraDims ?? {})}::jsonb, ${input.memo ?? null}, ${input.actorId}, ${input.actorId})
      returning id`,
        "objects",
      )
    )[0];
    if (!row)
      throw new AmortizationError("The schedule was not stored; nothing was saved.", {
        status: 409,
      });
    await insertPlanLines(db, {
      orgId: input.orgId,
      scheduleId: row.id,
      planRevision: 1,
      lines: plan,
      destinationAccountId: bookDestinationAccountId,
      actorId: input.actorId,
    });
    await recordScheduleEvent(db, {
      orgId: input.orgId,
      scheduleId: row.id,
      kind: "created",
      reason,
      effectiveOn: term.startOn,
      after: {
        scheduleNumber,
        status: "draft",
        totalAmount: fromUnits(total),
        openingAmortized: fromUnits(opening),
        bookId,
        currency: basis.bookCurrency,
        deferralAccountId,
        template: { id: template.id, code: template.code, effectiveFrom: template.effectiveFrom },
        firstPeriodOn: plan[0]?.periodStart ?? null,
        periods: plan.length,
        destinationAccountId: bookDestinationAccountId,
      },
      actorId: input.actorId,
    });
    return { scheduleId: row.id, scheduleNumber };
  }).catch((error: unknown) => {
    if (error instanceof BookTranslationError || error instanceof BookAccountMapError) {
      throw new AmortizationError(error.message, {
        code: "amortization_book_policy",
        remedy:
          "Correct the selected book's currency coverage or account mappings for the first amortization period in Setup → Accounting books, then save the schedule again.",
        cause: error,
      });
    }
    throw error;
  });
}

// ---------------------------------------------------------------------------
// Governed changes
// ---------------------------------------------------------------------------

export interface ScheduleChangeInput {
  orgId: string;
  actorId: string;
  scheduleId: string;
  reason: string;
  expectedRevision?: number;
}

export interface ScheduleChangeResult {
  scheduleId: string;
  status: string;
  revision: number;
  journalEntryId: string | null;
}

/**
 * Activate a draft manual schedule. Its unamortized balance joins the
 * subledger at the end of the month before its first period, the date the
 * carried-in prepaid balance must already stand in the deferral account.
 */
export async function activateSchedule(input: ScheduleChangeInput): Promise<ScheduleChangeResult> {
  const reason = requireReason(input.reason);
  return withOrgTransaction(input.orgId, async () => {
    const schedule = await openScheduleForChange(db, input);
    if (schedule.status !== "draft") {
      throw new AmortizationError(
        `Schedule ${schedule.scheduleNumber} is ${schedule.status}; only a draft activates.`,
        {
          status: 409,
          code: "amortization_not_draft",
          remedy: "Reload the schedule; it may already be active.",
        },
      );
    }
    const lines = await livePlanLines(db, input.orgId, schedule.id);
    const before = stateOf(schedule, lines);
    const updated = await updateSchedule(db, schedule, input.actorId, { status: "active" });
    await recordScheduleEvent(db, {
      orgId: input.orgId,
      scheduleId: schedule.id,
      kind: "activated",
      reason,
      effectiveOn: addCalendarDays(schedule.firstPeriodOn, -1),
      balanceDelta: schedule.totalAmount - schedule.openingAmortized,
      before,
      after: stateOf(updated, lines),
      actorId: input.actorId,
    });
    return {
      scheduleId: schedule.id,
      status: updated.status,
      revision: updated.revision,
      journalEntryId: null,
    };
  });
}

/** Put an active schedule on hold: runs skip it until it resumes. */
export async function holdSchedule(input: ScheduleChangeInput): Promise<ScheduleChangeResult> {
  const reason = requireReason(input.reason);
  return withOrgTransaction(input.orgId, async () => {
    const schedule = await openScheduleForChange(db, input);
    if (schedule.status !== "active") {
      throw new AmortizationError(
        `Schedule ${schedule.scheduleNumber} is ${schedule.status}; only an active schedule goes on hold.`,
        {
          status: 409,
          code: "amortization_not_active",
          remedy: "Reload the schedule to see its current status.",
        },
      );
    }
    const lines = await livePlanLines(db, input.orgId, schedule.id);
    const before = stateOf(schedule, lines);
    const updated = await updateSchedule(db, schedule, input.actorId, {
      status: "on_hold",
      holdReason: reason,
    });
    await recordScheduleEvent(db, {
      orgId: input.orgId,
      scheduleId: schedule.id,
      kind: "held",
      reason,
      effectiveOn: await today(db, input.orgId),
      before,
      after: stateOf(updated, lines),
      actorId: input.actorId,
    });
    return {
      scheduleId: schedule.id,
      status: updated.status,
      revision: updated.revision,
      journalEntryId: null,
    };
  });
}

/** Resume a held schedule: due periods post on the next run. */
export async function resumeSchedule(input: ScheduleChangeInput): Promise<ScheduleChangeResult> {
  const reason = requireReason(input.reason);
  return withOrgTransaction(input.orgId, async () => {
    const schedule = await openScheduleForChange(db, input);
    if (schedule.status !== "on_hold") {
      throw new AmortizationError(
        `Schedule ${schedule.scheduleNumber} is ${schedule.status}; only a held schedule resumes.`,
        {
          status: 409,
          code: "amortization_not_on_hold",
          remedy: "Reload the schedule to see its current status.",
        },
      );
    }
    const lines = await livePlanLines(db, input.orgId, schedule.id);
    const before = stateOf(schedule, lines);
    const updated = await updateSchedule(db, schedule, input.actorId, {
      status: "active",
      holdReason: null,
    });
    await recordScheduleEvent(db, {
      orgId: input.orgId,
      scheduleId: schedule.id,
      kind: "resumed",
      reason,
      effectiveOn: await today(db, input.orgId),
      before,
      after: stateOf(updated, lines),
      actorId: input.actorId,
    });
    return {
      scheduleId: schedule.id,
      status: updated.status,
      revision: updated.revision,
      journalEntryId: null,
    };
  });
}

async function today(runner: SqlExecutor, orgId: string): Promise<string> {
  return businessTodayInTx(runner, orgId);
}

function assertOpenForPlanChange(schedule: StoredSchedule): void {
  if (
    schedule.status !== "active" &&
    schedule.status !== "on_hold" &&
    schedule.status !== "draft"
  ) {
    throw new AmortizationError(
      `Schedule ${schedule.scheduleNumber} is ${schedule.status} and its plan cannot change.`,
      {
        status: 409,
        code: "amortization_plan_closed",
        remedy: "Only draft, active and held schedules change their plan.",
      },
    );
  }
}

/**
 * Change the remaining term from a period: every unposted amount — including
 * periods before it that never posted, such as a closed month — spreads
 * evenly from that period through the new last period. Posted periods stay
 * as they are.
 */
export async function changeScheduleTerm(
  input: ScheduleChangeInput & { effectivePeriod: string; newLastPeriod: string },
): Promise<ScheduleChangeResult> {
  const reason = requireReason(input.reason);
  const fromPeriod = requirePeriodStart(
    input.effectivePeriod,
    "the period the change takes effect",
  );
  const lastPeriod = requirePeriodStart(input.newLastPeriod, "the new last period");
  return withOrgTransaction(input.orgId, async () => {
    const schedule = await openScheduleForChange(db, input);
    assertOpenForPlanChange(schedule);
    const lines = await livePlanLines(db, input.orgId, schedule.id);
    assertChangePeriod(schedule, lines, fromPeriod);
    const amount = lines
      .filter((line) => line.status === "planned")
      .reduce((acc, line) => acc + line.plannedAmount, 0n);
    if (amount === 0n) {
      throw new AmortizationError(
        `Schedule ${schedule.scheduleNumber} has no unposted amount to re-plan.`,
        {
          code: "amortization_nothing_to_replan",
          remedy: "Only a schedule with unposted periods can change its term.",
        },
      );
    }
    const before = stateOf(schedule, lines);
    await replan(db, schedule, lines, {
      fromPeriod,
      amount,
      newLastPeriod: lastPeriod,
      destinationAccountId: schedule.destinationAccountId,
      actorId: input.actorId,
      fold: true,
    });
    const updated = await updateSchedule(db, schedule, input.actorId, {});
    const after = stateOf(updated, await livePlanLines(db, input.orgId, schedule.id));
    await recordScheduleEvent(db, {
      orgId: input.orgId,
      scheduleId: schedule.id,
      kind: "term_changed",
      reason,
      effectivePeriodOn: fromPeriod,
      effectiveOn: fromPeriod,
      before,
      after: { ...after, newLastPeriod: lastPeriod },
      actorId: input.actorId,
    });
    return {
      scheduleId: schedule.id,
      status: updated.status,
      revision: updated.revision,
      journalEntryId: null,
    };
  });
}

/** Amortize into a different account from a period; earlier periods keep theirs. */
export async function changeScheduleDestination(
  input: ScheduleChangeInput & { effectivePeriod: string; destinationAccountId: string },
): Promise<ScheduleChangeResult> {
  const reason = requireReason(input.reason);
  const fromPeriod = requirePeriodStart(
    input.effectivePeriod,
    "the period the change takes effect",
  );
  return withOrgTransaction(input.orgId, async () => {
    const schedule = await openScheduleForChange(db, input);
    assertOpenForPlanChange(schedule);
    if (input.destinationAccountId === schedule.deferralAccountId) {
      throw new AmortizationError(
        "The destination account must differ from the deferral account.",
        {
          code: "amortization_destination_is_deferral",
          remedy: "Choose the expense account the prepaid amount amortizes into.",
        },
      );
    }
    await assertDestinationAccount(
      db,
      input.orgId,
      input.destinationAccountId,
      `Schedule ${schedule.scheduleNumber}`,
    );
    const lines = await livePlanLines(db, input.orgId, schedule.id);
    assertChangePeriod(schedule, lines, fromPeriod);
    const amount = lines
      .filter((line) => line.status === "planned" && line.periodStart >= fromPeriod)
      .reduce((acc, line) => acc + line.plannedAmount, 0n);
    if (amount === 0n) {
      throw new AmortizationError(
        `Schedule ${schedule.scheduleNumber} has nothing planned from ${fromPeriod.slice(0, 7)}.`,
        {
          code: "amortization_nothing_to_replan",
          remedy: "Choose an earlier period for the change to take effect.",
        },
      );
    }
    const before = stateOf(schedule, lines);
    await replan(db, schedule, lines, {
      fromPeriod,
      amount,
      destinationAccountId: input.destinationAccountId,
      actorId: input.actorId,
      fold: false,
    });
    const updated = await updateSchedule(db, schedule, input.actorId, {
      destinationAccountId: input.destinationAccountId,
    });
    await recordScheduleEvent(db, {
      orgId: input.orgId,
      scheduleId: schedule.id,
      kind: "destination_changed",
      reason,
      effectivePeriodOn: fromPeriod,
      effectiveOn: fromPeriod,
      before,
      after: stateOf(updated, await livePlanLines(db, input.orgId, schedule.id)),
      actorId: input.actorId,
    });
    return {
      scheduleId: schedule.id,
      status: updated.status,
      revision: updated.revision,
      journalEntryId: null,
    };
  });
}

/**
 * Reduce a schedule for a credit (for example, a vendor credit posted to the
 * deferral account). The reduction comes out of the unposted periods, which
 * are re-planned from the credit's month (or the first month after the last
 * posted period, when later). When the credit exceeds the unamortized
 * balance, the excess amortization returns to the deferral account as a
 * catch-up entry on the credit date and the schedule completes.
 */
export async function reduceSchedule(
  input: ScheduleChangeInput & {
    amount: string;
    effectiveDate: string;
    relatedDocumentId?: string | null;
  },
): Promise<ScheduleChangeResult> {
  const reason = requireReason(input.reason);
  const effectiveDate = requireDate(input.effectiveDate, "the credit date");
  const creditPeriod = startOfMonth(effectiveDate);
  const reduction = ledgerUnits(input.amount, "the reduction");
  if (reduction <= 0n) {
    throw new AmortizationError("The reduction must be positive.", {
      code: "amortization_amount_not_positive",
      remedy: "Enter the credited amount above zero.",
    });
  }
  return withOrgTransaction(input.orgId, async () => {
    const schedule = await openScheduleForChange(db, input);
    if (schedule.status === "cancelled" || schedule.status === "draft") {
      throw new AmortizationError(
        `Schedule ${schedule.scheduleNumber} is ${schedule.status} and cannot be reduced.`,
        {
          status: 409,
          code: "amortization_not_reducible",
          remedy:
            schedule.status === "draft"
              ? "Activate the schedule first, or cancel it and record a new one."
              : "A cancelled schedule is final.",
        },
      );
    }
    if (input.relatedDocumentId) await assertCreditDocument(db, schedule, input.relatedDocumentId);
    const lines = await livePlanLines(db, input.orgId, schedule.id);
    const balance = scheduleBalance(schedule, lines);
    if (reduction >= schedule.totalAmount - schedule.openingAmortized) {
      throw new AmortizationError(
        `A credit of ${fromUnits(reduction)} covers the whole deferral of ${schedule.scheduleNumber}.`,
        {
          code: "amortization_reduction_covers_total",
          remedy:
            "Cancel the schedule and return its posted amortization to the deferral account instead.",
        },
      );
    }
    const before = stateOf(schedule, lines);
    const lastPosted = lines.filter((line) => line.status === "posted").at(-1)?.periodStart ?? null;
    const afterPosted = lastPosted
      ? addMonthsStart(lastPosted, 1)
      : (lines.find((line) => line.status === "planned")?.periodStart ?? creditPeriod);
    const fromPeriod = creditPeriod > afterPosted ? creditPeriod : afterPosted;
    const planned = balance.planned;
    const plannedFromCredit = lines
      .filter((line) => line.status === "planned" && line.periodStart >= fromPeriod)
      .reduce((sum, line) => sum + line.plannedAmount, 0n);
    const replanFrom = reduction > plannedFromCredit ? afterPosted : fromPeriod;
    const replacedPlanned = lines.filter(
      (line) => line.status === "planned" && line.periodStart >= replanFrom,
    );
    const remainingForReplan =
      replacedPlanned.reduce((sum, line) => sum + line.plannedAmount, 0n) - reduction;
    let catchUp = 0n;
    let entryId: string | null = null;
    if (reduction <= planned) {
      if (remainingForReplan > 0n) {
        await replan(db, schedule, lines, {
          fromPeriod: replanFrom,
          amount: remainingForReplan,
          destinationAccountId: schedule.destinationAccountId,
          actorId: input.actorId,
          fold: false,
        });
      } else {
        await closePlannedLines(
          db,
          input.orgId,
          replacedPlanned.map((line) => line.id),
          "superseded",
        );
      }
    } else if (reduction <= balance.remaining) {
      // The plan always carries the unamortized balance; a gap between them
      // is not something a credit may paper over.
      throw new AmortizationError(
        `Schedule ${schedule.scheduleNumber} plans ${fromUnits(planned)} but carries ${fromUnits(balance.remaining)} unamortized.`,
        {
          status: 409,
          code: "amortization_plan_gap",
          remedy:
            "Review the schedule's plan and history; cancel it with a write-off or a reversal to settle its balance.",
        },
      );
    } else {
      // Amortized beyond the reduced total: return the excess to the deferral.
      catchUp = reduction - balance.remaining;
      await closePlannedLines(
        db,
        input.orgId,
        lines.filter((l) => l.status === "planned").map((l) => l.id),
        "superseded",
      );
      entryId = await postScheduleEntry(db, {
        schedule,
        postingDate: effectiveDate,
        entrySuffix: "CR",
        idempotencyKey: `expense-amortization:reduce:${schedule.id}:${schedule.revision}`,
        memo: `Amortization catch-up for credit on ${schedule.scheduleNumber}`,
        actorId: input.actorId,
        auditAction: "amortization.reduce",
        legs: [
          { accountId: schedule.deferralAccountId, amount: catchUp },
          { accountId: schedule.destinationAccountId, amount: -catchUp },
        ],
      });
    }
    const after = await updateSchedule(db, schedule, input.actorId, {
      totalAmount: schedule.totalAmount - reduction,
      reversed: schedule.reversed + catchUp,
    });
    const afterLines = await livePlanLines(db, input.orgId, schedule.id);
    let final = after;
    if (
      scheduleBalance(after, afterLines).remaining === 0n &&
      afterLines.every((line) => line.status === "posted") &&
      after.status === "active"
    ) {
      final = await updateSchedule(db, after, input.actorId, {
        status: "completed",
        completed: true,
      });
    }
    await recordScheduleEvent(db, {
      orgId: input.orgId,
      scheduleId: schedule.id,
      kind: "reduced",
      reason,
      effectivePeriodOn: creditPeriod,
      effectiveOn: effectiveDate,
      balanceDelta: catchUp - reduction,
      before,
      after: {
        ...stateOf(final, afterLines),
        reduction: fromUnits(reduction),
        catchUp: fromUnits(catchUp),
      },
      journalEntryId: entryId,
      relatedDocumentId: input.relatedDocumentId ?? null,
      actorId: input.actorId,
    });
    return {
      scheduleId: schedule.id,
      status: final.status,
      revision: final.revision,
      journalEntryId: entryId,
    };
  });
}

/** A credit document must be a posted credit of the same organization and entity. */
async function assertCreditDocument(
  runner: SqlExecutor,
  schedule: StoredSchedule,
  documentId: string,
): Promise<void> {
  const doc = (
    await runner.execute<{ kind: string; status: string; subsidiary_id: string | null }>(
      sql`
    select kind, status, subsidiary_id from documents where org_id = ${schedule.orgId} and id = ${documentId}`,
      "objects",
    )
  )[0];
  if (
    !doc ||
    doc.status !== "posted" ||
    doc.subsidiary_id !== schedule.subsidiaryId ||
    !["vendor_credit", "journal"].includes(doc.kind)
  ) {
    throw new AmortizationError(
      "The credit must be a posted vendor credit or journal for this schedule's legal entity.",
      {
        code: "amortization_credit_document_invalid",
        remedy:
          "Post the vendor credit (coded to the prepaid account) first, then reduce the schedule referencing it.",
      },
    );
  }
}

export type CancelMode = "write_off" | "reverse";

/**
 * Cancel a schedule. `write_off` expenses the unamortized balance now (DR
 * destination, CR deferral) — for a prepaid cost that no longer has future
 * benefit. `reverse` returns the posted amortization to the deferral (DR
 * deferral, CR the accounts it went to) — for a source credited in full,
 * whose credit already relieved the deferral. A draft cancels with no
 * posting. Planned periods are cancelled; posted periods stay as history.
 */
export async function cancelSchedule(
  input: ScheduleChangeInput & { mode: CancelMode; effectiveDate: string },
): Promise<ScheduleChangeResult> {
  const reason = requireReason(input.reason);
  const effectiveDate = requireDate(input.effectiveDate, "the cancellation date");
  if (input.mode !== "write_off" && input.mode !== "reverse") {
    throw new AmortizationError("Choose how the cancellation settles the balance.", {
      code: "amortization_cancel_mode_invalid",
      remedy: "Write off the unamortized balance, or reverse the posted amortization.",
    });
  }
  return withOrgTransaction(input.orgId, async () => {
    const schedule = await openScheduleForChange(db, input);
    if (schedule.status === "cancelled") {
      throw new AmortizationError(`Schedule ${schedule.scheduleNumber} is already cancelled.`, {
        status: 409,
        code: "amortization_already_cancelled",
        remedy: "Reload the schedule.",
      });
    }
    if (schedule.status === "completed" && input.mode === "write_off") {
      throw new AmortizationError(
        `Schedule ${schedule.scheduleNumber} is fully amortized; there is nothing to write off.`,
        {
          status: 409,
          code: "amortization_nothing_to_write_off",
          remedy: "Reverse the posted amortization only when the source was credited in full.",
        },
      );
    }
    const lines = await livePlanLines(db, input.orgId, schedule.id);
    const balance = scheduleBalance(schedule, lines);
    const before = stateOf(schedule, lines);
    let entryId: string | null = null;
    let reversed = schedule.reversed;
    let delta = 0n;
    if (schedule.status !== "draft") {
      if (input.mode === "write_off" && balance.remaining > 0n) {
        entryId = await postScheduleEntry(db, {
          schedule,
          postingDate: effectiveDate,
          entrySuffix: "WO",
          idempotencyKey: `expense-amortization:write-off:${schedule.id}`,
          memo: `Write-off of ${schedule.scheduleNumber}`,
          actorId: input.actorId,
          auditAction: "amortization.write_off",
          legs: [
            { accountId: schedule.destinationAccountId, amount: balance.remaining },
            { accountId: schedule.deferralAccountId, amount: -balance.remaining },
          ],
        });
        delta = -balance.remaining;
      } else if (input.mode === "reverse") {
        const restored = await reversePostedAmortization(db, schedule, {
          postingDate: effectiveDate,
          entrySuffix: "REV",
          idempotencyKey: `expense-amortization:reverse:${schedule.id}`,
          memo: `Reversal of amortization on ${schedule.scheduleNumber}`,
          actorId: input.actorId,
        });
        entryId = restored.entryId;
        reversed += restored.amount;
        // The credit that relieved the deferral posts outside the schedule;
        // with this entry the ledger moves by the unamortized balance, which
        // is exactly what leaves the subledger.
        delta = -balance.remaining;
      }
    }
    await closePlannedLines(
      db,
      input.orgId,
      lines.filter((line) => line.status === "planned").map((line) => line.id),
      "cancelled",
    );
    const updated = await updateSchedule(db, schedule, input.actorId, {
      status: "cancelled",
      cancelled: true,
      reversed,
      holdReason: null,
    });
    await recordScheduleEvent(db, {
      orgId: input.orgId,
      scheduleId: schedule.id,
      kind: "cancelled",
      reason,
      effectiveOn: effectiveDate,
      balanceDelta: schedule.status === "draft" ? 0n : delta,
      before,
      after: {
        ...stateOf(updated, await livePlanLines(db, input.orgId, schedule.id)),
        mode: input.mode,
      },
      journalEntryId: entryId,
      actorId: input.actorId,
    });
    return {
      scheduleId: schedule.id,
      status: updated.status,
      revision: updated.revision,
      journalEntryId: entryId,
    };
  });
}

/**
 * Return a schedule's net posted amortization to its deferral account, per
 * account and dimension exactly as the ledger carries it: the amortization
 * and catch-up entries of the schedule are summed by account, and every
 * non-deferral balance is reversed. Returns the entry and the amount.
 */
export async function reversePostedAmortization(
  runner: SqlExecutor,
  schedule: StoredSchedule,
  input: {
    postingDate: string;
    entrySuffix: string;
    idempotencyKey: string;
    memo: string;
    actorId: string | null;
  },
): Promise<{ entryId: string | null; amount: bigint }> {
  const rows = await runner.execute<{ account_id: string; amount: string }>(
    sql`
    with schedule_entries as (
      select journal_entry_id as entry_id from expense_amortization_schedule_lines
       where org_id = ${schedule.orgId} and schedule_id = ${schedule.id} and journal_entry_id is not null
      union
      select journal_entry_id from expense_amortization_schedule_events
       where org_id = ${schedule.orgId} and schedule_id = ${schedule.id} and journal_entry_id is not null
         and kind in ('reduced', 'cancelled', 'source_voided')
    )
    select jl.account_id, sum(jl.amount)::text as amount
      from journal_lines jl
      join journal_entries je on je.org_id = jl.org_id and je.id = jl.entry_id
     where jl.org_id = ${schedule.orgId}
       and jl.entry_id in (select entry_id from schedule_entries)
       and je.status in ('posted', 'reversed')
       and jl.account_id <> ${schedule.deferralAccountId}
     group by jl.account_id
    having sum(jl.amount) <> 0
     order by jl.account_id`,
    "objects",
  );
  const legs = rows.map((row) => ({
    accountId: row.account_id,
    amount: -ledgerUnits(row.amount, "the posted amortization"),
  }));
  const amount = -legs.reduce((acc, leg) => acc + leg.amount, 0n);
  if (legs.length === 0 || amount === 0n) return { entryId: null, amount: 0n };
  if (amount < 0n) {
    throw new AmortizationError(
      `Schedule ${schedule.scheduleNumber} carries a net credit in expense; its history needs review.`,
      {
        status: 409,
        code: "amortization_negative_amortized",
        remedy: "Review the schedule's amortization entries in the journal before cancelling it.",
      },
    );
  }
  const entryId = await postScheduleEntry(runner, {
    schedule,
    postingDate: input.postingDate,
    entrySuffix: input.entrySuffix,
    idempotencyKey: input.idempotencyKey,
    memo: input.memo,
    actorId: input.actorId,
    auditAction: "amortization.reverse",
    legs: [...legs, { accountId: schedule.deferralAccountId, amount }],
  });
  return { entryId, amount };
}
