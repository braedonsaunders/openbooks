import { add } from "../../money.ts";
import { filingAccountRef, filingAccountsById } from "../../payroll-filing.ts";
import { PayrollError } from "../../payroll-run.ts";
import { form941Worksheet, w2Slips } from "../../payroll-yearend.ts";
import type { PayrollFilingData, PayrollFilingSlipData, PayrollPackFilings } from "../../payroll-filing-registry.ts";

/**
 * The US pack's filing declaration: the Form 941 quarterly worksheet and the
 * W-2 box extract, both straight off the committed-stub subledger. Neither
 * declares an electronic file — the refusals name what is missing (941
 * e-file, SSA EFW2) instead of leaving a button that builds an
 * approximation. Destined for `PAYROLL_COUNTRY_PACKS.US.filings` (see the
 * packs.ts handoff).
 */

async function form941Population(orgId: string, taxYear: number): Promise<PayrollFilingData> {
  const quarters = await form941Worksheet(orgId, taxYear);
  return {
    rowKey: "rowId",
    columns: [
      { key: "quarter", label: "Quarter" },
      { key: "wages", label: "Wages", align: "right", money: true },
      { key: "fit", label: "Federal tax", align: "right", money: true },
      { key: "ssWages", label: "SS wages", align: "right", money: true },
      { key: "ssTax", label: "SS tax (both)", align: "right", money: true },
      { key: "medicareTax", label: "Medicare tax (both)", align: "right", money: true },
    ],
    rows: quarters.map((quarter) => ({
      rowId: `${quarter.filingAccountId ?? ""}:${quarter.quarter}`,
      quarter: `Q${quarter.quarter}`,
      wages: quarter.wages,
      fit: quarter.federalIncomeTax,
      ssWages: quarter.ssWages,
      ssTax: quarter.ssTax,
      medicareTax: quarter.medicareTax,
    })),
  };
}

async function w2Population(orgId: string, taxYear: number): Promise<PayrollFilingData> {
  const slips = await w2Slips(orgId, taxYear);
  return {
    rowKey: "rowId",
    columns: [
      { key: "employee", label: "Employee" },
      { key: "state", label: "State" },
      { key: "box1", label: "Box 1 wages", align: "right", money: true },
      { key: "box2", label: "Box 2 FIT", align: "right", money: true },
      { key: "box3", label: "Box 3 SS wages", align: "right", money: true },
      { key: "box4", label: "Box 4 SS tax", align: "right", money: true },
      { key: "box5", label: "Box 5 Medicare wages", align: "right", money: true },
      { key: "box6", label: "Box 6 Medicare tax", align: "right", money: true },
    ],
    rows: slips.map((slip) => ({
      rowId: `${slip.employeePartyId}:${slip.filingAccountId ?? ""}`,
      employee: slip.employeeName,
      state: slip.state,
      box1: slip.box1Wages,
      box2: slip.box2FederalIncomeTax,
      box3: slip.box3SsWages,
      box4: slip.box4SsTax,
      box5: slip.box5MedicareWages,
      box6: slip.box6MedicareTax,
    })),
  };
}

/**
 * One (EIN, quarter) worksheet row as the Form 941 lines it feeds — the IRS's
 * own line numbers. Line 5e is the form's computed total of the FICA columns.
 */
async function form941Slip(orgId: string, taxYear: number, rowId: string): Promise<PayrollFilingSlipData> {
  const quarters = await form941Worksheet(orgId, taxYear);
  const quarter = quarters.find((q) => `${q.filingAccountId ?? ""}:${q.quarter}` === rowId);
  if (!quarter) {
    throw new PayrollError(`no ${taxYear} Form 941 worksheet matches the requested quarter`);
  }
  const account = filingAccountRef(quarter.filingAccountId, await filingAccountsById(orgId));
  return {
    formCode: "US_941",
    formName: "Form 941 — Employer's Quarterly Federal Tax Return",
    formNumber: "Form 941",
    headerFields: [
      { label: "Employer identification number (EIN)", value: account.accountNumber ?? "Unassigned" },
      { label: "Report for this quarter", value: `Q${quarter.quarter} ${taxYear}` },
    ],
    boxes: [
      { code: "2", label: "Wages, tips, and other compensation", value: quarter.wages },
      { code: "3", label: "Federal income tax withheld from wages, tips, and other compensation", value: quarter.federalIncomeTax },
      { code: "5a", label: "Taxable social security wages", value: quarter.ssWages },
      { code: "5c", label: "Taxable Medicare wages & tips", value: quarter.medicareWages },
      {
        code: "5e",
        label: "Total social security and Medicare taxes (employee + employer)",
        value: add(quarter.ssTax, quarter.medicareTax),
        emphasis: true,
      },
    ],
    notes: [
      "Worksheet lines computed from committed stubs; Medicare tax includes Additional Medicare withholding.",
    ],
  };
}

/** One employee's W-2, box for box — the SSA/IRS printed box titles. */
async function w2Slip(orgId: string, taxYear: number, rowId: string): Promise<PayrollFilingSlipData> {
  const slips = await w2Slips(orgId, taxYear);
  const slip = slips.find((s) => `${s.employeePartyId}:${s.filingAccountId ?? ""}` === rowId);
  if (!slip) {
    throw new PayrollError(`no ${taxYear} W-2 matches the requested employee`);
  }
  const account = filingAccountRef(slip.filingAccountId, await filingAccountsById(orgId));
  return {
    formCode: "US_W2",
    formName: "Form W-2 — Wage and Tax Statement",
    formNumber: "Form W-2",
    headerFields: [
      { label: "Employee's name", value: slip.employeeName },
      { label: "State(s) of employment", value: slip.state || "—" },
      { label: "Employer identification number (EIN)", value: account.accountNumber ?? "Unassigned" },
      { label: "Tax year", value: String(taxYear) },
    ],
    boxes: [
      { code: "1", label: "Wages, tips, other compensation", value: slip.box1Wages },
      { code: "2", label: "Federal income tax withheld", value: slip.box2FederalIncomeTax },
      { code: "3", label: "Social security wages", value: slip.box3SsWages },
      { code: "4", label: "Social security tax withheld", value: slip.box4SsTax },
      { code: "5", label: "Medicare wages and tips", value: slip.box5MedicareWages },
      { code: "6", label: "Medicare tax withheld", value: slip.box6MedicareTax },
    ],
    notes: [
      "A W-2 carries one federal wage set; state lines are reported per state of employment.",
    ],
  };
}

/** Lazy for the same import-cycle reason as caPackFilings. */
let cached: PayrollPackFilings | null = null;

export function usPackFilings(): PayrollPackFilings {
  cached ??= buildUsPackFilings();
  return cached;
}

function buildUsPackFilings(): PayrollPackFilings {
  return {
  country: "US",
  programTypes: [
    { key: "us_ein", label: "Federal employer identification number (EIN)" },
    { key: "us_state_sui", label: "State unemployment insurance (SUI) account", requiresRegion: true },
  ],
  // No separationPayments mapping: the US pack declares no separation filing
  // (there is no federal ROE equivalent), so nothing consumes one. A filing
  // that needed it would be refused by name, not fed zeros.
  yearEnd: [
    {
      key: "941",
      label: "Form 941 quarterly worksheet",
      cadence: "quarterly",
      description: "Form 941 quarterly worksheet for US-pack employees, one return per EIN.",
      emptyText: "No committed US pay stubs for this year.",
      population: (orgId, taxYear) => form941Population(orgId, taxYear),
      slip: { build: (orgId, taxYear, rowId) => form941Slip(orgId, taxYear, rowId) },
      downloadRefusal:
        "the US pack produces no Form 941 e-file — the worksheet is the source data; "
        + "file the return with the IRS directly",
    },
    {
      key: "w2",
      label: "W-2 box data",
      cadence: "annual",
      description: "W-2 box data for US-pack employees, filed per EIN.",
      emptyText: "No committed US pay stubs for this year.",
      population: (orgId, taxYear) => w2Population(orgId, taxYear),
      slip: { build: (orgId, taxYear, rowId) => w2Slip(orgId, taxYear, rowId) },
      downloadRefusal:
        "the US pack does not produce the SSA EFW2 electronic W-2 file — the box data "
        + "is complete on screen; transmit W-2s through SSA Business Services Online",
    },
  ],
  };
}
