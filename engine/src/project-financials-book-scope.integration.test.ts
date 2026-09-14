import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";
import { resolveProjectFinancials } from "./project-financials.ts";
import { db } from "./db.ts";
import { sum } from "./money.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Parallel books are alternate representations of the same economics, so the
 * default project financials must pin the authoritative primary posting book
 * — the same contract the retainage balance (`projectRetainageHeldSql`),
 * cost-to-cost progress (`project-revenue.ts`), and the labor clearing drill
 * already enforce. An unqualified GL sum counts one event once per book
 * (revenue 100 in primary + tax reads back as 200).
 */

const profile = BUILTIN_PROJECT_TYPES.find((t) => t.key === "time_and_materials")!
  .financialProfile;

async function seedTwoBookProject(org: ScratchOrg): Promise<{ projectId: string; taxBookId: string }> {
  const taxBookId = randomUUID();
  await db.execute(sql`insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
    values (${taxBookId}, ${org.orgId}, 'TAX', 'Tax', false, true, true)`);
  const projectId = randomUUID();
  await db.execute(sql`
    insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
    values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'JOB-BOOK', 'Book scope job', ${org.customerId}, 'active', true, '{}'::jsonb)`);
  // The same economic event represented in BOTH books: revenue 100 + cost 100.
  for (const [bookId, tag] of [[org.bookId, "PRI"], [taxBookId, "TAX"]] as const) {
    const revId = randomUUID();
    const costId = randomUUID();
    await db.execute(sql`
      insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
      values (${revId}, ${org.orgId}, ${bookId}, ${org.subsidiaryId}, ${`${tag}-REV`}, ${org.date}, ${org.periodId}, 'rev', 'draft', 'manual'),
             (${costId}, ${org.orgId}, ${bookId}, ${org.subsidiaryId}, ${`${tag}-COST`}, ${org.date}, ${org.periodId}, 'cost', 'draft', 'manual')`);
    await db.execute(sql`
      insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, project_id, amount, currency, txn_amount, fx_rate)
      values (${org.orgId}, ${revId}, 1, ${org.accounts.revenue}, ${org.subsidiaryId}, ${projectId}, '-100', 'CAD', '-100', '1'),
             (${org.orgId}, ${revId}, 2, ${org.accounts.ar}, ${org.subsidiaryId}, null, '100', 'CAD', '100', '1'),
             (${org.orgId}, ${costId}, 1, ${org.accounts.cogs}, ${org.subsidiaryId}, ${projectId}, '100', 'CAD', '100', '1'),
             (${org.orgId}, ${costId}, 2, ${org.accounts.ap}, ${org.subsidiaryId}, null, '-100', 'CAD', '-100', '1')`);
    await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id in (${revId}, ${costId})`);
  }
  return { projectId, taxBookId };
}

test("default project financials count revenue and cost in the primary book once", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { projectId } = await seedTwoBookProject(org);
    const report = await resolveProjectFinancials(org.orgId, projectId, profile);
    assert.equal(report.measures.revenue_posted, "100.0000");
    assert.equal(report.measures.actual_cost, "100.0000");
    assert.equal(report.measures.total_cost, "100.0000");
    assert.equal(
      sum(report.costByAccount.map((row) => row.amount)),
      report.measures.actual_cost,
      "headline actual_cost must reconcile with its own account detail",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("payroll-JE labor cost counts the primary book once", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const { projectId } = await seedTwoBookProject(org);
    const laborProfile = { ...profile, laborCost: { source: "payroll_je" as const } };
    // Same burden event in both books: the cogs leg carries the project tag.
    for (const bookId of [org.bookId, (await db.execute<{ id: string }>(sql`
        select id from accounting_books where org_id = ${org.orgId} and code = 'TAX'`)).rows[0]!.id]) {
      const entryId = randomUUID();
      await db.execute(sql`
        insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
        values (${entryId}, ${org.orgId}, ${bookId}, ${org.subsidiaryId}, ${`BURDEN-${bookId}`}, ${org.date}, ${org.periodId}, 'burden', 'draft', 'labor_burden')`);
      await db.execute(sql`
        insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, project_id, amount, currency, txn_amount, fx_rate)
        values (${org.orgId}, ${entryId}, 1, ${org.accounts.cogs}, ${org.subsidiaryId}, ${projectId}, '60', 'CAD', '60', '1'),
               (${org.orgId}, ${entryId}, 2, ${org.accounts.clearing}, ${org.subsidiaryId}, null, '-60', 'CAD', '-60', '1')`);
      await db.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`);
    }
    const report = await resolveProjectFinancials(org.orgId, projectId, laborProfile);
    assert.equal(report.measures.labor_cost, "60.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
