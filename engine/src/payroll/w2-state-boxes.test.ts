import assert from "node:assert/strict";
import test from "node:test";
import {
  buildW2StateLines,
  openingYtdIntoW2Slip,
  type W2LocalLine,
  type W2Slip,
} from "./yearend.ts";
import { w2StateBoxes } from "./us/filings.ts";

/**
 * W-2 boxes 15–20 from the committed-stub subledger.
 *
 * Pure coverage for the two rules a database cannot be required to prove:
 * two work states are never smashed into one row, and a zero is never
 * printed where the employer would file a real amount. The end-to-end
 * goldens (committed stubs → slip boxes) live in
 * payroll-w2-state-lines.integration.test.ts.
 */

const slip = (overrides: Partial<W2Slip> = {}): W2Slip => ({
  employeePartyId: "e1",
  employeeName: "Emp e1",
  states: ["AZ"],
  state: "AZ",
  filingAccountId: null,
  box1Wages: "48000.0000",
  box2FederalIncomeTax: "6000.0000",
  box3SsWages: "48000.0000",
  box4SsTax: "2976.0000",
  box5MedicareWages: "48000.0000",
  box6MedicareTax: "696.0000",
  stateLines: [],
  ...overrides,
});

const localsOf = (byState: Record<string, W2LocalLine[]>) => (province: string) => byState[province] ?? [];
const stateIdOf = (ids: Record<string, string>) => (province: string) => ids[province] ?? null;

test("two withholding states stay two entries, with their own wages and tax", () => {
  const lines = buildW2StateLines(
    [
      { province: "AZ", wages: "20000.0000", stateTax: "512.0000" },
      { province: "CA", wages: "28000.0000", stateTax: "930.0000" },
    ],
    localsOf({}),
    stateIdOf({ AZ: "AZ-001", CA: "CA-002" }),
  );
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((line) => line.state), ["AZ", "CA"]);
  assert.equal(lines[0]!.box16StateWages, "20000.0000");
  assert.equal(lines[0]!.box17StateIncomeTax, "512.0000");
  assert.equal(lines[0]!.employerStateId, "AZ-001");
  assert.equal(lines[1]!.box16StateWages, "28000.0000");
  assert.equal(lines[1]!.employerStateId, "CA-002");
});

test("a state with stubs but no state or local withholding gets no entry", () => {
  const lines = buildW2StateLines(
    [
      { province: "TX", wages: "48000.0000", stateTax: "0" },
      { province: "AZ", wages: "2000.0000", stateTax: "51.2000" },
    ],
    localsOf({}),
    stateIdOf({}),
  );
  assert.deepEqual(lines.map((line) => line.state), ["AZ"]);
});

test("a locality-only state is kept, with a null state ID where no SUI account is on file", () => {
  const lines = buildW2StateLines(
    [{ province: "OH", wages: "2000.0000", stateTax: "0" }],
    localsOf({
      OH: [{ locality: "School district 4401 income tax", box18LocalWages: "2000.0000", box19LocalIncomeTax: "20.0000" }],
    }),
    stateIdOf({}),
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.employerStateId, null);
  assert.equal(lines[0]!.localLines.length, 1);
});

test("a group with no work-state code earns no state entry", () => {
  const lines = buildW2StateLines(
    [{ province: "", wages: "48000.0000", stateTax: "900.0000" }],
    localsOf({}),
    stateIdOf({}),
  );
  assert.deepEqual(lines, []);
});

test("state boxes print 15/16/17 and omit zero wages and zero tax", () => {
  const boxes = w2StateBoxes("AZ", "AZ-001", "20000.0000", "512.0000", []);
  assert.deepEqual(boxes.map((box) => box.code), ["15", "16", "17"]);
  assert.equal(boxes[0]!.value, "AZ-001");
  assert.match(boxes[0]!.label, /AZ/);

  const emptyTax = w2StateBoxes("AZ", "AZ-001", "20000.0000", "0", []);
  assert.deepEqual(emptyTax.map((box) => box.code), ["15", "16"]);

  const emptyWages = w2StateBoxes("AZ", "AZ-001", "0", "512.0000", []);
  assert.deepEqual(emptyWages.map((box) => box.code), ["15", "17"]);
});

test("a missing state ID names the state with Unassigned, never an invented number", () => {
  const boxes = w2StateBoxes("CA", null, "28000.0000", "930.0000", []);
  assert.equal(boxes[0]!.code, "15");
  assert.equal(boxes[0]!.value, "Unassigned");
  assert.match(boxes[0]!.label, /CA/);
});

test("local lines print 18/19/20 per locality and omit zero local wages", () => {
  const boxes = w2StateBoxes("NY", "NY-009", "24000.0000", "1100.0000", [
    { locality: "New York City resident income tax", box18LocalWages: "24000.0000", box19LocalIncomeTax: "730.0000" },
  ]);
  assert.deepEqual(boxes.map((box) => box.code), ["15", "16", "17", "18", "19", "20"]);
  assert.equal(boxes[5]!.value, "New York City resident income tax");

  const zeroWages = w2StateBoxes("NY", "NY-009", "24000.0000", "1100.0000", [
    { locality: "New York City resident income tax", box18LocalWages: "0", box19LocalIncomeTax: "730.0000" },
  ]);
  assert.deepEqual(zeroWages.map((box) => box.code), ["15", "16", "17", "19", "20"]);
});

test("an opening carry-in lands in the federal boxes and never invents state lines", () => {
  const before = slip({
    stateLines: [
      {
        state: "AZ", employerStateId: "AZ-001",
        box16StateWages: "20000.0000", box17StateIncomeTax: "512.0000", localLines: [],
      },
    ],
  });
  const after = openingYtdIntoW2Slip(before, {
    pensionableYtd: "0", insurableYtd: "0", cppYtd: "0", cpp2Ytd: "0",
    eiYtd: "0", qpipYtd: "0", taxableYtd: "12000.5000", taxYtd: "1500.2500", ficaWithheldYtd: "0",
  });
  assert.equal(after.box1Wages, "60000.5000");
  assert.deepEqual(after.stateLines, before.stateLines);
});
