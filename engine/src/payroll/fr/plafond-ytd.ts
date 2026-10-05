import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  civilDateFromParts,
  daysInCivilMonth,
  inclusiveCalendarDays,
  parseIsoDate,
} from "../../platform/civil-date.ts";
import { PayrollPackError } from "../payroll-error.ts";

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
 * periods; monthly pay derives the employed months from the hire date and
 * the pay date instead (frCeilingThirtieths), so calendar gaps without pay
 * still accrue ceiling.
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

/**
 * The cumulative monthly ceiling position, in thirtieths of a month, before
 * and through the month of this versement. The plafond accrues only over
 * the months the employee was actually employed this year (Urssaf
 * régularisation progressive): nothing before the hire month, and the
 * month of entry or exit counts its calendar days of employment over 30
 * (capped at a full month), the Urssaf proration of the plafond for a part
 * month. An unknown hire date refuses: accruing from January would hand a
 * mid-year hire months of ceiling they were never employed for.
 */
export function frCeilingThirtieths(input: {
  taxYear: number;
  payDate: string;
  hiredOn: string | null | undefined;
  terminatedOn: string | null | undefined;
}): { before: number; through: number } {
  const hiredOn = input.hiredOn ? String(input.hiredOn).slice(0, 10) : "";
  if (hiredOn === "") {
    throw new PayrollPackError(
      "FR plafond refuses: the employee's hire date is not recorded, and the monthly social-security "
      + "ceiling accrues only from the month of hire (Urssaf régularisation progressive du plafond). "
      + "Record the hire date on the employee record before calculating.",
    );
  }
  parseIsoDate(hiredOn);
  const terminatedOn = input.terminatedOn ? String(input.terminatedOn).slice(0, 10) : "";
  if (terminatedOn !== "") parseIsoDate(terminatedOn);
  const payMonth = Number(input.payDate.slice(5, 7));
  if (input.payDate.slice(0, 4) !== String(input.taxYear) || payMonth < 1 || payMonth > 12) {
    throw new PayrollPackError(`FR plafond needs a ${input.taxYear} pay date, got "${input.payDate}"`);
  }
  const monthThirtieths = (month: number): number => {
    const first = civilDateFromParts(input.taxYear, month, 1);
    const last = civilDateFromParts(input.taxYear, month, daysInCivilMonth(input.taxYear, month));
    const from = hiredOn > first ? hiredOn : first;
    const to = terminatedOn !== "" && terminatedOn < last ? terminatedOn : last;
    if (to < from) return 0;
    if (from === first && to === last) return 30;
    return Math.min(30, inclusiveCalendarDays(from, to));
  };
  let before = 0;
  for (let month = 1; month < payMonth; month += 1) before += monthThirtieths(month);
  const through = before + monthThirtieths(payMonth);
  if (through === 0) {
    throw new PayrollPackError(
      `FR plafond refuses: the employee is not employed on or before ${input.payDate} this year `
      + `(hired ${hiredOn}${terminatedOn !== "" ? `, left ${terminatedOn}` : ""}). Correct the hire `
      + "date on the employee record, or pay the employee in a run dated within the employment.",
    );
  }
  return { before, through };
}
