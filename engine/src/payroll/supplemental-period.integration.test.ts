import {
  seedPayrollSchedule, seedPayrollEmployeeRole, seedPayrollPerson, seedPayrollTime, seedPostingAccount,
  seedPayrollProfile, seedPayrollWage, createScratchOrg, dropScratchOrgReporting, seedFlowActors, seedWorkerEmployment,
  seedPayrollAccountingConfiguration,
} from "../testing/fixtures.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { div, toCents } from "../money/money.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { mutatePayRunAdjustment } from "./run-adjustments.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { seedOntarioEhtFixture } from "./filing-test-fixtures.ts";

/**
 * Supplemental runs share the CPP exemption and retain payment-level EI rounding.
 *
 * Measured against the employer's real stubs (2026, weekly P=52, Ontario,
 * TD1 claims 16452 federal / 12989 Ontario, June 2026 so the July edition is
 * not in force):
 *
 * - Run 1 of the week is a BONUS code paid as periodic pay — the bonus
 *   method is never involved. Income 4000.00, pensionable 4000.00,
 *   insurable 4000.00 -> CPP 234.00, EI 65.20, federal 786.13,
 *   provincial 491.71 (total 1277.84).
 * - Run 2 pays 800.00 cash earnings plus 193.77 of taxable non-cash
 *   benefits (188.16 insurable, 5.61 not). CPP prices on the period total
 *   once: (4000.00 + 993.77 - 67.30) x 0.0595 - 234.00 = 59.12.
 *   EI rounds this payment: 988.16 x 0.0163 = 16.11.
 *   Income tax prices run 2 as its own periodic pay, with the K2/F5
 *   credits off the 59.12/16.11 actually withheld (not a 55.12
 *   standalone recomputation): federal 80.26, provincial 45.31.
 *
 * The stub carries one income-tax line (federal + provincial combined, as
 * T4127 prices them); the federal/provincial split below is derived from
 * the stub's traced annual T1/T2 factors at 1/52, so it holds whichever
 * per-period rounding the engine uses.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  orgId: string;
  subsidiaryId: string;
  actorId: string;
  scheduleId: string;
  bonusComponentId: string;
  benInsComponentId: string;
  benNinsComponentId: string;
  worker: string;
}

async function payrollOrg(setting: "per_run" | "period_cumulative" | null): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const expense = await seedPostingAccount(org.orgId, "6000", "Wages expense", "expense");
  const burden = await seedPostingAccount(org.orgId, "6010", "Payroll burden", "expense");
  const netPay = await seedPostingAccount(org.orgId, "2300", "Wages payable", "liability_current");
  const cra = await seedPostingAccount(org.orgId, "2310", "CRA payable", "liability_current");
  const vacation = await seedPostingAccount(org.orgId, "2320", "Vacation payable", "liability_current");
  await seedPayrollAccountingConfiguration(org.orgId, {
    wageExpenseAccountId: expense,
    burdenExpenseAccountId: burden,
    netPayAccountId: netPay,
    cppPayableAccountId: cra,
    eiPayableAccountId: cra,
    taxPayableAccountId: cra,
    vacationPayableAccountId: vacation,
    wagesTo: "expense",
  });
  await seedPayrollComponents(org.orgId, actorId, "CA");
  await seedOntarioEhtFixture(org.orgId, actorId);
  if (setting !== null) {
    await db.execute(sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{payroll,supplementalTaxMethod}', ${JSON.stringify(setting)}::jsonb) where id = ${org.orgId}`);
  }
  const scheduleId = randomUUID();
  await seedPayrollSchedule(org.orgId, scheduleId, actorId, {
    name: "Weekly", frequency: "weekly", periodsPerYear: 52, anchorPeriodEnd: "2026-05-30",
    payDateOffsetDays: 3,
  });
  // A bonus code paid as periodic pay: the bonus method is never involved.
  const bonusComponentId = randomUUID();
  await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,taxable,pensionable,insurable,vacationable,non_periodic)
    values(${bonusComponentId},${org.orgId},'BONUS_PAY','Bonus (periodic)','earning','CA',true,true,true,false,false)`);
  const benInsComponentId = randomUUID();
  await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,taxable,pensionable,insurable,vacationable,non_periodic)
    values(${benInsComponentId},${org.orgId},'BEN_INS','Taxable benefit (insurable)','earning','CA',true,true,true,false,false)`);
  const benNinsComponentId = randomUUID();
  await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,taxable,pensionable,insurable,vacationable,non_periodic)
    values(${benNinsComponentId},${org.orgId},'BEN_NINS','Taxable benefit (non-insurable)','earning','CA',true,true,false,false,false)`);
  const worker = randomUUID();
  await seedPayrollPerson(org.orgId, worker, "Supplemental Worker");
  await seedPayrollEmployeeRole(org.orgId, worker, { id: randomUUID(), workerCompGroupId: null, terminatedOn: null });
  await seedPayrollWage(org.orgId, worker, actorId, {
    currency: "CAD", rate: "25", basis: "hour", annualHours: "2080", effectiveFrom: "2026-01-01",
  });
  const employmentId = await seedWorkerEmployment(org.orgId, worker, org.subsidiaryId);
  await seedPayrollProfile(org.orgId, worker, employmentId, scheduleId, actorId, {
    country: "CA", province: "ON", payBasis: "hourly",
    federalClaimAmount: "16452", provincialClaimAmount: "12989",
  }, { percentFloor: "4", method: "accrue" });
  return {
    orgId: org.orgId, subsidiaryId: org.subsidiaryId, actorId, scheduleId,
    bonusComponentId, benInsComponentId, benNinsComponentId, worker,
  };
}

async function line(fx: Fixture, documentId: string, componentId: string, amount: string): Promise<void> {
  await mutatePayRunAdjustment({
    orgId: fx.orgId, documentId, actorId: fx.actorId,
    mutation: { action: "add", employeePartyId: fx.worker, componentId, amount },
  });
}

async function stubLine(fx: Fixture, documentId: string, systemKey: string): Promise<string> {
  const rows = (await db.execute<{ amount: string }>(sql`
    select l.amount::text as amount
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
      join pay_components c on c.id = l.component_id and c.org_id = l.org_id
     where s.org_id = ${fx.orgId} and s.pay_run_document_id = ${documentId}
       and s.employee_party_id = ${fx.worker}
       and c.system_key = ${systemKey} and l.kind = 'deduction'`)).rows;
  assert.equal(rows.length, 1, `expected one ${systemKey} line`);
  return rows[0]!.amount;
}

async function stubFactor(fx: Fixture, documentId: string, key: string): Promise<string> {
  const rows = (await db.execute<{ value: string | null }>(sql`
    select (factors->>${key})::text as value from pay_stubs
     where org_id = ${fx.orgId} and pay_run_document_id = ${documentId}
       and employee_party_id = ${fx.worker}`)).rows;
  assert.ok(rows[0]?.value != null, `expected factor ${key}`);
  return rows[0]!.value!;
}

/** Per-period federal/provincial shares from the stub's annual T1/T2 at 1/52. */
async function taxSplit(fx: Fixture, documentId: string): Promise<{ federal: bigint; provincial: bigint }> {
  const t1 = await stubFactor(fx, documentId, "T1");
  const t2 = await stubFactor(fx, documentId, "T2");
  return { federal: toCents(div(t1, "52")), provincial: toCents(div(t2, "52")) };
}

test("default: each run taxed as its own periodic pay, credits off what the run withheld", { skip: !DB }, async () => {
  const fx = await payrollOrg(null);
  try {
    // Run 1 (supplemental, paid first): 4000.00 bonus paid as periodic pay.
    const run1 = await createPayRun({
      orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
      periodStart: "2026-06-07", periodEnd: "2026-06-13", payDate: "2026-06-13",
      runType: "supplemental",
    });
    await line(fx, run1.documentId, fx.bonusComponentId, "4000.00");
    assert.deepEqual((await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run1.documentId })).errors, []);
    assert.equal(await stubLine(fx, run1.documentId, "cpp"), "234.0000");
    assert.equal(await stubLine(fx, run1.documentId, "ei"), "65.2000");
    assert.equal(await stubLine(fx, run1.documentId, "income_tax"), "1277.8400");
    assert.deepEqual(await taxSplit(fx, run1.documentId), { federal: 78613n, provincial: 49171n });
    await commitPayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run1.documentId });

    // A supplemental run that names no period is refused: the next-period
    // anchor would silently pay the wrong week.
    await assert.rejects(
      createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        runType: "supplemental",
      }),
      /must name its pay period explicitly/,
    );

    // Run 2 (regular, same period): 800.00 wages + 193.77 taxable benefits.
    for (const day of ["2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11"]) {
      await seedPayrollTime(fx.orgId, fx.worker, fx.actorId, {
        workedOn: day, hours: "8", projectId: null, status: "approved",
        isBillable: false, billingStatus: "unbilled", costingBasis: "actual",
      });
    }
    const run2 = await createPayRun({
      orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
      periodStart: "2026-06-07", periodEnd: "2026-06-13", payDate: "2026-06-16",
      runType: "regular",
    });
    await line(fx, run2.documentId, fx.benInsComponentId, "188.16");
    await line(fx, run2.documentId, fx.benNinsComponentId, "5.61");
    assert.deepEqual((await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run2.documentId })).errors, []);
    // (4000.00 + 993.77 - 67.30) x 0.0595 - 234.00 = 59.12.
    assert.equal(await stubLine(fx, run2.documentId, "cpp"), "59.1200");
    // EI rounds this payment: 988.16 x 0.0163 = 16.11.
    assert.equal(await stubLine(fx, run2.documentId, "ei"), "16.1100");
    // Run 2 as its own periodic pay, credits off the 59.12/16.11 withheld.
    assert.deepEqual(await taxSplit(fx, run2.documentId), { federal: 8026n, provincial: 4531n });
    assert.equal(await stubLine(fx, run2.documentId, "income_tax"), "125.5700");
    await commitPayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run2.documentId });

    // Year-to-date accumulates both runs exactly once.
    const ytd = (await db.execute<{ pensionable: string; insurable: string; cpp: string; ei: string }>(sql`
      select sum(s.pensionable_earnings)::text as pensionable, sum(s.insurable_earnings)::text as insurable,
             sum((s.factors->>'C')::numeric)::text as cpp, sum((s.factors->>'EI')::numeric)::text as ei
        from pay_stubs s
        join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
        join documents d on d.id = r.document_id and d.org_id = r.org_id
       where s.org_id = ${fx.orgId} and s.employee_party_id = ${fx.worker}
         and s.tax_year = 2026 and r.run_status = 'committed' and d.status <> 'voided'`)).rows[0]!;
    assert.equal(ytd.pensionable, "4993.7700");
    assert.equal(ytd.insurable, "4988.1600");
    assert.equal(ytd.cpp, "293.1200");
    assert.equal(ytd.ei, "81.3100");

    // A second REGULAR run for the same period is refused, naming the
    // covering run and the supplemental remedy that exists.
    await assert.rejects(
      createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-06-07", periodEnd: "2026-06-13", payDate: "2026-06-16",
        runType: "regular",
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /already covers 2026-06-07 to 2026-06-13/);
        assert.ok(message.includes(run2.documentNumber), "refusal names the covering run");
        assert.match(message, /create a supplemental run for the same period instead/);
        return true;
      },
    );

    // Sequencing: a run inserted before an already-committed later run is
    // refused until the later run is voided and the period re-processed.
    const run3 = await createPayRun({
      orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
      periodStart: "2026-06-07", periodEnd: "2026-06-13", payDate: "2026-06-17",
      runType: "supplemental",
    });
    await line(fx, run3.documentId, fx.bonusComponentId, "100.00");
    assert.deepEqual((await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run3.documentId })).errors, []);
    await commitPayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run3.documentId });
    const run4 = await createPayRun({
      orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
      periodStart: "2026-06-07", periodEnd: "2026-06-13", payDate: "2026-06-16",
      runType: "supplemental",
    });
    await line(fx, run4.documentId, fx.bonusComponentId, "10.00");
    await assert.rejects(
      calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run4.documentId }),
      /already committed and was computed without this run's share — void .* and re-process the period in pay-date order/,
    );

    // Sequencing: a run cannot calculate while an earlier run is still draft.
    const run5 = await createPayRun({
      orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
      periodStart: "2026-06-07", periodEnd: "2026-06-13", payDate: "2026-06-18",
      runType: "supplemental",
    });
    await line(fx, run5.documentId, fx.bonusComponentId, "10.00");
    const run6 = await createPayRun({
      orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
      periodStart: "2026-06-07", periodEnd: "2026-06-13", payDate: "2026-06-19",
      runType: "supplemental",
    });
    await line(fx, run6.documentId, fx.bonusComponentId, "10.00");
    await assert.rejects(
      calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run6.documentId }),
      /still draft — commit .* first \(or discard it\), so the period builds in pay-date order/,
    );
  } finally {
    await dropScratchOrgReporting(fx.orgId);
  }
});

test("alternative: period-cumulative income tax folds the period into one pay", { skip: !DB }, async () => {
  const fx = await payrollOrg("period_cumulative");
  try {
    const run1 = await createPayRun({
      orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
      periodStart: "2026-06-07", periodEnd: "2026-06-13", payDate: "2026-06-13",
      runType: "supplemental",
    });
    await line(fx, run1.documentId, fx.bonusComponentId, "4000.00");
    assert.deepEqual((await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run1.documentId })).errors, []);
    const split1 = await taxSplit(fx, run1.documentId);
    await commitPayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run1.documentId });
    for (const day of ["2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11"]) {
      await seedPayrollTime(fx.orgId, fx.worker, fx.actorId, {
        workedOn: day, hours: "8", projectId: null, status: "approved",
        isBillable: false, billingStatus: "unbilled", costingBasis: "actual",
      });
    }
    const run2 = await createPayRun({
      orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
      periodStart: "2026-06-07", periodEnd: "2026-06-13", payDate: "2026-06-16",
      runType: "regular",
    });
    await line(fx, run2.documentId, fx.benInsComponentId, "188.16");
    await line(fx, run2.documentId, fx.benNinsComponentId, "5.61");
    assert.deepEqual((await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run2.documentId })).errors, []);
    // Contributions stay period-cumulative under either tax method.
    assert.equal(await stubLine(fx, run2.documentId, "cpp"), "59.1200");
    assert.equal(await stubLine(fx, run2.documentId, "ei"), "16.1100");
    // The period's 4,993.77 as one periodic pay prices far above two own-pay
    // shares — which is why it is the opt-in, not the default. The stub
    // traces the combined pay's shares; run 2's net is the combined share
    // minus what run 1 already withheld.
    const combined = await taxSplit(fx, run2.documentId);
    assert.equal(combined.federal - split1.federal, 28531n);
    assert.equal(combined.provincial - split1.provincial, 19777n);
    assert.equal(await stubLine(fx, run2.documentId, "income_tax"), "483.0800");
  } finally {
    await dropScratchOrgReporting(fx.orgId);
  }
});

test('separate payments round EI independently while sharing the CPP exemption', { skip: !DB }, async () => {
  for (const method of ['per_run', 'period_cumulative'] as const) {
    const fx = await payrollOrg(method);
    try {
      const first = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: '2025-12-28', periodEnd: '2026-01-03', payDate: '2026-01-08', runType: 'supplemental',
      });
      await line(fx, first.documentId, fx.bonusComponentId, '312.00');
      assert.deepEqual((await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: first.documentId })).errors, []);
      assert.equal(await stubLine(fx, first.documentId, 'cpp'), '14.5600');
      assert.equal(await stubLine(fx, first.documentId, 'ei'), '5.0900');
      await commitPayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: first.documentId });
      const second = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: '2025-12-28', periodEnd: '2026-01-03', payDate: '2026-01-09', runType: 'regular',
      });
      await line(fx, second.documentId, fx.bonusComponentId, '858.00');
      await line(fx, second.documentId, fx.benNinsComponentId, '5.61');
      assert.deepEqual((await calculatePayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: second.documentId })).errors, []);
      assert.equal(await stubLine(fx, second.documentId, 'cpp'), '51.3800');
      // 858 × 1.63% = 13.9854, rounded to 13.99 on this payment. Rounding
      // both payments together and subtracting 5.09 incorrectly yields 13.98.
      assert.equal(await stubLine(fx, second.documentId, 'ei'), '13.9900');
      assert.equal(await stubFactor(fx, second.documentId, 'EI_ER'), '19.5900');
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  }
});
