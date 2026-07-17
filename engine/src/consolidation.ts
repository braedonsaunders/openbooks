import { sql } from "drizzle-orm";
import { db, schema } from "./db.ts";
import { isZero, neg, sum } from "./money.ts";
import { loadSubsidiaryContext } from "./subsidiaries.ts";

/**
 * Consolidation machinery (NetSuite parity):
 *
 *  - deriveConsolidatedRates: builds the period's consolidated exchange-rate
 *    rows (current / average / historical) from the daily fx_rates table for
 *    every currency pair the subsidiary tree needs. Manual overrides
 *    (source='manual') are never touched.
 *
 *  - runAutoElimination: at period close, reverses the period's activity on
 *    accounts flagged `eliminate` into the elimination subsidiary, so
 *    consolidated statements net intercompany balances to zero while every
 *    standalone view stays untouched. Re-runnable: it replaces the period's
 *    prior elimination entry.
 *
 * Translation itself (statement-time current/average/historical application
 * + CTA plug) lives with the report resolvers; these functions own the data
 * they consume.
 */

export class ConsolidationError extends Error {}

/** Currency pairs needed to translate every subsidiary into every ancestor. */
async function neededPairs(orgId: string): Promise<{ from: string; to: string }[]> {
  const ctx = await loadSubsidiaryContext(db, orgId);
  const pairs = new Map<string, { from: string; to: string }>();
  for (const s of ctx.byId.values()) {
    let p = s.parentId ? ctx.byId.get(s.parentId) : null;
    while (p) {
      if (s.baseCurrency !== p.baseCurrency) {
        pairs.set(`${s.baseCurrency}→${p.baseCurrency}`, { from: s.baseCurrency, to: p.baseCurrency });
      }
      p = p.parentId ? ctx.byId.get(p.parentId) : null;
    }
  }
  return [...pairs.values()];
}

/**
 * Derive the period's consolidated rates from daily fx_rates:
 *   current    — the latest spot rate on/before the period end
 *   average    — the mean of spot rates dated inside the period
 *   historical — carried forward from the prior period (else = current)
 * Upserts source='derived' rows; rows a controller set to 'manual' are kept.
 */
export async function deriveConsolidatedRates(orgId: string, periodId: string): Promise<number> {
  const periodRes = (await db.execute(sql`
    select id, starts_on, ends_on, fiscal_year, period_number from accounting_periods
     where id = ${periodId} and org_id = ${orgId}`)) as unknown as {
    rows: { id: string; starts_on: string; ends_on: string; fiscal_year: number; period_number: number }[];
  };
  const period = periodRes.rows[0];
  if (!period) throw new ConsolidationError(`period ${periodId} not found`);

  const pairs = await neededPairs(orgId);
  let written = 0;
  for (const pair of pairs) {
    const rates = (await db.execute(sql`
      select
        (select rate from fx_rates
          where org_id = ${orgId} and from_currency = ${pair.from} and to_currency = ${pair.to}
            and rate_type = 'spot' and as_of <= ${period.ends_on}
          order by as_of desc limit 1) as current,
        (select avg(rate) from fx_rates
          where org_id = ${orgId} and from_currency = ${pair.from} and to_currency = ${pair.to}
            and rate_type = 'spot'
            and as_of between ${period.starts_on} and ${period.ends_on}) as average,
        (select cf.historical_rate from consolidated_fx_rates cf
           join accounting_periods p on p.id = cf.period_id
          where cf.org_id = ${orgId} and cf.from_currency = ${pair.from} and cf.to_currency = ${pair.to}
            and p.ends_on < ${period.starts_on}
          order by p.ends_on desc limit 1) as historical
    `)) as unknown as { rows: { current: string | null; average: string | null; historical: string | null }[] };
    const r = rates.rows[0];
    if (!r?.current) {
      throw new ConsolidationError(
        `no spot rate for ${pair.from}→${pair.to} on or before ${period.ends_on} — load fx_rates first`,
      );
    }
    await db.execute(sql`
      insert into consolidated_fx_rates
        (org_id, period_id, from_currency, to_currency, current_rate, average_rate, historical_rate, source)
      values (${orgId}, ${periodId}, ${pair.from}, ${pair.to},
              ${r.current}, ${r.average ?? r.current}, ${r.historical ?? r.current}, 'derived')
      on conflict (org_id, period_id, from_currency, to_currency) do update
        set current_rate = excluded.current_rate,
            average_rate = excluded.average_rate,
            historical_rate = excluded.historical_rate,
            updated_at = now()
        where consolidated_fx_rates.source = 'derived'
    `);
    written++;
  }
  return written;
}

/**
 * Auto-elimination at period close. For every account flagged `eliminate`,
 * the period's net activity per subsidiary is reversed into the elimination
 * subsidiary under the same account: consolidated views (which include the
 * elimination subsidiary) net intercompany balances to zero, standalone views
 * (which exclude it) are untouched. The elimination entry balances within the
 * elimination subsidiary because flagged intercompany activity nets to zero
 * across the tree when due-to/due-from pairs are used consistently; any
 * residual is a real reconciliation break and aborts the run.
 */
export async function runAutoElimination(
  orgId: string,
  periodId: string,
  userId?: string,
): Promise<{ entryId: string | null; lineCount: number }> {
  const ctx = await loadSubsidiaryContext(db, orgId);
  const elim = [...ctx.byId.values()].find((s) => s.isElimination && s.isActive);
  if (!elim) {
    throw new ConsolidationError(
      "no active elimination subsidiary — create one under Setup → Subsidiaries",
    );
  }

  const activity = (await db.execute(sql`
    select l.account_id as "accountId", l.subsidiary_id as "subsidiaryId",
           sum(round(l.amount * case
             when source_sub.base_currency = ${elim.baseCurrency} then 1
             else consolidated.current_rate
           end, 4))::text as total,
           bool_or(source_sub.base_currency <> ${elim.baseCurrency}
                   and consolidated.current_rate is null) as "missingRate"
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
      join subsidiaries source_sub on source_sub.id = l.subsidiary_id
      left join consolidated_fx_rates consolidated
        on consolidated.org_id = e.org_id
       and consolidated.period_id = e.period_id
       and consolidated.from_currency = source_sub.base_currency
       and consolidated.to_currency = ${elim.baseCurrency}
     where e.org_id = ${orgId} and e.period_id = ${periodId} and e.status = 'posted'
       and a.eliminate and l.subsidiary_id <> ${elim.id}
     group by l.account_id, l.subsidiary_id
    having sum(l.amount) <> 0`)) as unknown as {
    rows: { accountId: string; subsidiaryId: string; total: string | null; missingRate: boolean }[];
  };

  const missing = activity.rows.find((row) => row.missingRate || row.total === null);
  if (missing) {
    const source = ctx.byId.get(missing.subsidiaryId);
    throw new ConsolidationError(
      `no consolidated current rate for ${source?.baseCurrency ?? "unknown"}→${elim.baseCurrency} in period ${periodId}`,
    );
  }
  const translatedActivity = activity.rows as { accountId: string; subsidiaryId: string; total: string }[];

  // Prior effective elimination entries are reversed on a re-run. Posted
  // ledger rows are never deleted or rewritten.
  const prior = (await db.execute(sql`
    select original.id, original.entry_number as "entryNumber"
      from journal_entries original
     where original.org_id = ${orgId} and original.period_id = ${periodId}
       and original.subsidiary_id = ${elim.id}
       and original.origin = 'intercompany' and original.status = 'posted'
       and original.reverses_entry_id is null
       and not exists (
         select 1 from journal_entries reversal
          where reversal.org_id = original.org_id
            and reversal.reverses_entry_id = original.id
            and reversal.status = 'posted'
       )`)) as unknown as {
    rows: { id: string; entryNumber: string }[];
  };

  if (translatedActivity.length === 0 && prior.rows.length === 0) {
    return { entryId: null, lineCount: 0 };
  }

  const residual = sum(translatedActivity.map((r) => r.total));
  if (!isZero(residual)) {
    throw new ConsolidationError(
      `intercompany activity does not net to zero for the period (residual ${residual}) — reconcile due-to/due-from before eliminating`,
    );
  }

  const periodRes = (await db.execute(sql`
    select ends_on, name from accounting_periods where id = ${periodId} and org_id = ${orgId}`)) as unknown as {
    rows: { ends_on: string; name: string }[];
  };
  const period = periodRes.rows[0];
  const [book] = await db
    .select()
    .from(schema.accountingBooks)
    .where(sql`${schema.accountingBooks.orgId} = ${orgId} and ${schema.accountingBooks.isPrimary} = true`);
  if (!period) throw new ConsolidationError(`period ${periodId} not found`);
  if (!book) throw new ConsolidationError("no primary accounting book is configured");

  return db.transaction(async (tx) => {
    let lastReversalId: string | null = null;
    for (const p of prior.rows) {
      const rev = (await tx.execute(sql`
        insert into journal_entries
          (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id,
           memo, status, origin, reverses_entry_id, created_by)
        values (${orgId}, ${book.id}, ${elim.id}, ${`${p.entryNumber}-R`}, ${period.ends_on},
                ${periodId}, ${`Reversal of ${p.entryNumber}`}, 'draft', 'intercompany', ${p.id}, ${userId ?? null})
        returning id`)) as unknown as { rows: { id: string }[] };
      const reversalId = rev.rows[0]!.id;
      await tx.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount,
           currency, txn_amount, fx_rate, memo)
        select org_id, ${reversalId}, line_number, account_id, subsidiary_id, -amount,
               currency, -txn_amount, fx_rate, ${`Reversal of ${p.entryNumber}`}
          from journal_lines where entry_id = ${p.id}`);
      await tx.execute(sql`
        update journal_entries set status = 'posted', posted_at = now(), posted_by = ${userId ?? null}
         where id = ${reversalId}`);
      lastReversalId = reversalId;
    }
    if (translatedActivity.length === 0) return { entryId: lastReversalId, lineCount: 0 };

    const ins = (await tx.execute(sql`
      insert into journal_entries
        (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id,
         memo, status, origin, created_by)
      values (${orgId}, ${book.id}, ${elim.id}, ${`ELIM-${period.name}`}, ${period.ends_on},
              ${periodId}, ${`Auto-elimination ${period.name}`}, 'draft', 'intercompany', ${userId ?? null})
      returning id`)) as unknown as { rows: { id: string }[] };
    const entryId = ins.rows[0].id;

    let n = 0;
    for (const row of translatedActivity) {
      n++;
      await tx.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount,
           currency, txn_amount, fx_rate, memo)
        values (${orgId}, ${entryId}, ${n}, ${row.accountId}, ${elim.id}, ${neg(row.total)},
                ${elim.baseCurrency}, ${neg(row.total)}, 1,
                ${`Eliminates ${ctx.byId.get(row.subsidiaryId)?.name ?? row.subsidiaryId}`})`);
    }
    await tx.execute(sql`
      update journal_entries set status = 'posted', posted_at = now(), posted_by = ${userId ?? null}
       where id = ${entryId}`);
    return { entryId, lineCount: n };
  });
}
