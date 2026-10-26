import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id, orgRef } from "./helpers";
import { payrollOpeningLevySourceAuthorities } from "./payroll-opening-levy-source-authority";
import { payrollOpeningEmployerAuthorities } from "./payroll-opening-employer-authority";
import { files, fileVersions } from "./file-cabinet";
import { parties } from "./parties";
import { subsidiaries } from "./subsidiaries";
import { users } from "./extension";
import { currencies } from "./core";

/** Source-attested original Canadian reporting slices; posted amounts are never rewritten. */
export const payrollCaOpeningReportingAuthorities = pgTable(
  "payroll_ca_opening_reporting_authorities",
  {
    id: id(),
    orgId: orgRef(),
    openingBalanceId: uuid("opening_balance_id").notNull(),
    levyAuthorityId: uuid("levy_authority_id").notNull(),
    employerAuthorityId: uuid("employer_authority_id").notNull(),
    levyAllocationSha256: text("levy_allocation_sha256").notNull(),
    employeePartyId: uuid("employee_party_id").notNull(),
    taxYear: integer("tax_year").notNull(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    originalCountry: text("original_country").notNull(),
    originalCurrency: text("original_currency")
      .notNull()
      .references(() => currencies.code),
    coverageStart: date("coverage_start").notNull(),
    coverageEnd: date("coverage_end").notNull(),
    sourceFileId: uuid("source_file_id")
      .notNull()
      .references(() => files.id),
    sourceVersionId: uuid("source_version_id")
      .notNull()
      .references(() => fileVersions.id),
    sourceSha256: text("source_sha256").notNull(),
    sourceReference: text("source_reference").notNull(),
    openingSha256: text("opening_sha256").notNull(),
    openingSnapshot: jsonb("opening_snapshot").$type<Record<string, unknown>>().notNull(),
    openingChildrenSha256: text("opening_children_sha256").notNull(),
    openingChildrenSnapshot: jsonb("opening_children_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    annualAmounts: jsonb("annual_amounts").$type<Record<string, string>>().notNull(),
    allocationSnapshot: jsonb("allocation_snapshot").$type<unknown[]>().notNull(),
    allocationSha256: text("allocation_sha256").notNull(),
    requestId: uuid("request_id").notNull(),
    requestSha256: text("request_sha256").notNull(),
    changeReason: text("change_reason").notNull(),
    sealed: boolean("sealed").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
  },
  (t) => [
    uniqueIndex("payroll_ca_opening_reporting_authorities_org_id_unique").on(t.orgId, t.id),
    uniqueIndex("payroll_ca_opening_reporting_authorities_levy_unique").on(
      t.orgId,
      t.levyAuthorityId,
    ),
    uniqueIndex("payroll_ca_opening_reporting_authorities_request_unique").on(t.orgId, t.requestId),
    index("payroll_ca_opening_reporting_authorities_scope").on(
      t.orgId,
      t.subsidiaryId,
      t.taxYear,
      t.employeePartyId,
    ),
    foreignKey({
      name: "payroll_ca_opening_reporting_authorities_levy_fk",
      columns: [t.orgId, t.levyAuthorityId],
      foreignColumns: [
        payrollOpeningLevySourceAuthorities.orgId,
        payrollOpeningLevySourceAuthorities.id,
      ],
    }),
    foreignKey({
      name: "payroll_ca_opening_reporting_authorities_employer_fk",
      columns: [t.orgId, t.employerAuthorityId],
      foreignColumns: [
        payrollOpeningEmployerAuthorities.orgId,
        payrollOpeningEmployerAuthorities.id,
      ],
    }),
    foreignKey({
      name: "payroll_ca_opening_reporting_authorities_opening_fk",
      columns: [t.orgId, t.openingBalanceId],
      foreignColumns: [
        payrollOpeningEmployerAuthorities.orgId,
        payrollOpeningEmployerAuthorities.openingBalanceId,
      ],
    }),
    foreignKey({
      name: "payroll_ca_opening_reporting_authorities_employee_fk",
      columns: [t.orgId, t.employeePartyId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    foreignKey({
      name: "payroll_ca_opening_reporting_authorities_subsidiary_fk",
      columns: [t.orgId, t.subsidiaryId],
      foreignColumns: [subsidiaries.orgId, subsidiaries.id],
    }),
    foreignKey({
      name: "payroll_ca_opening_reporting_authorities_source_version_fk",
      columns: [t.sourceFileId, t.sourceVersionId],
      foreignColumns: [fileVersions.fileId, fileVersions.id],
    }),
    check(
      "payroll_ca_opening_reporting_authorities_country",
      sql`${t.originalCountry} = 'CA' and ${t.originalCurrency} = 'CAD'
    and ${t.coverageStart} = make_date(${t.taxYear},1,1) and ${t.coverageEnd} >= ${t.coverageStart}
    and ${t.coverageEnd} <= make_date(${t.taxYear},12,31)`,
    ),
    check(
      "payroll_ca_opening_reporting_authorities_evidence",
      sql`
    ${t.sourceSha256} ~ '^[a-f0-9]{64}$' and ${t.openingSha256} ~ '^[a-f0-9]{64}$'
    and ${t.openingChildrenSha256} ~ '^[a-f0-9]{64}$' and ${t.levyAllocationSha256} ~ '^[a-f0-9]{64}$'
    and ${t.allocationSha256} ~ '^[a-f0-9]{64}$' and ${t.requestSha256} ~ '^[a-f0-9]{64}$'
    and jsonb_typeof(${t.openingSnapshot}) = 'object' and jsonb_typeof(${t.openingChildrenSnapshot}) = 'object'
    and jsonb_typeof(${t.annualAmounts}) = 'object' and jsonb_typeof(${t.allocationSnapshot}) = 'array'
    and length(btrim(${t.sourceReference})) between 1 and 2000 and length(btrim(${t.changeReason})) between 1 and 2000`,
    ),
  ],
);

export const payrollCaOpeningReportingAllocations = pgTable(
  "payroll_ca_opening_reporting_allocations",
  {
    id: id(),
    orgId: orgRef(),
    authorityId: uuid("authority_id").notNull(),
    filingAccountId: uuid("filing_account_id").notNull(),
    province: text("province").notNull(),
    sourceOrdinal: integer("source_ordinal").notNull(),
    firstCoveredPayDate: date("first_covered_pay_date").notNull(),
    annualAmounts: jsonb("annual_amounts").$type<Record<string, string>>().notNull(),
    reportableBases: jsonb("reportable_bases")
      .$type<{ ei: string; cpp: string; qpip: string }>()
      .notNull(),
    children: jsonb("children").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
  },
  (t) => [
    uniqueIndex("payroll_ca_opening_reporting_allocations_scope_unique").on(
      t.orgId,
      t.authorityId,
      t.filingAccountId,
      t.province,
    ),
    uniqueIndex("payroll_ca_opening_reporting_allocations_order_unique").on(
      t.orgId,
      t.authorityId,
      t.sourceOrdinal,
    ),
    foreignKey({
      name: "payroll_ca_opening_reporting_allocations_authority_fk",
      columns: [t.orgId, t.authorityId],
      foreignColumns: [
        payrollCaOpeningReportingAuthorities.orgId,
        payrollCaOpeningReportingAuthorities.id,
      ],
    }),
    check(
      "payroll_ca_opening_reporting_allocations_facts",
      sql`${t.sourceOrdinal} > 0
    and ${t.province} in ('AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT','ZZ')
    and jsonb_typeof(${t.annualAmounts}) = 'object' and jsonb_typeof(${t.reportableBases}) = 'object' and jsonb_typeof(${t.children}) = 'object'`,
    ),
  ],
);
