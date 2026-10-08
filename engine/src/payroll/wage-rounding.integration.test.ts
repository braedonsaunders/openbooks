import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { supersedeLaborCostRate } from "../projects/labor-cost-rates.ts";
import { seedHourlyPayrollOrg, seedHourlyPayrollEmployee } from "../testing/payroll-hourly-fixture.ts";
import { dropScratchOrgReporting, seedPayrollTime } from "../testing/fixtures.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { assertPayRunNotStale } from "./readiness.ts";
import { payRunCalculationSource, payRunCalculationSourceDigest } from "./run-calculation-evidence.ts";

test("omitted wage rounding terms inherit the policy at the saved date rather than the latest policy", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await seedHourlyPayrollOrg();
  try {
    const { partyId } = await seedHourlyPayrollEmployee(fx, "Dated wage policy inheritance");
    const wage = {
      orgId: fx.orgId, actorId: fx.actorId,
      scope: { employeePartyId: partyId, jobTitle: null, tradeId: null, departmentId: null, subsidiaryId: null },
      currency: "CAD", basis: "hour" as const, rate: "35.25", annualHours: "2080", notes: null,
      reason: "Preserve the effective payroll policy during a wage change",
    };
    const save = (terms: { effectiveFrom: string; rate?: string; payrollRateScale?: number; payrollAmountRounding?: "dimension_group" | "time_entry" }) =>
      withOrgTransaction(fx.orgId, () => supersedeLaborCostRate({ ...wage, ...terms }));
    await save({ effectiveFrom: "2026-01-01" });
    await save({ effectiveFrom: "2026-07-12", payrollRateScale: 2, payrollAmountRounding: "time_entry" });
    await save({ effectiveFrom: "2026-08-01", rate: "36.25" });
    await save({ effectiveFrom: "2026-03-01", rate: "35.50" });
    await save({ effectiveFrom: "2026-07-12", rate: "35.75" });
    const rows = (await db.execute<{
      effective_from: string; effective_to: string | null; rate: string;
      payroll_rate_scale: number; payroll_amount_rounding: string;
    }>(sql`select effective_from::text, effective_to::text, rate::text, payroll_rate_scale, payroll_amount_rounding
      from labor_cost_rates where org_id=${fx.orgId} and employee_party_id=${partyId} order by effective_from`)).rows;
    assert.deepEqual(rows, [
      { effective_from: "2026-01-01", effective_to: "2026-02-28", rate: "35.2500", payroll_rate_scale: 4, payroll_amount_rounding: "dimension_group" },
      { effective_from: "2026-03-01", effective_to: "2026-07-11", rate: "35.5000", payroll_rate_scale: 4, payroll_amount_rounding: "dimension_group" },
      { effective_from: "2026-07-12", effective_to: "2026-07-31", rate: "35.7500", payroll_rate_scale: 2, payroll_amount_rounding: "time_entry" },
      { effective_from: "2026-08-01", effective_to: null, rate: "36.2500", payroll_rate_scale: 2, payroll_amount_rounding: "time_entry" },
    ]);
    const audits = (await db.execute<{ actor_id: string; changes: { after: { payrollRateScale: number; payrollAmountRounding: string } } }>(sql`
      select actor_id, changes from audit_log where org_id=${fx.orgId} and table_name='labor_cost_rates'
        and changes->>'reason'=${wage.reason} order by at,id`)).rows;
    assert.equal(audits.length, 5);
    assert.ok(audits.every((audit) => audit.actor_id === fx.actorId));
    assert.deepEqual(audits.map((audit) => [audit.changes.after.payrollRateScale, audit.changes.after.payrollAmountRounding]),
      [[4, "dimension_group"], [2, "time_entry"], [2, "time_entry"], [4, "dimension_group"], [2, "time_entry"]]);
  } finally {
    await dropScratchOrgReporting(fx.orgId);
  }
});

test("dated wage rounding reaches native stubs, audits, replay and stale-calculation refusal", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await seedHourlyPayrollOrg();
  try {
    const { partyId } = await seedHourlyPayrollEmployee(fx, "Hourly wage rounding");
    const scope = { employeePartyId: partyId, jobTitle: null, tradeId: null, departmentId: null, subsidiaryId: null };
    const wage = { orgId: fx.orgId, actorId: fx.actorId, scope, currency: "CAD", basis: "hour" as const,
      rate: "35.25", annualHours: "2080", notes: null, reason: "Reviewed contractual wage rounding" };
    await withOrgTransaction(fx.orgId, () => supersedeLaborCostRate({ ...wage, effectiveFrom: "2026-01-01" }));
    const changed = await withOrgTransaction(fx.orgId, () => supersedeLaborCostRate({ ...wage,
      effectiveFrom: "2026-07-12", payrollRateScale: 2, payrollAmountRounding: "time_entry" }));
    assert.equal(changed.after.payrollRateScale, 2);
    assert.equal(changed.before[0]!.payrollRateScale, 4);
    const typeId = randomUUID();
    await db.execute(sql`insert into time_types(id,org_id,name,classification,cost_multiplier,bill_multiplier)
      values(${typeId},${fx.orgId},'Overtime','overtime',1.5,1.5)`);
    for (const [start, end] of [["2026-07-05", "2026-07-11"], ["2026-07-12", "2026-07-18"]] as const) {
      // Distinct source entries include two on the same day; they cannot be
      // replaced by a day subtotal when entry rounding governs.
      for (const hours of ["1", "1", "1.5", "0.5", "1"]) {
        await seedPayrollTime(fx.orgId, partyId, fx.actorId, { workedOn: start, hours, timeTypeId: typeId,
          status: "approved", projectId: null, isBillable: false, costingBasis: "actual", billingStatus: "unbilled" });
      }
      const run = await createPayRun({ orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId, periodStart: start, periodEnd: end });
      const calculate = () => calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId });
      const lines = async () => (await db.execute<{ amount: string; rate: string; hours: string; earned_from: string; expense_account_id: string }>(sql`
        select l.amount::text,l.rate::text,l.hours::text,l.earned_from::text,l.expense_account_id
          from pay_stub_lines l join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id
          join pay_components c on c.org_id=l.org_id and c.id=l.component_id
         where s.org_id=${fx.orgId} and s.pay_run_document_id=${run.documentId} and c.system_key='overtime'`)).rows;
      assert.deepEqual((await calculate()).errors, []);
      const initial = await lines();
      assert.equal(initial.length, 1);
      assert.equal(initial[0]!.amount, end === "2026-07-11" ? "264.3800" : "264.4000");
      assert.equal(initial[0]!.hours, "5.00");
      assert.equal(initial[0]!.earned_from, start);
      assert.equal(initial[0]!.expense_account_id, fx.accounts.wageExpense);
      assert.deepEqual((await calculate()).errors, []);
      assert.deepEqual(await lines(), initial, "native replay cannot duplicate or reprice the entries");
      if (end === "2026-07-11") {
        const source = await withOrgContext(fx.orgId, () => payRunCalculationSource(fx.orgId, run.documentId));
        assert.ok(!Object.hasOwn(source!.payRates[0]!, "payrollRateScale"), "unchanged default terms retain the legacy source shape");
      }
      if (end === "2026-07-18") {
        const source = await withOrgContext(fx.orgId, () => payRunCalculationSource(fx.orgId, run.documentId));
        assert.equal(source!.payRates[0]!.payrollRateScale, 2);
        assert.equal(source!.payRates[0]!.payrollAmountRounding, "time_entry");
        await withOrgTransaction(fx.orgId, () => supersedeLaborCostRate({ ...wage,
          effectiveFrom: start, payrollRateScale: 4, payrollAmountRounding: "dimension_group" }));
        const updated = await withOrgContext(fx.orgId, () => payRunCalculationSource(fx.orgId, run.documentId));
        assert.notEqual(payRunCalculationSourceDigest(source!), payRunCalculationSourceDigest(updated!));
        await assert.rejects(() => withOrgContext(fx.orgId, () => assertPayRunNotStale(fx.orgId, run.documentId)), /wage|rate|recalculate/i);
        assert.deepEqual(await lines(), initial, "a wage edit cannot rewrite the calculated stub");
        assert.deepEqual((await calculate()).errors, []);
        assert.equal((await lines())[0]!.amount, "264.3800");
      }
    }
    const audits = (await db.execute<{ actor_id: string; changes: { after: { payrollRateScale: number; payrollAmountRounding: string } } }>(sql`
      select actor_id,changes from audit_log where org_id=${fx.orgId} and table_name='labor_cost_rates'
        and changes->>'reason'=${wage.reason} order by at,id`)).rows;
    assert.equal(audits.length, 3);
    assert.ok(audits.every((audit) => audit.actor_id === fx.actorId));
    assert.ok(audits.some((audit) => audit.changes.after.payrollRateScale === 2 && audit.changes.after.payrollAmountRounding === "time_entry"));
  } finally {
    await dropScratchOrgReporting(fx.orgId);
  }
});
