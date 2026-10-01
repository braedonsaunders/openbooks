import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

class Rollback extends Error {}
import test, { after, before } from "node:test";
import { db } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../../testing/fixtures.ts";
import {
  enableHrm,
  grantPermissions,
  mkHr,
  mkSecondSubsidiary,
  seedComponent,
  seedPerson,
} from "../../testing/hrm-harness.ts";
import { BenefitsError } from "./errors.ts";
import {
  activateBenefitProgram,
  addProgramMembership,
  closeBenefitProgram,
  createBenefitProgram,
  getBenefitProgram,
  listBenefitPrograms,
} from "./programs.ts";
import {
  approveBenefitAward,
  createBenefitAward,
  getBenefitAward,
  listBenefitAwards,
  queueBenefitAward,
  recordPayrollDelivery,
  submitBenefitAward,
  voidBenefitAward,
} from "./awards.ts";
import { queueAwardForPayRun } from "./settlement.ts";
import { listProgramMemberships, removeProgramMembership } from "./programs.ts";

/**
 * Employer-defined benefit programs and awards on a scratch database.
 *
 * Isolation (second org sees nothing), approval segregation (the creator
 * never approves their own award, even holding every grant), retry safety
 * (a repeated settlement with the same source key lands once), and history
 * (snapshots immutable, events append-only, audit evidence per move).
 * Requires the integration partition with its marked scratch database.
 */
let ARTIFACT: ScratchOrg | null = null;
let HRMGR: string | null = null;
let APPROVER: string | null = null;
let FINANCE: string | null = null;
let ENTITY: string | null = null;
let OTHER_ENTITY: string | null = null;
let EMPLOYMENT: string | null = null;
let COMPONENT: string | null = null;
let ACCOUNT: string | null = null;

before(async () => {
  if (!process.env.OPENBOOKS_DB_URL) return;
  ARTIFACT = await createScratchOrg();
  const orgId = ARTIFACT.orgId;
  await enableHrm(orgId);
  ENTITY = ARTIFACT.subsidiaryId;
  OTHER_ENTITY = await mkSecondSubsidiary(orgId, ENTITY!);
  HRMGR = await mkHr(orgId, "Benefits Author", "benefits_author", null, [
    "hrm.benefits.read",
    "hrm.benefits.manage",
  ]);
  APPROVER = await mkHr(orgId, "Benefits Approver", "benefits_approver", null, [
    "hrm.benefits.read",
    "hrm.benefits.manage",
  ]);
  FINANCE = await mkHr(orgId, "Benefits Finance", "benefits_finance", null, [
    "hrm.benefits.read",
    "payroll.manage",
  ]);
  await grantPermissions(orgId, HRMGR, ["payroll.manage"]);
  const person = await seedPerson(orgId, ENTITY, "Award Earner");
  EMPLOYMENT = person.employmentId;
  COMPONENT = await seedComponent(orgId, { code: "BONUS", kind: "earning" });
  ACCOUNT = (
    await db.execute<{ id: string }>(sql`
      insert into accounts (org_id, number, name, type, is_active, is_summary)
      values (${orgId}, '6040', 'Bonus expense', 'expense', true, false)
      returning id
    `)
  ).rows[0]!.id;
});

after(async () => {
  if (ARTIFACT) await dropScratchOrg(ARTIFACT.orgId);
});

async function draftProgram(code: string, overrides: Record<string, unknown> = {}) {
  const orgId = ARTIFACT!.orgId;
  const program = await createBenefitProgram({
    orgId,
    actorId: HRMGR!,
    code,
    name: code,
    family: "reward",
    currency: "USD",
    effectiveFrom: "2026-01-01",
    legalEntityId: ENTITY!,
    payComponentId: COMPONENT!,
    deliveryMethod: "payroll",
    valuation: "fixed",
    fixedAmount: "100.0000",
    sourceAccountIds: [ACCOUNT!],
    ...overrides,
  });
  await addProgramMembership({
    orgId,
    actorId: HRMGR!,
    programId: program.id,
    employmentId: EMPLOYMENT!,
    effectiveFrom: "2026-01-01",
  });
  return program;
}

test("0469 tables exist with tenant RLS enforced", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const tables = (
    await db.execute<{ tablename: string }>(sql`
      select tablename from pg_tables
       where tablename in ('hrm_benefit_programs', 'hrm_benefit_program_scopes',
         'hrm_benefit_program_sources', 'hrm_benefit_program_members',
         'hrm_benefit_awards', 'hrm_benefit_award_events')
    `)
  ).rows;
  assert.equal(tables.length, 6);
  const rls = (
    await db.execute<{ tablename: string }>(sql`
      select tablename from pg_tables
       where tablename in ('hrm_benefit_programs', 'hrm_benefit_awards')
         and rowsecurity
    `)
  ).rows;
  assert.equal(rls.length, 2);
});

test("second organization sees nothing of the first", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const other = await createScratchOrg();
  try {
    await enableHrm(other.orgId);
    const stranger = await createScratchUser(other.orgId, "Stranger", "stranger");
    await grantPermissions(other.orgId, stranger, ["hrm.benefits.read", "hrm.benefits.manage"]);
    const seen = await listBenefitPrograms({ orgId: other.orgId, actorId: stranger });
    assert.equal(seen.programs.length, 0);
    assert.equal(seen.total, 0);
    const program = await draftProgram(`ISO${Date.now().toString(36).toUpperCase()}`);
    await assert.rejects(
      getBenefitProgram(db, other.orgId, stranger, program.id),
      (error: unknown) => error instanceof BenefitsError && error.code === "NOT_FOUND",
    );
  } finally {
    await dropScratchOrg(other.orgId);
  }
});

test("restricted actor configures only their own entity", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const orgId = ARTIFACT!.orgId;
  const restricted = await mkHr(orgId, "Entity Author", "entity_author", [ENTITY as string], [
    "hrm.benefits.read",
    "hrm.benefits.manage",
  ]);
  await assert.rejects(
    createBenefitProgram({
      orgId,
      actorId: restricted,
      code: `WIDE${Date.now().toString(36).toUpperCase()}`,
      name: "wide",
      family: "reward",
      currency: "USD",
      effectiveFrom: "2026-01-01",
      valuation: "fixed",
      fixedAmount: "100.0000",
      legalEntityId: null,
      payComponentId: COMPONENT!,
      sourceAccountIds: [ACCOUNT!],
    }),
    /unrestricted managers/,
  );
  await assert.rejects(
    createBenefitProgram({
      orgId,
      actorId: restricted,
      code: `OTHR${Date.now().toString(36).toUpperCase()}`,
      name: "other",
      family: "reward",
      currency: "USD",
      effectiveFrom: "2026-01-01",
      valuation: "fixed",
      fixedAmount: "100.0000",
      legalEntityId: OTHER_ENTITY!,
      payComponentId: COMPONENT!,
      sourceAccountIds: [ACCOUNT!],
    }),
    (error: unknown) => error instanceof BenefitsError,
  );
});

test("activation needs a legal entity; closure preserves history", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const orgId = ARTIFACT!.orgId;
  const bare = await createBenefitProgram({
    orgId,
    actorId: HRMGR!,
    code: `BARE${Date.now().toString(36).toUpperCase()}`,
    name: "bare",
    family: "allowance",
    currency: "USD",
    effectiveFrom: "2026-01-01",
    valuation: "fixed",
    fixedAmount: "100.0000",
    legalEntityId: null,
    payComponentId: COMPONENT!,
    sourceAccountIds: [ACCOUNT!],
  });
  await assert.rejects(activateBenefitProgram({ orgId, actorId: HRMGR!, programId: bare.id }), /legal entity/);
  const program = await draftProgram(`CLS${Date.now().toString(36).toUpperCase()}`);
  const active = await activateBenefitProgram({ orgId, actorId: HRMGR!, programId: program.id });
  assert.equal(active.status, "active");
  const closed = await closeBenefitProgram({
    orgId,
    actorId: HRMGR!,
    programId: program.id,
    reason: "annual program ended",
  });
  assert.equal(closed.status, "closed");
  await assert.rejects(
    activateBenefitProgram({ orgId, actorId: HRMGR!, programId: program.id }),
    (error: unknown) => error instanceof BenefitsError && error.code === "BAD_STATE",
  );
});

test("creator cannot approve their own award, even holding every grant", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const orgId = ARTIFACT!.orgId;
  const program = await draftProgram(`SOD${Date.now().toString(36).toUpperCase()}`);
  await activateBenefitProgram({ orgId, actorId: HRMGR!, programId: program.id });
  const award = await createBenefitAward({
    orgId,
    actorId: HRMGR!,
    programId: program.id,
    employmentId: EMPLOYMENT!,
    periodFrom: "2026-03-01",
    value: "100.0000",
    currency: "USD",
    sourceKey: `sod-${program.id}`,
  });
  await submitBenefitAward({ orgId, actorId: HRMGR!, awardId: award.id });
  await assert.rejects(
    approveBenefitAward({ orgId, actorId: HRMGR!, awardId: award.id }),
    /second manager/,
  );
  const approved = await approveBenefitAward({ orgId, actorId: APPROVER!, awardId: award.id });
  assert.equal(approved.status, "approved");
});

test("repeated settlement with the same source key lands once", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const orgId = ARTIFACT!.orgId;
  const program = await draftProgram(`RTY${Date.now().toString(36).toUpperCase()}`);
  await activateBenefitProgram({ orgId, actorId: HRMGR!, programId: program.id });
  const key = `retry-${program.id}`;
  const first = await createBenefitAward({
    orgId,
    actorId: HRMGR!,
    programId: program.id,
    employmentId: EMPLOYMENT!,
    periodFrom: "2026-04-01",
    value: "100.0000",
    currency: "USD",
    sourceKey: key,
  });
  await assert.rejects(
    createBenefitAward({
      orgId,
      actorId: HRMGR!,
      programId: program.id,
      employmentId: EMPLOYMENT!,
      periodFrom: "2026-04-01",
      value: "100.0000",
      currency: "USD",
      sourceKey: key,
    }),
    /already recorded/,
  );
  const listed = await listBenefitAwards({ orgId, actorId: HRMGR!, programId: program.id });
  assert.equal(listed.awards.filter((row) => row.sourceKey === key).length, 1);
  assert.equal(first.status, "draft");
});

test("per-award cap and pool budget refuse over-issuance", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const orgId = ARTIFACT!.orgId;
  const capped = await draftProgram(`CAP${Date.now().toString(36).toUpperCase()}`, {
    valuation: "pool",
    fixedAmount: null,
    budgetAmount: "200.0000",
    capAmount: "100.0000",
  });
  await activateBenefitProgram({ orgId, actorId: HRMGR!, programId: capped.id });
  await assert.rejects(
    createBenefitAward({
      orgId,
      actorId: HRMGR!,
      programId: capped.id,
      employmentId: EMPLOYMENT!,
      periodFrom: "2026-05-01",
      value: "150.0000",
      currency: "USD",
    }),
    /per-award cap/,
  );
  await createBenefitAward({
    orgId,
    actorId: HRMGR!,
    programId: capped.id,
    employmentId: EMPLOYMENT!,
    periodFrom: "2026-05-01",
    value: "100.0000",
    currency: "USD",
  });
  await createBenefitAward({
    orgId,
    actorId: HRMGR!,
    programId: capped.id,
    employmentId: EMPLOYMENT!,
    periodFrom: "2026-06-01",
    value: "100.0000",
    currency: "USD",
  });
  await assert.rejects(
    createBenefitAward({
      orgId,
      actorId: HRMGR!,
      programId: capped.id,
      employmentId: EMPLOYMENT!,
      periodFrom: "2026-07-01",
      value: "1.0000",
      currency: "USD",
    }),
    /budget .* cannot cover/,
  );
});

test("award snapshots are immutable evidence; voiding keeps the row", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const orgId = ARTIFACT!.orgId;
  const program = await draftProgram(`HST${Date.now().toString(36).toUpperCase()}`);
  await activateBenefitProgram({ orgId, actorId: HRMGR!, programId: program.id });
  const award = await createBenefitAward({
    orgId,
    actorId: HRMGR!,
    programId: program.id,
    employmentId: EMPLOYMENT!,
    periodFrom: "2026-08-01",
    value: "100.0000",
    currency: "USD",
    evidence: { metric: "approved_hours", measured: "160.0000" },
  });
  const stored = await getBenefitAward(db, orgId, HRMGR!, award.id);
  assert.equal((stored.evidence as Record<string, unknown>).measured, "160.0000");
  await assert.rejects(
    db.execute(sql`update hrm_benefit_awards set value = '26.0000' where org_id = ${orgId} and id = ${award.id}`),
    (error: unknown) => /immutable|adjusting award/.test(String((error as { cause?: unknown }).cause ?? error)),
  );
  const voided = await voidBenefitAward({
    orgId,
    actorId: HRMGR!,
    awardId: award.id,
    reason: "issued for the wrong period",
  });
  assert.equal(voided.status, "voided");
  const events = (
    await db.execute<{ kind: string }>(sql`
      select kind from hrm_benefit_award_events
       where org_id = ${orgId} and award_id = ${award.id} order by recorded_at
    `)
  ).rows.map((row) => row.kind);
  assert.deepEqual(events, ["created", "voided"]);
  const audits = (
    await db.execute(sql`select id from audit_log where org_id = ${orgId} and table_name = 'hrm_benefit_awards' and row_id = ${award.id}`)
  ).rowCount;
  assert.ok((audits ?? 0) >= 2);
});

test("membership overlap refuses; ending is prospective, never a rewrite", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const orgId = ARTIFACT!.orgId;
  const program = await createBenefitProgram({
    orgId,
    actorId: HRMGR!,
    code: `MBR${Date.now().toString(36).toUpperCase()}`,
    name: "mbr",
    family: "reward",
    currency: "USD",
    effectiveFrom: "2026-01-01",
    valuation: "fixed",
    fixedAmount: "100.0000",
    legalEntityId: ENTITY!,
    payComponentId: COMPONENT!,
    sourceAccountIds: [ACCOUNT!],
  });
  const member = await addProgramMembership({
    orgId,
    actorId: HRMGR!,
    programId: program.id,
    employmentId: EMPLOYMENT!,
    effectiveFrom: "2026-01-01",
  });
  await assert.rejects(
    addProgramMembership({
      orgId,
      actorId: HRMGR!,
      programId: program.id,
      employmentId: EMPLOYMENT!,
      effectiveFrom: "2026-06-01",
    }),
    /already holds membership/,
  );
  await assert.rejects(
    removeProgramMembership({
      orgId,
      actorId: HRMGR!,
      membershipId: member.id,
      reason: "backdated exit",
      effectiveTo: "2020-01-01",
    }),
    /rewrites source history/,
  );
  const ended = await removeProgramMembership({
    orgId,
    actorId: HRMGR!,
    membershipId: member.id,
    reason: "transferred out",
  });
  assert.ok(ended.effectiveTo !== null);
  const members = await listProgramMemberships({ orgId, actorId: HRMGR!, programId: program.id });
  assert.equal(members.length, 1);
});

test("restricted actors list and read only their own entity", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const orgId = ARTIFACT!.orgId;
  const restricted = await mkHr(orgId, "Entity Reader", "entity_reader", [ENTITY as string], [
    "hrm.benefits.read",
    "hrm.benefits.manage",
  ]);
  const own = await draftProgram(`OWN${Date.now().toString(36).toUpperCase()}`);
  const foreign = await createBenefitProgram({
    orgId,
    actorId: HRMGR!,
    code: `FRN${Date.now().toString(36).toUpperCase()}`,
    name: "foreign",
    family: "reward",
    currency: "USD",
    effectiveFrom: "2026-01-01",
    valuation: "fixed",
    fixedAmount: "100.0000",
    legalEntityId: OTHER_ENTITY!,
    payComponentId: COMPONENT!,
    sourceAccountIds: [ACCOUNT!],
  });
  const seen = await listBenefitPrograms({ orgId, actorId: restricted });
  assert.ok(seen.programs.some((row) => row.id === own.id));
  assert.ok(seen.programs.every((row) => row.id !== foreign.id));
  await assert.rejects(
    getBenefitProgram(db, orgId, restricted, foreign.id),
    (error: unknown) => error instanceof BenefitsError && error.code === "NOT_FOUND",
  );
  const read = await getBenefitProgram(db, orgId, restricted, own.id);
  assert.equal(read.id, own.id);
});

test("nonprivileged connection cannot SET its way across tenants or history", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const orgId = ARTIFACT!.orgId;
  const program = await draftProgram(`GUC${Date.now().toString(36).toUpperCase()}`);
  await activateBenefitProgram({ orgId, actorId: HRMGR!, programId: program.id });
  const award = await createBenefitAward({
    orgId,
    actorId: HRMGR!,
    programId: program.id,
    employmentId: EMPLOYMENT!,
    periodFrom: "2026-10-01",
    value: "100.0000",
    currency: "USD",
  });
  // Custom GUCs are settable by any login — the protection is the privileged
  // predicate inside the policy and trigger, not SET denial. With both GUCs
  // forced on, cross-tenant rows stay invisible and snapshot rewrites still
  // raise; RESET restores the pooled connection afterwards.
  // One transaction, one connection: SET LOCAL cannot leak to the pool,
  // and the org context is set explicitly so RLS evaluates instead of the
  // query silently matching zero rows.
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local app.bypass_rls = 'on'`);
    await tx.execute(sql`set local openbooks.amend = 'on'`);
    assert.match(orgId, /^[0-9a-f-]{36}$/i);
    await tx.execute(sql.raw(`set local app.current_org = '${orgId}'`));
    const foreign = (
      await tx.execute<{ id: string }>(sql`
        select id from hrm_benefit_programs where org_id <> ${orgId} limit 1
      `)
    ).rows;
    assert.equal(foreign.length, 0);
    await assert.rejects(
      tx.execute(sql`
        update hrm_benefit_awards set value = '11.0000'
         where org_id = ${orgId} and id = ${award.id}
      `),
      (error: unknown) => /immutable|adjusting award/.test(String((error as { cause?: unknown }).cause ?? error)),
    );
    throw new Rollback();
  }).catch((error: unknown) => {
    if (!(error instanceof Rollback)) throw error;
  });
});

test("realistic refusals name the remedy", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const orgId = ARTIFACT!.orgId;
  const program = await draftProgram(`RM${Date.now().toString(36).toUpperCase()}`);
  await activateBenefitProgram({ orgId, actorId: HRMGR!, programId: program.id });
  await assert.rejects(
    createBenefitAward({
      orgId,
      actorId: HRMGR!,
      programId: program.id,
      employmentId: EMPLOYMENT!,
      periodFrom: "2026-09-01",
      value: "12,34",
      currency: "USD",
    }),
    /decimal point/,
  );
  await assert.rejects(
    createBenefitProgram({
      orgId,
      actorId: HRMGR!,
      code: `Q${Date.now().toString(36).toUpperCase()}`,
      name: "quarterly",
      family: "incentive",
      currency: "USD",
      effectiveFrom: "2026-01-01",
      legalEntityId: ENTITY!,
      payComponentId: COMPONENT!,
      valuation: "percent",
      percentRate: "5.0000",
      metric: "revenue",
      metricScope: "company",
      frequency: "quarterly",
      sourceAccountIds: [ACCOUNT!],
    }),
    /calendar or fiscal/,
  );
});

test("a payroll award cannot queue without a native adjustment and remains approved", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const orgId = ARTIFACT!.orgId;
  const program = await draftProgram(`LINK${Date.now().toString(36).toUpperCase()}`);
  await activateBenefitProgram({ orgId, actorId: HRMGR!, programId: program.id });
  const award = await createBenefitAward({ orgId, actorId: HRMGR!, programId: program.id,
    employmentId: EMPLOYMENT!, periodFrom: "2026-03-01", value: "100.0000", currency: "USD" });
  await submitBenefitAward({ orgId, actorId: HRMGR!, awardId: award.id });
  await approveBenefitAward({ orgId, actorId: APPROVER!, awardId: award.id });
  await assert.rejects(queueBenefitAward({ orgId, actorId: FINANCE!, awardId: award.id }), /select an editable pay run/);
  const stored = await getBenefitAward(db, orgId, HRMGR!, award.id);
  assert.equal(stored.status, "approved");
  assert.equal(stored.payRunAdjustmentId, null);
  const listed = await listBenefitAwards({ orgId, actorId: HRMGR!, programId: program.id });
  assert.equal(listed.awards[0]!.approvedBy, APPROVER);
  assert.equal(listed.awards[0]!.createdBy, HRMGR);
});

test("award visibility follows the immutable program entity after employment moves", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const orgId = ARTIFACT!.orgId;
  const program = await draftProgram(`SCOPE${Date.now().toString(36).toUpperCase()}`);
  await activateBenefitProgram({ orgId, actorId: HRMGR!, programId: program.id });
  const award = await createBenefitAward({ orgId, actorId: HRMGR!, programId: program.id,
    employmentId: EMPLOYMENT!, periodFrom: "2026-03-01", value: "100.0000", currency: "USD" });
  const own = await mkHr(orgId, "Historical Reader", "historical_reader", [ENTITY!], ["hrm.benefits.read"]);
  const foreign = await mkHr(orgId, "Transfer Reader", "transfer_reader", [OTHER_ENTITY!], ["hrm.benefits.read"]);
  try {
    await db.execute(sql`update worker_employments set employer_subsidiary_id = ${OTHER_ENTITY} where org_id = ${orgId} and id = ${EMPLOYMENT}`);
    assert.equal((await getBenefitAward(db, orgId, own, award.id)).id, award.id);
    await assert.rejects(getBenefitAward(db, orgId, foreign, award.id), /not found/);
  } finally {
    await db.execute(sql`update worker_employments set employer_subsidiary_id = ${ENTITY} where org_id = ${orgId} and id = ${EMPLOYMENT}`);
  }
});

test("HR award DTOs never serialize private source measurements", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const orgId = ARTIFACT!.orgId;
  const program = await draftProgram(`PRIV${Date.now().toString(36).toUpperCase()}`);
  await activateBenefitProgram({ orgId, actorId: HRMGR!, programId: program.id });
  const award = await createBenefitAward({ orgId, actorId: HRMGR!, programId: program.id,
    employmentId: EMPLOYMENT!, periodFrom: "2026-03-01", value: "100.0000", currency: "USD" });
  const dto = await getBenefitAward(db, orgId, HRMGR!, award.id);
  assert.equal("sourceSnapshot" in dto, false);
  assert.equal("source_snapshot" in dto, false);
  assert.equal("programSnapshot" in dto, false);
});

async function queuedPayrollAward() {
  const orgId = ARTIFACT!.orgId;
  const program = await draftProgram(`PAY${randomUUID().slice(0, 8).toUpperCase()}`);
  await activateBenefitProgram({ orgId, actorId: HRMGR!, programId: program.id });
  const award = await createBenefitAward({ orgId, actorId: HRMGR!, programId: program.id,
    employmentId: EMPLOYMENT!, periodFrom: "2026-03-01", value: "100.0000", currency: "USD" });
  await submitBenefitAward({ orgId, actorId: HRMGR!, awardId: award.id });
  await approveBenefitAward({ orgId, actorId: APPROVER!, awardId: award.id });
  const worker = (await db.execute<{ worker_party_id: string }>(sql`
    select worker_party_id from worker_employments where org_id = ${orgId} and id = ${EMPLOYMENT}
  `)).rows[0]!.worker_party_id;
  const schedule = randomUUID();
  await db.execute(sql`insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end, subsidiary_id)
    values (${schedule}, ${orgId}, ${`Benefits ${schedule}`}, 'biweekly', 26, '2026-03-14', ${ENTITY})`);
  const existing = (await db.execute<{ id: string }>(sql`
    select id from employee_payroll_profiles where org_id = ${orgId} and employment_id = ${EMPLOYMENT}
  `)).rows[0];
  if (existing) {
    await db.execute(sql`update employee_payroll_profiles set pay_schedule_id = ${schedule} where org_id = ${orgId} and id = ${existing.id}`);
  } else {
    await db.execute(sql`insert into employee_payroll_profiles
      (org_id, employee_party_id, employment_id, pay_schedule_id, country, province)
      values (${orgId}, ${worker}, ${EMPLOYMENT}, ${schedule}, 'US', 'TX')`);
  }
  const run = randomUUID();
  await db.execute(sql`insert into documents
    (id, org_id, kind, document_number, document_date, currency, subsidiary_id, status, subtotal, tax_total, total)
    values (${run}, ${orgId}, 'pay_run', ${`PAY-${run}`}, '2026-03-14', 'USD', ${ENTITY}, 'draft', 0, 0, 0)`);
  await db.execute(sql`insert into pay_runs
    (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date, tax_year, run_status, run_type)
    values (${run}, ${orgId}, ${schedule}, '2026-03-01', '2026-03-14', '2026-03-20', 2026, 'draft', 'regular')`);
  const queued = await queueAwardForPayRun({ orgId, actorId: FINANCE!, awardId: award.id, runDocumentId: run });
  return { orgId, program, queued, run };
}

test("queued linkage freezes and void removes its native payable input atomically", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { orgId, queued, run } = await queuedPayrollAward();
  assert.equal(queued.award.payRunDocumentId, run);
  assert.equal(queued.award.payRunAdjustmentId, queued.adjustmentId);
  await assert.rejects(db.execute(sql`update hrm_benefit_awards set pay_run_document_id = null
    where org_id = ${orgId} and id = ${queued.award.id}`),
    (error: unknown) => /payroll linkage is immutable/.test(String((error as { cause?: unknown }).cause ?? error)));
  const voided = await voidBenefitAward({ orgId, actorId: HRMGR!, awardId: queued.award.id, reason: "Canceled before payment" });
  assert.equal(voided.status, "voided");
  assert.equal(voided.payRunAdjustmentId, null);
  const remaining = (await db.execute(sql`select id from pay_run_adjustments where org_id = ${orgId} and id = ${queued.adjustmentId}`)).rows;
  assert.equal(remaining.length, 0);
});

test("committed run without the award's paid stub cannot report delivery or void", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { orgId, queued, run } = await queuedPayrollAward();
  await db.execute(sql`update pay_runs set run_status = 'committed' where org_id = ${orgId} and document_id = ${run}`);
  await assert.rejects(recordPayrollDelivery({ orgId, actorId: FINANCE!, awardId: queued.award.id,
    payRunDocumentId: run, payRunAdjustmentId: queued.adjustmentId }), /no matching paid stub line/);
  await assert.rejects(voidBenefitAward({ orgId, actorId: HRMGR!, awardId: queued.award.id, reason: "Cannot cancel paid run" }), /finalized pay run/);
  assert.equal((await getBenefitAward(db, orgId, HRMGR!, queued.award.id)).status, "queued");
});
