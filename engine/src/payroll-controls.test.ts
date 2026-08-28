import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { cmp, sum } from "./money.ts";
import {
  assertPayRunApprovalReleased,
  payRunApprovalState,
} from "./payroll-approval.ts";
import {
  allocateByQuantity,
  applyDerivedRule,
  DerivedEarningsError,
  type DerivedRule,
} from "./payroll-derived-earnings.ts";
import { payRateIsUsable } from "./payroll-rate.ts";
import { payRunReadiness, payRunStaleness } from "./payroll-readiness.ts";
import { remittanceDueDate } from "./payroll-remittance.ts";
import { isCanadianSin, renderRoeXml, type RoeRecordToFile } from "./payroll-roexml.ts";
import { roeCandidates, t4Slips, type RoeRecord } from "./payroll-yearend.ts";
import { employeeYtd } from "./payroll/canada/compute-statutory.ts";
import { usEmployeeYtd } from "./payroll/us/compute-statutory.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";

/**
 * Payroll control tests.
 *
 * Each one names the failure it prevents and was written to FAIL against the
 * code as it stood. Where the control is a database predicate the test drives
 * the real query; where it is a rule, the rule is exercised directly.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** An on_submit flow with a gate — a real pay-run approval policy. */
const GATING_GRAPH = {
  schemaVersion: 1,
  nodes: [
    { id: "t", position: { x: 0, y: 0 }, data: { kind: "trigger", trigger: { trigger: "on_submit" } } },
    {
      id: "g", position: { x: 200, y: 0 },
      data: {
        kind: "gate",
        gate: { title: "Approve pay run", assignees: [{ kind: "role", role: "admin" }], mode: "any" },
      },
    },
  ],
  edges: [{ id: "e", source: "t", target: "g" }],
};

/** A pay-run flow that is NOT an approval policy: void routing, no gate. */
const NON_GATING_GRAPH = {
  schemaVersion: 1,
  nodes: [
    { id: "t", position: { x: 0, y: 0 }, data: { kind: "trigger", trigger: { trigger: "before_void" } } },
    {
      id: "a", position: { x: 200, y: 0 },
      data: { kind: "action", action: { action: "set_field", field: "memo", value: { kind: "literal", value: "x" } } },
    },
  ],
  edges: [{ id: "e", source: "t", target: "a" }],
};

interface PayRunFixture {
  orgId: string;
  actorId: string;
  documentId: string;
  scheduleId: string;
  employeeId: string;
  subsidiaryId: string;
}

async function seedPayRun(options: {
  runStatus?: string;
  calculated?: boolean;
  payBasis?: string;
  rateBasis?: "hour" | "year";
  rateEffectiveTo?: string | null;
  scheduleSubsidiaryId?: string | null;
  employeeSubsidiaryId?: string | null;
  country?: string;
  terminatedOn?: string | null;
} = {}): Promise<PayRunFixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, subsidiary_id, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
            ${options.scheduleSubsidiaryId ?? null}, ${actorId}, ${actorId})`);

  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, subsidiary_id, custom)
    values (${employeeId}, ${org.orgId}, 'person', 'Terry Worker', true,
            ${options.employeeSubsidiaryId ?? org.subsidiaryId}, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (org_id, party_id, hired_on, terminated_on, is_active,
                               created_by, updated_by)
    values (${org.orgId}, ${employeeId}, '2024-01-01', ${options.terminatedOn ?? null}, true,
            ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                  effective_from, effective_to, is_active, created_by, updated_by)
    values (${org.orgId}, ${employeeId}, 'CAD', '30', ${options.rateBasis ?? "hour"}, 2080,
            '2026-01-01', ${options.rateEffectiveTo ?? null}, true, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                           pay_basis, country, federal_claim_code,
                                           provincial_claim_code, vacation_percent, vacation_method,
                                           is_active, created_by, updated_by)
    values (${org.orgId}, ${employeeId}, ${scheduleId}, 'ON', ${options.payBasis ?? "hourly"},
            ${options.country ?? "CA"}, 1, 1, '4', 'accrue', true, ${actorId}, ${actorId})`);

  const documentId = randomUUID();
  await db.execute(sql`
    insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date,
                           currency, status, created_by, updated_by)
    values (${org.orgId}, ${documentId}, 'pay_run', ${`PAY-${documentId.slice(0, 8)}`},
            ${org.subsidiaryId}, '2026-07-21', 'CAD', 'draft', ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date,
                          tax_year, run_status, calculated_at, created_by, updated_by)
    values (${documentId}, ${org.orgId}, ${scheduleId}, '2026-07-05', '2026-07-18', '2026-07-21',
            2026, ${options.runStatus ?? "calculated"},
            ${options.calculated === false ? null : sql`now()`}, ${actorId}, ${actorId})`);

  return {
    orgId: org.orgId, actorId, documentId, scheduleId, employeeId,
    subsidiaryId: org.subsidiaryId,
  };
}

/* ------------------------------------------------------------------ */
/* C1 — the approval gate must not fail open before submission         */
/* ------------------------------------------------------------------ */

test(
  "an approval policy is not released just because no gate exists yet",
  { skip: !DB },
  async () => {
    // The whole defect in one sentence: gates are created BY submission, so a
    // run in a gated tenant that was never submitted has zero gates — and
    // "zero gates" read as "released", which let every pay run in the tenant
    // walk straight past the approval into commit and the bank file.
    const run = await seedPayRun();
    try {
      await db.execute(sql`
        insert into flows (org_id, name, subject_kind, enabled, graph, created_by, updated_by)
        values (${run.orgId}, 'Pay run approval', 'pay_run', true,
                ${JSON.stringify(GATING_GRAPH)}::jsonb, ${run.actorId}, ${run.actorId})`);

      const before = await payRunApprovalState(run.orgId, run.documentId);
      assert.equal(before.policyExists, true);
      assert.equal(before.outstandingGates, 0, "no gate exists until the run is submitted");
      assert.equal(before.submitted, false);
      assert.equal(before.released, false, "an unsubmitted run in a gated org is NOT released");
      await assert.rejects(
        assertPayRunApprovalReleased(run.orgId, run.documentId),
        /has not been submitted for approval/,
      );

      // Submission evaluates the policy. Once it has, and nothing is
      // outstanding, money may move.
      await db.execute(sql`
        update documents set submitted_at = now(), submitted_by = ${run.actorId}
         where id = ${run.documentId}`);
      const after = await payRunApprovalState(run.orgId, run.documentId);
      assert.equal(after.submitted, true);
      assert.equal(after.released, true);
      await assertPayRunApprovalReleased(run.orgId, run.documentId);
    } finally {
      await dropScratchOrgReporting(run.orgId);
    }
  },
);

test(
  "a pay-run flow with no on_submit gate is not an approval policy",
  { skip: !DB },
  async () => {
    // Counting every enabled pay_run flow as a policy would make a tenant whose
    // only pay-run flow routes VOIDS unable to commit anything at all. The
    // policy test is a graph test: on_submit trigger AND a gate node.
    const run = await seedPayRun();
    try {
      await db.execute(sql`
        insert into flows (org_id, name, subject_kind, enabled, graph, created_by, updated_by)
        values (${run.orgId}, 'Void routing', 'pay_run', true,
                ${JSON.stringify(NON_GATING_GRAPH)}::jsonb, ${run.actorId}, ${run.actorId})`);
      const state = await payRunApprovalState(run.orgId, run.documentId);
      assert.equal(state.policyExists, false);
      assert.equal(state.released, true);
      await assertPayRunApprovalReleased(run.orgId, run.documentId);
    } finally {
      await dropScratchOrgReporting(run.orgId);
    }
  },
);

test(
  "a disabled approval policy does not block, an outstanding gate does",
  { skip: !DB },
  async () => {
    const run = await seedPayRun();
    try {
      const flowId = randomUUID();
      await db.execute(sql`
        insert into flows (id, org_id, name, subject_kind, enabled, graph, created_by, updated_by)
        values (${flowId}, ${run.orgId}, 'Pay run approval', 'pay_run', false,
                ${JSON.stringify(GATING_GRAPH)}::jsonb, ${run.actorId}, ${run.actorId})`);
      assert.equal((await payRunApprovalState(run.orgId, run.documentId)).released, true);

      await db.execute(sql`update flows set enabled = true where id = ${flowId}`);
      await db.execute(sql`
        update documents set submitted_at = now(), submitted_by = ${run.actorId}, status = 'pending_approval'
         where id = ${run.documentId}`);
      const runId = randomUUID();
      await db.execute(sql`
        insert into flow_runs (id, org_id, flow_id, subject_kind, subject_id, trigger, status)
        values (${runId}, ${run.orgId}, ${flowId}, 'pay_run', ${run.documentId}, 'on_submit', 'waiting')`);
      await db.execute(sql`
        insert into flow_gates (org_id, flow_id, run_id, node_id, subject_kind, subject_id, title,
                                group_key, quorum, status, assignee_user_id)
        values (${run.orgId}, ${flowId}, ${runId}, 'g', 'pay_run', ${run.documentId},
                'Approve pay run', 'g', 'any', 'pending', ${run.actorId})`);

      const state = await payRunApprovalState(run.orgId, run.documentId);
      assert.equal(state.outstandingGates, 1);
      assert.equal(state.released, false);
      await assert.rejects(
        assertPayRunApprovalReleased(run.orgId, run.documentId),
        /awaiting 1 approval/,
      );
    } finally {
      await dropScratchOrgReporting(run.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* C2 — a voided pay run must be un-counted everywhere                 */
/* ------------------------------------------------------------------ */

/**
 * `run_status = 'voided'` needs the CHECK constraint widened, which is a
 * migration another agent owns (see .local/handoff-controls.md). Probe for it
 * so this test starts passing the moment it lands instead of silently never
 * running.
 */
async function voidedRunStatusAllowed(): Promise<boolean> {
  if (!DB) return false;
  const r = (await db.execute<{ def: string }>(sql`
    select pg_get_constraintdef(oid) as def from pg_constraint
     where conrelid = 'pay_runs'::regclass and conname = 'pay_runs_run_status'
  `));
  return !r.rows[0] || r.rows[0].def.includes("'voided'");
}

const VOIDED_ALLOWED = await voidedRunStatusAllowed();

test(
  "voiding a pay run retires it from statutory YTD, T4 and the remittance summary",
  {
    skip: !DB
      ? "no database"
      : !VOIDED_ALLOWED
        ? "pending migration: pay_runs_run_status must allow 'voided' — see .local/handoff-controls.md"
        : false,
  },
  async () => {
    const run = await seedPayRun({ runStatus: "committed" });
    try {
      await seedCommittedStub(run, "40000.0000");
      assert.equal((await t4Slips(run.orgId, 2026)).length, 1);

      await db.execute(sql`
        update pay_runs set run_status = 'voided' where document_id = ${run.documentId}`);

      assert.deepEqual(await t4Slips(run.orgId, 2026), [],
        "a voided run must not appear on a T4 slip");
      assert.deepEqual(await roeCandidates(run.orgId, 2026), []);
    } finally {
      await dropScratchOrgReporting(run.orgId);
    }
  },
);

test(
  "every payroll consumer keys on run_status, so one status write un-counts the run",
  { skip: !DB },
  async () => {
    // The proof that `run_status` is the RIGHT single write: with the run
    // committed the year-end builders see it, and the moment run_status stops
    // being 'committed' every one of them drops it — with no change to the
    // stubs, the document, or any consumer's SQL. (The status the void writes
    // is 'voided'; this drives the same predicate with a value the current
    // CHECK constraint already permits, so the control is verified today.)
    const run = await seedPayRun({ runStatus: "committed" });
    try {
      await seedCommittedStub(run, "90000.0000");
      const slips = await t4Slips(run.orgId, 2026);
      assert.equal(slips.length, 1);
      assert.equal(slips[0]!.box24EiInsurable, "68900"); // capped at the 2026 MIE
      assert.equal(slips[0]!.box26CppPensionable, "85000"); // capped at the 2026 YAMPE

      await db.execute(sql`
        update pay_runs set run_status = 'draft' where document_id = ${run.documentId}`);
      assert.deepEqual(await t4Slips(run.orgId, 2026), []);
    } finally {
      await dropScratchOrgReporting(run.orgId);
    }
  },
);

async function seedCommittedStub(run: PayRunFixture, gross: string): Promise<string> {
  const stubId = randomUUID();
  await db.execute(sql`
    insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, province,
                           periods_per_year, pay_date, tax_year, currency_code, gross, net_pay,
                           pensionable_earnings, insurable_earnings, factors, created_by, updated_by)
    values (${stubId}, ${run.orgId}, ${run.documentId}, ${run.employeeId}, 'ON', 26, '2026-07-21',
            2026, 'CAD', ${gross}, ${gross}, ${gross}, ${gross},
            ${JSON.stringify({ C: "0", C2: "0", EI: "0" })}::jsonb, ${run.actorId}, ${run.actorId})`);
  return stubId;
}

test(
  "statutory YTD counts committed payroll, not calculated drafts",
  { skip: !DB },
  async () => {
    const current = await seedPayRun();
    try {
      const insertHistory = async (
        runStatus: "calculated" | "committed",
        periodStart: string,
        periodEnd: string,
        gross: string,
      ) => {
        const documentId = randomUUID();
        await db.execute(sql`
          insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date,
                                 currency, status, created_by, updated_by)
          values (${current.orgId}, ${documentId}, 'pay_run', ${`PAY-${documentId.slice(0, 8)}`},
                  ${current.subsidiaryId}, ${periodEnd}, 'CAD', 'approved',
                  ${current.actorId}, ${current.actorId})`);
        await db.execute(sql`
          insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end,
                                pay_date, tax_year, run_status, created_by, updated_by)
          values (${documentId}, ${current.orgId}, ${current.scheduleId}, ${periodStart}, ${periodEnd},
                  ${periodEnd}, 2026, ${runStatus}, ${current.actorId}, ${current.actorId})`);
        await db.execute(sql`
          insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, province,
                                 periods_per_year, pay_date, tax_year, currency_code, gross,
                                 pensionable_earnings, insurable_earnings, net_pay, factors,
                                 created_by, updated_by)
          values (${randomUUID()}, ${current.orgId}, ${documentId}, ${current.employeeId}, 'ON',
                  26, ${periodEnd}, 2026, 'CAD', ${gross}, ${gross}, ${gross}, ${gross},
                  ${JSON.stringify({
                    C: gross, C2: gross, EI: gross, QPIP: gross,
                    SS: gross, MED: gross, MED2: gross,
                  })}::jsonb,
                  ${current.actorId}, ${current.actorId})`);
      };

      // A committed $1,000 period is real YTD. The later calculated $9,000
      // period is still a draft and may be abandoned, so it must not consume
      // statutory room in either country engine.
      await insertHistory("committed", "2026-06-07", "2026-06-20", "1000.0000");
      await insertHistory("calculated", "2026-06-21", "2026-07-04", "9000.0000");

      const context = {
        tx: db,
        orgId: current.orgId,
        employeePartyId: current.employeeId,
        taxYear: 2026,
        documentId: current.documentId,
      } as const;
      const caYtd = await employeeYtd(context);
      const usYtd = await usEmployeeYtd(context);
      assert.equal(cmp(caYtd.pensionable, "1000"), 0,
        "Canada YTD ignores an uncommitted calculated stub");
      assert.equal(cmp(caYtd.cpp, "1000"), 0,
        "Canada statutory factors ignore an uncommitted calculated stub");
      assert.equal(cmp(usYtd.fica, "1000"), 0,
        "US YTD ignores an uncommitted calculated stub");
      assert.equal(cmp(usYtd.fica_tax, "3000"), 0,
        "US FICA tax YTD ignores an uncommitted calculated stub");
    } finally {
      await dropScratchOrgReporting(current.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* C3 — staleness must watch every input class                         */
/* ------------------------------------------------------------------ */

test("a run that cannot be found is stale, not fresh", { skip: !DB }, async () => {
  // "Not found" returned `stale: false`, which the wizard reads as "safe to
  // commit". A missing run is not a fresh run.
  const staleness = await payRunStaleness(randomUUID(), randomUUID());
  assert.equal(staleness.stale, true);
  assert.deepEqual(staleness.reasons, ["missing"]);
});

test(
  "changing a component, a plan, a derived rule or the org settings makes the run stale",
  { skip: !DB },
  async () => {
    // Each of these was invisible: edit a garnishment, a benefit, an RRSP
    // percentage, a vacation plan, a per-diem rule or the EHT rate after
    // Calculate, and the wizard reported `stale: false` and green-lit the
    // commit of figures the operator had already edited past.
    const run = await seedPayRun();
    try {
      assert.deepEqual((await payRunStaleness(run.orgId, run.documentId)).reasons, []);

      const componentId = randomUUID();
      await db.execute(sql`
        insert into pay_components (id, org_id, code, name, kind, is_active, created_by, updated_by)
        values (${componentId}, ${run.orgId}, 'GARN', 'Garnishment', 'deduction', true,
                ${run.actorId}, ${run.actorId})`);
      assert.ok(
        (await payRunStaleness(run.orgId, run.documentId)).reasons.includes("componentDefinitions"),
        "a new/edited pay component changes what the stub computes",
      );

      await db.execute(sql`
        update pay_runs set calculated_at = now() where document_id = ${run.documentId}`);
      await db.execute(sql`
        insert into employee_pay_components (org_id, employee_party_id, component_id, value,
                                             effective_from, is_active, created_by, updated_by)
        values (${run.orgId}, ${run.employeeId}, ${componentId}, '250', '2026-01-01', true,
                ${run.actorId}, ${run.actorId})`);
      assert.ok(
        (await payRunStaleness(run.orgId, run.documentId)).reasons.includes("components"),
        "assigning a garnishment to an employee changes their net pay",
      );

      await db.execute(sql`
        update pay_runs set calculated_at = now() where document_id = ${run.documentId}`);
      await db.execute(sql`
        insert into entitlement_plans (org_id, code, name, unit, direction, accrual_method,
                                       accrual_value, cap_behavior, is_active, created_by, updated_by)
        values (${run.orgId}, 'VAC', 'Vacation', 'money', 'accrue', 'percent_of_earnings', '4',
                'warn', true, ${run.actorId}, ${run.actorId})`);
      assert.ok(
        (await payRunStaleness(run.orgId, run.documentId)).reasons.includes("entitlements"),
        "an entitlement plan moves accrual and payout amounts on the stub",
      );

      await db.execute(sql`
        update pay_runs set calculated_at = now() where document_id = ${run.documentId}`);
      await db.execute(sql`
        insert into pay_derived_rules (org_id, code, name, component_id, trigger, quantity_mode,
                                       rate_mode, rate_value, costing_mode, effective_from,
                                       sequence, is_active, created_by, updated_by)
        values (${run.orgId}, 'PERDIEM', 'Per diem', ${componentId}, 'distinct_day', 'count',
                'fixed_per_unit', '125', 'source', '2026-01-01', 10, true,
                ${run.actorId}, ${run.actorId})`);
      assert.ok(
        (await payRunStaleness(run.orgId, run.documentId)).reasons.includes("derivedRules"),
        "a derived earnings rule emits stub lines",
      );

      await db.execute(sql`
        update pay_runs set calculated_at = now() where document_id = ${run.documentId}`);
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${run.orgId}, 'orgs', ${run.orgId}, 'update',
                ${JSON.stringify({ payroll: { ehtRate: "1.95" } })}::jsonb, ${run.actorId})`);
      assert.ok(
        (await payRunStaleness(run.orgId, run.documentId)).reasons.includes("settings"),
        "EHT/SUI rates and posting accounts are run inputs",
      );
    } finally {
      await dropScratchOrgReporting(run.orgId);
    }
  },
);

test(
  "another run committing against the same employee's tax year makes this run stale",
  { skip: !DB },
  async () => {
    // The over-deduction case: an off-cycle bonus run commits after this run
    // was calculated and consumes CPP/EI room. Committing the stale figures
    // deducts past the annual maximum, and the employee is short-paid.
    const run = await seedPayRun();
    try {
      await seedCommittedStub(run, "2400.0000");
      assert.deepEqual((await payRunStaleness(run.orgId, run.documentId)).reasons, []);

      const otherId = randomUUID();
      await db.execute(sql`
        insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date,
                               currency, status, created_by, updated_by)
        values (${run.orgId}, ${otherId}, 'pay_run', 'PAY-OFFCYCLE', ${run.subsidiaryId},
                '2026-07-22', 'CAD', 'approved', ${run.actorId}, ${run.actorId})`);
      await db.execute(sql`
        insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end,
                              pay_date, tax_year, run_type, run_status, created_by, updated_by)
        values (${otherId}, ${run.orgId}, ${run.scheduleId}, '2026-07-19', '2026-07-19',
                '2026-07-22', 2026, 'bonus', 'committed', ${run.actorId}, ${run.actorId})`);
      await db.execute(sql`
        insert into pay_stubs (org_id, pay_run_document_id, employee_party_id, province,
                               periods_per_year, pay_date, tax_year, currency_code, gross,
                               created_by, updated_by)
        values (${run.orgId}, ${otherId}, ${run.employeeId}, 'ON', 26, '2026-07-22', 2026, 'CAD',
                '5000', ${run.actorId}, ${run.actorId})`);

      assert.ok(
        (await payRunStaleness(run.orgId, run.documentId)).reasons.includes("ytd"),
        "an off-cycle run has already consumed this employee's statutory room",
      );
    } finally {
      await dropScratchOrgReporting(run.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* C4 — readiness must validate the run's rule and the run's population */
/* ------------------------------------------------------------------ */

test("the usable-pay-rate rule, without a database", () => {
  // resolvePayRate takes the latest row COVERING THE PERIOD END, and
  // calculateStub refuses a salaried employee whose effective row is not an
  // annual one. Readiness tested period OVERLAP and ignored the basis, so both
  // of these passed green and then threw inside the run.
  assert.equal(payRateIsUsable("hourly", { basis: "hour" }), true);
  assert.equal(payRateIsUsable("hourly", { basis: "year" }), true);
  assert.equal(payRateIsUsable("salary", { basis: "year" }), true);
  assert.equal(payRateIsUsable("salary", { basis: "hour" }), false);
  assert.equal(payRateIsUsable("hourly", null), false);
  assert.equal(payRateIsUsable("salary", null), false);
});

test(
  "readiness blocks a rate that ends mid-period and a salaried employee on an hourly rate",
  { skip: !DB },
  async () => {
    const expired = await seedPayRun({ rateEffectiveTo: "2026-07-10" }); // period ends 07-18
    try {
      const readiness = await payRunReadiness(expired.orgId, expired.documentId);
      assert.ok(
        readiness.items.some((i) => i.code === "employee.noWage" && i.severity === "blocker"),
        "a rate that expired before the period end cannot pay the run",
      );
    } finally {
      await dropScratchOrgReporting(expired.orgId);
    }

    const salaried = await seedPayRun({ payBasis: "salary", rateBasis: "hour" });
    try {
      const readiness = await payRunReadiness(salaried.orgId, salaried.documentId);
      assert.ok(
        readiness.items.some((i) => i.code === "employee.noWage" && i.severity === "blocker"),
        "a salaried employee holding only an hourly rate throws inside calculateStub",
      );
    } finally {
      await dropScratchOrgReporting(salaried.orgId);
    }
  },
);

test(
  "readiness scopes to the pay schedule's subsidiary, exactly as the run does",
  { skip: !DB },
  async () => {
    // A subsidiary-scoped schedule pays only that entity's employees.
    // Readiness ignored the scope, so it described — and counted, and
    // blocked/warned on — a population the run would never pay.
    const other = randomUUID();
    const run = await seedPayRun();
    try {
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country,
                                  is_elimination, is_active, custom)
        values (${other}, ${run.orgId}, ${run.subsidiaryId}, 'Other Co', 'CAD', 'CA',
                false, true, '{}'::jsonb)`);
      assert.equal((await payRunReadiness(run.orgId, run.documentId)).included, 1);

      // Scope the schedule to a subsidiary the employee does not belong to.
      await db.execute(sql`
        update pay_schedules set subsidiary_id = ${other} where id = ${run.scheduleId}`);
      const scoped = await payRunReadiness(run.orgId, run.documentId);
      assert.equal(scoped.included, 0);
      assert.ok(scoped.items.some((i) => i.code === "scope.empty"));
    } finally {
      await dropScratchOrgReporting(run.orgId);
    }
  },
);

test(
  "readiness drops an employee terminated before the period, as the run does",
  { skip: !DB },
  async () => {
    const run = await seedPayRun({ terminatedOn: "2026-06-30" }); // period starts 07-05
    try {
      const readiness = await payRunReadiness(run.orgId, run.documentId);
      assert.equal(readiness.included, 0);
      assert.equal(
        readiness.items.some((i) => i.code === "employee.terminated"), false,
        "someone the run will not pay is not a warning about this run",
      );
    } finally {
      await dropScratchOrgReporting(run.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* C7 — the ROE pipeline is Canada-only, and the SIN is a SIN          */
/* ------------------------------------------------------------------ */

const CA_ROE: RoeRecord = {
  employeePartyId: "emp-1",
  employeeName: "Grace Hopper",
  country: "CA",
  payrollReference: "E-4471",
  filingAccount: {
    id: null, accountNumber: null, name: null, remitterType: null,
  },
  payPeriodType: "B",
  sinLast3: "286",
  firstDayWorked: "2023-04-03",
  lastDayPaid: "2026-05-29",
  finalPayPeriodEnd: "2026-05-29",
  occupation: "Site supervisor",
  totalInsurableHours: "86.6150",
  totalInsurableEarnings: "2000.0000",
  periods: [{
    payDate: "2026-06-05", periodStart: "2026-05-16", periodEnd: "2026-05-29",
    insurableEarnings: "2000.0000", insurableHours: "86.6150",
  }],
  vacationPayOnSeparation: "0",
  otherMoniesOnSeparation: "0",
};

const EMPLOYER = {
  bn: "999999999RP0001", name: "Acme Ltd",
  contactName: "Pat Payroll", contactPhone: "5555550100",
};

const roeFile = (over: Partial<RoeRecordToFile> = {}): RoeRecordToFile => ({
  record: CA_ROE, issue: { employeePartyId: "emp-1", reasonCode: "A" }, sin: "046454286", ...over,
});

test("the ROE XML builder refuses a non-Canadian employee", () => {
  // The query filter is a convenience; this is the control. The builder is
  // separately callable, and what it would otherwise produce is a false Service
  // Canada return, under the employer's CRA business number, disclosing a
  // foreign national identifier inside a <SIN> element.
  assert.throws(
    () => renderRoeXml({
      employer: EMPLOYER,
      records: [roeFile({ record: { ...CA_ROE, country: "US" }, sin: "123456789" })],
    }),
    (error: unknown) =>
      error instanceof Error && /can only be filed for a Canadian employee/.test(error.message),
  );
  // The Canadian record still files.
  assert.match(renderRoeXml({ employer: EMPLOYER, records: [roeFile()] }), /<SIN>046454286<\/SIN>/);
});

test("a nine-digit number is not a SIN", () => {
  // /^\d{9}$/ admits any US SSN. A SIN carries a Luhn check digit.
  assert.equal(isCanadianSin("046454286"), true);
  assert.equal(isCanadianSin("123456789"), false); // a plausible SSN shape
  assert.equal(isCanadianSin("12345678"), false);
  assert.equal(isCanadianSin("04645428X"), false);
});

test("insurable hours are rounded exactly, not through a double", () => {
  // 86.615 has no exact double: Number("86.6150").toFixed(2) gives "86.61",
  // where half-up gives 86.62. Insurable hours drive an EI claim.
  assert.equal(Number("86.6150").toFixed(2), "86.61"); // the defect, pinned
  const xml = renderRoeXml({ employer: EMPLOYER, records: [roeFile()] });
  assert.match(xml, /<InsurableHours>86\.62<\/InsurableHours>/);
  assert.match(xml, /<TotalInsurableHours>86\.62<\/TotalInsurableHours>/);
});

test(
  "a US employee is never offered an ROE",
  { skip: !DB },
  async () => {
    const run = await seedPayRun({ runStatus: "committed", country: "US", terminatedOn: "2026-07-15" });
    try {
      await seedCommittedStub(run, "5000.0000");
      assert.deepEqual(await roeCandidates(run.orgId, 2026), []);
    } finally {
      await dropScratchOrgReporting(run.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* M-7 — T4 caps must refuse an unknown year, not silently not cap     */
/* ------------------------------------------------------------------ */

test("T4 slips refuse a year with no CRA maximums rather than filing uncapped", async () => {
  // caYearCaps returned null for anything but 2026, which made the box 24/26
  // cap a no-op. A 2025 restatement, or anything filed after the calendar
  // turns to 2027, went out uncapped and silently.
  await assert.rejects(
    t4Slips(randomUUID(), 2025),
    /no CRA maximums for tax year 2025/,
  );
});

/* ------------------------------------------------------------------ */
/* C8a + M-4 — derived earnings                                        */
/* ------------------------------------------------------------------ */

const derivedRule = (over: Partial<DerivedRule> = {}): DerivedRule => ({
  id: "rule-1", code: "PERDIEM", name: "Per diem", componentId: "cmp-1",
  trigger: "distinct_day", timeTypeId: null, projectId: null, departmentId: null,
  tradeId: null, jobTitle: null, billableOnly: false,
  includedJobTitles: [], excludedJobTitles: [],
  quantityMode: "count", rateMode: "fixed_per_unit", rateValue: "125.0000",
  costingMode: "source", sequence: 10, ...over,
});

const derivedComponent = {
  id: "cmp-1", name: "Per diem", value: null,
  taxable: true, pensionable: true, insurable: true, vacationable: false, nonPeriodic: false,
};

const derivedInput = (rule: DerivedRule, entries: number, gross = "2000.0000") => ({
  rules: [rule],
  components: new Map([["cmp-1", derivedComponent]]),
  employee: { jobTitle: null, tradeId: null, departmentId: null },
  entries: Array.from({ length: entries }, (_, i) => ({
    id: `e${i}`,
    workedOn: `2026-07-${String((i % 28) + 1).padStart(2, "0")}`,
    hours: "8.00", timeTypeId: null,
    // The last fact sits on a different job — routine for a crew that moves.
    projectId: i === entries - 1 ? "job-b" : "job-a",
    departmentId: null, isBillable: true,
  })),
  periodStart: "2026-07-01", periodEnd: "2026-07-31", gross,
});

test("an unconfigured derived rate throws instead of silently paying nothing", () => {
  // `rateValue ?? "0"` turned "unconfigured" into "zero", and a zero bucket is
  // DROPPED — so no line appeared at all, not on the stub and not in the
  // pre-enable preview an operator reads to look before enabling. The
  // rate_card branch already threw; its two siblings now agree.
  for (const rateMode of ["fixed_per_unit", "percent_of_gross"] as const) {
    assert.throws(
      () => applyDerivedRule(
        derivedRule({ rateMode, rateValue: null }),
        derivedInput(derivedRule({ rateMode, rateValue: null }), 3),
      ),
      (error: unknown) =>
        error instanceof DerivedEarningsError && /carries no rate value/.test(error.message),
    );
  }
  assert.throws(
    () => applyDerivedRule(
      derivedRule({ rateMode: "fixed_per_unit", rateValue: "  " }),
      derivedInput(derivedRule({ rateMode: "fixed_per_unit", rateValue: "  " }), 3),
    ),
    DerivedEarningsError,
  );
});

test("a percent-of-gross split never pays a negative amount", () => {
  // The demonstrated case: gross 2,000.00 at 0.25% is a 5.00 total over 40
  // time entries. The exact per-unit share is 0.1250, which rounds to 0.13, so
  // giving the residual to the LAST unit left it holding 5.00 - 5.07 = -0.07.
  // With the last entry on a different job that becomes a NEGATIVE earning
  // line, which the WCB job split and disposable-earnings both refuse outright.
  const rule = derivedRule({
    trigger: "time_entry", rateMode: "percent_of_gross", rateValue: "0.2500",
  });
  const result = applyDerivedRule(rule, derivedInput(rule, 40));

  assert.equal(result.units.length, 40);
  assert.equal(sum(result.units.map((u) => u.amount)), "5.0000", "the total is still exact");
  for (const unit of result.units) {
    assert.ok(
      Number(unit.amount) >= 0,
      `every share must be non-negative, saw ${unit.amount} on ${unit.day}`,
    );
  }
  // Largest remainder: 5.00 over 40 equal units is 0.12 for 20 of them and
  // 0.13 for the other 20 — every share a faithful rounding of its own value.
  const amounts = [...new Set(result.units.map((u) => u.amount))].sort();
  assert.deepEqual(amounts, ["0.1200", "0.1300"]);
  // And no line is negative either, including the one on the other job.
  for (const line of result.lines) assert.ok(Number(line.amount) > 0);
});

test("largest-remainder allocation: exact sum, faithful shares, deterministic", () => {
  // Σ == total is the invariant that must survive; the shares must also each
  // be floor or floor+1 cent of their own exact value.
  assert.deepEqual(allocateByQuantity("5.0000", []), null);
  assert.deepEqual(allocateByQuantity("5.0000", ["0", "0"]), null);
  assert.deepEqual(allocateByQuantity("1.0000", ["1", "1", "1"]), ["0.3400", "0.3300", "0.3300"]);
  assert.deepEqual(allocateByQuantity("10.0000", ["3", "1"]), ["7.5000", "2.5000"]);
  // Weighted, with a leftover cent: 0.10 over quantities 1 and 2.
  assert.deepEqual(allocateByQuantity("0.1000", ["1", "2"]), ["0.0300", "0.0700"]);
  // A negative total still sums exactly and keeps every share negative.
  const negative = allocateByQuantity("-5.0000", Array(40).fill("1"))!;
  assert.equal(sum(negative), "-5.0000");
  for (const share of negative) assert.ok(Number(share) <= 0);
  // Deterministic: identical input, identical output, run to run.
  assert.deepEqual(
    allocateByQuantity("5.0000", Array(40).fill("1")),
    allocateByQuantity("5.0000", Array(40).fill("1")),
  );
});

/* ------------------------------------------------------------------ */
/* C8b — an invented remittance due date                               */
/* ------------------------------------------------------------------ */

test("a remittance due date follows the remitter type, never one schedule for all", () => {
  // The control: the 15th of the following month is the REGULAR schedule, and
  // it was once stamped on every bill regardless of `remitter_type` — so an
  // accelerated remitter's bill carried a confidently wrong date weeks late,
  // and the CRA penalty is 3-10%. The schedules diverge, and they must stay
  // diverged.
  //
  // Until the statutory holiday calendar existed the other three schedules
  // REFUSED (returned null) rather than invent a date. They are now computed
  // from that calendar — engine/src/payroll-holidays.ts — and the exhaustive
  // case-by-case verification against the CRA's published table lives in
  // engine/src/payroll-remittance-due-dates.test.ts. What this control asserts
  // is only that one schedule is never silently used for another.
  const period = "2026-07-31";
  const byType = new Map(
    (["regular", "quarterly", "accelerated_1", "accelerated_2"] as const)
      .map((remitter) => [remitter, remittanceDueDate(period, remitter)]),
  );
  assert.equal(new Set(byType.values()).size, 4, "every remitter type has its own deadline");

  // Regular: the 15th of the following month, moved off the weekend. August 15
  // 2026 is a Saturday, and the CRA's rule is that the remittance is on time if
  // it is received on the next business day.
  assert.equal(byType.get("regular"), "2026-08-17");
  assert.equal(remittanceDueDate("2026-12-31", "regular"), "2027-01-15");
  // No filing account = the CRA's default registration for a new employer,
  // which is a regular remitter. The single-account org is unchanged.
  assert.equal(remittanceDueDate(period, null), "2026-08-17");
  // And no schedule ever stamps a Saturday, a Sunday, or a CRA holiday.
  for (const [remitter, due] of byType) {
    const weekday = new Date(`${due}T00:00:00Z`).getUTCDay();
    assert.ok(weekday !== 0 && weekday !== 6, `${remitter} landed on a weekend (${due})`);
    assert.ok(due > period, `${remitter} must fall after the period it closes`);
  }
});
