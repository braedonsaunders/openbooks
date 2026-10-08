import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../../platform/db.ts";
import { withSimClock } from "../../platform/clock.ts";
import { DB, seedEmployment, seedWage, setupHarness, withHarness } from "../../testing/hrm-harness.ts";
import { employeeTotalCompensation } from "./total-compensation.ts";

const setup = () => setupHarness({
  features: ["hrm", "payroll"],
  users: [{ key: "reader", name: "Compensation reader", handle: "compensation_reader",
    permissions: ["hrm.compensation.read", "hrm.compensation.manage", "setup.manage"] }],
});

test("annual variable compensation includes all committed lines while history stays bounded", { skip: !DB }, async () => {
  await withHarness(setup, async ({ org, reader }) => {
    const worker = await seedEmployment(org.orgId, org.subsidiaryId);
    const other = await seedEmployment(org.orgId, org.subsidiaryId);
    await seedWage(org.orgId, reader, worker.workerPartyId, "52000");
    const scheduleId = randomUUID();
    await db.execute(sql`
      insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end)
      values (${scheduleId}, ${org.orgId}, 'Weekly', 'weekly', 52, '2026-10-08')`);

    // Historical payroll fixtures have one committed stub with many earning
    // splits, plus draft, voided, old and other-employment amounts to exclude.
    async function seedPayroll(employment: typeof worker, count: number, amount: string, date: string,
      status: "committed" | "draft" | "voided" = "committed") {
      const documentId = randomUUID();
      const stubId = randomUUID();
      await db.execute(sql`
        insert into documents (id, org_id, kind, document_number, document_date, currency, status,
          subtotal, tax_total, total, custom, extra_dims)
        values (${documentId}, ${org.orgId}, 'pay_run', ${`PAY-${documentId}`}, ${date}::date,
          'CAD', ${status}, 0, 0, 0, '{}'::jsonb, '{}'::jsonb)`);
      await db.execute(sql`
        insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end,
          pay_date, tax_year, run_status, run_type)
        values (${documentId}, ${org.orgId}, ${scheduleId}, ${date}::date, ${date}::date,
          ${date}::date, extract(year from ${date}::date)::integer,
          ${status === "draft" ? "draft" : "committed"}, 'bonus')`);
      await db.execute(sql`
        insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, employment_id,
          province, periods_per_year, pay_date, tax_year, currency_code)
        values (${stubId}, ${org.orgId}, ${documentId}, ${employment.workerPartyId}, ${employment.employmentId},
          'ON', 52, ${date}::date, extract(year from ${date}::date)::integer, 'CAD')`);
      await db.execute(sql`
        insert into pay_stub_lines (org_id, stub_id, kind, description, amount, sequence)
        select ${org.orgId}, ${stubId}, 'earning', 'Bonus split', ${amount}::numeric, n
          from generate_series(1, ${count}::integer) n`);
    }
    await seedPayroll(worker, 201, "0.01", "2026-10-08");
    await seedPayroll(worker, 1, "0.03", "2025-10-09");
    await seedPayroll(worker, 1, "1000", "2025-10-08");
    await seedPayroll(worker, 1, "1000", "2026-10-08", "draft");
    await seedPayroll(worker, 1, "1000", "2026-10-08", "voided");
    await seedPayroll(other, 1, "1000", "2026-10-08");

    const data = await withSimClock("2026-10-08T12:00:00Z", () => withOrgTransaction(org.orgId, () =>
      employeeTotalCompensation({ orgId: org.orgId, actorId: reader, employeePartyId: worker.workerPartyId }),
      { isolationLevel: "REPEATABLE READ", readOnly: true }));
    assert.equal(data.variableHistory.length, 200);
    assert.equal(data.variable.length, 202);
    assert.equal(data.totals?.variable, "2.04");
    assert.equal(data.totals?.total, "52002.04");
    assert.deepEqual(data.actualsWindow, { from: "2025-10-09", to: "2026-10-08" });
  });
});

test("HRM compensation retains benefit awards while Payroll is disabled", { skip: !DB }, async () => {
  await withHarness(setup, async ({ org, reader }) => {
    const worker = await seedEmployment(org.orgId, org.subsidiaryId);
    const programId = randomUUID();
    const awardId = randomUUID();
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features,payroll}', 'false'::jsonb)
       where id = ${org.orgId}`);
    await db.execute(sql`
      insert into hrm_benefit_programs (id, org_id, code, name, family, legal_entity_id,
        currency, effective_from, delivery_method, fixed_amount)
      values (${programId}, ${org.orgId}, 'RECOGNITION', 'Recognition award', 'reward',
        ${org.subsidiaryId}, 'CAD', '2026-01-01', 'external', 250)`);
    await db.execute(sql`
      insert into hrm_benefit_awards (id, org_id, program_id, employment_id, period_from,
        value, currency, program_snapshot, source_snapshot)
      values (${awardId}, ${org.orgId}, ${programId}, ${worker.employmentId}, '2026-10-08',
        250, 'CAD', '{"name":"Recognition award"}'::jsonb, '{}'::jsonb)`);
    const data = await withSimClock("2026-10-08T12:00:00Z", () => withOrgTransaction(org.orgId, () =>
      employeeTotalCompensation({ orgId: org.orgId, actorId: reader, employeePartyId: worker.workerPartyId }),
      { isolationLevel: "REPEATABLE READ", readOnly: true }));
    assert.equal(data.payroll.enabled, false);
    assert.equal(data.awards.length, 1);
    assert.equal(data.awards[0]!.id, awardId);
    assert.equal(data.awards[0]!.program, "Recognition award");
    assert.equal(data.awards[0]!.value, "250.0000");
    assert.deepEqual(data.variable, []);
    assert.equal(data.actualsWindow, null);
  });
});
