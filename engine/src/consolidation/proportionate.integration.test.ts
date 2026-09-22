import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { runOwnershipConsolidation } from "./consolidation.ts";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * A 50%-owned child consolidated by the proportionate method: the product
 * offers proportionate as a first-class method (Setup options, reporting
 * weights, docs), so the ownership run must post the owned share of the
 * acquisition elimination — silently posting nothing leaves the parent's
 * investment and the subsidiary's equity double-counted.
 */
async function seedProportionateFixture(org: ScratchOrg): Promise<{
  childId: string;
  accounts: Map<string, string>;
}> {
  const childId = randomUUID();
  const eliminationId = randomUUID();
  await db.execute(sql`
      insert into subsidiaries
        (id,org_id,parent_id,name,base_currency,country,tax_ids,is_elimination,is_active,custom)
      values
        (${childId},${org.orgId},${org.subsidiaryId},'Joint Op Co','CAD','CA','{}'::jsonb,false,true,'{}'::jsonb),
        (${eliminationId},${org.orgId},${org.subsidiaryId},'Proportionate eliminations','CAD','CA','{}'::jsonb,true,true,'{}'::jsonb)
    `);
  const defs = [
    ["investment", "1400", "Investment in joint operation", "asset_current_other"],
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
  const profit = randomUUID();
  await db.execute(sql`
      insert into journal_entries
        (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,memo,status,origin)
      values
        (${capital},${org.orgId},${org.bookId},${childId},'PROP-CAP','2026-07-01',${org.periodId},'Opening equity','draft','manual'),
        (${profit},${org.orgId},${org.bookId},${childId},'PROP-PROFIT',${org.date},${org.periodId},'Period profit','draft','manual')
    `);
  await db.execute(sql`
      insert into journal_lines
        (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
      values
        (${org.orgId},${capital},1,${org.accounts.bank},${childId},'1000','CAD','1000','1'),
        (${org.orgId},${capital},2,${accounts.get("childEquity")!},${childId},'-1000','CAD','-1000','1'),
        (${org.orgId},${profit},1,${org.accounts.bank},${childId},'100','CAD','100','1'),
        (${org.orgId},${profit},2,${org.accounts.revenue},${childId},'-100','CAD','-100','1')
    `);
  await db.execute(sql`
      update journal_entries set status='posted', posted_at=now()
       where id in (${capital}, ${profit})
    `);
  const interestId = randomUUID();
  await db.execute(sql`
      insert into subsidiary_ownership_interests
        (id,org_id,parent_subsidiary_id,subsidiary_id,effective_from,ownership_percent,method,
         acquisition_date,acquisition_cost,fair_value_net_assets,acquisition_rate,nci_measurement,
         investment_account_id,equity_income_account_id,
         goodwill_account_id,fair_value_adjustment_account_id)
      values (${interestId},${org.orgId},${org.subsidiaryId},${childId},'2026-07-01','50','proportionate',
              '2026-07-01','550','1000','1','proportionate',${accounts.get("investment")!},
              ${accounts.get("equityIncome")!},
              ${accounts.get("goodwill")!},${accounts.get("fairValue")!})
    `);
  return { childId, accounts };
}

test("ownership consolidation eliminates the owned share of a proportionate acquisition", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await seedProportionateFixture(org);

    const run = await runOwnershipConsolidation(org.orgId, org.periodId, actorId);
    // One acquisition entry only: the reporting layer already weights the
    // subsidiary's lines at the owned share, so there is no NCI allocation.
    assert.equal(run.entryIds.length, 1);
    const balances = (await db.execute<{ number: string; amount: string }>(sql`
      select a.number,coalesce(sum(l.amount),0)::text amount
        from journal_lines l join journal_entries e on e.id=l.entry_id
        join accounts a on a.id=l.account_id
       where e.id=any(${`{${run.entryIds.join(",")}}`}::uuid[])
       group by a.number order by a.number
    `));
    assert.deepEqual(balances.rows, [
      { number: "1400", amount: "-550.0000" },
      { number: "1500", amount: "50.0000" },
      { number: "3000", amount: "500.0000" },
    ]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("proportionate elimination absorbs the owned share of pre-acquisition retained earnings", { skip: !DB }, async () => {
  // Share capital 1000 + pre-acquisition revenue 400, bought 50% for 750
  // with FV net assets 1400: owned book is 700, owned FV is 700, so the FV
  // adjustment is zero and goodwill is 50. The owned 200 of pre-acq P&L is
  // eliminated as retained earnings. Before the fix the equity-only read
  // saw owned book 500 and posted a 200 FV adjustment, overstating assets.
  // Post-acquisition profit (100) must NOT be eliminated.
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const childId = randomUUID();
    const eliminationId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries
        (id,org_id,parent_id,name,base_currency,country,tax_ids,is_elimination,is_active,custom)
      values
        (${childId},${org.orgId},${org.subsidiaryId},'Joint Op Co','CAD','CA','{}'::jsonb,false,true,'{}'::jsonb),
        (${eliminationId},${org.orgId},${org.subsidiaryId},'Proportionate eliminations','CAD','CA','{}'::jsonb,true,true,'{}'::jsonb)
    `);
    const defs = [
      ["investment", "1400", "Investment in joint operation", "asset_current_other"],
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
    const postEntry = async (tag: string, debitAccount: string, creditAccount: string, amount: string, postingDate: string) => {
      const entry = randomUUID();
      await db.execute(sql`
        insert into journal_entries
          (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,memo,status,origin)
        values (${entry},${org.orgId},${org.bookId},${childId},${tag},${postingDate},${org.periodId},${tag},'draft','manual')`);
      await db.execute(sql`
        insert into journal_lines
          (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
        values
          (${org.orgId},${entry},1,${debitAccount},${childId},${amount},'CAD',${amount},'1'),
          (${org.orgId},${entry},2,${creditAccount},${childId},${"-" + amount},'CAD',${"-" + amount},'1')`);
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`);
    };
    await postEntry("PROP-CAP", org.accounts.bank, accounts.get("childEquity")!, "1000", "2026-07-01");
    await postEntry("PROP-PRE-REV", org.accounts.bank, org.accounts.revenue, "400", "2026-07-05");
    await postEntry("PROP-POST-REV", org.accounts.bank, org.accounts.revenue, "100", "2026-07-15");
    const interestId = randomUUID();
    await db.execute(sql`
      insert into subsidiary_ownership_interests
        (id,org_id,parent_subsidiary_id,subsidiary_id,effective_from,ownership_percent,method,
         acquisition_date,acquisition_cost,fair_value_net_assets,acquisition_rate,nci_measurement,
         investment_account_id,equity_income_account_id,
         goodwill_account_id,fair_value_adjustment_account_id)
      values (${interestId},${org.orgId},${org.subsidiaryId},${childId},'2026-07-10','50','proportionate',
              '2026-07-10','750','1400','1','proportionate',${accounts.get("investment")!},
              ${accounts.get("equityIncome")!},
              ${accounts.get("goodwill")!},${accounts.get("fairValue")!})
    `);
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
      { number: "1400", amount: "-750.0000" },
      { number: "1500", amount: "50.0000" },
      { number: "3000", amount: "500.0000" },
      { number: "4000", amount: "200.0000" },
    ]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
