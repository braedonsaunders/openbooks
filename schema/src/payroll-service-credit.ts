import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { auditColumns, id, orgRef } from './helpers';
/** Observed credited service advances without altering employment hire evidence. */
export const payrollServiceCredits = pgTable('payroll_service_credits', {
  id: id(), orgId: orgRef(), employmentId: uuid('employment_id').notNull(),
  convention: text('convention', { enum: ['calendar_months', 'actual_365'] }).notNull(),
  asOfDate: date('as_of_date').notNull(), creditedDays: numeric('credited_days', { precision: 30, scale: 16 }),
  creditedMonths: integer('credited_months'), effectiveFrom: date('effective_from').notNull(), effectiveTo: date('effective_to'),
  reason: text('reason').notNull(), sourceSnapshot: jsonb('source_snapshot').$type<Record<string, unknown>>().notNull().default({}), ...auditColumns,
}, (t) => [uniqueIndex('payroll_service_credits_org_id_id').on(t.orgId, t.id), index('payroll_service_credits_employment').on(t.orgId, t.employmentId, t.effectiveFrom),
  check('payroll_service_credits_shape', sql`(${t.convention} = 'calendar_months' and ${t.creditedMonths} is not null and ${t.creditedMonths} >= 0 and ${t.creditedDays} is null) or (${t.convention} = 'actual_365' and ${t.creditedDays} is not null and ${t.creditedDays} >= 0 and ${t.creditedMonths} is null)`),
  check('payroll_service_credits_range', sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`)]);

/** Effective-dated money rates and annual time allowances share the same service ladder. */
export const entitlementServiceTiers = pgTable('entitlement_service_tiers', {
  id: id(), orgId: orgRef(), planId: uuid('plan_id'), componentId: uuid('component_id'), employerSubsidiaryId: uuid('employer_subsidiary_id'),
  afterMonths: integer('after_months').notNull(), accrualValue: numeric('accrual_value', { precision: 19, scale: 4 }),
  eligible: boolean('eligible'), annualDays: numeric('annual_days', { precision: 12, scale: 4 }),
  effectiveFrom: date('effective_from').notNull().default('0001-01-01'), effectiveTo: date('effective_to'),
  isActive: boolean('is_active').notNull().default(true), ...auditColumns,
}, (t) => [index('entitlement_service_tiers_plan').on(t.orgId, t.planId, t.afterMonths),
  index('entitlement_service_tiers_component').on(t.orgId, t.componentId, t.afterMonths),
  check('entitlement_service_tiers_one_target', sql`num_nonnulls(${t.planId},${t.componentId}) = 1`),
  check('entitlement_service_tiers_days_target', sql`${t.annualDays} is null or ${t.planId} is not null`),
  check('entitlement_service_tiers_effective_range', sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`)]);

/** Employee vacation elections are independent of tax and bank-rail configuration. */
export const payrollVacationTerms = pgTable('payroll_vacation_terms', {
  id: id(), orgId: orgRef(), employmentId: uuid('employment_id').notNull(),
  planId: uuid('plan_id').notNull(),
  method: text('method', { enum: ['accrue', 'pay_each_period', 'paid_leave'] }).notNull(),
  percentFloor: numeric('percent_floor', { precision: 7, scale: 4 }), annualDaysFloor: numeric('annual_days_floor', { precision: 12, scale: 4 }),
  effectiveFrom: date('effective_from').notNull(), effectiveTo: date('effective_to'), reason: text('reason').notNull(),
  sourceSnapshot: jsonb('source_snapshot').$type<Record<string, unknown>>().notNull().default({}), ...auditColumns,
}, (t) => [uniqueIndex('payroll_vacation_terms_org_id_id').on(t.orgId, t.id), index('payroll_vacation_terms_employment').on(t.orgId, t.employmentId, t.effectiveFrom),
  check('payroll_vacation_terms_paid_leave', sql`${t.method} <> 'paid_leave' or ${t.percentFloor} is null or ${t.percentFloor} = 0`),
  check('payroll_vacation_terms_range', sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`)]);
