import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../platform/db.ts';
import { setupHarness, seedEmployment } from './hrm-harness.ts';
import { seedPayrollSchedule, seedPayrollProfile, type ScratchOrg } from './fixtures.ts';
import { saveOpeningBalances } from '../payroll/opening-balances.ts';
import { CA_PERIOD_OPENING_TREATMENT } from '../payroll/canada/period-openings.ts';

const spec = { features: ['payroll', 'hrm'], country: 'CA', users: [
  { key: 'authorId', name: 'Payroll operator', handle: 'period_opening_author', permissions: ['payroll.manage', 'payroll.read'], link: true },
  { key: 'readerId', name: 'Payroll reviewer', handle: 'period_opening_reader', permissions: ['payroll.read'], link: true },
] } as const;
export async function setupPeriodOpeningFixture() {
  return setupHarness(spec, async ({ org, authorId }) => {
    const scheduleId = randomUUID();
    await seedPayrollSchedule(org.orgId, scheduleId, authorId, { name: 'Weekly', frequency: 'weekly', periodsPerYear: 52, anchorPeriodEnd: '2026-01-03', payDateOffsetDays: 6 });
    return { scheduleId, ...await seedPeriodOpeningEmployee(org, authorId, scheduleId) };
  });
}

/** Every subject has its own employment, annual carry-in and admitted revision. */
export async function seedPeriodOpeningEmployee(org: ScratchOrg, authorId: string, scheduleId: string) {
  const worker = await seedEmployment(org.orgId, org.subsidiaryId, { from: '2025-12-01' });
  await db.execute(sql`update parties set subsidiary_id=${org.subsidiaryId} where org_id=${org.orgId} and id=${worker.workerPartyId}`);
  await seedPayrollProfile(org.orgId, worker.workerPartyId, worker.employmentId, scheduleId, authorId, { country: 'CA', province: 'ON', payBasis: 'hourly' });
  await saveOpeningBalances({ orgId: org.orgId, actorId: authorId, taxYear: 2026,
    rows: [{ employeePartyId: worker.workerPartyId, amounts: { pensionableYtd: '262.77', insurableYtd: '262.77', taxableYtd: '262.77', cppYtd: '11.63', eiYtd: '4.28' } }], allowedSubsidiaryIds: null });
  const annual = (await db.execute<{ updated_at: string }>(sql`select updated_at::text as updated_at from payroll_opening_balances
    where org_id=${org.orgId} and employee_party_id=${worker.workerPartyId} and tax_year=2026`)).rows[0]!;
  const amounts = Object.fromEntries(CA_PERIOD_OPENING_TREATMENT.fields.map((field) => [field.key, '0']));
  Object.assign(amounts, { pensionable: '262.77', insurable: '262.77', periodicIncome: '262.77', cpp: '11.63', ei: '4.28', enhancedCppPeriodic: '1.95' });
  return { ...worker, annualVersion: annual.updated_at, amounts };
}
export type PeriodOpeningFixture = Awaited<ReturnType<typeof setupPeriodOpeningFixture>>;
export function periodOpeningInput(f: PeriodOpeningFixture) {
  return { orgId: f.org.orgId, actorId: f.authorId, employeePartyId: f.workerPartyId, taxYear: 2026,
    subsidiaryId: f.org.subsidiaryId, payScheduleId: f.scheduleId, country: 'CA', currency: 'CAD',
    periodStart: '2025-12-28', periodEnd: '2026-01-03', paidThrough: '2026-01-08', amounts: f.amounts,
    sourceReference: 'Verified previous-provider payment register', reason: 'Record the paid period share within annual carry-in',
    expectedRevision: null, expectedAnnualUpdatedAt: f.annualVersion, dryRun: false, allowedSubsidiaryIds: null };
}
