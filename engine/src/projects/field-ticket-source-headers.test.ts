import assert from "node:assert/strict";
import test from "node:test";
import {
  fieldTicketSourceHeaderRowSha256,
  findFieldTicketSourceHeaderRow,
  parseFieldTicketSourceHeaderTsv,
  parseFieldTicketSourceHeaders,
  FieldTicketSourceHeaderError,
} from "./field-ticket-source-headers.ts";

const HEADER = [
  "id",
  "TSNumber",
  "JobID",
  "EmpID",
  "CustomerID",
  "PPEBegin",
  "PPEEnd",
  "Billed",
  "FinalTimesheet",
  "ApprovalStatus",
  "ForemanID",
  "SuperintendentID",
  "PO",
  "Description",
].join("\t");
const ROW_100 = [
  "100",
  "M2406148079",
  "JOB-1",
  "E1",
  "C1",
  "2024-06-10",
  "2024-06-16",
  "No",
  "Yes",
  "Yes",
  "F1",
  "S1",
  "NULL",
  "Week one hundred",
].join("\t");

test("the TSV parser reads a full source export and finds row 100 by exact source id", () => {
  const rows = parseFieldTicketSourceHeaders(Buffer.from(`${HEADER}\n${ROW_100}\n`));
  assert.equal(rows.length, 1);
  const row = findFieldTicketSourceHeaderRow(rows, "100");
  assert.equal(row.number, "M2406148079");
  assert.equal(row.superintendentRef, "S1");
  assert.equal(row.po, null);
});

test("a missing superintendent column and an explicit null superintendent remain different source facts", () => {
  const thirteenColumn = parseFieldTicketSourceHeaderTsv(
    [
      "9",
      "FT-9",
      "JOB-1",
      "E1",
      "C1",
      "2024-06-10",
      "2024-06-16",
      "No",
      "Yes",
      "Yes",
      "F1",
      "NULL",
      "Week nine",
    ].join("\t"),
  );
  assert.equal("superintendentRef" in thirteenColumn[0]!, false);
  const explicitNull = parseFieldTicketSourceHeaderTsv(
    [
      "9",
      "FT-9",
      "JOB-1",
      "E1",
      "C1",
      "2024-06-10",
      "2024-06-16",
      "No",
      "Yes",
      "Yes",
      "F1",
      "NULL",
      "NULL",
      "Week nine",
    ].join("\t"),
  );
  assert.equal(explicitNull[0]!.superintendentRef, null);
  assert.notEqual(
    fieldTicketSourceHeaderRowSha256(thirteenColumn[0]!),
    fieldTicketSourceHeaderRowSha256(explicitNull[0]!),
  );
});

test("the JSON parser preserves a missing superintendent and an explicit null superintendent", () => {
  const base = {
    sourceId: "100",
    number: "M2406148079",
    jobRef: "JOB-1",
    empRef: "E1",
    customerRef: "C1",
    begin: "2024-06-10",
    end: "2024-06-16",
    billed: false,
    final: true,
    approval: "Yes",
    foremanRef: "F1",
    po: null,
    description: null,
  };
  const missing = parseFieldTicketSourceHeaders(Buffer.from(JSON.stringify([base])));
  assert.equal("superintendentRef" in missing[0]!, false);
  const explicitNull = parseFieldTicketSourceHeaders(
    Buffer.from(JSON.stringify([{ ...base, superintendentRef: null }])),
  );
  assert.equal(explicitNull[0]!.superintendentRef, null);
});

test("a missing source row refuses instead of certifying a client-asserted row", () => {
  const rows = parseFieldTicketSourceHeaders(Buffer.from(`${HEADER}\n${ROW_100}\n`));
  assert.throws(
    () => findFieldTicketSourceHeaderRow(rows, "999"),
    /not a row of the pinned retained source file/,
  );
});

test("duplicate source identities and impossible work periods refuse at the parser", () => {
  assert.throws(
    () => parseFieldTicketSourceHeaders(Buffer.from(`${HEADER}\n${ROW_100}\n${ROW_100}\n`)),
    (error: unknown) =>
      error instanceof FieldTicketSourceHeaderError && /appear once/.test(error.message),
  );
  const impossible = ROW_100.replace("2024-06-10", "2024-02-30");
  assert.throws(
    () => parseFieldTicketSourceHeaders(Buffer.from(`${HEADER}\n${impossible}\n`)),
    /invalid work period/,
  );
});

test("malformed TSV flags refuse in the shared parser instead of becoming false", () => {
  const malformed = ROW_100.replace("\tNo\tYes\tYes\t", "\tMaybe\tYes\tYes\t");
  assert.throws(
    () => parseFieldTicketSourceHeaderTsv(`${HEADER}\n${malformed}\n`),
    /malformed billed or final flag/,
  );
  assert.throws(
    () => parseFieldTicketSourceHeaders(Buffer.from(`${HEADER}\n${malformed}\n`)),
    /malformed billed or final flag/,
  );
});

test("an unrelated blank-job source row is retained, and a selected blank-job row refuses", () => {
  const blankJob = [
    "26928",
    "FT-26928",
    "",
    "E1",
    "C1",
    "2024-06-10",
    "2024-06-16",
    "No",
    "Yes",
    "Yes",
    "F1",
    "S1",
    "NULL",
    "No job named",
  ].join("\t");
  const rows = parseFieldTicketSourceHeaders(Buffer.from(`${HEADER}\n${ROW_100}\n${blankJob}\n`));
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.sourceId === "26928")!.jobRef, "");
  assert.equal(findFieldTicketSourceHeaderRow(rows, "100").number, "M2406148079");
  assert.throws(
    () => findFieldTicketSourceHeaderRow(rows, "26928"),
    /missing number, job or approval/,
  );
});

test("canonical JSON rows accept only exact keys and types", () => {
  const canonical = {
    sourceId: "100",
    number: "M2406148079",
    jobRef: "JOB-1",
    empRef: "E1",
    customerRef: "C1",
    begin: "2024-06-10",
    end: "2024-06-16",
    billed: false,
    final: true,
    approval: "Yes",
    foremanRef: "F1",
    superintendentRef: "S1",
    po: null,
    description: "Week one hundred",
  };
  assert.equal(
    parseFieldTicketSourceHeaders(Buffer.from(JSON.stringify([canonical])))[0]!.sourceId,
    "100",
  );
  assert.throws(
    () =>
      parseFieldTicketSourceHeaders(Buffer.from(JSON.stringify([{ ...canonical, billed: "Yes" }]))),
    /malformed billed flag/,
  );
  assert.throws(
    () =>
      parseFieldTicketSourceHeaders(
        Buffer.from(JSON.stringify([{ ...canonical, foremanRef: 42 }])),
      ),
    /malformed foremanRef reference/,
  );
  const aliased = { ...canonical } as Record<string, unknown>;
  delete aliased.sourceId;
  aliased.id = "100";
  assert.throws(
    () => parseFieldTicketSourceHeaders(Buffer.from(JSON.stringify([aliased]))),
    /unsupported field id/,
  );
});

test("malformed UTF-8 bytes refuse by name without byte repair", () => {
  const bytes = Buffer.concat([
    Buffer.from(`${HEADER}\n`, "utf8"),
    Buffer.from([0xff, 0xfe, 0x0a]),
  ]);
  assert.throws(() => parseFieldTicketSourceHeaders(bytes), /not valid UTF-8/);
});

test("numeric source rows of other than the two actual widths refuse", () => {
  const short = [
    "100",
    "M2406148079",
    "JOB-1",
    "E1",
    "C1",
    "2024-06-10",
    "2024-06-16",
    "No",
    "Yes",
    "Yes",
    "F1",
    "S1",
  ].join("\t");
  assert.throws(() => parseFieldTicketSourceHeaderTsv(`${HEADER}\n${short}\n`), /13- or 14-column/);
  assert.throws(
    () => parseFieldTicketSourceHeaders(Buffer.from(`${HEADER}\n${short}\n`)),
    /13- or 14-column/,
  );
  const extra = `${ROW_100}\tEXTRA`;
  assert.throws(() => parseFieldTicketSourceHeaderTsv(`${HEADER}\n${extra}\n`), /13- or 14-column/);
  // Header and blank lines still pass, and a full file still parses.
  assert.equal(parseFieldTicketSourceHeaders(Buffer.from(`\n${HEADER}\n${ROW_100}\n\n`)).length, 1);
});

test("malformed JSON refuses with its remedy", () => {
  assert.throws(() => parseFieldTicketSourceHeaders(Buffer.from("[{")), /not valid JSON/);
  assert.throws(
    () => parseFieldTicketSourceHeaders(Buffer.from("{}")),
    /array of source ticket header rows/,
  );
});
