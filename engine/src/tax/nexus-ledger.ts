import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  buildFilingCalendar,
  type FilingFrequency,
  type FilingObligation,
} from "./nexus.ts";

/** Load the org's active registrations and expand them into filing obligations. */
export async function loadOrgFilingCalendar(
  orgId: string,
  rangeFrom: string,
  rangeTo: string,
): Promise<FilingObligation[]> {
  const rows = (await db.execute<{
    jurisdiction_id: string
    jurisdiction_name: string
    jurisdiction_code: string
    country: string
    filing_frequency: FilingFrequency
    return_form_code: string | null
    registration_number: string | null
    effective_from: string | null
    effective_to: string | null
  }>(sql`
    select r.jurisdiction_id, j.name as jurisdiction_name, j.code as jurisdiction_code,
           j.country, r.filing_frequency, r.return_form_code, r.registration_number,
           r.effective_from::text, r.effective_to::text
      from tax_registrations r
      join tax_jurisdictions j on j.id = r.jurisdiction_id and j.org_id = r.org_id
     where r.org_id = ${orgId} and r.is_active
  `));
  return buildFilingCalendar(
    rows.rows.map((r) => ({
      jurisdictionId: r.jurisdiction_id,
      jurisdictionName: r.jurisdiction_name,
      jurisdictionCode: r.jurisdiction_code,
      country: r.country,
      filingFrequency: r.filing_frequency,
      returnFormCode: r.return_form_code,
      registrationNumber: r.registration_number,
      effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to,
    })),
    rangeFrom,
    rangeTo,
  );
}

