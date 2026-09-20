import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  deriveConsolidatedRates,
  runOwnershipConsolidation,
} from "./consolidation.ts";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * neededPairs must cover every source currency into the elimination
 * subsidiary's currency: the ownership and auto-elimination phases translate
 * source activity into the elimination entity, which is almost never an
 * ancestor of its sources. With a EUR elimination entity under a CAD root
 * and a USD child, ancestor chains alone derive USD→CAD and EUR→CAD but
 * never USD→EUR — and "derive rates first" can never fix the refusal.
 */
async function seedEliminationCurrencyFixture(org: ScratchOrg): Promise<{
  childId: string;
}> {
  const childId = randomUUID();
  const eliminationId = randomUUID();
  await db.execute(sql`
      insert into subsidiaries
        (id,org_id,parent_id,name,base_currency,country,tax_ids,is_elimination,is_active,custom)
      values
        (${childId},${org.orgId},${org.subsidiaryId},'US Op Co','USD','US','{}'::jsonb,false,true,'{}'::jsonb),
        (${eliminationId},${org.orgId},${org.subsidiaryId},'Elimination EUR','EUR','DE','{}'::jsonb,true,true,'{}'::jsonb)
    `);
  const defs = [
    ["investment", "1400", "Investment in subsidiary", "asset_current_other"],
    ["equityIncome", "4020", "Equity income", "income_other"],
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
  await db.execute(sql`
      insert into journal_entries
        (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,memo,status,origin)
      values
        (${capital},${org.orgId},${org.bookId},${childId},'ELIMFX-CAP','2026-07-01',${org.periodId},'Opening equity','draft','manual')
    `);
  await db.execute(sql`
      insert into journal_lines
        (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
      values
        (${org.orgId},${capital},1,${org.accounts.bank},${childId},'1000','USD','1000','1'),
        (${org.orgId},${capital},2,${accounts.get("childEquity")!},${childId},'-1000','USD','-1000','1')
    `);
  await db.execute(sql`
      update journal_entries set status='posted', posted_at=now() where id=${capital}
    `);
  // Daily spots covering the ancestor pairs plus the source→elimination pair.
  for (const [from, to, rate] of [
    ["USD", "CAD", "1.3500000000"],
    ["EUR", "CAD", "1.4500000000"],
    ["USD", "EUR", "0.9300000000"],
    ["CAD", "EUR", "0.6896551724"],
  ] as const) {
    await db.execute(sql`
      insert into fx_rates (org_id,from_currency,to_currency,as_of,rate_type,rate,source)
      values (${org.orgId},${from},${to},'2026-07-15','spot',${rate},'manual')
    `);
  }
  const interestId = randomUUID();
  await db.execute(sql`
      insert into subsidiary_ownership_interests
        (id,org_id,parent_subsidiary_id,subsidiary_id,effective_from,ownership_percent,method,
         acquisition_date,acquisition_cost,fair_value_net_assets,acquisition_rate,nci_measurement,
         investment_account_id,equity_income_account_id,
         goodwill_account_id,fair_value_adjustment_account_id)
      values (${interestId},${org.orgId},${org.subsidiaryId},${childId},'2026-07-01','100','full',
              '2026-07-01','2100','2000','2','proportionate',${accounts.get("investment")!},
              ${accounts.get("equityIncome")!},
              ${accounts.get("goodwill")!},${accounts.get("fairValue")!})
    `);
  return { childId };
}

test("rate derivation covers source currencies into the elimination entity", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await seedEliminationCurrencyFixture(org);

    await deriveConsolidatedRates(org.orgId, org.periodId, actorId);
    const rates = (await db.execute<{ from_currency: string; to_currency: string }>(sql`
      select from_currency, to_currency from consolidated_fx_rates
       where org_id=${org.orgId} and period_id=${org.periodId}
    `)).rows.map((r) => `${r.from_currency}→${r.to_currency}`);
    assert.ok(rates.includes("USD→EUR"), `derived pairs cover the elimination entity (got ${rates.join(", ")})`);

    // And the ownership run that consumes the pair completes: USD 1000 of
    // acquisition-date equity at the policy rate 2 lands in EUR as 2000,
    // cost 2100 leaves goodwill 100.
    const run = await runOwnershipConsolidation(org.orgId, org.periodId, actorId);
    assert.equal(run.entryIds.length, 1);
    const balances = (await db.execute<{ number: string; amount: string }>(sql`
      select a.number,coalesce(sum(l.amount),0)::text amount
        from journal_lines l join journal_entries e on e.id=l.entry_id
        join accounts a on a.id=l.account_id
       where e.id=any(${`{${run.entryIds.join(",")}}`}::uuid[])
       group by a.number order by a.number
    `));
    assert.deepEqual(balances.rows, [
      { number: "1400", amount: "-2100.0000" },
      { number: "1500", amount: "100.0000" },
      { number: "3000", amount: "2000.0000" },
    ]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
