import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db, withOrgTransaction, withTransactionSavepoint } from "./db.ts";
import { businessTimeZone } from "./business-date.ts";
import { lockAndCheckOrgFeature } from "./org-feature-lock.ts";
import { loadControlAccounts } from "./control-accounts.ts";
import { add, cmp, isZero, mulRate, neg, sum } from "./money.ts";
import { loadSubsidiaryContext, SubsidiaryError, validateSubsidiaryRestrictions } from "./subsidiaries.ts";

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
 * Each run measures historical foreign positions in the assigned-period close
 * scope, then subtracts every still-effective FX adjustment in that same scope.
 * Corrections are additional immutable adjustment/reversal pairs; unchanged
 * reruns do nothing. The organization write lock precedes the subsidiary's
 * advisory lock and all basis reads, serializing ordinary posting and reruns.
 * The mandatory next-period mirror prevents permanent unrealized differences.
 */

/** Monetary account types whose foreign balances are revalued. Non-monetary
 *  accounts (fixed assets, equity, income, expense) are carried at historical
 *  rate and never revalued. */
export const MONETARY_ACCOUNT_TYPES = [
  "asset_bank",
  "asset_receivable",
  "liability_payable",
] as const;

/**
 * The monetary-item predicate (IAS 21.8/16) over an `accounts` row aliased
 * `a`: bank, receivable, and payable types by default, plus any balance-sheet
 * account explicitly flagged `accounts.monetary = true`, minus any account
 * flagged `monetary = false`. ONE definition: the revaluation engine's
 * position loader and the close readiness check both consume it, so the
 * check can never demand a revaluation the engine would not post (or ignore
 * one it would).
 */
export const MONETARY_ACCOUNT_SQL = sql`case
  when a.monetary is false then false
  when a.monetary is true then a.type not in
    ('income', 'income_other', 'cogs', 'expense', 'expense_other', 'expense_deferred', 'equity')
  else a.type in ('asset_bank', 'asset_receivable', 'liability_payable')
end`;

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
/**
 * The signed base-currency restatement one position needs: `foreignBalance ×
 * periodEndRate − carryingBase`, exact to ledger scale. Shared by the posting
 * arithmetic and the close readiness probe so both agree on "no revaluation
 * needed" to the last unit.
 */
export function positionDelta(p: Pick<RevaluationPosition, "foreignBalance" | "periodEndRate" | "carryingBase">): string {
  return add(mulRate(p.foreignBalance, p.periodEndRate), neg(p.carryingBase));
}

export function computeRevaluation(
  positions: RevaluationPosition[],
  unrealizedGainLossAccountId: string,
): { lines: RevaluationLine[]; netDelta: string } {
  const monetaryLines: RevaluationLine[] = [];
  let netDelta = "0";
  for (const p of positions) {
    const delta = positionDelta(p);
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

export class RevaluationFeatureDisabledError extends Error {
  readonly name = "RevaluationFeatureDisabledError";
  constructor() { super("multiCurrency feature is disabled"); }
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

/** org unrealized-FX gain/loss control account (orgs.settings.controlAccounts.fxUnrealizedGainLoss). */
async function unrealizedAccount(orgId: string): Promise<string> {
  // Use the centralized control-account reader so this P&L leg observes the
  // same organization, active/non-summary, and role-type policy as every
  // other posting path. Reading the JSON setting directly would allow a
  // balance-sheet account to silently absorb unrealized FX gains/losses.
  const controls = await loadControlAccounts(orgId);
  const acct = controls.fxUnrealizedGainLoss;
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
 * The historical population shared by posting and readiness. `scope` uses
 * assigned accounting periods, not dates. Zero foreign balances with residual
 * carrying value remain visible: they need a zero-value restatement, not a
 * spot rate. Open items use remaining directional application amounts; realized
 * settlement entries are already represented by that carrying basis and are
 * excluded. Historical unapplication uses endpoint reversal period evidence,
 * otherwise the stored event timestamp in the organization's business zone.
 * Missing rates on nonzero foreign balances remain explicit.
 */
async function loadExposures(
  orgId: string,
  bookId: string,
  subsidiaryId: string,
  functionalCurrency: string,
  asOfDate: string,
  scope: SQL,
): Promise<(Omit<RevaluationPosition, "periodEndRate"> & { periodEndRate: string | null })[]> {
  const timeZone = await businessTimeZone(orgId);
  const r = await db.execute<{
    account_id: string; currency: string; carrying_base: string; foreign_balance: string; invalid_residual: boolean;
  }>(sql`
    with scoped_entries as materialized (
      select e.id, e.org_id, e.reverses_entry_id, e.origin
        from journal_entries e
       where e.org_id=${orgId} and e.book_id=${bookId}
         and e.status in ('posted', 'reversed') and ${scope}
    ), effective_applications as (
      select ap.*
        from applications ap
        join journal_lines source on source.id=ap.from_line_id and source.org_id=ap.org_id
        join journal_lines target on target.id=ap.to_line_id and target.org_id=ap.org_id
        join scoped_entries source_entry on source_entry.id=source.entry_id
        join scoped_entries target_entry on target_entry.id=target.entry_id
       where ap.org_id=${orgId} and ap.applied_on<=${asOfDate}
         -- A backdated reversal is effective in its assigned period even when
         -- the unapplication audit timestamp was written in a later month.
         and not exists (select 1 from scoped_entries reversal
           where reversal.reverses_entry_id in (source.entry_id, target.entry_id))
         and (ap.unapplied_at is null
           or exists (select 1 from journal_entries reversal
             where reversal.org_id=${orgId} and reversal.book_id=${bookId}
               and reversal.status in ('posted', 'reversed')
               and reversal.reverses_entry_id in (source.entry_id, target.entry_id))
           or (ap.unapplied_at at time zone ${timeZone})::date>${asOfDate}::date)
    ), position_lines as (
      select l.account_id, l.currency,
             l.amount - sign(l.amount) * coalesce(applied.base,0) as carrying_base,
             l.txn_amount - sign(l.txn_amount) * coalesce(applied.foreign_amount,0) as foreign_balance,
             l.is_open_item and (
               coalesce(applied.base,0)>abs(l.amount)
               or coalesce(applied.foreign_amount,0)>abs(l.txn_amount)
               or ((abs(l.amount)=coalesce(applied.base,0)) <>
                   (abs(l.txn_amount)=coalesce(applied.foreign_amount,0)))
             ) as invalid_residual
        from journal_lines l
        join scoped_entries e on e.id=l.entry_id and e.org_id=l.org_id
        join accounts a on a.id=l.account_id and a.org_id=l.org_id
        left join lateral (
          select sum(case when ap.from_line_id=l.id then ap.source_amount else ap.amount end) as base,
                 sum(case when ap.from_line_id=l.id then ap.source_transaction_amount else ap.target_transaction_amount end) as foreign_amount
            from effective_applications ap
           where ap.from_line_id=l.id or ap.to_line_id=l.id
        ) applied on l.is_open_item
       where l.org_id=${orgId} and l.subsidiary_id=${subsidiaryId}
         and e.origin not in ('fx_revaluation', 'fx_settlement')
         and l.currency<>${functionalCurrency} and ${MONETARY_ACCOUNT_SQL}
    )
    select account_id, currency, sum(carrying_base)::text as carrying_base,
           sum(foreign_balance)::text as foreign_balance, bool_or(invalid_residual) as invalid_residual
      from position_lines group by account_id,currency
     having sum(foreign_balance)<>0 or sum(carrying_base)<>0 or bool_or(invalid_residual)`);

  const exposures: (Omit<RevaluationPosition, "periodEndRate"> & { periodEndRate: string | null })[] = [];
  for (const row of r.rows) {
    if (row.invalid_residual) {
      throw new RevaluationError(`inconsistent open-item residual for account ${row.account_id} in ${row.currency}`);
    }
    exposures.push({
      accountId: row.account_id,
      currency: row.currency,
      carryingBase: row.carrying_base,
      foreignBalance: row.foreign_balance,
      periodEndRate: isZero(row.foreign_balance) ? "1" : await periodEndRate(orgId, row.currency, functionalCurrency, asOfDate),
    });
  }
  return exposures;
}

/** Functional-currency FX lines cannot be allocated back to foreign currencies.
 * Net them by monetary account, including mirrors and earlier same-end periods.
 * A formerly monetary account remains here so disabling its policy cannot
 * strand an adjustment. Migration 0046 freezes account types once journal
 * lines exist; the validated FX offset is a P&L account and excluded. */
async function loadEffectiveAdjustments(
  orgId: string,
  bookId: string,
  subsidiaryId: string,
  scope: SQL,
): Promise<RevaluationLine[]> {
  const result = await db.execute<{ account_id: string; amount: string }>(sql`
    select l.account_id, sum(l.amount)::text as amount
      from journal_lines l
      join journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
      join accounts a on a.id=l.account_id and a.org_id=l.org_id
     where l.org_id=${orgId} and l.subsidiary_id=${subsidiaryId}
       and e.book_id=${bookId} and e.status in ('posted', 'reversed')
       and e.origin='fx_revaluation' and ${scope}
       and a.type not in
         ('income', 'income_other', 'cogs', 'expense', 'expense_other', 'expense_deferred', 'equity')
     group by l.account_id having sum(l.amount) <> 0`);
  return result.rows.map((row) => ({ accountId: row.account_id, amount: row.amount }));
}

/** One authoritative residual per account, including accounts that now have no
 * foreign exposure but still carry an effective earlier adjustment. */
function requiredAdjustments(positions: RevaluationPosition[], effective: RevaluationLine[]): RevaluationLine[] {
  const amounts = new Map<string, string>();
  for (const position of positions) {
    amounts.set(position.accountId, add(amounts.get(position.accountId) ?? "0", positionDelta(position)));
  }
  for (const line of effective) {
    amounts.set(line.accountId, add(amounts.get(line.accountId) ?? "0", neg(line.amount)));
  }
  return [...amounts].sort(([a], [b]) => a.localeCompare(b))
    .filter(([, amount]) => !isZero(amount)).map(([accountId, amount]) => ({ accountId, amount }));
}

type RevaluationPeriod = {
  id: string;
  ends_on: string;
  name: string;
  is_adjustment: boolean;
  fiscal_calendar_id: string;
  period_number: number;
  next_starts_on: string | null;
  next_period_id: string | null;
};

/** The period plus the following regular period its reversal must land in. */
async function loadRevaluationPeriod(orgId: string, periodId: string): Promise<RevaluationPeriod> {
  const periodRes = (await db.execute<RevaluationPeriod>(sql`
    select p.id as id, p.ends_on as ends_on, p.name as name,
           p.is_adjustment as is_adjustment, p.fiscal_calendar_id as fiscal_calendar_id,
           p.period_number as period_number,
           (select n.starts_on from accounting_periods n
             where n.org_id = ${orgId} and n.starts_on > p.ends_on and n.is_adjustment = false
               and n.fiscal_calendar_id = p.fiscal_calendar_id
             order by n.starts_on asc limit 1) as next_starts_on,
           (select n.id from accounting_periods n
             where n.org_id = ${orgId} and n.starts_on > p.ends_on and n.is_adjustment = false
               and n.fiscal_calendar_id = p.fiscal_calendar_id
             order by n.starts_on asc limit 1) as next_period_id
      from accounting_periods p
     where p.org_id = ${orgId} and p.id = ${periodId}`));
  const period = periodRes.rows[0];
  if (!period) throw new RevaluationError(`accounting period ${periodId} not found`);
  return period;
}

export interface RevaluationReadiness {
  /** Monetary accounts with a remaining restatement difference, plus foreign
   * positions with a missing spot rate. Prior FX entries alone never satisfy
   * readiness when the source balance or rate has changed. */
  unrevaluedPositions: number;
  /** Of those, positions with no usable period-end spot rate. */
  positionsMissingSpotRate: number;
  /** True when unrevalued positions exist but no following regular period
   *  exists for the mandatory reversal — the engine refuses to post until
   *  periods are generated. */
  reversalPeriodMissing: boolean;
}

/**
 * The close run's ledger scope for a period, by exact period identity (the
 * close doctrine: a journal belongs to the period it is assigned to, never
 * one inferred from its date): every period that ended before this one plus
 * the period itself, and for an adjustment period also the regular period
 * sharing its end date and any lower-numbered adjustment period of the same
 * calendar. An entry assigned to an adjustment period is outside its regular
 * period's close even when dated inside it. The journal-entry alias is `e`.
 */
export function financialClosePeriodScope(period: Pick<RevaluationPeriod, "id" | "ends_on" | "is_adjustment" | "fiscal_calendar_id" | "period_number">): SQL {
  return sql`exists (
    select 1 from accounting_periods ep
     where ep.id = e.period_id and ep.org_id = e.org_id
       and (
         ep.ends_on < ${period.ends_on}
         or ep.id = ${period.id}
         or (
           ${period.is_adjustment}
           and ep.fiscal_calendar_id = ${period.fiscal_calendar_id}
           and ep.ends_on = ${period.ends_on}
           and (not ep.is_adjustment or ep.period_number <= ${period.period_number})
         )
       ))`;
}

/** Posting and readiness share period identity, source population, rate
 * lookup and effective-adjustment arithmetic. Entity-scoped closes must pass
 * their resolved legal-entity set; an empty set means no entities. */
export async function revaluationReadiness(
  orgId: string,
  bookId: string,
  periodId: string,
  allowedSubsidiaryIds?: string[],
): Promise<RevaluationReadiness> {
  const period = await loadRevaluationPeriod(orgId, periodId);
  const ctx = await loadSubsidiaryContext(db, orgId);
  const scope = financialClosePeriodScope(period);
  let unrevaluedPositions = 0;
  let positionsMissingSpotRate = 0;
  for (const subsidiary of ctx.byId.values()) {
    if (allowedSubsidiaryIds && !allowedSubsidiaryIds.includes(subsidiary.id)) continue;
    const exposures = await loadExposures(orgId, bookId, subsidiary.id, subsidiary.baseCurrency, period.ends_on, scope);
    const positions: RevaluationPosition[] = [];
    const missingAccounts = new Set<string>();
    for (const exposure of exposures) {
      if (!exposure.periodEndRate) {
        positionsMissingSpotRate++;
        unrevaluedPositions++;
        missingAccounts.add(exposure.accountId);
      } else {
        positions.push({ ...exposure, periodEndRate: exposure.periodEndRate });
      }
    }
    const effective = await loadEffectiveAdjustments(orgId, bookId, subsidiary.id, scope);
    unrevaluedPositions += requiredAdjustments(positions, effective)
      .filter((line) => !missingAccounts.has(line.accountId)).length;
  }
  return {
    unrevaluedPositions,
    positionsMissingSpotRate,
    reversalPeriodMissing: unrevaluedPositions > 0 && (!period.next_period_id || !period.next_starts_on),
  };
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

/** Restate each legal entity with incremental immutable adjustment/reversal
 * pairs. The organization lock is taken before configuration and basis reads,
 * consistent with ordinary posting. Each entity retains its own savepoint so a
 * rejected entity cannot leave half a pair or discard successful siblings. */
export async function runRevaluation(
  orgId: string,
  periodId: string,
  actorId: string | null,
  allowedSubsidiaryIds?: string[],
): Promise<RevaluationRunResult> {
  return withOrgTransaction(orgId, async () => {
    await db.execute(sql`select id from orgs where id=${orgId} for update`);
    if (!(await lockAndCheckOrgFeature(db, orgId, "multiCurrency"))) {
      throw new RevaluationFeatureDisabledError();
    }
    const bookId = await primaryBookId(orgId);
    await unrealizedAccount(orgId);
    const ctx = await loadSubsidiaryContext(db, orgId);
    const result: RevaluationRunResult = { posted: [], skipped: [], problems: [] };
    for (const subsidiaryId of [...new Set(allowedSubsidiaryIds ?? [...ctx.byId.keys()])]) {
      const subsidiary = ctx.byId.get(subsidiaryId);
      if (!subsidiary) {
        result.problems.push(`subsidiary ${subsidiaryId} does not exist`);
        continue;
      }
      try {
        const posted = await postRevaluationEntry(orgId, bookId, subsidiaryId, periodId, actorId);
        if (!posted) {
          result.skipped.push({ subsidiaryId, reason: "no revaluation needed" });
        } else {
          result.posted.push({ subsidiaryId, ...posted });
        }
      } catch (err) {
        result.problems.push(`${subsidiary.name}: ${(err as Error).message}`);
      }
    }
    return result;
  });
}

/** Compute and insert one incremental pair under the run's organization lock
 * and subsidiary advisory lock. Every line uses the legal entity's functional
 * currency; its reversal is mandatory and atomic with the adjustment. */
async function postRevaluationEntry(
  orgId: string,
  bookId: string,
  subsidiaryId: string,
  periodId: string,
  actorId: string | null,
): Promise<{ entryId: string; reversalEntryId: string; netDelta: string } | null> {
  return db.transaction(async (tx) => withTransactionSavepoint(tx, async () => {
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${revaluationLockKey(orgId, bookId, periodId, subsidiaryId)}, 0))`);
    const book = (await tx.execute<{ id: string }>(sql`select id from accounting_books
      where org_id=${orgId} and id=${bookId} and is_primary and is_active and posts_gl for share`)).rows[0];
    if (!book) throw new RevaluationError("revaluation requires an active primary posting book");
    await tx.execute(sql`select id from subsidiaries where org_id=${orgId} order by id for share`);
    const ctx = await loadSubsidiaryContext(tx, orgId);
    const subsidiary = ctx.byId.get(subsidiaryId);
    if (!subsidiary?.isActive) throw new RevaluationError("revaluation subsidiary is missing or inactive");
    const functionalCurrency = subsidiary.baseCurrency;
    // Freeze account policy before computing exposure membership and validating
    // the configured offset. Historical accounts with obsolete monetary policy
    // also need locking when clearing their residual adjustment.
    await tx.execute(sql`select id from accounts where org_id=${orgId} order by id for share`);
    const gainLossAccount = await unrealizedAccount(orgId);
    const period = await loadRevaluationPeriod(orgId, periodId);
    const { ends_on: asOfDate, name: periodName, next_period_id: nextPeriodId, next_starts_on: nextStartsOn } = period;
    const scope = financialClosePeriodScope(period);
    const exposures = await loadExposures(orgId, bookId, subsidiaryId, functionalCurrency, asOfDate, scope);
    const positions: RevaluationPosition[] = [];
    for (const exposure of exposures) {
      if (!exposure.periodEndRate) {
        throw new RevaluationError(`no spot rate for ${exposure.currency}→${functionalCurrency} on or before ${asOfDate}`);
      }
      positions.push({ ...exposure, periodEndRate: exposure.periodEndRate });
    }
    const effective = await loadEffectiveAdjustments(orgId, bookId, subsidiaryId, scope);
    const monetaryLines = requiredAdjustments(positions, effective);
    if (monetaryLines.length === 0) return null;
    if (!nextPeriodId || !nextStartsOn) throw new RevaluationError(missingReversalPeriodReason());
    const netDelta = sum(monetaryLines.map((line) => line.amount));
    const lines = isZero(netDelta) ? monetaryLines
      : [...monetaryLines, { accountId: gainLossAccount, amount: neg(netDelta) }];
    if (!isZero(sum(lines.map((line) => line.amount)))) {
      throw new RevaluationError("revaluation entry does not balance");
    }
    try {
      await validateSubsidiaryRestrictions(tx, {
        orgId, ctx, docSubsidiaryId: subsidiaryId,
        lines: lines.map((line) => ({ ...line, subsidiaryId })),
      });
    } catch (error) {
      if (error instanceof SubsidiaryError) throw new RevaluationError(error.message);
      throw error;
    }

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
      const eid = entryRes.rows[0]!.id;
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
         where id = ${eid} and org_id = ${orgId}`);
      return eid;
    };

    // Every subsidiary and correction generation needs a distinct org-wide
    // journal number, so every physical journal —
    // adjustment and its -R mirror alike — carries its own number.
    const entryNumber = `FXREVAL-${periodName}-${randomUUID().slice(0, 8)}`;
    const entryId = await insertEntry(
      entryNumber,
      `Unrealized FX revaluation — ${periodName}`,
      asOfDate,
      periodId,
      null,
      lines,
    );

    const reversalEntryId = await insertEntry(
      `${entryNumber}-R`,
      `Unrealized FX revaluation reversal — ${periodName}`,
      nextStartsOn,
      nextPeriodId,
      entryId,
      lines.map((l) => ({ accountId: l.accountId, amount: neg(l.amount) })),
    );

    await tx.execute(sql`insert into audit_log
      (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (${orgId}, 'journal_entries', ${entryId}, 'insert', ${JSON.stringify({
        mode: "fx_revaluation_incremental", bookId, subsidiaryId, periodId,
        asOfDate, reversalEntryId, nextPeriodId,
        basis: "assigned_period_open_item_residuals_and_nonopen_gl_less_effective_fx_by_account",
        positions, effectiveAdjustments: effective, lines, netDelta,
      })}::jsonb, ${actorId}, 'fx_revaluation')`);
    return { entryId, reversalEntryId, netDelta };
  }));
}

/** Sort helper kept local so callers don't import money directly. */
export const byMagnitudeDesc = (a: string, b: string) => cmp(b, a);
