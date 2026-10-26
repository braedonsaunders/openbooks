/**
 * Equity journal entries: the effective-dated account policy, balanced
 * entries posted through the journal kernel with origin `equity`, and the
 * governed reversal that corrects them.
 *
 * Every entry posts in the organization's primary book, measured in the legal
 * entity's functional currency (a leg in another currency carries its
 * transaction amount and rate), into the period covering its date, with an
 * exactly-once idempotency key: a retried command returns the entry it
 * already posted instead of posting twice. Closed periods, inactive
 * accounts and other ledger refusals reach the operator with their remedy.
 */
import { sql } from "drizzle-orm";
import { markEntryReversed, postEntry } from "../journal/post-entry.ts";
import { PostingError } from "../journal/posting-contracts.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import {
  assertPeriodModulesOpen,
  canonicalPeriodLabel,
  CloseError,
  periodClosedDetailsOf,
  type PeriodClosedDetails,
} from "../periods/period-policy.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { businessTodayInTx } from "../platform/business-date.ts";
import { db, type SqlExecutor } from "../platform/db.ts";
import { loadControlAccountsForRoles } from "../records/control-accounts.ts";
import { nextFreeEntryNumber } from "../records/entry-number.ts";
import { catalogRefusalOf, type CatalogRefusal } from "../platform/catalog-refusal.ts";
import { EquityError, equityError, fig } from "./errors.ts";

export const EQUITY_JOURNAL_ORIGIN = "equity";

/** A periodic run, or any other dated posting, as period refusals name it. */
export type EquityRunKind = "compensation" | "interest" | "posting";

export interface EquityAccountPolicy {
  id: string;
  effectiveFrom: string;
  commonStockAccountId: string;
  preferredStockAccountId: string;
  apicAccountId: string;
  apicShareBasedAccountId: string;
  compensationExpenseAccountId: string;
  treasuryStockAccountId: string;
  convertibleInstrumentsAccountId: string;
  /** Convertible note interest; versions recorded before these accounts existed carry none. */
  interestExpenseAccountId: string | null;
  accruedInterestAccountId: string | null;
  /** Cash received for unvested shares bought by early exercise. */
  earlyExerciseDepositAccountId: string | null;
}

type OptionalPolicyAccount =
  "interestExpenseAccountId" | "accruedInterestAccountId" | "earlyExerciseDepositAccountId";

/** An account the posting needs that the policy version in force does not map refuses with the Setup remedy. */
export function requirePolicyAccount(
  policy: EquityAccountPolicy,
  key: OptionalPolicyAccount,
): string {
  const accountId = policy[key];
  if (!accountId) {
    throw equityError("accountPolicyIncomplete", {
      date: fig.date(policy.effectiveFrom),
      account: fig.term(key),
    });
  }
  return accountId;
}

/** The organization's realized FX gain/loss control account, for settlements of foreign-currency instruments. */
export async function realizedFxAccount(runner: SqlExecutor, orgId: string): Promise<string> {
  const accounts = await loadControlAccountsForRoles(runner, orgId, ["fxRealizedGainLoss"]);
  if (!accounts.fxRealizedGainLoss) {
    throw equityError("fxAccountMissing");
  }
  return accounts.fxRealizedGainLoss;
}

/** The policy version in force on `on` for the legal entity; none refuses with the remedy. */
export async function resolveAccountPolicy(
  runner: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
  on: string,
): Promise<EquityAccountPolicy> {
  const row = (
    await runner.execute<{
      id: string;
      effective_from: string;
      common_stock_account_id: string;
      preferred_stock_account_id: string;
      apic_account_id: string;
      apic_share_based_account_id: string;
      compensation_expense_account_id: string;
      treasury_stock_account_id: string;
      convertible_instruments_account_id: string;
      interest_expense_account_id: string | null;
      accrued_interest_account_id: string | null;
      early_exercise_deposit_account_id: string | null;
    }>(
      sql`
    select id, effective_from::text as effective_from, common_stock_account_id, preferred_stock_account_id, apic_account_id,
           apic_share_based_account_id, compensation_expense_account_id, treasury_stock_account_id, convertible_instruments_account_id,
           interest_expense_account_id, accrued_interest_account_id, early_exercise_deposit_account_id
      from equity_account_policies
     where org_id = ${orgId} and subsidiary_id = ${subsidiaryId} and effective_from <= ${on}::date
     order by effective_from desc
     limit 1`,
      "objects",
    )
  )[0];
  if (!row) {
    throw equityError("accountPolicyMissing", { date: fig.date(on) });
  }
  return {
    id: row.id,
    effectiveFrom: row.effective_from,
    commonStockAccountId: row.common_stock_account_id,
    preferredStockAccountId: row.preferred_stock_account_id,
    apicAccountId: row.apic_account_id,
    apicShareBasedAccountId: row.apic_share_based_account_id,
    compensationExpenseAccountId: row.compensation_expense_account_id,
    treasuryStockAccountId: row.treasury_stock_account_id,
    convertibleInstrumentsAccountId: row.convertible_instruments_account_id,
    interestExpenseAccountId: row.interest_expense_account_id,
    accruedInterestAccountId: row.accrued_interest_account_id,
    earlyExerciseDepositAccountId: row.early_exercise_deposit_account_id,
  };
}

/** Whether an account is classified as equity (an equity-classified convertible is never remeasured for exchange rates). */
export async function isEquityAccount(
  runner: SqlExecutor,
  orgId: string,
  accountId: string,
): Promise<boolean> {
  const row = (
    await runner.execute<{ type: string }>(
      sql`select type from accounts where org_id = ${orgId} and id = ${accountId}`,
      "objects",
    )
  )[0];
  return row?.type === "equity";
}

/** Accounts a consideration (cash received or paid) may settle through: cash and bank accounts. */
export const CONSIDERATION_ACCOUNT_TYPES = ["asset_bank"] as const;

/** A consideration account must be an active posting cash or bank account of the organization. */
export async function requireConsiderationAccount(
  runner: SqlExecutor,
  orgId: string,
  accountId: string | null | undefined,
): Promise<string> {
  if (!accountId) {
    throw equityError(
      "considerationAccountMissing",
      { field: fig.term("considerationAccount") },
      { field: "considerationAccountId" },
    );
  }
  const row = (
    await runner.execute<{ type: string; is_active: boolean; is_summary: boolean }>(
      sql`
    select type, is_active, is_summary from accounts where org_id = ${orgId} and id = ${accountId}`,
      "objects",
    )
  )[0];
  if (
    !row ||
    !row.is_active ||
    row.is_summary ||
    !(CONSIDERATION_ACCOUNT_TYPES as readonly string[]).includes(row.type)
  ) {
    throw equityError(
      "considerationAccountInvalid",
      { field: fig.term("considerationAccount") },
      { field: "considerationAccountId" },
    );
  }
  return accountId;
}

export interface EquityLeg {
  accountId: string;
  /** Signed functional-currency ledger units: positive debits, negative credits. */
  units: bigint;
  memo?: string;
  /** A leg stated in another currency: its currency, signed transaction units and rate. */
  foreign?: { currency: string; txnUnits: bigint; fxRate: string };
  /** The instrument balance the leg carries (accrued interest, an early-exercise deposit), read back at settlement. */
  balance?: { securityId: string; role: InstrumentBalanceRole };
}

/** Instrument balances the ledger carries per security, identified on their journal lines. */
export type InstrumentBalanceRole = "interest" | "deposit";

export interface InstrumentBalanceGroup {
  accountId: string;
  currency: string;
  fxRate: string;
  /** Signed functional and transaction ledger units. */
  units: bigint;
  txnUnits: bigint;
}

/**
 * The balance a security carries on the ledger in one role, grouped by
 * account, currency and rate: every posted equity line identified with the
 * security and role, reversals included, so a settlement relieves exactly
 * what was accrued, on the accounts it sits on. A line names its security
 * on the line itself; a recorded attribution correction (see
 * equity_instrument_line_attributions) names it instead when the line's own
 * identity does not resolve in this organization. With `asOf`, only entries
 * posted on or before that date count: the balance as the ledger stood then.
 */
export async function instrumentBalance(
  runner: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
  securityId: string,
  role: InstrumentBalanceRole,
  asOf?: string | null,
): Promise<InstrumentBalanceGroup[]> {
  const rows = await runner.execute<{
    account_id: string;
    currency: string;
    fx_rate: string;
    amount: string;
    txn_amount: string;
  }>(
    sql`
    with entries as materialized (
      select id from journal_entries
       where org_id = ${orgId} and subsidiary_id = ${subsidiaryId} and origin = ${EQUITY_JOURNAL_ORIGIN} and status in ('posted', 'reversed')
         ${asOf ? sql`and posting_date <= ${asOf}::date` : sql``}
    )
    select l.account_id, l.currency, l.fx_rate::text as fx_rate, sum(l.amount)::text as amount, sum(l.txn_amount)::text as txn_amount
      from entries e
      join journal_lines l on l.org_id = ${orgId} and l.entry_id = e.id
      left join equity_instrument_line_attributions a on a.org_id = l.org_id and a.journal_line_id = l.id
     where coalesce(a.security_id::text, l.custom->>'equitySecurityId') = ${securityId}
       and coalesce(a.role, l.custom->>'equityRole') = ${role}
     group by l.account_id, l.currency, l.fx_rate
     order by l.account_id, l.currency, l.fx_rate`,
    "objects",
  );
  return rows
    .map((row) => ({
      accountId: row.account_id,
      currency: row.currency,
      fxRate: row.fx_rate,
      units: toUnits(row.amount),
      txnUnits: toUnits(row.txn_amount),
    }))
    .filter((group) => group.units !== 0n || group.txnUnits !== 0n);
}

/** An accounting period as a refusal names it: its fiscal label and the months it spans. */
async function periodFigure(runner: SqlExecutor, orgId: string, periodId: string) {
  const row = (
    await runner.execute<{
      fiscal_year: number;
      period_number: number;
      is_adjustment: boolean;
      starts_on: string;
      ends_on: string;
    }>(
      sql`
    select fiscal_year, period_number, is_adjustment, starts_on::text as starts_on, ends_on::text as ends_on
      from accounting_periods where org_id = ${orgId} and id = ${periodId}`,
      "objects",
    )
  )[0];
  if (!row) return null;
  return fig.period(
    canonicalPeriodLabel({
      fiscalYear: row.fiscal_year,
      periodNumber: row.period_number,
      adjustment: row.is_adjustment,
    }),
    row.starts_on,
    row.ends_on,
  );
}

/**
 * The period a closed-period refusal locks, and the period whose controlled
 * reopen releases it: the same period, or the closing period of a fiscal
 * year sealed by its period-end journals.
 */
async function closedPeriods(
  runner: SqlExecutor,
  orgId: string,
  coveringPeriodId: string,
  error: unknown,
) {
  const details =
    periodClosedDetailsOf(error) ??
    periodClosedDetailsOf((error as { cause?: unknown } | null)?.cause) ??
    (error instanceof PostingError &&
    error.details &&
    typeof error.details === "object" &&
    (error.details as { kind?: unknown }).kind === "period-closed"
      ? (error.details as PeriodClosedDetails)
      : undefined);
  if (!details) return null;
  const period = await periodFigure(runner, orgId, coveringPeriodId);
  const closing = await periodFigure(runner, orgId, details.periodId);
  return period && closing ? { period, closing } : null;
}

async function refusal(
  runner: SqlExecutor,
  orgId: string,
  periodId: string,
  on: string,
  error: unknown,
): Promise<never> {
  if (error instanceof PostingError || error instanceof CloseError) {
    // The ledger's own refusal is kept whenever its period cannot be read back.
    const closed = await closedPeriods(runner, orgId, periodId, error).catch(() => null);
    if (closed)
      throw equityError(
        "postingPeriodClosed",
        { date: fig.date(on), period: closed.period, closing: closed.closing },
        { cause: error },
      );
    throw equityError(
      "postingRefused",
      { date: fig.date(on), reason: fig.text(error.message) },
      { cause: error },
    );
  }
  throw error;
}

/** The primary book; a posting holds it shared so it cannot be retired underneath, while a probe only reads it. */
async function primaryBook(runner: SqlExecutor, orgId: string, lock = true): Promise<string> {
  const book = (
    await runner.execute<{ id: string }>(
      sql`
    select id from accounting_books where org_id = ${orgId} and is_primary and is_active and posts_gl limit 1 ${lock ? sql`for share` : sql``}`,
      "objects",
    )
  )[0];
  if (!book) {
    throw equityError("bookMissing");
  }
  return book.id;
}

async function coveringPeriod(
  runner: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
  on: string,
): Promise<string> {
  const period = await resolveCoveringPeriod(runner, orgId, on, subsidiaryId);
  if (!period) {
    throw equityError("periodMissing", { date: fig.date(on) });
  }
  return period.id;
}

/**
 * Refuse a dated equity record whose accounting period is closed for the
 * general ledger in the primary book, whether or not it posts an amount: a
 * run records what it measured into its period, so it is dated into an open
 * one, exactly as its entry would be.
 */
export async function assertPostingPeriodOpen(
  runner: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
  on: string,
  run: EquityRunKind,
  options: { lock?: boolean } = {},
): Promise<void> {
  const bookId = await primaryBook(runner, orgId, options.lock !== false);
  const periodId = await coveringPeriod(runner, orgId, subsidiaryId, on);
  try {
    await assertPeriodModulesOpen(runner, {
      orgId,
      periodId,
      bookId,
      subsidiaryIds: [subsidiaryId],
      modules: ["gl"],
    });
  } catch (error) {
    if (error instanceof CloseError) {
      const closed = await closedPeriods(runner, orgId, periodId, error);
      const period = closed?.period ?? (await periodFigure(runner, orgId, periodId))!;
      throw equityError(
        "runPeriodClosed",
        { run: fig.choice(run), date: fig.date(on), period, closing: closed?.closing ?? period },
        { field: "throughDate", cause: error },
      );
    }
    throw error;
  }
}

/**
 * Refuse a periodic run through a date whose accounting period has not yet
 * ended on the organization's business date (the calendar day in its time
 * zone), or that falls in a closed period. A run measures a period once it
 * is over: cost or interest recognized for it later (a backdated grant, an
 * issue recorded after a run) is caught up by the next run, which can only
 * be dated after the last one.
 */
export async function assertRunPeriodPostable(
  runner: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
  throughDate: string,
  run: Exclude<EquityRunKind, "posting">,
  options: { lock?: boolean } = {},
): Promise<void> {
  const period = await resolveCoveringPeriod(runner, orgId, throughDate, subsidiaryId);
  if (!period)
    throw equityError("periodMissing", { date: fig.date(throughDate) }, { field: "throughDate" });
  const today = await businessTodayInTx(runner, orgId);
  if (period.ends_on > today) {
    const label = canonicalPeriodLabel({
      fiscalYear: period.fiscal_year,
      periodNumber: period.period_number,
      adjustment: false,
    });
    throw equityError(
      "runPeriodNotEnded",
      {
        run: fig.choice(run),
        date: fig.date(throughDate),
        period: fig.period(label, period.starts_on, period.ends_on),
        endsOn: fig.date(period.ends_on),
        today: fig.date(today),
      },
      { field: "throughDate" },
    );
  }
  await assertPostingPeriodOpen(runner, orgId, subsidiaryId, throughDate, run, options);
}

/** The refusal a run through the date would raise for its period (not ended, closed or missing), or null when it can post. */
export async function runBlocked(
  orgId: string,
  subsidiaryId: string,
  throughDate: string,
  run: Exclude<EquityRunKind, "posting">,
): Promise<CatalogRefusal | null> {
  try {
    await assertRunPeriodPostable(db, orgId, subsidiaryId, throughDate, run, { lock: false });
    return null;
  } catch (error) {
    if (!(error instanceof EquityError)) throw error;
    return catalogRefusalOf(error);
  }
}

export interface RunPeriodAfter {
  periodId: string;
  /** The period's canonical fiscal label (P03 FY2026). */
  name: string;
  endsOn: string;
  /** Whether the period has ended by the organization's business date, so a run through it can post now. */
  ended: boolean;
}

/**
 * The period the next run after `after` is dated to: the first accounting
 * period of the default calendar ending after it that is open for posting.
 */
export async function nextRunPeriodAfter(
  runner: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
  after: string,
): Promise<RunPeriodAfter | null> {
  const periods = await runner.execute<{
    id: string;
    fiscal_year: number;
    period_number: number;
    ends_on: string;
  }>(
    sql`
    select p.id, p.fiscal_year, p.period_number, p.ends_on::text as ends_on from accounting_periods p
     where p.org_id = ${orgId} and not p.is_adjustment and p.ends_on > ${after}::date
       and p.fiscal_calendar_id in (select id from fiscal_calendars where org_id = ${orgId} and is_default and is_active)
     order by p.ends_on, p.id
     limit 36`,
    "objects",
  );
  const today = await businessTodayInTx(runner, orgId);
  for (const period of periods) {
    if (await postingPeriodOpen(runner, orgId, subsidiaryId, period.ends_on))
      return {
        periodId: period.id,
        name: canonicalPeriodLabel({
          fiscalYear: period.fiscal_year,
          periodNumber: period.period_number,
          adjustment: false,
        }),
        endsOn: period.ends_on,
        ended: period.ends_on <= today,
      };
  }
  return null;
}

/**
 * The fiscal year of the default calendar to generate when no accounting
 * period ends after `after`: the year after the calendar's latest generated
 * period. Null when the calendar has periods after the date (they are closed,
 * so generating more would not help) or there is no default calendar.
 */
export async function runPeriodsToGenerate(
  runner: SqlExecutor,
  orgId: string,
  after: string,
): Promise<{ calendarId: string; fiscalYear: number } | null> {
  const latest = (
    await runner.execute<{ calendar_id: string; fiscal_year: number; ends_on: string }>(
      sql`
    select p.fiscal_calendar_id as calendar_id, p.fiscal_year, p.ends_on::text as ends_on from accounting_periods p
     where p.org_id = ${orgId} and not p.is_adjustment
       and p.fiscal_calendar_id in (select id from fiscal_calendars where org_id = ${orgId} and is_default and is_active)
     order by p.ends_on desc, p.id
     limit 1`,
      "objects",
    )
  )[0];
  if (!latest || latest.ends_on > after) return null;
  return { calendarId: latest.calendar_id, fiscalYear: latest.fiscal_year + 1 };
}

/** Whether the accounting period covering a date is open for general ledger posting in the primary book. */
export async function postingPeriodOpen(
  runner: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
  on: string,
): Promise<boolean> {
  try {
    await assertPostingPeriodOpen(runner, orgId, subsidiaryId, on, "posting", { lock: false });
    return true;
  } catch (error) {
    if (
      error instanceof EquityError &&
      (error.code === "equity_period_closed" || error.code === "equity_period_missing")
    )
      return false;
    throw error;
  }
}

/**
 * Post one balanced equity entry. Zero legs are dropped; an entry whose legs
 * do not balance is a defect in the caller and refuses before the kernel.
 */
export async function postEquityEntry(
  runner: SqlExecutor,
  input: {
    orgId: string;
    subsidiaryId: string;
    currency: string;
    postingDate: string;
    entryNumberBase: string;
    memo: string;
    idempotencyKey: string;
    actorId: string | null;
    auditAction: string;
    auditChanges: Record<string, unknown>;
    legs: readonly EquityLeg[];
  },
): Promise<string> {
  const legs = input.legs.filter((leg) => leg.units !== 0n);
  const balance = legs.reduce((sum, leg) => sum + leg.units, 0n);
  if (legs.length < 2 || balance !== 0n) {
    throw equityError("entryUnbalanced", { date: fig.date(input.postingDate) });
  }
  const bookId = await primaryBook(runner, input.orgId);
  const periodId = await coveringPeriod(runner, input.orgId, input.subsidiaryId, input.postingDate);
  try {
    const posted = await postEntry(runner, {
      orgId: input.orgId,
      bookId,
      subsidiaryId: input.subsidiaryId,
      entryNumber: await nextFreeEntryNumber(runner, input.orgId, input.entryNumberBase),
      postingDate: input.postingDate,
      periodId,
      memo: input.memo,
      origin: EQUITY_JOURNAL_ORIGIN,
      idempotencyKey: input.idempotencyKey,
      currency: input.currency,
      actorId: input.actorId,
      auditAction: input.auditAction,
      auditChanges: input.auditChanges,
      lines: legs.map((leg) => {
        const custom = leg.balance
          ? { custom: { equitySecurityId: leg.balance.securityId, equityRole: leg.balance.role } }
          : {};
        return leg.foreign && leg.foreign.currency !== input.currency
          ? {
              accountId: leg.accountId,
              amount: fromUnits(leg.units),
              currency: leg.foreign.currency,
              txnAmount: fromUnits(leg.foreign.txnUnits),
              fxRate: leg.foreign.fxRate,
              memo: leg.memo ?? input.memo,
              ...custom,
            }
          : {
              accountId: leg.accountId,
              amount: fromUnits(leg.units),
              currency: input.currency,
              memo: leg.memo ?? input.memo,
              ...custom,
            };
      }),
    });
    return posted.entryId;
  } catch (error) {
    return refusal(runner, input.orgId, periodId, input.postingDate, error);
  }
}

/**
 * Reverse a posted equity entry on `reversalDate`: a new entry mirrors every
 * line with the opposite sign and links the original, which is then marked
 * reversed. The original is never edited.
 */
export async function reverseEquityEntry(
  runner: SqlExecutor,
  input: {
    orgId: string;
    entryId: string;
    reversalDate: string;
    memo: string;
    idempotencyKey: string;
    actorId: string | null;
    auditChanges: Record<string, unknown>;
  },
): Promise<string> {
  const header = (
    await runner.execute<{
      subsidiary_id: string;
      entry_number: string;
      origin: string;
      status: string;
    }>(
      sql`
    select subsidiary_id, entry_number, origin, status from journal_entries
     where org_id = ${input.orgId} and id = ${input.entryId}
     for update`,
      "objects",
    )
  )[0];
  if (!header || header.origin !== EQUITY_JOURNAL_ORIGIN) {
    throw equityError("entryUnknown");
  }
  // Live entries only: an entry already reversed cannot be reversed again.
  if (header.status !== "posted") {
    throw equityError("entryNotPosted", { entry: fig.text(header.entry_number) });
  }
  const lines = await runner.execute<{
    account_id: string;
    amount: string;
    currency: string;
    txn_amount: string;
    fx_rate: string;
    line_number: number;
    custom: Record<string, unknown> | null;
  }>(
    sql`
    select account_id, amount::text as amount, currency, txn_amount::text as txn_amount, fx_rate::text as fx_rate, line_number, custom
      from journal_lines where org_id = ${input.orgId} and entry_id = ${input.entryId}
     order by line_number`,
    "objects",
  );
  const bookId = await primaryBook(runner, input.orgId);
  const periodId = await coveringPeriod(
    runner,
    input.orgId,
    header.subsidiary_id,
    input.reversalDate,
  );
  try {
    const posted = await postEntry(runner, {
      orgId: input.orgId,
      bookId,
      subsidiaryId: header.subsidiary_id,
      entryNumber: await nextFreeEntryNumber(runner, input.orgId, `${header.entry_number}-REV`),
      postingDate: input.reversalDate,
      periodId,
      memo: input.memo,
      origin: EQUITY_JOURNAL_ORIGIN,
      reversesEntryId: input.entryId,
      idempotencyKey: input.idempotencyKey,
      actorId: input.actorId,
      auditAction: "equity.reverse",
      auditChanges: input.auditChanges,
      lines: lines.map((line) => ({
        accountId: line.account_id,
        amount: negate(line.amount),
        currency: line.currency,
        txnAmount: negate(line.txn_amount),
        fxRate: line.fx_rate,
        memo: input.memo,
        // Instrument balances follow their reversal, so the security's ledger balance nets.
        ...(line.custom && typeof line.custom.equitySecurityId === "string"
          ? {
              custom: {
                equitySecurityId: line.custom.equitySecurityId,
                equityRole: line.custom.equityRole,
              },
            }
          : {}),
      })),
    });
    await markEntryReversed(runner, {
      orgId: input.orgId,
      entryId: input.entryId,
      actorId: input.actorId,
    });
    return posted.entryId;
  } catch (error) {
    return refusal(runner, input.orgId, periodId, input.reversalDate, error);
  }
}

function negate(amount: string): string {
  return amount.startsWith("-")
    ? amount.slice(1)
    : amount === "0" || /^0(\.0+)?$/.test(amount)
      ? amount
      : `-${amount}`;
}
