import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, cmp, isZero, mulRate, neg, sum } from "./money.ts";
import { loadSubsidiaryContext } from "./subsidiaries.ts";

/**
 * Period-end UNREALIZED FX revaluation.
 *
 * Foreign-currency monetary balances (bank/cash, AR, AP) are carried on the
 * ledger at the historical rates they posted at. At period-end their base
 * (functional-currency) value must be restated to the period-end spot rate; the
 * difference is an *unrealized* FX gain/loss. Unlike the realized gain/loss that
 * settlement books (see applications.fx_gain_loss_entry_id), this reverses at the
 * start of the next period so the exposure is re-measured from historical each
 * close rather than compounding.
 *
 * Correctness rules that keep this idempotent and double-count-free:
 *  - The historical carrying value and the foreign-currency balance are measured
 *    EXCLUDING lines whose entry origin is 'revaluation'. A revaluation only
 *    adjusts base carrying (its lines are booked in the functional currency);
 *    it never changes how much foreign currency is held. Excluding it means each
 *    close compares current spot against historical, never against a prior
 *    revaluation.
 *  - A period that already has a revaluation entry is skipped (re-running posts
 *    nothing). Correcting a period is a reopen, not a silent re-post.
 *  - A revaluation never posts without its mirror reversal: when no following
 *    accounting period exists the run reports a problem and posts nothing,
 *    because an unreversed revaluation would permanently book a delta the next
 *    close must be free to re-measure.
 *  - Concurrent runs serialize per (org, book, period, subsidiary) on a
 *    transaction-scoped advisory lock taken before the duplicate check, so the
 *    check-then-insert cannot double-post.
 *  - Every entry balances by construction (monetary deltas offset by one
 *    unrealized-gain/loss line); the kernel's deferred balance trigger is the
 *    final authority.
 */

/** Monetary account types whose foreign balances are revalued. Non-monetary
 *  accounts (fixed assets, equity, income, expense) are carried at historical
 *  rate and never revalued. */
export const MONETARY_ACCOUNT_TYPES = [
  "asset_bank",
  "asset_receivable",
  "liability_payable",
] as const;

/** One foreign-currency monetary exposure for a single legal entity. */
export interface RevaluationPosition {
  accountId: string;
  /** The foreign (transaction) currency, always ≠ the subsidiary functional currency. */
  currency: string;
  /** Base-currency carrying value on the books at historical rates (SUM of line.amount). */
  carryingBase: string;
  /** Foreign-currency balance still on the books (SUM of line.txn_amount). */
  foreignBalance: string;
  /** Period-end spot rate, foreign → functional. */
  periodEndRate: string;
}

export interface RevaluationLine {
  accountId: string;
  /** Signed base-currency amount: positive = debit, negative = credit. */
  amount: string;
}

/**
 * Pure revaluation arithmetic — no database. For each position the base value is
 * restated to `foreignBalance × periodEndRate`; the delta against `carryingBase`
 * adjusts the monetary account, and the sum of all deltas is offset to the single
 * unrealized gain/loss account so the entry balances. Positions whose delta
 * rounds to zero (rate unchanged, or nothing on the books) produce no line —
 * which is what makes a no-op close post nothing.
 */
export function computeRevaluation(
  positions: RevaluationPosition[],
  unrealizedGainLossAccountId: string,
): { lines: RevaluationLine[]; netDelta: string } {
  const monetaryLines: RevaluationLine[] = [];
  let netDelta = "0";
  for (const p of positions) {
    const revalued = mulRate(p.foreignBalance, p.periodEndRate);
    const delta = add(revalued, neg(p.carryingBase));
    if (isZero(delta)) continue;
    monetaryLines.push({ accountId: p.accountId, amount: delta });
    netDelta = add(netDelta, delta);
  }
  if (monetaryLines.length === 0) return { lines: [], netDelta: "0" };
  // Offset: a net debit to monetary accounts (a gain on assets / smaller
  // liability) is credited to the gain/loss account, and vice versa. When the
  // per-account deltas offset EXACTLY (a USD asset against an equal USD
  // liability), the entry already balances and a zero-amount offset line would
  // be rejected by the kernel — omit it.
  return {
    lines: isZero(netDelta)
      ? monetaryLines
      : [...monetaryLines, { accountId: unrealizedGainLossAccountId, amount: neg(netDelta) }],
    netDelta,
  };
}

export interface RevaluationRunResult {
  /** Journal entries posted (period-end adjustment + its next-period reversal), by subsidiary. */
  posted: { subsidiaryId: string; entryId: string; reversalEntryId: string | null; netDelta: string }[];
  skipped: { subsidiaryId: string; reason: string }[];
  problems: string[];
}

export class RevaluationError extends Error {
  readonly name = "RevaluationError";
}

/** The transaction advisory lock that serializes one subsidiary's duplicate
 *  check-and-post for a period. */
export function revaluationLockKey(
  orgId: string,
  bookId: string,
  periodId: string,
  subsidiaryId: string,
): string {
  return `fxreval:${orgId}:${bookId}:${periodId}:${subsidiaryId}`;
}

/** Why a revaluation was refused: with no following period the mandatory
 *  reversal has nowhere to land. Pure, so the wording is pinned in one place. */
export function missingReversalPeriodReason(): string {
  return "no following accounting period exists to reverse into — generate periods and re-run";
}

/** Skip reason for a period that already carries a revaluation entry — shared
 *  by the fast-path check and the authoritative one under the lock so both
 *  report identically. */
const ALREADY_REVALUED = "already revalued for this period";

/** org unrealized-FX gain/loss control account (orgs.settings.controlAccounts.fxUnrealizedGainLoss). */
async function unrealizedAccount(orgId: string): Promise<string> {
  const r = (await db.execute<{ acct: string | null }>(
    sql`select settings->'controlAccounts'->>'fxUnrealizedGainLoss' as acct from orgs where id = ${orgId}`,
  ));
  const acct = r.rows[0]?.acct;
  if (!acct) {
    throw new RevaluationError(
      "unrealized FX gain/loss account is not configured (orgs.settings.controlAccounts.fxUnrealizedGainLoss)",
    );
  }
  return acct;
}

async function primaryBookId(orgId: string): Promise<string> {
  const r = (await db.execute<{ id: string }>(
    sql`select id from accounting_books where org_id = ${orgId} and is_primary = true limit 1`,
  ));
  const id = r.rows[0]?.id;
  if (!id) throw new RevaluationError("primary accounting book is not configured");
  return id;
}

/**
 * Foreign-currency monetary positions for one subsidiary as of `asOfDate`,
 * measured from POSTED, non-revaluation lines only. Positions whose foreign
 * balance is exactly zero (fully settled) are dropped.
 *
 * The monetary-item population (IAS 21.8/16): bank, receivable, and payable
 * account types by default, plus any balance-sheet account explicitly flagged
 * `accounts.monetary = true` (foreign-currency loans, monetary accruals,
 * long-term debt), minus any account flagged `monetary = false` (a
 * default-typed account holding a non-monetary deferral). The true-override is
 * ignored for income/expense/equity types — only balance-sheet items are
 * monetary.
 */
async function loadPositions(
  orgId: string,
  bookId: string,
  subsidiaryId: string,
  functionalCurrency: string,
  asOfDate: string,
): Promise<RevaluationPosition[]> {
  const r = (await db.execute<{ account_id: string; currency: string; carrying_base: string; foreign_balance: string }>(sql`
    select l.account_id                         as account_id,
           l.currency                           as currency,
           sum(l.amount)::text                  as carrying_base,
           sum(l.txn_amount)::text              as foreign_balance
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
     where l.org_id = ${orgId}
       and l.subsidiary_id = ${subsidiaryId}
       and e.book_id = ${bookId}
       and e.status in ('posted', 'reversed')
       and e.origin <> 'fx_revaluation'
       and e.posting_date <= ${asOfDate}
       and l.currency <> ${functionalCurrency}
       and case
             when a.monetary is false then false
             when a.monetary is true then a.type not in
               ('income', 'income_other', 'cogs', 'expense', 'expense_other', 'expense_deferred', 'equity')
             else a.type in ('asset_bank', 'asset_receivable', 'liability_payable')
           end
     group by l.account_id, l.currency
     having sum(l.txn_amount) <> 0`));

  const positions: RevaluationPosition[] = [];
  for (const row of r.rows) {
    const rate = await periodEndRate(orgId, row.currency, functionalCurrency, asOfDate);
    if (!rate) {
      throw new RevaluationError(
        `no spot rate for ${row.currency}→${functionalCurrency} on or before ${asOfDate}`,
      );
    }
    positions.push({
      accountId: row.account_id,
      currency: row.currency,
      carryingBase: row.carrying_base,
      foreignBalance: row.foreign_balance,
      periodEndRate: rate,
    });
  }
  return positions;
}

/** Latest spot rate foreign→functional on or before the date, with the inverse
 *  fallback the posting engine uses. When the direct pair and an inverted quote
 *  share the newest as_of, the DIRECT row wins (priority 0 beats 1) — the same
 *  deterministic rule as labor-costing, so one pair/date always converts alike. */
async function periodEndRate(
  orgId: string,
  from: string,
  to: string,
  asOfDate: string,
): Promise<string | null> {
  const r = (await db.execute<{ rate: string }>(sql`
    select rate::text from (
      select rate, as_of, 0 as priority from fx_rates
       where org_id = ${orgId} and from_currency = ${from} and to_currency = ${to}
         and rate_type = 'spot' and as_of <= ${asOfDate}
      union all
      select (1 / rate)::numeric(19,10) as rate, as_of, 1 as priority from fx_rates
       where org_id = ${orgId} and from_currency = ${to} and to_currency = ${from}
         and rate_type = 'spot' and as_of <= ${asOfDate}
    ) candidates order by as_of desc, priority asc limit 1`));
  return r.rows[0]?.rate ?? null;
}

/**
 * Run period-end unrealized FX revaluation for a period. Posts, per subsidiary
 * with a nonzero delta, a period-end adjustment entry (origin 'revaluation') and
 * a mirror reversing entry on the first day of the next period. Idempotent: a
 * subsidiary that already carries a revaluation entry for the period is skipped.
 * When no following accounting period exists the subsidiary is not revalued at
 * all and a problem is reported — every posted revaluation must carry its
 * reversal.
 */
export async function runRevaluation(
  orgId: string,
  periodId: string,
  actorId: string | null,
  allowedSubsidiaryIds?: string[],
): Promise<RevaluationRunResult> {
  const bookId = await primaryBookId(orgId);
  const gainLossAccount = await unrealizedAccount(orgId);
  const ctx = await loadSubsidiaryContext(db, orgId);

  const periodRes = (await db.execute<{ ends_on: string; name: string; next_starts_on: string | null; next_period_id: string | null }>(sql`
    select p.ends_on as ends_on, p.name as name,
           (select n.starts_on from accounting_periods n
             where n.org_id = ${orgId} and n.starts_on > p.ends_on and n.is_adjustment = false
             order by n.starts_on asc limit 1) as next_starts_on,
           (select n.id from accounting_periods n
             where n.org_id = ${orgId} and n.starts_on > p.ends_on and n.is_adjustment = false
             order by n.starts_on asc limit 1) as next_period_id
      from accounting_periods p
     where p.org_id = ${orgId} and p.id = ${periodId}`));
  const period = periodRes.rows[0];
  if (!period) throw new RevaluationError(`accounting period ${periodId} not found`);
  const asOfDate = period.ends_on;

  const result: RevaluationRunResult = { posted: [], skipped: [], problems: [] };

  const subsidiaryIds = allowedSubsidiaryIds ?? [...ctx.byId.keys()];
  for (const subsidiaryId of subsidiaryIds) {
    const subsidiary = ctx.byId.get(subsidiaryId);
    if (!subsidiary) {
      result.problems.push(`subsidiary ${subsidiaryId} does not exist`);
      continue;
    }

    // Idempotency fast path: never post a second revaluation into an
    // already-revalued period. Advisory only — the authoritative check runs
    // under the advisory lock inside postRevaluationEntry's transaction.
    const existing = (await db.execute(sql`
      select 1 from journal_entries
       where org_id = ${orgId} and period_id = ${periodId} and book_id = ${bookId}
         and subsidiary_id = ${subsidiaryId} and origin = 'fx_revaluation'
         and reverses_entry_id is null limit 1`));
    if (existing.rows.length > 0) {
      result.skipped.push({ subsidiaryId, reason: ALREADY_REVALUED });
      continue;
    }

    // Fail closed: a revaluation whose mirror reversal has no period to land in
    // would make the unrealized gain/loss permanent (later closes re-measure
    // against stale carrying and re-book a delta the books already carry).
    // Refuse rather than post unreversed.
    if (!period.next_period_id || !period.next_starts_on) {
      result.problems.push(`${subsidiary.name}: ${missingReversalPeriodReason()}`);
      continue;
    }

    let positions: RevaluationPosition[];
    try {
      positions = await loadPositions(orgId, bookId, subsidiaryId, subsidiary.baseCurrency, asOfDate);
    } catch (err) {
      result.problems.push(`${subsidiary.name}: ${(err as Error).message}`);
      continue;
    }

    const { lines, netDelta } = computeRevaluation(positions, gainLossAccount);
    if (lines.length === 0) {
      result.skipped.push({ subsidiaryId, reason: "no revaluation needed" });
      continue;
    }

    try {
      const posted = await postRevaluationEntry(
        orgId,
        bookId,
        subsidiaryId,
        subsidiary.baseCurrency,
        periodId,
        asOfDate,
        period.name,
        period.next_period_id,
        period.next_starts_on,
        lines,
        actorId,
      );
      // Null: a concurrent run won the advisory lock and posted first.
      if (!posted) {
        result.skipped.push({ subsidiaryId, reason: ALREADY_REVALUED });
        continue;
      }
      result.posted.push({ subsidiaryId, entryId: posted.entryId, reversalEntryId: posted.reversalEntryId, netDelta });
    } catch (err) {
      result.problems.push(`${subsidiary.name}: ${(err as Error).message}`);
    }
  }

  return result;
}

/**
 * Insert the period-end adjustment and its mandatory next-period reversal,
 * atomically. Lines are booked in the functional currency.
 *
 * The duplicate check-then-insert is only a control because concurrent runs
 * cannot pass it simultaneously: a transaction-scoped advisory lock keyed per
 * (org, book, period, subsidiary) is taken BEFORE the check, so a retried
 * worker racing the close automation serializes here and the loser reports the
 * period as already revalued instead of double-posting. Returns null when
 * another run already posted; throws when the reversal has no period to land
 * in — an unreversed revaluation never posts.
 */
async function postRevaluationEntry(
  orgId: string,
  bookId: string,
  subsidiaryId: string,
  functionalCurrency: string,
  periodId: string,
  asOfDate: string,
  periodName: string,
  nextPeriodId: string | null,
  nextStartsOn: string | null,
  lines: RevaluationLine[],
  actorId: string | null,
): Promise<{ entryId: string; reversalEntryId: string } | null> {
  if (!isZero(sum(lines.map((l) => l.amount)))) {
    throw new RevaluationError("revaluation entry does not balance");
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${revaluationLockKey(orgId, bookId, periodId, subsidiaryId)}, 0))`);

    // Authoritative duplicate check — held under the lock above.
    const existing = (await tx.execute(sql`
      select 1 from journal_entries
       where org_id = ${orgId} and period_id = ${periodId} and book_id = ${bookId}
         and subsidiary_id = ${subsidiaryId} and origin = 'fx_revaluation'
         and reverses_entry_id is null limit 1`));
    if (existing.rows.length > 0) return null;

    const insertEntry = async (
      entryNumber: string,
      memo: string,
      postingDate: string,
      periodIdForEntry: string,
      reversesEntryId: string | null,
      entryLines: RevaluationLine[],
    ): Promise<string> => {
      const entryRes = (await tx.execute<{ id: string }>(sql`
        insert into journal_entries
          (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo,
           status, origin, reverses_entry_id, created_by, updated_by)
        values (${orgId}, ${bookId}, ${subsidiaryId}, ${entryNumber}, ${postingDate}, ${periodIdForEntry},
                ${memo}, 'draft', 'fx_revaluation', ${reversesEntryId}, ${actorId}, ${actorId})
        returning id`));
      const eid = entryRes.rows[0].id;
      for (let i = 0; i < entryLines.length; i++) {
        const l = entryLines[i]!;
        await tx.execute(sql`
          insert into journal_lines
            (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
          values (${orgId}, ${eid}, ${i + 1}, ${l.accountId}, ${subsidiaryId}, ${l.amount},
                  ${functionalCurrency}, ${l.amount}, 1, ${`Unrealized FX revaluation ${periodName}`})`);
      }
      await tx.execute(sql`
        update journal_entries set status = 'posted', posted_at = now(), posted_by = ${actorId}
         where id = ${eid}`);
      return eid;
    };

    const entryId = await insertEntry(
      `FXREVAL-${periodName}`,
      `Unrealized FX revaluation — ${periodName}`,
      asOfDate,
      periodId,
      null,
      lines,
    );

    if (!nextPeriodId || !nextStartsOn) {
      throw new RevaluationError(missingReversalPeriodReason());
    }
    const reversalEntryId = await insertEntry(
      `FXREVAL-${periodName}-R`,
      `Unrealized FX revaluation reversal — ${periodName}`,
      nextStartsOn,
      nextPeriodId,
      entryId,
      lines.map((l) => ({ accountId: l.accountId, amount: neg(l.amount) })),
    );

    return { entryId, reversalEntryId };
  });
}

/** Sort helper kept local so callers don't import money directly. */
export const byMagnitudeDesc = (a: string, b: string) => cmp(b, a);
