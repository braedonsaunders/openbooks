import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";

export interface FrPlafondYearToDate {
  /** Prior committed brut for the contract/year, exact decimal. */
  ytdGross: string;
  /** Count of prior committed stubs for the contract/year. */
  priorStubCount: number;
}

/**
 * Committed French runs only; draft or calculated stubs never consume YTD.
 * Same committed-only, void-safe shape as committedFrRgduYearToDate: the
 * current document is excluded and only committed runs count, so a voided
 * run's ceiling consumption leaves with it and a replacement re-reads the
 * surviving base. The stub count serves non-monthly ceiling elapsed
 * periods; monthly pay derives elapsed months from the pay date instead,
 * so calendar gaps without pay still accrue ceiling.
 */
export async function committedFrPlafondYearToDate(input: {
  tx: Pick<typeof db, "execute">;
  orgId: string;
  subsidiaryId: string;
  employeePartyId: string;
  employmentId: string | null | undefined;
  taxYear: number;
  payDate: string;
  excludeDocumentId: string;
}): Promise<FrPlafondYearToDate> {
  const employmentFilter = input.employmentId
    ? sql`and s.employment_id = ${input.employmentId}::uuid`
    : sql``;
  const row = (await input.tx.execute<{
    remuneration: string | null;
    stubs: number | null;
  }>(sql`
    select round(coalesce(sum(s.gross), 0), 4)::numeric(24, 4)::text as remuneration,
           count(*)::int as stubs
      from pay_stubs s
      join pay_runs r on r.org_id = s.org_id
                    and r.document_id = s.pay_run_document_id
                    and r.run_status = 'committed'
      join documents d on d.org_id = r.org_id and d.id = r.document_id
     where s.org_id = ${input.orgId}
       and s.employee_party_id = ${input.employeePartyId}
       and s.country = 'FR'
       and s.tax_year = ${input.taxYear}
       and s.pay_date <= ${input.payDate}::date
       and s.pay_run_document_id <> ${input.excludeDocumentId}
       and d.subsidiary_id = ${input.subsidiaryId}::uuid
       ${employmentFilter}
  `)).rows[0];
  return {
    ytdGross: typeof row?.remuneration === "string" ? row.remuneration : "0",
    priorStubCount: typeof row?.stubs === "number" ? row.stubs : 0,
  };
}
