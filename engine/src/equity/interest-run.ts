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
 * again. A run with no change records a zero total and posts nothing.
 * Posting a run is an approval (equity.approve).
 */
import { sql } from "drizzle-orm";
import { toUnits } from "../money/money.ts";
import { db, withOrgTransaction } from "../platform/db.ts";
import { convertibleState } from "./cap-table.ts";
import { EquityError } from "./errors.ts";
import { functionalUnits, spotRate } from "./fx.ts";
import { noteInterest } from "./interest.ts";
import { assertEquityReadable, currencyExponent, loadLegalEntity, requireEquityReader, writeEquityAudit } from "./internal.ts";
import { instrumentBalance, postEquityEntry, requirePolicyAccount, resolveAccountPolicy, type EquityLeg } from "./posting.ts";
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
}

type MeasuredLine = InterestLine & { units: { cumulative: bigint; previous: bigint; period: bigint; functional: bigint }; legs: EquityLeg[] };

async function lastRun(orgId: string, subsidiaryId: string): Promise<{ id: string; through_date: string } | undefined> {
  return (await db.execute<{ id: string; through_date: string }>(sql`
    select id, through_date::text as through_date from equity_interest_runs
     where org_id = ${orgId} and subsidiary_id = ${subsidiaryId}
     order by through_date desc limit 1`)).rows[0];
}

/** Interest already accrued per note, in its currency: earlier run lines and settlement accruals. */
async function accrued(orgId: string, subsidiaryId: string): Promise<Map<string, bigint>> {
  const rows = (await db.execute<{ security_id: string; amount: string }>(sql`
    select security_id, sum(amount)::text as amount from (
      select security_id, period_amount as amount from equity_interest_run_lines where org_id = ${orgId} and subsidiary_id = ${subsidiaryId}
      union all
      select security_id, interest_accrued_amount from equity_security_events
       where org_id = ${orgId} and subsidiary_id = ${subsidiaryId} and interest_accrued_amount is not null
    ) accruals group by security_id`)).rows;
  return new Map(rows.map((row) => [row.security_id, toUnits(row.amount)]));
}

async function measure(
  orgId: string,
  subsidiaryId: string,
  book: EquityBook,
  throughDate: string,
  functional: string,
  accounts: { expense: () => string; accrued: () => string } | null,
): Promise<{ lines: MeasuredLine[]; total: bigint }> {
  const previous = await accrued(orgId, subsidiaryId);
  const lines: MeasuredLine[] = [];
  let total = 0n;
  for (const note of book.securities) {
    if (note.kind !== "note" || note.issueDate > throughDate) continue;
    const state = convertibleState(book, note, throughDate);
    const exponent = await currencyExponent(db, note.currency);
    const target = state.status === "void" ? 0n : ledgerUnits(noteInterest(state.terms, state.endedOn ?? throughDate), exponent);
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
            accountId: accounts.accrued(), units: -functionalPeriod, balance: { securityId: note.id, role: "interest" },
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
            accountId: group.accountId, units: -group.units, balance: { securityId: note.id, role: "interest" },
            foreign: { currency: group.currency, txnUnits: -group.txnUnits, fxRate: group.fxRate },
          });
        }
        legs.push({ accountId: accounts.expense(), units: functionalPeriod });
      }
    } else {
      throw new EquityError(`Interest on ${note.securityNumber} through ${throughDate} is below what is already accrued.`, {
        status: 409,
        code: "equity_interest_unreconciled",
        remedy: "Review the note's interest entries and settlements in the journal; accrued interest only falls when a note is voided.",
      });
    }
    total += functionalPeriod;
    lines.push({
      securityId: note.id, securityNumber: note.securityNumber, holderPartyId: note.holderPartyId, currency: note.currency,
      cumulative: formatLedger(target), previous: formatLedger(before), period: formatLedger(period), fxRate,
      functional: formatLedger(functionalPeriod),
      units: { cumulative: target, previous: before, period, functional: functionalPeriod }, legs,
    });
  }
  return { lines, total };
}

/** What an interest run through the date would accrue, without posting it (equity.read). */
export async function previewInterestRun(input: { orgId: string; actorId: string; subsidiaryId: string; throughDate: string }): Promise<InterestPreview> {
  const throughDate = requireDate(input.throughDate, "throughDate", "The run date");
  await assertEquityReadable(input.orgId);
  return withOrgTransaction(input.orgId, async () => {
    await requireEquityReader(db, input.orgId, input.actorId, input.subsidiaryId);
    const entity = await loadLegalEntity(db, input.orgId, input.subsidiaryId);
    const book = await loadEquityBook(db, input.orgId, input.subsidiaryId);
    const last = await lastRun(input.orgId, input.subsidiaryId);
    const { lines, total } = await measure(input.orgId, input.subsidiaryId, book, throughDate, entity.currency, null);
    return {
      subsidiaryId: input.subsidiaryId, throughDate, currency: entity.currency, lastRunThrough: last?.through_date ?? null,
      total: formatLedger(total), lines: lines.map(({ units: _units, legs: _legs, ...line }) => line),
    };
  }, { isolationLevel: "REPEATABLE READ", readOnly: true });
}

export interface InterestRunResult {
  runId: string;
  throughDate: string;
  total: string;
  journalEntryId: string | null;
  lines: number;
  replayed: boolean;
}

/** Post the note interest run through a date (equity.approve). */
export async function postInterestRun(input: EquityCommand & { subsidiaryId: string; throughDate: string }): Promise<InterestRunResult> {
  const throughDate = requireDate(input.throughDate, "throughDate", "The run date");
  return inEquityCommand(input, "equity.approve", async ({ book, currency, entityName }) => {
    const existing = (await db.execute<{ id: string; total_amount: string; journal_entry_id: string | null; lines: number }>(sql`
      select r.id, r.total_amount::text as total_amount, r.journal_entry_id,
             (select count(*)::int from equity_interest_run_lines l where l.org_id = r.org_id and l.run_id = r.id) as lines
        from equity_interest_runs r
       where r.org_id = ${input.orgId} and r.subsidiary_id = ${input.subsidiaryId} and r.through_date = ${throughDate}::date`)).rows[0];
    if (existing) {
      return { runId: existing.id, throughDate, total: existing.total_amount, journalEntryId: existing.journal_entry_id, lines: existing.lines, replayed: true };
    }
    const last = await lastRun(input.orgId, input.subsidiaryId);
    if (last && throughDate < last.through_date) {
      throw new EquityError(`An interest run through ${last.through_date} is already posted.`, {
        status: 409,
        code: "equity_interest_run_backdated",
        remedy: `Run through a date after ${last.through_date}; earlier periods are already accrued.`,
        field: "throughDate",
      });
    }
    let policy: Awaited<ReturnType<typeof resolveAccountPolicy>> | null = null;
    const resolve = async () => (policy ??= await resolveAccountPolicy(db, input.orgId, input.subsidiaryId, throughDate));
    const probe = await measure(input.orgId, input.subsidiaryId, book, throughDate, currency, null);
    if (probe.lines.length > 0) await resolve();
    const accounts = policy
      ? { expense: () => requirePolicyAccount(policy!, "interestExpenseAccountId"), accrued: () => requirePolicyAccount(policy!, "accruedInterestAccountId") }
      : null;
    const { lines, total } = accounts ? await measure(input.orgId, input.subsidiaryId, book, throughDate, currency, accounts) : probe;
    const runId = await newEquityId(db);
    let journalEntryId: string | null = null;
    const legs = lines.flatMap((line) => line.legs);
    if (legs.some((leg) => leg.units !== 0n)) {
      journalEntryId = await postEquityEntry(db, {
        orgId: input.orgId, subsidiaryId: input.subsidiaryId, currency, postingDate: throughDate,
        entryNumberBase: `EQ-INT-${throughDate}`, memo: `Convertible note interest through ${throughDate} (${entityName})`,
        idempotencyKey: `equity:interest-run:${input.subsidiaryId}:${throughDate}`, actorId: input.actorId,
        auditAction: "equity.interest", auditChanges: { runId, throughDate }, legs,
      });
    }
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into equity_interest_runs (id, org_id, subsidiary_id, through_date, currency, total_amount, journal_entry_id, created_by)
      values (${runId}, ${input.orgId}, ${input.subsidiaryId}, ${throughDate}::date, ${currency}, ${formatLedger(total)}::numeric, ${journalEntryId}, ${input.actorId})
      returning id`)).rows;
    if (inserted.length !== 1) throw new EquityError("The interest run was not saved.", { status: 409, code: "equity_write_failed", remedy: "Try again." });
    if (lines.length > 0) {
      const values = lines.map((line) => sql`(${input.orgId}, ${input.subsidiaryId}, ${runId}, ${line.securityId}, ${line.currency},
        ${line.cumulative}::numeric, ${line.previous}::numeric, ${line.period}::numeric, ${line.fxRate}::numeric, ${line.functional}::numeric)`);
      const written = (await db.execute<{ id: string }>(sql`
        insert into equity_interest_run_lines (org_id, subsidiary_id, run_id, security_id, currency, cumulative_amount, previous_amount, period_amount, fx_rate, functional_amount)
        values ${sql.join(values, sql`, `)}
        returning id`)).rows;
      if (written.length !== lines.length) {
        throw new EquityError("The interest run lines were not stored completely; nothing was saved.", { status: 409, code: "equity_write_failed", remedy: "Try again." });
      }
    }
    await writeEquityAudit(db, {
      orgId: input.orgId, table: "equity_interest_runs", rowId: runId, action: "equity.interest.run", actorId: input.actorId,
      changes: { before: { lastRunThrough: last?.through_date ?? null }, after: { throughDate, total: formatLedger(total), lines: lines.length, journalEntryId } },
    });
    return { runId, throughDate, total: formatLedger(total), journalEntryId, lines: lines.length, replayed: false };
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
export async function listInterestRuns(input: { orgId: string; actorId: string; subsidiaryId: string }): Promise<InterestRunRow[]> {
  await assertEquityReadable(input.orgId);
  return withOrgTransaction(input.orgId, async () => {
    await requireEquityReader(db, input.orgId, input.actorId, input.subsidiaryId);
    const rows = (await db.execute<{ id: string; through_date: string; total_amount: string; currency: string; journal_entry_id: string | null; entry_number: string | null }>(sql`
      select r.id, r.through_date::text as through_date, r.total_amount::text as total_amount, r.currency, r.journal_entry_id, je.entry_number
        from equity_interest_runs r
        left join journal_entries je on je.org_id = r.org_id and je.id = r.journal_entry_id
       where r.org_id = ${input.orgId} and r.subsidiary_id = ${input.subsidiaryId}
       order by r.through_date desc`)).rows;
    return rows.map((row) => ({ id: row.id, throughDate: row.through_date, total: row.total_amount, currency: row.currency, journalEntryId: row.journal_entry_id, entryNumber: row.entry_number }));
  }, { isolationLevel: "REPEATABLE READ", readOnly: true });
}
