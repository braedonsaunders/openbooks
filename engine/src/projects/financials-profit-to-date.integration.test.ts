import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";
import { resolveProjectFinancials } from "./financials.ts";
import { db, withBypassContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

const fixedPrice = BUILTIN_PROJECT_TYPES.find((t) => t.key === "fixed_price")!.financialProfile;

async function seedProject(org: ScratchOrg, contractValue: string): Promise<{ project: string; customer: string }> {
  const customer = randomUUID();
  const project = randomUUID();
  await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active) values (${customer},${org.orgId},'customer','Profit Customer',${org.subsidiaryId},true)`));
  await withBypassContext(() => db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,contract_value,status,is_active,custom) values (${project},${org.orgId},${org.subsidiaryId},'PROFIT','Profit job',${customer},${contractValue},'active',true,'{}'::jsonb)`));
  return { project, customer };
}

test("profit-to-date is zero with contract value but no posted revenue or cost", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const { project } = await seedProject(org, "8400");
    const financials = await resolveProjectFinancials(org.orgId, project, fixedPrice);
    assert.equal(financials.measures.invoiced_to_date, "0.0000");
    assert.equal(financials.measures.actual_cost, "0.0000");
    assert.equal(financials.measures.gross_profit, "0.0000");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("profit-to-date nets posted revenue against posted cost instead of pricing the contract", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const { project } = await seedProject(org, "8400");
    const entry = randomUUID();
    await withBypassContext(() => db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
      values
        (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'PROFIT-1',
         ${org.date}, ${org.periodId}, 'PROFIT-1', 'draft', 'manual')`));
    await withBypassContext(() => db.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, project_id, amount, currency, txn_amount, fx_rate)
      values
        (${org.orgId}, ${entry}, 1, ${org.accounts.cogs}, ${org.subsidiaryId}, ${project}, '1000', 'CAD', '1000', '1'),
        (${org.orgId}, ${entry}, 2, ${org.accounts.ap}, ${org.subsidiaryId}, null, '-1000', 'CAD', '-1000', '1')`));
    await withBypassContext(() => db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`));
    const costOnly = await resolveProjectFinancials(org.orgId, project, fixedPrice);
    assert.equal(costOnly.measures.actual_cost, "1000.0000");
    assert.equal(costOnly.measures.gross_profit, "-1000.0000");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
