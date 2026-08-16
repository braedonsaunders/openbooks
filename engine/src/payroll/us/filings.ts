import { form941Worksheet, w2Slips } from "../../payroll-yearend.ts";
import type { PayrollFilingData, PayrollPackFilings } from "../../payroll-filing-registry.ts";

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
      description: "Form 941 quarterly worksheet for US-pack employees, one return per EIN.",
      emptyText: "No committed US pay stubs for this year.",
      population: (orgId, taxYear) => form941Population(orgId, taxYear),
      downloadRefusal:
        "the US pack produces no Form 941 e-file — the worksheet is the source data; "
        + "file the return with the IRS directly",
    },
    {
      key: "w2",
      label: "W-2 box data",
      description: "W-2 box data for US-pack employees, filed per EIN.",
      emptyText: "No committed US pay stubs for this year.",
      population: (orgId, taxYear) => w2Population(orgId, taxYear),
      downloadRefusal:
        "the US pack does not produce the SSA EFW2 electronic W-2 file — the box data "
        + "is complete on screen; transmit W-2s through SSA Business Services Online",
    },
  ],
  };
}
