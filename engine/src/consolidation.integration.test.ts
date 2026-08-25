import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { deriveConsolidatedRates, runAutoElimination, runOwnershipConsolidation } from "./consolidation.ts";
import { db, withOrgTransaction } from "./db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("foreign-currency eliminations are exact, balanced, and safely rerunnable", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const foreignSubsidiaryId = randomUUID();
    const eliminationSubsidiaryId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries
        (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values
        (${foreignSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb),
        (${eliminationSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'Eliminations', 'CAD', 'CA', '{}'::jsonb, true, true, '{}'::jsonb)`);
    await db.execute(sql`
      update accounts set eliminate = true
       where id in (${org.accounts.ar}, ${org.accounts.ap})`);
    await db.execute(sql`
      insert into consolidated_fx_rates
        (org_id, period_id, from_currency, to_currency, current_rate, average_rate, historical_rate, source)
      values (${org.orgId}, ${org.periodId}, 'USD', 'CAD', '1.2000000000', '1.1900000000', '1.1000000000', 'manual')`);

    const cadEntry = randomUUID();
    const usdEntry = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
      values
        (${cadEntry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'IC-CAD', ${org.date}, ${org.periodId}, 'CAD intercompany', 'draft', 'manual'),
        (${usdEntry}, ${org.orgId}, ${org.bookId}, ${foreignSubsidiaryId}, 'IC-USD', ${org.date}, ${org.periodId}, 'USD intercompany', 'draft', 'manual')`);
    await db.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
      values
        (${org.orgId}, ${cadEntry}, 1, ${org.accounts.ar}, ${org.subsidiaryId}, '120.0000', 'CAD', '120.0000', '1'),
        (${org.orgId}, ${cadEntry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, '-120.0000', 'CAD', '-120.0000', '1'),
        (${org.orgId}, ${usdEntry}, 1, ${org.accounts.ap}, ${foreignSubsidiaryId}, '-100.0000', 'USD', '-100.0000', '1'),
        (${org.orgId}, ${usdEntry}, 2, ${org.accounts.bank}, ${foreignSubsidiaryId}, '100.0000', 'USD', '100.0000', '1')`);
    await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id in (${cadEntry}, ${usdEntry})`);

    const first = await runAutoElimination(org.orgId, org.periodId, actorId);
    assert.equal(first.lineCount, 2);
    const firstLines = (await db.execute<{ number: string; amount: string }>(sql`
      select a.number, l.amount
        from journal_lines l join accounts a on a.id = l.account_id
       where l.entry_id = ${first.entryId}
       order by a.number`));
    assert.deepEqual(firstLines.rows, [
      { number: "1100", amount: "-120.0000" },
      { number: "2000", amount: "120.0000" },
    ]);

    const second = await runAutoElimination(org.orgId, org.periodId, actorId);
    assert.equal(second.lineCount, 2);
    assert.notEqual(second.entryId, first.entryId);
    const proof = (await db.execute<{ reversals: number; effective_balance: string; ar_elimination: string; ap_elimination: string }>(sql`
      select
        count(distinct e.id) filter (where reverses_entry_id = ${first.entryId} and status = 'posted')::int as reversals,
        coalesce(sum(l.amount), 0)::text as effective_balance,
        coalesce(sum(l.amount) filter (where l.account_id = ${org.accounts.ar}), 0)::text as ar_elimination,
        coalesce(sum(l.amount) filter (where l.account_id = ${org.accounts.ap}), 0)::text as ap_elimination
      from journal_entries e
      join journal_lines l on l.entry_id = e.id
      where e.org_id = ${org.orgId} and e.subsidiary_id = ${eliminationSubsidiaryId}
        and e.status in ('posted', 'reversed') and e.origin = 'intercompany'`));
    assert.deepEqual(proof.rows[0], {
      reversals: 1,
      effective_balance: "0.0000",
      ar_elimination: "-120.0000",
      ap_elimination: "120.0000",
    });

    // A non-netting intercompany residual must fail before creating or
    // reversing any elimination evidence.
    const brokenEntry = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
      values (${brokenEntry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'IC-BROKEN', ${org.date}, ${org.periodId}, 'Broken pair', 'draft', 'manual')`);
    await db.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
      values
        (${org.orgId}, ${brokenEntry}, 1, ${org.accounts.ar}, ${org.subsidiaryId}, '0.0001', 'CAD', '0.0001', '1'),
        (${org.orgId}, ${brokenEntry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, '-0.0001', 'CAD', '-0.0001', '1')`);
    await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${brokenEntry}`);
    await assert.rejects(
      runAutoElimination(org.orgId, org.periodId, actorId),
      /residual 0\.0001/,
    );
    const afterFailure = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_entries
       where org_id = ${org.orgId} and subsidiary_id = ${eliminationSubsidiaryId}
         and origin = 'intercompany' and status in ('posted', 'reversed')`));
    assert.equal(afterFailure.rows[0]!.n, 3);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("ownership consolidation uses exact period identity and reverses reruns", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const childId = randomUUID();
    const eliminationId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries
        (id,org_id,parent_id,name,base_currency,country,tax_ids,is_elimination,is_active,custom)
      values
        (${childId},${org.orgId},${org.subsidiaryId},'Owned Co','CAD','CA','{}'::jsonb,false,true,'{}'::jsonb),
        (${eliminationId},${org.orgId},${org.subsidiaryId},'Ownership eliminations','CAD','CA','{}'::jsonb,true,true,'{}'::jsonb)
    `);
    const defs = [
      ["investment", "1400", "Investment in subsidiary", "asset_current_other"],
      ["equityIncome", "4020", "Equity income", "income_other"],
      ["nciEquity", "3100", "Non-controlling interest", "equity"],
      ["nciIncome", "6100", "Profit attributable to NCI", "expense_other"],
      ["goodwill", "1500", "Goodwill", "asset_fixed"],
      ["fairValue", "1510", "Fair value adjustment", "asset_fixed"],
      ["childEquity", "3000", "Child share capital", "equity"],
    ] as const;
    const accounts = new Map<string, string>();
    for (const [key, number, name, type] of defs) {
      const id = randomUUID();
      accounts.set(key, id);
      await db.execute(sql`
        insert into accounts
          (id,org_id,number,name,type,is_summary,is_active,eliminate,reconcilable,required_dimensions,custom,subsidiary_include_children)
        values (${id},${org.orgId},${number},${name},${type},false,true,false,false,'[]'::jsonb,'{}'::jsonb,true)
      `);
    }
    const capital = randomUUID();
    const profit = randomUUID();
    const adjustmentProfit = randomUUID();
    const calendar = (await db.execute<{ fiscal_calendar_id: string }>(sql`
      select fiscal_calendar_id
        from accounting_periods
       where id = ${org.periodId}
    `));
    const adjustmentPeriodId = randomUUID();
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name,
         starts_on, ends_on, is_adjustment, custom)
      values (
        ${adjustmentPeriodId}, ${org.orgId},
        ${calendar.rows[0]!.fiscal_calendar_id},
        2026, 13, 'FY26 Adjustment', '2026-07-01', '2026-07-31', true,
        '{}'::jsonb
      )
    `);
    await db.execute(sql`
      insert into journal_entries
        (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,memo,status,origin)
      values
        (${capital},${org.orgId},${org.bookId},${childId},'OWN-CAP','2026-07-01',${org.periodId},'Opening equity','draft','manual'),
        (${profit},${org.orgId},${org.bookId},${childId},'OWN-PROFIT',${org.date},${org.periodId},'Period profit','draft','manual'),
        (${adjustmentProfit},${org.orgId},${org.bookId},${childId},'OWN-ADJUSTMENT',${org.date},${adjustmentPeriodId},'Adjustment-period profit','draft','manual')
    `);
    await db.execute(sql`
      insert into journal_lines
        (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
      values
        (${org.orgId},${capital},1,${org.accounts.bank},${childId},'1000','CAD','1000','1'),
        (${org.orgId},${capital},2,${accounts.get("childEquity")!},${childId},'-1000','CAD','-1000','1'),
        (${org.orgId},${profit},1,${org.accounts.bank},${childId},'100','CAD','100','1'),
        (${org.orgId},${profit},2,${org.accounts.revenue},${childId},'-100','CAD','-100','1'),
        (${org.orgId},${adjustmentProfit},1,${org.accounts.bank},${childId},'900','CAD','900','1'),
        (${org.orgId},${adjustmentProfit},2,${org.accounts.revenue},${childId},'-900','CAD','-900','1')
    `);
    await db.execute(sql`
      update journal_entries
         set status='posted', posted_at=now()
       where id in (${capital}, ${profit}, ${adjustmentProfit})
    `);
    const interestId = randomUUID();
    await db.execute(sql`
      insert into subsidiary_ownership_interests
        (id,org_id,parent_subsidiary_id,subsidiary_id,effective_from,ownership_percent,method,
         acquisition_date,acquisition_cost,fair_value_net_assets,acquisition_rate,nci_measurement,
         investment_account_id,equity_income_account_id,nci_equity_account_id,nci_income_account_id,
         goodwill_account_id,fair_value_adjustment_account_id)
      values (${interestId},${org.orgId},${org.subsidiaryId},${childId},'2026-07-01','80','full',
              '2026-07-01','900','1000','1','proportionate',${accounts.get("investment")!},
              ${accounts.get("equityIncome")!},${accounts.get("nciEquity")!},${accounts.get("nciIncome")!},
              ${accounts.get("goodwill")!},${accounts.get("fairValue")!})
    `);

    const first = await runOwnershipConsolidation(
      org.orgId,
      org.periodId,
      actorId,
    );
    assert.equal(first.entryIds.length, 2);
    const firstBalances = (await db.execute<{ number: string; amount: string }>(sql`
      select a.number,coalesce(sum(l.amount),0)::text amount
        from journal_lines l join journal_entries e on e.id=l.entry_id
        join accounts a on a.id=l.account_id
       where e.id=any(${`{${first.entryIds.join(",")}}`}::uuid[])
       group by a.number order by a.number
    `));
    assert.deepEqual(firstBalances.rows, [
      { number: "1400", amount: "-900.0000" },
      { number: "1500", amount: "100.0000" },
      { number: "3000", amount: "1000.0000" },
      { number: "3100", amount: "-220.0000" },
      { number: "6100", amount: "20.0000" },
    ]);
    const firstUnbalanced = (await db.execute(sql`
      select entry_id from journal_lines where entry_id=any(${`{${first.entryIds.join(",")}}`}::uuid[])
       group by entry_id having sum(amount)<>0
    `));
    assert.equal(firstUnbalanced.rows.length, 0);

    const second = await runOwnershipConsolidation(
      org.orgId,
      org.periodId,
      actorId,
    );
    assert.equal(second.entryIds.length, 4);
    const rerun = (await db.execute<{ reversals: number; replacements: number; balance: string }>(sql`
      select
        count(distinct e.id) filter (where oce.kind='reversal')::int reversals,
        count(distinct e.id) filter (where oce.kind<>'reversal')::int replacements,
        coalesce(sum(l.amount),0)::text balance
       from ownership_consolidation_entries oce
       join journal_entries e on e.id=oce.journal_entry_id
       join journal_lines l on l.entry_id=e.id
      where oce.run_id=${second.runId}
    `));
    assert.deepEqual(rerun.rows[0], { reversals: 2, replacements: 2, balance: "0.0000" });

    await assert.rejects(
      db.execute(sql`
        insert into subsidiary_ownership_interests
          (org_id,parent_subsidiary_id,subsidiary_id,effective_from,ownership_percent,method,acquisition_date,
           investment_account_id,equity_income_account_id,goodwill_account_id,fair_value_adjustment_account_id)
        values (${org.orgId},${org.subsidiaryId},${childId},'2026-07-15','100','full','2026-07-15',
                ${accounts.get("investment")!},${accounts.get("equityIncome")!},${accounts.get("goodwill")!},${accounts.get("fairValue")!})
      `),
      (error: any) => /overlap/.test(String(error?.cause?.message ?? error?.message)),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("derived consolidated FX refresh is all-or-nothing and respects manual overrides", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const usdSubsidiaryId = randomUUID();
    const eurSubsidiaryId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries
        (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values
        (${usdSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'US Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb),
        (${eurSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'Euro Co', 'EUR', 'DE', '{}'::jsonb, false, true, '{}'::jsonb)`);
    // Spot coverage for USD→CAD only, dated before the period so the average
    // falls back to the carried current rate. EUR→CAD has no spot history at
    // all — the API's wrapped derivation (web/app/api/consolidation drives
    // deriveConsolidatedRates inside withOrgTransaction) must refuse without
    // committing ANY pair, leaving no partially refreshed period behind.
    await db.execute(sql`
      insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
      values (${org.orgId}, 'USD', 'CAD', '2026-06-20', 'spot', '0.7300000000')`);

    await assert.rejects(
      withOrgTransaction(org.orgId, () => deriveConsolidatedRates(org.orgId, org.periodId)),
      /no spot rate for EUR→CAD/,
    );
    const partial = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from consolidated_fx_rates where org_id = ${org.orgId}`));
    assert.equal(partial.rows[0]!.n, 0);

    // With every needed pair covered, the same wrapped call commits the whole
    // period at once: current = latest spot on/before period end; average and
    // historical fall back to it when no in-period rates or prior period exist.
    await db.execute(sql`
      insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
      values (${org.orgId}, 'EUR', 'CAD', '2026-06-25', 'spot', '0.6600000000')`);
    const written = await withOrgTransaction(org.orgId, () =>
      deriveConsolidatedRates(org.orgId, org.periodId),
    );
    assert.equal(written, 2);
    const expected = [
      {
        from_currency: "EUR",
        current_rate: "0.6600000000",
        average_rate: "0.6600000000",
        historical_rate: "0.6600000000",
      },
      {
        from_currency: "USD",
        current_rate: "0.7300000000",
        average_rate: "0.7300000000",
        historical_rate: "0.7300000000",
      },
    ];
    const firstPass = (await db.execute<{
      from_currency: string;
      current_rate: string;
      average_rate: string;
      historical_rate: string;
    }>(sql`
      select from_currency, current_rate, average_rate, historical_rate
        from consolidated_fx_rates
       where org_id = ${org.orgId} and period_id = ${org.periodId}
       order by from_currency`));
    assert.deepEqual(firstPass.rows, expected);

    // A newer USD spot arrives, but a controller pins USD→CAD to 'manual':
    // the rerun refreshes derived pairs only and never touches pinned rows.
    await db.execute(sql`
      insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
      values (${org.orgId}, 'USD', 'CAD', '2026-06-28', 'spot', '0.7500000000')`);
    await db.execute(sql`
      update consolidated_fx_rates set source = 'manual'
       where org_id = ${org.orgId} and period_id = ${org.periodId} and from_currency = 'USD'`);
    const rewritten = await withOrgTransaction(org.orgId, () =>
      deriveConsolidatedRates(org.orgId, org.periodId),
    );
    assert.equal(rewritten, 2);
    const secondPass = (await db.execute<{
      from_currency: string;
      current_rate: string;
      average_rate: string;
      historical_rate: string;
    }>(sql`
      select from_currency, current_rate, average_rate, historical_rate
        from consolidated_fx_rates
       where org_id = ${org.orgId} and period_id = ${org.periodId}
       order by from_currency`));
    assert.deepEqual(secondPass.rows, expected);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
