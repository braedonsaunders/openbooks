import assert from "node:assert/strict";
import test from "node:test";
import { resolvePdfPageSetup } from "@openbooks/pdf";
import type { ReportRunResult } from "@openbooks/reports";

const { exportDataToCsv, exportDataToPdfInput, exportDataToRunResult, runResultToExportData } =
  await import("./report-pdf.ts");
const { reportExportFilename } = await import("./export.ts");

const page = resolvePdfPageSetup({
  paperSize: "letter",
  orientation: "landscape",
  marginMm: 12,
  density: "compact",
});

const capTable: ReportRunResult = {
  groups: [
    {
      kind: "summary",
      title: "Summary",
      columns: ["Share class", "Position type", "Holder", "Outstanding shares", "Fully diluted"],
      rows: [
        ["CS", "Shares", "Avery Quinn", "4500000", "4500000"],
        ["CS", "Unallocated pool", null, "0", "1820000"],
      ],
      align: ["left", "left", "left", "right", "right"],
      numberFormats: [null, null, null, "number", "number"],
    },
  ],
  summary: [
    { label: "Groups", value: 2 },
    { label: "Total fully diluted", value: "6320000", money: false, number: true },
  ],
  rowCount: 2,
};

test("a Reports-hub run prints numbers in the viewer locale, right-aligned, and keeps plain values in CSV", () => {
  const data = runResultToExportData(capTable, {
    title: "Cap table as of a date",
    dateRangeLabel: "as of 2025-10-01",
  });
  const pdf = exportDataToPdfInput(data, { orgName: "Northstar Cloud" }, page, { locale: "en" });
  assert.deepEqual(pdf.groups[0]!.align, ["left", "left", "left", "right", "right"]);
  assert.deepEqual(pdf.groups[0]!.rows[0], [
    "CS",
    "Shares",
    "Avery Quinn",
    "4,500,000",
    "4,500,000",
  ]);
  assert.deepEqual(pdf.summary, [
    { label: "Groups", value: "2" },
    { label: "Total fully diluted", value: "6,320,000" },
  ]);
  const french = exportDataToPdfInput(data, { orgName: "Northstar Cloud" }, page, { locale: "fr" });
  assert.equal(french.groups[0]!.rows[1]![4]!.toString().replace(/\s/g, " "), "1 820 000");
  assert.match(exportDataToCsv(data, {}), /\r\nCS,Shares,Avery Quinn,4500000,4500000\r\n/);
});

test("print right-aligns money and quantity columns of a group that declares no alignment", () => {
  const pdf = exportDataToPdfInput(
    {
      title: "Holdings",
      dateRangeLabel: "",
      summary: [],
      groups: [
        {
          kind: "results",
          title: "Holdings",
          columns: ["Holder", "Shares", "Paid"],
          rows: [["A", "1200", "10.0000"]],
          money: [false, false, true],
          numberFormats: [null, "number", null],
        },
      ],
    },
    { orgName: "Main Co" },
    page,
    { locale: "en" },
  );
  assert.deepEqual(pdf.groups[0]!.align, ["left", "right", "right"]);
  assert.deepEqual(pdf.groups[0]!.rows[0], ["A", "1,200", "10.00"]);
  const plain = exportDataToPdfInput(
    {
      title: "Notes",
      dateRangeLabel: "",
      summary: [],
      groups: [{ kind: "results", title: "Notes", columns: ["Note"], rows: [["1200"]] }],
    },
    { orgName: "Main Co" },
    page,
    { locale: "en" },
  );
  assert.equal(plain.groups[0]!.align, undefined);
  assert.deepEqual(plain.groups[0]!.rows[0], ["1200"], "untyped text prints as written");
});

test("a point-in-time export is named for its as-of date and any other for the day it was produced", () => {
  assert.equal(
    reportExportFilename("equity-cap-table", { asOf: "2025-10-01", producedOn: "2026-10-19" }),
    "equity-cap-table-2025-10-01",
  );
  assert.equal(
    reportExportFilename("equity-stock-compensation-schedule", { producedOn: "2026-10-19" }),
    "equity-stock-compensation-schedule-2026-10-19",
  );
  assert.equal(
    reportExportFilename('equity/cap "table"', { asOf: null, producedOn: "2026-10-19" }),
    "equity-cap table-2026-10-19",
  );
});

test("typed dates print in the reader language and retain civil ISO values in data exports", () => {
  const run: ReportRunResult = {
    groups: [
      {
        kind: "results",
        title: "Securities",
        columns: ["Issued", "Memo"],
        rows: [["2026-03-01", "2026-03-01"]],
        dates: [true, false],
      },
    ],
    summary: [],
    rowCount: 1,
  };
  const data = runResultToExportData(run, { title: "Securities", dateRangeLabel: "" });
  const pdf = exportDataToPdfInput(data, { orgName: "Main Co" }, page, { locale: "de" });
  assert.equal(
    pdf.groups[0]!.rows[0]![0],
    new Intl.DateTimeFormat("de", {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(new Date("2026-03-01T12:00:00Z")),
  );
  assert.equal(pdf.groups[0]!.rows[0]![1], "2026-03-01", "untyped text is preserved");
  assert.deepEqual(exportDataToRunResult(data).groups[0]!.dates, [true, false]);
  assert.match(exportDataToCsv(data, {}), /2026-03-01,2026-03-01/);
});
