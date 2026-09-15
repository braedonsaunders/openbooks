import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { runOwnershipConsolidation } from "./consolidation.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from "./test-fixtures.ts";

/**
 * Ownership coverage gaps must fail closed. An ownership change is recorded
 * by closing the used policy and opening a new effective-dated one for the
 * SAME acquisition — a handover, so consecutive policies must be contiguous
 * (successor.from = predecessor.to + 1). The storage guard refuses overlaps
 * but not gaps, and the run windows profit per policy with no completeness
 * fence (unlike elimination's net-to-zero residual abort): a one-day
 * fat-finger gap silently excludes that day's profit from NCI and equity
 * income, and consolidation no longer ties to the subsidiary's P&L.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedGapFixture(org: ScratchOrg): Promise<{ childId: string; accounts: Map<string, string> }> {
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
  const postEntry = async (tag: string, date: string, revenue: string): Promise<void> => {
    const entry = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,memo,status,origin)
      values (${entry},${org.orgId},${org.bookId},${childId},${tag},${date},${org.periodId},${tag},'draft','manual')`);
    await db.execute(sql`
      insert into journal_lines
        (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
      values
        (${org.orgId},${entry},1,${org.accounts.bank},${childId},${revenue},'CAD',${revenue},'1'),
        (${org.orgId},${entry},2,${org.accounts.revenue},${childId},${`-${revenue}`},'CAD',${`-${revenue}`},'1')`);
    await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`);
  };
  // Opening equity plus covered profit (Jul 15) plus gap-day profit (Jul 30).
  const capId = randomUUID();
  await db.execute(sql`
      insert into journal_entries
        (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,memo,status,origin)
      values (${capId},${org.orgId},${org.bookId},${childId},'OWN-CAP','2026-07-01',${org.periodId},'OWN-CAP','draft','manual')`);
  await db.execute(sql`
      insert into journal_lines
        (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
      values
        (${org.orgId},${capId},1,${org.accounts.bank},${childId},'1000','CAD','1000','1'),
        (${org.orgId},${capId},2,${accounts.get("childEquity")!},${childId},'-1000','CAD','-1000','1')`);
  await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${capId}`);
  await postEntry("OWN-PROFIT-COVERED", "2026-07-15", "100");
  await postEntry("OWN-PROFIT-GAP", "2026-07-30", "100");
  // Policy A covers July 1–29; policy B takes over July 31 for the SAME
  // acquisition — July 30 belongs to no policy. Both rows are closable
  // because no consolidation has run yet.
  const policy = (id: string, from: string, to: string | null, percent: string): Promise<unknown> => db.execute(sql`
      insert into subsidiary_ownership_interests
        (id,org_id,parent_subsidiary_id,subsidiary_id,effective_from,effective_to,ownership_percent,method,
         acquisition_date,acquisition_cost,fair_value_net_assets,acquisition_rate,nci_measurement,
         investment_account_id,equity_income_account_id,nci_equity_account_id,nci_income_account_id,
         goodwill_account_id,fair_value_adjustment_account_id)
      values (${id},${org.orgId},${org.subsidiaryId},${childId},${from},${to},${percent},'full',
              '2026-07-01','900','1000','1','proportionate',${accounts.get("investment")!},
              ${accounts.get("equityIncome")!},${accounts.get("nciEquity")!},${accounts.get("nciIncome")!},
              ${accounts.get("goodwill")!},${accounts.get("fairValue")!})`);
  await policy(randomUUID(), "2026-07-01", "2026-07-29", "80");
  await policy(randomUUID(), "2026-07-31", null, "80");
  return { childId, accounts };
}

test("a same-acquisition coverage gap refuses consolidation instead of dropping the day", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await seedGapFixture(org);
    await assert.rejects(
      runOwnershipConsolidation(org.orgId, org.periodId, actorId),
      /ownership coverage for .* has a gap: the policy ending 2026-07-29.*2026-07-31/,
      "July 30 belongs to no policy: the run must refuse, not silently consolidate 30 of 31 days",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
