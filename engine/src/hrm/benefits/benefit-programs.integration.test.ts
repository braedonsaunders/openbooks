import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

class Rollback extends Error {}
import test from "node:test";
import { db, withOrgTransaction } from "../../platform/db.ts";
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
  seedEmployment,
  mkVersion,
  addLiveVersion,
} from "../../testing/hrm-harness.ts";
import { installEngineSeams } from "../../composition/install.ts";
import { decideGate } from "../../flows/gates.ts";
import { isUuid } from "../../platform/uuid.ts";
import { BenefitsError } from "./errors.ts";
import {
  activateBenefitProgram,
  addProgramMembership,
  closeBenefitProgram,
  createBenefitProgram,
  getBenefitProgram,
  listBenefitPrograms,
  updateBenefitProgram,
  listProgramSources,
} from "./programs.ts";
import {
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
 * Isolation (second org sees nothing), configured native approval controls,
 * retry safety
 * (a repeated settlement with the same source key lands once), and history
 * (snapshots immutable, events append-only, audit evidence per move).
 * Requires the integration partition with its marked scratch database.
 */
test("Benefits programs and payout controls", { skip: !process.env.OPENBOOKS_DB_URL }, async (t) => {
  let ARTIFACT: ScratchOrg | null = null;
  let HRMGR: string | null = null;
  let APPROVER: string | null = null;
  let FINANCE: string | null = null;
  let ENTITY: string | null = null;
  let OTHER_ENTITY: string | null = null;
  let EMPLOYMENT: string | null = null;
  let COMPONENT: string | null = null;
  let ACCOUNT: string | null = null;
  t.after(async () => {
    if (ARTIFACT) await dropScratchOrg(ARTIFACT.orgId);
  });

  {
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
    installEngineSeams();
    const graph = { schemaVersion: 1, nodes: [
      { id: "submit", position: {x:0,y:0}, data: {kind:"trigger",trigger:{trigger:"on_submit"}} },
      { id: "approve", position: {x:200,y:0}, data: {kind:"gate",gate:{title:"Benefits approval",assignees:[{type:"user",userId:APPROVER}],mode:"any",preventSelfApproval:true}} }
    ], edges:[{id:"submit-approve",source:"submit",target:"approve",sourceHandle:"next"}] };
    await db.execute(sql`insert into flows (org_id,name,subject_kind,enabled,graph) values (${orgId},'Benefits approval','hrm_benefit_award',true,${JSON.stringify(graph)}::jsonb)`);
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
  }

  async function approveThroughWorkflow(orgId: string, actorId: string, awardId: string): Promise<void> {
    const gate = (await db.execute<{id:string}>(sql`select id from flow_gates where org_id=${orgId} and subject_kind='hrm_benefit_award' and subject_id=${awardId} and status='pending'`)).rows[0];
    assert.ok(gate);
    await decideGate({gateId:gate.id,decision:"approved",userId:actorId});
  }

  async function draftProgram(code: string, overrides: Record<string, unknown> = {}) {
    const orgId = ARTIFACT!.orgId;
    const program = await createBenefitProgram({
      orgId,
      actorId: HRMGR!,
      code,
      name: code,
      family: "reward",
      approvalMode: "flows",
      currency: "CAD",
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

  function programFor(options: Partial<Parameters<typeof createBenefitProgram>[0]> & Pick<Parameters<typeof createBenefitProgram>[0], "code" | "name" | "family">) {
    return createBenefitProgram({ orgId: ARTIFACT!.orgId, actorId: HRMGR!, currency: "CAD", effectiveFrom: "2026-01-01", payComponentId: COMPONENT!, ...options });
  }
  function awardFor(programId: string, options: Pick<Parameters<typeof createBenefitAward>[0], "periodFrom"> & Partial<Parameters<typeof createBenefitAward>[0]>) {
    return createBenefitAward({ orgId: ARTIFACT!.orgId, actorId: HRMGR!, employmentId: EMPLOYMENT!, currency: "CAD", value: "100.0000", ...options, programId });
  }
  function activate(programId: string) {
    return activateBenefitProgram({ orgId: ARTIFACT!.orgId, actorId: HRMGR!, programId });
  }
  await t.test("second organization sees nothing of the first", async () => {
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

  await t.test("restricted actor configures only their own entity", async () => {
    const orgId = ARTIFACT!.orgId;
    const restricted = await mkHr(orgId, "Entity Author", "entity_author", [ENTITY as string], [
      "hrm.benefits.read",
      "hrm.benefits.manage",
    ]);
    await assert.rejects(
      programFor({
        actorId: restricted,
        code: `WIDE${Date.now().toString(36).toUpperCase()}`,
        name: "wide",
        family: "reward",
        approvalMode: "flows",
        valuation: "fixed",
        fixedAmount: "100.0000",
        legalEntityId: null,
        sourceAccountIds: [ACCOUNT!],
      }),
      /unrestricted managers/,
    );
    await assert.rejects(
      programFor({
        actorId: restricted,
        code: `OTHR${Date.now().toString(36).toUpperCase()}`,
        name: "other",
        family: "reward",
        approvalMode: "flows",
        valuation: "fixed",
        fixedAmount: "100.0000",
        legalEntityId: OTHER_ENTITY!,
        sourceAccountIds: [ACCOUNT!],
      }),
      (error: unknown) => error instanceof BenefitsError,
    );
  });

  await t.test("activation needs a legal entity; closure preserves history", async () => {
    const orgId = ARTIFACT!.orgId;
    const bare = await programFor({
      code: `BARE${Date.now().toString(36).toUpperCase()}`,
      name: "bare",
      family: "allowance",
      valuation: "fixed",
      fixedAmount: "100.0000",
      legalEntityId: null,
      sourceAccountIds: [ACCOUNT!],
    });
    await assert.rejects(activate(bare.id), /legal entity/);
    const program = await draftProgram(`CLS${Date.now().toString(36).toUpperCase()}`);
    const active = await activate(program.id);
    assert.equal(active.status, "active");
    const closed = await closeBenefitProgram({
      orgId,
      actorId: HRMGR!,
      programId: program.id,
      reason: "annual program ended",
    });
    assert.equal(closed.status, "closed");
    await assert.rejects(
      activate(program.id),
      (error: unknown) => error instanceof BenefitsError && error.code === "BAD_STATE",
    );
  });

  await t.test("repeated settlement with the same source key lands once", async () => {
    const orgId = ARTIFACT!.orgId;
    const program = await draftProgram(`RTY${Date.now().toString(36).toUpperCase()}`);
    await activate(program.id);
    const key = `retry-${program.id}`;
    const first = await awardFor(program.id, { periodFrom: "2026-04-01", sourceKey: key });
    await assert.rejects(
      awardFor(program.id, { periodFrom: "2026-04-01", sourceKey: key }),
      /already recorded/,
    );
    const listed = await listBenefitAwards({ orgId, actorId: HRMGR!, programId: program.id });
    assert.equal(listed.awards.filter((row) => row.sourceKey === key).length, 1);
    assert.equal(first.status, "draft");
  });

  await t.test("per-award cap and pool budget refuse over-issuance", async () => {
    const capped = await draftProgram(`CAP${Date.now().toString(36).toUpperCase()}`, {
      valuation: "pool",
      fixedAmount: null,
      budgetAmount: "200.0000",
      capAmount: "100.0000",
    });
    await activate(capped.id);
    await assert.rejects(
      awardFor(capped.id, { periodFrom: "2026-05-01", value: "150.0000" }),
      /per-award cap/,
    );
    await awardFor(capped.id, { periodFrom: "2026-05-01" });
    await awardFor(capped.id, { periodFrom: "2026-06-01" });
    await assert.rejects(
      awardFor(capped.id, { periodFrom: "2026-07-01", value: "1.0000" }),
      /budget .* cannot cover/,
    );
  });

  await t.test("award snapshots are immutable evidence; voiding keeps the row", async () => {
    const orgId = ARTIFACT!.orgId;
    const program = await draftProgram(`HST${Date.now().toString(36).toUpperCase()}`);
    await activate(program.id);
    const award = await awardFor(program.id, { periodFrom: "2026-08-01", evidence: { metric: "approved_hours", measured: "160.0000" } });
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

  await t.test("membership overlap refuses; ending is prospective, never a rewrite", async () => {
    const orgId = ARTIFACT!.orgId;
    const program = await programFor({
      code: `MBR${Date.now().toString(36).toUpperCase()}`,
      name: "mbr",
      family: "reward",
      approvalMode: "flows",
      valuation: "fixed",
      fixedAmount: "100.0000",
      legalEntityId: ENTITY!,
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

  await t.test("restricted actors list and read only their own entity", async () => {
    const orgId = ARTIFACT!.orgId;
    const restricted = await mkHr(orgId, "Entity Reader", "entity_reader", [ENTITY as string], [
      "hrm.benefits.read",
      "hrm.benefits.manage",
    ]);
    const own = await draftProgram(`OWN${Date.now().toString(36).toUpperCase()}`);
    const foreign = await programFor({
      code: `FRN${Date.now().toString(36).toUpperCase()}`,
      name: "foreign",
      family: "reward",
      approvalMode: "flows",
      valuation: "fixed",
      fixedAmount: "100.0000",
      legalEntityId: OTHER_ENTITY!,
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

  await t.test("nonprivileged connection cannot SET its way across tenants or history", async () => {
    const orgId = ARTIFACT!.orgId;
    const program = await draftProgram(`GUC${Date.now().toString(36).toUpperCase()}`);
    await activate(program.id);
    const award = await awardFor(program.id, { periodFrom: "2026-10-01" });
    // Custom GUCs are settable by any login — the protection is the privileged
    // predicate inside the policy and trigger, not SET denial. With both GUCs
    // forced on, cross-tenant rows stay invisible and snapshot rewrites still
    // raise; RESET restores the pooled connection afterwards.
    // One transaction, one connection: SET LOCAL cannot leak to the pool,
    // and the org context is set explicitly so RLS evaluates instead of the
    // query silently matching zero rows.
    await withOrgTransaction(orgId, async () => {
      const tx = db;
      await tx.execute(sql`set local app.bypass_rls = 'on'`);
      await tx.execute(sql`set local openbooks.amend = 'on'`);
      assert.ok(isUuid(orgId));
      await tx.execute(sql.raw(`set local app.current_org = '${orgId}'`));
      const foreign = (
        await tx.execute<{ id: string }>(sql`
          select id from hrm_benefit_programs where org_id <> ${orgId} limit 1
        `)
      ).rows;
      assert.equal(foreign.length, 0);
      const visible = (await tx.execute<{ id: string; privileged: boolean }>(sql`
        select id, public.app_bypass_rls_active() as privileged from hrm_benefit_awards
         where org_id = ${orgId} and id = ${award.id}
      `)).rows;
      assert.equal(visible.length, 1, "the guarded write must target a visible award, never zero rows");
      assert.equal(visible[0]!.privileged, false, "raw GUCs confer no privileged authority");
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

  await t.test("realistic refusals name the remedy", async () => {
    const program = await draftProgram(`RM${Date.now().toString(36).toUpperCase()}`);
    await activate(program.id);
    await assert.rejects(
      awardFor(program.id, { periodFrom: "2026-09-01", value: "12,34" }),
      /decimal point/,
    );
    await assert.rejects(
      programFor({
        code: `Q${Date.now().toString(36).toUpperCase()}`,
        name: "quarterly",
        family: "incentive",
        legalEntityId: ENTITY!,
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

  await t.test("a payroll award cannot queue without a native adjustment and remains approved", async () => {
    const orgId = ARTIFACT!.orgId;
    const program = await draftProgram(`LINK${Date.now().toString(36).toUpperCase()}`);
    await activate(program.id);
    const award = await awardFor(program.id, { periodFrom: "2026-03-01" });
    await submitBenefitAward({ orgId, actorId: HRMGR!, awardId: award.id });
    await approveThroughWorkflow(orgId, APPROVER!, award.id);
    await assert.rejects(queueBenefitAward({ orgId, actorId: FINANCE!, awardId: award.id }), /select an editable pay run/);
    const stored = await getBenefitAward(db, orgId, HRMGR!, award.id);
    assert.equal(stored.status, "approved");
    assert.equal(stored.payRunAdjustmentId, null);
    const listed = await listBenefitAwards({ orgId, actorId: HRMGR!, programId: program.id });
    assert.equal(listed.awards[0]!.approvedBy, APPROVER);
    assert.equal(listed.awards[0]!.createdBy, HRMGR);
  });

  await t.test("award visibility and employer identity remain bound to the original legal entity", async () => {
    const orgId = ARTIFACT!.orgId;
    const program = await draftProgram(`SCOPE${Date.now().toString(36).toUpperCase()}`);
    await activate(program.id);
    const award = await awardFor(program.id, { periodFrom: "2026-03-01" });
    const own = await mkHr(orgId, "Historical Reader", "historical_reader", [ENTITY!], ["hrm.benefits.read"]);
    const foreign = await mkHr(orgId, "Transfer Reader", "transfer_reader", [OTHER_ENTITY!], ["hrm.benefits.read"]);
    await assert.rejects(
      db.execute(sql`update worker_employments set employer_subsidiary_id = ${OTHER_ENTITY} where org_id = ${orgId} and id = ${EMPLOYMENT}`),
      (error: unknown) => /employer_subsidiary_id is immutable/.test(String((error as { cause?: unknown }).cause ?? error)),
    );
    assert.equal((await getBenefitAward(db, orgId, own, award.id)).id, award.id);
    await assert.rejects(getBenefitAward(db, orgId, foreign, award.id), /not found/);
  });

  await t.test("HR award DTOs never serialize private source measurements", async () => {
    const orgId = ARTIFACT!.orgId;
    const program = await draftProgram(`PRIV${Date.now().toString(36).toUpperCase()}`);
    await activate(program.id);
    const award = await awardFor(program.id, { periodFrom: "2026-03-01" });
    const dto = await getBenefitAward(db, orgId, HRMGR!, award.id);
    assert.equal("sourceSnapshot" in dto, false);
    assert.equal("source_snapshot" in dto, false);
    assert.equal("programSnapshot" in dto, false);
  });

  async function queuedPayrollAward() {
    const orgId = ARTIFACT!.orgId;
    const program = await draftProgram(`PAY${randomUUID().slice(0, 8).toUpperCase()}`);
    await activate(program.id);
    const award = await awardFor(program.id, { periodFrom: "2026-03-01" });
    await submitBenefitAward({ orgId, actorId: HRMGR!, awardId: award.id });
    await approveThroughWorkflow(orgId, APPROVER!, award.id);
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
      values (${run}, ${orgId}, 'pay_run', ${`PAY-${run}`}, '2026-03-14', 'CAD', ${ENTITY}, 'draft', 0, 0, 0)`);
    await db.execute(sql`insert into pay_runs
      (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date, tax_year, run_status, run_type)
      values (${run}, ${orgId}, ${schedule}, '2026-03-01', '2026-03-14', '2026-03-20', 2026, 'draft', 'regular')`);
    const queued = await queueAwardForPayRun({ orgId, actorId: FINANCE!, awardId: award.id, runDocumentId: run });
    return { orgId, program, queued, run };
  }

  await t.test("queued linkage freezes and void removes its native payable input atomically", async () => {
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

  await t.test("committed run without the award's paid stub cannot report delivery or void", async () => {
    const { orgId, queued, run } = await queuedPayrollAward();
    await db.execute(sql`update pay_runs set run_status = 'committed' where org_id = ${orgId} and document_id = ${run}`);
    await assert.rejects(recordPayrollDelivery({ orgId, actorId: FINANCE!, awardId: queued.award.id,
      payRunDocumentId: run, payRunAdjustmentId: queued.adjustmentId }), /no matching payroll representation.*review the employee.s inclusion and calculation.*does not prove this benefit was processed/);
    await assert.rejects(voidBenefitAward({ orgId, actorId: HRMGR!, awardId: queued.award.id, reason: "Cannot cancel paid run" }), /finalized pay run/);
    assert.equal((await getBenefitAward(db, orgId, HRMGR!, queued.award.id)).status, "queued");
  });

  await t.test("draft source replacement records the full before and after policy in the audit", async () => {
    const orgId = ARTIFACT!.orgId;
    const program = await draftProgram(`AUD${randomUUID().slice(0, 8).toUpperCase()}`);
    await updateBenefitProgram({ orgId, actorId: HRMGR!, programId: program.id,
      sourceAccountIds: [], reason: "Use the component's native expense mapping" });
    assert.equal((await listProgramSources(db, orgId, HRMGR!, program.id)).length, 0);
    const rows = (await db.execute<{ changes: {
      event: string; reason: string; before: { sourceAccountIds: string[] }; after: { sourceAccountIds: string[] };
    } }>(sql`
      select changes from audit_log where org_id = ${orgId} and table_name = 'hrm_benefit_programs'
        and row_id = ${program.id} and changes->>'event' = 'updated'
    `)).rows;
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.changes.before.sourceAccountIds, [ACCOUNT!]);
    assert.deepEqual(rows[0]!.changes.after.sourceAccountIds, []);
    assert.equal(rows[0]!.changes.reason, "Use the component's native expense mapping");
  });

  await t.test("direct program and award reads honor the authoritative HRM feature gate", async () => {
    const orgId = ARTIFACT!.orgId;
    const program = await draftProgram(`GATE${randomUUID().slice(0, 8).toUpperCase()}`);
    await activate(program.id);
    const award = await awardFor(program.id, { periodFrom: "2026-03-01" });
    try {
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,hrm}', 'false'::jsonb, true) where id = ${orgId}`);
      await assert.rejects(getBenefitProgram(db, orgId, HRMGR!, program.id), /hrm feature is off/);
      await assert.rejects(getBenefitAward(db, orgId, HRMGR!, award.id), /hrm feature is off/);
      await assert.rejects(listProgramSources(db, orgId, HRMGR!, program.id), /hrm feature is off/);
    } finally {
      await enableHrm(orgId);
    }
    assert.equal((await getBenefitAward(db, orgId, HRMGR!, award.id)).id, award.id);
  });

  await t.test("award eligibility unions current active spans and excludes end dates and superseded versions", async () => {
    const orgId = ARTIFACT!.orgId;
    const program = await draftProgram(`SPAN${randomUUID().slice(0, 8).toUpperCase()}`);
    await activate(program.id);
    const consecutive = await seedEmployment(orgId, ENTITY!, { from: "2026-01-01", to: "2026-03-15" });
    await mkVersion(orgId, consecutive.employmentId, { from: "2026-03-15", versionNo: 2 });
    const ended = await seedEmployment(orgId, ENTITY!, { from: "2026-01-01", to: "2026-03-15" });
    const superseded = await seedEmployment(orgId, ENTITY!);
    await addLiveVersion(orgId, superseded.employmentId, {
      status: "terminated", from: "2020-01-01", reason: "Corrected service status", sourceRef: `status-${superseded.employmentId}`,
    });
    for (const member of [consecutive, ended, superseded]) {
      await addProgramMembership({ orgId, actorId: HRMGR!, programId: program.id,
        employmentId: member.employmentId, effectiveFrom: "2026-01-01" });
    }
    const base = { orgId, actorId: HRMGR!, programId: program.id,
      periodFrom: "2026-03-01", periodTo: "2026-03-31", value: "100.0000", currency: "CAD" };
    assert.equal((await createBenefitAward({ ...base, employmentId: consecutive.employmentId })).status, "draft");
    await assert.rejects(createBenefitAward({ ...base, employmentId: ended.employmentId,
      periodFrom: "2026-03-15", periodTo: "2026-03-15" }), /end dates exclude their day/);
    await assert.rejects(createBenefitAward({ ...base, employmentId: superseded.employmentId }), /current employment history/);
  });

  await t.test("role allocation never accepts an unweighted member or silently converts equal memberships", async () => {
    const orgId = ARTIFACT!.orgId;
    const weighted = await programFor({
      code: `ROLE${randomUUID().slice(0, 8).toUpperCase()}`,
      name: "Weighted reward",
      family: "reward",
      legalEntityId: ENTITY!,
      valuation: "fixed",
      fixedAmount: "100.0000",
      allocation: "role",
    });
    for (const weight of [null, "0.0000"]) {
      await assert.rejects(addProgramMembership({ orgId, actorId: HRMGR!, programId: weighted.id,
        employmentId: EMPLOYMENT!, effectiveFrom: "2026-01-01", weight }), /enter a positive membership weight/);
    }
    await addProgramMembership({ orgId, actorId: HRMGR!, programId: weighted.id,
      employmentId: EMPLOYMENT!, effectiveFrom: "2026-01-01", weight: "2.0000", role: "Lead" });
    assert.equal((await activate(weighted.id)).status, "active");
    const equal = await draftProgram(`EQUAL${randomUUID().slice(0, 8).toUpperCase()}`);
    await assert.rejects(updateBenefitProgram({ orgId, actorId: HRMGR!, programId: equal.id,
      allocation: "role", reason: "Change allocation" }), /keep equal allocation/);
    assert.equal((await getBenefitProgram(db, orgId, HRMGR!, equal.id)).allocation, "equal");
    const noRevenue = await programFor({
      code: `NOBAS${randomUUID().slice(0, 8).toUpperCase()}`,
      name: "Incomplete profit base",
      family: "incentive",
      legalEntityId: ENTITY!,
      valuation: "percent",
      percentRate: "5",
      metric: "net_profit",
      metricScope: "company",
      sourceAccountIds: [ACCOUNT!],
    });
    await assert.rejects(activate(noRevenue.id), /without an income source/);
    assert.equal((await getBenefitProgram(db, orgId, HRMGR!, noRevenue.id)).status, "draft");
  });

});
