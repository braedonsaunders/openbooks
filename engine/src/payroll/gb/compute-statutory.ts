/**
 * The GB pack's statutory pass: PAYE income tax and Class 1 National
 * Insurance (primary and secondary, category A).
 *
 * Thin by design: every number comes from calculate.ts (pure, gold-tested).
 * This wrapper resolves the employee's operable tax code from the P6/P9
 * coding notice, reads the in-year record from committed stubs, enforces the
 * cumulative-basis completeness gate, and pushes the three statutory lines.
 *
 * Assumed, declared loudly (no input channel exists yet — PROPOSEd to
 * Orchestrate alongside GB opening-YTD fields):
 * - NIC category letter A for every employee. Non-A categories (C nil-rate
 *   pensioners, B married women's reduced rate, M/H/V apprentice and veteran
 *   zero-secondary bands, J deferment) are refused by name in the pack docs
 *   but cannot be detected at runtime: no certificate or profile column
 *   carries the letter, and deriving it from birth dates would also need the
 *   State Pension age schedule plus apprenticeship/veteran status. Category-A
 *   arithmetic on a non-A employee is wrong money the engine cannot see —
 *   the input channel is the fix, not more guessing here.
 * - Directors are priced by the per-period (alternative) method. The annual
 *   method for directors (CA44) is not modeled.
 * - Two payments in the same Income Tax week are priced as one period's pay
 *   each, not aggregated ("Add to each payment any payments made earlier in
 *   the same Income Tax week", CWG2) — same-week aggregation is not modeled.
 */

import { sql } from "drizzle-orm";
import { sum } from "../../money.ts";
import { PayrollPackError } from "../payroll-error.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import {
  calculateGbNic,
  calculateGbPaye,
  gbResolveTaxYear,
  resolveGbCumulativeBasis,
  type GbStarterDeclaration,
} from "./calculate.ts";
import { GB_TAX_YEAR } from "./rates.ts";
import { parseGbTaxCode } from "./tax-codes.ts";

/** Regions whose income tax this engine computes end to end (rUK + Scotland). */
const GB_COMPUTED_REGIONS: readonly string[] = ["ENG", "WLS", "NIR", "SCT"];

/** In-year sums from committed stubs, plus the record's start. */
export interface GbPriorPeriod {
  taxablePay: string;
  addedPay: string;
  taxPaid: string;
  /** Earliest committed stub pay date this year, or null when none exists. */
  minPayDate: string | null;
  /** Whether any committed stub exists this year. */
  hasStubs: boolean;
}

/**
 * Read the employee's in-year GB record from committed payroll, the same way
 * `usEmployeeYtd` does: calculated runs are drafts and may be abandoned, so
 * counting them would let unpaid figures consume allowance room in a later
 * run. Opening balances contribute nothing — GB has no opening-YTD columns
 * (no migration this shard), so the completeness gate below refuses the
 * gapped cases by name instead of pricing them from zero.
 */
export async function gbEmployeePriorPeriod(ctx: Pick<
  PayrollStatutoryComputeContext,
  "tx" | "orgId" | "employeePartyId" | "taxYear" | "documentId"
>): Promise<GbPriorPeriod> {
  const { tx, orgId, employeePartyId, taxYear, documentId } = ctx;
  const rows = (await tx.execute<{
    taxable: string;
    addpay: string;
    tax: string;
    stub_count: string;
    first_pay: string | null;
  }>(sql`
    select
      coalesce(sum((s.factors->>'GB_TAXABLE')::numeric), 0) as taxable,
      coalesce(sum((s.factors->>'GB_ADDPAY')::numeric), 0) as addpay,
      coalesce(sum((s.factors->>'GB_TAX')::numeric), 0) as tax,
      count(*) as stub_count,
      min(r.pay_date) as first_pay
    from pay_stubs s
    join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
    join documents d on d.id = r.document_id and d.org_id = r.org_id
    where s.org_id = ${orgId} and s.employee_party_id = ${employeePartyId}
      and s.tax_year = ${taxYear} and s.pay_run_document_id <> ${documentId}
      and r.run_status = 'committed'
      and d.status <> 'voided'
  `)).rows[0];
  if (!rows) {
    return { taxablePay: "0.0000", addedPay: "0.0000", taxPaid: "0.0000", minPayDate: null, hasStubs: false };
  }
  return {
    taxablePay: String(rows.taxable),
    addedPay: String(rows.addpay),
    taxPaid: String(rows.tax),
    minPayDate: rows.first_pay == null ? null : String(rows.first_pay).slice(0, 10),
    hasStubs: Number(rows.stub_count) > 0,
  };
}

/** The starter declaration on file, or null when no checklist answers it. */
function gbStarterDeclaration(ctx: Pick<
  PayrollStatutoryComputeContext, "certificateFor"
>): GbStarterDeclaration {
  const answer = ctx.certificateFor("gb_starter_checklist")?.answers.starter_declaration;
  return answer === "A" || answer === "B" || answer === "C" ? answer : null;
}

export async function computeGbStatutory(
  ctx: PayrollStatutoryComputeContext,
): Promise<Record<string, string>> {
  const {
    tx, orgId, documentId, employeePartyId, taxYear, region,
    run, periodsPerYear: P, income, nonPeriodic, pensionable,
    deduction, pushStatutory, certificateFor, bool, assertRegionSupported,
  } = ctx;

  assertRegionSupported(region);
  if (!GB_COMPUTED_REGIONS.includes(region)) {
    throw new PayrollPackError(
      `PAYE income tax withholding for ${region} is not implemented by the GB payroll pack: `
      + "the engine computes England, Wales, Northern Ireland and Scotland end to end "
      + "(see GB_REGIONS).",
    );
  }

  const payDate = run.pay_date!;
  gbResolveTaxYear(payDate);
  if (taxYear !== GB_TAX_YEAR) {
    throw new PayrollPackError(
      `GB payroll pack transcribed 2026/27 only — the run's tax year is ${taxYear}`,
    );
  }

  const notice = certificateFor("gb_tax_code_notice");
  const rawCode = notice?.onFile ? notice.answers.tax_code : null;
  if (!rawCode || !rawCode.trim()) {
    throw new PayrollPackError(
      "GB PAYE needs the employee's tax code from the P6/P9 coding notice "
      + "(gb_tax_code_notice): no notice is on file and this pack operates no emergency "
      + "default — HMRC issues the code, the product does not invent it",
    );
  }
  let code = parseGbTaxCode(rawCode);
  // Scottish-taxpayer status follows the S-prefix code (main home in
  // Scotland), so an S-code prices the Scottish bands in any region. The
  // reverse — a non-Scottish code on an SCT-region run — would fall through
  // to the rUK bands, wrong money for every Scottish employee, so it is
  // refused by name. NT deducts nothing on any table and needs no gate.
  if (region === "SCT" && code.kind !== "none" && !code.scottish) {
    throw new PayrollPackError(
      `Scottish income tax for SCT needs a Scottish S-prefix code on the P6/P9 coding notice: `
      + `"${rawCode}" prices against the rUK bands and is refused by name for SCT — HMRC issues `
      + "Scottish taxpayers an S-prefix code (S1257L, SBR, SD0, SD1, SD2, SD3), and the product "
      + "does not fall an S-less code through to the wrong table (see GB_REGIONS).",
    );
  }
  if (bool(notice?.answers.non_cumulative)) {
    if (code.kind === "flat" || code.kind === "none") {
      throw new PayrollPackError(
        `GB tax code "${rawCode}" contradicts its coding notice: a week-1/month-1 marker on a `
        + "flat-rate or NT code is malformed input, not an operable code",
      );
    }
    code = { ...code, nonCumulative: true };
  }

  // PAYE prices all taxable pay of the period (bonuses and back pay are taxed
  // as ordinary pay of the period they are PAID in — `retroactivePayTreatment:
  // "periodic"`), less pre-tax pension (net-pay arrangement, same treatment
  // the CA pack reads). NIC prices NIC-able earnings, which no deduction
  // reduces. The K-code 50% cap measures "pre-tax pay": income + nonPeriodic.
  const periodPay = sum([income, nonPeriodic, `-${deduction("pension_f")}`]);
  const periodGross = sum([income, nonPeriodic]);
  const cumulative = code.kind !== "flat" && code.kind !== "none" && !code.nonCumulative;

  let priors: GbPriorPeriod = {
    taxablePay: "0.0000", addedPay: "0.0000", taxPaid: "0.0000", minPayDate: null, hasStubs: false,
  };
  if (cumulative) {
    priors = await gbEmployeePriorPeriod({ tx, orgId, employeePartyId, taxYear, documentId });
    resolveGbCumulativeBasis({
      payDate,
      starterDeclaration: gbStarterDeclaration({ certificateFor }),
      hasStubs: priors.hasStubs,
      minStubPayDate: priors.minPayDate,
    });
  }

  const paye = calculateGbPaye({
    code,
    payDate,
    periodsPerYear: P,
    periodPay,
    priorTaxablePay: priors.taxablePay,
    priorAddedPay: priors.addedPay,
    priorTaxPaid: priors.taxPaid,
    periodGrossPay: periodGross,
  });
  // Category A: the only NIC letter with an input channel (none exists yet —
  // see the module header). Every other letter is refused by name in docs.
  const nic = calculateGbNic({ earnings: pensionable, periodsPerYear: P });

  pushStatutory("paye", "deduction", "PAYE income tax", paye.tax, 110);
  pushStatutory("nic", "deduction", "National Insurance (employee, primary)", nic.employee, 120);
  pushStatutory(
    "nic", "employer_contribution", "National Insurance (employer, secondary)", nic.employer, 210,
  );
  return {
    GB_TAXABLE: paye.periodTaxablePay,
    GB_ADDPAY: paye.periodAddedPay,
    GB_TAX: paye.tax,
  };
}
