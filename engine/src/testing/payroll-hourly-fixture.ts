import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  seedPayrollAccountingConfiguration, seedPayrollSchedule, seedPayrollEmployeeRole,
  seedPayrollPerson, seedPayrollProfile, seedPayrollWage, createScratchOrg,
  seedFlowActors, seedWorkerEmployment, seedPayrollTime,
} from "./fixtures.ts";
import { seedPayrollComponents } from "../payroll/run-setup.ts";
import { seedOntarioEhtFixture } from "../payroll/filing-test-fixtures.ts";

/** Native Ontario hourly employment with explicit posting and vacation policy. */
export interface HourlyPayrollFixture {
  orgId: string; subsidiaryId: string; actorId: string; scheduleId: string;
  accounts: { wageExpense: string; burdenExpense: string; netPayable: string; craPayable: string; vacationPayable: string; otherPayable: string };
}

async function account(orgId: string, number: string, name: string, type: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into accounts(id,org_id,number,name,type,is_active) values(${id},${orgId},${number},${name},${type},true)`);
  return id;
}

export async function seedHourlyPayrollOrg(): Promise<HourlyPayrollFixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const accounts = {
    wageExpense: await account(org.orgId, "6000", "Wages expense", "expense"),
    burdenExpense: await account(org.orgId, "6010", "Payroll burden", "expense"),
    netPayable: await account(org.orgId, "2300", "Wages payable", "liability_current"),
    craPayable: await account(org.orgId, "2310", "CRA payable", "liability_current"),
    vacationPayable: await account(org.orgId, "2320", "Vacation payable", "liability_current"),
    otherPayable: await account(org.orgId, "2330", "Other payable", "liability_current"),
  };
  await seedPayrollAccountingConfiguration(org.orgId, {
    wageExpenseAccountId: accounts.wageExpense,
    burdenExpenseAccountId: accounts.burdenExpense,
    netPayAccountId: accounts.netPayable,
    cppPayableAccountId: accounts.craPayable,
    eiPayableAccountId: accounts.craPayable,
    taxPayableAccountId: accounts.craPayable,
    vacationPayableAccountId: accounts.vacationPayable,
    wagesTo: "expense",
  });
  await seedPayrollComponents(org.orgId, actorId, "CA");
  await seedOntarioEhtFixture(org.orgId, actorId);
  const scheduleId = randomUUID();
  await seedPayrollSchedule(org.orgId, scheduleId, actorId, {
    name: 'Weekly', frequency: 'weekly', periodsPerYear: 52, anchorPeriodEnd: '2026-07-18',
    payDateOffsetDays: 3,
  });
  return { orgId: org.orgId, subsidiaryId: org.subsidiaryId, actorId, scheduleId, accounts };
}

export async function seedHourlyPayrollEmployee(fx: HourlyPayrollFixture, name: string, subsidiaryId: string | null = null): Promise<{ partyId: string; employmentId: string }> {
  const id = randomUUID();
  await seedPayrollPerson(fx.orgId, id, name, { subsidiaryId });
  await seedPayrollEmployeeRole(fx.orgId, id, { id: randomUUID(), workerCompGroupId: null, terminatedOn: null });
  await seedPayrollWage(fx.orgId, id, fx.actorId, {
    currency: "CAD", rate: "30", basis: "hour",
    annualHours: "2080", effectiveFrom: '2026-01-01',
  });
  const employmentId = await seedWorkerEmployment(fx.orgId, id, fx.subsidiaryId);
  await seedPayrollProfile(fx.orgId, id, employmentId, fx.scheduleId, fx.actorId, {
    country: 'CA', province: 'ON', payBasis: "hourly", federalClaimCode: 1,
    provincialClaimCode: 1,
  }, { percentFloor: "4", method: 'accrue' });
  return { partyId: id, employmentId };
}

/** Eight approved hourly earnings per declared work date. */
export async function seedHourlyPayrollTime(fx: HourlyPayrollFixture, partyId: string, days: readonly string[]): Promise<void> {
  for (const day of days) {
    await seedPayrollTime(fx.orgId, partyId, fx.actorId, {
      workedOn: day, hours: '8', projectId: null, status: 'approved', isBillable: false,
      billingStatus: 'unbilled', costingBasis: 'actual',
    });
  }
}
