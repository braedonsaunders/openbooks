import assert from "node:assert/strict";
import test from "node:test";
import {
  combineRetainedSourceClaims,
  parseRetainedPdfPage,
  parseRetainedSourceArtifact,
  parseRetainedSourceRow,
  type RetainedPdfSelection,
} from "./retained-source.ts";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const report =
  "Date Range: 2026-07-01 - 2026-07-31\nReport Date: 2026-09-11 02:09:52\nMorgan, Alex A $ 1,205.77\nOther, Person $ 100.00";
const reportSelection: RetainedPdfSelection = {
  page: 1,
  anchor: "Morgan, Alex A $ 1,205.77",
  fields: {
    value: { quote: "Morgan, Alex A $ 1,205.77", value: "1,205.77", format: "grouped-decimal" },
    periodFrom: {
      quote: "Date Range: 2026-07-01 - 2026-07-31",
      value: "2026-07-01",
      format: "iso-date",
    },
    periodTo: {
      quote: "Date Range: 2026-07-01 - 2026-07-31",
      value: "2026-07-31",
      format: "iso-date",
    },
    sourceIssueDate: {
      quote: "Report Date: 2026-09-11 02:09:52",
      value: "2026-09-11 02:09:52",
      format: "iso-timestamp-date",
    },
  },
};

test("multi-document binding preserves report coverage and paid date independently of the issued-row period", () => {
  const card = parseRetainedSourceRow(
    Buffer.from('{"id":"source-45","ppe":"2026-09-12","amount":1205.77}'),
    "",
    { sourceRowRefPointer: "/id", amountPointer: "/amount" },
  );
  const extracted = parseRetainedPdfPage(report, reportSelection);
  const stub = parseRetainedPdfPage("Employee Morgan, Alex Cheque Date: 09/16/2026", {
    page: 12,
    anchor: "Employee Morgan, Alex",
    fields: {
      sourcePaidDate: { quote: "Cheque Date: 09/16/2026", value: "09/16/2026", format: "us-date" },
    },
  });
  assert.deepEqual(combineRetainedSourceClaims([card, extracted, stub], "CAD"), {
    sourceRowRef: "source-45",
    value: "1205.77",
    currency: "CAD",
    periodFrom: "2026-07-01",
    periodTo: "2026-07-31",
    sourceIssueDate: "2026-09-11",
    sourcePaidDate: "2026-09-16",
  });
  assert.equal(extracted.row.page, 1);
  assert.equal(stub.row.page, 12);
  assert.match(extracted.rowSha256, /^[0-9a-f]{64}$/);
  assert.equal(card.row.ppe, "2026-09-12");
});

test("absent and ambiguous quotations, forged values and malformed dates never bind", () => {
  assert.throws(
    () => parseRetainedPdfPage(report, { ...reportSelection, anchor: "Missing recipient" }),
    /occurs once/,
  );
  assert.throws(() => parseRetainedPdfPage(report + "\n" + report, reportSelection), /occurs once/);
  assert.throws(
    () =>
      parseRetainedPdfPage(report, {
        ...reportSelection,
        fields: { value: { quote: reportSelection.anchor, value: "9999.00", format: "decimal" } },
      }),
    /absent/,
  );
  assert.throws(
    () =>
      parseRetainedPdfPage("Person Date: 02/30/2026", {
        page: 1,
        anchor: "Person",
        fields: {
          sourcePaidDate: { quote: "Date: 02/30/2026", value: "02/30/2026", format: "us-date" },
        },
      }),
    /valid civil date/,
  );
  assert.throws(
    () =>
      parseRetainedPdfPage("Person amount: 12,05.77", {
        page: 1,
        anchor: "Person",
        fields: {
          value: { quote: "amount: 12,05.77", value: "12,05.77", format: "grouped-decimal" },
        },
      }),
    /grouping/,
  );
});

test("currency is explicit native provenance and never inferred from a dollar glyph", () => {
  const row = parseRetainedPdfPage(report, {
    ...reportSelection,
    fields: {
      ...reportSelection.fields,
      sourceRowRef: { quote: reportSelection.anchor, value: "Morgan, Alex A", format: "text" },
    },
  });
  assert.throws(() => combineRetainedSourceClaims([row]), /bind currency/);
  assert.equal(combineRetainedSourceClaims([row], "CAD").currency, "CAD");
  assert.throws(
    () =>
      combineRetainedSourceClaims(
        [row, { row: {}, rowSha256: "", claims: { currency: "USD" } }],
        "CAD",
      ),
    /contradicts/,
  );
  assert.throws(
    () =>
      combineRetainedSourceClaims(
        [row, { row: {}, rowSha256: "", claims: { value: "1000.00" } }],
        "CAD",
      ),
    /disagree/,
  );
  assert.throws(
    () =>
      combineRetainedSourceClaims(
        [
          parseRetainedPdfPage("Currency: USD\n" + report, {
            ...reportSelection,
            fields: {
              ...reportSelection.fields,
              sourceRowRef: {
                quote: reportSelection.anchor,
                value: "Morgan, Alex A",
                format: "text",
              },
            },
          }),
        ],
        "CAD",
      ),
    /contradicts/,
  );
  assert.throws(
    () =>
      combineRetainedSourceClaims(
        [row, { row: { currency: "USD" }, rowSha256: "", claims: {} }],
        "CAD",
      ),
    /contradicts/,
  );
  const namedRecipient = parseRetainedPdfPage(report + "\nNguyen, Tim $ 50.00\nOther CAD $ 20.00", {
    ...reportSelection,
    fields: {
      ...reportSelection.fields,
      sourceRowRef: { quote: reportSelection.anchor, value: "Morgan, Alex A", format: "text" },
    },
  });
  assert.deepEqual(
    namedRecipient.row.printedCurrencyCodes,
    [],
    "names and words adjacent to money are not currency declarations",
  );
  assert.equal(combineRetainedSourceClaims([namedRecipient], "CAD").currency, "CAD");
});

test("real retained PDF extraction binds the selected page and refuses a forged page or JSON selectors", async () => {
  const PDFDocument = require("pdfkit");
  const doc = new PDFDocument({ size: "LETTER" });
  const chunks: Buffer[] = [];
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  doc.text(report);
  doc.addPage().text("Different recipient and amount");
  doc.end();
  const bytes = await finished;
  const parsed = await parseRetainedSourceArtifact(bytes, "application/pdf", {
    fileId: "f",
    versionId: "v",
    rowPointer: "",
    pdfSelection: reportSelection,
  });
  assert.equal(parsed.claims?.value, "1205.77");
  await assert.rejects(
    parseRetainedSourceArtifact(bytes, "application/pdf", {
      fileId: "f",
      versionId: "v",
      rowPointer: "",
      pdfSelection: { ...reportSelection, page: 2 },
    }),
    /occurs once/,
  );
  await assert.rejects(
    parseRetainedSourceArtifact(bytes, "application/pdf", {
      fileId: "f",
      versionId: "v",
      rowPointer: "/0",
      pdfSelection: reportSelection,
    }),
    /cannot be combined/,
  );
});
