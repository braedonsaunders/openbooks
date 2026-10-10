import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, orgContext, withBypass, withBypassContext, withOrgTransaction } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { assertSampleOperator, sampleOperatorId, sampleOperatorPermissions, sampleOperatorAuthorship, SampleLocalAuthorRequiredError, withSampleOperator } from "./operator.ts";

import { sampleRefreshPlan, refreshAllSampleCompanies } from "./refresh.ts";
import { SAMPLE_COMPANY_PROFILES } from "./catalog.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

test("sample operator selection is explicit and canonical", () => {
  assert.equal(sampleOperatorId({}), undefined);
  assert.equal(sampleOperatorId({ actorId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.throws(() => sampleOperatorId({ actorId: "admin" }), /explicit native user UUID/);
  assert.throws(() => sampleOperatorId({ actorId: "" }), /explicit native user UUID/);
});


test("native local authorship is required only for the industries that write tenant-owned author records", () => {
  const local = SAMPLE_COMPANY_PROFILES.filter(profile => sampleOperatorAuthorship(profile.industryKey).length).map(profile => profile.industryKey).sort();
  assert.deepEqual(local, ["general_business", "healthcare_practice", "nonprofit"]);
  assert.deepEqual(sampleOperatorAuthorship("general_business"), [{ table: "einvoice_settings", actorColumns: ["created_by", "updated_by"], requiresPerson: false }]);
  assert.ok(sampleOperatorAuthorship("nonprofit").some(contract => contract.actorColumns.includes("set_by")));
  assert.ok(sampleOperatorAuthorship("healthcare_practice").some(contract => contract.requiresPerson));
});


test("explicit sample authority preserves grants, denies and legal-entity scope", enabled, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Sample author", "sample_author"));
    const authorize = () => withSampleOperator(org.orgId, { actorId }, () => withOrgTransaction(org.orgId,
      () => assertSampleOperator(db, org.orgId, actorId, org.subsidiaryId, "general_business", true)));
    await assert.rejects(authorize(), /lacks admin.setup.manage/);
    await withBypass(() => db.execute(sql`update app_roles set permissions=${JSON.stringify(sampleOperatorPermissions("general_business"))}::jsonb where org_id=${org.orgId} and key='sample_author'`));
    const grants = () => withBypass(async () => (await db.execute(sql`select to_jsonb(r) as role from app_roles r where org_id=${org.orgId} order by id`)).rows);
    const before = await grants();
    await authorize();
    assert.deepEqual(await grants(), before, "authorization never upgrades stored role definitions");
    await withBypass(() => db.execute(sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values(${org.orgId},${actorId},'gl.post','deny')`));
    await assert.rejects(authorize(), /lacks gl.post/);
    await withBypass(async () => {
      await db.execute(sql`delete from user_permission_overrides where org_id=${org.orgId} and user_id=${actorId}`);
      await db.execute(sql`update app_roles set subsidiary_restriction='{"mode":"list","subsidiaryIds":[]}'::jsonb where org_id=${org.orgId} and key='sample_author'`);
    });
    await assert.rejects(authorize(), /legal entity/);
  } finally { await withBypass(() => dropScratchOrg(org.orgId)); }
});

test("explicit platform operator remains identity-locked while business writes stay tenant-scoped", enabled, async () => {
  const home = await withBypass(() => createScratchOrg());
  const target = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(home.orgId, "Platform operator", "operator"));
    const command = (fn: () => Promise<void>) => withSampleOperator(target.orgId, { actorId }, () => withOrgTransaction(target.orgId, fn));
    await assert.rejects(command(async () => {}), /active platform superadmin/);
    await withBypass(() => db.execute(sql`update users set is_super_admin=true where id=${actorId} and org_id=${home.orgId}`));
    await command(async () => {
      assert.equal(orgContext.getStore()?.bypass, false);
      assert.equal(orgContext.getStore()?.orgId, target.orgId);
      await assertSampleOperator(db, target.orgId, actorId, target.subsidiaryId, "engineering_architecture", true);
      await assert.rejects(withBypassContext(() => withBypass(async () => {
        await db.execute(sql`set local lock_timeout='100ms'`);
        await db.execute(sql`update users set is_active=false where id=${actorId} and org_id=${home.orgId}`);
      })), (error: unknown) => {
        const detail = error as { code?: string; cause?: { code?: string } };
        return (detail.code ?? detail.cause?.code) === "55P03";
      }, "home identity cannot be revoked halfway through the selected tenant command");
      for (const industry of ["general_business", "nonprofit", "healthcare_practice"]) {
        await assert.rejects(assertSampleOperator(db, target.orgId, actorId, target.subsidiaryId, industry, true), (error: unknown) =>
          error instanceof SampleLocalAuthorRequiredError && error.code === "SAMPLE_LOCAL_AUTHOR_REQUIRED" && error.industryKey === industry && error.requiredRecords.length > 0);
      }
    });
    await withBypass(() => db.execute(sql`update orgs set settings=settings || '{"simHarness":true,"sampleTemplate":{"enabled":true,"profileId":"engineering-architecture"}}'::jsonb where id=${target.orgId}`));
    const defaultPlan = await sampleRefreshPlan("engineering_architecture");
    const selectedPlan = await sampleRefreshPlan("engineering_architecture", { actorId });
    assert.ok(selectedPlan.targets.some(row => row.orgId === target.orgId));
    assert.notEqual(selectedPlan.digest, defaultPlan.digest, "the plan pins the explicitly selected platform author where native contracts permit it");
    await assert.rejects(refreshAllSampleCompanies({ industryKey: "engineering_architecture", digest: selectedPlan.digest }), /sample population changed/i);
    await withBypass(() => db.execute(sql`update users set is_active=false where id=${actorId} and org_id=${home.orgId}`));
    await assert.rejects(sampleRefreshPlan("engineering_architecture", { actorId }), /operator is unavailable/);
    await assert.rejects(command(async () => {}), /active platform superadmin/);
  } finally {
    await withBypass(() => dropScratchOrg(target.orgId));
    await withBypass(() => dropScratchOrg(home.orgId));
  }
});
