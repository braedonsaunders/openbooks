import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { cmp } from "../money/money.ts";
import { installEngineSeams } from "../composition/install.ts";
import { db, withOrgContext, withBypass } from "../platform/db.ts";
import { provisionOrg, wipeSimOrg } from "../sim/world.ts";
import { getProfile } from "../sim/profiles/index.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { SAMPLE_COMPANY_PROFILES } from "./catalog.ts";
import { DEMO_DATA_VERSION, installDemoScenarios, verifyDemoScenarios } from "./install-scenarios.ts";
import { demoRecordId } from "./scenarios.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
installEngineSeams();

for (const profile of SAMPLE_COMPANY_PROFILES) test(`${profile.companyName}: native demo installation is complete, balanced, and idempotent`, enabled, async () => {
  const world = await provisionOrg(getProfile(profile.profileId), { startDate: "2026-01-01", endDate: "2027-12-31" });
  try {
    if (profile.industryKey === "general_business") await withOrgContext(world.orgId, async () => {
      const appId = demoRecordId(world.orgId, "apps", "main");
      await db.execute(sql`insert into apps(id,org_id,key,name,status,created_by,updated_by) values (${appId},${world.orgId},'demo-operations','Operations extension example','disabled',${world.actors.admin},${world.actors.admin})`);
      await db.execute(sql`insert into app_versions(id,org_id,app_id,version,manifest,status,created_by,updated_by) values (${demoRecordId(world.orgId,"app_versions","main")},${world.orgId},${appId},'1.0.0','{"name":"Earlier demonstration"}'::jsonb,'draft',${world.actors.admin},${world.actors.admin})`);
    });
    const result = await installDemoScenarios(world.orgId, profile.industryKey);
    assert.equal(result.version, DEMO_DATA_VERSION);
    assert.ok(result.inserted > 20);
    const verified = await verifyDemoScenarios(world.orgId, profile.industryKey);
    assert.deepEqual(verified.missing, []);
    assert.equal(verified.ready, true);
    if (profile.industryKey === "general_business") await withOrgContext(world.orgId, async () => {
      const versions = (await db.execute<{ version: string; manifest: Record<string, unknown> }>(sql`select version,manifest from app_versions where org_id=${world.orgId} and app_id=${demoRecordId(world.orgId,"apps","main")} order by version`)).rows;
      assert.equal(versions.length, 2, "package corrections append a new immutable revision");
      assert.deepEqual(versions[0]!.manifest, { name: "Earlier demonstration" });
      assert.equal(versions[1]!.version, "1.0.1");
    });
    const snapshot = () => withOrgContext(world.orgId, async () => (await db.execute(sql`
      select (select count(*)::int from audit_log where org_id=${world.orgId}) as audits,
             (select count(*)::int from journal_entries where org_id=${world.orgId}) as entries,
             (select count(*)::int from documents where org_id=${world.orgId}) as documents
    `)).rows[0]);
    const before = await snapshot();
    assert.equal((await installDemoScenarios(world.orgId, profile.industryKey)).inserted, 0);
    assert.deepEqual(await snapshot(), before, "a retry must neither post again nor claim another material change");
    if (profile.industryKey === "general_business") {
      await withOrgContext(world.orgId, async () => {
        await db.execute(sql`update orgs set env_kind='sandbox', settings=jsonb_set(settings,'{features,crm}','false'::jsonb) where id=${world.orgId}`);
      });
      const drifted = await verifyDemoScenarios(world.orgId, profile.industryKey);
      assert.equal(drifted.ready, false);
      assert.ok(drifted.missing.includes("authoritative industry feature settings"));
      assert.ok(drifted.missing.includes("preview environment protections"));
      await installDemoScenarios(world.orgId, profile.industryKey);
      assert.equal((await verifyDemoScenarios(world.orgId, profile.industryKey)).ready, true);
      const repaired = await snapshot();
      assert.equal(repaired.entries, before.entries, "configuration repair must not duplicate posting");
      assert.equal(repaired.documents, before.documents);
      assert.equal(repaired.audits, Number(before.audits) + 1, "configuration repair records its material change");
    }
    await withOrgContext(world.orgId, async () => {
      const unbalanced = await db.execute(sql`select entry_id from journal_lines where org_id=${world.orgId} group by entry_id having sum(amount) <> 0`);
      assert.equal(unbalanced.rows.length, 0, "every posted example must remain balanced");
      const cash = (await db.execute<{ amount: string }>(sql`select coalesce(sum(amount),0)::text as amount from journal_lines where org_id=${world.orgId} and account_id=${demoRecordId(world.orgId,"accounts","bank")}`)).rows[0]!;
      assert.equal(cmp(cash.amount, "99500.00"), 0, "bank statement balances must agree with the demonstration ledger");
      await db.execute(sql`delete from hrm_goals where org_id=${world.orgId}`);
    });
    if (verified.features.hrmPerformance) assert.equal((await verifyDemoScenarios(world.orgId, profile.industryKey)).ready, false, "metadata alone must never hide missing feature data");
  } finally { await wipeSimOrg(world.orgId); }
});

test("installer refuses an ordinary tenant before writing demo records", enabled, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await assert.rejects(installDemoScenarios(org.orgId, "general_business"), /only be installed into the matching synthetic master company/);
    await withOrgContext(org.orgId, async () => {
      assert.equal((await db.execute(sql`select id from parties where org_id=${org.orgId} and id=${demoRecordId(org.orgId,"parties","employee")}`)).rows.length, 0);
    });
  } finally { await withBypass(() => dropScratchOrg(org.orgId)); }
});

test("a refused scenario installation rolls back earlier records, settings, and postings", enabled, async () => {
  const world = await provisionOrg(getProfile("general-business"), { startDate: "2026-01-01", endDate: "2027-12-31" });
  try {
    await withOrgContext(world.orgId, () => db.execute(sql`insert into accounts(org_id,number,name,type) values (${world.orgId},'1098','Existing operating bank','asset_bank')`));
    await assert.rejects(installDemoScenarios(world.orgId, "general_business"), (error: unknown) => {
      assert.equal((error as { cause?: { code?: string } }).cause?.code, "23505");
      return true;
    });
    await withOrgContext(world.orgId, async () => {
      const result = await db.execute(sql`
        select (select count(*)::int from accounts where org_id=${world.orgId} and id=${demoRecordId(world.orgId,"accounts","capital")}) as capital,
               (select count(*)::int from documents where org_id=${world.orgId} and idempotency_key like 'industry-demo:%') as posted,
               (select count(*)::int from audit_log where org_id=${world.orgId} and changes->>'source'='industry_demo_installation') as audits,
               settings ? 'demoData' as registered from orgs where id=${world.orgId}
      `);
      assert.deepEqual(result.rows[0], { capital: 0, posted: 0, audits: 0, registered: false });
    });
  } finally { await wipeSimOrg(world.orgId); }
});

test("demo preparation extends fully closed history without reopening it", enabled, async () => {
  const world = await provisionOrg(getProfile("general-business"), { startDate: "2026-01-01", endDate: "2026-12-31" });
  try {
    await withOrgContext(world.orgId, () => db.execute(sql`
      insert into period_locks(org_id,period_id,book_id,module,state,reason)
      select p.org_id,p.id,b.id,'gl','closed','Completed prior demonstration year'
      from accounting_periods p join accounting_books b on b.org_id=p.org_id and b.is_primary where p.org_id=${world.orgId}
    `));
    await installDemoScenarios(world.orgId, "general_business");
    await withOrgContext(world.orgId, async () => {
      const old = (await db.execute<{ total: number; closed: number }>(sql`
        select count(*)::int as total, count(*) filter(where lock.state='closed')::int as closed
        from accounting_periods p join period_locks lock on lock.period_id=p.id and lock.org_id=p.org_id
        where p.org_id=${world.orgId} and p.fiscal_year=2026 and lock.module='gl'
      `)).rows[0]!;
      assert.equal(old.total, 12); assert.equal(old.closed, old.total);
      assert.equal((await db.execute(sql`select 1 from accounting_periods where org_id=${world.orgId} and fiscal_year=2027`)).rows.length, 12);
      const future = await db.execute(sql`select 1 from documents where org_id=${world.orgId} and idempotency_key like 'industry-demo:%' and document_date >= '2027-01-01' and status='posted'`);
      assert.equal(future.rows.length, 2);
    });
  } finally { await wipeSimOrg(world.orgId); }
});
