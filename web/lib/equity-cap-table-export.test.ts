import assert from "node:assert/strict";
import test from "node:test";
import type { CapTableView } from "@openbooks/engine/equity";
import ExcelJS from "exceljs";
import {
  capTableExportData,
  capTableExportHref,
  type CapTableExportLabels,
} from "./equity-cap-table-export";
import { exportDataToCsv, exportDataToPdfInput, exportDataToXlsx } from "./report-pdf";

const labels: CapTableExportLabels = {
  title: "Main Co — cap table",
  dateRange: "As of 2026-07-31",
  class: "Class",
  kind: (kind) => kind,
  holder: "Holder",
  column: (key) => `[${key}]`,
  total: "Total",
  pool: "Available pool",
};

const view = {
  entity: { id: "sub", name: "Main Co", currency: "CAD" },
  hasAccountPolicy: true,
  parties: { founder: "Founder One" },
  table: {
    asOf: "2026-07-31",
    classes: [
      {
        shareClassId: "cs",
        code: "CS",
        name: "Common",
        kind: "common",
        seniority: 0,
        authorized: "10000000",
        outstanding: "9007199254740993",
        asConvertedOutstanding: "9007199254740993",
        awardsOutstanding: "0",
        poolAvailable: "0",
        fullyDiluted: "9007199254740993",
        conversionRatio: "1.0000000000",
        parValue: "0.0001000000",
        originalIssuePrice: null,
        conversionPrice: null,
        outstandingPercent: "100.0000",
        fullyDilutedPercent: "100.0000",
      },
    ],
    holders: [
      {
        holderPartyId: "founder",
        sharesByClass: { cs: "9007199254740993" },
        asConvertedOutstanding: "9007199254740993",
        options: "0",
        rsus: "0",
        warrants: "0",
        vestedAwards: "0",
        fullyDiluted: "9007199254740993",
        outstandingPercent: "100.0000",
        fullyDilutedPercent: "100.0000",
      },
    ],
    unallocatedPool: { fullyDiluted: "0", fullyDilutedPercent: "0.0000" },
    plans: [],
    holdings: [],
    convertibles: [],
    totals: {
      outstanding: "9007199254740993",
      asConvertedOutstanding: "9007199254740993",
      awardsOutstanding: "0",
      poolAvailable: "0",
      fullyDiluted: "9007199254740993",
    },
  },
} as CapTableView;

const all = (dimension: "class" | "holder") => ({
  dimension,
  instrument: "all" as const,
  query: "",
});

test("the cap table exports by class and by holder with share counts kept as exact text", () => {
  const byClass = capTableExportData(view, all("class"), labels);
  assert.equal(
    byClass.groups[0]!.rows[0]![2],
    "9007199254740993",
    "a count above 2^53 is never coerced through a float",
  );
  assert.equal(byClass.groups[0]!.columns.length, byClass.groups[0]!.rows[0]!.length);
  const byHolder = capTableExportData(view, all("holder"), labels);
  assert.deepEqual(byHolder.groups[0]!.columns.slice(0, 2), ["Holder", "CS"]);
  assert.equal(byHolder.groups[0]!.rows[0]![0], "Founder One");
  assert.deepEqual(
    byHolder.groups[0]!.rows.at(-1)!.slice(0, 2),
    ["Total", "9007199254740993"],
    "the totals row the page shows closes the export",
  );
});

test("the export link carries the legal entity, date and every filter the page applies", () => {
  assert.equal(
    capTableExportHref("sub", "2026-07-31", all("holder")),
    "/api/equity/cap-table/export?subsidiaryId=sub&asOf=2026-07-31&by=holder",
  );
  assert.equal(
    capTableExportHref("sub", "2026-07-31", {
      dimension: "class",
      instrument: "option",
      query: "Series A",
    }),
    "/api/equity/cap-table/export?subsidiaryId=sub&asOf=2026-07-31&by=class&instrument=option&q=Series+A",
  );
});

test("cap table quantities are numbers in Excel, locale-formatted and right-aligned in the PDF, and plain in CSV", async () => {
  const common = view.table.classes[0]!;
  const ordinary = {
    ...view,
    table: {
      ...view.table,
      classes: [
        {
          ...common,
          outstanding: "8448000",
          asConvertedOutstanding: "8448000",
          fullyDiluted: "11600000",
          outstandingPercent: "47.2366",
          fullyDilutedPercent: "55.0198",
        },
      ],
    },
  } as CapTableView;
  const data = capTableExportData(ordinary, all("class"), labels);
  const group = data.groups[0]!;
  const percentAt = group.columns.indexOf("[outstandingPercent]");
  const outstandingAt = group.columns.indexOf("[outstanding]");
  assert.ok(percentAt > 0 && outstandingAt > 0);
  assert.equal(group.numberFormats?.[0], null);
  assert.equal(group.numberFormats?.[outstandingAt], "number");
  assert.equal(group.numberFormats?.[percentAt], "percent");

  // CSV stays machine-readable: no grouping, percentage points under a "%" heading.
  const csvLine = exportDataToCsv(data, {}).split("\r\n")[1]!;
  assert.ok(csvLine.includes(",8448000,"), csvLine);
  assert.ok(csvLine.includes(",47.2366,"), csvLine);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    (await exportDataToXlsx(data, {
      reportName: data.title,
      generatedAt: new Date("2026-07-31T00:00:00Z"),
      money: null,
    })) as unknown as ArrayBuffer,
  );
  const sheet = workbook.worksheets[0]!;
  assert.equal(sheet.getCell(5, outstandingAt + 1).value, 8448000);
  assert.equal(sheet.getCell(5, outstandingAt + 1).numFmt, "#,##0");
  assert.equal(sheet.getCell(5, percentAt + 1).value, 47.2366);
  assert.equal(sheet.getCell(5, percentAt + 1).numFmt, '#,##0.0000"%"');

  const page = {
    paperSize: "letter",
    orientation: "landscape",
    marginMm: 12,
    density: "compact",
  } as never;
  const english = exportDataToPdfInput(data, { orgName: "Main Co" }, page, { locale: "en" })
    .groups[0]!;
  assert.equal(english.rows[0]![outstandingAt], "8,448,000");
  assert.equal(english.rows[0]![percentAt], "47.2366%");
  assert.equal(english.align?.[outstandingAt], "right");
  const german = exportDataToPdfInput(data, { orgName: "Main Co" }, page, { locale: "de" })
    .groups[0]!;
  assert.equal(german.rows[0]![outstandingAt], "8.448.000");
  assert.equal(String(german.rows[0]![percentAt]).replace(/\s/g, " "), "47,2366 %");
  // A count beyond 2^53 still prints exactly.
  const exact = exportDataToPdfInput(
    capTableExportData(view, all("class"), labels),
    { orgName: "Main Co" },
    page,
    { locale: "en" },
  ).groups[0]!;
  assert.equal(exact.rows[0]![outstandingAt], "9,007,199,254,740,993");
});
