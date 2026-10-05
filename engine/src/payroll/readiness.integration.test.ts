import { seedPayrollLine, seedPayrollParty } from '../testing/fixtures.ts';
import { seedPayrollComponent, seedPayrollDocument, seedPayrollStub } from '../testing/fixtures.ts';
import { recurringBenefitsRunSource } from "./benefit-plan-inputs.ts";
import {
  seedPayrollSchedule, seedPayrollEmployeeRole, seedPayrollPerson, seedPayrollProfile, seedPayrollWage,
  createScratchOrg, dropScratchOrg, seedFlowActors, dropScratchOrgReporting, seedWorkerEmployment,
} from "../testing/fixtures.ts";
// Consolidated DB-test file: merged from sibling per-finding suites to
// share one file's startup cost. Each describe block is one former file;
// bodies are unchanged apart from import hoisting.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { describe } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { payRunStaleness, payRunChanges, payRunFunding, payRunReadiness, payrollSetupState } from "./readiness.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { PayrollError } from "./error.ts";
import { scheduledFrequencyAdvisory } from "./remittance.ts";

describe("readiness-levy-scope", () => {

  const DB = !!process.env.OPENBOOKS_DB_URL;

  // Employer-levy staleness used to fire across packs and scopes: the
  // 'consumed' query filtered only org, year, status and timestamp, so a
  // calculated CA run went stale on ANY committed or voided run in the tax
  // year — a US pack, another subsidiary, a disjoint roster — while arming
  // read schedule-wide profiles with no termination filter. Staleness is now
  // scoped to runs sharing the pack, the levy's aggregation unit (the
  // employer as a whole, or the employer in one region), and — for
  // per-employee caps — the affected employees; terminated profiles arm
  // nothing.

  async function setup(orgId: string, actorId: string): Promise<void> {
    await db.execute(sql`
      update orgs set settings = settings || '{"features":{"payroll":true}}'::jsonb
       where id = ${orgId}`);
    await seedPayrollComponents(orgId, actorId, "CA");
    await seedPayrollComponents(orgId, actorId, "US");
  }

  async function makeSchedule(orgId: string, actorId: string): Promise<string> {
    const id = randomUUID();
    const name = `Biweekly ${randomUUID().slice(0, 8)}`;
    await seedPayrollSchedule(orgId, id, actorId, {
      name: name, frequency: 'biweekly', periodsPerYear: 26, anchorPeriodEnd: '2026-07-18', payDateOffsetDays: 3,
    });
    return id;
  }

  async function makeEmployee(
    orgId: string,
    actorId: string,
    scheduleId: string,
    name: string,
    country: string,
    province: string,
    terminatedOn: string | null = null,
  ): Promise<string> {
    const id = randomUUID();
    await seedPayrollPerson(orgId, id, name);
    await seedPayrollEmployeeRole(orgId, id, { id: randomUUID(), terminatedOn: terminatedOn });
    await seedPayrollWage(orgId, id, actorId, {
      currency: 'CAD', rate: '30', basis: 'hour', annualHours: '2080', effectiveFrom: '2026-01-01',
    });
    // Hires carry an HRM employment or stub calculation refuses them; the
    // employment rides the org's root subsidiary like the party does.
    const employmentSubsidiary = (await db.execute<{ id: string }>(sql`
      select id from subsidiaries where org_id = ${orgId} and parent_id is null and is_active
       order by created_at limit 1`)).rows[0]!.id;
    const employmentId = await seedWorkerEmployment(orgId, id, employmentSubsidiary);
    await seedPayrollProfile(orgId, id, employmentId, scheduleId, actorId, {
      country: country, province: province, payBasis: 'hourly', federalClaimCode: 1, provincialClaimCode: 1,
    }, { percentFloor: '4', method: 'accrue' });

    return id;
  }

  async function makeRun(orgId: string, actorId: string, scheduleId: string): Promise<{ documentId: string }> {
    return createPayRun({
      orgId, actorId, payScheduleId: scheduleId,
      periodStart: "2026-07-05", periodEnd: "2026-07-18",
    });
  }

  /** Mark a run committed after the given timestamp without the commit path. */
  async function markCommittedAfter(
    orgId: string,
    documentId: string,
    after: string,
  ): Promise<void> {
    await db.execute(sql`
      update pay_runs set run_status = 'committed', benefit_source_snapshot=${JSON.stringify(await recurringBenefitsRunSource(db,orgId,documentId))}::jsonb, updated_at = ${after}::timestamptz + interval '1 minute'
       where org_id = ${orgId} and document_id = ${documentId}`);
  }

  async function levyStale(orgId: string, documentId: string): Promise<boolean> {
    const staleness = await payRunStaleness(orgId, documentId);
    return staleness.reasons.includes("employerLevyYtd");
  }

  test("a committed US-pack run does not stale a calculated CA run", { skip: !DB }, async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      await setup(org.orgId, actorId);
      const caSchedule = await makeSchedule(org.orgId, actorId);
      const usSchedule = await makeSchedule(org.orgId, actorId);
      await makeEmployee(org.orgId, actorId, caSchedule, "Amy CA", "CA", "ON");
      await makeEmployee(org.orgId, actorId, usSchedule, "Uma US", "US", "CA");
      const caRun = await makeRun(org.orgId, actorId, caSchedule);
      const { calculatePayRun } = await import("./run-calculation.ts");
      await calculatePayRun({ orgId: org.orgId, documentId: caRun.documentId, actorId });
      const calculated = (await db.execute<{ calculated_at: string }>(sql`
        select calculated_at::text as calculated_at from pay_runs
         where org_id = ${org.orgId} and document_id = ${caRun.documentId}`)).rows[0]!;
      const usRun = await makeRun(org.orgId, actorId, usSchedule);
      await markCommittedAfter(org.orgId, usRun.documentId, calculated.calculated_at);
      assert.equal(await levyStale(org.orgId, caRun.documentId), false);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });

  test("a committed CA run still stales a calculated CA run sharing the province", { skip: !DB }, async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      await setup(org.orgId, actorId);
      const scheduleA = await makeSchedule(org.orgId, actorId);
      const scheduleB = await makeSchedule(org.orgId, actorId);
      await makeEmployee(org.orgId, actorId, scheduleA, "Amy CA", "CA", "ON");
      await makeEmployee(org.orgId, actorId, scheduleB, "Bob CA", "CA", "ON");
      const runA = await makeRun(org.orgId, actorId, scheduleA);
      const runB = await makeRun(org.orgId, actorId, scheduleB);
      const { calculatePayRun } = await import("./run-calculation.ts");
      await calculatePayRun({ orgId: org.orgId, documentId: runB.documentId, actorId });
      const calculated = (await db.execute<{ calculated_at: string }>(sql`
        select calculated_at::text as calculated_at from pay_runs
         where org_id = ${org.orgId} and document_id = ${runB.documentId}`)).rows[0]!;
      await markCommittedAfter(org.orgId, runA.documentId, calculated.calculated_at);
      assert.equal(await levyStale(org.orgId, runB.documentId), true);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });

  test("an employer fact recorded after Calculate stales the run like a rate edit", { skip: !DB }, async () => {
    // Pack-declared employer facts (the EI employer multiple, the CNT
    // exemption class) price fresh on every statutory pass, so a value
    // recorded after Calculate restates the stub: the commit must refuse
    // until the run recalculates.
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      await setup(org.orgId, actorId);
      const schedule = await makeSchedule(org.orgId, actorId);
      await makeEmployee(org.orgId, actorId, schedule, "Amy CA", "CA", "ON");
      const run = await makeRun(org.orgId, actorId, schedule);
      const { calculatePayRun } = await import("./run-calculation.ts");
      await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      const before = await payRunStaleness(org.orgId, run.documentId);
      assert.ok(!before.reasons.includes("statutoryRates"));
      const accountId = randomUUID();
      await db.execute(sql`
        insert into payroll_filing_accounts (id, org_id, country, program_type, account_number, name,
                                             remitter_type, is_default, is_active, created_by, updated_by)
        values (${accountId}, ${org.orgId}, 'CA', 'ca_rp', '123456789RP0001', 'RP account', 'regular',
                true, true, ${actorId}, ${actorId})`);
      const { upsertPayrollEmployerFact } = await import("./employer-fact-store.ts");
      await upsertPayrollEmployerFact({
        orgId: org.orgId, actorId, country: "CA", factKey: "ei_employer_multiplier",
        filingAccountId: accountId, effectiveFrom: "2026-01-01", value: "1.167",
        changeReason: "CRA-approved reduced rate for the account wage-loss plan.",
      });
      const after = await payRunStaleness(org.orgId, run.documentId);
      assert.ok(after.reasons.includes("statutoryRates"));
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });

  test("a department expense mapping edited after Calculate stales the run", { skip: !DB }, async () => {
    // The line stamp froze the GL projection at calculate time, so a
    // mapping edit after Calculate restates it: the commit must refuse
    // until the run recalculates.
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      await setup(org.orgId, actorId);
      const schedule = await makeSchedule(org.orgId, actorId);
      await makeEmployee(org.orgId, actorId, schedule, "Amy CA", "CA", "ON");
      const run = await makeRun(org.orgId, actorId, schedule);
      const { calculatePayRun } = await import("./run-calculation.ts");
      await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      const fresh = await payRunStaleness(org.orgId, run.documentId);
      assert.ok(!fresh.reasons.includes("componentDefinitions"));
      const componentId = (await db.execute<{ id: string }>(sql`
        select id from pay_components
         where org_id = ${org.orgId} and code = 'BASE' and country is null`)).rows[0]!.id;
      const departmentId = (await db.execute<{ id: string }>(sql`
        insert into departments (id, org_id, code, name, is_active)
        values (gen_random_uuid(), ${org.orgId}, 'OVERHEAD', 'Overhead', true) returning id`)).rows[0]!.id;
      const accountId = (await db.execute<{ id: string }>(sql`
        insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                              reconcilable, required_dimensions, custom, subsidiary_include_children)
        values (gen_random_uuid(), ${org.orgId}, '8010', 'Overhead wages', 'expense', false, true,
                false, false, '[]'::jsonb, '{}'::jsonb, true) returning id`)).rows[0]!.id;
      await db.execute(sql`
        insert into pay_component_department_expenses
               (org_id, pay_component_id, department_id, expense_account_id,
                effective_from, is_active, created_by, updated_by)
        values (${org.orgId}, ${componentId}, ${departmentId}, ${accountId},
                '2026-01-01', true, ${actorId}, ${actorId})`);
      const stale = await payRunStaleness(org.orgId, run.documentId);
      assert.ok(stale.reasons.includes("componentDefinitions"));
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });

  test("a terminated roster arms nothing, so a later CA commit does not stale it", { skip: !DB }, async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      await setup(org.orgId, actorId);
      const scheduleA = await makeSchedule(org.orgId, actorId);
      const scheduleB = await makeSchedule(org.orgId, actorId);
      // Terminated before the run period: not paid, claims no room.
      await makeEmployee(org.orgId, actorId, scheduleA, "Tam CA", "CA", "ON", "2026-07-01");
      await makeEmployee(org.orgId, actorId, scheduleB, "Bob CA", "CA", "ON");
      const runA = await makeRun(org.orgId, actorId, scheduleA);
      const runB = await makeRun(org.orgId, actorId, scheduleB);
      const { calculatePayRun } = await import("./run-calculation.ts");
      await calculatePayRun({ orgId: org.orgId, documentId: runA.documentId, actorId });
      const calculated = (await db.execute<{ calculated_at: string }>(sql`
        select calculated_at::text as calculated_at from pay_runs
         where org_id = ${org.orgId} and document_id = ${runA.documentId}`)).rows[0]!;
      await markCommittedAfter(org.orgId, runB.documentId, calculated.calculated_at);
      assert.equal(await levyStale(org.orgId, runA.documentId), false);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });
});

describe("readiness-missing-run", () => {

  const DB = !!process.env.OPENBOOKS_DB_URL;

  // A missing run is a named not-found regardless of scope. Funding with an
  // unknown id and no scope used to return SUCCESS (zero net pay, every
  // account sufficient, payDate today); changes returned a clean no-changes
  // diff for a run that does not exist; readiness tallied zero blockers.

  async function rejectsNotFound(work: () => Promise<unknown>): Promise<void> {
    await assert.rejects(work, (e: unknown) => {
      assert.ok(e instanceof PayrollError);
      assert.match(e.message, /pay run not found/);
      return true;
    });
  }

  for (const scopeName of ["no scope", "a subsidiary scope"] as const) {
    test(`funding refuses an unknown run with ${scopeName}`, { skip: !DB }, async () => {
      const org = await createScratchOrg();
      try {
        const scope = scopeName === "no scope" ? undefined : new Set([randomUUID()]);
        await rejectsNotFound(() => payRunFunding(org.orgId, randomUUID(), scope));
      } finally {
        await dropScratchOrg(org.orgId);
      }
    });

    test(`changes refuse an unknown run with ${scopeName}`, { skip: !DB }, async () => {
      const org = await createScratchOrg();
      try {
        const scope = scopeName === "no scope" ? undefined : new Set([randomUUID()]);
        await rejectsNotFound(() => payRunChanges(org.orgId, randomUUID(), scope));
      } finally {
        await dropScratchOrg(org.orgId);
      }
    });

    test(`readiness refuses an unknown run with ${scopeName}`, { skip: !DB }, async () => {
      const org = await createScratchOrg();
      try {
        const scope = scopeName === "no scope" ? undefined : new Set([randomUUID()]);
        await rejectsNotFound(() => payRunReadiness(org.orgId, randomUUID(), scope));
      } finally {
        await dropScratchOrg(org.orgId);
      }
    });
  }
});

describe("readiness-rq-schedule", () => {

  const DB = !!process.env.OPENBOOKS_DB_URL;

  /**
   * Readiness for scheduled remittance destinations: the RQ frequency check
   * names what applies when the org has not confirmed it, and the prior-year
   * advisory catches a large employer left on the monthly default.
   *
   * The advisory measures the destination's committed prior-year total over 12
   * calendar months and compares bands — it can only warn, never re-date a bill.
   */

  interface RqOrg {
    orgId: string;
    actorId: string;
    accountId: string;
    rqVendorId: string;
    employeeId: string;
    employmentId: string;
    scheduleId: string;
    componentId: string;
    liabilityAccountId: string;
  }

  async function seedRqOrg(frequency: string | null): Promise<RqOrg> {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;

    const accountId = randomUUID();
    await db.execute(sql`
      insert into payroll_filing_accounts (id, org_id, country, program_type, account_number, name,
                                           remitter_type, is_default)
      values (${accountId}, ${org.orgId}, 'CA', 'ca_rp', '123456789RP0007', 'Quebec division',
              'regular', true)`);

    const rqVendorId = randomUUID();
    await seedPayrollParty(org.orgId, rqVendorId, {
      kind: 'company', displayName: 'Revenu Quebec fixture vendor', subsidiaryId: org.subsidiaryId, isActive: true,
      custom: {}, createdBy: actorId, updatedBy: actorId,
    });
    await db.execute(sql`
      insert into vendor_roles (org_id, party_id, is_active, created_by, updated_by)
      values (${org.orgId}, ${rqVendorId}, true, ${actorId}, ${actorId})
      on conflict do nothing`);
    // jsonb_set creates no intermediate objects: ensure the payroll subtree first.
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(
           jsonb_set(coalesce(settings, '{}'::jsonb), '{payroll}', coalesce(settings->'payroll', '{}'::jsonb)),
           '{payroll,rqRemittancePartyId}', to_jsonb(${rqVendorId}::text))
       where id = ${org.orgId}`);
    if (frequency !== null) {
      await db.execute(sql`
        update orgs
           set settings = jsonb_set(coalesce(settings, '{}'::jsonb),
             '{payroll,rqRemittanceFrequency}', to_jsonb(${frequency}::text))
         where id = ${org.orgId}`);
    }

    const liabilityAccountId = randomUUID();
    await db.execute(sql`
      insert into accounts
        (id, org_id, number, name, type, is_summary, is_active, eliminate,
         reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${liabilityAccountId}, ${org.orgId}, '2320', 'RQ payable', 'liability_current',
              false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
    const componentId = randomUUID();
    await seedPayrollComponent(org.orgId, componentId, {
      code: 'QPIP-7', name: 'QPIP', kind: 'deduction', systemKey: 'qpip', liabilityAccountId: liabilityAccountId,
      remittancePartyId: null, sequence: 10, country: 'CA', createdBy: actorId, updatedBy: actorId,
    });

    const scheduleId = randomUUID();
    await seedPayrollSchedule(org.orgId, scheduleId, actorId, {
      name: 'Quebec weekly', frequency: 'weekly', periodsPerYear: 52, anchorPeriodEnd: '2026-07-31',
      payDateOffsetDays: 0,
    });

    const employeeId = randomUUID();
    await seedPayrollPerson(org.orgId, employeeId, 'Quebec Employee', {
      subsidiaryId: org.subsidiaryId, createdBy: actorId, updatedBy: actorId,
    });
    // Direct committed stubs carry a NOT NULL employment.
    const employmentId = await seedWorkerEmployment(org.orgId, employeeId, org.subsidiaryId);
    return {
      orgId: org.orgId, actorId, accountId, rqVendorId, employeeId, employmentId, scheduleId,
      componentId, liabilityAccountId,
    };
  }

  async function seedCommittedRun(
    fx: RqOrg,
    periodId: string,
    payDate: string,
    taxYear: number,
    amount: string,
    line?: { liabilityAccountId?: string | null; liabilityAccountSource?: "unknown" | "reconciled" | "commit" | "legacy_component" },
  ): Promise<void> {
    const documentId = randomUUID();
    const subsidiaryId = await subsidiaryOf(fx.orgId);
    await seedPayrollDocument(fx.orgId, documentId, {
      kind: 'pay_run', documentNumber: `PAY-${documentId.slice(0, 8)}`, subsidiaryId: subsidiaryId,
      documentDate: payDate, postingDate: payDate, postingPeriodId: periodId, currency: 'CAD', status: 'draft',
      memo: 'RQ source', createdBy: fx.actorId, updatedBy: fx.actorId,
    });
    await db.execute(sql`
      insert into pay_runs
        (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date,
         tax_year, run_status, run_type, created_by, updated_by)
      values (${documentId}, ${fx.orgId}, ${fx.scheduleId}, ${payDate}, ${payDate}, ${payDate},
              ${taxYear}, 'committed', 'regular', ${fx.actorId}, ${fx.actorId})`);
    const stubId = randomUUID();
    await seedPayrollStub(fx.orgId, documentId, fx.employeeId, fx.employmentId, {
      id: stubId, province: 'QC', periodsPerYear: 52, payDate: payDate, taxYear: taxYear, currency: 'CAD',
      gross: amount, pensionableEarnings: amount, insurableEarnings: amount, netPay: amount, employerCost: amount,
      vacationAccrued: '0', factors: {}, filingAccountId: fx.accountId, filingAccountSource: 'calculation',
      createdBy: fx.actorId, updatedBy: fx.actorId,
    });
    // An unknown historical liability account is the legacy state the summary
    // refuses to read (migration 0093's trigger rewrites unknown filing
    // attribution at insert, so the line account is the insertable refusal).
    const liabilityAccountId = line?.liabilityAccountId === undefined ? fx.liabilityAccountId : line.liabilityAccountId;
    await seedPayrollLine(fx.orgId, stubId, fx.componentId, {
      id: randomUUID(), kind: 'deduction', description: 'QPIP', amount: amount, sequence: 10,
      liabilityAccountId: liabilityAccountId, liabilityAccountSource: line?.liabilityAccountSource ?? 'commit',
      createdBy: fx.actorId, updatedBy: fx.actorId,
    });
  }

  async function subsidiaryOf(orgId: string): Promise<string> {
    const row = (await db.execute<{ id: string }>(sql`
      select id from subsidiaries where org_id = ${orgId} and parent_id is null and is_active
       order by created_at limit 1`)).rows[0]!;
    return row.id;
  }

  async function period2025(orgId: string): Promise<string> {
    const calendar = (await db.execute<{ id: string }>(sql`
      select id from fiscal_calendars where org_id = ${orgId} order by created_at limit 1`)).rows[0]!;
    const periodId = randomUUID();
    await db.execute(sql`
      insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on,
                                      is_adjustment, fiscal_calendar_id)
      values (${periodId}, ${orgId}, 2025, 12, '2025-12', '2025-12-01', '2025-12-31', false, ${calendar.id})`);
    return periodId;
  }

  async function payrollBlob(orgId: string): Promise<Record<string, unknown>> {
    const row = (await db.execute<{ p: Record<string, unknown> | null }>(sql`
      select settings->'payroll' as p from orgs where id = ${orgId}`)).rows[0]!;
    return row.p ?? {};
  }

  function frequencyChecks(state: Awaited<ReturnType<typeof payrollSetupState>>): { ok: boolean; detail?: string }[] {
    return state.checks.filter((check) => check.code === "setup.remittanceFrequency");
  }

  test(
    "an unset RQ frequency warns and names the default that applies",
    { skip: !DB },
    async () => {
      const fx = await seedRqOrg(null);
      try {
        const failed = frequencyChecks(await payrollSetupState(fx.orgId));
        assert.equal(failed.length, 1);
        assert.equal(failed[0]!.ok, false);
        assert.match(failed[0]!.detail ?? "", /Revenu Québec remittance frequency is not set/);
        assert.match(failed[0]!.detail ?? "", /the monthly frequency applies/);
      } finally {
        await dropScratchOrgReporting(fx.orgId);
      }
    },
  );

  test(
    "an undeclared RQ frequency warns instead of silently dating from the default",
    { skip: !DB },
    async () => {
      const fx = await seedRqOrg("weekly");
      try {
        const failed = frequencyChecks(await payrollSetupState(fx.orgId));
        assert.equal(failed.length, 1);
        assert.equal(failed[0]!.ok, false);
        assert.match(failed[0]!.detail ?? "", /"weekly" is not declared/);
      } finally {
        await dropScratchOrgReporting(fx.orgId);
      }
    },
  );

  test(
    "a confirmed RQ frequency with agreeing history is quiet",
    { skip: !DB },
    async () => {
      const fx = await seedRqOrg("monthly");
      try {
        // A small 2026 run only: the advisory measures the prior year, which is
        // empty, so nothing fires.
        const period = (await db.execute<{ id: string }>(sql`
          select id from accounting_periods where org_id = ${fx.orgId} limit 1`)).rows[0]!.id;
        await seedCommittedRun(fx, period, "2026-07-31", 2026, "400.0000");
        const passed = frequencyChecks(await payrollSetupState(fx.orgId));
        assert.equal(passed.length, 1);
        assert.equal(passed[0]!.ok, true);
        assert.equal(passed[0]!.detail, "Revenu Québec · monthly");
      } finally {
        await dropScratchOrgReporting(fx.orgId);
      }
    },
  );

  test(
    "a large prior year on the monthly default raises the band advisory",
    { skip: !DB },
    async () => {
      const fx = await seedRqOrg("monthly");
      try {
        await seedCommittedRun(fx, await period2025(fx.orgId), "2025-12-31", 2025, "400000.0000");
        const found = frequencyChecks(await payrollSetupState(fx.orgId));
        // The confirmation itself is quiet; the advisory names the mismatch.
        assert.ok(found.some((check) => check.ok === true));
        const advisory = found.find((check) => check.ok === false);
        assert.ok(advisory, "expected the twice-monthly advisory");
        assert.match(advisory!.detail ?? "", /averaged \$33333\.33\/month across 2025/);
        assert.match(advisory!.detail ?? "", /the twice monthly band/);
        assert.match(advisory!.detail ?? "", /bills date at the monthly frequency/);
      } finally {
        await dropScratchOrgReporting(fx.orgId);
      }
    },
  );

  test(
    "the advisory is silent when the bands agree, empty, or unreadable",
    { skip: !DB },
    async () => {
      const fx = await seedRqOrg("monthly");
      try {
        const blob = await payrollBlob(fx.orgId);
        const { RQ_REMITTANCE_SCHEDULE } = await import("./canada/quebec/remittance.ts");
        // No history at all: nothing to compare.
        assert.equal(
          await scheduledFrequencyAdvisory(fx.orgId, RQ_REMITTANCE_SCHEDULE, fx.rqVendorId, blob, 2026),
          null,
        );
        const period = (await db.execute<{ id: string }>(sql`
          select id from accounting_periods where org_id = ${fx.orgId} limit 1`)).rows[0]!.id;
        // History in the monthly band ($60,000/year = $5,000/month): agrees with
        // the configured frequency.
        await seedCommittedRun(fx, period, "2026-07-31", 2026, "60000.0000");
        assert.equal(
          await scheduledFrequencyAdvisory(fx.orgId, RQ_REMITTANCE_SCHEDULE, fx.rqVendorId, blob, 2026),
          null,
        );
        // Large history in the twice-monthly band: warns, naming the figures.
        const fx2 = await seedRqOrg("monthly");
        try {
          const period2 = (await db.execute<{ id: string }>(sql`
            select id from accounting_periods where org_id = ${fx2.orgId} limit 1`)).rows[0]!.id;
          await seedCommittedRun(fx2, period2, "2026-07-31", 2026, "400.0000");
          const period25 = await period2025(fx2.orgId);
          await seedCommittedRun(fx2, period25, "2025-12-31", 2025, "400000.0000");
          const warning = await scheduledFrequencyAdvisory(
            fx2.orgId, RQ_REMITTANCE_SCHEDULE, fx2.rqVendorId, await payrollBlob(fx2.orgId), 2025,
          );
          assert.match(warning ?? "", /twice monthly band/);
        } finally {
          await dropScratchOrgReporting(fx2.orgId);
        }
        // Committed payroll the summary refuses to read (an unknown historical
        // liability account) never breaks the advisory: it stays silent instead
        // of throwing.
        await seedCommittedRun(fx, period, "2026-08-31", 2026, "400.0000", {
          liabilityAccountId: null, liabilityAccountSource: "unknown",
        });
        assert.equal(
          await scheduledFrequencyAdvisory(fx.orgId, RQ_REMITTANCE_SCHEDULE, fx.rqVendorId, blob, 2026),
          null,
        );
      } finally {
        await dropScratchOrgReporting(fx.orgId);
      }
    },
  );
});

describe("readiness-setup-schedule", () => {

  const DB = !!process.env.OPENBOOKS_DB_URL;

  // setup.schedule used to read pay_schedules org-wide, so a caller restricted
  // to subsidiary A saw ok:true off a schedule living under B — a calendar the
  // caller can never run payroll on. Schedules are subsidiary-scoped, so the
  // check carries the same scope predicate as the population, slots and rates
  // on this surface: only an active schedule in the caller's scope counts.

  function scheduleCheck(
    state: Awaited<ReturnType<typeof payrollSetupState>>,
  ): { ok: boolean } {
    const found = state.checks.filter((check) => check.code === "setup.schedule");
    assert.equal(found.length, 1);
    return found[0]!;
  }

  test("an A-scoped caller with the only schedule under B gets setup.schedule not ok", { skip: !DB }, async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const childB = randomUUID();
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values(${childB},${org.orgId},${org.subsidiaryId},'Division B','CAD','CA')`);
      await seedPayrollSchedule(org.orgId, randomUUID(), actorId, {
        subsidiaryId: childB, name: 'Division B weekly', frequency: 'weekly', periodsPerYear: 52,
        anchorPeriodEnd: '2026-07-31', payDateOffsetDays: 0,
      });

      // Restricted to A (the root entity): B's schedule is unusable.
      assert.equal(scheduleCheck(await payrollSetupState(org.orgId, new Set([org.subsidiaryId]))).ok, false);
      // The same caller scoped to both entities, and the unrestricted caller,
      // still see the schedule.
      assert.equal(
        scheduleCheck(await payrollSetupState(org.orgId, new Set([org.subsidiaryId, childB]))).ok, true,
      );
      assert.equal(scheduleCheck(await payrollSetupState(org.orgId)).ok, true);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });
});
