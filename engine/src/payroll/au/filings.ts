/**
 * The AU pack's filing declaration.
 *
 * Single Touch Payroll (STP) is the reporting channel: the employer sends
 * tax and super information to the ATO on payday through STP-enabled
 * software and makes a finalisation declaration once the year-to-date
 * figures for the financial year are complete. The employee gets their
 * income statement from the ATO via myGov — there is no employer-issued
 * payment summary anymore — so this filing declares the finalisation,
 * populates the YTD figures it asserts (reconciled to the year's committed,
 * posted runs to the cent), and refuses the transmission by name. STP is a
 * filing on this pack, not a second engine.
 *
 * Cycle discipline (the ES-pack TDZ lesson): this module takes NO runtime
 * edge to `../packs.ts`. Filing-registry types arrive as `import type`
 * only; the row-id grammar lives in ./stp-finalisation.ts beside the
 * builder; the financial-year label comes off the pack's own AU_TAX_YEARS.
 */
import type {
  PayrollFilingData,
  PayrollFilingRowScope,
  PayrollFilingSlipData,
  PayrollPackFilings,
} from "../filing-registry.ts";
import { PayrollError } from "../error.ts";
import { add } from "../../money/money.ts";
import { auStpFinalisationRows } from "./stp-finalisation.ts";
import {
  auFinancialYearLabel,
  parseStpFinalisationRowId,
  stpReportableGross,
} from "./stp-figures.ts";

async function stpPopulation(orgId: string, taxYear: number): Promise<PayrollFilingData> {
  const rows = await auStpFinalisationRows(orgId, taxYear);
  const total = (pick: (row: (typeof rows)[number]) => string): string =>
    rows.map(pick).reduce((acc, value) => add(acc, value), "0");
  return {
    rowKey: "rowId",
    columns: [
      { key: "employee", label: "Employee" },
      { key: "gross", label: "Gross payments", align: "right", money: true },
      { key: "overtime", label: "Overtime", align: "right", money: true },
      { key: "bonuses", label: "Bonuses & commissions", align: "right", money: true },
      { key: "paidLeave", label: "Paid leave", align: "right", money: true },
      { key: "payg", label: "PAYG withheld", align: "right", money: true },
      { key: "sg", label: "SG liability", align: "right", money: true },
      { key: "sacrifice", label: "Salary sacrifice", align: "right", money: true },
    ],
    rows: rows.map((row) => ({
      rowId: row.employeePartyId,
      employee: row.employeeName,
      gross: row.gross,
      overtime: row.overtime,
      bonuses: row.bonusesCommissions,
      paidLeave: row.paidLeave,
      payg: row.paygWithheld,
      sg: row.sgLiability,
      sacrifice: row.salarySacrifice,
    })),
    totals: [
      { label: "Employees", value: String(rows.length) },
      { label: "Gross payments", value: total((row) => row.gross), money: true },
      { label: "PAYG withheld", value: total((row) => row.paygWithheld), money: true },
      { label: "SG liability", value: total((row) => row.sgLiability), money: true },
    ],
  };
}

/**
 * One employee's finalisation figures as the reconciliation the declaration
 * asserts — ATO STP Phase 2 vocabulary throughout ("Reporting the amounts
 * you have paid"). Box codes are the STP field names: STP has no printed
 * box numbers, so each label names the STP amount it feeds.
 */
async function stpSlip(orgId: string, taxYear: number, rowId: string): Promise<PayrollFilingSlipData> {
  const rows = await auStpFinalisationRows(orgId, taxYear);
  const row = rows.find((candidate) => candidate.employeePartyId === rowId);
  if (!row) {
    throw new PayrollError(`no ${taxYear} STP finalisation figures match the requested employee`);
  }
  return {
    formCode: "AU_STP",
    formName: "STP finalisation declaration — employee year-to-date reconciliation",
    formNumber: "STP finalisation",
    headerFields: [
      { label: "Employee's name", value: row.employeeName },
      { label: "Financial year", value: `${auFinancialYearLabel(taxYear)} (taxYear ${taxYear})` },
    ],
    boxes: [
      { code: "GROSS", label: "Gross payments — total YTD remuneration", value: row.gross },
      {
        code: "GROSS-STP",
        label: "Gross payments — STP-reportable (total less separately-itemised below)",
        value: stpReportableGross(row),
        emphasis: true,
      },
      { code: "OT", label: "Overtime", value: row.overtime },
      { code: "BONUS", label: "Bonuses and commissions", value: row.bonusesCommissions },
      { code: "LEAVE", label: "Paid leave", value: row.paidLeave },
      { code: "PAYG", label: "PAYG withholding (income tax + Medicare + STSL)", value: row.paygWithheld },
      {
        code: "SG",
        label: "Superannuation guarantee — employer liability accrued (not cash paid)",
        value: row.sgLiability,
        emphasis: true,
      },
      { code: "OTE", label: "Ordinary time earnings — SG base as priced", value: row.oteBase },
      {
        code: "SAL-SAC",
        label: "Salary-sacrificed amounts — pre-tax (super/other split not itemised)",
        value: row.salarySacrifice,
      },
    ],
    notes: [
      "This declaration states the figures above are fully and correctly reported for the financial year "
      + "and is due to the Commissioner of Taxation by 14 July (ATO STP employer reporting guidelines). "
      + "It is what flips the employee's ATO income statement to tax-ready in myGov.",
      "PAYG withholding is the one withholding collecting income tax, the Medicare levy and STSL "
      + "repayments (F2026L00716 Schedule 1, transcribed in ./schedule1-2027.ts).",
      "The SG liability is what STP carries — at a minimum the SG liability or OTE (ATO STP Phase 2 "
      + "employer reporting guidelines). Cash contributions actually paid to the fund are never "
      + "STP-reported. Priced at 12% of ordinary time earnings (SGAA 1992 s17A(2)).",
      "Allowances, directors' fees, employment termination payments and lump sums are NOT separately "
      + "itemised: the subledger carries no STP income-type classification for them, so any such "
      + "amounts paid through custom components sit in gross — itemise them in STP-enabled software.",
      "The employee's tax file number is deliberately absent: it is the STP matching key the employer "
      + "holds on the TFN declaration and enters in STP-enabled software, never a value this "
      + "reconciliation persists or prints.",
    ],
  };
}

export function auPackFilings(): PayrollPackFilings {
  return {
    country: "AU",
    programTypes: [
      {
        key: "ato_stp",
        label: "Single Touch Payroll (STP)",
      },
    ],
    yearEnd: [
      {
        key: "stp_finalisation",
        label: "STP finalisation declaration",
        cadence: "annual",
        description:
          "The employer's declaration that STP year-to-date figures for the "
          + "financial year are complete and final (due 14 July). Reported "
          + "through STP-enabled software — "
          + "https://www.ato.gov.au/businesses-and-organisations/"
          + "hiring-and-paying-your-workers/single-touch-payroll",
        emptyText: "No committed AU pay stubs for this year.",
        population: (orgId, taxYear) => stpPopulation(orgId, taxYear),
        parseRowId: (rowId: string): PayrollFilingRowScope | null =>
          parseStpFinalisationRowId(rowId),
        slip: { build: (orgId, taxYear, rowId) => stpSlip(orgId, taxYear, rowId) },
        downloadRefusal:
          "There is no ATO file this product builds: STP pay events, update "
          + "events and the finalisation indicator are transmitted by "
          + "STP-enabled payroll software over the ATO's STP channel, not as "
          + "a downloadable return — the reconciliation above is the complete "
          + "source data to lodge",
        amendment: {
          supported: false,
          refusal:
            "A finalised employee's figures are corrected with an STP update "
            + "event correcting the year-to-date amounts and, where the "
            + "finalisation indicator already went, an amended finalisation — "
            + "lodged through STP-enabled payroll software, which updates the "
            + "employee's myGov income statement. This pack builds no STP "
            + "events, so corrections cannot be made in-product",
        },
      },
    ],
  };
}
