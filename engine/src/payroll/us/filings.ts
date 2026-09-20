import { add, cmp } from "../../money/money.ts";
import { filingAccountRef, filingAccountsById } from "../filing.ts";
import { PayrollError } from "../error.ts";
import { form941Worksheet, w2Slips } from "../yearend.ts";
import { build941X, buildW2c } from "../w2c.ts";
import { isFilingRowUuid } from "../filing-registry.ts";
import type {
  PayrollFilingData,
  PayrollFilingRowScope,
  PayrollFilingSlipData,
  PayrollPackFilings,
  PayrollSlipBox,
} from "../filing-registry.ts";

/**
 * The US pack's filing declaration: the Form 941 quarterly worksheet and the
 * W-2 box extract, both straight off the committed-stub subledger. Neither
 * declares an electronic file — the refusals name what is missing (941
 * e-file, SSA EFW2) instead of leaving a button that builds an
 * approximation. Destined for `PAYROLL_COUNTRY_PACKS.US.filings` (see the
 * packs.ts handoff).
 */

/**
 * W-2 lines this product does NOT produce, named rather than printed as zeros
 * an employer might file (the RLZ-1.S `RLZ1S_GAPS` pattern). Boxes 15–20
 * themselves ARE reported from the committed-stub subledger (see `w2Slip`);
 * what remains is the employer's state-assigned ID number inside box 15,
 * which exists only where the state has a SUI filing account on file.
 */
/**
 * The Form 941 row grammar, as the inverse of form941Population's
 * `account:quarter` construction (the account empty for the unassigned
 * aggregate). Owned HERE, beside the builder — the subsidiary-scope guard
 * parses through the declaration, never its own copy of this shape.
 */
export function parse941RowId(rowId: string): PayrollFilingRowScope | null {
  const parts = rowId.split(":");
  const account = parts[0] ?? "";
  const quarter = parts[1] ?? "";
  if (parts.length !== 2 || (account && !isFilingRowUuid(account)) || !/^[1-4]$/.test(quarter)) {
    return null;
  }
  return { employees: [], accounts: account ? [account] : [] };
}

/**
 * The W-2 row grammar, as the inverse of w2Population's
 * `employee:account` construction. Owned here for the same reason.
 */
export function parseW2RowId(rowId: string): PayrollFilingRowScope | null {
  const parts = rowId.split(":");
  const employee = parts[0] ?? "";
  const account = parts[1] ?? "";
  if (parts.length !== 2 || !isFilingRowUuid(employee)) return null;
  if (account && !isFilingRowUuid(account)) return null;
  return { employees: [employee], accounts: account ? [account] : [] };
}

export const W2_GAPS = [
  "the employer's state ID number (W-2 box 15) is the SUI account number where the work state " +
    "has one on file — a state with no SUI account names the state with no ID; enter the ID before filing",
];

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

/**
 * Boxes 15–20 for one work state, in the General Instructions' vocabulary
 * (two-letter state abbreviation and state-assigned ID in 15; state wages in
 * 16; state income tax in 17; local wages, local tax and locality name in
 * 18–20). A box whose subledger amount is zero is OMITTED, never printed as
 * a zero the employer would file as a real amount; box 15 names the state
 * even where no state ID is on file (see W2_GAPS). Exported for the pure
 * box-suppression tests — the slip itself needs a database, but the
 * "never print a zero" rule must not.
 */
export function w2StateBoxes(
  state: string,
  employerStateId: string | null,
  stateWages: string,
  stateIncomeTax: string,
  localLines: readonly { locality: string; box18LocalWages: string; box19LocalIncomeTax: string }[],
): PayrollSlipBox[] {
  const boxes: PayrollSlipBox[] = [
    {
      code: "15",
      label: `State / Employer's state ID number — ${state}`,
      value: employerStateId ?? "Unassigned",
    },
  ];
  if (cmp(stateWages, "0") !== 0) {
    boxes.push({ code: "16", label: `State wages, tips, etc. — ${state}`, value: stateWages });
  }
  if (cmp(stateIncomeTax, "0") !== 0) {
    boxes.push({ code: "17", label: `State income tax — ${state}`, value: stateIncomeTax });
  }
  for (const local of localLines) {
    if (cmp(local.box18LocalWages, "0") !== 0) {
      boxes.push({
        code: "18", label: `Local wages, tips, etc. — ${local.locality}`, value: local.box18LocalWages,
      });
    }
    if (cmp(local.box19LocalIncomeTax, "0") !== 0) {
      boxes.push({
        code: "19", label: `Local income tax — ${local.locality}`, value: local.box19LocalIncomeTax,
      });
    }
    boxes.push({ code: "20", label: "Locality name", value: local.locality });
  }
  return boxes;
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
      ...slip.stateLines.flatMap((line) =>
        w2StateBoxes(
          line.state, line.employerStateId,
          line.box16StateWages, line.box17StateIncomeTax, line.localLines,
        )),
    ],
    notes: [
      "A W-2 carries one federal wage set (boxes 1-6); each work state that withheld repeats its own boxes 15-20 group on this copy, so a mid-year mover's states are never totalled into one row.",
      "State wages (box 16) are the taxable earnings of that state's committed stubs — the subledger carries no separate state wage base.",
      "State and local lines reflect committed stubs in this system; pre-adoption state amounts are not attributed by state and stay in the federal boxes.",
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
      parseRowId: parse941RowId,
      slip: { build: (orgId, taxYear, rowId) => form941Slip(orgId, taxYear, rowId) },
      downloadRefusal:
        "the US pack produces no Form 941 e-file — the worksheet is the source data; "
        + "file the return with the IRS directly",
      // A filed quarter cannot be withdrawn: the IRS has no cancellation for
      // Form 941. It is corrected on Form 941-X, which reports the corrected
      // amount, the amount originally reported, and the difference — so this
      // filing declares `amended` and ONLY `amended`.
      amendment: {
        supported: true,
        revisions: ["amended"],
        vehicle: "correction_form",
        formLabel: "Form 941-X",
        slip: { build: async (row, _orgId, taxYear) => build941X(row, taxYear) },
        downloadRefusal:
          "no electronic Form 941-X is generated, the same gap the original Form 941 declares — "
          + "the three-column adjustment above is complete; file the adjusted return with the "
          + "IRS directly",
      },
    },
    {
      key: "w2",
      label: "W-2 box data",
      cadence: "annual",
      description: "W-2 box data for US-pack employees, filed per EIN.",
      emptyText: "No committed US pay stubs for this year.",
      population: (orgId, taxYear) => w2Population(orgId, taxYear),
      parseRowId: parseW2RowId,
      slip: { build: (orgId, taxYear, rowId) => w2Slip(orgId, taxYear, rowId) },
      downloadRefusal:
        "the US pack does not produce the SSA EFW2 electronic W-2 file — the box data "
        + "is complete on screen; transmit W-2s through SSA Business Services Online",
      // The IRS corrects a W-2 on a WHOLLY SEPARATE form, not by re-filing the
      // W-2: Form W-2c carries both the previously reported and the correct
      // amount for every box being corrected, transmitted on Form W-3c.
      // Cancelling is supported because a W-2 filed in error is withdrawn the
      // same way — a W-2c correcting the amounts to nil, since the SSA has no
      // delete transaction for a filed W-2.
      amendment: {
        supported: true,
        revisions: ["amended", "cancelled"],
        vehicle: "correction_form",
        formLabel: "Form W-2c",
        slip: { build: async (row, _orgId, taxYear) => buildW2c(row, taxYear) },
        downloadRefusal:
          "no SSA EFW2C electronic correction file is generated, the same gap the original W-2 "
          + "declares for EFW2 — print and file the Form W-2c above with its Form W-3c, or key "
          + "the corrections into SSA Business Services Online",
      },
    },
  ],
  };
}
