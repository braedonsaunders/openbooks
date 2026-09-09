import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { syncProjectRevenueContracts } from "./project-revenue.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "./test-fixtures.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

async function projectFixture(org: ScratchOrg, subsidiaryId: string | null = org.subsidiaryId) {
  const projectId = randomUUID(), typeId = randomUUID();
  await db.execute(sql`update orgs set settings=settings || ${JSON.stringify({
    features: { projects: true, revenueRecognition: true },
    controlAccounts: { unbilledReceivable: org.accounts.ar, projectRevenue: org.accounts.revenue },
  })}::jsonb where id=${org.orgId}`);
  await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
    values(${typeId},${org.orgId},'cost-poc','Cost POC','fixed_price',
      '{"recognition":"percent_complete_cost","billingProcedure":"standard"}'::jsonb,'{}'::jsonb)`);
  await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active,starts_on,contract_value)
    values(${projectId},${org.orgId},${subsidiaryId},'COST-POC','Cost POC project',${org.customerId},${typeId},'active',true,${org.date},1000)`);
  await db.execute(sql`insert into project_tasks(org_id,project_id,name,estimated_cost)
    values(${org.orgId},${projectId},'Budget',1000)`);
  return projectId;
}

async function cost(org: ScratchOrg, projectId: string, amount: string, options: {
  bookId?: string; subsidiaryId?: string; date?: string; txnAmount?: string; fxRate?: string; currency?: string;
  status?: "posted" | "reversed" | "draft";
} = {}) {
  const id = randomUUID();
  const subsidiaryId = options.subsidiaryId ?? org.subsidiaryId;
  await db.transaction(async tx => {
    await tx.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status)
      values(${id},${org.orgId},${options.bookId ?? org.bookId},${subsidiaryId},${id},${options.date ?? org.date},${org.periodId},'draft')`);
    await tx.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,project_id,amount,currency,txn_amount,fx_rate)
      values(${org.orgId},${id},1,${org.accounts.cogs},${subsidiaryId},${projectId},${amount},${options.currency ?? 'CAD'},${options.txnAmount ?? amount},${options.fxRate ?? '1'}),
        (${org.orgId},${id},2,${org.accounts.bank},${subsidiaryId},${projectId},-${amount}::numeric,${options.currency ?? 'CAD'},-${options.txnAmount ?? amount}::numeric,${options.fxRate ?? '1'})`);
    await tx.execute(sql`update journal_entries set status=${options.status ?? 'posted'} where org_id=${org.orgId} and id=${id}`);
  });
}

async function snapshot(orgId: string) {
  return (await db.execute<{ evidence: unknown }>(sql`select jsonb_build_object(
    'rules',(select jsonb_agg(to_jsonb(r) order by r.id) from recognition_rules r where org_id=${orgId}),
    'contracts',(select jsonb_agg(to_jsonb(c) order by c.id) from revenue_contracts c where org_id=${orgId}),
    'obligations',(select jsonb_agg(to_jsonb(o) order by o.id) from performance_obligations o where org_id=${orgId}),
    'schedules',(select jsonb_agg(to_jsonb(s) order by s.id) from recognition_schedules s where org_id=${orgId}),
    'lines',(select jsonb_agg(to_jsonb(s) order by s.id) from recognition_schedule_lines s where org_id=${orgId})
  ) as evidence`)).rows[0]!.evidence;
}

test("project cost progress counts primary functional costs once and shares 25% across posting books", enabled, async () => {
  const org = await createScratchOrg();
  try {
    const projectId = await projectFixture(org), taxBook = randomUUID();
    await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl)
      values(${taxBook},${org.orgId},'TAX','Tax',false,true,true)`);
    await cost(org, projectId, "250", { txnAmount: "200", fxRate: "1.25", currency: "USD" });
    await cost(org, projectId, "250", { bookId: taxBook });
    const result = await syncProjectRevenueContracts(org.orgId, null, org.date, projectId);
    assert.deepEqual(result.problems, []);
    assert.equal(result.synced[0]?.percentComplete, "25.0000");
    const planned = (await db.execute<{ book_id: string; amount: string }>(sql`
      select s.book_id,sum(l.planned_amount)::text as amount from recognition_schedule_lines l
       join recognition_schedules s on s.id=l.schedule_id and s.org_id=l.org_id
       where l.org_id=${org.orgId} group by s.book_id order by s.book_id`)).rows;
    assert.deepEqual(planned, [org.bookId, taxBook].sort().map(book_id => ({ book_id, amount: "250.0000" })));
  } finally { await dropScratchOrg(org.orgId); }
});

test("project cost progress excludes other legal entities, drafts and future costs and nets reversals", enabled, async () => {
  const org = await createScratchOrg();
  try {
    const projectId = await projectFixture(org), other = randomUUID();
    await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
      values(${other},${org.orgId},${org.subsidiaryId},'Other entity','CAD','CA')`);
    await cost(org, projectId, "300", { status: "reversed" });
    await cost(org, projectId, "-50");
    await cost(org, projectId, "700", { subsidiaryId: other });
    await cost(org, projectId, "600", { date: "2026-07-20" });
    await cost(org, projectId, "500", { status: "draft" });
    const result = await syncProjectRevenueContracts(org.orgId, null, org.date, projectId);
    assert.deepEqual(result.problems, []);
    assert.equal(result.synced[0]?.percentComplete, "25.0000");
    const later = await syncProjectRevenueContracts(org.orgId, null, "2026-07-20", projectId);
    assert.equal(later.synced[0]?.percentComplete, "85.0000");
  } finally { await dropScratchOrg(org.orgId); }
});

test("project cost progress includes its entity's intercompany cost when the journal originates elsewhere", enabled, async () => {
  const org = await createScratchOrg();
  try {
    const projectId = await projectFixture(org), origin = randomUUID(), entry = randomUUID();
    await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
      values(${origin},${org.orgId},${org.subsidiaryId},'Paying entity','CAD','CA')`);
    await db.transaction(async tx => {
      await tx.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status)
        values(${entry},${org.orgId},${org.bookId},${origin},${entry},${org.date},${org.periodId},'draft')`);
      // The paying entity records cash and a due-from; the project entity
      // records its expense and due-to. Each entity balances independently.
      await tx.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,project_id,amount,currency,txn_amount)
        values(${org.orgId},${entry},1,${org.accounts.bank},${origin},null,-250,'CAD',-250),
          (${org.orgId},${entry},2,${org.accounts.ar},${origin},null,250,'CAD',250),
          (${org.orgId},${entry},3,${org.accounts.cogs},${org.subsidiaryId},${projectId},250,'CAD',250),
          (${org.orgId},${entry},4,${org.accounts.ap},${org.subsidiaryId},null,-250,'CAD',-250)`);
      await tx.execute(sql`update journal_entries set status='posted' where org_id=${org.orgId} and id=${entry}`);
    });
    const result = await syncProjectRevenueContracts(org.orgId, null, org.date, projectId);
    assert.deepEqual(result.problems, []);
    assert.equal(result.synced[0]?.percentComplete, "25.0000");
  } finally { await dropScratchOrg(org.orgId); }
});

for (const invalid of ["missing-primary", "inactive-primary", "nonposting-primary", "ambiguous-primary", "inactive-owner", "elimination-owner", "missing-root"] as const) {
  test(`project cost progress refuses ${invalid} without recognition writes`, enabled, async () => {
    const org = await createScratchOrg();
    try {
      const projectId = await projectFixture(org, invalid.endsWith("root") ? null : org.subsidiaryId);
      if (invalid === "missing-primary") await db.execute(sql`update accounting_books set is_primary=false where id=${org.bookId}`);
      if (invalid === "inactive-primary") await db.execute(sql`update accounting_books set is_active=false where id=${org.bookId}`);
      if (invalid === "nonposting-primary") await db.execute(sql`update accounting_books set posts_gl=false where id=${org.bookId}`);
      if (invalid === "ambiguous-primary") await db.execute(sql`insert into accounting_books(org_id,code,name,is_primary) values(${org.orgId},'OTHER','Other',true)`);
      if (invalid === "inactive-owner") {
        const inactive = randomUUID();
        await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,is_active)
          values(${inactive},${org.orgId},${org.subsidiaryId},'Inactive entity','CAD','CA',false)`);
        await db.execute(sql`update projects set subsidiary_id=${inactive} where id=${projectId}`);
      }
      if (invalid === "elimination-owner" || invalid === "missing-root") await db.execute(sql`update subsidiaries set is_elimination=true where id=${org.subsidiaryId}`);
      const before = await snapshot(org.orgId);
      const result = await syncProjectRevenueContracts(org.orgId, null, org.date, projectId);
      assert.equal(result.synced.length, 0);
      assert.equal(result.problems.length, 1);
      assert.match(result.problems[0]!, /authoritative|primary accounting book/);
      assert.deepEqual(await snapshot(org.orgId), before);
    } finally { await dropScratchOrg(org.orgId); }
  });
}

test("legacy owner resolves the unique root; authorized scope and manual progress remain intact", enabled, async () => {
  const org = await createScratchOrg();
  try {
    const projectId = await projectFixture(org, null);
    await cost(org, projectId, "250");
    const legacy = await syncProjectRevenueContracts(org.orgId, null, org.date, projectId);
    assert.deepEqual(legacy.problems, []);
    assert.equal(legacy.synced[0]?.percentComplete, "25.0000");
    const before = await snapshot(org.orgId);
    assert.deepEqual(await syncProjectRevenueContracts(org.orgId, null, org.date, projectId, []), { synced: [], problems: [] });
    assert.deepEqual(await snapshot(org.orgId), before);
    await db.execute(sql`update projects set custom='{"percentCompleteOverride":"40"}'::jsonb where id=${projectId}`);
    const manual = await syncProjectRevenueContracts(org.orgId, null, org.date, projectId);
    assert.equal(manual.synced[0]?.percentComplete, "40.0000");
    assert.equal(manual.synced[0]?.overridden, true);
  } finally { await dropScratchOrg(org.orgId); }
});
