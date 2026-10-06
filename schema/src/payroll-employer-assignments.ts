import { date, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { id, orgRef } from './helpers';

/** Explicit historical assignments override current settings only on their recorded dates. */
export const payrollEmployeeEmployerAssignments = pgTable('payroll_employee_employer_assignments', {
  id: id(), orgId: orgRef(), employeePartyId: uuid('employee_party_id').notNull(),
  subsidiaryId: uuid('subsidiary_id').notNull(), assignmentKind: text('assignment_kind').notNull(),
  taxYear: integer('tax_year').notNull(), effectiveFrom: date('effective_from').notNull(), effectiveTo: date('effective_to').notNull(),
  filingAccountId: uuid('filing_account_id'), workerCompGroupId: uuid('worker_comp_group_id'), expectedCurrentId: uuid('expected_current_id'),
  sourceReference: text('source_reference').notNull(), reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(), createdBy: uuid('created_by').notNull(),
});
