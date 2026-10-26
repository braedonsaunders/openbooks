import assert from "node:assert/strict";
import test from "node:test";
import PDFDocument from "pdfkit";
import { computeColumnWidths, PdfLayoutError } from "./table";
import type { PdfTableGroup, PdfTheme } from "./types";

const theme: PdfTheme = {
  primary: "#0f766e",
  text: "#111827",
  muted: "#6b7280",
  headerFill: "#f3f4f6",
  headerText: "#374151",
  headerBorder: "#d1d5db",
  rowBorder: "#eef2f7",
  zebra: "#f9fafb",
  empty: "#9ca3af",
  font: "Helvetica",
  fontBold: "Helvetica-Bold",
  body: 10,
  h1: 18,
  meta: 9,
  h2: 11.5,
  subtitle: 9,
  table: 9.5,
  cellPadX: 6,
  cellPadY: 4,
  groupGap: 20,
};
const group = (columns: string[], rows: PdfTableGroup["rows"]): PdfTableGroup => ({
  kind: "results",
  title: "Register",
  columns,
  rows,
});
function document() {
  const doc = new PDFDocument();
  doc.resume();
  return doc;
}

test("automatic widths preserve German financial labels, compact identifiers and padding", () => {
  const doc = document();
  try {
    const columns = [
      "Ausgabedatum",
      "Wertpapier",
      "Art",
      "Inhaber",
      "Aktiengattung",
      "Status",
      "Ausgegebene Menge",
      "Ausstehende Menge",
      "Preis je Aktie",
      "Währung",
    ];
    const row = [
      "19.10.2026",
      "NOTE-0001",
      "Anteilszertifikat",
      "Avery Quinn",
      "CS",
      "Ausstehend",
      "4.500.000",
      "4.500.000",
      "0,0001",
      "USD",
    ];
    const widths = computeColumnWidths(doc, group(columns, [row]), 735.3, theme);
    assert.ok(Math.abs(widths.reduce((a, b) => a + b, 0) - 735.3) < 0.001);
    for (const [column, token, bold] of [
      [1, "NOTE-0001", false],
      [2, "Anteilszertifikat", false],
      [4, "Aktiengattung", true],
      [5, "Ausstehend", false],
      [9, "Währung", true],
    ] as const) {
      doc.font(bold ? theme.fontBold : theme.font).fontSize(theme.table);
      assert.ok(
        widths[column]! - 2 * theme.cellPadX >= doc.widthOfString(token),
        `${token} must remain whole`,
      );
    }
  } finally {
    doc.end();
  }
});

test("late rows and independently styled evidence determine minimum widths", () => {
  const doc = document();
  try {
    const rows: PdfTableGroup["rows"] = Array.from({ length: 201 }, () => ["A", "B"]);
    rows.push([
      "ÄKT-0000123456789",
      { text: "Unused summary text", segments: [{ text: "Ausstehend", bold: true }] },
    ]);
    const widths = computeColumnWidths(doc, group(["Reference", "Status"], rows), 400, theme);
    doc.font(theme.font).fontSize(theme.table);
    assert.ok(widths[0]! >= doc.widthOfString("ÄKT-0000123456789") + 12);
    doc.font(theme.fontBold);
    assert.ok(widths[1]! >= doc.widthOfString("Ausstehend") + 12);
  } finally {
    doc.end();
  }
});

test("impossible automatic and weighted grids refuse with an actionable 422", () => {
  const doc = document();
  try {
    const data = group(["Reference", "Reference"], [["ÄKT-0000123456789", "ÄKT-0000123456789"]]);
    for (const configured of [data, { ...data, columnWeights: [1, 1] }]) {
      assert.throws(
        () => computeColumnWidths(doc, configured, 100, theme),
        (error: unknown) => {
          assert.ok(error instanceof PdfLayoutError);
          assert.equal(error.status, 422);
          assert.match(error.remedy, /wider page/);
          return true;
        },
      );
    }
  } finally {
    doc.end();
  }
});

test("Unicode zero-width break opportunities keep long text wrappable", () => {
  const doc = document();
  try {
    const text = "Aktien\u200b".repeat(100);
    doc.font(theme.font).fontSize(theme.table);
    assert.ok(doc.widthOfString(text) > 100, "the complete text cannot fit on one line");
    const widths = computeColumnWidths(doc, group(["Text"], [[text]]), 100, theme);
    assert.deepEqual(widths, [100]);
  } finally {
    doc.end();
  }
});
