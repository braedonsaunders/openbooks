import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext } from "../platform/db.ts";
import { installEngineSeams } from "../composition/install.ts";
import { provisionOrg, wipeSimOrg } from "../sim/world.ts";
import { getProfile } from "../sim/profiles/index.ts";
import { createScratchOrg, createScratchUser, dropSampleCloneOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { createSampleCompany } from "./service.ts";
import { installDemoScenarios, DEMO_DATA_VERSION, verifyDemoScenarios } from "./install-scenarios.ts";
import { refreshAllSampleCompanies, refreshSampleCompany, sampleRefreshPlan } from "./refresh.ts";
import { SampleLocalAuthorRequiredError } from "./operator.ts";
import { scenarioRecordId } from "./scenarios.ts";
import { sampleCompanyFeatures } from "./features.ts";

installEngineSeams();
const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

test("native exploration refresh preserves rebased posted history, member drafts and unrelated feature choices", enabled, async () => {
  const master = await provisionOrg(getProfile("general-business"), { startDate: "2026-01-01", endDate: "2027-12-31" });
  const home = await withBypass(() => createScratchOrg());
  let memberOrgId: string | undefined;
  try {
    const memberUserId = await withBypass(() => createScratchUser(home.orgId, "Sample reviewer", "admin"));
    await installDemoScenarios(master.orgId, "general_business");
    // Model a previously published source version while retaining genuine native history.
    await withOrgContext(master.orgId, () => db.execute(sql`update orgs set settings=jsonb_set(jsonb_set(settings,'{sampleTemplate}',
      '{"enabled":true,"profileId":"general-business","version":1}'::jsonb),'{demoData,version}','4'::jsonb) where id=${master.orgId}`));
    const draftMasterId = scenarioRecordId({ orgId: master.orgId }, "documents", "expense");
    const draftMasterLineId = scenarioRecordId({ orgId: master.orgId }, "document_lines", "expense");
    await withOrgContext(master.orgId, async () => {
      const actor = (await db.execute<{ id: string }>(sql`select id from users where org_id=${master.orgId} and is_active order by created_at,id limit 1`)).rows[0]!;
      await db.execute(sql`insert into user_org_access(member_user_id,org_id,acting_user_id) values(${memberUserId},${master.orgId},${actor.id})`);
      assert.equal((await db.execute(sql`update documents set memo='Operator revised master expense' where org_id=${master.orgId} and id=${draftMasterId} and status='draft' returning id`)).rows.length, 1);
      assert.equal((await db.execute(sql`update document_lines set description='Operator retained receipt detail' where org_id=${master.orgId} and id=${draftMasterLineId} returning id`)).rows.length, 1);
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{onboarding}','{"setupComplete":false,"customReview":"retained"}'::jsonb) where id=${master.orgId}`);
    });
    const masterDraft = () => withOrgContext(master.orgId, async () => (await db.execute(sql`
      select to_jsonb(d) as document,to_jsonb(l) as line,o.settings->'onboarding' as onboarding
      from documents d join document_lines l on l.org_id=d.org_id and l.document_id=d.id
      join orgs o on o.id=d.org_id where d.org_id=${master.orgId} and d.id=${draftMasterId} and l.id=${draftMasterLineId}`)).rows);
    const masterDraftBefore = await masterDraft();
    const masterRefresh = await refreshSampleCompany(master.orgId, "general_business");
    assert.ok(masterRefresh.preservedRecords > masterRefresh.preservedEntries);
    assert.deepEqual(await masterDraft(), masterDraftBefore, "direct master access preserves operator document, line and configuration edits");
    // Keep clone provisioning on the legacy-source restoration branch.
    await withOrgContext(master.orgId, () => db.execute(sql`update orgs set settings=jsonb_set(settings,'{demoData,version}','4'::jsonb) where id=${master.orgId}`));
    const company = await createSampleCompany({ industryKey: "general_business", memberUserId, sourceOrgId: home.orgId,
      memberName: "Sample reviewer", features: sampleCompanyFeatures("general_business") }, {
      prepareTemplate: async () => ({ industryKey: "general_business", profileId: "general-business", templateOrgId: master.orgId,
        templateName: "Cedar & Stone Supply Co.", generated: false,
        coverage: { documents: 100, postedEntries: 60, parties: 16, periods: 24, adminRoles: 1 } }),
    });
    memberOrgId = company.orgId;
    const orgId = memberOrgId;
    const signedOffMatches = (tenantId: string) => withOrgContext(tenantId, async () =>
      (await db.execute<{ matches: number; invalid: number }>(sql`
        select count(*)::int as matches,count(*) filter(where
          jl.org_id is distinct from m.org_id or jl.account_id is distinct from r.account_id
          or jl.currency is distinct from r.currency or jl.reconciliation_id is distinct from r.id
          or jl.reconciled_at is null or je.posting_date>r.through_date
          or sl.org_id is distinct from m.org_id or sl.account_id is distinct from r.account_id
          or sl.currency is distinct from r.currency or sl.posted_on>r.through_date)::int as invalid
        from reconciliation_matches m join reconciliations r on r.org_id=m.org_id and r.id=m.reconciliation_id
        join journal_lines jl on jl.org_id=m.org_id and jl.id=m.journal_line_id
        join journal_entries je on je.org_id=m.org_id and je.id=jl.entry_id
        join bank_statement_lines sl on sl.org_id=m.org_id and sl.id=m.statement_line_id
        where m.org_id=${tenantId} and r.status='signed_off'`)).rows[0]!);
    const sourceMatches = await signedOffMatches(master.orgId);
    assert.ok(sourceMatches.matches >= 4, "native source contains signed-off bank evidence to preserve");
    assert.equal(sourceMatches.invalid, 0);
    assert.deepEqual(await signedOffMatches(orgId), sourceMatches,
      "exploration copies preserve signed-off match counts and exact native journal ownership");
    const identity = await withOrgContext(orgId, async () => (await db.execute<{ seed: string }>(sql`select sandbox_seed::text as seed from orgs where id=${orgId}`)).rows[0]!);
    const draftId = scenarioRecordId({ orgId, identitySourceOrgId: master.orgId, identitySeed: identity.seed }, "documents", "operations-quote-3");
    await withOrgContext(orgId, async () => {
      await db.execute(sql`update documents set memo='Member-owned scope revision' where org_id=${orgId} and id=${draftId} and status='draft'`);
      await db.execute(sql`update orgs set settings=jsonb_set(jsonb_set(settings,'{features,projects}','true'::jsonb),'{features,payroll}','false'::jsonb) where id=${orgId}`);
    });
    const snapshot = () => withOrgContext(orgId, async () => (await db.execute<{ id: string; digest: string }>(sql`
      select e.id,md5(to_jsonb(e)::text || coalesce((select jsonb_agg(to_jsonb(l) order by l.id)::text from journal_lines l where l.org_id=e.org_id and l.entry_id=e.id),'[]')) as digest
      from journal_entries e where e.org_id=${orgId} and e.status in ('posted','reversed') order by e.id`)).rows);
    const before = await snapshot();
    assert.ok(before.length > 40, "the preservation proof needs substantial real posted history");
    const plan = await sampleRefreshPlan("general_business");
    const operator = await withBypass(() => createScratchUser(home.orgId, "Explicit sample operator", "platform_operator"));
    await withBypass(() => db.execute(sql`update users set is_super_admin=true where id=${operator} and org_id=${home.orgId}`));
    await assert.rejects(sampleRefreshPlan("general_business", { actorId: operator }), SampleLocalAuthorRequiredError);
    await assert.rejects(refreshSampleCompany(orgId, "general_business", { actorId: operator }), SampleLocalAuthorRequiredError);
    assert.deepEqual(await snapshot(), before, "foreign-author refusal preserves all inherited posting before any refresh writes");

    assert.ok(plan.targets.some(target => target.orgId === orgId && target.kind === "member" && target.installedVersion === 4));
    assert.ok(!plan.targets.some(target => target.orgId === home.orgId));
    const refreshed = await refreshSampleCompany(orgId, "general_business");
    assert.equal(refreshed.preservedEntries, before.length);
    assert.ok(refreshed.preservedRecords > before.length);
    assert.equal(refreshed.version, DEMO_DATA_VERSION);
    assert.deepEqual(await snapshot(), before, "restoring clone-excluded configuration cannot rewrite or duplicate inherited posting");
    const inspected = await verifyDemoScenarios(orgId, "general_business");
    assert.deepEqual(inspected.missing, []);
    await withOrgContext(orgId, async () => {
      const row = (await db.execute<{ projects: boolean; payroll: boolean; memo: string }>(sql`select
        (o.settings->'features'->>'projects')::boolean as projects,(o.settings->'features'->>'payroll')::boolean as payroll,
        (select memo from documents where org_id=o.id and id=${draftId}) as memo from orgs o where o.id=${orgId}`)).rows[0]!;
      assert.deepEqual(row, { projects: true, payroll: false, memo: "Member-owned scope revision" });
    });
    assert.equal((await sampleRefreshPlan("general_business")).digest, plan.digest, "advancing a version leaves the reviewed membership resumable");
    await refreshSampleCompany(orgId, "general_business");
    assert.deepEqual(await snapshot(), before);
    await withBypass(() => db.execute(sql`update users set is_active=false where id=${operator} and org_id=${home.orgId}`));
    await assert.rejects(sampleRefreshPlan("general_business", { actorId: operator }), /operator is unavailable/);
    assert.deepEqual(await snapshot(), before, "revoked operator refuses without touching existing records");
    await assert.rejects(refreshAllSampleCompanies({ industryKey: "general_business", digest: "stale" }), /sample population changed/i);
  } finally {
    if (memberOrgId) await withBypass(() => dropSampleCloneOrg(memberOrgId!));
    await withBypass(() => dropScratchOrg(home.orgId));
    await wipeSimOrg(master.orgId);
  }
});
