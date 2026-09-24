import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedApprovalFlow,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { HRM_COMP_CYCLE_SUBJECT_KIND } from "@openbooks/schema/src/hrm-compensation.ts";
import { decideGate } from "../flows/gates.ts";
import { CompensationError } from "./compensation/errors.ts";
import {
  createJobFamily,
  createJobLevel,
  updateJobFamily,
} from "./compensation/architecture.ts";
import {
  compaRatioFor,
  createPayBand,
  listPayBands,
  resolveBandForScope,
} from "./compensation/bands.ts";
import {
  approveLine,
  approvePlanLine,
  cancelCycle,
  closeCycle,
  computeGapSnapshot,
  createCycle,
  createPlan,
  createPlanLine,
  cyclePacing,
  fulfilPayInformationRequest,
  generateStatement,
  getCycle,
  listCycleLines,
  listCycles,
  markPlanLineFilledForRequisition,
  openCycle,
  proposeLine,
  pushCycle,
  rejectLine,
  reopenLine,
  requestPayInformation,
  submitCycleForApproval,
} from "./compensation/index.ts";

/**
 * HR-12 DB coverage (integration partition — run by the integrator at
 * gate; skips without OPENBOOKS_DB_URL): migrations 0221/0222 tables
 * plus RLS, architecture and bands, the cycle open → propose → approve
 * (Flows) → push (one wage row, idempotent) → statement path, headcount
 * plan approve → requisition → hire-fill hook, gap snapshots with a
 * known unexplained gap, pay-information requests, and every named
 * refusal through the real code path with the writes that must NOT
 * exist asserted.
 *
 * Proofs are read back from storage, never from the service's own
 * return values alone.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function grantPermissions(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

async function linkPerson(orgId: string, userId: string, partyId?: string): Promise<string> {
  const id = partyId ?? randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${id}, ${orgId}, 'person', ${`Person ${id.slice(0, 8)}`}, true, '{}'::jsonb)
  `);
  await db.execute(sql`update users set party_id = ${id} where id = ${userId} and org_id = ${orgId}`);
  return id;
}

async function enableHrm(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true)
     where id = ${orgId}`);
}

async function setCompensationSettings(orgId: string, patch: Record<string, unknown>): Promise<void> {
  const current = (await db.execute<{ settings: Record<string, unknown> }>(sql`
    select settings from orgs where id = ${orgId}`)).rows[0]?.settings ?? {};
  const next = { ...(current as Record<string, unknown>), compensation: { ...((current as Record<string, unknown>).compensation as Record<string, unknown> ?? {}), ...patch } };
  await db.execute(sql`update orgs set settings = ${JSON.stringify(next)}::jsonb where id = ${orgId}`);
}

type Harness = {
  org: ScratchOrg;
  hrId: string;
  managerId: string;
  employeeId: string;
  outsiderId: string;
};

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableHrm(org.orgId);
  const hrId = await createScratchUser(org.orgId, "Comp HR", "comp_hr");
  const managerId = await createScratchUser(org.orgId, "Comp Manager", "comp_manager");
  const employeeId = await createScratchUser(org.orgId, "Comp Employee", "comp_employee");
  const outsiderId = await createScratchUser(org.orgId, "Comp Outsider", "comp_outsider");
  await grantPermissions(org.orgId, hrId, ["hrm.compensation.read", "hrm.compensation.manage", "hrm.compensation.approve", "hrm.recruiting.manage"]);
  await grantPermissions(org.orgId, managerId, ["hrm.compensation.read", "hrm.self.read", "hrm.compensation.approve"]);
  await grantPermissions(org.orgId, employeeId, ["hrm.self.read", "hrm.self.request"]);
  await linkPerson(org.orgId, hrId);
  await linkPerson(org.orgId, managerId);
  await linkPerson(org.orgId, employeeId);
  await linkPerson(org.orgId, outsiderId);
  return { org, hrId, managerId, employeeId, outsiderId };
}

/** Worker employment with one live version plus a primary positioned assignment. */
async function seedPositionedEmployment(
  orgId: string,
  subsidiaryId: string,
  opts: { workerPartyId?: string; status?: string; from?: string; positionCode?: string; levelId?: string | null; departmentId?: string | null },
): Promise<{ employmentId: string; workerPartyId: string; positionId: string | null }> {
  const workerPartyId = opts.workerPartyId ?? randomUUID();
  if (!opts.workerPartyId) {
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${workerPartyId}, ${orgId}, 'person', 'Comp Worker', true, '{}'::jsonb)
    `);
  }
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${workerPartyId}, ${subsidiaryId}, 1)
  `);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
    values (${orgId}, ${employmentId}, 1, ${opts.status ?? "active"}, ${opts.from ?? "2020-01-01"}::date, null, now())
  `);
  let positionId: string | null = null;
  if (opts.levelId !== undefined) {
    positionId = randomUUID();
    await db.execute(sql`
      insert into positions (id, org_id, position_code, revision)
      values (${positionId}, ${orgId}, ${opts.positionCode ?? `POS-${positionId.slice(0, 6)}`}, 1)
    `);
    await db.execute(sql`
      insert into position_versions (org_id, position_id, version_no, title, department_id, location_id,
        employer_subsidiary_id, planned_fte, status, effective_from, job_level_id)
      values (${orgId}, ${positionId}, 1, 'Engineer', ${opts.departmentId ?? null}, null,
        ${subsidiaryId}, 1, 'filled', '2020-01-01', ${opts.levelId})
    `);
    const assignmentId = randomUUID();
    await db.execute(sql`
      insert into employment_assignments (id, org_id, employment_id, assignment_key)
      values (${assignmentId}, ${orgId}, ${employmentId}, 'primary')
    `);
    await db.execute(sql`
      insert into employment_assignment_versions (org_id, assignment_id, employment_id, version_no,
        job_title, department_id, fte, is_primary, effective_from, position_id)
      values (${orgId}, ${assignmentId}, ${employmentId}, 1,
        'Engineer', ${opts.departmentId ?? null}, 1, true, '2020-01-01', ${positionId})
    `);
  }
  return { employmentId, workerPartyId, positionId };
}

async function seedWage(orgId: string, actorId: string, workerPartyId: string, rate: string, from = "2020-01-01"): Promise<void> {
  // Through the canonical writer: overlapping inserts are refused by
  // the exclusion constraint, so every new start supersedes properly.
  const { withOrgTransaction } = await import("../platform/db.ts");
  const { supersedeLaborCostRate } = await import("../projects/labor-cost-rates.ts");
  await withOrgTransaction(orgId, async () => {
    await supersedeLaborCostRate({
      orgId,
      actorId,
      scope: { employeePartyId: workerPartyId, jobTitle: null, tradeId: null, departmentId: null, subsidiaryId: null },
      effectiveFrom: from,
      rate: rate,
      currency: "CAD",
      basis: "year",
      annualHours: "2080",
      notes: null,
      reason: "test wage",
    });
  });
}

async function seedManagerLink(orgId: string, employmentId: string, managerEmploymentId: string): Promise<void> {
  const relationshipId = randomUUID();
  await db.execute(sql`
    insert into reporting_relationships (org_id, employment_id, manager_employment_id, kind,
      relationship_id, version_no, effective_from)
    values (${orgId}, ${employmentId}, ${managerEmploymentId}, 'line', ${relationshipId}, 1, '2020-01-01')
  `);
}

/** Trigger refusals arrive wrapped: Drizzle carries the pg message on the cause chain. */
function triggerRefusal(pattern: RegExp): (e: unknown) => boolean {
  return (e: unknown) => {
    let current: unknown = e;
    for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
      const message = (current as { message?: unknown }).message;
      if (typeof message === "string" && pattern.test(message)) return true;
      current = (current as { cause?: unknown }).cause ?? null;
    }
    return false;
  };
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  if (!DB) return;
  const h = await setupHarness();
  try {
    await fn(h);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
}

async function seedArchitecture(orgId: string, hrId: string) {
  const family = await createJobFamily({ orgId, actorId: hrId, code: "ENG", name: "Engineering" });
  const level = await createJobLevel({
    orgId,
    actorId: hrId,
    familyId: family.id,
    code: "IC3",
    name: "Engineer III",
    rank: 3,
    equalValueCriteria: [
      { criterion: "skills", weight: "3" },
      { criterion: "effort", weight: "2" },
      { criterion: "responsibility", weight: "3" },
      { criterion: "working_conditions", weight: "1" },
    ],
  });
  const band = await createPayBand({
    orgId,
    actorId: hrId,
    scope: { familyId: family.id, levelId: level.id, employerSubsidiaryId: null, locationId: null },
    currency: "CAD",
    basis: "annual",
    min: "80000",
    target: "100000",
    max: "120000",
    effectiveFrom: "2020-01-01",
    reason: "test band",
  });
  return { family, level, band };
}

test("HR-12 architecture refuses duplicate codes and unconfigured families", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const family = await createJobFamily({ orgId: org.orgId, actorId: h.hrId, code: "ENG", name: "Engineering" });
    assert.equal(family.code, "ENG");
    await assert.rejects(
      createJobFamily({ orgId: org.orgId, actorId: h.hrId, code: "ENG", name: "Duplicate" }),
      (e: unknown) => e instanceof CompensationError && /already exists/.test(e.message),
    );
    // Levels need at least one equal-value criterion — the directive rule.
    await assert.rejects(
      createJobLevel({ orgId: org.orgId, actorId: h.hrId, familyId: family.id, code: "IC1", name: "One", rank: 1, equalValueCriteria: [] }),
      /at least one equal-value criterion/,
    );
    await assert.rejects(
      createJobLevel({ orgId: org.orgId, actorId: h.hrId, familyId: randomUUID(), code: "IC1", name: "One", rank: 1, equalValueCriteria: [{ criterion: "skills", weight: "1" }] }),
      /not visible in this organization/,
    );
    // Deactivating the family preserves the row.
    const retired = await updateJobFamily({ orgId: org.orgId, actorId: h.hrId, familyId: family.id, isActive: false, reason: "retire" });
    assert.equal(retired.isActive, false);
    const stored = (await db.execute<{ is_active: boolean }>(sql`
      select is_active from hrm_job_families where org_id = ${org.orgId} and id = ${family.id}`)).rows[0];
    assert.equal(stored?.is_active, false);
  });
});

test("HR-12 bands version and place employments, refusing no-band and no-wage by name", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level, band } = await seedArchitecture(org.orgId, h.hrId);
    assert.equal(band.target, "100000.0000");
    // A reordered band refuses instead of storing a rung nobody can sit in.
    await assert.rejects(
      createPayBand({
        orgId: org.orgId, actorId: h.hrId,
        scope: { familyId: null, levelId: level.id, employerSubsidiaryId: null, locationId: null },
        currency: "CAD", basis: "annual", min: "120000", target: "100000", max: "110000",
        effectiveFrom: "2021-01-01", reason: "bad",
      }),
      /not ordered min <= target <= max/,
    );
    const emp = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, emp.workerPartyId, "90000");
    const placed = await compaRatioFor(org.orgId, h.hrId, emp.employmentId, "2024-06-01");
    assert.equal(placed.placement, "in_range");
    assert.equal(placed.compaRatio, "0.9000000000");
    assert.equal(placed.band?.id, band.id);
    // Below-min placement names its side.
    await seedWage(org.orgId, h.hrId, emp.workerPartyId, "95000", "2024-01-01");
    const placed2 = await compaRatioFor(org.orgId, h.hrId, emp.employmentId, "2025-06-01");
    assert.equal(placed2.compaRatio, "0.9500000000");
    // No band for another level refuses by name (never zero).
    const otherFamily = await createJobFamily({ orgId: org.orgId, actorId: h.hrId, code: "DES", name: "Design" });
    const otherLevel = await createJobLevel({
      orgId: org.orgId, actorId: h.hrId, familyId: otherFamily.id, code: "D1", name: "Designer", rank: 1,
      equalValueCriteria: [{ criterion: "skills", weight: "1" }],
    });
    const emp2 = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: otherLevel.id });
    await seedWage(org.orgId, h.hrId, emp2.workerPartyId, "70000");
    await assert.rejects(
      compaRatioFor(org.orgId, h.hrId, emp2.employmentId, "2024-06-01"),
      /no band covers this employment/,
    );
    // No wage refuses by name.
    const emp3 = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    await assert.rejects(
      compaRatioFor(org.orgId, h.hrId, emp3.employmentId, "2024-06-01"),
      /no payroll-side wage covers/,
    );
    // Narrower scope wins resolution.
    const narrow = await createPayBand({
      orgId: org.orgId, actorId: h.hrId,
      scope: { familyId: null, levelId: level.id, employerSubsidiaryId: org.subsidiaryId, locationId: null },
      currency: "CAD", basis: "annual", min: "85000", target: "95000", max: "110000",
      effectiveFrom: "2020-01-01", reason: "subsidiary band",
    });
    const resolved = await resolveBandForScope(org.orgId, {
      familyId: null, levelId: level.id, employerSubsidiaryId: org.subsidiaryId, locationId: null,
      currency: "CAD", basis: "annual",
    }, "2024-06-01");
    assert.equal(resolved?.id, narrow.id);
    const bands = await listPayBands({ orgId: org.orgId, actorId: h.hrId, levelId: level.id, asOf: "2024-06-01" });
    assert.equal(bands.length, 2);
  });
});

test("HR-12 cycle open proposes within guideline, flags outside, and refuses empty scope", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedArchitecture(org.orgId, h.hrId);
    const emp = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, emp.workerPartyId, "90000");
    // Manager holds the structural scope over the employee.
    const mgrParty = (await db.execute<{ party_id: string }>(sql`
      select party_id from users where id = ${h.managerId} and org_id = ${org.orgId}`)).rows[0]?.party_id;
    const mgrEmp = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { workerPartyId: mgrParty, levelId: level.id });
    await seedWage(org.orgId, h.hrId, mgrParty!, "120000");
    await seedManagerLink(org.orgId, emp.employmentId, mgrEmp.employmentId);
    const cycle = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "Merit 2025", kind: "merit",
      effectiveOn: "2025-04-01", currency: "CAD", guidelineKind: "matrix",
      guideline: {
        rows: ["meets"], cols: ["q1", "q2", "q3", "q4"],
        cells: { meets: { q1: { min: 3, max: 5 }, q2: { min: 2, max: 4 }, q3: { min: 1, max: 3 }, q4: { min: 0, max: 2 } } },
        unratedRow: "meets",
      },
    });
    const opened = await openCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    assert.equal(opened.lines, 2);
    const lines = await listCycleLines({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const empLine = lines.find((l) => l.employmentId === emp.employmentId)!;
    assert.ok(empLine);
    assert.equal(empLine.currentRate, "90000.0000");
    assert.equal(empLine.compaRatio, "0.9000000000");
    // 0.90 → q2 → meets row → 2–4%.
    assert.equal(empLine.guidelineMinPct, "2.000000");
    // Outside-guideline without a reason refuses and writes nothing.
    await assert.rejects(
      proposeLine({ orgId: org.orgId, actorId: h.managerId, lineId: empLine.id, proposedPct: 10 }),
      /outside the guideline 2%–4%.*need a reason/,
    );
    const untouched = (await db.execute<{ status: string }>(sql`
      select status from hrm_comp_cycle_lines where org_id = ${org.orgId} and id = ${empLine.id}`)).rows[0];
    assert.equal(untouched?.status, "pending");
    // Within guideline proposes cleanly.
    const proposed = await proposeLine({ orgId: org.orgId, actorId: h.managerId, lineId: empLine.id, proposedPct: 3 });
    assert.equal(proposed.status, "proposed");
    assert.equal(proposed.proposedRate, "92700.0000");
    // A stranger (no manage grant, no team) is refused.
    await assert.rejects(
      proposeLine({ orgId: org.orgId, actorId: h.outsiderId, lineId: empLine.id, proposedPct: 3 }),
      /proposals come from the employment's manager/,
    );
    // Reopen a decided line with reason; pushed lines never reopen (covered below).
    const decided = await approveLine({ orgId: org.orgId, actorId: h.hrId, lineId: empLine.id });
    assert.equal(decided.status, "approved");
    const reopened = await reopenLine({ orgId: org.orgId, actorId: h.managerId, lineId: empLine.id, reason: "market moved" });
    assert.equal(reopened.status, "proposed");
    // The proposer cannot decide their own line.
    await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: empLine.id, proposedPct: 3 });
    await assert.rejects(
      approveLine({ orgId: org.orgId, actorId: h.hrId, lineId: empLine.id }),
      /cannot decide their own line/,
    );
    // A rejection needs its reason — the manager reads it.
    await assert.rejects(
      rejectLine({ orgId: org.orgId, actorId: h.managerId, lineId: empLine.id, reason: "  " }),
      /non-blank reason is required/,
    );
    const rejected = await rejectLine({ orgId: org.orgId, actorId: h.managerId, lineId: empLine.id, reason: "over budget for the team" });
    assert.equal(rejected.status, "rejected");
  });
});

test("HR-12 cycle approval runs through Flows and push writes each wage once", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedArchitecture(org.orgId, h.hrId);
    const emp = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, emp.workerPartyId, "100000");
    const cycle = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "Merit 2025", kind: "merit",
      effectiveOn: "2025-04-01", currency: "CAD", guidelineKind: "matrix",
      guideline: {
        rows: ["meets"], cols: ["q1", "q2", "q3", "q4"],
        cells: { meets: { q1: { min: 3, max: 5 }, q2: { min: 2, max: 4 }, q3: { min: 1, max: 3 }, q4: { min: 0, max: 2 } } },
        unratedRow: "meets",
      },
    });
    await openCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const [line] = await listCycleLines({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: line!.id, proposedPct: 3, reason: "hr proposes" });
    // Submitting with no enabled flow refuses by name (the approval IS a Flows run).
    await assert.rejects(
      submitCycleForApproval({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id }),
      /no enabled approval flow produced an approval gate/,
    );
    // The approval is a Flows run: the gate goes to an approver who is
    // not the submitter (self-approval is forbidden outright).
    const cycleApprover = await createScratchUser(org.orgId, "Comp Cycle Approver", "comp_cycle_approver");
    await grantPermissions(org.orgId, cycleApprover, ["hrm.compensation.read", "hrm.compensation.approve"]);
    await linkPerson(org.orgId, cycleApprover);
    await seedApprovalFlow(org.orgId, {
      subjectKind: HRM_COMP_CYCLE_SUBJECT_KIND,
      assignees: [{ type: "user", userId: cycleApprover }],
      mode: "any",
    });
    const submitted = await submitCycleForApproval({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    assert.equal(submitted.status, "in_review");
    assert.ok(submitted.flowRunId);
    const gate = (await db.execute<{ id: string; status: string }>(sql`
      select id, status from flow_gates where subject_id = ${cycle.id} order by created_at`)).rows[0]!;
    await decideGate({ gateId: gate.id, decision: "approved", userId: cycleApprover });
    const released = (await db.execute<{ status: string }>(sql`
      select status from hrm_comp_cycles where org_id = ${org.orgId} and id = ${cycle.id}`)).rows[0];
    assert.equal(released?.status, "approved");
    await approveLine({ orgId: org.orgId, actorId: cycleApprover, lineId: line!.id });
    const pushed = await pushCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    assert.equal(pushed.pushed, 1);
    assert.equal(pushed.skipped, 0);
    // Exactly one wage row governs the date; the line links it.
    const wages = (await db.execute<{ id: string; rate: string }>(sql`
      select id, rate::text as rate from labor_cost_rates
       where org_id = ${org.orgId} and employee_party_id = ${emp.workerPartyId}
         and effective_from = '2025-04-01'::date and is_active`)).rows;
    assert.equal(wages.length, 1);
    assert.equal(wages[0]!.rate, "103000.0000");
    const link = (await db.execute<{ pushed_rate_id: string; status: string }>(sql`
      select pushed_rate_id, status from hrm_comp_cycle_lines where org_id = ${org.orgId} and id = ${line!.id}`)).rows[0];
    assert.equal(link?.pushed_rate_id, wages[0]!.id);
    assert.equal(link?.status, "pushed");
    // A second push of the round is refused (the round already moved payroll)...
    await assert.rejects(pushCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id }), /cannot push/);
    // ...and the line-level link makes re-push a skip, never a double:
    // rewind only the cycle (a crash between the line writes and the
    // cycle flip); the pushed line is verified org-scoped and skipped.
    await db.execute(sql`
      update hrm_comp_cycles set status = 'approved' where org_id = ${org.orgId} and id = ${cycle.id}`);
    const repushed = await pushCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    assert.equal(repushed.pushed, 0);
    assert.equal(repushed.skipped, 1);
    const wagesAfter = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from labor_cost_rates
       where org_id = ${org.orgId} and employee_party_id = ${emp.workerPartyId} and is_active`)).rows[0];
    assert.equal(wagesAfter?.n, "2");
    // A pushed line never reopens.
    await assert.rejects(
      reopenLine({ orgId: org.orgId, actorId: h.hrId, lineId: line!.id, reason: "oops" }),
      /already moved payroll/,
    );
    await closeCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    await assert.rejects(cancelCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id, reason: "late" }), /cannot cancel/);
  });
});

test("HR-12 post-push line actions refuse, and push refuses approved lines with no raise", { skip: !DB }, async () => {
  // F3-38: pushed history is immutable through the service (submit,
  // propose, decide, and reopen all refuse past push), and an approved
  // line that changes nothing refuses the push instead of writing a
  // redundant wage row. The pushed audit event names the count.
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedArchitecture(org.orgId, h.hrId);
    const emp = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, emp.workerPartyId, "100000");
    const cycleApprover = await createScratchUser(org.orgId, "Comp Cycle Approver", "comp_cycle_approver");
    await grantPermissions(org.orgId, cycleApprover, ["hrm.compensation.read", "hrm.compensation.approve"]);
    await linkPerson(org.orgId, cycleApprover);
    await seedApprovalFlow(org.orgId, {
      subjectKind: HRM_COMP_CYCLE_SUBJECT_KIND,
      assignees: [{ type: "user", userId: cycleApprover }],
      mode: "any",
    });
    const wide = { min: 0, max: 10 };
    const matrix = {
      rows: ["meets"],
      cols: ["q1", "q2", "q3", "q4"],
      cells: { meets: { q1: wide, q2: wide, q3: wide, q4: wide } },
      unratedRow: "meets",
    };
    async function approvedCycle(name: string): Promise<{ cycleId: string; lineId: string }> {
      const cycle = await createCycle({
        orgId: org.orgId, actorId: h.hrId, name, kind: "adjustment",
        effectiveOn: "2025-04-01", currency: "CAD", guidelineKind: "matrix", guideline: matrix,
      });
      await openCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
      const [line] = await listCycleLines({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
      return { cycleId: cycle.id, lineId: line!.id };
    }
    async function releaseCycle(cycleId: string): Promise<void> {
      await submitCycleForApproval({ orgId: org.orgId, actorId: h.hrId, cycleId });
      const gate = (await db.execute<{ id: string }>(sql`
        select id from flow_gates where subject_id = ${cycleId} order by created_at`)).rows[0]!;
      await decideGate({ gateId: gate.id, decision: "approved", userId: cycleApprover });
    }
    // Cycle A runs the whole lifecycle to pushed.
    const pushed = await approvedCycle("Post-push");
    await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: pushed.lineId, proposedPct: 3 });
    await releaseCycle(pushed.cycleId);
    await approveLine({ orgId: org.orgId, actorId: cycleApprover, lineId: pushed.lineId });
    const result = await pushCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: pushed.cycleId });
    assert.equal(result.pushed, 1);
    await assert.rejects(
      submitCycleForApproval({ orgId: org.orgId, actorId: h.hrId, cycleId: pushed.cycleId }),
      /cannot be submitted/,
      "submit-for-approval after push refuses",
    );
    await assert.rejects(
      proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: pushed.lineId, proposedPct: 2 }),
      /takes no proposals/,
      "proposing after push refuses",
    );
    await assert.rejects(
      approveLine({ orgId: org.orgId, actorId: cycleApprover, lineId: pushed.lineId }),
      /decides no lines/,
      "deciding after push refuses",
    );
    await assert.rejects(
      rejectLine({ orgId: org.orgId, actorId: cycleApprover, lineId: pushed.lineId, reason: "late" }),
      /decides no lines/,
      "rejecting after push refuses",
    );
    const trail = (await db.execute<{ lineId: string | null; reason: string | null }>(sql`
      select line_id as "lineId", reason from hrm_comp_events
       where org_id = ${org.orgId} and cycle_id = ${pushed.cycleId} and kind = 'pushed'
       order by line_id nulls last`)).rows;
    assert.equal(trail.length, 2, "the push leaves the line event and the cycle event");
    assert.equal(trail[0]!.lineId, pushed.lineId, "the line event names its line");
    assert.equal(trail[1]!.lineId, null, "the cycle event closes the round");
    assert.match(trail[1]!.reason ?? "", /1 lines pushed/, "the cycle event names the pushed count");
    // Cycle B approves a zero raise: the push refuses instead of writing
    // an identical wage row, and nothing is stored.
    const flat = await approvedCycle("No raise");
    await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: flat.lineId, proposedPct: 0 });
    await releaseCycle(flat.cycleId);
    await approveLine({ orgId: org.orgId, actorId: cycleApprover, lineId: flat.lineId });
    await assert.rejects(
      pushCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: flat.cycleId }),
      /carries no raise/,
      "an approved line with no raise refuses the push",
    );
    const wages = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from labor_cost_rates
       where org_id = ${org.orgId} and employee_party_id = ${emp.workerPartyId}
         and effective_from = '2025-04-01'::date`)).rows[0];
    assert.equal(wages?.n, "1", "only cycle A wrote a wage row");
  });
});

test("HR-12 cross-org wage link on a pushed line halts the push", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedArchitecture(org.orgId, h.hrId);
    const emp = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, emp.workerPartyId, "100000");
    const cycle = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "X", kind: "adjustment",
      effectiveOn: "2025-04-01", currency: "CAD", guidelineKind: "matrix",
      guideline: { rows: ["meets"], cols: ["q1"], cells: { meets: { q1: { min: 0, max: 10 } } }, unratedRow: "meets" },
    });
    await openCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const [line] = await listCycleLines({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    await seedApprovalFlow(org.orgId, { subjectKind: HRM_COMP_CYCLE_SUBJECT_KIND, assignees: [{ type: "user", userId: h.hrId }], mode: "any" });
    await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: line!.id, proposedPct: 2, reason: "x" });
    // Forge a real wage row in a SECOND org and link it onto the pushed
    // line (bypassing the service, the way a hostile write would): the
    // FK lets the link exist (it names a real rate), so the service's
    // org check is the unit under test — the push must halt, not skip.
    const foreignOrg = await createScratchOrg();
    const foreignParty = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${foreignParty}, ${foreignOrg.orgId}, 'person', 'Foreign Worker', true, '{}'::jsonb)`);
    const foreignRate: string = (await db.execute<{ id: string }>(sql`
      insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours, effective_from)
      values (${foreignOrg.orgId}, ${foreignParty}, 'CAD', 1, 'year', 2080, '2025-04-01')
      returning id`)).rows[0]!.id;
    // approver_party_id is a PARTY, and this used to write h.hrId, which
    // is a USER id. It stored fine until 0241 gave the column its foreign
    // key; the service has always resolved users.party_id for it, so the
    // forge now does the same.
    const approverParty = (await db.execute<{ party_id: string | null }>(sql`
      select party_id from users where id = ${h.hrId}`)).rows[0]?.party_id ?? null;
    await db.execute(sql`
      update hrm_comp_cycle_lines
         set pushed_rate_id = ${foreignRate}, status = 'pushed',
             approver_party_id = ${approverParty}, decided_at = now()
       where id = ${line!.id}`);
    // Drive the cycle to approved without the gate (unit of the check under test).
    await db.execute(sql`update hrm_comp_cycles set status = 'approved' where id = ${cycle.id}`);
    await assert.rejects(
      pushCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id }),
      /outside this organization/,
    );
    // Unforge on the governed amend path (transaction-scoped GUC, so no
    // session leaks into other tests) before teardown drops the foreign org.
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('openbooks.amend', 'on', true)`);
      await tx.execute(sql`delete from hrm_comp_cycle_lines where id = ${line!.id}`);
    });
    await dropScratchOrg(foreignOrg.orgId);
  });
});

test("HR-12 headcount plan lines cost from bands and approve into requisitions", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedArchitecture(org.orgId, h.hrId);
    await setCompensationSettings(org.orgId, { burdenRate: "0.20" });
    const plan = await createPlan({ orgId: org.orgId, actorId: h.hrId, name: "FY26 plan", fiscalPeriodFrom: "2026-01-01", fiscalPeriodTo: "2026-12-31" });
    const line = await createPlanLine({
      orgId: org.orgId, actorId: h.hrId, planId: plan.id, kind: "create",
      title: "Engineer III", employerSubsidiaryId: org.subsidiaryId, jobLevelId: level.id,
      plannedFte: "1", startOn: "2026-03-01", currency: "CAD", reason: "growth",
    });
    // 100000 target × 1.0 FTE × 1.20 burden, with its inputs explainable.
    assert.equal(line.estAnnualCost, "120000.0000");
    assert.deepEqual(line.costBasis, {
      basis: "band_target", annual_target: "100000.0000", planned_fte: "1",
      burden_rate: "0.20", burden_source: "compensation_settings",
    });
    // A create line with a position is refused at the gate.
    await assert.rejects(
      createPlanLine({
        orgId: org.orgId, actorId: h.hrId, planId: plan.id, kind: "create", positionId: randomUUID(),
        title: "Bad", employerSubsidiaryId: org.subsidiaryId, jobLevelId: level.id,
        plannedFte: "1", startOn: "2026-03-01", currency: "CAD",
      }),
      /names no position until approval/,
    );
    // Terminate lines are informational: approving one opens no requisition.
    const emp = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    const termLine = await createPlanLine({
      orgId: org.orgId, actorId: h.hrId, planId: plan.id, kind: "terminate", positionId: emp.positionId,
      title: "Sunset role", employerSubsidiaryId: org.subsidiaryId, jobLevelId: level.id,
      plannedFte: "1", startOn: "2026-06-01", currency: "CAD",
    });
    const approvedTerm = await approvePlanLine({ orgId: org.orgId, actorId: h.hrId, lineId: termLine.id });
    assert.equal(approvedTerm.status, "approved");
    assert.equal(approvedTerm.requisitionId, null);
    // The employment still stands: terminate lines never end employments.
    const stillThere = (await db.execute<{ status: string }>(sql`
      select status from worker_employment_versions
       where org_id = ${org.orgId} and employment_id = ${emp.employmentId} and recorded_until is null`)).rows[0];
    assert.equal(stillThere?.status, "active");
    const approved = await approvePlanLine({ orgId: org.orgId, actorId: h.hrId, lineId: line.id });
    assert.equal(approved.status, "opened");
    assert.ok(approved.requisitionId);
    // A hire against the requisition marks the line filled.
    await markPlanLineFilledForRequisition(org.orgId, approved.requisitionId!);
    const filled = (await db.execute<{ status: string }>(sql`
      select status from hrm_headcount_plan_lines where org_id = ${org.orgId} and id = ${line.id}`)).rows[0];
    assert.equal(filled?.status, "filled");
  });
});

test("HR-12 gap snapshots measure a known unexplained gap and flag joint assessment", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    // Unconfigured comparison attribute refuses by name.
    await assert.rejects(
      computeGapSnapshot({ orgId: org.orgId, actorId: h.hrId, asOf: "2024-06-01", groupA: "A", groupB: "B" }),
      /no comparison attribute is configured/,
    );
    await setCompensationSettings(org.orgId, { comparisonAttributeKey: "eeo_group", gapThresholdPct: 5 });
    const { level } = await seedArchitecture(org.orgId, h.hrId);
    // Six workers split 3/3 across groups with group B paid exactly 80%
    // of group A and tenure balanced across the groups (so tenure cannot
    // explain the gap): the OLS unexplained gap must read ~25% (A over
    // B) and flag assessment.
    const mkWorker = async (group: string, rate: string, from: string): Promise<void> => {
      const partyId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${partyId}, ${org.orgId}, 'person', ${`W ${partyId.slice(0, 6)}`}, true,
                ${JSON.stringify({ eeo_group: group })}::jsonb)
      `);
      await seedPositionedEmployment(org.orgId, org.subsidiaryId, { workerPartyId: partyId, levelId: level.id, from });
      await seedWage(org.orgId, h.hrId, partyId, rate);
    };
    await mkWorker("A", "100000", "2018-01-01");
    await mkWorker("A", "100000", "2020-01-01");
    await mkWorker("A", "100000", "2022-01-01");
    await mkWorker("B", "80000", "2018-01-01");
    await mkWorker("B", "80000", "2020-01-01");
    await mkWorker("B", "80000", "2022-01-01");
    const snapshot = await computeGapSnapshot({ orgId: org.orgId, actorId: h.hrId, asOf: "2024-06-01", groupA: "A", groupB: "B" });
    assert.equal(snapshot.metrics.headcountA, 3);
    assert.equal(snapshot.metrics.headcountB, 3);
    // Mean gap of A over B: (100000-80000)/80000 = 25%.
    assert.ok(Math.abs(snapshot.metrics.meanGapPct! - 25) < 0.001, `mean ${snapshot.metrics.meanGapPct}`);
    assert.ok(Math.abs(snapshot.metrics.medianGapPct! - 25) < 0.001);
    assert.equal(snapshot.categories.length, 1);
    const category = snapshot.categories[0]!;
    assert.ok(Math.abs(category.unexplainedGapPct! - 25) < 0.5, `unexplained ${category.unexplainedGapPct}`);
    assert.equal(category.method, "ols_log_rate");
    assert.equal(category.jointAssessmentDue, true);
    // Frozen: updates refused on every path.
    await assert.rejects(
      db.execute(sql`update hrm_pay_gap_snapshots set metrics = '{}'::jsonb where id = ${snapshot.id}`),
      triggerRefusal(/frozen/),
    );
  });
});

test("HR-12 pay information requests need a window and answer from snapshots", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedArchitecture(org.orgId, h.hrId);
    const empPartyRow = (await db.execute<{ party_id: string }>(sql`
      select party_id from users where id = ${h.employeeId} and org_id = ${org.orgId}`)).rows[0];
    assert.ok(empPartyRow?.party_id);
    const empParty = empPartyRow.party_id;
    const emp = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { workerPartyId: empParty, levelId: level.id });
    await seedWage(org.orgId, h.hrId, empParty, "90000");
    // No response window: refused by name before the first request.
    await assert.rejects(
      requestPayInformation({ orgId: org.orgId, actorId: h.employeeId, employmentId: emp.employmentId }),
      /no response window is configured/,
    );
    await setCompensationSettings(org.orgId, { responseDays: 30, comparisonAttributeKey: "eeo_group" });
    const req = await requestPayInformation({ orgId: org.orgId, actorId: h.employeeId, employmentId: emp.employmentId });
    assert.equal(req.status, "open");
    // No snapshot covers the category: fulfil refuses.
    await assert.rejects(
      fulfilPayInformationRequest({ orgId: org.orgId, actorId: h.hrId, requestId: req.id }),
      /no gap snapshot exists/,
    );
    // A stranger cannot file for someone else's employment.
    await assert.rejects(
      requestPayInformation({ orgId: org.orgId, actorId: h.outsiderId, employmentId: emp.employmentId }),
      /your own employment/,
    );
  });
});

test("HR-12 statements freeze the total-rewards payload", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedArchitecture(org.orgId, h.hrId);
    const emp = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, emp.workerPartyId, "90000");
    const statement = await generateStatement({
      orgId: org.orgId, actorId: h.hrId, employmentId: emp.employmentId,
      periodFrom: "2025-01-01", periodTo: "2025-12-31",
    });
    const payload = statement.payload as Record<string, unknown>;
    assert.ok(payload.currentRate);
    assert.deepEqual(payload.bandPlacement, {
      placement: "in_range", compaRatio: "0.9000000000",
      band: { min: "80000.0000", target: "100000.0000", max: "120000.0000", currency: "CAD" },
    });
    // Other-org reads report not-found.
    const other = await createScratchOrg();
    try {
      await assert.rejects(
        generateStatement({ orgId: other.orgId, actorId: h.hrId, employmentId: emp.employmentId, periodFrom: "2025-01-01", periodTo: "2025-12-31" }),
        /not visible in this organization/,
      );
    } finally {
      await dropScratchOrg(other.orgId);
    }
  });
});

test("HR-12 compensation events are append-only and RLS-isolated", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedArchitecture(org.orgId, h.hrId);
    const emp = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, emp.workerPartyId, "90000");
    const cycle = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "E", kind: "cola",
      effectiveOn: "2025-01-01", currency: "CAD", guidelineKind: "matrix",
      guideline: { rows: ["meets"], cols: ["q1"], cells: { meets: { q1: { min: 0, max: 10 } } }, unratedRow: "meets" },
    });
    await openCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    await assert.rejects(
      db.execute(sql`update hrm_comp_events set reason = 'rewritten' where cycle_id = ${cycle.id}`),
      triggerRefusal(/append-only/),
    );
    // RLS: a second org sees none of the first org's rows.
    const other = await createScratchOrg();
    try {
      const seen = (await db.execute<{ n: string }>(sql`
        select count(*)::text as n from hrm_comp_cycles where org_id = ${other.orgId}`)).rows[0];
      assert.equal(seen?.n, "0");
    } finally {
      await dropScratchOrg(other.orgId);
    }
  });
});

test("HR-12 cycle reads fence salaries to the actor's subsidiary lens", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedArchitecture(org.orgId, h.hrId);
    // A second legal entity in the same org.
    const subB = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
        from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
    const empA = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    const empB = await seedPositionedEmployment(org.orgId, subB, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, empA.workerPartyId, "90000");
    await seedWage(org.orgId, h.hrId, empB.workerPartyId, "100000");
    // A compensation reader scoped to subsidiary A only, and one scoped nowhere.
    const readerA = await createScratchUser(org.orgId, "Comp Reader A", "comp_reader_a");
    await db.execute(sql`
      update app_roles
         set permissions = '["hrm.compensation.read"]'::jsonb,
             subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb
       where org_id = ${org.orgId} and key = 'comp_reader_a'`);
    const readerNone = await createScratchUser(org.orgId, "Comp Reader None", "comp_reader_none");
    await db.execute(sql`
      update app_roles
         set permissions = '["hrm.compensation.read"]'::jsonb,
             subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [] })}::jsonb
       where org_id = ${org.orgId} and key = 'comp_reader_none'`);
    const guideline = {
      rows: ["meets"], cols: ["q1", "q2", "q3", "q4"],
      cells: { meets: { q1: { min: 3, max: 5 }, q2: { min: 2, max: 4 }, q3: { min: 1, max: 3 }, q4: { min: 0, max: 2 } } },
      unratedRow: "meets",
    };
    const open = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "Merit 2025", kind: "merit",
      effectiveOn: "2025-04-01", budgetBasis: "combined", budgetTotal: "10000",
      currency: "CAD", guidelineKind: "matrix", guideline,
    });
    const opened = await openCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: open.id });
    assert.equal(opened.lines, 2);
    const scopedA = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "Merit A", kind: "merit",
      effectiveOn: "2025-04-01", currency: "CAD", guidelineKind: "matrix", guideline,
      scope: { employerSubsidiaryId: org.subsidiaryId },
    });
    const scopedB = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "Merit B", kind: "merit",
      effectiveOn: "2025-04-01", currency: "CAD", guidelineKind: "matrix", guideline,
      scope: { employerSubsidiaryId: subB },
    });
    // Lines: the unrestricted HR role sees both salaries; the A-scoped
    // reader sees only A's line (B's pay is not observable through a
    // read grant alone); the empty scope sees no lines at all.
    const allLines = await listCycleLines({ orgId: org.orgId, actorId: h.hrId, cycleId: open.id });
    assert.equal(allLines.length, 2);
    const aLines = await listCycleLines({ orgId: org.orgId, actorId: readerA, cycleId: open.id });
    assert.equal(aLines.length, 1);
    assert.equal(aLines[0]!.employmentId, empA.employmentId);
    assert.equal(aLines[0]!.currentRate, "90000.0000");
    const noLines = await listCycleLines({ orgId: org.orgId, actorId: readerNone, cycleId: open.id });
    assert.equal(noLines.length, 0);
    // Discovery: scoped rounds outside the lens are not listed; the mixed
    // (unscoped) round stays discoverable because headers carry no pay.
    const seenA = await listCycles({ orgId: org.orgId, actorId: readerA });
    assert.ok(seenA.some((c) => c.id === open.id));
    assert.ok(seenA.some((c) => c.id === scopedA.id));
    assert.ok(!seenA.some((c) => c.id === scopedB.id));
    const seenNone = await listCycles({ orgId: org.orgId, actorId: readerNone });
    assert.ok(seenNone.some((c) => c.id === open.id));
    assert.ok(!seenNone.some((c) => c.id === scopedA.id));
    assert.ok(!seenNone.some((c) => c.id === scopedB.id));
    const seenAll = await listCycles({ orgId: org.orgId, actorId: h.hrId });
    assert.ok(seenAll.some((c) => c.id === scopedB.id));
    // Direct reads: a hidden scoped round refuses as not-found (the same
    // message as a missing round, never an existence oracle).
    await assert.rejects(
      getCycle({ orgId: org.orgId, actorId: readerA, cycleId: scopedB.id }),
      /not visible in this organization/,
    );
    await assert.rejects(
      getCycle({ orgId: org.orgId, actorId: readerNone, cycleId: scopedA.id }),
      /not visible in this organization/,
    );
    const visibleA = await getCycle({ orgId: org.orgId, actorId: readerA, cycleId: scopedA.id });
    assert.equal(visibleA.id, scopedA.id);
    const visibleOpen = await getCycle({ orgId: org.orgId, actorId: readerNone, cycleId: open.id });
    assert.equal(visibleOpen.id, open.id);
    // Cross-org: a reader from a second org cannot see this org's round.
    const other = await createScratchOrg();
    try {
      const otherReader = await createScratchUser(other.orgId, "Other Reader", "other_reader");
      await grantPermissions(other.orgId, otherReader, ["hrm.compensation.read"]);
      await assert.rejects(
        getCycle({ orgId: other.orgId, actorId: otherReader, cycleId: open.id }),
        /not visible in this organization/,
      );
    } finally {
      await dropScratchOrg(other.orgId);
    }
    // Pacing: propose 3% on both lines (A +2700, B +3000 against a 10000
    // envelope). The unrestricted pacing reads 57%; the A-scoped pacing
    // reads only A's 27% — B's increase cannot leak through the percent.
    // The envelope math itself is unchanged, only the input rows fence.
    const lineA = allLines.find((l) => l.employmentId === empA.employmentId)!;
    const lineB = allLines.find((l) => l.employmentId === empB.employmentId)!;
    await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: lineA.id, proposedPct: 3, reason: "scope test" });
    await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: lineB.id, proposedPct: 3, reason: "scope test" });
    const full = await cyclePacing(org.orgId, h.hrId, open.id);
    assert.ok(Math.abs(full.totalPct! - 57) < 1e-9);
    assert.equal(full.overBudget, false);
    const scoped = await cyclePacing(org.orgId, readerA, open.id);
    assert.ok(Math.abs(scoped.totalPct! - 27) < 1e-9);
    assert.equal(scoped.overBudget, false);
    const empty = await cyclePacing(org.orgId, readerNone, open.id);
    assert.equal(empty.totalPct, 0);
    assert.equal(empty.overBudget, false);
  });
});

test("HR-12 cycle propose stays open to grant-less structural managers", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedArchitecture(org.orgId, h.hrId);
    const emp = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, emp.workerPartyId, "90000");
    // A structural manager holding only team-scoped grants: no
    // hrm.compensation.read, manage, or approve anywhere.
    const teamMgr = await createScratchUser(org.orgId, "Team Manager", "team_manager");
    await grantPermissions(org.orgId, teamMgr, ["hrm.self.read", "hrm.team.read"]);
    const mgrParty = await linkPerson(org.orgId, teamMgr);
    const mgrEmp = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { workerPartyId: mgrParty, levelId: level.id });
    await seedWage(org.orgId, h.hrId, mgrParty, "120000");
    await seedManagerLink(org.orgId, emp.employmentId, mgrEmp.employmentId);
    // A 1000 envelope: the manager's +2700 proposal paces 270%, so the
    // over-budget control engages on a grant-less proposer.
    const cycle = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "Merit 2025", kind: "merit",
      effectiveOn: "2025-04-01", budgetBasis: "combined", budgetTotal: "1000",
      currency: "CAD", guidelineKind: "matrix",
      guideline: {
        rows: ["meets"], cols: ["q1", "q2", "q3", "q4"],
        cells: { meets: { q1: { min: 3, max: 5 }, q2: { min: 2, max: 4 }, q3: { min: 1, max: 3 }, q4: { min: 0, max: 2 } } },
        unratedRow: "meets",
      },
    });
    await openCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const lines = await listCycleLines({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const empLine = lines.find((l) => l.employmentId === emp.employmentId)!;
    // Over budget with no reason: refused, and the refusal carries no
    // whole-cycle percentage — the manager holds no compensation.read
    // grant, and public cyclePacing would deny them the same number.
    const refusal = await proposeLine({ orgId: org.orgId, actorId: teamMgr, lineId: empLine.id, proposedPct: 3 }).then(
      () => { throw new Error("expected the over-budget proposal to refuse"); },
      (e: unknown) => String((e as { message?: unknown }).message ?? e),
    );
    assert.match(refusal, /over-budget pacing needs a reason/);
    assert.ok(!/takes the cycle to \d/.test(refusal), `refusal must not carry the hidden total: ${refusal}`);
    // With a reason the same proposal lands: the write control demands
    // no read grant, so a valid proposal is never rolled back on a
    // permission refusal.
    const proposed = await proposeLine({ orgId: org.orgId, actorId: teamMgr, lineId: empLine.id, proposedPct: 3, reason: "annual merit" });
    assert.equal(proposed.status, "proposed");
    assert.equal(proposed.proposedRate, "92700.0000");
    // The read side stays gated: the same manager cannot list salaries.
    await assert.rejects(
      listCycleLines({ orgId: org.orgId, actorId: teamMgr, cycleId: cycle.id }),
      /hrm\.compensation\.read/,
    );
  });
});

test("HR-12 restricted proposers still face the whole-cycle budget control", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const { org } = h;
    const { level } = await seedArchitecture(org.orgId, h.hrId);
    const subB = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
        from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
    const empA = await seedPositionedEmployment(org.orgId, org.subsidiaryId, { levelId: level.id });
    const empB = await seedPositionedEmployment(org.orgId, subB, { levelId: level.id });
    await seedWage(org.orgId, h.hrId, empA.workerPartyId, "90000");
    await seedWage(org.orgId, h.hrId, empB.workerPartyId, "100000");
    // A proposer with the manage grant but a subsidiary-A lens.
    const proposerA = await createScratchUser(org.orgId, "Proposer A", "proposer_a");
    await db.execute(sql`
      update app_roles
         set permissions = '["hrm.compensation.manage"]'::jsonb,
             subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb
       where org_id = ${org.orgId} and key = 'proposer_a'`);
    const guideline = {
      rows: ["meets"], cols: ["q1", "q2", "q3", "q4"],
      cells: { meets: { q1: { min: 3, max: 5 }, q2: { min: 2, max: 4 }, q3: { min: 1, max: 3 }, q4: { min: 0, max: 2 } } },
      unratedRow: "meets",
    };
    // A +2700 then B +3000 against a 5000 envelope: A alone paces 54%,
    // the whole cycle paces 114%.
    const cycle = await createCycle({
      orgId: org.orgId, actorId: h.hrId, name: "Merit 2025", kind: "merit",
      effectiveOn: "2025-04-01", budgetBasis: "combined", budgetTotal: "5000",
      currency: "CAD", guidelineKind: "matrix", guideline,
    });
    await openCycle({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const lines = await listCycleLines({ orgId: org.orgId, actorId: h.hrId, cycleId: cycle.id });
    const lineA = lines.find((l) => l.employmentId === empA.employmentId)!;
    const lineB = lines.find((l) => l.employmentId === empB.employmentId)!;
    await proposeLine({ orgId: org.orgId, actorId: h.hrId, lineId: lineA.id, proposedPct: 3, reason: "scope test" });
    // The restricted proposer takes the whole cycle over budget without a
    // reason: refused even though their visible 54% slice looks funded —
    // the lens cannot shrink the envelope.
    const refusal = await proposeLine({
      orgId: org.orgId, actorId: proposerA, lineId: lineB.id, proposedPct: 3,
    }).then(
      () => { throw new Error("expected the over-budget proposal to refuse"); },
      (e: unknown) => String((e as { message?: unknown }).message ?? e),
    );
    assert.match(refusal, /over-budget pacing needs a reason/);
    assert.ok(!/takes the cycle to \d/.test(refusal), `refusal must not carry the hidden total: ${refusal}`);
    // Nothing was written by the refused proposal.
    const untouched = (await db.execute<{ status: string }>(sql`
      select status from hrm_comp_cycle_lines where org_id = ${org.orgId} and id = ${lineB.id}`)).rows[0];
    assert.equal(untouched?.status, "pending");
    // With a reason the same proposal lands.
    const proposed = await proposeLine({
      orgId: org.orgId, actorId: proposerA, lineId: lineB.id, proposedPct: 3, reason: "market catch-up",
    });
    assert.equal(proposed.status, "proposed");
  });
});
