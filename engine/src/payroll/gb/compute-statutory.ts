/**
 * The GB pack's statutory pass: PAYE income tax, Class 1 National Insurance
 * (primary and secondary, category A), and student/postgraduate loan
 * deductions on NIC-able earnings.
 *
 * Thin by design: every number comes from calculate.ts (pure, gold-tested).
 * This wrapper resolves the employee's operable tax code from the P6/P9
 * coding notice, reads the in-year record from committed stubs, enforces the
 * cumulative-basis completeness gate, and refuses pension cases it cannot price.
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
 * - Workplace-pension contributions require an effective-dated worker
 *   assessment. Enrolled or opted-in workers and eligible jobholders without
 *   a valid opt-out refuse by name: this pack does not calculate the scheme's
 *   pay-reference-period qualifying earnings or employee/employer amounts.
 * - Directors require an effective-dated status and appointment date, then
 *   refuse by name until cumulative annual/pro-rata NIC, prior employee and
 *   employer shares, and the FPS method are calculated together.
 * - Two payments in the same Income Tax week are priced as one period's pay
 *   each, not aggregated ("Add to each payment any payments made earlier in
 *   the same Income Tax week", CWG2) — same-week aggregation is not modeled.
 */

import { sql } from "drizzle-orm";
import { mulPercent, sum } from "../../money/money.ts";
import { D, max0, U } from "../canada/decimal.ts";
import { PayrollPackError } from "../payroll-error.ts";
import { empFact, resolveEmployeeFact } from "../employee-facts.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import "./employee-facts.ts";
import {
  calculateGbNic,
  calculateGbLoanDeductions,
  calculateGbPaye,
  gbResolveTaxYear,
  resolveGbCumulativeBasis,
  type GbStarterDeclaration,
} from "./calculate.ts";
import { gbTablesForTaxYear } from "./year-tables.ts";
import { GB_AE_THRESHOLDS } from "./rates.ts";
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

/**
 * Trace-factor labels for the stub calculation trace, keyed by the factor
 * keys this pass returns. Terms are HMRC's own (PAYE, taxable pay) — see
 * the pack's CWG2 conformance basis.
 */
export const GB_FACTOR_LABELS: Readonly<Record<string, string>> = {
  GB_TAXABLE: "Taxable pay this period",
  GB_ADDPAY: "Added pay this period (bonus / back pay)",
  GB_TAX: "PAYE income tax this period",
  GB_STUDENT_LOAN: "Student loan deduction this period",
  GB_POSTGRADUATE_LOAN: "Postgraduate loan deduction this period",
  GB_LEVY: "Apprenticeship Levy this stub (report year-to-date on the EPS)",
  GB_LEVY_EARN: "Apprenticeship Levy paybill this stub",
  GB_AE_EMPLOYEE: "Workplace pension employee contribution this period",
  GB_AE_EMPLOYER: "Workplace pension employer contribution this period",
};

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
  const payYear = gbResolveTaxYear(payDate);
  if (taxYear !== payYear) {
    throw new PayrollPackError(
      `GB payroll pack cannot price a pay date in ${payYear} against the run's tax year ${taxYear}: ` +
      "a pay date is always priced from its own year's transcribed tables, never a neighbour's.",
    );
  }
  const tables = gbTablesForTaxYear(taxYear);

  const workplacePension = certificateFor("gb_workplace_pension");
  const pensionAnswers = workplacePension?.answers;
  if (!workplacePension?.onFile || !pensionAnswers) {
    throw new PayrollPackError(
      "GB workplace-pension assessment is required before payroll: record the worker's "
      + "effective-dated automatic-enrolment age, worker category and enrolment status "
      + "in gb_workplace_pension; an active member also needs scheme terms in "
      + "gb_workplace_pension_assessment before minimum contributions can be priced.",
    );
  }
  // Scheme terms are read before the enrolled gate: an enrolled or opted-in
  // worker who is an active member falls through to the minimums pricing
  // below (unsupported bases and methods refuse there by name); every other
  // enrolled case keeps this refusal. A missing terms assessment refuses here
  // by fact name, never as an enrolled worker priced at zero.
  const pensionAssessment = certificateFor("gb_workplace_pension_assessment");
  const aeMembership = resolveEmployeeFact("GB", "gb_ae_membership_status", empFact("GB", {
    gb_ae_membership_status: pensionAssessment?.answers.membership_status ?? null,
  }, "gb_ae_membership_status"));
  resolveEmployeeFact("GB", "gb_ae_age_band", empFact("GB", {
    gb_ae_age_band: pensionAssessment?.answers.age_band ?? null,
  }, "gb_ae_age_band"));
  const aeBasis = resolveEmployeeFact("GB", "gb_ae_scheme_basis", empFact("GB", {
    gb_ae_scheme_basis: pensionAssessment?.answers.scheme_basis ?? null,
  }, "gb_ae_scheme_basis"));
  const aeMethod = resolveEmployeeFact("GB", "gb_ae_deduction_method", empFact("GB", {
    gb_ae_deduction_method: pensionAssessment?.answers.deduction_method ?? null,
  }, "gb_ae_deduction_method"));
  if (aeMembership !== "active_member"
      && (pensionAnswers.enrolment_status === "enrolled" || pensionAnswers.enrolment_status === "opted_in")) {
    throw new PayrollPackError(
      "GB workplace-pension contributions are due for this enrolled or opted-in worker, "
      + "but the pack does not calculate employee and employer contributions on the "
      + "scheme's pay-reference-period basis; use AE-capable payroll software and do not "
      + "finalise this run without both amounts.",
    );
  }
  // Enrolled and opted-in workers satisfy the duty this gate protects, so
  // they fall through to the minimums pricing when their scheme is priced
  // (and keep the enrolled refusal above when it is not).
  if (pensionAnswers.worker_status === "eligible_jobholder"
      && pensionAnswers.enrolment_status !== "opted_out"
      && pensionAnswers.enrolment_status !== "enrolled"
      && pensionAnswers.enrolment_status !== "opted_in") {
    throw new PayrollPackError(
      "GB eligible jobholders must be enrolled in a qualifying workplace pension; "
      + "this pack cannot calculate the required employee and employer contributions. "
      + "Use AE-capable payroll software and do not finalise this run.",
    );
  }
  if (pensionAnswers.enrolment_status === "postponed") {
    throw new PayrollPackError(
      "GB workplace-pension postponement dates and duties are not calculated by this pack; "
      + "use AE-capable payroll software to assess this worker before finalising the run.",
    );
  }

  const nicCategoryCertificate = certificateFor("gb_nic_category");
  const nicCategoryRaw = empFact("GB", {
    gb_nic_category_letter: nicCategoryCertificate?.answers.category_letter ?? null,
  }, "gb_nic_category_letter");
  const nicCategory = resolveEmployeeFact("GB", "gb_nic_category_letter", nicCategoryRaw);
  if (nicCategory !== "A") {
    throw new PayrollPackError(
      `GB payroll cannot calculate National Insurance category ${nicCategory}: this pack currently `
      + "implements category A only, and must not apply its employee or employer rates to another "
      + "category. Use payroll software that supports this HMRC category until this pack adds its rules.",
    );
  }
  const directorStatus = nicCategoryCertificate?.answers.director_status;
  if (directorStatus !== "director" && directorStatus !== "not_director") {
    throw new PayrollPackError(
      "GB National Insurance needs an effective-dated director status in gb_nic_category; "
      + "record whether the employee is a company director before calculating NIC.",
    );
  }
  if (directorStatus === "director") {
    const startDate = nicCategoryCertificate?.answers.directorship_start_date;
    if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      throw new PayrollPackError(
        "GB director National Insurance needs the directorship start date (YYYY-MM-DD) "
        + "in gb_nic_category to determine the annual or pro-rata earnings period.",
      );
    }
    throw new PayrollPackError(
      "GB director National Insurance is not calculated: CA44 requires cumulative annual or "
      + "pro-rata earnings-period employee and employer NIC less both shares already paid, "
      + "and this pack cannot report the FPS director calculation method. Use payroll software "
      + "that supports CA44 and FPS director reporting; do not finalise this run.",
    );
  }

  const starterChecklist = certificateFor("gb_starter_checklist");
  const studentLoanPlan = resolveEmployeeFact(
    "GB",
    "gb_student_loan_plan",
    empFact("GB", {
      gb_student_loan_plan: starterChecklist?.answers.student_loan_plan ?? null,
    }, "gb_student_loan_plan"),
  );
  const postgraduateLoan = resolveEmployeeFact(
    "GB",
    "gb_postgraduate_loan",
    empFact("GB", {
      gb_postgraduate_loan: starterChecklist?.answers.student_loan_postgraduate ?? null,
    }, "gb_postgraduate_loan"),
  );

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

  // Workplace-pension automatic enrolment: statutory minimum contributions
  // (5% employee, 3% employer) on qualifying earnings within the published
  // pay-reference band, for active members of qualifying-earnings-minimum
  // net-pay schemes. Membership, basis, and method were resolved beside the
  // enrolled gate above; an enrolled worker with any other scheme never
  // reaches this block. Any other scheme basis or contribution method — and
  // any pay with no assessment on file — refuses by name: the engine must not
  // assume duties, bands, or methods. Net-pay employee contributions reduce
  // taxable pay exactly like the pension_f deduction below.
  let aeEmployee = "0.0000";
  let aeEmployer = "0.0000";
  if (aeMembership === "active_member") {
    if (aeBasis !== "qualifying_earnings_minimum") {
      throw new PayrollPackError(
        "GB workplace pension prices statutory minimum contributions on qualifying earnings only: "
        + "this scheme uses another certified basis, which this pack does not price — use payroll "
        + "software that supports the scheme until this pack adds its rules",
      );
    }
    if (aeMethod !== "net_pay") {
      throw new PayrollPackError(
        "GB workplace pension prices the employee share as a net-pay deduction only: this scheme "
        + "uses relief at source or salary sacrifice, which change withholding and tax treatment — "
        + "use payroll software that supports the method until this pack adds its rules",
      );
    }
    const thresholds = GB_AE_THRESHOLDS[P];
    if (!thresholds) {
      throw new PayrollPackError(
        `GB workplace pension has no published pay-reference thresholds for ${P} periods per year: `
        + "the Pensions Regulator publishes thresholds per frequency and this pack never divides an "
        + "annual figure by a guessed frequency",
      );
    }
    const grossUnits = U(sum([income, nonPeriodic]));
    const qualifying = max0(
      (grossUnits < U(thresholds.upper) ? grossUnits : U(thresholds.upper)) - U(thresholds.lower),
    );
    aeEmployee = mulPercent(D(qualifying), "5", 2);
    aeEmployer = mulPercent(D(qualifying), "3", 2);
  }
  // not_eligible and valid_opt_out price nothing; any other value was
  // already refused by resolveEmployeeFact against the declared choices.

  // PAYE prices all taxable pay of the period (bonuses and back pay are taxed
  // as ordinary pay of the period they are PAID in — `retroactivePayTreatment:
  // "periodic"`), less pre-tax pension (net-pay arrangement, same treatment
  // the CA pack reads). NIC prices NIC-able earnings, which no deduction
  // reduces. The K-code 50% cap measures "pre-tax pay": income + nonPeriodic.
  const periodPay = sum([income, nonPeriodic, `-${deduction("pension_f")}`, `-${aeEmployee}`]);
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
      monthOneEnd: tables.monthOneEnd,
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
    tables,
  });
  // Category A: the only NIC letter with an input channel (none exists yet —
  // see the module header). Every other letter is refused by name in docs.
  const nic = calculateGbNic({ earnings: pensionable, periodsPerYear: P, tables });
  const loan = calculateGbLoanDeductions({
    earnings: pensionable,
    periodsPerYear: P,
    taxYear,
    studentLoanPlan: studentLoanPlan!,
    postgraduateLoan: postgraduateLoan === "true",
  });

  pushStatutory("paye", "deduction", "PAYE income tax", paye.tax, 110);
  pushStatutory("nic", "deduction", "National Insurance (employee, primary)", nic.employee, 120);
  pushStatutory("student_loan", "deduction", "Student loan repayment", loan.studentLoan, 130);
  pushStatutory("postgraduate_loan", "deduction", "Postgraduate loan repayment", loan.postgraduateLoan, 140);
  // Zero-amount shares push no line: every existing stub shape is
  // unchanged for workers with no contributions due.
  if (U(aeEmployee) > 0n || U(aeEmployer) > 0n) {
    pushStatutory("ae_employee", "deduction", "Workplace pension (employee)", aeEmployee, 150);
    pushStatutory("ae_employer", "employer_contribution", "Workplace pension (employer)", aeEmployer, 220);
  }
  pushStatutory(
    "nic", "employer_contribution", "National Insurance (employer, secondary)", nic.employer, 210,
  );
  return {
    GB_TAXABLE: paye.periodTaxablePay,
    GB_ADDPAY: paye.periodAddedPay,
    GB_TAX: paye.tax,
    GB_STUDENT_LOAN: loan.studentLoan,
    GB_POSTGRADUATE_LOAN: loan.postgraduateLoan,
    GB_AE_EMPLOYEE: aeEmployee,
    GB_AE_EMPLOYER: aeEmployer,
  };
}
