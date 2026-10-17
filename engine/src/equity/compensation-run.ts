/**
 * The stock compensation run of a legal entity through a date.
 *
 * For every option and RSU award the run measures the cumulative cost
 * recognized through the date (see compensation.ts), rounded to the
 * currency's minor unit, and posts the change since the award's previous
 * run line: Dr stock compensation expense / Cr paid-in capital
 * (share-based), or the reverse when forfeitures and voids reduce the
 * cumulative cost. Runs are sequential per legal entity: each run's date
 * follows the last one, and a run for a date already run returns that run
 * instead of posting again. A run with no change records a zero total and
 * posts nothing. Posting a run is an approval (equity.approve).
 */
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { cumulativeCompensation, isCompensatory } from "./compensation.ts";
import { EquityError } from "./errors.ts";
import { assertEquityReadable, currencyExponent, loadLegalEntity, requireEquityReader, writeEquityAudit } from "./internal.ts";
import { postEquityEntry, resolveAccountPolicy } from "./posting.ts";
import { ledgerUnits } from "./quantities.ts";
import { formatLedger, newEquityId } from "./securities.ts";
import { loadEquityBook } from "./store.ts";
import { inEquityCommand, requireDate, type EquityCommand } from "./structure.ts";
import type { EquityBook } from "./types.ts";
import { toUnits } from "../money/money.ts";

export interface CompensationLine {
  securityId: string;
  securityNumber: string;
  holderPartyId: string;
  kind: "option" | "rsu";
  cumulative: string;
  previous: string;
  period: string;
}

export interface CompensationPreview {
  subsidiaryId: string;
  throughDate: string;
  currency: string;
  lastRunThrough: string | null;
  total: string;
  lines: CompensationLine[];
}

type PreviousLine = {
  security_id: string;
  cumulative_amount: string;
};

async function lastRun(orgId: string, subsidiaryId: string): Promise<{ id: string; through_date: string } | undefined> {
  return (await db.execute<{ id: string; through_date: string }>(sql`
    select id, through_date::text as through_date from equity_compensation_runs
     where org_id = ${orgId} and subsidiary_id = ${subsidiaryId}
     order by through_date desc limit 1`)).rows[0];
}

/** The latest recorded cumulative cost of every award with run history. */
async function previousCumulative(orgId: string, subsidiaryId: string): Promise<Map<string, bigint>> {
  const rows = (await db.execute<PreviousLine>(sql`
    select distinct on (l.security_id) l.security_id, l.cumulative_amount::text as cumulative_amount
      from equity_compensation_run_lines l
      join equity_compensation_runs r on r.org_id = l.org_id and r.id = l.run_id
     where l.org_id = ${orgId} and l.subsidiary_id = ${subsidiaryId}
     order by l.security_id, r.through_date desc`)).rows;
  return new Map(rows.map((row) => [row.security_id, toUnits(row.cumulative_amount)]));
}

function measure(book: EquityBook, throughDate: string, exponent: number, previous: ReadonlyMap<string, bigint>): { lines: (CompensationLine & { units: { cumulative: bigint; previous: bigint; period: bigint } })[]; total: bigint } {
  const lines: (CompensationLine & { units: { cumulative: bigint; previous: bigint; period: bigint } })[] = [];
  let total = 0n;
  for (const security of book.securities) {
    if (!isCompensatory(security) || security.issueDate > throughDate) continue;
    const cumulative = ledgerUnits(cumulativeCompensation(book, security, throughDate), exponent);
    const before = previous.get(security.id) ?? 0n;
    const period = cumulative - before;
    if (cumulative === 0n && before === 0n) continue;
    total += period;
    lines.push({
      securityId: security.id, securityNumber: security.securityNumber, holderPartyId: security.holderPartyId, kind: security.kind as "option" | "rsu",
      cumulative: formatLedger(cumulative), previous: formatLedger(before), period: formatLedger(period),
      units: { cumulative, previous: before, period },
    });
  }
  return { lines, total };
}

/** What a run through the date would post, without posting it (equity.read). */
export async function previewCompensationRun(input: { orgId: string; actorId: string; subsidiaryId: string; throughDate: string }): Promise<CompensationPreview> {
  const throughDate = requireDate(input.throughDate, "throughDate", "The run date");
  await assertEquityReadable(input.orgId);
  return withOrgTransaction(input.orgId, async () => {
    await requireEquityReader(db, input.orgId, input.actorId, input.subsidiaryId);
    const entity = await loadLegalEntity(db, input.orgId, input.subsidiaryId);
    const exponent = await currencyExponent(db, entity.currency);
    const book = await loadEquityBook(db, input.orgId, input.subsidiaryId);
    const last = await lastRun(input.orgId, input.subsidiaryId);
    const { lines, total } = measure(book, throughDate, exponent, await previousCumulative(input.orgId, input.subsidiaryId));
    return {
      subsidiaryId: input.subsidiaryId, throughDate, currency: entity.currency, lastRunThrough: last?.through_date ?? null,
      total: formatLedger(total), lines: lines.map(({ units: _units, ...line }) => line),
    };
  }, { isolationLevel: "REPEATABLE READ", readOnly: true });
}

export interface CompensationRunResult {
  runId: string;
  throughDate: string;
  total: string;
  journalEntryId: string | null;
  lines: number;
  replayed: boolean;
}

/** Post the stock compensation run through a date (equity.approve). */
export async function postCompensationRun(input: EquityCommand & { subsidiaryId: string; throughDate: string }): Promise<CompensationRunResult> {
  const throughDate = requireDate(input.throughDate, "throughDate", "The run date");
  return inEquityCommand(input, "equity.approve", async ({ book, currency, entityName }) => {
    const existing = (await db.execute<{ id: string; total_amount: string; journal_entry_id: string | null; lines: number }>(sql`
      select r.id, r.total_amount::text as total_amount, r.journal_entry_id,
             (select count(*)::int from equity_compensation_run_lines l where l.org_id = r.org_id and l.run_id = r.id) as lines
        from equity_compensation_runs r
       where r.org_id = ${input.orgId} and r.subsidiary_id = ${input.subsidiaryId} and r.through_date = ${throughDate}::date`)).rows[0];
    if (existing) {
      return { runId: existing.id, throughDate, total: existing.total_amount, journalEntryId: existing.journal_entry_id, lines: existing.lines, replayed: true };
    }
    const last = await lastRun(input.orgId, input.subsidiaryId);
    if (last && throughDate < last.through_date) {
      throw new EquityError(`A stock compensation run through ${last.through_date} is already posted.`, {
        status: 409,
        code: "equity_compensation_run_backdated",
        remedy: `Run through a date after ${last.through_date}; earlier periods are already measured.`,
        field: "throughDate",
      });
    }
    const exponent = await currencyExponent(db, currency);
    const { lines, total } = measure(book, throughDate, exponent, await previousCumulative(input.orgId, input.subsidiaryId));
    const runId = await newEquityId(db);
    let journalEntryId: string | null = null;
    if (total !== 0n) {
      const policy = await resolveAccountPolicy(db, input.orgId, input.subsidiaryId, throughDate);
      journalEntryId = await postEquityEntry(db, {
        orgId: input.orgId, subsidiaryId: input.subsidiaryId, currency, postingDate: throughDate,
        entryNumberBase: `EQ-SBC-${throughDate}`, memo: `Stock compensation through ${throughDate} (${entityName})`,
        idempotencyKey: `equity:compensation-run:${input.subsidiaryId}:${throughDate}`, actorId: input.actorId,
        auditAction: "equity.compensation", auditChanges: { runId, throughDate },
        legs: [
          { accountId: policy.compensationExpenseAccountId, units: total },
          { accountId: policy.apicShareBasedAccountId, units: -total },
        ],
      });
    }
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into equity_compensation_runs (id, org_id, subsidiary_id, through_date, currency, total_amount, journal_entry_id, created_by)
      values (${runId}, ${input.orgId}, ${input.subsidiaryId}, ${throughDate}::date, ${currency}, ${formatLedger(total)}::numeric, ${journalEntryId}, ${input.actorId})
      returning id`)).rows;
    if (inserted.length !== 1) throw new EquityError("The compensation run was not saved.", { status: 409, code: "equity_write_failed", remedy: "Try again." });
    const recorded = lines.filter((line) => line.units.period !== 0n || line.units.cumulative !== 0n);
    if (recorded.length > 0) {
      const values = recorded.map((line) => sql`(${input.orgId}, ${input.subsidiaryId}, ${runId}, ${line.securityId},
        ${line.cumulative}::numeric, ${line.previous}::numeric, ${line.period}::numeric)`);
      const written = (await db.execute<{ id: string }>(sql`
        insert into equity_compensation_run_lines (org_id, subsidiary_id, run_id, security_id, cumulative_amount, previous_amount, period_amount)
        values ${sql.join(values, sql`, `)}
        returning id`)).rows;
      if (written.length !== recorded.length) {
        throw new EquityError("The compensation run lines were not stored completely; nothing was saved.", { status: 409, code: "equity_write_failed", remedy: "Try again." });
      }
    }
    await writeEquityAudit(db, {
      orgId: input.orgId, table: "equity_compensation_runs", rowId: runId, action: "equity.compensation.run", actorId: input.actorId,
      changes: { before: { lastRunThrough: last?.through_date ?? null }, after: { throughDate, total: formatLedger(total), lines: recorded.length, journalEntryId } },
    });
    return { runId, throughDate, total: formatLedger(total), journalEntryId, lines: recorded.length, replayed: false };
  });
}
