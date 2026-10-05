/**
 * The PL pack's year-to-date position for one payslip: the dochód and the
 * emerytalne/rentowe contribution base this payer has already paid the
 * employee in the tax year. The 120 000 zł PIT threshold (art. 32 ust. 2)
 * and the annual emerytalne/rentowe limit (ZUS art. 19 ust. 1) both test
 * these real figures — never the current month multiplied back over the
 * year, which invents income for a mid-year hire and exhausts the limit
 * early after a raise.
 *
 * Sources: the payer's committed PL stubs for the year (the DOCHOD and
 * PODSTAWA_SP factors each payslip recorded), plus the declared opening
 * carry-in (`pl_otwarcie_roku`) for months paid before the payer's payroll
 * ran here. The figures are only used when the record is provably complete;
 * otherwise the payslip refuses by name.
 */
import { sql } from "drizzle-orm";
import { fromUnits, toUnits } from "../../money/money.ts";
import { PayrollPackError } from "../payroll-error.ts";
import type { ResolvedCertificate } from "../certificates.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";

export interface PlCommittedHistory {
  /** Sum of DOCHOD over the employee's earlier committed stubs from this payer. */
  dochod: string;
  /** Sum of PODSTAWA_SP over the same stubs. */
  podstawaSpoleczne: string;
  /** Earliest pay date of any committed PL stub this payer issued this year. */
  payerFirstPayDate: string | null;
  /** Earliest period start of any committed PL run this payer paid this year. */
  payerFirstPeriodStart: string | null;
}

/**
 * Committed runs only: a calculated run is a draft that may be abandoned,
 * and a voided run's figures leave with it. The current document is
 * excluded so a recalculation never counts itself, and only stubs paid on
 * or before this payslip count.
 */
export async function committedPlHistory(input: {
  tx: Pick<PayrollStatutoryComputeContext["tx"], "execute">;
  orgId: string;
  subsidiaryId: string;
  employeePartyId: string;
  taxYear: number;
  payDate: string;
  excludeDocumentId: string;
}): Promise<PlCommittedHistory> {
  const row = (await input.tx.execute<{
    dochod: string | null;
    podstawa: string | null;
    payer_first_pay: string | null;
    payer_first_period: string | null;
  }>(sql`
    with payer as (
      select s.employee_party_id, s.pay_date, r.period_start, s.factors
        from pay_stubs s
        join pay_runs r on r.org_id = s.org_id
                      and r.document_id = s.pay_run_document_id
                      and r.run_status = 'committed'
        join documents d on d.org_id = r.org_id and d.id = r.document_id
       where s.org_id = ${input.orgId}
         and s.country = 'PL'
         and s.tax_year = ${input.taxYear}
         and s.pay_run_document_id <> ${input.excludeDocumentId}
         and d.status <> 'voided'
         and d.subsidiary_id = ${input.subsidiaryId}::uuid
    )
    select
      round(coalesce(sum((factors->>'DOCHOD')::numeric) filter (
        where employee_party_id = ${input.employeePartyId} and pay_date <= ${input.payDate}::date), 0), 4)::text as dochod,
      round(coalesce(sum((factors->>'PODSTAWA_SP')::numeric) filter (
        where employee_party_id = ${input.employeePartyId} and pay_date <= ${input.payDate}::date), 0), 4)::text as podstawa,
      min(pay_date)::text as payer_first_pay,
      min(period_start)::text as payer_first_period
      from payer
  `)).rows[0];
  return {
    dochod: row?.dochod ?? "0",
    podstawaSpoleczne: row?.podstawa ?? "0",
    payerFirstPayDate: row?.payer_first_pay ? row.payer_first_pay.slice(0, 10) : null,
    payerFirstPeriodStart: row?.payer_first_period ? row.payer_first_period.slice(0, 10) : null,
  };
}

export interface PlYearToDate {
  dochod: string;
  podstawaSpoleczne: string;
}

/**
 * Combine committed history with the opening carry-in, refusing when the
 * payer's record for the year cannot be shown complete. Complete means one
 * of: the payslip is paid in January (nothing earlier counts); an opening
 * carry-in is on file; the payer has run its payroll here since January;
 * or the employee was hired on or after the first period the payer ran
 * here, so every payment to them is on file.
 */
export function resolvePlYearToDate(input: {
  taxYear: number;
  payDate: string;
  periodStart: string | null | undefined;
  hiredOn: string | null | undefined;
  history: PlCommittedHistory;
  opening: ResolvedCertificate | null;
}): PlYearToDate {
  const { history, opening } = input;
  let openingDochod = 0n;
  let openingPodstawa = 0n;
  const openingOnFile = opening !== null && opening.onFile;
  if (openingOnFile) {
    const dochod = opening.answers["dochod_ytd"] ?? "";
    const podstawa = opening.answers["podstawa_emerytalna_ytd"] ?? "";
    if (dochod === "" || podstawa === "") {
      throw new PayrollPackError(
        "PL opening year-to-date (pl_otwarcie_roku) is on file without both figures: record the "
        + "dochód and the emerytalne/rentowe base this payer paid before its payroll ran here "
        + "(zero when nothing was paid) before calculating.",
      );
    }
    openingDochod = toUnits(dochod);
    openingPodstawa = toUnits(podstawa);
    if (openingDochod < 0n || openingPodstawa < 0n) {
      throw new PayrollPackError("PL opening year-to-date figures cannot be negative.");
    }
  }
  const january = `${input.taxYear}-01-31`;
  const hiredOn = input.hiredOn ? String(input.hiredOn).slice(0, 10) : "";
  const adoption = [history.payerFirstPeriodStart, input.periodStart ? String(input.periodStart).slice(0, 10) : null]
    .filter((value): value is string => value !== null && value !== "")
    .sort()[0] ?? null;
  const complete = input.payDate <= january
    || openingOnFile
    || (history.payerFirstPayDate !== null && history.payerFirstPayDate <= january)
    || (hiredOn !== "" && adoption !== null && hiredOn >= adoption);
  if (!complete) {
    throw new PayrollPackError(
      `PL year-to-date is incomplete for ${input.payDate}: the 120 000 zł PIT threshold and the `
      + "emerytalne/rentowe annual limit test what this payer paid since 1 January, and its payroll "
      + "has not run here since then. If the employee joined this payer after its payroll started "
      + "running here, record the hire date on the employee record; otherwise record what this payer "
      + "paid before its payroll ran here (dochód and emerytalne/rentowe base, zero when nothing) on "
      + "the employee's opening year-to-date (pl_otwarcie_roku) before calculating.",
    );
  }
  return {
    dochod: fromUnits(openingDochod + toUnits(history.dochod)),
    podstawaSpoleczne: fromUnits(openingPodstawa + toUnits(history.podstawaSpoleczne)),
  };
}
