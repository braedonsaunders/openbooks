import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { laborClearingReconciliation, postPayrollVariance } from "./labor-costing.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from "./test-fixtures.ts";

const enabled = !!process.env.OPENBOOKS_DB_URL;
const periodStart = "2026-07-01";
const periodEnd = "2026-07-31";

async function configure(org: ScratchOrg) {
  await db.execute(sql`update orgs set settings = jsonb_set(settings, '{controlAccounts}',
    (settings->'controlAccounts') || ${JSON.stringify({
      laborClearing: org.accounts.clearing,
      payrollVariance: org.accounts.freight,
    })}::jsonb) where id = ${org.orgId}`);
  return (await seedFlowActors(org.orgId)).adminId;
}

async function postFixtureJournal(org: ScratchOrg, actorId: string, bookId: string,
  origin: string, clearingAmount: string, projectId: string | null = null) {
  return db.transaction(async (tx) => {
    const id = randomUUID();
    await tx.execute(sql`insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id,
       status, origin, created_by, updated_by)
      values (${id}, ${org.orgId}, ${bookId}, ${org.subsidiaryId}, ${`FIX-${id}`},
        ${periodEnd}, ${org.periodId}, 'draft', ${origin}, ${actorId}, ${actorId})`);
    await tx.execute(sql`insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, amount,
       currency, txn_amount, fx_rate, project_id)
      values (${org.orgId}, ${id}, 1, ${org.accounts.clearing}, ${org.subsidiaryId},
        ${clearingAmount}, 'CAD', ${clearingAmount}, 1, null),
        (${org.orgId}, ${id}, 2, ${org.accounts.cogs}, ${org.subsidiaryId},
        -${clearingAmount}::numeric, 'CAD', -${clearingAmount}::numeric, 1, ${projectId})`);
    await tx.execute(sql`update journal_entries set status = 'posted', posted_at = now(),
      posted_by = ${actorId} where org_id = ${org.orgId} and id = ${id}`);
    return id;
  });
}

async function seedBooks(org: ScratchOrg, actorId: string) {
  const taxBookId = randomUUID();
  const projectId = randomUUID();
  await db.execute(sql`insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
    values (${taxBookId}, ${org.orgId}, 'TAX', 'Tax', false, true, true)`);
  await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status)
    values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'LAB-BOOK', 'Labor book scope', ${org.customerId}, 'active')`);
  for (const bookId of [org.bookId, taxBookId]) {
    await postFixtureJournal(org, actorId, bookId, "labor_burden", "-100", projectId);
    await postFixtureJournal(org, actorId, bookId, "payroll", "80");
  }
  return { taxBookId, projectId };
}

test("labor clearing totals and project drill include only the active posting primary book", { skip: !enabled }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await configure(org);
    const { projectId } = await seedBooks(org, actorId);
    const rec = await laborClearingReconciliation(org.orgId, periodStart, periodEnd, org.subsidiaryId);
    assert.ok(rec);
    assert.equal(rec.standardPosted, "100.0000");
    assert.equal(rec.payrollPosted, "80.0000");
    assert.equal(rec.periodVariance, "20.0000");
    assert.equal(rec.openBalance, "-20.0000");
    assert.equal(rec.currency, "CAD");
    assert.deepEqual(rec.perProject, [{ projectId, name: "Labor book scope", standard: "100.0000" }]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("payroll variance uses primary-book residue and preserves secondary-book variance history", { skip: !enabled }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await configure(org);
    const { taxBookId } = await seedBooks(org, actorId);
    const taxVarianceId = await postFixtureJournal(org, actorId, taxBookId, "payroll_variance", "7");
    const opts = { orgId: org.orgId, actorId, periodStart, periodEnd, subsidiaryId: org.subsidiaryId };
    const first = await postPayrollVariance(opts);
    assert.equal(first.variance, "20.0000");
    assert.ok(first.entryId);
    const posted = (await db.execute<{ book_id: string; amount: string }>(sql`
      select e.book_id, l.amount from journal_entries e join journal_lines l on l.entry_id=e.id and l.org_id=e.org_id
      where e.org_id=${org.orgId} and e.id=${first.entryId} and l.account_id=${org.accounts.clearing}`)).rows[0];
    assert.deepEqual(posted, { book_id: org.bookId, amount: "20.0000" });
    // Make the tax journal newer than primary variance to expose cross-book
    // prior lookup on a rerun, independently of timestamp tie ordering.
    const lateTaxVarianceId = await postFixtureJournal(org, actorId, taxBookId, "payroll_variance", "3");
    const second = await postPayrollVariance(opts);
    assert.equal(second.variance, "20.0000");
    assert.ok(second.entryId);
    const states = (await db.execute<{ id: string; status: string }>(sql`
      select id, status from journal_entries where org_id=${org.orgId}
      and id in (${taxVarianceId}, ${lateTaxVarianceId}, ${first.entryId}, ${second.entryId})`)).rows;
    assert.equal(states.find(row => row.id === taxVarianceId)?.status, "posted");
    assert.equal(states.find(row => row.id === lateTaxVarianceId)?.status, "posted");
    assert.equal(states.find(row => row.id === first.entryId)?.status, "reversed");
    assert.equal(states.find(row => row.id === second.entryId)?.status, "posted");
    const rec = await laborClearingReconciliation(org.orgId, periodStart, periodEnd, org.subsidiaryId);
    assert.equal(rec?.openBalance, "0.0000");
    assert.equal(rec?.periodVariance, "20.0000");
    const mirrors = (await db.execute<{ n: number }>(sql`select count(*)::int as n from journal_entries
      where org_id=${org.orgId} and book_id=${taxBookId} and reverses_entry_id is not null`)).rows[0];
    assert.equal(mirrors?.n, 0);
    await postFixtureJournal(org, actorId, org.bookId, "payroll", "20");
    assert.deepEqual(await postPayrollVariance(opts), { entryId: null, variance: "0" });
    assert.deepEqual(await postPayrollVariance(opts), { entryId: null, variance: "0" });
    const settled = await laborClearingReconciliation(org.orgId, periodStart, periodEnd, org.subsidiaryId);
    assert.equal(settled?.openBalance, "0.0000", "zero-variance reruns preserve the settled primary clearing balance");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

for (const policy of ["missing", "inactive", "non-posting", "ambiguous"] as const) {
  test(`labor reconciliation and variance reject ${policy} primary-book authority`, { skip: !enabled }, async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await configure(org);
      if (policy === "missing") await db.execute(sql`update accounting_books set is_primary=false where id=${org.bookId}`);
      if (policy === "inactive") await db.execute(sql`update accounting_books set is_active=false where id=${org.bookId}`);
      if (policy === "non-posting") await db.execute(sql`update accounting_books set posts_gl=false where id=${org.bookId}`);
      if (policy === "ambiguous") await db.execute(sql`insert into accounting_books (org_id, code, name, is_primary, is_active, posts_gl)
        values (${org.orgId}, 'OTHER', 'Other primary', true, true, true)`);
      await assert.rejects(() => laborClearingReconciliation(org.orgId, periodStart, periodEnd, org.subsidiaryId), /exactly one active posting primary GL book/);
      await assert.rejects(() => postPayrollVariance({ orgId: org.orgId, actorId, periodStart, periodEnd, subsidiaryId: org.subsidiaryId }), /exactly one active posting primary GL book/);
      const entries = (await db.execute<{ n: number }>(sql`select count(*)::int as n from journal_entries where org_id=${org.orgId}`)).rows[0];
      assert.equal(entries?.n, 0);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });
}
