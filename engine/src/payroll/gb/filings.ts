/**
 * The GB pack's filing declaration: the filing-account program type and the
 * year-end statements — the P60 End of Year Certificate (annual) and the P45
 * leaver statement (separation).
 *
 * The employer enrols for PAYE with HMRC and receives an employer PAYE
 * reference and an Accounts Office reference; every Full Payment Submission
 * and Employer Payment Summary rides those references, so the program type is
 * declared here.
 *
 * SCOPE (read the header brief before extending this file):
 * - IN: the employee statements the law says the employee is owed — the P60
 *   for everyone still employed at 5 April (by 31 May), and P45 Parts
 *   1A/2/3 for every leaver. Both render from committed stubs, pence for
 *   pence.
 * - OUT: RTI — the Full Payment Submission (every payday, including the
 *   leaver FPS that carries P45 Part 1 to HMRC) and the Employer Payment
 *   Summary — is a national submission standard with its own campaign, and
 *   attempting it here would produce a half-built file that looks finished.
 *   P11D benefits returns are likewise out of scope. Both refusals below
 *   name the missing standard precisely, so nobody reads an absent `download`
 *   as "no submission exists".
 */

import { add } from "../../money/money.ts";
import { isFilingRowUuid, type PayrollFilingData, type PayrollFilingRowScope, type PayrollFilingSlipData, type PayrollPackFilings, type PayrollYearEndFiling } from "../filing-registry.ts";
import { PayrollError } from "../error.ts";
import { filingAccountRef, filingAccountsById } from "../filing.ts";
import { gbP45Leavers, gbP60Slips, gbTaxYearBounds, type GbYearStatement } from "../yearend.ts";

/**
 * The `employee:account` row grammar, as the inverse of the P60/P45
 * populations' row-id construction (the account empty for the unassigned
 * aggregate). Owned HERE, beside the builders — the subsidiary-scope guard
 * parses through the declaration, never its own copy of this shape. Shared
 * by both filings: one employment is one row on each, and the guard treats
 * them by cadence (annual slips by their pay runs, separation events by
 * current employment plus sources).
 */
export function parseGbStatementRowId(rowId: string): PayrollFilingRowScope | null {
  const parts = rowId.split(":");
  const employee = parts[0] ?? "";
  const account = parts[1] ?? "";
  if (parts.length !== 2 || !isFilingRowUuid(employee)) return null;
  if (account && !isFilingRowUuid(account)) return null;
  return { employees: [employee], accounts: account ? [account] : [] };
}

/** The GB tax year label the statements carry ("2026/27", named opening year). */
export function gbTaxYearLabel(taxYear: number): string {
  return `${taxYear}/${String(taxYear + 1).slice(2)}`;
}

async function p60Population(orgId: string, taxYear: number): Promise<PayrollFilingData> {
  const slips = await gbP60Slips(orgId, taxYear);
  // The employer-side tie, on the face of the population: total pay, total
  // PAYE, and both NIC shares — the secondary (employer) share is the
  // employer's own liability, the figure an Employer Payment Summary would
  // reconcile against. RTI itself is still refused by name below; these
  // totals answer "why no second filing" with a reconciliation, not silence.
  const total = (pick: (slip: GbYearStatement) => string) =>
    slips.reduce((acc, slip) => add(acc, pick(slip)), "0");
  const totals = {
    pay: total((slip) => slip.payInEmployment),
    tax: total((slip) => slip.taxDeducted),
    nicEe: total((slip) => slip.nicEmployee),
    nicEr: total((slip) => slip.nicEmployer),
  };
  return {
    rowKey: "rowId",
    columns: [
      { key: "employee", label: "Employee" },
      { key: "nation", label: "Nation" },
      { key: "pay", label: "Pay in this employment", align: "right", money: true },
      { key: "tax", label: "Tax deducted", align: "right", money: true },
      { key: "nic", label: "Employee NIC", align: "right", money: true },
      { key: "taxCode", label: "Final tax code" },
    ],
    rows: slips.map((slip) => ({
      rowId: `${slip.employeePartyId}:${slip.filingAccountId ?? ""}`,
      employee: slip.employeeName,
      nation: slip.nation,
      pay: slip.payInEmployment,
      tax: slip.taxDeducted,
      nic: slip.nicEmployee,
      taxCode: slip.finalTaxCode ?? "—",
    })),
    totals: [
      { label: "Statements", value: String(slips.length) },
      { label: "Total pay in employments", value: totals.pay, money: true },
      { label: "Total PAYE deducted", value: totals.tax, money: true },
      { label: "Employee NIC (primary)", value: totals.nicEe, money: true },
      { label: "Employer NIC (secondary)", value: totals.nicEr, money: true },
    ],
  };
}

async function p45Population(orgId: string, taxYear: number): Promise<PayrollFilingData> {
  const leavers = await gbP45Leavers(orgId, taxYear);
  return {
    rowKey: "rowId",
    columns: [
      { key: "employee", label: "Employee" },
      { key: "leavingDate", label: "Leaving date" },
      { key: "pay", label: "Total pay to date", align: "right", money: true },
      { key: "tax", label: "Total tax to date", align: "right", money: true },
      { key: "taxCode", label: "Tax code" },
    ],
    rows: leavers.map((leaver) => ({
      rowId: `${leaver.employeePartyId}:${leaver.filingAccountId ?? ""}`,
      employee: leaver.employeeName,
      leavingDate: leaver.leavingDate,
      pay: leaver.payInEmployment,
      tax: leaver.taxDeducted,
      taxCode: leaver.finalTaxCode ?? "—",
    })),
  };
}

/**
 * The employer's PAYE reference for the statement header, or "Unassigned"
 * when no gb_paye account is on file. RD1 requires the reference by law; an
 * employer that has not recorded it must do so before handing the statement
 * over — the slip names the gap instead of inventing a number.
 */
async function gbPayeReference(orgId: string, filingAccountId: string | null): Promise<string> {
  const account = filingAccountRef(filingAccountId, await filingAccountsById(orgId));
  return account.accountNumber ?? "Unassigned — record the employer PAYE reference before issuing";
}

/**
 * One employee's P60, section for section — HMRC Specification for employer
 * substitute forms P60 (RD1), 2026 to 2027 edition (HMRC 12/25), "P60 legal
 * requirements" (p.4). The P60 carries no box numbers (it is £/p columns,
 * not numbered boxes), so each slip box below is keyed by the form's own
 * section heading, quoted.
 */
async function p60Slip(orgId: string, taxYear: number, rowId: string): Promise<PayrollFilingSlipData> {
  const slips = await gbP60Slips(orgId, taxYear);
  const slip = slips.find(
    (candidate) => `${candidate.employeePartyId}:${candidate.filingAccountId ?? ""}` === rowId,
  );
  if (!slip) {
    throw new PayrollError(`no ${gbTaxYearLabel(taxYear)} P60 matches the requested employee`);
  }
  if (!slip.finalTaxCode) {
    throw new PayrollError(
      `${slip.employeeName} has no P6/P9 coding notice on file — the P60's final tax code box cannot be `
      + "printed without one. File the gb_tax_code_notice certificate, then re-open the P60.",
    );
  }
  const { end } = gbTaxYearBounds(taxYear);
  return {
    formCode: "GB_P60",
    formName: "P60 End of Year Certificate",
    formNumber: "P60",
    headerFields: [
      { label: "Employee's name", value: slip.employeeName },
      // RD1: "employee's National Insurance number (if known)". The product
      // holds no NINO column, so "if known" is never known here — printed as
      // such, never invented.
      { label: "National Insurance number (if known)", value: "Not known" },
      { label: "Works/payroll number (where appropriate)", value: slip.payrollNumber ?? "—" },
      { label: "Employer PAYE reference", value: await gbPayeReference(orgId, slip.filingAccountId) },
      { label: "Tax year to 5 April", value: `${gbTaxYearLabel(taxYear)} (to ${end})` },
    ],
    boxes: [
      // RD1 Illustration 1a: three pay/tax column pairs. Previous-employment
      // figures arrive on the P45 and this product holds no P45 input channel
      // (a P45 joiner's prior pay is refused by name in the engine), so they
      // are declared not-held rather than printed as zeros.
      { code: "prev-pay", label: "Pay — In previous employments", value: "Not held — no P45 figures on file" },
      { code: "prev-tax", label: "Tax deducted — In previous employments", value: "Not held — no P45 figures on file" },
      // RD1 certificate text: "This form shows your total pay for Income Tax
      // purposes in this employment for the year."
      { code: "this-pay", label: "Pay — In this employment", value: slip.payInEmployment, emphasis: true },
      { code: "this-tax", label: "Tax deducted — In this employment", value: slip.taxDeducted, emphasis: true },
      { code: "total-pay", label: "Pay — Total for year (this employment; no previous-employment figures held)", value: slip.payInEmployment, emphasis: true },
      { code: "total-tax", label: "Tax deducted — Total for year (this employment; no previous-employment figures held)", value: slip.taxDeducted, emphasis: true },
      // RD1: "final tax code including the 'Week 1' or 'Month 1' indicator
      // (if applicable)". An S-prefix code reports Scottish tax (rates.ts:
      // the code selects the band table), so the slip says so.
      { code: "final-tax-code", label: "Final tax code", value: slip.finalTaxCode + (slip.scottishCode ? " — Scottish taxpayer rate" : "") },
      // RD1 NIC section: one row per table letter used during the year, with
      // earnings at the LEL, above the LEL to the PT, above the PT to the
      // UEL, and the employee's contributions due above the PT. The engine
      // prices NIC by the exact percentage method (calculateGbNic returns
      // employee/employer totals only), and the subledger carries NIC-able
      // earnings and contributions but no LEL/PT/UEL split — so the three
      // earnings-band boxes are declared not-held while the contributions
      // box reports what was actually withheld. Table letter A is the
      // engine's stated assumption for every employee (compute-statutory.ts
      // header: no category-letter input channel exists yet).
      { code: "nic-letter", label: "NIC table letter", value: "A (the engine prices category A for every employee)" },
      { code: "nic-lel", label: "Earnings at the Lower Earnings Limit", value: "Not held — the subledger carries no LEL/PT/UEL split" },
      { code: "nic-lel-pt", label: "Earnings above the LEL, up to and including the Primary Threshold", value: "Not held — the subledger carries no LEL/PT/UEL split" },
      { code: "nic-pt-uel", label: "Earnings above the PT, up to and including the Upper Earnings Limit", value: "Not held — the subledger carries no LEL/PT/UEL split" },
      { code: "nic-contrib", label: "Employee's contributions due on all earnings above the PT", value: slip.nicEmployee },
      // RD1: the six statutory payments "included in the pay 'In this
      // employment' figure above". The pack prices no statutory payments
      // (jurisdictions.ts header; rates.ts declares the AE band as data
      // only), so any such pay rides ordinary earnings inside the pay figure
      // and cannot be separated back out — declared, not guessed.
      { code: "smp", label: "Statutory Maternity Pay paid", value: "Not held — the pack prices no statutory payments" },
      { code: "spp", label: "Statutory Paternity Pay paid", value: "Not held — the pack prices no statutory payments" },
      { code: "shpp", label: "Statutory Shared Parental Pay paid", value: "Not held — the pack prices no statutory payments" },
      { code: "sap", label: "Statutory Adoption Pay paid", value: "Not held — the pack prices no statutory payments" },
      { code: "spbp", label: "Statutory Parental Bereavement Pay paid", value: "Not held — the pack prices no statutory payments" },
      { code: "sncp", label: "Statutory Neonatal Care Pay paid", value: "Not held — the pack prices no statutory payments" },
      // RD1 (whole £s only). No student-loan or postgraduate-loan slot
      // exists and the engine fills none (jurisdictions.ts header), so there
      // are no deductions to report — stated, not zeroed.
      { code: "student-loan", label: "Student Loan deductions in this employment (whole £s only)", value: "None — the pack prices no student-loan repayments" },
      { code: "postgrad-loan", label: "Postgraduate Loan deductions in this employment (whole £s only)", value: "None — the pack prices no postgraduate-loan repayments" },
    ],
    notes: [
      "Pay and tax 'In this employment' are the figures to use for a tax return, if the employee gets one (RD1 best practice).",
      "The P60 goes to every employee still employed at 5 April, by 31 May (RD1 p.6).",
      "A P60 for an employee on an S-prefix code reports Scottish tax.",
      "National Insurance contributions and statutory payments the pack does not price are declared not-held on the face of the statement — a plausible figure on a statutory form is worse than a named gap.",
    ],
  };
}

/**
 * One leaver's P45, Parts 1A/2/3 — what each part is for:
 * - Part 1 goes to HMRC, reported through the Full Payment Submission when
 *   the employee leaves (RTI — not produced here, see downloadRefusal).
 * - Part 1A is the employee's own copy, kept for their records.
 * - Parts 2 and 3 go to the NEW employer (or to Jobcentre Plus when claiming
 *   benefits), so the next employment starts on the right tax code.
 * (gov.uk "What to do when an employee leaves": give the leaver a P45;
 * LITRG "Employee leaving": the P45's contents and onward routing.)
 *
 * Fields (same sources): the employer PAYE reference, the employee's name,
 * National Insurance number, payroll number, the leaving date, the tax code
 * at leaving (with basis), and total pay and tax to date in this employment
 * for the tax year. Student-loan deductions: the P45 asks whether they
 * continue — none can, because the pack prices none (jurisdictions.ts).
 */
async function p45Slip(orgId: string, taxYear: number, rowId: string): Promise<PayrollFilingSlipData> {
  const leavers = await gbP45Leavers(orgId, taxYear);
  const leaver = leavers.find(
    (candidate) => `${candidate.employeePartyId}:${candidate.filingAccountId ?? ""}` === rowId,
  );
  if (!leaver) {
    throw new PayrollError(`no ${gbTaxYearLabel(taxYear)} P45 matches the requested employee`);
  }
  if (!leaver.finalTaxCode) {
    throw new PayrollError(
      `${leaver.employeeName} has no P6/P9 coding notice on file — the P45's tax code cannot be `
      + "printed without one. File the gb_tax_code_notice certificate, then re-open the P45.",
    );
  }
  return {
    formCode: "GB_P45",
    formName: "P45 — Details of employee leaving work",
    formNumber: "P45 (Parts 1A/2/3)",
    headerFields: [
      { label: "Employee's name", value: leaver.employeeName },
      { label: "National Insurance number (if known)", value: "Not known" },
      { label: "Works/payroll number (where appropriate)", value: leaver.payrollNumber ?? "—" },
      { label: "Employer PAYE reference", value: await gbPayeReference(orgId, leaver.filingAccountId) },
      { label: "Tax year", value: gbTaxYearLabel(taxYear) },
    ],
    boxes: [
      { code: "leaving-date", label: "Date of leaving", value: leaver.leavingDate, emphasis: true },
      { code: "tax-code", label: "Tax code at leaving", value: leaver.finalTaxCode + (leaver.scottishCode ? " — Scottish taxpayer rate" : "") },
      { code: "pay-to-date", label: "Total pay to date in this employment", value: leaver.payInEmployment, emphasis: true },
      { code: "tax-to-date", label: "Total tax to date in this employment", value: leaver.taxDeducted, emphasis: true },
      { code: "student-loan", label: "Student Loan deductions to continue", value: "No — the pack prices no student-loan repayments" },
    ],
    notes: [
      "Part 1 goes to HMRC through the Full Payment Submission — RTI, not produced here.",
      "Part 1A is the employee's own copy, kept for their records.",
      "Parts 2 and 3 go to the new employer (or to Jobcentre Plus when claiming benefits).",
      "Pay and tax are the tax-year totals in this employment to the leaving date, from committed pay runs.",
    ],
  };
}

/**
 * A corrected GB statement, as HMRC's correction mechanics require: the
 * payroll error is corrected by updating the year-to-date figures in the
 * next (or an additional) FPS (gov.uk "You made a mistake in your FPS or
 * EPS"), and the employee gets a replacement statement re-rendered from the
 * corrected subledger. There is no separate correction form — the
 * replacement P60/P45 IS the vehicle, so `same_form` with `amended` only:
 * a GB statement is never cancelled, it is restated.
 */
function gbStatementAmendment(form: "P60" | "P45"): NonNullable<PayrollYearEndFiling["amendment"]> {
  return {
    supported: true,
    revisions: ["amended"],
    vehicle: "same_form",
    slip: {
      build: async (row, orgId, taxYear) => {
        const current = form === "P60"
          ? await p60Slip(orgId, taxYear, row.rowId)
          : await p45Slip(orgId, taxYear, row.rowId);
        return {
          ...current,
          formName: `${current.formName} (CORRECTED)`,
          notes: [
            `A corrected ${form}: re-rendered from the committed pay runs as they stand now — correct the `
            + "payroll first (a retro or adjustment run), update the year-to-date figures in the next or an "
            + "additional FPS (gov.uk 'You made a mistake in your FPS or EPS'), then hand over this replacement.",
            ...(current.notes ?? []),
          ],
        };
      },
    },
    downloadRefusal:
      `no electronic ${form} correction file is generated — the replacement ${form} above is complete; `
      + "correct the year-to-date figures through RTI payroll software (gov.uk 'You made a mistake in "
      + "your FPS or EPS')",
  };
}

const RTI_REFUSAL =
  "the GB pack produces no RTI submission — no Full Payment Submission and no Employer Payment Summary. "
  + "The statement figures above are complete on screen; report pay, deductions and starters/leavers through "
  + "RTI payroll software on every payday (gov.uk 'Report payroll information').";

const P11D_REFUSAL =
  "P11D benefits returns are not produced by any payroll filing here — benefits in kind are outside the "
  + "payroll subledger. Report them through HMRC's PAYE online service.";

/** Lazy, like caPackFilings/usPackFilings: the filings modules sit in an
 * import cycle with the year-end builders, so the declaration must not be
 * dereferenced at module-evaluation time. */
let cached: PayrollPackFilings | null = null;

export function gbPackFilings(): PayrollPackFilings {
  cached ??= {
    country: "GB",
    programTypes: [
      {
        key: "gb_paye",
        label: "Employer PAYE reference",
      },
    ],
    yearEnd: [
      {
        key: "p60",
        label: "P60 End of Year Certificate",
        cadence: "annual",
        description:
          "P60 End of Year Certificates for employees still employed at 5 April, from committed GB pay runs. "
          + "RTI (Full Payment Submission, Employer Payment Summary) and P11D benefits returns are out of scope "
          + "and refused by name below.",
        emptyText: "No P60-eligible employees with committed GB pay stubs for this year.",
        population: (orgId, taxYear) => p60Population(orgId, taxYear),
        parseRowId: parseGbStatementRowId,
        slip: { build: (orgId, taxYear, rowId) => p60Slip(orgId, taxYear, rowId) },
        downloadRefusal: `${RTI_REFUSAL} ${P11D_REFUSAL}`,
        amendment: gbStatementAmendment("P60"),
      },
      {
        key: "p45",
        label: "P45 leaver statements",
        // A SEPARATION document: due when the employee leaves, per leaver —
        // never a year-end return. The cadence routes it to the Separations
        // surface and the termination run's Finish step instead of the
        // year-end page. The pack CAN produce Parts 1A/2/3 from a
        // termination run; Part 1 rides the RTI leaver FPS and is refused
        // with the RTI standard by name.
        cadence: "separation",
        description:
          "P45 Parts 1A/2/3 for employees who left in the year, from committed GB pay runs. "
          + "Part 1 goes to HMRC through the Full Payment Submission (RTI, out of scope and refused by name below).",
        emptyText: "No leavers with committed GB pay stubs for this year.",
        population: (orgId, taxYear) => p45Population(orgId, taxYear),
        parseRowId: parseGbStatementRowId,
        slip: { build: (orgId, taxYear, rowId) => p45Slip(orgId, taxYear, rowId) },
        downloadRefusal:
          "the GB pack produces no RTI leaver submission — P45 Part 1 goes to HMRC through the Full Payment "
          + "Submission when the employee leaves. The Parts 1A/2/3 statement above is complete on screen; "
          + "report the leaving through RTI payroll software (gov.uk 'What to do when an employee leaves').",
        amendment: gbStatementAmendment("P45"),
      },
    ],
  };
  return cached;
}
