import { date, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, orgRef } from './helpers';

/** A paid-period share of the existing annual carry-in, with its source evidence. */
export const payrollPeriodOpenings = pgTable('payroll_period_openings', {
  id: id(), orgId: orgRef(), employeePartyId: uuid('employee_party_id').notNull(),
  annualOpeningBalanceId: uuid('annual_opening_balance_id').notNull(),
  subsidiaryId: uuid('subsidiary_id').notNull(), payScheduleId: uuid('pay_schedule_id').notNull(),
  country: text('country').notNull(), currency: text('currency').notNull(), taxYear: integer('tax_year').notNull(),
  periodStart: date('period_start').notNull(), periodEnd: date('period_end').notNull(), paidThrough: date('paid_through').notNull(),
  amounts: jsonb('amounts').$type<Record<string, string>>().notNull(),
  /** Derived bounds are checked against the authoritative annual columns. */
  annualBounds: jsonb('annual_bounds').$type<Record<string, string>>().notNull(),
  contractHash: text('contract_hash').notNull(), revision: integer('revision').notNull().default(1),
  sourceReference: text('source_reference').notNull(), reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), createdBy: uuid('created_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(), updatedBy: uuid('updated_by').notNull(),
}, (t) => [uniqueIndex('payroll_period_openings_org_employee_year').on(t.orgId, t.employeePartyId, t.taxYear)]);
