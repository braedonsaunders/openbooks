import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { db } from "../platform/db.ts";
import { DB, setupHarness, withHarness, seedEmployment, setFeatures, grant } from "../testing/hrm-harness.ts";
import { seedPayrollSchedule, seedPayrollProfile } from "../testing/fixtures.ts";
import { createCompensationPackage, getCompensationPackage, saveCompensationPackageVersion, transitionCompensationPackageVersion,
  saveCompensationPackageAssignment, transitionCompensationPackageAssignment, updateCompensationPackage } from "./compensation-package-store.ts";
import type { CompensationPackageDefinition } from "./compensation-package.ts";
import { compensationPackageDefinitionHash } from "./compensation-package.ts";
import { createSandbox, deleteSandbox } from "../sandbox/lifecycle.ts";

const spec = { features: ["payroll", "hrm"], country: "CA", users: [
  { key: "authorId", name: "Package author", handle: "package_author", permissions: ["payroll.manage", "payroll.read", "hrm.compensation.approve"], link: true, partyKey: "authorPartyId" },
  { key: "approverId", name: "Independent approver", handle: "package_approver", permissions: ["hrm.compensation.approve", "payroll.read"], link: true, partyKey: "approverPartyId" },
  { key: "aliasId", name: "Author alternate login", handle: "package_alias", permissions: ["hrm.compensation.approve"], link: true },
  { key: "unlinkedId", name: "Unidentified approver", handle: "package_unlinked", permissions: ["hrm.compensation.approve"] },
] } as const;
async function setup() {
  return setupHarness(spec, async ({ org, authorId, authorPartyId, aliasId }) => {
    await db.execute(sql`update users set party_id=${authorPartyId} where org_id=${org.orgId} and id=${aliasId}`);
    const worker = await seedEmployment(org.orgId, org.subsidiaryId, { from: "2026-01-01" });
    const scheduleId = randomUUID();
    await seedPayrollSchedule(org.orgId, scheduleId, authorId, { name: "Monthly", frequency: "monthly", periodsPerYear: 12, anchorPeriodEnd: "2026-01-31", payDateOffsetDays: 1 });
    await seedPayrollProfile(org.orgId, worker.workerPartyId, worker.employmentId, scheduleId, authorId, { country: "CA", province: "ON", payBasis: "hourly" });
    const componentId = randomUUID();
    await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,basis,value,is_active)
      values(${componentId},${org.orgId},'PKG_TRAVEL','Travel allowance','earning','CA','fixed_amount','0',true)`);
    const pack = await createCompensationPackage({ orgId: org.orgId, actorId: authorId, subsidiaryId: org.subsidiaryId, code: "FIELD", name: "Field compensation", country: "CA", currency: "CAD", reason: "Declared employer package" });
    const definition: CompensationPackageDefinition = { orgId: org.orgId, country: "CA", currency: "CAD", partialPeriod: "allow",
      inputs: [{ name: "allowance", type: { kind: "money", currency: "CAD" }, source: "assignment", minimum: "0", maximum: "10000" }],
      rules: [{ key: "travel", componentId, expression: "allowance", proration: "calendar_days", rounding: { scale: 2, mode: "half_even", maxWholeDigits: 15 } }] };
    const version = await saveCompensationPackageVersion({ orgId: org.orgId, actorId: authorId, packageId: pack.id, effectiveFrom: "2026-01-01", effectiveTo: null, definition, reason: "Defined fixed allowance" });
    return { ...worker, scheduleId, componentId, pack, version, definition };
  });
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function approveVersion(f: Fixture) {
  const query = { orgId: f.org.orgId, packageId: f.pack.id, versionId: f.version.id, reason: "Independent policy review" };
  const submitted = await transitionCompensationPackageVersion({ ...query, actorId: f.authorId, expectedRevision: f.version.revision, action: "submit" });
  return transitionCompensationPackageVersion({ ...query, actorId: f.approverId, expectedRevision: submitted.revision, action: "approve" });
}
async function assignment(f: Fixture) {
  return saveCompensationPackageAssignment({ orgId: f.org.orgId, actorId: f.authorId, packageId: f.pack.id, versionId: f.version.id,
    employmentId: f.employmentId, effectiveFrom: "2026-01-01", effectiveTo: null, inputs: { allowance: "310.00" }, reason: "Employee package terms" });
}

test("package approval requires independent user and person identities, freezes terms and preserves complete audit", { skip: !DB }, async () => {
  await withHarness(setup, async (f) => {
    const base = { orgId: f.org.orgId, packageId: f.pack.id, versionId: f.version.id, reason: "Policy review" };
    const submitted = await transitionCompensationPackageVersion({ ...base, actorId: f.authorId, expectedRevision: 1, action: "submit" });
    for (const actorId of [f.authorId, f.aliasId]) await assert.rejects(transitionCompensationPackageVersion({ ...base, actorId, expectedRevision: submitted.revision, action: "approve" }), /author.*submitter.*independent approver/);
    await assert.rejects(transitionCompensationPackageVersion({ ...base, actorId: f.unlinkedId, expectedRevision: submitted.revision, action: "approve" }), /resolved person identity.*link/);
    const approved = await transitionCompensationPackageVersion({ ...base, actorId: f.approverId, expectedRevision: submitted.revision, action: "approve" });
    assert.equal(approved.status, "approved");
    assert.equal(approved.definitionHash, f.version.definitionHash);
    await assert.rejects(saveCompensationPackageVersion({ ...base, actorId: f.authorId, expectedRevision: approved.revision, definition: f.definition, effectiveFrom: "2026-01-01", effectiveTo: null }), /frozen.*new draft/);
    await assert.rejects(db.execute(sql`update payroll_compensation_versions set definition='{}'::jsonb,revision=revision+1 where org_id=${f.org.orgId} and id=${approved.id}`), (error: unknown) => error instanceof Error && error.cause instanceof Error && /Approved compensation history is immutable.*successor/.test(error.cause.message));
    const audits = (await db.execute<{ actorId: string; changes: { before: unknown; after: unknown; reason: string } }>(sql`select actor_id as "actorId",changes from audit_log where org_id=${f.org.orgId} and table_name='payroll_compensation_versions' and row_id=${approved.id} order by at,id`)).rows;
    assert.equal(audits.length, 3);
    assert.deepEqual(audits.map((row) => row.actorId), [f.authorId, f.authorId, f.approverId]);
    assert.ok(audits.every((row) => row.changes.after && row.changes.reason));
    assert.ok(audits[2]!.changes.before);
  });
});

test("assignment refusals preserve the register and approval excludes the affected employee", { skip: !DB }, async () => {
  await withHarness(setup, async (f) => {
    await assert.rejects(assignment(f), /approved package version/);
    await approveVersion(f);
    const input = { orgId: f.org.orgId, actorId: f.authorId, packageId: f.pack.id, versionId: f.version.id, employmentId: f.employmentId,
      effectiveFrom: "2026-01-01", effectiveTo: null, inputs: { allowance: "310.00" }, reason: "Employee terms" };
    await assert.rejects(saveCompensationPackageAssignment({ ...input, effectiveFrom: "2025-12-31" }), /approved version window/);
    await assert.rejects(saveCompensationPackageAssignment({ ...input, inputs: { allowance: "12,34" } }), /12.34/);
    await assert.rejects(saveCompensationPackageAssignment({ ...input, inputs: { allowance: "310", wage: "999" } }), /wage.*not employee-configurable.*native wage/);
    assert.equal((await getCompensationPackage({ orgId: f.org.orgId, actorId: f.authorId, packageId: f.pack.id })).assignments.length, 0);
    const saved = await assignment(f);
    const transition = { orgId: input.orgId, actorId: input.actorId, packageId: input.packageId, reason: input.reason };
    const submitted = await transitionCompensationPackageAssignment({ ...transition, assignmentId: saved.id, expectedRevision: saved.revision, action: "submit" });
    await db.execute(sql`update users set party_id=${f.workerPartyId} where org_id=${f.org.orgId} and id=${f.approverId}`);
    await assert.rejects(transitionCompensationPackageAssignment({ ...transition, actorId: f.approverId, assignmentId: saved.id, expectedRevision: submitted.revision, action: "approve" }), /affected employee.*independent/);
    await db.execute(sql`update users set party_id=${f.approverPartyId} where org_id=${f.org.orgId} and id=${f.approverId}`);
    const active = await transitionCompensationPackageAssignment({ ...transition, actorId: f.approverId, assignmentId: saved.id, expectedRevision: submitted.revision, action: "approve" });
    assert.equal(active.status, "active"); assert.deepEqual(active.inputs, { allowance: "310" });
    await assert.rejects(saveCompensationPackageAssignment({ ...input, assignmentId: saved.id, expectedRevision: active.revision, inputs: { allowance: "400" } }), /frozen.*successor/);
    const overlapping = await assignment(f);
    const proposal = await transitionCompensationPackageAssignment({ ...transition, assignmentId: overlapping.id, expectedRevision: overlapping.revision, action: "submit" });
    await assert.rejects(transitionCompensationPackageAssignment({ ...transition, actorId: f.approverId, assignmentId: proposal.id, expectedRevision: proposal.revision, action: "approve" }), /already has approved compensation.*end.*non-overlapping/);
    const ended = await transitionCompensationPackageAssignment({ ...transition, assignmentId: active.id, expectedRevision: active.revision, action: "end", effectiveTo: "2026-01-31" });
    assert.equal(ended.status, "ended"); assert.equal(ended.effectiveTo, "2026-01-31");
  });
});

test("configuration writes enforce freshness, tenant and employer scope, currency and feature state", { skip: !DB }, async () => {
  await withHarness(setup, async (f) => {
    const base = { orgId: f.org.orgId, actorId: f.authorId, packageId: f.pack.id, name: "Renamed package", description: null, retire: false, reason: "Clear operator name" };
    await assert.rejects(updateCompensationPackage({ ...base, expectedRevision: 0 }), /revision changed.*reload/);
    assert.equal((await getCompensationPackage(base)).package.name, "Field compensation");
    await assert.rejects(createCompensationPackage({ ...base, subsidiaryId: randomUUID(), code: "FOREIGN", country: "CA", currency: "CAD" }), /not found/);
    await setFeatures(f.org.orgId, { multiCurrency: false });
    await assert.rejects(createCompensationPackage({ ...base, subsidiaryId: f.org.subsidiaryId, code: "FX", country: "CA", currency: "EUR" }), /enabled currency.*Multi-currency/);
    await db.execute(sql`update app_roles set subsidiary_restriction='{"mode":"list","subsidiaryIds":[]}'::jsonb where org_id=${f.org.orgId} and key='package_author'`);
    await assert.rejects(getCompensationPackage(base), /not found/);
    await assert.rejects(updateCompensationPackage({ ...base, expectedRevision: 1 }), /not found/);
    await db.execute(sql`update app_roles set subsidiary_restriction='{"mode":"all"}'::jsonb where org_id=${f.org.orgId} and key='package_author'`);
    await setFeatures(f.org.orgId, { payroll: false });
    await assert.rejects(updateCompensationPackage({ ...base, expectedRevision: 1 }), /Payroll is disabled.*Company Settings/);
    await setFeatures(f.org.orgId, { payroll: true });
    const retired = await updateCompensationPackage({ ...base, expectedRevision: 1, retire: true });
    assert.equal(retired.status, "retired");
    assert.equal((await getCompensationPackage(base)).versions.length, 1);
  });
});

test("an older repeatable-read snapshot cannot acquire the changed compensation configuration as fresh", { skip: !DB }, async () => {
  await withHarness(setup, async (f) => {
    assert.ok(process.env.OPENBOOKS_TEST_ADMIN_DB_URL, "snapshot isolation proof requires the named isolated database admin URL");
    const client = new pg.Client({ connectionString: process.env.OPENBOOKS_TEST_ADMIN_DB_URL });
    await client.connect();
    try {
      await client.query("begin isolation level repeatable read");
      await client.query("select revision from payroll_compensation_configuration where org_id=$1", [f.org.orgId]);
      await updateCompensationPackage({ orgId: f.org.orgId, actorId: f.authorId, packageId: f.pack.id, expectedRevision: 1, name: "Changed policy name", description: null, retire: false, reason: "Configuration generation proof" });
      await assert.rejects(client.query("select revision from payroll_compensation_configuration where org_id=$1 for share", [f.org.orgId]), (error: unknown) => error instanceof Error && "code" in error && error.code === "40001");
    } finally { await client.query("rollback"); await client.end(); }
  });
});

test("an earlier editor cannot approve through a relinked login and authorship cannot be erased", { skip: !DB }, async () => {
  await withHarness(setup, async (f) => {
    await grant(f.org.orgId, f.approverId, "payroll.manage");
    const edited = await saveCompensationPackageVersion({ orgId: f.org.orgId, actorId: f.approverId, packageId: f.pack.id, versionId: f.version.id, expectedRevision: 1,
      definition: f.definition, effectiveFrom: "2026-01-01", effectiveTo: null, reason: "Additional policy author" });
    assert.equal(edited.authorship.length, 2);
    const submitted = await transitionCompensationPackageVersion({ orgId: f.org.orgId, actorId: f.authorId, packageId: f.pack.id, versionId: f.version.id,
      expectedRevision: edited.revision, action: "submit", reason: "Prepared for independent review" });
    await db.execute(sql`update users set party_id=${f.workerPartyId} where org_id=${f.org.orgId} and id=${f.approverId}`);
    await db.execute(sql`update users set party_id=${f.approverPartyId} where org_id=${f.org.orgId} and id=${f.aliasId}`);
    await assert.rejects(transitionCompensationPackageVersion({ orgId: f.org.orgId, actorId: f.aliasId, packageId: f.pack.id, versionId: f.version.id,
      expectedRevision: submitted.revision, action: "approve", reason: "Attempted alternate login" }), /author.*independent approver/);
    await assert.rejects(db.execute(sql`update payroll_compensation_versions set authorship='[]',revision=revision+1 where org_id=${f.org.orgId} and id=${f.version.id}`),
      (error: unknown) => error instanceof Error && error.cause instanceof Error && /Submitted compensation terms are frozen/.test(error.cause.message));
    const next = await saveCompensationPackageVersion({ orgId: f.org.orgId, actorId: f.authorId, packageId: f.pack.id,
      definition: f.definition, effectiveFrom: "2026-02-01", effectiveTo: null, reason: "New proposal for separate submission review" });
    const separateSubmitter = await transitionCompensationPackageVersion({ orgId: f.org.orgId, actorId: f.approverId,
      packageId: f.pack.id, versionId: next.id, expectedRevision: next.revision, action: "submit", reason: "Submission by a separate person" });
    assert.ok(separateSubmitter.authorship.some((row) => row.actorId === f.approverId && row.partyId === f.workerPartyId));
    await db.execute(sql`update users set party_id=${f.authorPartyId} where org_id=${f.org.orgId} and id=${f.approverId}`);
    await db.execute(sql`update users set party_id=${f.workerPartyId} where org_id=${f.org.orgId} and id=${f.aliasId}`);
    await assert.rejects(transitionCompensationPackageVersion({ orgId: f.org.orgId, actorId: f.aliasId, packageId: f.pack.id,
      versionId: next.id, expectedRevision: separateSubmitter.revision, action: "approve", reason: "Attempted submitter identity reuse" }), /submitter.*independent approver/);
  });
});

test("controlled full sandbox cloning preserves approved terms and rebinds only proven policy and authorship identities", { skip: !DB }, async () => {
  await withHarness(setup, async (f) => {
    await approveVersion(f);
    const saved = await assignment(f);
    const base = { orgId: f.org.orgId, packageId: f.pack.id, assignmentId: saved.id, reason: "Employee terms approval" };
    const submitted = await transitionCompensationPackageAssignment({ ...base, actorId: f.authorId, expectedRevision: saved.revision, action: "submit" });
    await transitionCompensationPackageAssignment({ ...base, actorId: f.approverId, expectedRevision: submitted.revision, action: "approve" });
    await db.execute(sql`update pay_component_earning_classifications set supplemental_wage_category='other' where org_id=${f.org.orgId} and pay_component_id=${f.componentId}`);
    const name = `Compensation copy ${randomUUID()}`;
    try {
      const sandbox = await createSandbox({ productionOrgId: f.org.orgId, name, tier: "full", masked: false });
      const cloned = (await db.execute<{ definition: CompensationPackageDefinition; definitionHash: string; status: string; authorship: { actorId: string; partyId: string | null }[] }>(sql`
        select definition,definition_hash as "definitionHash",status,authorship from payroll_compensation_versions where org_id=${sandbox.sandboxOrgId}`)).rows;
      assert.equal(cloned.length, 1);
      const version = cloned[0]!;
      assert.equal(version.status, "approved"); assert.equal(version.definition.orgId, sandbox.sandboxOrgId);
      assert.notEqual(version.definition.rules[0]!.componentId, f.componentId);
      assert.equal(version.definition.rules[0]!.expression, f.definition.rules[0]!.expression);
      assert.equal(version.definitionHash, compensationPackageDefinitionHash(version.definition));
      assert.equal((await db.execute<{ category: string }>(sql`select supplemental_wage_category as category from pay_component_earning_classifications
        where org_id=${sandbox.sandboxOrgId} and pay_component_id=${version.definition.rules[0]!.componentId}`)).rows[0]?.category, "other");
      assert.ok(version.authorship.every((author) => author.actorId !== f.authorId && author.partyId !== f.authorPartyId));
      const assignments = (await db.execute<{ status: string; inputs: unknown; employmentId: string }>(sql`select status,inputs,employment_id as "employmentId" from payroll_compensation_assignments where org_id=${sandbox.sandboxOrgId}`)).rows;
      assert.equal(assignments.length, 1); assert.equal(assignments[0]!.status, "active"); assert.deepEqual(assignments[0]!.inputs, { allowance: "310" });
      assert.notEqual(assignments[0]!.employmentId, f.employmentId);
      assert.equal((await db.execute(sql`select org_id from payroll_compensation_configuration where org_id=${sandbox.sandboxOrgId}`)).rows.length, 1);
    } finally {
      const shells = (await db.execute<{ id: string }>(sql`select id from sandboxes where production_org_id=${f.org.orgId} and name=${name}`)).rows;
      for (const shell of shells) await deleteSandbox(shell.id);
    }
  });
});

test("create retries match immutable evidence after edits and decisions and changed requests never create extra records", { skip: !DB }, async () => {
  await withHarness(setup, async (f) => {
    const create = { orgId: f.org.orgId, actorId: f.authorId, subsidiaryId: f.org.subsidiaryId, code: "RETRY", name: "Retry-safe package",
      country: "CA", currency: "CAD", reason: "Stable creation request", idempotencyKey: randomUUID() };
    const original = await createCompensationPackage(create);
    await updateCompensationPackage({ ...create, packageId: original.id, expectedRevision: original.revision, name: "Reviewed package name", description: null, retire: false });
    const replay = await createCompensationPackage(create);
    assert.equal(replay.id, original.id); assert.equal(replay.name, "Reviewed package name");
    await assert.rejects(createCompensationPackage({ ...create, name: "Changed request" }), /already saved with different details.*reopen/);
    const versionInput = { orgId: f.org.orgId, actorId: f.authorId, packageId: f.pack.id, effectiveFrom: "2026-02-01", effectiveTo: null,
      definition: f.definition, reason: "Stable version create", idempotencyKey: randomUUID() };
    const version = await saveCompensationPackageVersion(versionInput);
    await transitionCompensationPackageVersion({ ...versionInput, versionId: version.id, expectedRevision: version.revision, action: "submit" });
    const versionReplay = await saveCompensationPackageVersion(versionInput);
    assert.equal(versionReplay.id, version.id); assert.equal(versionReplay.status, "submitted");
    await assert.rejects(saveCompensationPackageVersion({ ...versionInput, effectiveFrom: "2026-03-01" }), /already saved with different details.*reopen/);
    await approveVersion(f);
    const assignmentInput = { orgId: f.org.orgId, actorId: f.authorId, packageId: f.pack.id, versionId: f.version.id, employmentId: f.employmentId,
      effectiveFrom: "2026-01-01", effectiveTo: null, inputs: { allowance: "310.00" }, reason: "Stable assignment create", idempotencyKey: randomUUID() };
    const saved = await saveCompensationPackageAssignment(assignmentInput);
    await transitionCompensationPackageAssignment({ orgId: f.org.orgId, actorId: f.authorId, packageId: f.pack.id, assignmentId: saved.id,
      expectedRevision: saved.revision, action: "submit", reason: "Employee proposal" });
    const assignmentReplay = await saveCompensationPackageAssignment({ ...assignmentInput, inputs: { allowance: "310" } });
    assert.equal(assignmentReplay.id, saved.id); assert.equal(assignmentReplay.status, "submitted");
    await assert.rejects(saveCompensationPackageAssignment({ ...assignmentInput, inputs: { allowance: "311" } }), /already saved with different details.*reopen/);
    const state = await getCompensationPackage({ orgId: f.org.orgId, actorId: f.authorId, packageId: f.pack.id });
    assert.equal(state.versions.length, 2); assert.equal(state.assignments.length, 1);
  });
});
