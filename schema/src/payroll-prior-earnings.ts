import { date, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { auditColumns, id, orgRef } from './helpers';

/** Dated pre-adoption wages support statutory lookbacks without another payment. */
export const payrollPriorEarnings = pgTable('payroll_prior_earnings', {
  id: id(), orgId: orgRef(), employeePartyId: uuid('employee_party_id').notNull(),
  subsidiaryId: uuid('subsidiary_id').notNull(), country: text('country').notNull(), currency: text('currency').notNull(),
  historyFrom: date('history_from').notNull(), historyThrough: date('history_through').notNull(),
  periods: jsonb('periods').$type<{
    from: string; through: string; sourceReference: string;
    lines: { sourceKey: string; sourceLabel: string; earnedFrom: string; earnedThrough: string; bucket: string; amount: string }[];
  }[]>().notNull(),
  sourceFileId: uuid('source_file_id').notNull(), sourceVersionId: uuid('source_version_id').notNull(),
  sourceHash: text('source_hash').notNull(), sourceReference: text('source_reference').notNull(),
  contentHash: text('content_hash').notNull(), reason: text('reason').notNull(),
  revision: integer('revision').notNull().default(1), ...auditColumns,
}, (t) => [uniqueIndex('payroll_prior_earnings_org_id_id').on(t.orgId, t.id),
  uniqueIndex('payroll_prior_earnings_employee_employer').on(t.orgId, t.employeePartyId, t.subsidiaryId)]);
