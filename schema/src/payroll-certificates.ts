import { sql } from "drizzle-orm";
import { check, date, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * An employee's answers on a PACK-DECLARED tax certificate — the form they file
 * to set their own withholding.
 *
 * The shape this replaces was flat columns on `employee_payroll_profiles`:
 * `federal_claim_code`, `filing_status`, `multiple_jobs`, `w4_allowances`,
 * `dependent_credits` … two jurisdictions' forms fused into one row. It does
 * not extend. The fifty-first column would be `il_line_2_allowances` and the
 * hundredth `ny_yonkers_allowances`, every one of them null for 98% of
 * employees, every one requiring a migration, an API change and a UI edit
 * before a state could be turned on.
 *
 * So the pack DECLARES its certificates with typed fields
 * (engine/src/payroll/certificates.ts) and the answers are stored here, against
 * a declared certificate. Adding California is adding a declaration.
 *
 * Effective-dated: a superseded certificate stays on file, because re-running a
 * prior period must calculate against the form that was actually in force then,
 * not the one that replaced it.
 *
 * `certificate_key`, `region` and `sub_region` are deliberately OPEN text and
 * not enums: the pack registry is open, and a CHECK naming one country's forms
 * would make a registered pack's certificates unrepresentable. The declaration
 * is the constraint, enforced at the API boundary.
 *
 * The federal W-4 and the Canadian TD1 family are NOT here. They declare
 * `storage: "profile_columns"` and still read from `employee_payroll_profiles`
 * through a field-level mapping, so the T4127, TP-1015 and Pub 15-T conformance
 * goldens compute from exactly the numbers they always have. That migration
 * belongs to a pass whose only job is the migration.
 */
export const employeeTaxCertificates = pgTable(
  "employee_tax_certificates",
  {
    id: id(),
    orgId: orgRef(),
    employeePartyId: uuid("employee_party_id").notNull(),
    /** Country pack that declares the certificate. */
    country: text("country").notNull(),
    /** The pack's own certificate key ("us_ca_de4", "ca_td1_ON"). */
    certificateKey: text("certificate_key").notNull(),
    /** The region the certificate is filed for; null for a country-level form. */
    region: text("region"),
    /** The taxing unit below the region, for a sub-region-level form. */
    subRegion: text("sub_region"),
    /** { [fieldKey]: answer }, canonicalized to each field's declared kind. */
    answers: jsonb("answers").notNull().default({}),
    /** The date the employee signed it — the effective date of the answers. */
    effectiveFrom: date("effective_from"),
    /** Set when a later certificate replaces it; the row is never deleted. */
    supersededOn: date("superseded_on"),
    ...auditColumns,
  },
  (t) => [
    // One CURRENT certificate per employee per jurisdiction point. Two would
    // make "what did this employee answer?" ambiguous, and an ambiguous
    // withholding election is wrong money that changes answer between queries.
    uniqueIndex("employee_tax_certificates_current")
      .on(
        t.orgId, t.employeePartyId, t.certificateKey,
        sql`coalesce(region, '')`, sql`coalesce(sub_region, '')`,
      )
      .where(sql`superseded_on is null`),
    index("employee_tax_certificates_employee").on(t.orgId, t.employeePartyId, t.country),
    check("employee_tax_certificates_answers", sql`jsonb_typeof(${t.answers}) = 'object'`),
    check("employee_tax_certificates_sub_region",
      sql`${t.subRegion} is null or ${t.region} is not null`),
    check("employee_tax_certificates_dates",
      sql`${t.supersededOn} is null or ${t.effectiveFrom} is null
          or ${t.supersededOn} >= ${t.effectiveFrom}`),
  ],
);

// Foreign keys are maintained in the migration (DEFERRABLE, per house rule).
