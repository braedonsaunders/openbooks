// Consolidated DB-test file: merged from sibling per-finding suites to
// share one file's startup cost. Each describe block is one former file;
// bodies are unchanged apart from import hoisting.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { describe } from "node:test";
import { sql } from "drizzle-orm";
import { db, pool, withOrgTransaction } from "../platform/db.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors, dropScratchOrgReporting, seedWorkerEmployment } from "../testing/fixtures.ts";
import { PayrollError } from "./error.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { calculatedRun, seedAdoption, seedOntarioEhtFixture } from "./filing-test-fixtures.ts";
import { commitPayRun } from "./run-commit.ts";
import { cmp } from "../money/money.ts";

describe("run-lifecycle", () => {

  const DB = !!process.env.OPENBOOKS_DB_URL;

  /**
   * Regular-cycle scheduling anchors on the REGULAR schedule: an off-cycle
   * final-pay run ending mid-span must not drag max(period_end) forward, or the
   * next regular run silently skips the period the off-cycle run interrupted.
   */
  test("an off-cycle final-pay run does not move the next regular period", { skip: !DB }, async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await db.execute(sql`
      update orgs set settings = settings || ${JSON.stringify({
        features: { payroll: true },
      })}::jsonb where id = ${org.orgId}`);
    await seedPayrollComponents(org.orgId, actorId, "CA");
    const employeeId = randomUUID();
    const scheduleId = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${employeeId}, ${org.orgId}, 'person', 'Lifecycle Employee', true, '{}'::jsonb)
    `);
    await db.execute(sql`
      insert into pay_schedules
        (id, org_id, name, frequency, periods_per_year, anchor_period_end,
         pay_date_offset_days, is_active, created_by, updated_by)
      values
        (${scheduleId}, ${org.orgId}, 'Lifecycle Schedule', 'biweekly', 26, '2026-07-11',
         3, true, ${actorId}, ${actorId})
    `);
    await db.execute(sql`
      insert into employee_payroll_profiles
        (org_id, employee_party_id, pay_schedule_id, country, province, pay_basis,
         federal_claim_code, provincial_claim_code, is_active, created_by, updated_by)
      values
        (${org.orgId}, ${employeeId}, ${scheduleId}, 'CA', 'ON', 'salary', 1, 1, true,
         ${actorId}, ${actorId})
    `);

    // The last regular payday ended 2026-07-11; the next span is 07-12–07-25.
    await createPayRun({
      orgId: org.orgId,
      actorId,
      payScheduleId: scheduleId,
      periodStart: "2026-06-28",
      periodEnd: "2026-07-11",
    });
    // An off-cycle final pay spans past the next regular payday: it ends
    // 2026-07-30, beyond the 2026-07-25 regular period end. (A mid-span end
    // alone is already absorbed by nextPeriodAfter's floor step; only an end
    // past the next schedule date can drag max(period_end) forward.)
    await createPayRun({
      orgId: org.orgId,
      actorId,
      payScheduleId: scheduleId,
      periodStart: "2026-07-12",
      periodEnd: "2026-07-30",
      runType: "termination",
      employeePartyIds: [employeeId],
    });

    // The next regular run must still open 07-12–07-25 — not jump to 07-26–08-08.
    const next = await createPayRun({ orgId: org.orgId, actorId, payScheduleId: scheduleId });
    const stored = (await db.execute<{ period_start: string; period_end: string }>(sql`
      select period_start::text as period_start, period_end::text as period_end
        from pay_runs where org_id = ${org.orgId} and document_id = ${next.documentId}
    `)).rows[0]!;
    assert.equal(stored.period_start, "2026-07-12");
    assert.equal(stored.period_end, "2026-07-25");

    await dropScratchOrg(org.orgId);
  });
});

describe("run-boundary", () => {

  const invalidPeriods = [
    { name: 'impossible calendar date', periodStart: '2026-02-30', periodEnd: '2026-03-07' },
    { name: 'inverted period', periodStart: '2026-07-18', periodEnd: '2026-07-05' },
    { name: 'partial explicit period', periodStart: '2026-06-01' },
    { name: 'pay date before period end', periodStart: '2026-07-05', periodEnd: '2026-07-18', payDate: '2026-07-17' },
    { name: 'impossible pay date', periodStart: '2026-07-05', periodEnd: '2026-07-18', payDate: '2026-02-30' },
  ]
  for (const { name, ...dates } of invalidPeriods) {
    test(`pay run refuses ${name} without allocating a document or number`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
      const org = await createScratchOrg()
      try {
        const actorId = (await seedFlowActors(org.orgId)).adminId
        const scheduleId = randomUUID()
        await db.execute(sql`update orgs set settings = settings || '{"features":{"payroll":true}}'::jsonb where id = ${org.orgId}`)
        await db.execute(sql`insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end, pay_date_offset_days, is_active, created_by, updated_by)
          values (${scheduleId}, ${org.orgId}, 'Boundary schedule', 'biweekly', 26, '2026-07-18', 3, true, ${actorId}, ${actorId})`)
        const snapshot = async () => (await db.execute(sql`select
          (select count(*) from documents where org_id = ${org.orgId}) as documents,
          (select count(*) from pay_runs where org_id = ${org.orgId}) as runs,
          (select jsonb_agg(to_jsonb(s) order by s.id) from number_sequences s where org_id = ${org.orgId}) as sequences`)).rows
        const before = await snapshot()
        await assert.rejects(createPayRun({ orgId: org.orgId, actorId, payScheduleId: scheduleId, ...dates }), PayrollError)
        assert.deepEqual(await snapshot(), before)
      } finally { await dropScratchOrgReporting(org.orgId) }
    })
  }
});

describe("run-assignment-window", () => {

  const DB = !!process.env.OPENBOOKS_DB_URL;

  /**
   * An assignment ending mid-period still applies to the period: readiness
   * treats the window as overlapping the period, and the stub must agree.
   * (The stub used to require effective_to >= period_end, so the assignment
   * passed pre-flight and was then silently left off the cheque.)
   */
  test("an assignment ending mid-period is paid on the stub", { skip: !DB }, async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await db.execute(sql`
      update orgs set settings = settings || ${JSON.stringify({
        features: { payroll: true },
      })}::jsonb where id = ${org.orgId}`);
    await seedPayrollComponents(org.orgId, actorId, "CA");
    await seedOntarioEhtFixture(org.orgId, actorId);

    const employeeId = randomUUID();
    const scheduleId = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${employeeId}, ${org.orgId}, 'person', 'Window Employee', true, '{}'::jsonb)`);
    await db.execute(sql`
      insert into employee_roles (id, org_id, party_id, terminated_on)
      values (${randomUUID()}, ${org.orgId}, ${employeeId}, null)`);
    await db.execute(sql`
      insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                 pay_date_offset_days, is_active, created_by, updated_by)
      values (${scheduleId}, ${org.orgId}, 'Window Schedule', 'biweekly', 26, '2026-07-18', 3, true,
              ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                    effective_from, is_active, created_by, updated_by)
      values (${org.orgId}, ${employeeId}, 'CAD', '30', 'hour', '2080', '2026-01-01', true,
              ${actorId}, ${actorId})`);
    // Hires carry an HRM employment or stub calculation refuses them.
    const employmentId = await seedWorkerEmployment(org.orgId, employeeId, org.subsidiaryId);
    await db.execute(sql`
      insert into employee_payroll_profiles (org_id, employee_party_id, employment_id, pay_schedule_id,
                                             country, province, pay_basis, federal_claim_code,
                                             provincial_claim_code, vacation_percent, vacation_method,
                                             is_active, created_by, updated_by)
      values (${org.orgId}, ${employeeId}, ${employmentId}, ${scheduleId}, 'CA', 'ON', 'hourly', 1, 1,
              null, 'accrue', true, ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into time_entries (org_id, employee_party_id, worked_on, hours, status,
                                is_billable, billing_status, costing_basis, created_by, updated_by)
      values (${org.orgId}, ${employeeId}, '2026-07-06', '8', 'approved',
              false, 'unbilled', 'actual', ${actorId}, ${actorId})`);

    const component = async (code: string): Promise<string> => {
      const id = randomUUID();
      await db.execute(sql`
        insert into pay_components (id, org_id, code, name, kind, system_key, basis, is_active,
                                    created_by, updated_by)
        values (${id}, ${org.orgId}, ${code}, ${code}, 'earning', null, 'fixed_amount',
                true, ${actorId}, ${actorId})`);
      return id;
    };
    const midId = await component("MIDSUM");
    const beforeId = await component("BEFORESUM");
    const fullId = await component("FULLSUM");
    const assign = async (componentId: string, value: string, from: string, to: string | null): Promise<void> => {
      await db.execute(sql`
        insert into employee_pay_components (org_id, employee_party_id, component_id, value,
                                             effective_from, effective_to, is_active,
                                             created_by, updated_by)
        values (${org.orgId}, ${employeeId}, ${componentId}, ${value}, ${from}, ${to}, true,
                ${actorId}, ${actorId})`);
    };
    // Ends mid-period (period is 2026-07-05–18): paid for the 6 covered days.
    await assign(midId, "50.00", "2026-01-01", "2026-07-10");
    // Ended the day before the period started: must stay off.
    await assign(beforeId, "50.00", "2026-01-01", "2026-07-04");
    // Covers the whole period: paid in full, byte-identical to unwindowed.
    await assign(fullId, "50.00", "2026-01-01", null);

    const run = await createPayRun({
      orgId: org.orgId,
      actorId,
      payScheduleId: scheduleId,
      periodStart: "2026-07-05",
      periodEnd: "2026-07-18",
    });
    await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });

    const lines = (await db.execute<{ code: string; amount: string }>(sql`
      select c.code, l.amount::text as amount
        from pay_stub_lines l
        join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
        join pay_components c on c.id = l.component_id and c.org_id = l.org_id
       where s.org_id = ${org.orgId} and s.pay_run_document_id = ${run.documentId}
         and l.component_id in (${midId}, ${beforeId}, ${fullId})
    `)).rows;
    const byCode = new Map(lines.map((l) => [l.code, l.amount]));
    // 6 of the 14 period days covered: 6/14 × 50.00, rounded to cents.
    assert.equal(byCode.get("MIDSUM"), "21.4300",
      "an assignment ending mid-period is paid for its covered days, not the full period");
    assert.ok(!byCode.has("BEFORESUM"),
      "an assignment that ended before the period started must stay off the stub");
    assert.equal(byCode.get("FULLSUM"), "50.0000",
      "a fully-covering assignment pays its full value with no proration math");

    await dropScratchOrg(org.orgId);
  });

  /**
   * A mid-period amendment is stored as two adjacent rows — old ending the
   * 15th, new starting the 16th — which the overlap guard allows. Each slice
   * pays its covered calendar-day fraction, so the two slices of one amended
   * component sum to exactly one period: never the sum of both full values.
   */
  test("a mid-month amendment pays each slice, never twice the component", { skip: !DB }, async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await db.execute(sql`
      update orgs set settings = settings || ${JSON.stringify({
        features: { payroll: true },
      })}::jsonb where id = ${org.orgId}`);
    await seedPayrollComponents(org.orgId, actorId, "CA");
    await seedOntarioEhtFixture(org.orgId, actorId);

    const employeeId = randomUUID();
    const scheduleId = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${employeeId}, ${org.orgId}, 'person', 'Amend Employee', true, '{}'::jsonb)`);
    await db.execute(sql`
      insert into employee_roles (id, org_id, party_id, terminated_on)
      values (${randomUUID()}, ${org.orgId}, ${employeeId}, null)`);
    await db.execute(sql`
      insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                 pay_date_offset_days, is_active, created_by, updated_by)
      values (${scheduleId}, ${org.orgId}, 'Amend Schedule', 'monthly', 12, '2026-07-31', 3, true,
              ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                    effective_from, is_active, created_by, updated_by)
      values (${org.orgId}, ${employeeId}, 'CAD', '30', 'hour', '2080', '2026-01-01', true,
              ${actorId}, ${actorId})`);
    // Hires carry an HRM employment or stub calculation refuses them.
    const employmentId = await seedWorkerEmployment(org.orgId, employeeId, org.subsidiaryId);
    await db.execute(sql`
      insert into employee_payroll_profiles (org_id, employee_party_id, employment_id, pay_schedule_id,
                                             country, province, pay_basis, federal_claim_code,
                                             provincial_claim_code, vacation_percent, vacation_method,
                                             is_active, created_by, updated_by)
      values (${org.orgId}, ${employeeId}, ${employmentId}, ${scheduleId}, 'CA', 'ON', 'hourly', 1, 1,
              null, 'accrue', true, ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into time_entries (org_id, employee_party_id, worked_on, hours, status,
                                is_billable, billing_status, costing_basis, created_by, updated_by)
      values (${org.orgId}, ${employeeId}, '2026-07-06', '8', 'approved',
              false, 'unbilled', 'actual', ${actorId}, ${actorId})`);

    const componentId = randomUUID();
    await db.execute(sql`
      insert into pay_components (id, org_id, code, name, kind, system_key, basis, is_active,
                                  created_by, updated_by)
      values (${componentId}, ${org.orgId}, 'AMENDED-ALLOW', 'AMENDED-ALLOW', 'earning', null,
              'fixed_amount', true, ${actorId}, ${actorId})`);
    const slice = async (value: string, from: string, to: string | null): Promise<void> => {
      await db.execute(sql`
        insert into employee_pay_components (org_id, employee_party_id, component_id, value,
                                             effective_from, effective_to, is_active,
                                             created_by, updated_by)
        values (${org.orgId}, ${employeeId}, ${componentId}, ${value}, ${from}, ${to}, true,
                ${actorId}, ${actorId})`);
    };
    await slice("3000.00", "2026-01-01", "2026-07-15");
    await slice("3100.00", "2026-07-16", null);

    const run = await createPayRun({
      orgId: org.orgId,
      actorId,
      payScheduleId: scheduleId,
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
    });
    await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });

    const lines = (await db.execute<{ amount: string }>(sql`
      select l.amount::text as amount
        from pay_stub_lines l
        join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
       where s.org_id = ${org.orgId} and s.pay_run_document_id = ${run.documentId}
         and l.component_id = ${componentId}
       order by l.amount
    `)).rows;
    assert.equal(lines.length, 2, "both slices of the amended component are paid");
    // 15/31 × 3000.00 and 16/31 × 3100.00, rounded to cents: ≈ half each.
    assert.equal(lines[0]!.amount, "1451.6100");
    assert.equal(lines[1]!.amount, "1600.0000");
    assert.ok(Number(lines[0]!.amount) + Number(lines[1]!.amount) < 6100,
      "the two slices must never sum to both full values");

    await dropScratchOrg(org.orgId);
  });
});

describe("run-entitlement-hours-payout", () => {

  const DB = !!process.env.OPENBOOKS_DB_URL;

  /**
   * A 40-hour bank at $30/h pays $1,200 on the final cheque — not $40.00. The
   * payout line pays the bank's MONEY value (hours valued at the current wage);
   * the ledger movement clearing the bank stays in the plan's unit.
   */
  test("a final pay values an hours bank at the wage", { skip: !DB }, async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await db.execute(sql`
      update orgs set settings = settings || ${JSON.stringify({
        features: { payroll: true },
      })}::jsonb where id = ${org.orgId}`);
    await seedPayrollComponents(org.orgId, actorId, "CA");
    await seedOntarioEhtFixture(org.orgId, actorId);

    const employeeId = randomUUID();
    const scheduleId = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${employeeId}, ${org.orgId}, 'person', 'Banked Employee', true, '{}'::jsonb)`);
    await db.execute(sql`
      insert into employee_roles (id, org_id, party_id, terminated_on)
      values (${randomUUID()}, ${org.orgId}, ${employeeId}, '2026-07-18')`);
    await db.execute(sql`
      insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                 pay_date_offset_days, is_active, created_by, updated_by)
      values (${scheduleId}, ${org.orgId}, 'Bank Schedule', 'biweekly', 26, '2026-07-18', 3, true,
              ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                    effective_from, is_active, created_by, updated_by)
      values (${org.orgId}, ${employeeId}, 'CAD', '30', 'hour', '2080', '2026-01-01', true,
              ${actorId}, ${actorId})`);
    // Hires carry an HRM employment or stub calculation refuses them.
    const employmentId = await seedWorkerEmployment(org.orgId, employeeId, org.subsidiaryId);
    await db.execute(sql`
      insert into employee_payroll_profiles (org_id, employee_party_id, employment_id, pay_schedule_id,
                                             country, province, pay_basis, federal_claim_code,
                                             provincial_claim_code, vacation_percent, vacation_method,
                                             is_active, created_by, updated_by)
      values (${org.orgId}, ${employeeId}, ${employmentId}, ${scheduleId}, 'CA', 'ON', 'hourly', 1, 1,
              null, 'accrue', true, ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into time_entries (org_id, employee_party_id, worked_on, hours, status,
                                is_billable, billing_status, costing_basis, created_by, updated_by)
      values (${org.orgId}, ${employeeId}, '2026-07-06', '8', 'approved',
              false, 'unbilled', 'actual', ${actorId}, ${actorId})`);

    const payoutComponentId = randomUUID();
    await db.execute(sql`
      insert into pay_components (id, org_id, code, name, kind, system_key, basis, is_active,
                                  created_by, updated_by)
      values (${payoutComponentId}, ${org.orgId}, 'SICK-PAY', 'Sick bank payout', 'earning', null,
              'fixed_amount', true, ${actorId}, ${actorId})`);
    const planId = randomUUID();
    await db.execute(sql`
      insert into entitlement_plans (id, org_id, code, name, system_key, unit, direction,
                                     accrual_method, payout_component_id, created_by, updated_by)
      values (${planId}, ${org.orgId}, 'SICK-HRS', 'Sick bank', null, 'hours', 'accrue',
              'manual', ${payoutComponentId}, ${actorId}, ${actorId})`);
    // 40 banked hours, accrued before this run.
    await db.execute(sql`
      insert into entitlement_ledger (org_id, plan_id, employee_party_id, movement_date, amount,
                                      hours, kind, pay_run_document_id, note, created_by, updated_by)
      values (${org.orgId}, ${planId}, ${employeeId}, '2026-07-01', '40.0000',
              null, 'accrual', null, 'banked time', ${actorId}, ${actorId})`);

    const run = await createPayRun({
      orgId: org.orgId,
      actorId,
      payScheduleId: scheduleId,
      periodStart: "2026-07-05",
      periodEnd: "2026-07-18",
      runType: "termination",
      employeePartyIds: [employeeId],
    });
    await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });

    const lines = (await db.execute<{ amount: string }>(sql`
      select l.amount::text as amount
        from pay_stub_lines l
        join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
       where s.org_id = ${org.orgId} and s.pay_run_document_id = ${run.documentId}
         and l.component_id = ${payoutComponentId}
    `)).rows;
    assert.equal(lines.length, 1, "the final pay carries the bank payout line");
    assert.equal(lines[0]!.amount, "1200.0000",
      "40 hours at $30/h pay $1,200 — never the $40.00 hour count");

    // The clearing movement stays in the plan's unit: the bank IS hours.
    const cleared = (await db.execute<{ amount: string; kind: string }>(sql`
      select amount::text as amount, kind from entitlement_ledger
       where org_id = ${org.orgId} and plan_id = ${planId} and kind = 'payout'
    `)).rows;
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0]!.amount, "-40.0000");

    await dropScratchOrg(org.orgId);
  });
});

describe("calculation-rollback", () => {

  async function evidence(orgId: string) {
    return (await db.execute<{ state: unknown }>(sql`select jsonb_build_object(
      'documents',(select jsonb_agg(to_jsonb(d) order by id) from documents d where org_id=${orgId}),
      'runs',(select jsonb_agg(to_jsonb(r) order by document_id) from pay_runs r where org_id=${orgId}),
      'stubs',(select jsonb_agg(to_jsonb(s) order by id) from pay_stubs s where org_id=${orgId}),
      'lines',(select jsonb_agg(to_jsonb(l) order by id) from pay_stub_lines l where org_id=${orgId}),
      'components',(select jsonb_agg(to_jsonb(c) order by id) from pay_components c where org_id=${orgId}),
      'entitlements',(select jsonb_agg(to_jsonb(e) order by id) from entitlement_ledger e where org_id=${orgId}),
      'projection',(select jsonb_agg(to_jsonb(d) order by id) from document_lines d where org_id=${orgId}),
      'time',(select jsonb_agg(to_jsonb(t) order by id) from time_entries t where org_id=${orgId})
    ) as state`)).rows[0]!.state;
  }

  test("a caught late payroll commit refusal restores all evidence in an ambient transaction",
    { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
      const fx = await seedAdoption();
      const blocker = await pool.connect();
      let pending: Promise<PromiseSettledResult<void>> | undefined;
      try {
        const { input } = await calculatedRun(fx);
        const line = (await db.execute<{ id: string }>(sql`insert into document_lines
          (org_id,document_id,line_number,account_id,description,amount,created_by,updated_by)
          select ${fx.orgId},${input.documentId},1,id,'Existing draft projection',1,${fx.actorId},${fx.actorId}
          from accounts where org_id=${fx.orgId} and number='6000' returning id`)).rows[0]!;
        const before = await evidence(fx.orgId);
        await blocker.query("begin");
        await blocker.query("select set_config('app.bypass_rls','on',true)");
        await blocker.query("select id from document_lines where org_id=$1 and id=$2 for update", [fx.orgId, line.id]);
        const pid = (await blocker.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
        pending = withOrgTransaction(fx.orgId, async () => {
          await assert.rejects(commitPayRun(input), /inputs changed after it was last calculated \(roster\)/);
          assert.deepEqual(await evidence(fx.orgId), before, "caught refusal must restore projection, liabilities, and time claims");
        }).then((value) => ({ status: "fulfilled", value }), (reason: unknown) => ({ status: "rejected", reason }));
        let blocked = false;
        for (let attempt = 0; attempt < 400; attempt++) {
          const row = (await pool.query<{ blocked: boolean }>("select exists(select 1 from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))) as blocked", [pid])).rows[0]!;
          if (row.blocked) { blocked = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(blocked, "commit must reach projection replacement after its initial freshness checks");
        await db.transaction(async (tx) => {
          await tx.execute(sql`set local lock_timeout='2s'`);
          // Org settings are locked by the feature gate; a payroll profile is
          // still an independent input whose late change must roll commit back.
          await tx.execute(sql`update employee_payroll_profiles set updated_at=clock_timestamp() where org_id=${fx.orgId}`);
        });
        await blocker.query("commit");
        const result = await pending;
        if (result.status === "rejected") throw result.reason;
        assert.deepEqual(await evidence(fx.orgId), before);
        assert.deepEqual((await calculatePayRun(input)).errors, []);
        assert.ok((await commitPayRun(input)).lines > 0);
      } finally {
        await blocker.query("rollback"); blocker.release(); await pending;
        await dropScratchOrgReporting(fx.orgId);
      }
    });

  for (const mode of ["dry-run", "simulation"] as const) {
    for (const ambient of [false, true]) {
      test(`payroll ${mode} preserves all evidence ${ambient ? "inside an ambient transaction" : "standalone"}`,
        { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const fx = await seedAdoption();
          try {
            const { input } = await calculatedRun(fx);
            if (mode === "simulation") await commitPayRun(input);
            const before = await evidence(fx.orgId);
            const preview = async () => {
              const result = await calculatePayRun({ ...input, ...(mode === "simulation" ? { simulate: true } : { dryRun: true }) });
              assert.equal(result.employees, 1);
              assert.deepEqual(result.errors, []);
              assert.equal(cmp(result.gross, "240"), 0);
              if (mode === "simulation") assert.equal(result.stubs?.length, 1);
              assert.deepEqual(await evidence(fx.orgId), before, "preview must preserve IDs, values, and audit evidence");
            };
            if (ambient) {
              await withOrgTransaction(fx.orgId, async () => {
                await db.execute(sql`update parties set custom=custom || '{"previewCallerWork":true}'::jsonb
                  where org_id=${fx.orgId} and id=${fx.employeeId}`);
                await preview();
              });
              assert.equal((await db.execute<{ marker: boolean }>(sql`select (custom->>'previewCallerWork')::boolean as marker
                from parties where org_id=${fx.orgId} and id=${fx.employeeId}`)).rows[0]!.marker, true,
              "preview rollback must preserve the caller's earlier work");
            } else await preview();
            assert.deepEqual(await evidence(fx.orgId), before, "committing the caller transaction cannot persist preview writes");
            if (mode === "dry-run") {
              assert.deepEqual((await calculatePayRun(input)).errors, []);
              assert.ok((await commitPayRun(input)).lines > 0, "real calculation and commit must still persist");
            }
          } finally { await dropScratchOrgReporting(fx.orgId); }
        });
    }
  }
});
