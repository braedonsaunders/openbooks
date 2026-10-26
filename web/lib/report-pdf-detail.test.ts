import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { XlsxMoneyRefusal } from "@openbooks/office";
import { generalLedgerExportData, isExactDecimalText, pdfMoney } from "./report-pdf-detail.ts";

// `report-pdf` is server-only in production. This suite runs it directly so
// the shared CSV/XLSX boundary is covered without weakening that production
// guard.
const {
  exportDataToPdfInput,
  exportDataToCsv,
  exportDataToRunResult,
  exportDataToXlsx,
  projectProfitabilityExportData,
  agingDetailExportData,
  journalExportData,
  registerExportData,
  partnerStatementExportData,
} = await import("./report-pdf.ts");
const { decimalRatio } = await import("./reports/decimals.ts");

const t = (key: string) => key;
const USD = { currency: "USD", minorUnits: { USD: 2, JPY: 0, BHD: 3 } };

test("project profitability export agrees with the table on decimalRatio margins", () => {
  // The producer stores margin = decimalRatio(net, revenue): a canonical
  // ratio, so net 25 / revenue 100 is '0.2500' — not '2500.0000'. The export
  // must print the same 25.0% the table displays.
  const margin = decimalRatio("25.0000", "100.0000");
  assert.equal(margin, "0.2500");
  const data = projectProfitabilityExportData(
    {
      from: "2026-01-01",
      to: "2026-01-31",
      rows: [],
      customers: [
        {
          customerId: "customer-1",
          customerName: "Exact Customer",
          rows: [
            {
              projectId: "project-1",
              projectName: "Exact Job",
              revenue: "100.0000",
              cogs: "50.0000",
              grossProfit: "50.0000",
              expenses: "25.0000",
              net: "25.0000",
              margin,
              hours: 1,
            },
          ],
          totals: {
            revenue: "100.0000",
            cogs: "50.0000",
            grossProfit: "50.0000",
            expenses: "25.0000",
            net: "25.0000",
            margin,
            hours: 1,
          },
        },
      ],
      totals: {
        revenue: "100.0000",
        cogs: "50.0000",
        grossProfit: "50.0000",
        expenses: "25.0000",
        net: "25.0000",
        margin,
        hours: 1,
      },
    },
    t,
  );

  assert.equal(data.groups[0]?.rows[0]?.[6], "25.0%");
  assert.equal(data.groups[0]?.rows[1]?.[6], "25.0%");
  assert.equal(data.groups[0]?.rows[2]?.[6], "25.0%");
});

test("project profitability export labels the Unassigned tie-out bucket", () => {
  // The data row carries the English fallback; the export must
  // print the translated bucket label, not the raw fallback or noCustomer.
  const data = projectProfitabilityExportData(
    {
      from: "2026-01-01",
      to: "2026-01-31",
      rows: [],
      customers: [
        {
          customerId: null,
          customerName: null,
          rows: [
            {
              projectId: "unassigned",
              projectName: "Unassigned",
              revenue: "500.0000",
              cogs: "0.0000",
              grossProfit: "500.0000",
              expenses: "300.0000",
              net: "200.0000",
              margin: null,
              hours: 0,
            },
          ],
          totals: {
            revenue: "500.0000",
            cogs: "0.0000",
            grossProfit: "500.0000",
            expenses: "300.0000",
            net: "200.0000",
            margin: null,
            hours: 0,
          },
        },
      ],
      totals: {
        revenue: "500.0000",
        cogs: "0.0000",
        grossProfit: "500.0000",
        expenses: "300.0000",
        net: "200.0000",
        margin: null,
        hours: 0,
      },
    },
    t,
  );

  assert.equal(data.groups[0]?.rows[0]?.[0], "projectProfitability.unassignedProject");
  assert.equal(data.groups[0]?.rows[1]?.[0], "  projectProfitability.unassignedProject");
});

test("general-ledger export mirrors the paper view with one section per account", () => {
  const data = generalLedgerExportData(
    {
      from: "2026-01-01",
      to: "2026-01-31",
      truncated: false,
      accounts: [
        {
          id: "account-1",
          number: "5210",
          name: "Overhead Allowance",
          type: "cogs",
          opening: "0.0000",
          closing: "125.0000",
          lines: [
            {
              entryId: "entry-1",
              entryNumber: "JE-100",
              date: "2026-01-31",
              party: null,
              memo: "Overhead applied",
              debit: "125.0000",
              credit: "0.0000",
              balance: "125.0000",
              docKind: null,
              docId: null,
            },
          ],
        },
      ],
    },
    "General Ledger",
    t,
  );

  assert.equal(data.groups.length, 1);
  assert.equal(data.groups[0]?.kind, "section");
  assert.equal(data.groups[0]?.title, "5210 Overhead Allowance");
  assert.deepEqual(data.groups[0]?.columns, [
    "generalLedger.columns.date",
    "generalLedger.columns.entry",
    "generalLedger.columns.detail",
    "trialBalance.columns.debits",
    "trialBalance.columns.credits",
    "export.columns.balance",
  ]);
  assert.equal(data.groups[0]?.rows[1]?.[1], "JE-100");
  assert.equal(data.groups[0]?.rows[1]?.[3], "125.0000");
});

test("detail exports disclose line truncation in the summary instead of silently omitting rows", () => {
  const gl = generalLedgerExportData(
    {
      from: "2026-01-01",
      to: "2026-01-31",
      truncated: true,
      accounts: [],
    },
    "General Ledger",
    t,
  );
  assert.ok(
    gl.summary.some((item) => item.label === "generalLedger.truncated"),
    `truncated GL export must warn, got summary: ${JSON.stringify(gl.summary)}`,
  );

  const journal = journalExportData(
    {
      entries: [],
      from: "2026-01-01",
      to: "2026-01-31",
      truncated: true,
    },
    "Journal",
    t,
  );
  assert.ok(
    journal.summary.some((item) => item.label === "journal.truncated"),
    `truncated journal export must warn, got summary: ${JSON.stringify(journal.summary)}`,
  );

  const register = registerExportData(
    {
      parties: [],
      from: "2026-01-01",
      to: "2026-01-31",
      side: "ar",
      truncated: true,
    },
    "A/R Register",
    t,
  );
  assert.ok(
    register.summary.some((item) => item.label === "registers.truncated"),
    `truncated register export must warn, got summary: ${JSON.stringify(register.summary)}`,
  );

  const statement = partnerStatementExportData(
    {
      party: { id: "party-1", name: "Acme" },
      side: "ar",
      from: "2026-01-01",
      to: "2026-01-31",
      opening: "0.0000",
      closing: "100.0000",
      lines: [],
      aging: {
        current: "100.0000",
        b1: "0.0000",
        b2: "0.0000",
        b3: "0.0000",
        b4: "0.0000",
        total: "100.0000",
      },
      truncated: true,
    },
    t,
  );
  assert.ok(
    statement.summary.some((item) => item.label === "registers.truncated"),
    `truncated partner-statement export must warn, got summary: ${JSON.stringify(statement.summary)}`,
  );
});

test("tabular exports carry the truncation notice instead of dropping the summary", async () => {
  const data = generalLedgerExportData(
    {
      from: "2026-01-01",
      to: "2026-01-31",
      truncated: true,
      accounts: [
        {
          id: "account-1",
          number: "5210",
          name: "Overhead Allowance",
          type: "cogs",
          opening: "0.0000",
          closing: "10.0000",
          lines: [],
        },
      ],
    },
    "General Ledger",
    t,
  );

  const result = exportDataToRunResult(data);
  const lastGroup = result.groups[result.groups.length - 1];
  assert.ok(
    lastGroup?.rows.some((row) => String(row[0] ?? "").includes("generalLedger.truncated")),
    `run result must end with the truncation notice, got: ${JSON.stringify(lastGroup?.rows.slice(-2))}`,
  );

  const csv = exportDataToCsv(data, {});
  assert.ok(
    csv.includes("generalLedger.truncated"),
    `truncated GL CSV must warn, got tail: ${JSON.stringify(csv.slice(-160))}`,
  );

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    (await exportDataToXlsx(data, {
      reportName: "General Ledger",
      generatedAt: new Date("2026-01-31T00:00:00Z"),
      money: USD,
    })) as unknown as ArrayBuffer,
  );
  const sheet = workbook.worksheets[workbook.worksheets.length - 1];
  assert.ok(
    String(sheet?.lastRow?.getCell(1).value ?? "").includes("generalLedger.truncated"),
    `truncated GL workbook must warn, got: ${JSON.stringify(sheet?.lastRow?.values)}`,
  );
});

test("tabular exports still warn when truncation left zero data groups", () => {
  const data = generalLedgerExportData(
    {
      from: "2026-01-01",
      to: "2026-01-31",
      truncated: true,
      accounts: [],
    },
    "General Ledger",
    t,
  );
  const emptyResult = exportDataToRunResult(data);
  assert.ok(
    emptyResult.groups.some((g) =>
      g.rows.some((row) => String(row[0] ?? "").includes("generalLedger.truncated")),
    ),
    "a truncated export with no data groups must still carry the cap notice",
  );
  assert.ok(
    exportDataToCsv(data, {}).includes("generalLedger.truncated"),
    "a truncated export with no rows must still disclose the cap in CSV",
  );
});

test("detail exports stay quiet when nothing was truncated", () => {
  const gl = generalLedgerExportData(
    {
      from: "2026-01-01",
      to: "2026-01-31",
      truncated: false,
      accounts: [],
    },
    "General Ledger",
    t,
  );
  assert.deepEqual(gl.summary, []);
});

test("general-ledger export preserves exact money strings and their column flags", () => {
  const data = generalLedgerExportData(
    {
      from: "2026-01-01",
      to: "2026-01-31",
      truncated: false,
      accounts: [
        {
          id: "account-1",
          number: "5210",
          name: "Overhead Allowance",
          type: "cogs",
          opening: "125.0000",
          closing: "9007199254740.9938",
          lines: [],
        },
      ],
    },
    "General Ledger",
    t,
  );

  assert.deepEqual(data.groups[0]?.money, [false, false, false, true, true, true]);
  assert.equal(data.groups[0]?.rows[0]?.[5], "125.0000");
  assert.equal(data.groups[0]?.rows[1]?.[5], "9007199254740.9938");
});

function generalLedgerFixture(value: string) {
  return generalLedgerExportData(
    {
      from: "2026-01-01",
      to: "2026-01-31",
      truncated: false,
      accounts: [
        {
          id: "account-1",
          number: "5210",
          name: "Overhead Allowance",
          type: "cogs",
          opening: value,
          closing: "0.0000",
          lines: [],
        },
      ],
    },
    "General Ledger",
    t,
  );
}

async function generalLedgerAdapterValues(value: string): Promise<{
  csv: string;
  runValue: string | number | null | undefined;
  xlsxValue: ExcelJS.CellValue;
  xlsxFormat: string;
}> {
  const data = generalLedgerFixture(value);

  const result = exportDataToRunResult(data);
  assert.deepEqual(result.groups[0]?.money, [false, false, false, true, true, true]);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    (await exportDataToXlsx(data, {
      reportName: "General Ledger",
      generatedAt: new Date("2026-01-31T00:00:00Z"),
      money: USD,
    })) as unknown as ArrayBuffer,
  );

  return {
    csv: exportDataToCsv(data, {}),
    runValue: result.groups[0]?.rows[0]?.[5],
    xlsxValue: workbook.worksheets[0]?.getCell("F5").value ?? null,
    xlsxFormat: workbook.worksheets[0]?.getCell("F5").numFmt ?? "",
  };
}

test("general-ledger CSV keeps exact money beyond 2^53, and the workbook refuses it rather than rounding", async () => {
  const exact = "9007199254740.9938";
  const data = generalLedgerFixture(exact);
  assert.equal(exportDataToRunResult(data).groups[0]?.rows[0]?.[5], exact);
  assert.match(exportDataToCsv(data, {}), /\r\n,,generalLedger\.opening,,,9007199254740\.9938\r\n/);
  // A numeric cell holds 15 significant digits; this amount has 17.
  await assert.rejects(
    exportDataToXlsx(data, {
      reportName: "General Ledger",
      generatedAt: new Date("2026-01-31T00:00:00Z"),
      money: USD,
    }),
    (error: unknown) =>
      error instanceof XlsxMoneyRefusal &&
      error.code === "xlsx_money_inexact" &&
      /CSV/.test(error.remedy),
  );
});

test("general-ledger CSV/XLSX adapters keep a normal exact money value: the workbook cell is that amount in its currency format", async () => {
  const exact = "125.0000";
  const values = await generalLedgerAdapterValues(exact);

  assert.equal(values.runValue, exact);
  assert.match(values.csv, /\r\n,,generalLedger\.opening,,,125\.0000\r\n/);
  assert.equal(values.xlsxValue, 125, "a numeric cell, exactly the amount");
  assert.equal(
    values.xlsxFormat,
    "[$USD] #,##0.00;([$USD] #,##0.00)",
    "the currency at its minor units",
  );
  const cents = await generalLedgerAdapterValues("-1234567.8900");
  assert.equal(cents.xlsxValue, -1234567.89);
});

test("pdfMoney prints exact ledger decimals IEEE-754 would corrupt", () => {
  // Past 2^53 (~15.95 significant digits) a Number() rounds cents away:
  // Number('9007199254740.9938') is already 9007199254740.994, and
  // Number('12345678901234567.8900') lands on ...568.00 — real money drift.
  assert.equal(pdfMoney("9007199254740.9938"), "9,007,199,254,740.99");
  assert.equal(pdfMoney("12345678901234567.8900"), "12,345,678,901,234,567.89");
});

test("pdfMoney rounds the exact value, not its double projection", () => {
  // Number('2.675') is really 2.67499999999999982…, which formats to "2.67";
  // the exact decimal string must half-round UP to "2.68".
  assert.equal(pdfMoney("2.675"), "2.68");
});

test("pdfMoney uses statement money conventions and locale separators", () => {
  assert.equal(pdfMoney("125"), "125.00");
  assert.equal(pdfMoney("-125.0000"), "-125.00");
  assert.equal(pdfMoney("-0.0000"), "0.00");
  assert.equal(pdfMoney("0"), "0.00");
  assert.equal(pdfMoney("0.005"), "0.01");
  assert.equal(pdfMoney("1234567.891", "de"), "1.234.567,89");
});

test("pdfMoney renders non-numeric text raw instead of throwing", () => {
  assert.equal(pdfMoney("n/a"), "n/a");
  assert.equal(pdfMoney("Acme GmbH"), "Acme GmbH");
});

test("isExactDecimalText separates ledger decimals from prose and dates", () => {
  assert.equal(isExactDecimalText("125.0000"), true);
  assert.equal(isExactDecimalText("-12.5"), true);
  assert.equal(isExactDecimalText("+7"), true);
  assert.equal(isExactDecimalText(""), false);
  assert.equal(isExactDecimalText("2026-01-31"), false);
  assert.equal(isExactDecimalText("12.5%"), false);
  assert.equal(isExactDecimalText("JE-100"), false);
});

test("styled observations retain exact values in tabular exports and their identity in PDF", () => {
  const exact = "9007199254740993.0100";
  const data = {
    title: "Observations",
    dateRangeLabel: "",
    summary: [],
    groups: [
      {
        kind: "results" as const,
        title: "",
        columns: ["Amount", "Observation"],
        money: [true, false],
        rows: [
          [
            { text: exact, textColor: "#123456", bold: true },
            {
              text: "Delivered; Held",
              segments: [
                { text: "Delivered", textColor: "#008800" },
                { text: "; Held", textColor: "#880000" },
              ],
            },
          ],
        ],
      },
    ],
  };
  assert.deepEqual(exportDataToRunResult(data).groups[0]?.rows, [[exact, "Delivered; Held"]]);
  assert.ok(exportDataToCsv(data, {}).includes(exact));
  const pdf = exportDataToPdfInput(
    data,
    { orgName: "Example" },
    { paperSize: "letter", orientation: "portrait", marginMm: 12, density: "standard" },
    { locale: "en" },
  );
  assert.deepEqual(pdf.groups[0]?.rows[0]?.[0], {
    text: pdfMoney(exact, "en"),
    textColor: "#123456",
    bold: true,
  });
  assert.deepEqual(pdf.groups[0]?.rows[0]?.[1], data.groups[0]?.rows[0]?.[1]);
});

test("aging exports preserve unknown due dates and disclose the actual aging basis without moving money columns", () => {
  const data = agingDetailExportData(
    "ap",
    {
      asOf: "2026-07-15",
      rows: [
        {
          partyName: "Supplier",
          reference: "BILL-1",
          dueDate: null,
          ageBasisDate: "2026-05-10",
          ageBasisSource: "posting_date",
          ageDays: 66,
          bucket: "b3",
          open: "500.0000",
          docCurrency: "CAD",
          txnOpen: "500.0000",
        },
        {
          partyName: "Supplier",
          reference: "BILL-2",
          dueDate: "2026-07-31",
          ageBasisDate: "2026-07-31",
          ageBasisSource: "due_date",
          ageDays: -16,
          bucket: "current",
          open: "200.0000",
          docCurrency: "CAD",
          txnOpen: "200.0000",
        },
      ],
      totals: {
        current: "200.0000",
        b1: "0.0000",
        b2: "0.0000",
        b3: "500.0000",
        b4: "0.0000",
        total: "700.0000",
      },
    },
    t,
  );
  const group = data.groups[0]!;
  assert.deepEqual(group.columns.slice(2, 5), [
    "aging.columns.due",
    "aging.columns.ageBasisDate",
    "aging.columns.ageBasisSource",
  ]);
  assert.deepEqual(group.rows[0], [
    "Supplier",
    "BILL-1",
    "",
    "2026-05-10",
    "aging.dateSources.posting_date",
    66,
    "aging.buckets.b3",
    "500.0000",
    "CAD",
    "500.0000",
  ]);
  assert.deepEqual(group.rows[1]?.slice(2, 5), [
    "2026-07-31",
    "2026-07-31",
    "aging.dateSources.due_date",
  ]);
  assert.equal(group.rows[2]?.[7], "700.0000");
  assert.deepEqual(group.money, [
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    true,
    false,
    true,
  ]);
  const csv = exportDataToCsv(data, {});
  assert.match(csv, /aging.columns.due/);
  assert.match(csv, /BILL-1,,2026-05-10,aging.dateSources.posting_date,66/);
  assert.match(csv, /BILL-2,2026-07-31,2026-07-31,aging.dateSources.due_date,-16/);
});
