import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { db, withOrgTransaction } from "../platform/db.ts";
import { DB, setupHarness, withHarness, seedEmployment, setFeatures, grant } from "../testing/hrm-harness.ts";
import { seedPayrollSchedule, seedPayrollProfile, seedEnabledPayrollConfiguration, seedPostingAccount, seedPayrollWage, seedPayrollTime } from "../testing/fixtures.ts";
import { createCompensationPackage, getCompensationPackage, saveCompensationPackageVersion, transitionCompensationPackageVersion,
  saveCompensationPackageAssignment, transitionCompensationPackageAssignment, updateCompensationPackage } from "./compensation-package-store.ts";
import type { CompensationPackageDefinition } from "./compensation-package.ts";
import { compensationPackageDefinitionHash } from "./compensation-package.ts";
import { createSandbox, deleteSandbox } from "../sandbox/lifecycle.ts";
import { compensationPackageEmploymentSource, compensationPackageRunSource, lockCompensationPackageComponents } from './compensation-package-source.ts';
import { prepareCompensationPackages, appendCompensationPackageStage, persistCompensationPackageCalculations, type CompensationPackagePayrollContext } from './compensation-package-payroll.ts';
import { seedCanadianPayrollComponentsForTest, seedVacationTerms } from './filing-test-fixtures.ts';
import { calculatePayRun } from './run-calculation.ts';
import { commitPayRun } from './run-commit.ts';
import { postDocument } from '../ledger/posting-document.ts';
import { payRunStaleness } from './readiness.ts';
import { parseMoney } from '../money/brands.ts';
import type { Line } from './run-stub-records.ts';
import { canonicalJson } from '../platform/canonical-json.ts';
import { compensationPackageNativeSettlement, validateCompensationPackagePayrollPolicy } from './compensation-package-payroll-policy.ts';
import { evaluateCompensationPackage } from './compensation-package.ts';

const spec = { features: ["payroll", "hrm", "compensationPackages"], country: "CA", users: [
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
async function assignment(f: Fixture, effectiveFrom = "2026-01-01") {
  return saveCompensationPackageAssignment({ orgId: f.org.orgId, actorId: f.authorId, packageId: f.pack.id, versionId: f.version.id,
    employmentId: f.employmentId, effectiveFrom, effectiveTo: null, inputs: { allowance: "310.00" }, reason: "Employee package terms" });
}

test('payroll package sources require an effective approved employment assignment and retain exact native limits', { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    await approveVersion(f);
    const saved = await assignment(f);
    const query = { orgId: f.org.orgId, employmentId: f.employmentId, periodStart: '2026-01-01', periodEnd: '2026-01-31' };
    assert.deepEqual(await compensationPackageEmploymentSource(db, query), [], 'a draft assignment must not create payroll defaults');
    const base = { orgId: f.org.orgId, actorId: f.authorId, packageId: f.pack.id, assignmentId: saved.id, reason: 'Independent employee terms' };
    const submitted = await transitionCompensationPackageAssignment({ ...base, expectedRevision: saved.revision, action: 'submit' });
    assert.deepEqual(await compensationPackageEmploymentSource(db, query), [], 'submission is not authority to pay');
    await transitionCompensationPackageAssignment({ ...base, actorId: f.approverId, expectedRevision: submitted.revision, action: 'approve' });
    const updated = await db.execute(sql`update pay_components set basis_cap_hours_per_period='40.25',
      basis_cap_amount_per_period='1234.5678',basis_cap_amount_per_year='249999.1234'
      where org_id=${f.org.orgId} and id=${f.componentId} returning id`);
    assert.equal(updated.rows.length, 1);
    const [source] = await compensationPackageEmploymentSource(db, query);
    assert.ok(source);
    assert.equal(source.assignmentId, saved.id);
    assert.equal(source.employmentId, f.employmentId);
    assert.equal(source.employeePartyId, f.workerPartyId);
    assert.equal(source.subsidiaryId, f.org.subsidiaryId);
    assert.equal(source.definitionHash, f.version.definitionHash);
    assert.equal(source.currencyMinorUnits, 2);
    assert.deepEqual(source.inputs, { allowance: '310' });
    const component = source.components[0]!;
    assert.equal(component.basisCapHoursPerPeriod, '40.25', 'native package hours caps must remain exact decimal text');
    assert.equal(component.basisCapAmountPerPeriod, '1234.5678', 'native package period caps must remain exact decimal text');
    assert.equal(component.basisCapAmountPerYear, '249999.1234', 'native package annual caps must remain exact decimal text');
    const values = { allowance: '310' };
    const settlement = compensationPackageNativeSettlement(source.definition, source.components, values,
      () => ({ lines: [], periodToDate: '0', yearToDate: '249899.124' }));
    const result = evaluateCompensationPackage(source.definition, source.components, { ...query,
      effectiveFrom: source.effectiveFrom, effectiveTo: source.effectiveTo, values, occupiedComponentIds: [], replacementComponentIds: [] }, settlement);
    assert.equal(result.lines[0]!.amount, '99.9900', 'package allowances cannot restore annual room already consumed in native payroll and openings');
    assert.equal(result.lines[0]!.evidence.settlement!.requestedAmount, '310.0000');
    assert.throws(() => validateCompensationPackagePayrollPolicy(source.definition, [{ ...component, basis: 'per_hour' }]), /hours-capped.*worked hours.*add that native amount input/);
    assert.deepEqual(await compensationPackageEmploymentSource(db, { ...query, allowedSubsidiaryIds: new Set() }), []);
    assert.deepEqual(await compensationPackageEmploymentSource(db, { ...query, allowedSubsidiaryIds: new Set([randomUUID()]) }), []);
    assert.deepEqual(await compensationPackageEmploymentSource(db, { ...query, employmentId: randomUUID() }), [], 'a different employment never inherits this assignment');
    assert.deepEqual(await compensationPackageEmploymentSource(db, { ...query, periodStart: '2025-12-01', periodEnd: '2025-12-31' }), []);
    const documentId = randomUUID();
    await db.execute(sql`insert into documents(org_id,id,kind,document_number,subsidiary_id,document_date,currency,status,created_by,updated_by)
      values(${f.org.orgId},${documentId},'pay_run',${`PAY-${documentId}`},${f.org.subsidiaryId},'2026-01-31','CAD','draft',${f.authorId},${f.authorId})`);
    await db.execute(sql`insert into pay_runs(document_id,org_id,pay_schedule_id,period_start,period_end,pay_date,tax_year,created_by,updated_by)
      values(${documentId},${f.org.orgId},${f.scheduleId},'2026-01-01','2026-01-31','2026-01-31',2026,${f.authorId},${f.authorId})`);
    assert.deepEqual(await compensationPackageRunSource(db, f.org.orgId, documentId), [], 'approved terms outside the calculated employee population cannot enter its source evidence');
    await db.execute(sql`insert into pay_stubs(org_id,pay_run_document_id,employee_party_id,employment_id,province,periods_per_year,pay_date,tax_year,country,country_source,currency_code,created_by,updated_by)
      values(${f.org.orgId},${documentId},${f.workerPartyId},${f.employmentId},'ON',12,'2026-01-31',2026,'CA','calculation','CAD',${f.authorId},${f.authorId})`);
    assert.deepEqual(await compensationPackageRunSource(db, f.org.orgId, documentId), [source], 'run evidence resolves the exact employment preserved on its native stub');
    assert.deepEqual(await compensationPackageRunSource(db, f.org.orgId, documentId, new Set()), []);
    assert.deepEqual(await compensationPackageRunSource(db, f.org.orgId, randomUUID()), []);
    await setFeatures(f.org.orgId, { compensationPackages: false });
    assert.deepEqual(await compensationPackageEmploymentSource(db, query), [source], 'disabling package authoring cannot remove approved payroll obligations');
  });
});

test('future package proposals and retirement preserve pinned terms while native component changes alter payroll evidence', { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    await approveVersion(f);
    const saved = await assignment(f);
    const base = { orgId: f.org.orgId, actorId: f.authorId, packageId: f.pack.id, assignmentId: saved.id, reason: 'Approved employee coverage' };
    const submitted = await transitionCompensationPackageAssignment({ ...base, expectedRevision: saved.revision, action: 'submit' });
    const active = await transitionCompensationPackageAssignment({ ...base, actorId: f.approverId, expectedRevision: submitted.revision, action: 'approve' });
    const query = { orgId: f.org.orgId, employmentId: f.employmentId, periodStart: '2026-01-01', periodEnd: '2026-01-31' };
    const before = await compensationPackageEmploymentSource(db, query);
    const deductionId = randomUUID();
    await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,basis,value,is_active)
      values(${deductionId},${f.org.orgId},'PKG_DEDUCTION','Package deduction','deduction','CA','fixed_amount','0',true)`);
    await assert.rejects(saveCompensationPackageVersion({ orgId: f.org.orgId, actorId: f.authorId, packageId: f.pack.id,
      effectiveFrom: '2026-01-01', effectiveTo: null, definition: { ...f.definition, rules: [
        { ...f.definition.rules[0]!, expression: 'deduction * 2', proration: 'none' },
        { key: 'deduction', componentId: deductionId, expression: 'allowance', proration: 'none', rounding: f.definition.rules[0]!.rounding },
      ] }, reason: 'Invalid cross-stage policy' }), /earning travel.*deduction.*after earnings/);
    assert.equal((await getCompensationPackage({ orgId: f.org.orgId, actorId: f.authorId, packageId: f.pack.id })).versions.length, 1,
      'invalid payroll stage dependencies refuse before saving any draft');
    await saveCompensationPackageVersion({ orgId: f.org.orgId, actorId: f.authorId, packageId: f.pack.id,
      effectiveFrom: '2026-01-01', effectiveTo: null, definition: { ...f.definition, rules: f.definition.rules.map(rule => ({ ...rule, expression: 'allowance * 2' })) }, reason: 'Separate proposed terms' });
    await updateCompensationPackage({ orgId: f.org.orgId, actorId: f.authorId, packageId: f.pack.id, expectedRevision: 1,
      name: f.pack.name, description: null, retire: true, reason: 'Stop new assignments while retaining obligations' });
    assert.deepEqual(await compensationPackageEmploymentSource(db, query), before);
    const changed = await db.execute(sql`update pay_components set vacationable=false where org_id=${f.org.orgId} and id=${f.componentId} returning id`);
    assert.equal(changed.rows.length, 1);
    assert.notEqual(canonicalJson(await compensationPackageEmploymentSource(db, query)), canonicalJson(before), 'changed native financial flags must invalidate source equality');
    await transitionCompensationPackageAssignment({ ...base, expectedRevision: active.revision, action: 'end', effectiveTo: '2026-01-15' });
    assert.equal((await compensationPackageEmploymentSource(db, query))[0]!.effectiveTo, '2026-01-15');
    assert.deepEqual(await compensationPackageEmploymentSource(db, { ...query, periodStart: '2026-01-16' }), [], 'an ended assignment owes no defaults outside its preserved window');
  });
});

test('native package component and classification edits cannot cross the held payroll evidence fence', { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    await approveVersion(f);
    const saved = await assignment(f);
    const base = { orgId: f.org.orgId, actorId: f.authorId, packageId: f.pack.id, assignmentId: saved.id, reason: 'Independent employee terms' };
    const submitted = await transitionCompensationPackageAssignment({ ...base, expectedRevision: saved.revision, action: 'submit' });
    await transitionCompensationPackageAssignment({ ...base, actorId: f.approverId, expectedRevision: submitted.revision, action: 'approve' });
    assert.ok(process.env.OPENBOOKS_TEST_ADMIN_DB_URL, 'the component fence proof requires the named isolated database');
    const client = new pg.Client({ connectionString: process.env.OPENBOOKS_TEST_ADMIN_DB_URL });
    await client.connect();
    try {
      await withOrgTransaction(f.org.orgId, async () => {
        const source = await compensationPackageEmploymentSource(db, { orgId: f.org.orgId, employmentId: f.employmentId, periodStart: '2026-01-01', periodEnd: '2026-01-31' });
        await lockCompensationPackageComponents(db, f.org.orgId, source);
        for (const statement of [
          'update pay_components set basis_cap_amount_per_year=1000 where org_id=$1 and id=$2',
          'update pay_component_earning_classifications set statutory_reporting_category=statutory_reporting_category where org_id=$1 and pay_component_id=$2',
        ]) {
          await client.query('begin');
          await client.query("select set_config('app.current_org',$1,true),set_config('lock_timeout','100ms',true)", [f.org.orgId]);
          await assert.rejects(client.query(statement, [f.org.orgId, f.componentId]), (error: unknown) =>
            error instanceof Error && 'code' in error && error.code === '55P03', 'native component policy must remain fenced until payroll finishes comparing its evidence');
          await client.query('rollback');
        }
      });
    } finally { await client.query('rollback'); await client.end(); }
  });
});

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
    await setFeatures(f.org.orgId, { compensationPackages: false });
    await assert.rejects(updateCompensationPackage({ ...base, expectedRevision: 1 }), /authoring is disabled.*Company Settings/);
    await setFeatures(f.org.orgId, { compensationPackages: true });
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

async function runtimeContext(f: Fixture, effectiveFrom = "2026-01-01"): Promise<CompensationPackagePayrollContext> {
  await approveVersion(f);
  const saved = await assignment(f, effectiveFrom);
  const query = { orgId: f.org.orgId, actorId: f.authorId, packageId: f.pack.id, assignmentId: saved.id, reason: 'Independent payroll terms' };
  const submitted = await transitionCompensationPackageAssignment({ ...query, expectedRevision: saved.revision, action: 'submit' });
  await transitionCompensationPackageAssignment({ ...query, actorId: f.approverId, expectedRevision: submitted.revision, action: 'approve' });
  const documentId = randomUUID();
  await db.execute(sql`insert into documents(org_id,id,kind,document_number,subsidiary_id,document_date,currency,status,created_by,updated_by)
    values(${f.org.orgId},${documentId},'pay_run',${`PAY-${documentId}`},${f.org.subsidiaryId},'2026-01-31','CAD','draft',${f.authorId},${f.authorId})`);
  await db.execute(sql`insert into pay_runs(document_id,org_id,pay_schedule_id,period_start,period_end,pay_date,tax_year,created_by,updated_by)
    values(${documentId},${f.org.orgId},${f.scheduleId},'2026-01-01','2026-01-31','2026-01-31',2026,${f.authorId},${f.authorId})`);
  return { orgId: f.org.orgId, actorId: f.authorId, documentId, employeePartyId: f.workerPartyId, employmentId: f.employmentId,
    subsidiaryId: f.org.subsidiaryId, country: 'CA', currency: 'CAD', periodStart: '2026-01-01', periodEnd: '2026-01-31',
    taxYear: 2026, hourlyWage: '25', payScheduleId: f.scheduleId, oneOffRun: false, terminationRun: false, simulate: false, assignedRows: [], unionAgreementId: null, unionClassificationId: null };
}
function nativeWages(): Line[] {
  return [{ componentId: null, kind: 'earning', description: 'Native wages', amount: parseMoney('1000'), hours: '40', sequence: 10 }];
}

test('native package stages preserve base pay and final calculation evidence without a second earning default', { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    const context = await runtimeContext(f);
    await withOrgTransaction(f.org.orgId, async () => {
      const lines = nativeWages();
      const prepared = await prepareCompensationPackages(db, context, lines);
      assert.equal(lines.length, 1, 'preparation cannot mutate native payroll');
      await appendCompensationPackageStage(db, prepared, 'earnings', lines);
      assert.deepEqual(lines.map(line => line.amount), ['1000.0000', '310.0000']);
      await appendCompensationPackageStage(db, prepared, 'remaining', lines);
      assert.equal(lines.length, 2, 'the later phase cannot repeat the allowance');
      lines[1]!.amount = parseMoney('290');
      await persistCompensationPackageCalculations(db, prepared);
      const evidence = (await db.execute<{ result: { finalLines: { amount: string }[] }; source: { definitionHash: string } }>(sql`
        select result_snapshot as result,source_snapshot as source from payroll_compensation_calculations
        where org_id=${f.org.orgId} and pay_run_document_id=${context.documentId}`)).rows;
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0]!.source.definitionHash, f.version.definitionHash);
      assert.equal(evidence[0]!.result.finalLines[0]!.amount, '290.0000', 'final protection effects remain part of the saved evidence');
      const simulated = await prepareCompensationPackages(db, { ...context, simulate: true }, nativeWages());
      const simulatedLines = nativeWages();
      await appendCompensationPackageStage(db, simulated, 'earnings', simulatedLines);
      await appendCompensationPackageStage(db, simulated, 'remaining', simulatedLines);
      await persistCompensationPackageCalculations(db, simulated);
      assert.equal((await db.execute(sql`select id from payroll_compensation_calculations where org_id=${f.org.orgId}`)).rows.length, 1,
        'simulation cannot rewrite preserved evidence');
    });
  });
});

test('an explicit zero replacement suppresses package pay while ordinary native top-ups remain additive', { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    const context = await runtimeContext(f);
    await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount,replace_component)
      values(${f.org.orgId},${context.documentId},${f.workerPartyId},'line',${f.componentId},0,true)`);
    await withOrgTransaction(f.org.orgId, async () => {
      const lines = nativeWages();
      const prepared = await prepareCompensationPackages(db, context, lines);
      await appendCompensationPackageStage(db, prepared, 'earnings', lines);
      assert.equal(lines.length, 1, 'a deliberately nil replacement cannot restore the default');
    });
    await db.execute(sql`update pay_run_adjustments set replace_component=false,amount=15 where org_id=${f.org.orgId}
      and pay_run_document_id=${context.documentId}`);
    await withOrgTransaction(f.org.orgId, async () => {
      const lines = nativeWages();
      const prepared = await prepareCompensationPackages(db, context, lines);
      assert.ok(prepared.preliminaryLines.some(line => line.amount === '15.0000' && line.runAdjustmentId));
      await appendCompensationPackageStage(db, prepared, 'earnings', lines);
      assert.equal(lines[1]!.amount, '310.0000', 'an additive manual input does not erase approved compensation');
    });
  });
});

test('an applicable native derived rule owns its component even when operational facts produce no payment', { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    const context = await runtimeContext(f);
    await db.execute(sql`insert into pay_derived_rules(org_id,code,name,component_id,trigger,quantity_mode,rate_mode,rate_value,costing_mode,effective_from,is_active)
      values(${f.org.orgId},'NATIVE_TRAVEL','Native travel policy',${f.componentId},'distinct_day','count','fixed_per_unit',70,'source','2026-01-01',true)`);
    await withOrgTransaction(f.org.orgId, async () => {
      const lines = nativeWages();
      const prepared = await prepareCompensationPackages(db, context, lines);
      await appendCompensationPackageStage(db, prepared, 'earnings', lines);
      assert.equal(lines.length, 1, 'no qualifying operational facts cannot become a package allowance');
      assert.deepEqual(prepared.results.values().next().value!.stages[0]!.evaluation.suppressedComponentIds, [f.componentId]);
    });
  });
});

test('package dependencies refuse an unfinished native percent amount and consume an explicit replacement exactly', { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    const bonusId = randomUUID();
    await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,basis,value,is_active)
      values(${bonusId},${f.org.orgId},'PKG_BONUS','Travel supplement','earning','CA','fixed_amount',0,true)`);
    await db.execute(sql`update pay_components set basis='percent_of_gross',value=10 where org_id=${f.org.orgId} and id=${f.componentId}`);
    f.definition = { ...f.definition, rules: [...f.definition.rules, { ...f.definition.rules[0]!, key: 'supplement', componentId: bonusId,
      expression: 'travel * 0.1', proration: 'none' }] };
    f.version = await saveCompensationPackageVersion({ orgId: f.org.orgId, actorId: f.authorId, packageId: f.pack.id,
      versionId: f.version.id, expectedRevision: f.version.revision, effectiveFrom: '2026-01-01', effectiveTo: null,
      definition: f.definition, reason: 'Supplement based on actual native travel pay' });
    const context = await runtimeContext(f);
    await db.execute(sql`insert into employee_pay_components(org_id,employee_party_id,employment_id,component_id,effective_from,is_active)
      values(${f.org.orgId},${f.workerPartyId},${f.employmentId},${f.componentId},'2026-01-01',true)`);
    context.assignedRows = (await db.execute<Record<string, unknown>>(sql`select c.*,a.effective_from::text,a.effective_to::text,a.value as override
      from employee_pay_components a join pay_components c on c.org_id=a.org_id and c.id=a.component_id
      where a.org_id=${f.org.orgId} and a.employee_party_id=${f.workerPartyId}`)).rows;
    await assert.rejects(withOrgTransaction(f.org.orgId, async () => {
      const lines = nativeWages();
      const prepared = await prepareCompensationPackages(db, context, lines);
      await appendCompensationPackageStage(db, prepared, 'earnings', lines);
    }), /depends on recurring percent-of-gross component PKG_TRAVEL.*combine these earning formulas/,
    'a circular native gross dependency must name the real component and an available policy remedy');
    await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount,replace_component)
      values(${f.org.orgId},${context.documentId},${f.workerPartyId},'line',${f.componentId},42,true)`);
    await withOrgTransaction(f.org.orgId, async () => {
      const lines = nativeWages();
      const prepared = await prepareCompensationPackages(db, context, lines);
      await appendCompensationPackageStage(db, prepared, 'earnings', lines);
      assert.deepEqual(lines.filter(line => line.componentId).map(line => [line.componentId,line.amount]), [[bonusId,'4.2000']]);
    });
  });
});

test('approved packages calculate and post natively only after changed employment terms are recalculated', { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    const context = await runtimeContext(f);
    const wageExpense = await seedPostingAccount(f.org.orgId,'6000','Wages expense','expense');
    const burdenExpense = await seedPostingAccount(f.org.orgId,'6010','Payroll burden','expense');
    const netPayable = await seedPostingAccount(f.org.orgId,'2300','Wages payable','liability_current');
    const craPayable = await seedPostingAccount(f.org.orgId,'2310','CRA payable','liability_current');
    const vacationPayable = await seedPostingAccount(f.org.orgId,'2320','Vacation payable','liability_current');
    await seedEnabledPayrollConfiguration(f.org.orgId, { wageExpenseAccountId:wageExpense,burdenExpenseAccountId:burdenExpense,
      netPayAccountId:netPayable,cppPayableAccountId:craPayable,eiPayableAccountId:craPayable,taxPayableAccountId:craPayable,
      vacationPayableAccountId:vacationPayable,wagesTo:'expense' });
    await setFeatures(f.org.orgId, { compensationPackages: true });
    await seedCanadianPayrollComponentsForTest(f.org.orgId,f.authorId);
    await seedVacationTerms(f.org.orgId,f.employmentId,f.authorId);
    await seedPayrollWage(f.org.orgId,f.workerPartyId,f.authorId, { currency:'CAD',rate:'25',basis:'hour',effectiveFrom:'2026-01-01' });
    await seedPayrollTime(f.org.orgId,f.workerPartyId,f.authorId, { workedOn:'2026-07-20',hours:'8',status:'approved',costingBasis:'actual',billingStatus:'unbilled' });
    await db.execute(sql`update documents set document_date='2026-07-31' where org_id=${f.org.orgId} and id=${context.documentId}`);
    await db.execute(sql`update pay_runs set period_start='2026-07-01',period_end='2026-07-31',pay_date='2026-07-31'
      where org_id=${f.org.orgId} and document_id=${context.documentId}`);
    const input = { orgId:f.org.orgId,actorId:f.authorId,documentId:context.documentId };
    const first = await calculatePayRun(input);
    assert.deepEqual(first.errors, []);
    assert.equal((await db.execute<{ gross:string }>(sql`select gross::text from pay_stubs where org_id=${f.org.orgId}
      and pay_run_document_id=${context.documentId}`)).rows[0]!.gross,'510.0000');
    const active = (await getCompensationPackage({orgId:f.org.orgId,actorId:f.authorId,packageId:f.pack.id})).assignments[0]!;
    await transitionCompensationPackageAssignment({ orgId:f.org.orgId,actorId:f.authorId,packageId:f.pack.id,assignmentId:active.id,
      expectedRevision:active.revision,action:'end',effectiveTo:'2026-07-15',reason:'Approved terms ended mid-period' });
    const stale = await payRunStaleness(f.org.orgId,context.documentId);
    assert.ok(stale.reasons.includes('compensationPackages'),JSON.stringify(stale.reasons));
    await assert.rejects(commitPayRun(input),/approved compensation terms.*recalculate/i);
    assert.equal((await db.execute(sql`select id from journal_entries where org_id=${f.org.orgId} and source_document_id=${context.documentId}`)).rows.length,0);
    const recalculated = await calculatePayRun(input);
    assert.deepEqual(recalculated.errors,[]);
    assert.equal((await db.execute<{ gross:string }>(sql`select gross::text from pay_stubs where org_id=${f.org.orgId}
      and pay_run_document_id=${context.documentId}`)).rows[0]!.gross,'350.0000');
    const evidence = (await db.execute<{ amount:string }>(sql`select result_snapshot->'finalLines'->0->>'amount' as amount
      from payroll_compensation_calculations where org_id=${f.org.orgId} and pay_run_document_id=${context.documentId}`)).rows;
    assert.deepEqual(evidence,[{amount:'150.0000'}]);
    await commitPayRun(input);
    await db.execute(sql`update documents set status='approved' where org_id=${f.org.orgId} and id=${context.documentId}`);
    const entryId = await postDocument(context.documentId, { control: { ar:f.org.accounts.ar,ap:f.org.accounts.ap,bank:f.org.accounts.bank } },
      { audit: { actorId:f.approverId,source:'payroll' } });
    const totals = (await db.execute<{ balance:string; count:number }>(sql`select coalesce(sum(amount),0)::text as balance,count(*)::int as count
      from journal_lines where org_id=${f.org.orgId} and entry_id=${entryId}`)).rows[0]!;
    assert.equal(totals.balance,'0.0000','native package posting must remain exactly balanced');
    assert.ok(totals.count>0,'balanced zero rows cannot masquerade as a posting');
    const preserved = (await db.execute(sql`select source_snapshot,result_snapshot from payroll_compensation_calculations
      where org_id=${f.org.orgId} and pay_run_document_id=${context.documentId}`)).rows;
    const simulated = await calculatePayRun({ ...input, simulate:true });
    assert.deepEqual(simulated.errors,[]);
    assert.deepEqual((await db.execute(sql`select source_snapshot,result_snapshot from payroll_compensation_calculations
      where org_id=${f.org.orgId} and pay_run_document_id=${context.documentId}`)).rows,preserved,
    'simulation must not rewrite posted package evidence');
    await assert.rejects(db.execute(sql`delete from payroll_compensation_calculations
      where org_id=${f.org.orgId} and pay_run_document_id=${context.documentId}`),(error:unknown)=>{
      const cause=(error as {cause?:{message?:string}}).cause;
      assert.match(cause?.message??'',/preserve posted evidence and use a controlled correction/);
      return true;
    });
  });
});

test('native package authoring refuses fractional payable units before saving and retains explicit coarser rounding', { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    assert.equal(f.pack.currencyMinorUnits,2);
    const fine = { ...f.definition, rules:f.definition.rules.map(rule=>({...rule,rounding:{...rule.rounding,scale:4}})) };
    await assert.rejects(saveCompensationPackageVersion({orgId:f.org.orgId,actorId:f.authorId,packageId:f.pack.id,effectiveFrom:'2026-01-01',
      effectiveTo:null,definition:fine,reason:'Invalid fraction-of-a-cent payroll policy'}),/rule travel rounds to 4 places, but CAD supports 2.*at most 2 decimal places/);
    assert.equal((await getCompensationPackage({orgId:f.org.orgId,actorId:f.authorId,packageId:f.pack.id})).versions.length,1);
    const coarse = await saveCompensationPackageVersion({orgId:f.org.orgId,actorId:f.authorId,packageId:f.pack.id,effectiveFrom:'2026-01-01',
      effectiveTo:null,definition:{...fine,rules:fine.rules.map(rule=>({...rule,rounding:{...rule.rounding,scale:0}}))},reason:'Explicit whole-dollar employer policy'});
    assert.equal(coarse.definition.rules[0]!.rounding.scale,0);
  });
});

test('native package inputs retain dated work and fixed configuration coverage without reinterpreting whole-period hourly pay', { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    f.definition = { ...f.definition, inputs: [...f.definition.inputs,
      { name: 'gross', type: { kind: 'money', currency: 'CAD' }, source: 'period_gross', minimum: '0', maximum: '1000000' },
      { name: 'hours', type: { kind: 'hours' }, source: 'period_hours', minimum: '0', maximum: '1000' },
      { name: 'wage', type: { kind: 'hourly_rate', currency: 'CAD' }, source: 'hourly_wage', minimum: '0', maximum: '10000' },
    ], rules: [{ ...f.definition.rules[0]!, expression: 'gross + hours * wage', proration: 'none' }] };
    f.version = await saveCompensationPackageVersion({ orgId: f.org.orgId, actorId: f.authorId, packageId: f.pack.id,
      versionId: f.version.id, expectedRevision: f.version.revision, effectiveFrom: '2026-01-01', effectiveTo: null,
      definition: f.definition, reason: 'Native dated gross and hours policy' });
    const context = await runtimeContext(f, '2026-01-16');
    await withOrgTransaction(f.org.orgId, async () => {
      const line = (amount: string, rest: Partial<Line> = {}): Line => ({ componentId: null, kind: 'earning',
        description: 'Native pay', amount: parseMoney(amount), sequence: 10, ...rest });
      const lines = [line('100', { earnedFrom: '2026-01-09', earnedTo: '2026-01-09', hours: '4' }),
        line('200', { earnedFrom: '2026-01-20', earnedTo: '2026-01-20', hours: '8' }), line('310'),
        line('160', { sourceEffectiveFrom: '2026-01-16', sourceEffectiveTo: '2026-01-31', sourceProratedByCoverage: true }),
        line('400', { sourceEffectiveFrom: '2026-01-16', sourceEffectiveTo: '2026-01-31', sourceProratedByCoverage: false })];
      const prepared = await prepareCompensationPackages(db, context, lines);
      await appendCompensationPackageStage(db, prepared, 'earnings', lines);
      const calculated = prepared.results.values().next().value!.stages[0]!.evaluation;
      assert.equal(calculated.inputs.gross, '726.4516', 'configuration dates cannot redefine whole-period per-hour earnings');
      assert.equal(calculated.inputs.hours, '8', 'only the dated work inside the assignment supplies earned hours');
      assert.equal(calculated.inputs.wage, '25');
      assert.equal(lines.at(-1)!.amount, '926.4500', 'native gross and worked hours cannot be calendar-prorated a second time');
      assert.equal(lines.at(-1)!.hours, undefined, 'package money cannot duplicate native worked hours');
    });
  });
});
