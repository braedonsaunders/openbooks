import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext } from "../platform/db.ts";
import { installEngineSeams } from "../composition/install.ts";
import { actorHasPermission, actorIdentity } from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { BUILT_IN_ROLES } from "../organization/permissions.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { createTrainingCourse, listTrainingCourses } from "../hrm/training/store.ts";
import { createScriptJournal } from "../ledger/journal-writes.ts";
import { createScratchOrg, createScratchUser, dropSampleCloneOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { cloneSampleCompanyTemplate, createSampleCompany, SampleCompanyProvisioningError } from "./service.ts";
import { retireSampleFixtureCompanies } from "./retirement-test-fixtures.ts";

installEngineSeams();
const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
const authorityTables = ["users", "app_roles", "role_assignments", "user_permission_overrides"] as const;
type AuthoritySnapshot = Record<string, Array<{ id: string } & Record<string, unknown>>>;
async function authoritySnapshot(orgId: string): Promise<AuthoritySnapshot> {
  return withOrgContext(orgId, async () => {
    const result: AuthoritySnapshot = {};
    for (const table of authorityTables) result[table] = (await db.execute<{ id: string } & Record<string, unknown>>(sql`
      select * from ${sql.identifier(table)} where org_id=${orgId} order by id`)).rows;
    return result;
  });
}
function assertInheritedAuthority(before: AuthoritySnapshot, after: AuthoritySnapshot): void {
  for (const table of authorityTables) {
    const ids = new Set(before[table]!.map(row => row.id));
    assert.deepEqual(after[table]!.filter(row => ids.has(row.id)), before[table], `existing ${table} rows remain byte-for-byte values`);
  }
}

test("an ordinary member receives a fresh local preview administrator while inherited grants and resumed identities remain unchanged", enabled, async () => {
  const home = await withBypass(() => createScratchOrg());
  const source = await withBypass(() => createScratchOrg());
  let previewId: string | undefined;
  try {
    const memberUserId = await withBypass(() => createScratchUser(home.orgId, "Ordinary preview member", "viewer"));
    const legacyUserId = await withBypass(() => createScratchUser(source.orgId, "Legacy restricted administrator", "admin"));
    await withOrgContext(source.orgId, async () => {
      await db.execute(sql`insert into user_permission_overrides(org_id,user_id,permission,effect)
        values(${source.orgId},${legacyUserId},'gl.post','deny')`);
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{sampleTemplate}',
        '{"enabled":true,"profileId":"healthcare-practice","version":1}'::jsonb) where id=${source.orgId}`);
    });
    const homeBefore = await authoritySnapshot(home.orgId);
    const sourceBefore = await authoritySnapshot(source.orgId);
    assert.deepEqual(sourceBefore.app_roles!.find(role => role.key === "admin")!.permissions, []);
    assert.equal(sourceBefore.app_roles!.find(role => role.key === "admin")!.is_built_in, false);
    assert.equal(homeBefore.users!.find(user => user.id === memberUserId)!.is_super_admin, false);
    const input = { industryKey: "healthcare_practice", memberUserId, sourceOrgId: home.orgId, memberName: "Ordinary preview member", features: {} };
    const prepareTemplate = async () => ({ industryKey: input.industryKey, profileId: "healthcare-practice", templateOrgId: source.orgId,
      templateName: "Native healthcare authority fixture", generated: false,
      coverage: { documents: 0, postedEntries: 0, parties: 2, periods: 1, adminRoles: 1 } });
    let inherited: AuthoritySnapshot | undefined;
    await assert.rejects(createSampleCompany(input, {
      prepareTemplate,
      cloneCompany: async args => {
        const cloned = await cloneSampleCompanyTemplate(args);
        previewId = cloned.sandboxOrgId;
        inherited = await authoritySnapshot(previewId);
        return cloned;
      },
      reconcileNumbering: async () => { throw new Error("Numbering temporarily unavailable after actor finalization"); },
    }), (error: unknown) => error instanceof SampleCompanyProvisioningError && error.stage === "numbering");
    assert.ok(previewId && inherited);
    const orgId = previewId;
    const finalized = await withOrgContext(orgId, async () => (await db.execute<{ actorId: string; stage: string; access: number }>(sql`
      select settings->'sampleCompany'->>'finalizedBy' as "actorId",settings->'sampleCompany'->>'provisioningStage' as stage,
        (select count(*)::int from user_org_access where org_id=${orgId} and is_active) as access from orgs where id=${orgId}`)).rows[0]!);
    assert.equal(finalized.stage, "finalized");
    assert.equal(finalized.access, 0, "unfinished company is not exposed to the member");
    const finalizedAuthority = await authoritySnapshot(orgId);
    assertInheritedAuthority(inherited, finalizedAuthority);
    assert.equal(finalizedAuthority.users!.length, inherited.users!.length + 1);
    assert.equal(finalizedAuthority.app_roles!.length, inherited.app_roles!.length + 1);
    assert.equal(finalizedAuthority.role_assignments!.length, inherited.role_assignments!.length + 1);
    assert.equal(finalizedAuthority.user_permission_overrides!.length, inherited.user_permission_overrides!.length);
    const actor = finalizedAuthority.users!.find(user => user.id === finalized.actorId)!;
    const assigned = finalizedAuthority.role_assignments!.filter(grant => grant.user_id === actor.id);
    assert.equal(assigned.length, 1);
    const role = finalizedAuthority.app_roles!.find(row => row.id === assigned[0]!.role_id)!;
    assert.notEqual(role.key, "admin");
    assert.equal(role.is_built_in, false);
    assert.deepEqual(role.permissions, BUILT_IN_ROLES.admin!.permissions);
    assert.deepEqual(role.subsidiary_restriction, { mode: "all" });
    assert.equal(actor.is_super_admin, false);
    assert.equal(actor.password_hash, "sample-company-direct-login-disabled");
    assert.ok(actor.party_id, "native HRM authorship has a separate local person");

    const resumed = await createSampleCompany(input, { prepareTemplate });
    assert.equal(resumed.orgId, orgId);
    assert.deepEqual(await authoritySnapshot(orgId), finalizedAuthority, "resuming finalized setup creates no user, role or grant");
    const access = await withOrgContext(orgId, async () => (await db.execute<{ acting_user_id: string }>(sql`
      select a.acting_user_id from user_org_access a join users u on u.org_id=a.org_id and u.id=a.acting_user_id and u.is_active
      where a.org_id=${orgId} and a.member_user_id=${memberUserId} and a.is_active`)).rows);
    assert.deepEqual(access, [{ acting_user_id: actor.id }], "native member access resolves the dedicated actor independently of its role key");
    const again = await createSampleCompany(input, { prepareTemplate });
    assert.equal(again.created, false);
    assert.equal(again.orgId, orgId);
    assert.deepEqual(await authoritySnapshot(orgId), finalizedAuthority, "ready replay does not recreate or broaden authority");

    await withOrgContext(orgId, async () => {
      assert.deepEqual(await actorIdentity(db, orgId, actor.id), { isSuperAdmin: false, isActive: true });
      for (const permission of ["gl.post", "items.post", "hrm.certifications.manage", "admin.roles.manage"])
        assert.equal(await actorHasPermission(db, orgId, actor.id, permission), true);
      assert.equal(await actorAllowedSubsidiaryIds(db, orgId, actor.id), null);
      const audit = (await db.execute<{ table_name: string; before: unknown; member: string }>(sql`
        select table_name,changes->'before' as before,changes->>'memberUserId' as member from audit_log
        where org_id=${orgId} and actor_id=${actor.id} and changes->>'source'='sample_company_administrator_provisioning' order by table_name`)).rows;
      assert.deepEqual(audit, ["app_roles", "parties", "role_assignments", "users"].map(table_name => ({ table_name, before: null, member: memberUserId })));
    });
    assert.equal(await withOrgContext(home.orgId, () => actorHasPermission(db, home.orgId, actor.id, "gl.post")), false, "preview authority grants no home-company access");
    const subsidiaryId = await withOrgContext(orgId, async () => (await db.execute<{ id: string }>(sql`
      select id from subsidiaries where org_id=${orgId} and parent_id is null and is_active`)).rows[0]!.id);
    const courseInput = { orgId, actorId: actor.id, id: randomUUID(), subsidiaryId, code: "PREVIEW-TRAINING", version: 1,
      name: "Native preview training draft", description: "Synthetic training; grants no credential.", effectiveFrom: source.date, effectiveTo: null,
      qualificationTypeId: null, minimumAttendancePercent: 100, passingScore: 80, reason: "Exercise the ordinary member's new local administrator" };
    const legacyActor = inherited.users!.find(user => user.name === "Legacy restricted administrator")!;
    await assert.rejects(createTrainingCourse({ ...courseInput, actorId: legacyActor.id }), ScopeNotFoundError);
    const course = await createTrainingCourse(courseInput);
    assert.equal(course.status, "draft");
    assert.equal(course.authorPartyId, actor.party_id);
    assert.ok((await listTrainingCourses({ orgId, actorId: actor.id })).some(row => row.id === course.id));
    await assert.rejects(createTrainingCourse({ ...courseInput, id: randomUUID(), subsidiaryId: home.subsidiaryId }), ScopeNotFoundError);
    const journal = await withOrgContext(orgId, () => createScriptJournal(orgId, actor.id, {
      documentDate: source.date, subsidiaryId, memo: "Ordinary member native preview journal",
      lines: [{ accountCode: "1000", amount: "125.25" }, { accountCode: "5100", amount: "-125.25" }],
    }, { post: true }));
    assert.ok(journal.entryId && !journal.approvalPending);
    assert.deepEqual(await authoritySnapshot(home.orgId), homeBefore);
    assert.deepEqual(await authoritySnapshot(source.orgId), sourceBefore);
    assertInheritedAuthority(inherited, await authoritySnapshot(orgId));
  } finally {
    const targets = [...(previewId ? [previewId] : []), source.orgId];
    if (!await retireSampleFixtureCompanies(home.orgId, targets)) {
      if (previewId) await withBypass(() => dropSampleCloneOrg(previewId!));
      await withBypass(() => dropScratchOrg(source.orgId));
    }
    await withBypass(() => dropScratchOrg(home.orgId));
  }
});
