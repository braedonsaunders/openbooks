import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../../platform/db.ts";
import { PayrollError } from "../error.ts";
import { takeOpeningSourceYearFence } from "../../organization/payroll-source-fence.ts";
import {
  readEmployeeOpeningLevySources,
  type OriginalOpeningSourceChildren,
} from "../opening-levy-source-reader.ts";
import {
  canonicalCanadianOpeningReportingAllocations,
  type CanadianOpeningReportingAllocation,
} from "./opening-reporting-source.ts";
import { readCanadianOpeningReportingCatalogue } from "./opening-reporting-catalogue.ts";

export type CanadianOpeningReportingAuthority = {
  id: string;
  openingBalanceId: string;
  levyAuthorityId: string;
  levyAllocationSha256: string;
  employerAuthorityId: string;
  employeePartyId: string;
  taxYear: number;
  subsidiaryId: string;
  originalCountry: "CA";
  originalCurrency: "CAD";
  coverageStart: string;
  coverageEnd: string;
  openingSha256: string;
  openingChildrenSha256: string;
  allocationSha256: string;
  sourceFileId: string;
  sourceVersionId: string;
  sourceSha256: string;
  sourceReference: string;
};

export type CanadianOpeningReportingSource = {
  hasOpening: boolean;
  hasMaterialHistory: boolean;
  authority: CanadianOpeningReportingAuthority | null;
  annualAmounts: Record<string, string> | null;
  children: OriginalOpeningSourceChildren | null;
  allocations: CanadianOpeningReportingAllocation[];
};

const REFUSAL =
  "Qualify every original Canadian RP/province reporting allocation, source ordinal and first covered pay date in Payroll → Opening balances → Reporting source";
const RETAINED_REFUSAL =
  "The retained reporting certificate is immutable. Review the original evidence in Payroll → Opening balances → Levy source and use its governed original source certificate correction where permitted, then qualify fresh reporting allocations in Payroll → Opening balances → Reporting source. Issued-year restrictions and governed payroll void requirements still apply";

/** Resolve the reporting source only through the exact current levy certificate. */
export async function readEmployeeCanadianOpeningReportingSource(
  tx: SqlExecutor,
  input: {
    orgId: string;
    employeePartyId: string;
    taxYear: number;
    subsidiaryId?: string;
  },
): Promise<CanadianOpeningReportingSource> {
  await takeOpeningSourceYearFence(tx, input.orgId, input.taxYear);
  const original = await readEmployeeOpeningLevySources(tx, input);
  const empty: CanadianOpeningReportingSource = {
    hasOpening: original.hasOpening,
    hasMaterialHistory: original.hasMaterialHistory,
    authority: null,
    annualAmounts: null,
    children: null,
    allocations: [],
  };
  if (!original.authority || !original.facts || original.facts.originalCountry !== "CA")
    return empty;
  const rows = await tx.execute<
    CanadianOpeningReportingAuthority & {
      matches: boolean;
      annualAmounts: Record<string, string>;
      children: OriginalOpeningSourceChildren;
      allocationSnapshot: CanadianOpeningReportingAllocation[];
    }
  >(
    sql`
    select r.id,r.opening_balance_id as "openingBalanceId",r.levy_authority_id as "levyAuthorityId",
      r.levy_allocation_sha256 as "levyAllocationSha256",r.employer_authority_id as "employerAuthorityId",
      r.employee_party_id as "employeePartyId",r.tax_year as "taxYear",r.subsidiary_id as "subsidiaryId",
      r.original_country as "originalCountry",r.original_currency as "originalCurrency",
      r.coverage_start::text as "coverageStart",r.coverage_end::text as "coverageEnd",
      r.opening_sha256 as "openingSha256",r.opening_children_sha256 as "openingChildrenSha256",
      r.allocation_sha256 as "allocationSha256",r.source_file_id as "sourceFileId",r.source_version_id as "sourceVersionId",
      r.source_sha256 as "sourceSha256",r.source_reference as "sourceReference",r.annual_amounts as "annualAmounts",
      r.opening_children_snapshot as children,r.allocation_snapshot as "allocationSnapshot",
      (r.sealed and r.levy_authority_id=h.id and r.employer_authority_id=h.employer_authority_id
        and r.opening_balance_id=h.opening_balance_id and r.employee_party_id=h.employee_party_id and r.tax_year=h.tax_year
        and r.subsidiary_id=h.subsidiary_id and r.original_country=h.original_country and r.original_country='CA'
        and r.original_currency=h.original_currency and r.original_currency='CAD'
        and r.coverage_start=h.coverage_start and r.coverage_end=h.coverage_end and h.coverage_complete
        and r.levy_allocation_sha256=h.allocation_sha256
        and r.opening_snapshot=to_jsonb(b) and r.opening_sha256=h.opening_sha256
        and r.opening_sha256=encode(public.digest(r.opening_snapshot::text,'sha256'),'hex')
        and r.annual_amounts=public.payroll_ca_opening_reporting_annual(to_jsonb(b))
        and r.opening_children_snapshot=h.opening_children_snapshot and r.opening_children_sha256=h.opening_children_sha256
        and r.opening_children_sha256=encode(public.digest(r.opening_children_snapshot::text,'sha256'),'hex')
        and r.allocation_snapshot=public.payroll_ca_opening_reporting_allocations_snapshot(r.org_id,r.id)
        and r.allocation_sha256=encode(public.digest(r.allocation_snapshot::text,'sha256'),'hex')
        and exists (select 1 from files f join file_versions v on v.file_id=f.id
          where f.org_id=r.org_id and f.id=r.source_file_id and v.id=r.source_version_id and v.content_hash=r.source_sha256)) as matches
      from payroll_ca_opening_reporting_authorities r
      join payroll_opening_levy_source_authorities h on h.org_id=r.org_id and h.id=r.levy_authority_id
      join payroll_opening_balances b on b.org_id=r.org_id and b.id=r.opening_balance_id
     where r.org_id=${input.orgId} and r.levy_authority_id=${original.authority.authorityId}
     for share of r,h,b
  `,
    "objects",
  );
  if (!rows.length && !original.hasMaterialHistory) return empty;
  if (rows.length !== 1 || !rows[0]!.matches)
    throw new PayrollError(
      `The current Canadian original reporting source is missing or no longer matches retained history. ${rows.length ? RETAINED_REFUSAL : REFUSAL}`,
    );
  const row = rows[0]!;
  const catalogue = await readCanadianOpeningReportingCatalogue(tx, input.orgId);
  let allocations: CanadianOpeningReportingAllocation[];
  try {
    allocations = canonicalCanadianOpeningReportingAllocations(
      {
        orgId: input.orgId,
        subsidiaryId: row.subsidiaryId,
        originalCountry: row.originalCountry,
        originalCurrency: row.originalCurrency,
        coverageStart: row.coverageStart,
        coverageEnd: row.coverageEnd,
        annualAmounts: row.annualAmounts,
        children: row.children,
      },
      row.allocationSnapshot,
      catalogue,
    );
  } catch (error) {
    if (error instanceof PayrollError)
      throw new PayrollError(`${error.message}. ${RETAINED_REFUSAL}`, { cause: error });
    throw error;
  }
  const {
    matches: _matches,
    annualAmounts,
    children,
    allocationSnapshot: _snapshot,
    ...authority
  } = row;
  return {
    hasOpening: original.hasOpening,
    hasMaterialHistory: original.hasMaterialHistory,
    authority,
    annualAmounts,
    children,
    allocations,
  };
}
