import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  ConsolidationError,
  deriveConsolidatedRates,
  runAutoElimination,
  runOwnershipConsolidation,
} from "./consolidation.ts";
import { db } from "./db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Consolidation's journal phases must honor the period-close fence at the
 * engine boundary, exactly like rate derivation already does: once the
 * period's GL is closed, re-running ownership or elimination must refuse
 * with a ConsolidationError (HTTP 422) instead of driving draft→posted
 * writes into the kernel guard and surfacing a raw Postgres failure.
 */
async function seedClosedPeriodFixture(org: ScratchOrg): Promise<void> {
  const childId = randomUUID();
  const eliminationId = randomUUID();
  await db.execute(sql`
      insert into subsidiaries
        (id,org_id,parent_id,name,base_currency,country,tax_ids,is_elimination,is_active,custom)
      values
        (${childId},${org.orgId},${org.subsidiaryId},'US Op Co','USD','US','{}'::jsonb,false,true,'{}'::jsonb),
        (${eliminationId},${org.orgId},${org.subsidiaryId},'Elimination','CAD','CA','{}'::jsonb,true,true,'{}'::jsonb)
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
        (${capital},${org.orgId},${org.bookId},${childId},'CLOSEDC-CAP','2026-07-01',${org.periodId},'Opening equity','draft','manual')
    `);
  await db.execute(sql`
      insert into journal_lines
        (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
      values
        (${org.orgId},${capital},1,${org.accounts.bank},${childId},'1000','USD','1000','1'),
        (${org.orgId},${capital},2,${accounts.get("childEquity")!},${childId},'-1000','USD','-1000','1')
    `);
  await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${capital}`);
  await db.execute(sql`
      insert into fx_rates (org_id,from_currency,to_currency,as_of,rate_type,rate,source)
      values (${org.orgId},'USD','CAD','2026-07-15','spot','1.3500000000','manual')
    `);
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
}

test("consolidation journal phases refuse a closed GL with ConsolidationError", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await seedClosedPeriodFixture(org);
    await deriveConsolidatedRates(org.orgId, org.periodId, actorId);
    const baseline = await runOwnershipConsolidation(org.orgId, org.periodId, actorId);
    assert.equal(baseline.entryIds.length, 1);

    await db.execute(sql`
      insert into period_locks (org_id, period_id, book_id, subsidiary_id, module, state, locked_at, reason)
      values (${org.orgId}, ${org.periodId}, ${org.bookId}, null, 'gl', 'closed', now(), 'controller sign-off')
    `);

    await assert.rejects(
      runOwnershipConsolidation(org.orgId, org.periodId, actorId),
      ConsolidationError,
      "ownership consolidation posts into a closed period instead of refusing",
    );
    await assert.rejects(
      runAutoElimination(org.orgId, org.periodId, actorId),
      ConsolidationError,
      "auto-elimination posts into a closed period instead of refusing",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
