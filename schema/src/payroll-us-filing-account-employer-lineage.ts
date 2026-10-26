import { sql } from "drizzle-orm";
import { check, date, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/** Original state-registration ownership, resolved at each payroll source date. */
export const payrollUsFilingAccountEmployerLineage = pgTable(
  "payroll_us_filing_account_employer_lineage",
  {
    id: id(),
    orgId: orgRef(),
    filingAccountId: uuid("filing_account_id").notNull(),
    federalAccountId: uuid("federal_account_id").notNull(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    sourceReference: text("source_reference").notNull(),
    changeReason: text("change_reason").notNull(),
    ...auditColumns,
    createdBy: uuid("created_by").notNull(),
    updatedBy: uuid("updated_by").notNull(),
  },
  (t) => [
    uniqueIndex("payroll_us_filing_account_employer_lineage_org_id_unique").on(t.orgId, t.id),
    check(
      "payroll_us_filing_account_employer_lineage_dates",
      sql`${t.effectiveTo} is null or ${t.effectiveFrom} <= ${t.effectiveTo}`,
    ),
    check(
      "payroll_us_filing_account_employer_lineage_source",
      sql`length(btrim(${t.sourceReference})) between 1 and 2000 and length(btrim(${t.changeReason})) between 1 and 2000`,
    ),
  ],
);
