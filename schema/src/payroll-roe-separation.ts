import { sql } from 'drizzle-orm';
import { check, date, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { auditColumns, id, orgRef } from './helpers';

/** Employer declarations bind each interruption to its native employment and source. */
export const payrollRoeSeparationEvents = pgTable('payroll_roe_separation_events', {
  id: id(), orgId: orgRef(), employeePartyId: uuid('employee_party_id').notNull(),
  employmentId: uuid('employment_id'), subsidiaryId: uuid('subsidiary_id'),
  firstDayWorked: date('first_day_worked'), interruptionOn: date('interruption_on').notNull(),
  lastInsurableEarningsOn: date('last_insurable_earnings_on').notNull(),
  salaryContinuanceEndOn: date('salary_continuance_end_on'), sourceReference: text('source_reference'),
  status: text('status', { enum: ['draft', 'confirmed', 'issued', 'cancelled'] }).notNull().default('draft'),
  changeReason: text('change_reason').notNull(), ...auditColumns,
}, t => [uniqueIndex('payroll_roe_separation_events_org_id_unique').on(t.orgId, t.id),
  index('payroll_roe_separation_events_employee_date').on(t.orgId, t.employeePartyId, t.interruptionOn.desc()),
  uniqueIndex('payroll_roe_separation_events_one_open_per_employee').on(t.orgId,t.employeePartyId).where(sql`${t.status} in ('draft','confirmed')`),
  check('payroll_roe_separation_events_status',sql`${t.status} in ('draft','confirmed','issued','cancelled')`),
  check('payroll_roe_separation_events_reason',sql`length(btrim(${t.changeReason})) > 0`),
  check('payroll_roe_separation_events_dates',sql`${t.lastInsurableEarningsOn} <= ${t.interruptionOn} and (${t.salaryContinuanceEndOn} is null or (${t.salaryContinuanceEndOn} >= ${t.lastInsurableEarningsOn} and ${t.salaryContinuanceEndOn} <= ${t.interruptionOn}))`),
  check('payroll_roe_separation_events_employer_pair',sql`(${t.employmentId} is null) = (${t.subsidiaryId} is null)`),
  check('payroll_roe_separation_events_first_worked',sql`${t.firstDayWorked} is null or ${t.firstDayWorked} <= ${t.lastInsurableEarningsOn}`),
  check('payroll_roe_separation_events_source_reference',sql`${t.sourceReference} is null or length(btrim(${t.sourceReference})) between 1 and 2000`)]);
