import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";
import { resolveProjectActualCosts, resolveProjectFinancials } from "./financials.ts";
import { db, withBypassContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

const fixedPrice = BUILTIN_PROJECT_TYPES.find((t) => t.key === "fixed_price")!.financialProfile;

async function seedProject(
  org: ScratchOrg,
  contractValue: string,
): Promise<{ project: string; customer: string }> {
  const customer = randomUUID();
  const project = randomUUID();
  await withBypassContext(() =>
    db.execute(
      sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active) values (${customer},${org.orgId},'customer','Profit Customer',${org.subsidiaryId},true)`,
    ),
  );
  await withBypassContext(() =>
    db.execute(
      sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,contract_value,status,is_active,custom) values (${project},${org.orgId},${org.subsidiaryId},'PROFIT','Profit job',${customer},${contractValue},'active',true,'{}'::jsonb)`,
    ),
  );
  return { project, customer };
}

test(
  "profit-to-date is zero with contract value but no posted revenue or cost",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
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
  },
);

test(
  "profit-to-date nets posted revenue against posted cost instead of pricing the contract",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const { project } = await seedProject(org, "8400");
      const entry = randomUUID();
      await withBypassContext(() =>
        db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
      values
        (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'PROFIT-1',
         ${org.date}, ${org.periodId}, 'PROFIT-1', 'draft', 'manual')`),
      );
      await withBypassContext(() =>
        db.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, project_id, amount, currency, txn_amount, fx_rate)
      values
        (${org.orgId}, ${entry}, 1, ${org.accounts.cogs}, ${org.subsidiaryId}, ${project}, '1000', 'CAD', '1000', '1'),
        (${org.orgId}, ${entry}, 2, ${org.accounts.ap}, ${org.subsidiaryId}, null, '-1000', 'CAD', '-1000', '1')`),
      );
      await withBypassContext(() =>
        db.execute(
          sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entry}`,
        ),
      );
      const costOnly = await resolveProjectFinancials(org.orgId, project, fixedPrice);
      assert.equal(costOnly.measures.actual_cost, "1000.0000");
      assert.equal(costOnly.measures.gross_profit, "-1000.0000");
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "actual cost carries approved-but-unposted labor and profit follows it",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const project = randomUUID();
      await withBypassContext(() =>
        db.execute(sql`
      insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
      values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'JOB-UNPOSTED', 'Unposted labor job', ${org.customerId}, 'active', true, '{}'::jsonb)`),
      );
      const employee = randomUUID();
      await withBypassContext(() =>
        db.execute(sql`
      insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${employee}, ${org.orgId}, 'employee', 'Site Worker', ${org.subsidiaryId}, true, '{}'::jsonb)`),
      );
      // Eight approved hours at $100/h never posted (standard-cost posting
      // off): $800 joins actual cost as the labelled unposted component.
      await withBypassContext(() =>
        db.execute(sql`
      insert into time_entries (id, org_id, employee_party_id, worked_on, hours, project_id, status,
                                costing_basis, is_billable, billing_status, cost_rate, custom)
      values (${randomUUID()}, ${org.orgId}, ${employee}, ${org.date}, '8.0000', ${project}, 'approved',
              'actual', true, 'unbilled', '100.0000', '{}'::jsonb)`),
      );
      // Four approved hours already posted: the stamp is the posting record, so
      // the $400 stays GL cost only and can never double-count into actuals.
      const stamp = randomUUID();
      await withBypassContext(() =>
        db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
      values
        (${stamp}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'LABOR-STAMP',
         ${org.date}, ${org.periodId}, 'LABOR-STAMP', 'draft', 'labor_burden')`),
      );
      await withBypassContext(() =>
        db.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, project_id, amount, currency, txn_amount, fx_rate)
      values
        (${org.orgId}, ${stamp}, 1, ${org.accounts.cogs}, ${org.subsidiaryId}, null, '1', 'CAD', '1', '1'),
        (${org.orgId}, ${stamp}, 2, ${org.accounts.ap}, ${org.subsidiaryId}, null, '-1', 'CAD', '-1', '1')`),
      );
      await withBypassContext(() =>
        db.execute(
          sql`update journal_entries set status = 'posted', posted_at = now() where id = ${stamp}`,
        ),
      );
      await withBypassContext(() =>
        db.execute(sql`
      insert into time_entries (id, org_id, employee_party_id, worked_on, hours, project_id, status,
                                costing_basis, is_billable, billing_status, cost_rate, cost_journal_entry_id, custom)
      values (${randomUUID()}, ${org.orgId}, ${employee}, ${org.date}, '4.0000', ${project}, 'approved',
              'actual', true, 'unbilled', '100.0000', ${stamp}, '{}'::jsonb)`),
      );
      const report = await resolveProjectFinancials(org.orgId, project, fixedPrice);
      assert.equal(report.measures.approved_unposted_labor, "800.0000");
      assert.equal(report.measures.actual_cost, "800.0000");
      assert.equal(report.measures.gross_profit, "-800.0000");
      // The projects list reads the same actual cost as the cockpit.
      const list = await resolveProjectActualCosts(org.orgId, [project]);
      assert.equal(list.costs.get(project), "800.0000");
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);
