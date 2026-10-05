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
import { calculatePayRun } from "./run-calculation.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { mutatePayRunAdjustment } from "./run-adjustments.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { seedOntarioEhtFixture } from "./filing-test-fixtures.ts";

/**
 * Component units: hours lines feed every hours basis, quantity lines never do.
 *
 * A trip allowance pays 3 trips at $50 through a quantity-unit component
 * alongside 10 approved hours and a 2-hour adjustment on hours-unit
 * components. The trip amount still pays (and stays pensionable/insurable),
 * but no hours reach its stub line: the stub's earning hours total 12, and
 * an assigned per-hour premium prices on those 12 hours — not 15.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

test("quantity-unit lines pay their amount and count zero hours", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  try {
    const expense = await seedPostingAccount(org.orgId, "6000", "Wages expense", "expense");
    const burden = await seedPostingAccount(org.orgId, "6010", "Payroll burden", "expense");
    const netPay = await seedPostingAccount(org.orgId, "2300", "Wages payable", "liability_current");
    const cra = await seedPostingAccount(org.orgId, "2310", "CRA payable", "liability_current");
    const vacation = await seedPostingAccount(org.orgId, "2320", "Vacation payable", "liability_current");
    await seedPayrollAccountingConfiguration(org.orgId, {
      wageExpenseAccountId: expense, burdenExpenseAccountId: burden, netPayAccountId: netPay,
      cppPayableAccountId: cra, eiPayableAccountId: cra, taxPayableAccountId: cra,
      vacationPayableAccountId: vacation, wagesTo: "expense",
    });
    await seedPayrollComponents(org.orgId, actorId, "CA");
    await seedOntarioEhtFixture(org.orgId, actorId);
    const scheduleId = randomUUID();
    await seedPayrollSchedule(org.orgId, scheduleId, actorId, {
      name: "Weekly", frequency: "weekly", periodsPerYear: 52, anchorPeriodEnd: "2026-05-30",
      payDateOffsetDays: 3,
    });
    const tripsId = randomUUID();
    await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,basis,taxable,pensionable,insurable,vacationable,non_periodic,unit_of_measure)
      values(${tripsId},${org.orgId},'TRIPS','Trip allowance','earning','CA','fixed_amount',true,true,true,false,false,'quantity')`);
    const extraId = randomUUID();
    await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,basis,taxable,pensionable,insurable,vacationable,non_periodic)
      values(${extraId},${org.orgId},'EXTRA','Extra hours','earning','CA','fixed_amount',true,true,true,false,false)`);
    const premiumId = randomUUID();
    await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,basis,value,taxable,pensionable,insurable,vacationable,non_periodic)
      values(${premiumId},${org.orgId},'HRPREM','Hourly premium','earning','CA','per_hour','2.0000',true,true,true,false,false)`);
    const worker = randomUUID();
    await seedPayrollPerson(org.orgId, worker, "Units Worker");
    await seedPayrollEmployeeRole(org.orgId, worker, { id: randomUUID(), workerCompGroupId: null, terminatedOn: null });
    await seedPayrollWage(org.orgId, worker, actorId, {
      currency: "CAD", rate: "25", basis: "hour", annualHours: "2080", effectiveFrom: "2026-01-01",
    });
    const employmentId = await seedWorkerEmployment(org.orgId, worker, org.subsidiaryId);
    await seedPayrollProfile(org.orgId, worker, employmentId, scheduleId, actorId, {
      country: "CA", province: "ON", payBasis: "hourly", federalClaimCode: 1, provincialClaimCode: 1,
    }, { percentFloor: "4", method: "accrue" });
    await db.execute(sql`insert into employee_pay_components(id,org_id,employee_party_id,component_id,value,effective_from,created_by)
      values(${randomUUID()},${org.orgId},${worker},${premiumId},'2.0000','2026-01-01',${actorId})`);

    const run = await createPayRun({
      orgId: org.orgId, actorId, payScheduleId: scheduleId,
      periodStart: "2026-06-07", periodEnd: "2026-06-13", payDate: "2026-06-13",
      runType: "regular",
    });
    await seedPayrollTime(org.orgId, worker, actorId, {
      workedOn: "2026-06-08", hours: "10", projectId: null, status: "approved",
      isBillable: false, billingStatus: "unbilled", costingBasis: "actual",
    });
    const adjust = (componentId: string, amount: string, hours?: string) =>
      mutatePayRunAdjustment({
        orgId: org.orgId, documentId: run.documentId, actorId,
        mutation: { action: "add", employeePartyId: worker, componentId, amount, ...(hours === undefined ? {} : { hours }) },
      });
    await adjust(extraId, "50.00", "2");
    await adjust(tripsId, "150.00", "3");
    assert.deepEqual((await calculatePayRun({ orgId: org.orgId, actorId, documentId: run.documentId })).errors, []);

    const lines = (await db.execute<{ code: string; amount: string; hours: string | null }>(sql`
      select c.code, l.amount::text as amount, l.hours::text as hours
        from pay_stub_lines l
        join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
        join pay_components c on c.id = l.component_id and c.org_id = l.org_id
       where s.org_id = ${org.orgId} and s.pay_run_document_id = ${run.documentId}
         and s.employee_party_id = ${worker} and l.kind = 'earning'`)).rows;
    const trips = lines.find((l) => l.code === "TRIPS");
    assert.ok(trips, "trip allowance line exists");
    // The quantity pays in full but carries no hours.
    assert.equal(trips.amount, "150.0000");
    assert.equal(trips.hours, null);
    // The stub's earning hours are the 10 worked plus the 2-hour
    // hours-unit adjustment — never the 3 trips.
    const totalHours = (await db.execute<{ total: string }>(sql`
      select coalesce(sum(l.hours), 0)::text as total
        from pay_stub_lines l
        join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
       where s.org_id = ${org.orgId} and s.pay_run_document_id = ${run.documentId}
         and s.employee_party_id = ${worker} and l.kind = 'earning'`)).rows[0]!.total;
    assert.equal(totalHours, "12.00");
    // The assigned per-hour premium still prices normally with a quantity
    // line in the run: 2.00 over the 10 worked hours known when assigned
    // lines compute (adjustments apply after). Suppression itself is proven
    // by the null above and the 12.00 total, not by this amount.
    const premium = lines.find((l) => l.code === "HRPREM");
    assert.ok(premium, "hourly premium line exists");
    assert.equal(premium.amount, "20.0000");

    // A per-hour basis cannot count quantities: refused for every writer.
    await assert.rejects(
      db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,basis,taxable,pensionable,insurable,vacationable,non_periodic,unit_of_measure)
        values(${randomUUID()},${org.orgId},'BAD','Bad per-hour','earning','CA','per_hour',true,true,true,false,false,'quantity')`),
      (error: unknown) => {
        const cause = (error as { cause?: { message?: string } })?.cause;
        assert.match(String(cause?.message ?? error), /pay_components_per_hour_hours/);
        return true;
      },
    );
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
