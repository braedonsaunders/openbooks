/**
 * The SG pack's year-end filing declaration: Form IR8A under the
 * Auto-Inclusion Scheme (AIS).
 *
 * WHAT THIS SERVES. The AIS model, not the paper route: an AIS employer
 * "submit[s] [its] employees' employment income information to IRAS
 * electronically by 1 Mar" of the year after the income year and "do[es]
 * not need to issue the Form IR8A and/or Appendix 8A/Appendix 8B to [its]
 * employees" (IRAS, Explanatory Notes for Completion of Form IR8A &
 * Appendix 8A for YA2026 §4; IRAS, Reporting Employee Earnings (IR8A, App
 * 8A/8B)). The slip below is the AIS-model statement of earnings the
 * employer submits from — and may give to the employee "for their record".
 *
 * WHAT EACH BOX IS. Every box is cited to the authority's own item in
 * those Explanatory Notes (§§9–10), which letter the form's income items
 * a) to f) and number its deductions (I) to (IV):
 *
 * - Employment income (items a–d aggregate): the year's TAXABLE earnings
 *   paid through committed payroll. The subledger carries no bonus /
 *   director's-fee / allowance classification and no entitlement date, and
 *   the Notes assess bonuses "in the year that an employee becomes
 *   entitled" (§9b) and director's fees "in the year that a director
 *   becomes entitled" (§9c) — so payroll can only report the aggregate
 *   paid, and the slip says the employer must split it across the form's
 *   items before submitting (the W-2 "attributable figure, stated as such"
 *   precedent).
 * - Employee's compulsory CPF contribution (Deductions I): the `cpf_ee`
 *   deduction lines. The engine prices compulsory Table-1 shares only
 *   (Additional Wages are refused by name), which is exactly what §10(I)
 *   asks for ("Apply the appropriate CPF rates ... and exclude the amount
 *   of excess/voluntary CPF contributions").
 * - Employer's CPF contribution: the `cpf_er` employer-contribution lines
 *   (the compulsory Table-1 share priced in payroll). Employer CPF paid on
 *   the employee's behalf sits in the income section — §9 item d)1.
 *   allowances ("CPF contributions made by the employer on the employee's
 *   behalf") with the excess/voluntary part in item d)6. — so the slip
 *   carries the payroll-priced share and names d)6. as the employer's
 *   top-up point for anything paid outside payroll.
 *
 * THE CPF/SDL BOUNDARY. The Skills Development Levy is NOT employee
 * remuneration: "The levy payable for each employee is at 0.25% of the
 * monthly total wages", "collected by the CPF Board on behalf of" SWDA
 * (CPF Board, Skills Development Levy, transcribed in `./rates.ts`). Like
 * the CPF contributions themselves — which ride the Board's channel
 * ("Who should receive CPF contributions"), not salary payment — the levy
 * has no IR8A box and this filing prices none. There is deliberately no
 * withholding box anywhere here: Singapore levies no monthly income-tax
 * withholding (IRAS, Reporting Employee Earnings; Tax Clearance (IR21)),
 * so an IR8A reports remuneration and CPF, never a year's withholding.
 *
 * HONEST YEARS. Only 2026: the one year with transcribed CPF tables
 * (`sgRatesForTaxYear` refuses every other year by name, and without those
 * tables the compulsory-CPF deduction box cannot be priced). Prior years
 * are the pack's one remaining transcription and stay refused.
 */
import { sql } from "drizzle-orm";
import { add } from "../../money/money.ts";
import { db } from "../../platform/db.ts";
import { PayrollError } from "../error.ts";
import { assertPayrollCountryKnown } from "../country.ts";
import { assertPayrollFilingAccountKnown } from "../filing.ts";
import type {
  PayrollFilingData,
  PayrollFilingRowScope,
  PayrollFilingSlipData,
  PayrollYearEndFiling,
} from "../filing-registry.ts";
import { sgRatesForTaxYear } from "./cpf.ts";

/**
 * The row-id UUID shape, owned HERE rather than imported from
 * `../filing-registry.ts` (the canada/filings.ts precedent): that module
 * imports `./packs.ts`, which imports `./sg/pack.ts`, which imports this
 * module — a runtime import would re-enter packs evaluation while
 * `SG_PAYROLL_PACK` is still initializing (TDZ crash). The grammar is the
 * same lax shape the web layer guards `[id]` params with.
 */
const IR8A_ROW_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const num = (value: unknown): string => (value == null ? "0" : String(value));

/** One employee's IR8A figures, straight off committed stubs. */
export interface Ir8aSlip {
  employeePartyId: string;
  employeeName: string;
  /** Taxable earnings paid through committed payroll (Notes items a–d aggregate). */
  employmentIncome: string;
  /** `cpf_ee` deduction lines — compulsory employee CPF (Deductions I). */
  employeeCpf: string;
  /** `cpf_er` employer-contribution lines — compulsory employer CPF. */
  employerCpf: string;
  stubCount: number;
}

/**
 * The year's IR8A rows: one per employee with committed SG stubs.
 * REFUSES an untranscribed year (no CPF tables, no deduction box) and a
 * year with no committed runs (an empty statutory form is a wrong one) —
 * both by name, before authorizing a byte.
 */
export async function ir8aSlips(orgId: string, taxYear: number): Promise<Ir8aSlip[]> {
  sgRatesForTaxYear(taxYear);
  await assertPayrollCountryKnown(db, orgId, taxYear);
  await assertPayrollFilingAccountKnown(db, orgId, { taxYear });
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select s.employee_party_id, p.display_name,
           count(*)::int as stub_count,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = 'earning'
                  and coalesce(pc.taxable, true))) as employment_income,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = 'deduction'
                  and pc.system_key = 'cpf_ee')) as employee_cpf,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = 'employer_contribution'
                  and pc.system_key = 'cpf_er')) as employer_cpf
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
                       and r.run_status = 'committed'
      join parties p on p.id = s.employee_party_id and p.org_id = ${orgId}
     where s.org_id = ${orgId} and s.tax_year = ${taxYear} and s.country = 'SG'
     group by s.employee_party_id, p.display_name
     order by p.display_name
  `));
  if (rows.rows.length === 0) {
    throw new PayrollError(
      `no committed SG pay runs for ${taxYear} — Form IR8A reports remuneration actually paid, `
      + "so a year with nothing committed has no slip to issue",
    );
  }
  return rows.rows.map((row) => ({
    employeePartyId: String(row.employee_party_id),
    employeeName: String(row.display_name),
    employmentIncome: num(row.employment_income),
    employeeCpf: num(row.employee_cpf),
    employerCpf: num(row.employer_cpf),
    stubCount: Number(row.stub_count ?? 0),
  }));
}

/**
 * The IR8A row grammar, as the inverse of `ir8aPopulation`'s bare-employee
 * row ids (the RL-1 bare-id precedent: one national region, no
 * per-account filing). Owned HERE, beside the builder — the
 * subsidiary-scope guard parses through the declaration, never its own
 * copy of this shape.
 */
export function parseIr8aRowId(rowId: string): PayrollFilingRowScope | null {
  if (!IR8A_ROW_UUID_RE.test(rowId)) return null;
  return { employees: [rowId], accounts: [] };
}

async function ir8aPopulation(orgId: string, taxYear: number): Promise<PayrollFilingData> {
  const slips = await ir8aSlips(orgId, taxYear);
  return {
    rowKey: "rowId",
    columns: [
      { key: "employee", label: "Employee" },
      { key: "employmentIncome", label: "Employment income (a–d)", align: "right", money: true },
      { key: "employeeCpf", label: "Employee CPF", align: "right", money: true },
      { key: "employerCpf", label: "Employer CPF", align: "right", money: true },
    ],
    rows: slips.map((slip) => ({
      rowId: slip.employeePartyId,
      employee: slip.employeeName,
      employmentIncome: slip.employmentIncome,
      employeeCpf: slip.employeeCpf,
      employerCpf: slip.employerCpf,
    })),
    totals: [
      { label: "Slips", value: String(slips.length) },
      {
        label: "Employment income",
        value: slips.reduce((acc, slip) => add(acc, slip.employmentIncome), "0"),
        money: true,
      },
      {
        label: "Employee CPF",
        value: slips.reduce((acc, slip) => add(acc, slip.employeeCpf), "0"),
        money: true,
      },
      {
        label: "Employer CPF",
        value: slips.reduce((acc, slip) => add(acc, slip.employerCpf), "0"),
        money: true,
      },
    ],
  };
}

/** One employee's IR8A, box for box — the form's own item letters. */
async function ir8aSlip(orgId: string, taxYear: number, rowId: string): Promise<PayrollFilingSlipData> {
  const slips = await ir8aSlips(orgId, taxYear);
  const slip = slips.find((candidate) => candidate.employeePartyId === rowId);
  if (!slip) {
    throw new PayrollError(`no ${taxYear} Form IR8A matches the requested employee`);
  }
  return {
    formCode: "SG_IR8A",
    formName: "Form IR8A — Return of Employee's Remuneration (Auto-Inclusion Scheme)",
    formNumber: "Form IR8A",
    headerFields: [
      { label: "Employee's name", value: slip.employeeName },
      { label: "Year ended", value: `31 Dec ${taxYear}` },
      // No plaintext national identifier is persisted anywhere in this
      // product (the pack holds no NRIC/FIN column); the form requires it
      // on its face, so it is a named gap with its remedy, never a blank.
      {
        label: "NRIC/FIN",
        value: "Not held by payroll — enter from the employer's records before AIS submission",
      },
    ],
    boxes: [
      {
        code: "a–d",
        label: "Employment income — IR8A items a) to d) aggregate, taxable earnings paid through payroll",
        value: slip.employmentIncome,
        emphasis: true,
      },
      {
        code: "Ded(I)",
        label: "Employee's compulsory contribution to CPF / designated pension or provident fund (Deductions I)",
        value: slip.employeeCpf,
      },
      {
        code: "ER-CPF",
        label: "Employer's CPF contribution — compulsory Table-1 share priced in payroll (items d)1./d)6. scope)",
        value: slip.employerCpf,
      },
    ],
    notes: [
      "This declaration serves the Auto-Inclusion Scheme: submit employment-income information to IRAS "
      + "electronically by 1 Mar of the year after the income year; no hardcopy IR8A is issued to the "
      + "employee (a separate statement of earnings may be given for their record). (IRAS, Reporting "
      + "Employee Earnings (IR8A, App 8A/8B); Explanatory Notes for YA2026 §4)",
      "Employment income above is the year's taxable earnings PAID through committed payroll. Bonuses are "
      + "assessed in the year the employee becomes entitled and director's fees in the year the director "
      + "becomes entitled — split this total across the form's items a), b), c) and d)1.–d)8. before "
      + "submitting. (Explanatory Notes §§9a–d)",
      "Employee CPF is the compulsory Table-1 share priced in payroll. Any excess or voluntary employer "
      + "top-up paid outside payroll belongs in item d)6. by the employer. (Explanatory Notes §§9d)6., 10(I))",
      "Not carried by payroll lines — complete from the employer's records; a blank here is unreported, "
      + "not nil: benefits-in-kind (Appendix 8A, item d)9.), share-option gains (Appendix 8B, item d)7.), "
      + "donations, Mosque Building Fund contributions and life-insurance premiums. (Explanatory Notes "
      + "§§10(II)–(IV), 11)",
      "The Skills Development Levy is the employer's levy, collected by the CPF Board on behalf of SWDA — "
      + "not employee remuneration — and CPF contributions ride the Board's channel, not salary payment; "
      + "neither takes an IR8A box beyond the CPF boxes above. (CPF Board, Skills Development Levy; CPF "
      + "Board, Who should receive CPF contributions)",
      "Commencement and cessation dates (§5) are not carried on pay stubs — verify from HR records when the "
      + "employee joined or left during the year. Singapore levies no monthly income-tax withholding, so no "
      + "withholding box exists on this slip. (Explanatory Notes §5; IRAS, Reporting Employee Earnings)",
    ],
  };
}

/**
 * Why no AIS file exists: the IRAS AIS interface file specification is a
 * separate multi-week transcription and is not built — the box data above
 * is complete on screen, and is what the employer keys into AIS payroll
 * software or the IRAS myTax Portal.
 */
export const IR8A_DOWNLOAD_REFUSAL =
  "the SG pack produces no AIS submission file — the IRAS AIS interface file specification "
  + "is not transcribed; submit the slip figures electronically via AIS payroll software or "
  + "the IRAS myTax Portal by 1 Mar";

/**
 * How a wrong IR8A is corrected, as the Notes define it (§6): AIS
 * employers file an amendment submission (the DIFFERENCES — positive to
 * add, negative to negate, unaffected fields blank) or a revised
 * submission (the complete correct record, overwriting; no negatives);
 * employers off AIS give the employee an Additional or Revised paper
 * IR8A. No in-product correction file is built for any of these.
 */
export const IR8A_AMENDMENT_REFUSAL =
  "a wrong IR8A is corrected by an AIS amendment submission (the differences in amount: positive "
  + "values to add, negative values to negate, unaffected fields left blank) or a revised submission "
  + "(the complete accurate record, overwriting all previous submissions for the employee) via IRAS — "
  + "employers not on AIS give the employee an Additional or Revised paper IR8A instead; no in-product "
  + "correction file is built (IRAS, Explanatory Notes for Completion of Form IR8A & Appendix 8A "
  + "for YA2026 §6)";

/** Lazy for the same import-cycle reason as the CA/US pack filings. */
let cached: PayrollYearEndFiling | null = null;

/** The SG pack's IR8A declaration, wired onto the pack in `./pack.ts`. */
export function ir8aFiling(): PayrollYearEndFiling {
  cached ??= {
    key: "ir8a",
    label: "Form IR8A (Auto-Inclusion Scheme)",
    cadence: "annual",
    description:
      "The employer's annual REPORT of each employee's employment income to IRAS "
      + "(\"Employers are responsible for reporting the employment income of all individuals "
      + "who have worked for them\"), pre-filled into the employee's electronic return — "
      + "a report, not a withholding. Built from committed pay runs for the transcribed year; "
      + "serves the Auto-Inclusion Scheme (electronic submission, no paper slip to the employee).",
    emptyText: "No committed SG pay stubs for this year.",
    population: (orgId, taxYear) => ir8aPopulation(orgId, taxYear),
    parseRowId: parseIr8aRowId,
    slip: { build: (orgId, taxYear, rowId) => ir8aSlip(orgId, taxYear, rowId) },
    downloadRefusal: IR8A_DOWNLOAD_REFUSAL,
    amendment: { supported: false, refusal: IR8A_AMENDMENT_REFUSAL },
  };
  return cached;
}
