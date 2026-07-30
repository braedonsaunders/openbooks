import { sql } from "drizzle-orm";
import { db, schema } from "./db.ts";
import { fromUnits, isZero, mulPercent, mulRate, neg, sum, toUnits } from "./money.ts";
import { assertFinalKernelBalance } from "./posting.ts";
import { loadSubsidiaryContext } from "./subsidiaries.ts";

/**
 * Consolidation machinery (source platform parity):
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

type OwnershipInterest = {
  id: string; subsidiary_id: string; method: "full" | "proportionate" | "equity";
  ownership_percent: string; acquisition_date: string; acquisition_cost: string;
  fair_value_net_assets: string; acquisition_rate: string; nci_measurement: "proportionate" | "fair_value";
  nci_fair_value: string | null; investment_account_id: string; equity_income_account_id: string;
  distribution_account_id: string | null; distribution_income_account_id: string | null;
  nci_equity_account_id: string | null; nci_income_account_id: string | null;
  goodwill_account_id: string | null; fair_value_adjustment_account_id: string | null;
};

type AdjustmentLine = { accountId: string; amount: string; memo: string };

/**
 * Post acquisition, NCI, and equity-method consolidation adjustments. Every
 * adjustment lives in the elimination subsidiary, is exact to ledger scale,
 * and is append-only on rerun (prior effective entries are reversed first).
 */
export async function runOwnershipConsolidation(
  orgId: string,
  periodId: string,
  userId: string,
): Promise<{ runId: string; entryIds: string[] }> {
  if (!userId) throw new ConsolidationError("an attributable actor is required");
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ownership:${orgId}:${periodId}`},0))`);
      const context = await loadSubsidiaryContext(tx as any, orgId);
      const elimination = [...context.byId.values()].find((row) => row.isElimination && row.isActive);
      if (!elimination) throw new ConsolidationError("no active elimination subsidiary for ownership adjustments");
      const periodResult = (await tx.execute(sql`
        select id, starts_on, ends_on, name from accounting_periods where id=${periodId} and org_id=${orgId}
      `)) as unknown as { rows: { id: string; starts_on: string; ends_on: string; name: string }[] };
      const period = periodResult.rows[0];
      if (!period) throw new ConsolidationError(`period ${periodId} not found`);
      const bookResult = (await tx.execute(sql`
        select id from accounting_books where org_id=${orgId} and is_primary and is_active limit 1
      `)) as unknown as { rows: { id: string }[] };
      const bookId = bookResult.rows[0]?.id;
      if (!bookId) throw new ConsolidationError("no active primary accounting book is configured");
      const interests = (await tx.execute(sql`
        select * from subsidiary_ownership_interests
         where org_id=${orgId} and is_active and effective_from <= ${period.ends_on}
           and (effective_to is null or effective_to >= ${period.starts_on})
         order by subsidiary_id, effective_from
      `)) as unknown as { rows: OwnershipInterest[] };
      const run = (await tx.execute(sql`
        insert into ownership_consolidation_runs (org_id,period_id,status,created_by,updated_by)
        values (${orgId},${periodId},'running',${userId ?? null},${userId ?? null}) returning id
      `)) as unknown as { rows: { id: string }[] };
      const runId = run.rows[0]!.id;
      const entryIds: string[] = [];
      let sequence = 0;

      const post = async (interestId: string, kind: "acquisition" | "nci_income" | "equity_income" | "reversal", lines: AdjustmentLine[], reverses?: string) => {
        const material = lines.filter((line) => !isZero(line.amount));
        if (material.length === 0) return null;
        assertFinalKernelBalance(material.map((line) => ({ amount: line.amount, subsidiaryId: elimination.id })));
        sequence++;
        const inserted = (await tx.execute(sql`
          insert into journal_entries
            (org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,memo,status,origin,reverses_entry_id,created_by)
          values (${orgId},${bookId},${elimination.id},${`OWN-${period.name}-${runId.slice(0,8)}-${sequence}`},
                  ${period.ends_on},${periodId},${`Ownership consolidation ${kind}`},'draft','translation',${reverses ?? null},${userId ?? null})
          returning id
        `)) as unknown as { rows: { id: string }[] };
        const entryId = inserted.rows[0]!.id;
        for (let index = 0; index < material.length; index++) {
          const line = material[index]!;
          await tx.execute(sql`
            insert into journal_lines
              (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,memo)
            values (${orgId},${entryId},${index + 1},${line.accountId},${elimination.id},${line.amount},
                    ${elimination.baseCurrency},${line.amount},1,${line.memo})
          `);
        }
        await tx.execute(sql`update journal_entries set status='posted',posted_at=now(),posted_by=${userId} where id=${entryId}`);
        if (reverses) {
          await tx.execute(sql`
            update journal_entries
               set status='reversed', updated_at=now(), updated_by=${userId}
             where id=${reverses} and org_id=${orgId} and status='posted'
          `);
        }
        await tx.execute(sql`
          insert into ownership_consolidation_entries (org_id,run_id,interest_id,kind,journal_entry_id,created_by,updated_by)
          values (${orgId},${runId},${interestId},${kind},${entryId},${userId ?? null},${userId ?? null})
        `);
        entryIds.push(entryId);
        return entryId;
      };

      const prior = (await tx.execute(sql`
        select oce.interest_id, je.id, je.entry_number
          from ownership_consolidation_entries oce
          join ownership_consolidation_runs r on r.id=oce.run_id and r.period_id=${periodId}
          join journal_entries je on je.id=oce.journal_entry_id and je.status='posted'
         where oce.org_id=${orgId} and oce.kind<>'reversal' and je.reverses_entry_id is null
           and not exists(select 1 from journal_entries rev where rev.reverses_entry_id=je.id and rev.status='posted')
      `)) as unknown as { rows: { interest_id: string; id: string; entry_number: string }[] };
      for (const old of prior.rows) {
        const oldLines = (await tx.execute(sql`select account_id,amount,memo from journal_lines where entry_id=${old.id} order by line_number`)) as unknown as { rows: { account_id: string; amount: string; memo: string | null }[] };
        await post(old.interest_id, "reversal", oldLines.rows.map((line) => ({ accountId: line.account_id, amount: neg(line.amount), memo: `Reversal of ${old.entry_number}` })), old.id);
      }

      for (const interest of interests.rows) {
        const periodActivity = (await tx.execute(sql`
          select coalesce(-sum(l.amount) filter (where a.type in ('income','income_other','cogs','expense','expense_other','expense_deferred')),0)::text as profit,
                 coalesce(sum(l.amount) filter (where l.account_id=${interest.distribution_account_id}),0)::text as distributions
           from journal_lines l join journal_entries e on e.id=l.entry_id
            join accounts a on a.id=l.account_id
           where e.org_id=${orgId} and e.status in ('posted','reversed') and l.subsidiary_id=${interest.subsidiary_id}
             and e.period_id=${periodId}
        `)) as unknown as { rows: { profit: string; distributions: string }[] };
        const profit = periodActivity.rows[0]!.profit;
        const distributions = periodActivity.rows[0]!.distributions;

        if (interest.method === "full") {
          const acquisitionExists = (await tx.execute(sql`
            select 1 from ownership_consolidation_entries oce
             join journal_entries je on je.id=oce.journal_entry_id and je.status='posted'
            where oce.interest_id=${interest.id} and oce.kind='acquisition' and je.reverses_entry_id is null
              and not exists(select 1 from journal_entries rev where rev.reverses_entry_id=je.id and rev.status='posted') limit 1
          `)) as unknown as { rows: unknown[] };
          if (!acquisitionExists.rows[0] && interest.acquisition_date <= period.ends_on) {
            const equity = (await tx.execute(sql`
              select l.account_id,coalesce(sum(l.amount),0)::text as amount
                from journal_lines l join journal_entries e on e.id=l.entry_id
                join accounts a on a.id=l.account_id and a.type='equity'
               where e.org_id=${orgId} and e.status in ('posted','reversed') and l.subsidiary_id=${interest.subsidiary_id}
                 and e.posting_date <= ${interest.acquisition_date}
               group by l.account_id having sum(l.amount)<>0
            `)) as unknown as { rows: { account_id: string; amount: string }[] };
            const translatedEquity = equity.rows.map((line) => ({ accountId: line.account_id, balance: mulRate(line.amount, interest.acquisition_rate) }));
            const bookNetAssets = sum(translatedEquity.map((line) => neg(line.balance)));
            const nciPercent = fromUnits(toUnits("100") - toUnits(interest.ownership_percent));
            const nci = interest.nci_measurement === "fair_value"
              ? interest.nci_fair_value!
              : mulPercent(interest.fair_value_net_assets, nciPercent);
            const fairValueAdjustment = fromUnits(toUnits(interest.fair_value_net_assets) - toUnits(bookNetAssets));
            const goodwill = fromUnits(toUnits(interest.acquisition_cost) + toUnits(nci) - toUnits(interest.fair_value_net_assets));
            await post(interest.id, "acquisition", [
              ...translatedEquity.map((line) => ({ accountId: line.accountId, amount: neg(line.balance), memo: "Eliminate acquisition-date equity" })),
              { accountId: interest.fair_value_adjustment_account_id!, amount: fairValueAdjustment, memo: "Fair-value net asset adjustment" },
              { accountId: interest.goodwill_account_id!, amount: goodwill, memo: "Acquisition goodwill or bargain purchase" },
              { accountId: interest.investment_account_id, amount: neg(interest.acquisition_cost), memo: "Eliminate parent investment" },
              ...(interest.nci_equity_account_id ? [{ accountId: interest.nci_equity_account_id, amount: neg(nci), memo: "Recognize non-controlling interest" }] : []),
            ]);
          }
          const nciPercent = fromUnits(toUnits("100") - toUnits(interest.ownership_percent));
          const nciIncome = mulPercent(profit, nciPercent);
          if (interest.nci_income_account_id && interest.nci_equity_account_id) {
            await post(interest.id, "nci_income", [
              { accountId: interest.nci_income_account_id!, amount: nciIncome, memo: "Allocate profit to non-controlling interests" },
              { accountId: interest.nci_equity_account_id!, amount: neg(nciIncome), memo: "Accumulate non-controlling interest" },
            ]);
          }
        } else if (interest.method === "equity") {
          const shareProfit = mulPercent(profit, interest.ownership_percent);
          const shareDistribution = mulPercent(distributions, interest.ownership_percent);
          await post(interest.id, "equity_income", [
            { accountId: interest.investment_account_id, amount: shareProfit, memo: "Equity-method share of profit" },
            { accountId: interest.equity_income_account_id, amount: neg(shareProfit), memo: "Equity-method income" },
            ...(interest.distribution_income_account_id ? [
              { accountId: interest.investment_account_id, amount: neg(shareDistribution), memo: "Equity-method distribution reduces investment" },
              { accountId: interest.distribution_income_account_id, amount: shareDistribution, memo: "Eliminate distribution income" },
            ] : []),
          ]);
        }
      }
      await tx.execute(sql`update ownership_consolidation_runs set status='posted',finished_at=now(),updated_at=now() where id=${runId}`);
      return { runId, entryIds };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.execute(sql`
      insert into ownership_consolidation_runs (org_id,period_id,status,error,finished_at,created_by,updated_by)
      values (${orgId},${periodId},'failed',${message.slice(0,1000)},now(),${userId ?? null},${userId ?? null})
    `).catch(() => undefined);
    throw error;
  }
}

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
  userId: string,
): Promise<{ entryId: string | null; lineCount: number }> {
  if (!userId) throw new ConsolidationError("an attributable actor is required");
  const ctx = await loadSubsidiaryContext(db, orgId);
  const elim = [...ctx.byId.values()].find((s) => s.isElimination && s.isActive);
  if (!elim) {
    throw new ConsolidationError(
      "no active elimination subsidiary — create one under Setup → Subsidiaries",
    );
  }

  return db.transaction(async (tx) => {
  // One elimination run per tenant/period at a time. Every read that decides
  // what to reverse or create happens after this transaction-scoped lock.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`elimination:${orgId}:${periodId}`}, 0))`);

  const activity = (await tx.execute(sql`
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
     where e.org_id = ${orgId} and e.period_id = ${periodId} and e.status in ('posted', 'reversed')
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
  const prior = (await tx.execute(sql`
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

  if (translatedActivity.length > 0) {
    assertFinalKernelBalance(
      translatedActivity.map((row) => ({ amount: neg(row.total), subsidiaryId: elim.id })),
    );
  }

  const periodRes = (await tx.execute(sql`
    select ends_on, name from accounting_periods where id = ${periodId} and org_id = ${orgId}`)) as unknown as {
    rows: { ends_on: string; name: string }[];
  };
  const period = periodRes.rows[0];
  const [book] = await tx
    .select()
    .from(schema.accountingBooks)
    .where(sql`${schema.accountingBooks.orgId} = ${orgId} and ${schema.accountingBooks.isPrimary} = true`);
  if (!period) throw new ConsolidationError(`period ${periodId} not found`);
  if (!book) throw new ConsolidationError("no primary accounting book is configured");

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
        update journal_entries set status = 'posted', posted_at = now(), posted_by = ${userId}
         where id = ${reversalId}`);
      await tx.execute(sql`
        update journal_entries
           set status = 'reversed', updated_at = now(), updated_by = ${userId}
         where id = ${p.id} and org_id = ${orgId} and status = 'posted'
      `);
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
      update journal_entries set status = 'posted', posted_at = now(), posted_by = ${userId}
       where id = ${entryId}`);
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (
        ${orgId}, 'journal_entries', ${entryId}, 'insert',
        ${JSON.stringify({
          mode: "auto_elimination",
          periodId,
          lineCount: translatedActivity.length,
        })}::jsonb,
        ${userId}, 'auto_elimination'
      )
    `);
    return { entryId, lineCount: n };
  });
}
