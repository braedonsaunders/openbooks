import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { currencies } from "./core";
import { id, orgRef } from "./helpers";
import { payrollOpeningEmployerAuthorities } from "./payroll-opening-employer-authority";

/** Sealed original-source allocations for statutory levy opening balances. */
export const payrollOpeningLevySourceAuthorities = pgTable(
  "payroll_opening_levy_source_authorities",
  {
    id: id(),
    orgId: orgRef(),
    openingBalanceId: uuid("opening_balance_id").notNull(),
    employerAuthorityId: uuid("employer_authority_id").notNull(),
    employeePartyId: uuid("employee_party_id").notNull(),
    taxYear: integer("tax_year").notNull(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    sourceFileId: uuid("source_file_id").notNull(),
    sourceVersionId: uuid("source_version_id").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    sourceReference: text("source_reference").notNull(),
    originalCountry: text("original_country").notNull(),
    originalCurrency: text("original_currency")
      .notNull()
      .references(() => currencies.code),
    coverageStart: date("coverage_start").notNull(),
    coverageEnd: date("coverage_end").notNull(),
    coverageComplete: boolean("coverage_complete").notNull(),
    changeReason: text("change_reason").notNull(),
    openingSha256: text("opening_sha256").notNull(),
    openingChildrenSnapshot: jsonb("opening_children_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    openingChildrenSha256: text("opening_children_sha256").notNull(),
    allocationSha256: text("allocation_sha256").notNull(),
    allocationSnapshot: jsonb("allocation_snapshot").$type<unknown[]>().notNull(),
    sealed: boolean("sealed").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
    supersedesAuthorityId: uuid("supersedes_authority_id"),
    requestId: uuid("request_id"),
    requestSha256: text("request_sha256"),
  },
  (t) => [
    uniqueIndex("payroll_opening_levy_source_authorities_org_id_unique").on(t.orgId, t.id),
    uniqueIndex("payroll_opening_levy_source_authorities_original_unique")
      .on(t.orgId, t.openingBalanceId)
      .where(sql`${t.supersedesAuthorityId} is null`),
    uniqueIndex("payroll_opening_levy_source_authorities_successor_unique")
      .on(t.orgId, t.supersedesAuthorityId)
      .where(sql`${t.supersedesAuthorityId} is not null`),
    uniqueIndex("payroll_opening_levy_source_authorities_request_unique")
      .on(t.orgId, t.requestId)
      .where(sql`${t.requestId} is not null`),
    foreignKey({
      name: "payroll_opening_levy_source_authorities_predecessor_fk",
      columns: [t.orgId, t.supersedesAuthorityId],
      foreignColumns: [t.orgId, t.id],
    }).onDelete("cascade"),
    check(
      "payroll_opening_levy_source_authorities_successor_request",
      sql`
    (${t.supersedesAuthorityId} is null and ${t.requestId} is null and ${t.requestSha256} is null)
    or (${t.supersedesAuthorityId} is not null and ${t.supersedesAuthorityId} <> ${t.id}
      and ${t.requestId} is not null and ${t.requestSha256} is not null and ${t.requestSha256} ~ '^[a-f0-9]{64}$')
  `,
    ),
    foreignKey({
      name: "payroll_opening_levy_source_authorities_parent_fk",
      columns: [t.orgId, t.openingBalanceId],
      foreignColumns: [
        payrollOpeningEmployerAuthorities.orgId,
        payrollOpeningEmployerAuthorities.openingBalanceId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "payroll_opening_levy_source_authorities_employer_authority_fk",
      columns: [t.orgId, t.employerAuthorityId],
      foreignColumns: [
        payrollOpeningEmployerAuthorities.orgId,
        payrollOpeningEmployerAuthorities.id,
      ],
    }).onDelete("cascade"),
    check(
      "payroll_opening_levy_source_authorities_facts",
      sql`
    ${t.originalCountry} ~ '^[A-Z]{2}$' and ${t.originalCurrency} ~ '^[A-Z]{3}$'
    and (${t.originalCountry} <> 'CA' or ${t.originalCurrency} = 'CAD')
    and (${t.originalCountry} <> 'US' or ${t.originalCurrency} = 'USD')
    and ${t.coverageComplete} and ${t.coverageEnd} >= ${t.coverageStart}
    and ${t.coverageEnd} < ${t.coverageStart} + interval '1 year'
    and extract(year from ${t.coverageStart}) in (${t.taxYear}, ${t.taxYear} - 1)
    and (${t.originalCountry} not in ('CA','US') or
      (${t.coverageStart} = make_date(${t.taxYear},1,1) and ${t.coverageEnd} <= make_date(${t.taxYear},12,31)))
  `,
    ),
    check(
      "payroll_opening_levy_source_authorities_source",
      sql`
    ${t.sourceSha256} ~ '^[a-f0-9]{64}$' and ${t.openingSha256} ~ '^[a-f0-9]{64}$'
    and ${t.allocationSha256} ~ '^[a-f0-9]{64}$' and ${t.openingChildrenSha256} ~ '^[a-f0-9]{64}$'
    and jsonb_typeof(${t.openingChildrenSnapshot}) = 'object'
    and length(btrim(${t.sourceReference})) between 1 and 2000
    and length(btrim(${t.changeReason})) between 1 and 2000
    and jsonb_typeof(${t.allocationSnapshot}) = 'array'
  `,
    ),
  ],
);

/** One exact programme, original jurisdiction and (for US bases) EIN carry-in. */
export const payrollOpeningLevySourceAllocations = pgTable(
  "payroll_opening_levy_source_allocations",
  {
    id: id(),
    orgId: orgRef(),
    authorityId: uuid("authority_id").notNull(),
    programKey: text("program_key").notNull(),
    region: text("region").notNull(),
    subRegion: text("sub_region").notNull().default(""),
    filingAccountId: uuid("filing_account_id"),
    federalAccountId: uuid("federal_account_id"),
    amount: numeric("amount", { precision: 19, scale: 4 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").notNull(),
  },
  (t) => [
    index("payroll_opening_levy_source_allocations_scope").on(
      t.orgId,
      t.programKey,
      t.region,
      t.filingAccountId,
      t.authorityId,
    ),
    uniqueIndex("payroll_opening_levy_source_allocations_unscoped_unique")
      .on(t.orgId, t.authorityId, t.programKey, t.region, t.subRegion, t.federalAccountId)
      // The native migration also enforces NULLS NOT DISTINCT for this scope;
      // the index builder describes its keys and partial predicate.
      .where(sql`${t.filingAccountId} is null`),
    uniqueIndex("payroll_opening_levy_source_allocations_account_unique")
      .on(
        t.orgId,
        t.authorityId,
        t.programKey,
        t.region,
        t.subRegion,
        t.filingAccountId,
        t.federalAccountId,
      )
      .where(sql`${t.filingAccountId} is not null`),
    foreignKey({
      name: "payroll_opening_levy_source_allocations_authority_fk",
      columns: [t.orgId, t.authorityId],
      foreignColumns: [
        payrollOpeningLevySourceAuthorities.orgId,
        payrollOpeningLevySourceAuthorities.id,
      ],
    }).onDelete("cascade"),
    check(
      "payroll_opening_levy_source_allocations_lineage",
      sql`
    (${t.programKey} in ('ca_wcb','ca_eht','ca_cnt') and ${t.federalAccountId} is null)
    or (${t.programKey} in ('us_futa','us_sui','us_pa_lst') and ${t.federalAccountId} is not null
      and (${t.programKey} <> 'us_futa' or ${t.federalAccountId} = ${t.filingAccountId}))
  `,
    ),
    check("payroll_opening_levy_source_allocations_amount", sql`${t.amount} >= 0`),
    check(
      "payroll_opening_levy_source_allocations_scope",
      sql`
    (${t.programKey} = 'ca_wcb' and ${t.region} in ('AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT')
      and ${t.subRegion} = '' and ${t.filingAccountId} is null)
    or (${t.programKey} = 'ca_eht' and ${t.region} in ('BC','MB','NL','ON')
      and ${t.subRegion} = '' and ${t.filingAccountId} is null)
    or (${t.programKey} = 'ca_cnt' and ${t.region} = 'QC'
      and ${t.subRegion} = '' and ${t.filingAccountId} is null)
    or (${t.programKey} = 'us_futa' and ${t.region} = 'US'
      and ${t.subRegion} = '' and ${t.filingAccountId} is not null)
    or (${t.programKey} = 'us_sui' and ${t.region} in ('AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY')
      and ${t.subRegion} = '')
    or (${t.programKey} = 'us_pa_lst' and ${t.region} = 'PA'
      and ${t.subRegion} ~ '^[0-9]{6}$' and ${t.filingAccountId} is null)
  `,
    ),
  ],
);
