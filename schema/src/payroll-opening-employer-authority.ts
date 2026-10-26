import { sql } from "drizzle-orm";
import {
  check,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  integer,
} from "drizzle-orm/pg-core";
import { id, orgRef } from "./helpers";
/** Source-qualified employer ownership preserves the original opening amounts. */
export const payrollOpeningEmployerAuthorities = pgTable(
  "payroll_opening_employer_authorities",
  {
    id: id(),
    orgId: orgRef(),
    openingBalanceId: uuid("opening_balance_id").notNull(),
    employeePartyId: uuid("employee_party_id").notNull(),
    taxYear: integer("tax_year").notNull(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    sourceFileId: uuid("source_file_id").notNull(),
    sourceVersionId: uuid("source_version_id").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    sourceReference: text("source_reference").notNull(),
    changeReason: text("change_reason").notNull(),
    openingSnapshot: jsonb("opening_snapshot").notNull(),
    openingSha256: text("opening_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("payroll_opening_employer_authorities_org_id_unique").on(t.orgId, t.id),
    uniqueIndex("payroll_opening_employer_authorities_opening_unique").on(
      t.orgId,
      t.openingBalanceId,
    ),
    check(
      "payroll_opening_employer_authorities_source",
      sql`${t.sourceSha256}~'^[a-f0-9]{64}$' and ${t.openingSha256}~'^[a-f0-9]{64}$'
  and length(btrim(${t.sourceReference})) between 1 and 2000 and length(btrim(${t.changeReason})) between 1 and 2000`,
    ),
    check(
      "payroll_opening_employer_authorities_snapshot",
      sql`jsonb_typeof(${t.openingSnapshot})='object'`,
    ),
  ],
);
