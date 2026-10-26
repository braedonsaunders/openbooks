/**
 * The convertible note interest run of a legal entity through a date.
 *
 * For every note the run measures the interest accrued from its issue date
 * through the date on its own day count and compounding (see interest.ts),
 * rounded to the note currency's minor unit, and posts the change since
 * everything already accrued for it by earlier runs and by its settlements:
 * Dr interest expense / Cr accrued interest, under the equity account policy
 * in force on the run date. A note that converted, was repaid or cancelled
 * stops accruing on that date (its settlement accrued the remainder); a
 * voided note's accruals are reversed line for line. A note in a foreign
 * currency accrues at the run date's spot rate and carries its foreign
 * amount on the accrued interest line, so settlement and revaluation see it.
 *
 * Runs are sequential per legal entity: each run's date follows the last
 * one, and a run for a date already run returns that run instead of posting
 * again. A run is dated into an open accounting period and accrues a
 * change: a date with nothing due, or a closed period, refuses. Posting a
 * run is a governed action an Equity action Flow may require approval for.
 */
import { sql } from "drizzle-orm";
import { toUnits } from "../money/money.ts";
import type { CatalogRefusal } from "../platform/catalog-refusal.ts";
import { db, withOrgTransaction } from "../platform/db.ts";
import { convertibleState } from "./cap-table.ts";
import type { GovernedRunResult } from "./compensation-run.ts";
import { EquityError, equityError, fig } from "./errors.ts";
import { governEquityAction } from "./governance.ts";
import { functionalUnits, spotRate } from "./fx.ts";
import { noteInterest } from "./interest.ts";
import {
  assertEquityReadable,
  currencyExponent,
  loadLegalEntity,
  requireEquityReader,
  writeEquityAudit,
} from "./internal.ts";
import {
  assertRunPeriodPostable,
  instrumentBalance,
  nextRunPeriodAfter,
  postEquityEntry,
  requirePolicyAccount,
  resolveAccountPolicy,
  runBlocked,
  runPeriodsToGenerate,
  type EquityLeg,
  type RunPeriodAfter,
} from "./posting.ts";
import { ledgerUnits } from "./quantities.ts";
import { formatLedger, newEquityId } from "./securities.ts";
import { loadEquityBook } from "./store.ts";
import { inEquityCommand, requireDate, type EquityCommand } from "./structure.ts";
import type { EquityBook } from "./types.ts";

export interface InterestLine {
  securityId: string;
  securityNumber: string;
  holderPartyId: string;
  currency: string;
  /** Interest accrued through the run date, in the note's currency. */
  cumulative: string;
  previous: string;
  period: string;
  /** The spot rate applied (null when the line reverses a voided note's accruals). */
  fxRate: string | null;
  /** The period in the functional currency. */
  functional: string;
}

export interface InterestPreview {
  subsidiaryId: string;
  throughDate: string;
  currency: string;
  lastRunThrough: string | null;
  total: string;
  lines: InterestLine[];
  /** Whether a run through the date would accrue anything. */
  due: boolean;
  /** Why the run cannot be posted through the date yet (its period has not ended, or is closed). */
  blocked: CatalogRefusal | null;
}

type MeasuredLine = InterestLine & {
  units: { cumulative: bigint; previous: bigint; period: bigint; functional: bigint };
  legs: EquityLeg[];
};

async function lastRun(
  orgId: string,
  subsidiaryId: string,
  onOrBefore?: string,
): Promise<{ id: string; through_date: string } | undefined> {
  return (
    await db.execute<{ id: string; through_date: string }>(
      sql`
    select id, through_date::text as through_date from equity_interest_runs
     where org_id = ${orgId} and subsidiary_id = ${subsidiaryId}
       ${onOrBefore ? sql`and through_date <= ${onOrBefore}::date` : sql``}
     order by through_date desc limit 1`,
      "objects",
    )
  )[0];
}

/**
 * Interest already accrued per note, in its currency: run lines and
 * settlement accruals, through `through` when given (runs through that
 * date and settlements dated on or before it).
 */
async function accrued(
  orgId: string,
  subsidiaryId: string,
  through?: string,
): Promise<Map<string, bigint>> {
  const rows = await db.execute<{ security_id: string; amount: string }>(
    sql`
    select security_id, sum(amount)::text as amount from (
      select l.security_id, l.period_amount as amount from equity_interest_run_lines l
        join equity_interest_runs r on r.org_id = l.org_id and r.id = l.run_id
       where l.org_id = ${orgId} and l.subsidiary_id = ${subsidiaryId}
         ${through ? sql`and r.through_date <= ${through}::date` : sql``}
      union all
      select e.security_id, e.interest_accrued_amount from equity_security_events e
       where e.org_id = ${orgId} and e.subsidiary_id = ${subsidiaryId} and e.interest_accrued_amount is not null
         ${through ? sql`and e.effective_on <= ${through}::date` : sql``}
         and not exists (select 1 from equity_security_events r where r.org_id = e.org_id and r.kind = 'reverse' and r.reverses_event_id = e.id)
         and not exists (select 1 from equity_security_events v where v.org_id = e.org_id and v.kind = 'void' and v.security_id = e.resulting_security_id)
    ) accruals group by security_id`,
    "objects",
  );
  return new Map(rows.map((row) => [row.security_id, toUnits(row.amount)]));
}

async function measure(
  orgId: string,
  subsidiaryId: string,
  book: EquityBook,
  throughDate: string,
  functional: string,
  accounts: { expense: () => string; accrued: () => string } | null,
  previous: ReadonlyMap<string, bigint>,
): Promise<{ lines: MeasuredLine[]; total: bigint }> {
  const lines: MeasuredLine[] = [];
  let total = 0n;
  for (const note of book.securities) {
    if (note.kind !== "note" || note.issueDate > throughDate) continue;
    const state = convertibleState(book, note, throughDate);
    const exponent = await currencyExponent(db, note.currency);
    const target =
      state.status === "void"
        ? 0n
        : ledgerUnits(noteInterest(state.terms, state.endedOn ?? throughDate), exponent);
    const before = previous.get(note.id) ?? 0n;
    const period = target - before;
    if (period === 0n) continue;
    let fxRate: string | null = null;
    let functionalPeriod: bigint;
    const legs: EquityLeg[] = [];
    if (period > 0n) {
      fxRate = await spotRate(db, orgId, note.currency, functional, throughDate, functional);
      functionalPeriod = functionalUnits(period, fxRate);
      if (accounts) {
        legs.push(
          { accountId: accounts.expense(), units: functionalPeriod },
          {
            accountId: accounts.accrued(),
            units: -functionalPeriod,
            balance: { securityId: note.id, role: "interest" },
            foreign: { currency: note.currency, txnUnits: -period, fxRate },
          },
        );
      }
    } else if (target === 0n) {
      // A voided note: reverse its accrued interest exactly as it sits on the ledger.
      const groups = await instrumentBalance(db, orgId, subsidiaryId, note.id, "interest");
      functionalPeriod = groups.reduce((sum, group) => sum + group.units, 0n);
      if (accounts) {
        for (const group of groups) {
          legs.push({
            accountId: group.accountId,
            units: -group.units,
            balance: { securityId: note.id, role: "interest" },
            foreign: { currency: group.currency, txnUnits: -group.txnUnits, fxRate: group.fxRate },
          });
        }
        legs.push({ accountId: accounts.expense(), units: functionalPeriod });
      }
    } else {
      throw equityError("interestBelowAccrued", {
        security: fig.text(note.securityNumber),
        date: fig.date(throughDate),
      });
    }
    total += functionalPeriod;
    lines.push({
      securityId: note.id,
      securityNumber: note.securityNumber,
      holderPartyId: note.holderPartyId,
      currency: note.currency,
      cumulative: formatLedger(target),
      previous: formatLedger(before),
      period: formatLedger(period),
      fxRate,
      functional: formatLedger(functionalPeriod),
      units: { cumulative: target, previous: before, period, functional: functionalPeriod },
      legs,
    });
  }
  return { lines, total };
}

/** A run dated before the latest posted run refuses: earlier periods are already accrued. */
function backdated(
  last: { through_date: string } | undefined,
  throughDate: string,
): EquityError | null {
  if (!last || throughDate >= last.through_date) return null;
  return equityError(
    "interestRunBackdated",
    { last: fig.date(last.through_date) },
    { field: "throughDate" },
  );
}

/**
 * What an interest run through the date would accrue, without posting it
 * (equity.read). A date before the latest posted run refuses as the run
 * itself would.
 */
export async function previewInterestRun(input: {
  orgId: string;
  actorId: string;
  subsidiaryId: string;
  throughDate: string;
}): Promise<InterestPreview> {
  const throughDate = requireDate(input.throughDate, "throughDate", "runDate");
  await assertEquityReadable(input.orgId);
  return withOrgTransaction(
    input.orgId,
    async () => {
      await requireEquityReader(db, input.orgId, input.actorId, input.subsidiaryId);
      const entity = await loadLegalEntity(db, input.orgId, input.subsidiaryId);
      const book = await loadEquityBook(db, input.orgId, input.subsidiaryId);
      const last = await lastRun(input.orgId, input.subsidiaryId);
      const refusal = backdated(last, throughDate);
      if (refusal) throw refusal;
      const { lines, total } = await measure(
        input.orgId,
        input.subsidiaryId,
        book,
        throughDate,
        entity.currency,
        null,
        await accrued(input.orgId, input.subsidiaryId),
      );
      return {
        subsidiaryId: input.subsidiaryId,
        throughDate,
        currency: entity.currency,
        lastRunThrough: last?.through_date ?? null,
        total: formatLedger(total),
        lines: lines.map(({ units: _units, legs: _legs, ...line }) => line),
        due: last?.through_date !== throughDate && lines.length > 0,
        blocked:
          last?.through_date === throughDate
            ? null
            : await runBlocked(input.orgId, input.subsidiaryId, throughDate, "interest"),
      };
    },
    { isolationLevel: "REPEATABLE READ", readOnly: true },
  );
}

/**
 * The change a note interest run through each date would accrue, in the
 * functional currency, measured exactly as the run measures it against the
 * accruals recorded through that date. A date the runs have already reached
 * has nothing due. It reads within the caller's organization transaction
 * and checks no actor, for the close checklist, the equity overview and the
 * runs view. A missing exchange rate refuses as the run itself would.
 */
export async function interestRunChanges(
  orgId: string,
  subsidiaryId: string,
  throughDates: readonly string[],
): Promise<
  {
    throughDate: string;
    lastRunThrough: string | null;
    total: string;
    lines: number;
    currency: string;
  }[]
> {
  return withOrgTransaction(orgId, async () => {
    const entity = await loadLegalEntity(db, orgId, subsidiaryId);
    const last = await lastRun(orgId, subsidiaryId);
    const out: {
      throughDate: string;
      lastRunThrough: string | null;
      total: string;
      lines: number;
      currency: string;
    }[] = [];
    let book: EquityBook | null = null;
    for (const throughDate of throughDates) {
      if (last && last.through_date >= throughDate) {
        out.push({
          throughDate,
          lastRunThrough: last.through_date,
          total: "0.0000",
          lines: 0,
          currency: entity.currency,
        });
        continue;
      }
      book ??= await loadEquityBook(db, orgId, subsidiaryId);
      const { lines, total } = await measure(
        orgId,
        subsidiaryId,
        book,
        throughDate,
        entity.currency,
        null,
        await accrued(orgId, subsidiaryId, throughDate),
      );
      out.push({
        throughDate,
        lastRunThrough: last?.through_date ?? null,
        total: formatLedger(total),
        lines: lines.length,
        currency: entity.currency,
      });
    }
    return out;
  });
}

/** The change a note interest run through one date would accrue (see interestRunChanges). */
export async function interestRunChange(
  orgId: string,
  subsidiaryId: string,
  throughDate: string,
): Promise<{ lastRunThrough: string | null; total: string; lines: number; currency: string }> {
  const [change] = await interestRunChanges(orgId, subsidiaryId, [throughDate]);
  return change!;
}

/**
 * Note interest accrued through a posted run that no run has accrued: a
 * note issued, or a settlement recorded, after the run for the periods it
 * measured. The next run, through the end of the period after the last one,
 * accrues it as a catch-up; until then it is due here with its amount. As
 * of a date, it is measured through the latest run on or before that date,
 * so nothing is due for a note before it is issued. Null when there is no
 * run yet or nothing to catch up. A missing exchange rate refuses as the run
 * itself would.
 */
export async function interestCatchUp(
  orgId: string,
  subsidiaryId: string,
  asOf?: string,
): Promise<{
  recognizedThrough: string;
  total: string;
  lines: number;
  currency: string;
  postsWith: RunPeriodAfter | null;
  generatePeriods: { calendarId: string; fiscalYear: number } | null;
} | null> {
  return withOrgTransaction(orgId, async () => {
    const latest = await lastRun(orgId, subsidiaryId);
    const last =
      latest && asOf && asOf < latest.through_date
        ? await lastRun(orgId, subsidiaryId, asOf)
        : latest;
    if (!latest || !last) return null;
    const entity = await loadLegalEntity(db, orgId, subsidiaryId);
    const book = await loadEquityBook(db, orgId, subsidiaryId);
    const { lines, total } = await measure(
      orgId,
      subsidiaryId,
      book,
      last.through_date,
      entity.currency,
      null,
      await accrued(orgId, subsidiaryId, last.through_date),
    );
    if (lines.length === 0) return null;
    const postsWith = await nextRunPeriodAfter(db, orgId, subsidiaryId, latest.through_date);
    return {
      recognizedThrough: last.through_date,
      total: formatLedger(total),
      lines: lines.length,
      currency: entity.currency,
      postsWith,
      generatePeriods: postsWith
        ? null
        : await runPeriodsToGenerate(db, orgId, latest.through_date),
    };
  });
}

export interface InterestRunResult {
  runId: string;
  throughDate: string;
  total: string;
  journalEntryId: string | null;
  lines: number;
  replayed: boolean;
}

/**
 * Post the note interest run through a date (equity.manage; a governed
 * action an Equity action Flow may require approval for).
 */
export async function postInterestRun(
  input: EquityCommand & { subsidiaryId: string; throughDate: string },
): Promise<GovernedRunResult<InterestRunResult>> {
  const throughDate = requireDate(input.throughDate, "throughDate", "runDate");
  // A run already posted for the date is returned as it stands; nothing is submitted again.
  const posted = await withOrgTransaction(
    input.orgId,
    async () =>
      (
        await db.execute<{ id: string }>(
          sql`
    select id from equity_interest_runs
     where org_id = ${input.orgId} and subsidiary_id = ${input.subsidiaryId} and through_date = ${throughDate}::date`,
          "objects",
        )
      ).length > 0,
  );
  if (posted) return { ...(await applyInterestRun(input)), status: "applied", requestId: null };
  // A date whose period has not ended or is closed refuses before anything is submitted for approval.
  await withOrgTransaction(input.orgId, () =>
    assertRunPeriodPostable(db, input.orgId, input.subsidiaryId, throughDate, "interest"),
  );
  const outcome = await governEquityAction(
    {
      orgId: input.orgId,
      actorId: input.actorId,
      subsidiaryId: input.subsidiaryId,
      action: "interest_run",
      subjectId: null,
      subjectLabel: `Note interest through ${throughDate}`,
      effectiveOn: throughDate,
      reason: null,
      summary: {},
      payload: { subsidiaryId: input.subsidiaryId, throughDate },
      idempotencyKey: null,
    },
    (actorId) => applyInterestRun({ ...input, actorId }),
  );
  return outcome.result
    ? { ...outcome.result, status: "applied", requestId: outcome.requestId }
    : { status: "pending_approval", requestId: outcome.requestId, throughDate };
}

/** Apply the note interest run: the command its approval releases. */
export async function applyInterestRun(
  input: EquityCommand & { subsidiaryId: string; throughDate: string },
): Promise<InterestRunResult> {
  const throughDate = requireDate(input.throughDate, "throughDate", "runDate");
  return inEquityCommand(input, "equity.manage", async ({ book, currency, entityName }) => {
    const existing = (
      await db.execute<{
        id: string;
        total_amount: string;
        journal_entry_id: string | null;
        lines: number;
      }>(
        sql`
      select r.id, r.total_amount::text as total_amount, r.journal_entry_id,
             (select count(*)::int from equity_interest_run_lines l where l.org_id = r.org_id and l.run_id = r.id) as lines
        from equity_interest_runs r
       where r.org_id = ${input.orgId} and r.subsidiary_id = ${input.subsidiaryId} and r.through_date = ${throughDate}::date`,
        "objects",
      )
    )[0];
    if (existing) {
      return {
        runId: existing.id,
        throughDate,
        total: existing.total_amount,
        journalEntryId: existing.journal_entry_id,
        lines: existing.lines,
        replayed: true,
      };
    }
    const last = await lastRun(input.orgId, input.subsidiaryId);
    const refusal = backdated(last, throughDate);
    if (refusal) throw refusal;
    await assertRunPeriodPostable(db, input.orgId, input.subsidiaryId, throughDate, "interest");
    const previous = await accrued(input.orgId, input.subsidiaryId);
    const probe = await measure(
      input.orgId,
      input.subsidiaryId,
      book,
      throughDate,
      currency,
      null,
      previous,
    );
    if (probe.lines.length === 0) {
      throw last
        ? equityError(
            "interestNothingDueSince",
            { date: fig.date(throughDate), last: fig.date(last.through_date) },
            { field: "throughDate" },
          )
        : equityError(
            "interestNothingDue",
            { date: fig.date(throughDate) },
            { field: "throughDate" },
          );
    }
    const policy = await resolveAccountPolicy(db, input.orgId, input.subsidiaryId, throughDate);
    const accounts = {
      expense: () => requirePolicyAccount(policy, "interestExpenseAccountId"),
      accrued: () => requirePolicyAccount(policy, "accruedInterestAccountId"),
    };
    const { lines, total } = await measure(
      input.orgId,
      input.subsidiaryId,
      book,
      throughDate,
      currency,
      accounts,
      previous,
    );
    const runId = await newEquityId(db);
    let journalEntryId: string | null = null;
    const legs = lines.flatMap((line) => line.legs);
    if (legs.some((leg) => leg.units !== 0n)) {
      journalEntryId = await postEquityEntry(db, {
        orgId: input.orgId,
        subsidiaryId: input.subsidiaryId,
        currency,
        postingDate: throughDate,
        entryNumberBase: `EQ-INT-${throughDate}`,
        memo: `Convertible note interest through ${throughDate} (${entityName})`,
        idempotencyKey: `equity:interest-run:${input.subsidiaryId}:${throughDate}`,
        actorId: input.actorId,
        auditAction: "equity.interest",
        auditChanges: { runId, throughDate },
        legs,
      });
    }
    const inserted = await db.execute<{ id: string }>(
      sql`
      insert into equity_interest_runs (id, org_id, subsidiary_id, through_date, currency, total_amount, journal_entry_id, created_by)
      values (${runId}, ${input.orgId}, ${input.subsidiaryId}, ${throughDate}::date, ${currency}, ${formatLedger(total)}::numeric, ${journalEntryId}, ${input.actorId})
      returning id`,
      "objects",
    );
    if (inserted.length !== 1) throw equityError("notSaved", { record: fig.choice("interestRun") });
    if (lines.length > 0) {
      const values = lines.map(
        (
          line,
        ) => sql`(${input.orgId}, ${input.subsidiaryId}, ${runId}, ${line.securityId}, ${line.currency},
        ${line.cumulative}::numeric, ${line.previous}::numeric, ${line.period}::numeric, ${line.fxRate}::numeric, ${line.functional}::numeric)`,
      );
      const written = await db.execute<{ id: string }>(
        sql`
        insert into equity_interest_run_lines (org_id, subsidiary_id, run_id, security_id, currency, cumulative_amount, previous_amount, period_amount, fx_rate, functional_amount)
        values ${sql.join(values, sql`, `)}
        returning id`,
        "objects",
      );
      if (written.length !== lines.length) {
        throw equityError("notStoredCompletely", { record: fig.choice("interestLines") });
      }
    }
    await writeEquityAudit(db, {
      orgId: input.orgId,
      table: "equity_interest_runs",
      rowId: runId,
      action: "equity.interest.run",
      actorId: input.actorId,
      changes: {
        before: { lastRunThrough: last?.through_date ?? null },
        after: { throughDate, total: formatLedger(total), lines: lines.length, journalEntryId },
      },
    });
    return {
      runId,
      throughDate,
      total: formatLedger(total),
      journalEntryId,
      lines: lines.length,
      replayed: false,
    };
  });
}

export interface InterestRunRow {
  id: string;
  throughDate: string;
  total: string;
  currency: string;
  journalEntryId: string | null;
  entryNumber: string | null;
}

/** Posted interest runs of a legal entity, latest first. */
export async function listInterestRuns(input: {
  orgId: string;
  actorId: string;
  subsidiaryId: string;
}): Promise<InterestRunRow[]> {
  await assertEquityReadable(input.orgId);
  return withOrgTransaction(
    input.orgId,
    async () => {
      await requireEquityReader(db, input.orgId, input.actorId, input.subsidiaryId);
      const rows = await db.execute<{
        id: string;
        through_date: string;
        total_amount: string;
        currency: string;
        journal_entry_id: string | null;
        entry_number: string | null;
      }>(
        sql`
      select r.id, r.through_date::text as through_date, r.total_amount::text as total_amount, r.currency, r.journal_entry_id, je.entry_number
        from equity_interest_runs r
        left join journal_entries je on je.org_id = r.org_id and je.id = r.journal_entry_id
       where r.org_id = ${input.orgId} and r.subsidiary_id = ${input.subsidiaryId}
       order by r.through_date desc`,
        "objects",
      );
      return rows.map((row) => ({
        id: row.id,
        throughDate: row.through_date,
        total: row.total_amount,
        currency: row.currency,
        journalEntryId: row.journal_entry_id,
        entryNumber: row.entry_number,
      }));
    },
    { isolationLevel: "REPEATABLE READ", readOnly: true },
  );
}
