/**
 * RL-1 assembly + transmission-mechanics tests — the pure halves (box caps,
 * transmitter validation, file naming), no database. The box cap rules are
 * transcribed from the Guide du relevé 1 (RL-1.G) ss. 5.9/5.11; the
 * transmitter mechanics from revenuquebec.ca's transmission pages and form
 * ED-430-V (each cited in the modules under test).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assembleRl1Slip, rl1YearCaps, RL1_UNSUPPORTED_BOXES, type Rl1SlipAggregates } from "./payroll-rl1.ts";
import {
  RL1_XML_DOWNLOAD_REFUSAL,
  rl1TransmitterProblems,
  rl1XmlFilename,
} from "./payroll-rl1xml.ts";
import { registerRl1Filing } from "./payroll/canada/quebec/rl1-filing.ts";
import { payrollPackFilings, yearEndFiling } from "./payroll-filing-registry.ts";

const CAPS_2026 = { ympe: "74600", yampe: "85000", qpipMie: "103000" };

const aggregates = (overrides: Partial<Rl1SlipAggregates> = {}): Rl1SlipAggregates => ({
  employeePartyId: "e-1",
  employeeName: "Employee One",
  taxableIncome: "52000.00",
  qpp: "3060.05",
  qpp2: "0",
  ei: "676.00",
  qpip: "223.60",
  qcIncomeTax: "6100.00",
  unionDues: "520.00",
  pensionable: "52000.00",
  insurable: "52000.00",
  stubCount: 26,
  ...overrides,
});

test("rl1YearCaps: 2026 published maximums; unknown years refuse", () => {
  // TP-1015.F-V (2026-01) p. 7: YMPE 74,600; additional maximum 85,000;
  // QPIP maximum insurable earnings 103,000.
  assert.deepEqual(rl1YearCaps(2026), CAPS_2026);
  assert.throws(() => rl1YearCaps(2025));
  assert.throws(() => rl1YearCaps(2027));
});

test("box mapping: pass-through under the caps", () => {
  const slip = assembleRl1Slip(aggregates(), rl1YearCaps(2026));
  assert.equal(slip.boxA, "52000.00");
  assert.equal(slip.boxBA, "3060.05");
  assert.equal(slip.boxBB, "0");
  assert.equal(slip.boxC, "676.00");
  assert.equal(slip.boxE, "6100.00");
  assert.equal(slip.boxF, "520.00");
  assert.equal(slip.boxG, "52000.00"); // below the YMPE, uncapped
  assert.equal(slip.boxH, "223.60");
  assert.equal(slip.boxI, "52000.00"); // below the QPIP MIE, uncapped
});

test("box G caps at the YMPE when only B.A has an amount (RL-1.G s. 5.9)", () => {
  const slip = assembleRl1Slip(
    aggregates({ pensionable: "80000.00", qpp2: "0" }),
    rl1YearCaps(2026),
  );
  assert.equal(slip.boxG, "74600");
});

test("box G caps at the ADDITIONAL maximum when B.B has an amount", () => {
  const slip = assembleRl1Slip(
    aggregates({ pensionable: "90000.00", qpp2: "416.00" }),
    rl1YearCaps(2026),
  );
  assert.equal(slip.boxG, "85000");
  // And within the band, the real pensionable salary passes through.
  const inBand = assembleRl1Slip(
    aggregates({ pensionable: "80000.00", qpp2: "216.00" }),
    rl1YearCaps(2026),
  );
  assert.equal(inBand.boxG, "80000.00");
});

test("box I caps at the QPIP maximum insurable earnings (RL-1.G s. 5.11)", () => {
  const slip = assembleRl1Slip(
    aggregates({ insurable: "110000.00" }),
    rl1YearCaps(2026),
  );
  assert.equal(slip.boxI, "103000");
});

test("the boxes the data cannot populate are published, not implied", () => {
  assert.match(RL1_UNSUPPORTED_BOXES, /box(es)? D/i);
});

test("RL-1 artifacts pin slips and totals to one repeatable-read snapshot", () => {
  const source = readFileSync(new URL("./payroll-rl1.ts", import.meta.url), "utf8");
  const returnStart = source.indexOf("export async function rl1Return");
  const populationStart = source.indexOf("export async function rl1Population");
  assert.ok(returnStart >= 0 && populationStart > returnStart);
  const returnBody = source.slice(returnStart, populationStart);
  assert.match(returnBody, /rl1Db\.transaction[\s\S]*isolationLevel: "repeatable read"/);
  assert.doesNotMatch(returnBody, /await rl1Slips\(/);
  assert.doesNotMatch(returnBody, /await rl1Summary\(/);

  const populationBody = source.slice(populationStart);
  assert.match(populationBody, /rl1Db\.transaction[\s\S]*isolationLevel: "repeatable read"/);
  assert.doesNotMatch(populationBody, /await rl1Slips\(/);
  assert.doesNotMatch(populationBody, /await rl1Summary\(/);
});

test("transmitter validation: a complete configuration passes", () => {
  assert.deepEqual(rl1TransmitterProblems({
    transmitterNumber: "NP123456",
    certificationNumber: "RQ-26-01-123",
    identificationNumber: "1234567890",
    fileSequence: 1,
    name: "Example Employer Inc.",
    contactName: "Pat Payroll",
    contactEmail: "pat@example.com",
    contactPhone: "514-555-0100",
    slipRangeStart: "10145875",
    slipRangeEnd: "10146174",
  }), []);
});

test("transmitter validation: every malformed field is named", () => {
  const problems = rl1TransmitterProblems({
    transmitterNumber: "123456",        // missing NP prefix
    certificationNumber: " ",           // blank
    identificationNumber: "12345",      // not 10 digits
    fileSequence: 0,                    // out of range
    name: "", contactName: "", contactEmail: "", contactPhone: "",
    slipRangeStart: "10145875",         // start without a valid end
    slipRangeEnd: "999",
  });
  assert.ok(problems.some((p) => p.includes("transmitterNumber")));
  assert.ok(problems.some((p) => p.includes("certificationNumber")));
  assert.ok(problems.some((p) => p.includes("identificationNumber")));
  assert.ok(problems.some((p) => p.includes("fileSequence")));
  assert.ok(problems.some((p) => p.includes("name is required")));
  assert.ok(problems.some((p) => p.includes("slipRangeEnd")));
});

test("transmitter validation: an inverted slip-number series is refused", () => {
  const problems = rl1TransmitterProblems({
    transmitterNumber: "NP123456",
    certificationNumber: "RQ-26-01-123",
    identificationNumber: "1234567890",
    fileSequence: 2,
    name: "X", contactName: "X", contactEmail: "x@x", contactPhone: "5145550100",
    slipRangeStart: "10146174",
    slipRangeEnd: "10145875",
  });
  assert.ok(problems.some((p) => p.includes("must not be lower")));
});

test("file name: AAPPPPPPSSS.xml, under 30 characters", () => {
  // 2026 + NP123456 + file 1 → 26123456001.xml (the RQ example pattern).
  assert.equal(rl1XmlFilename(2026, "NP123456", 1), "26123456001.xml");
  assert.equal(rl1XmlFilename(2026, "NP123456", 42), "26123456042.xml");
  assert.ok(rl1XmlFilename(2026, "NP123456", 999).length < 30);
  assert.throws(() => rl1XmlFilename(2026, "XX123456", 1));
  assert.throws(() => rl1XmlFilename(2026, "NP123456", 1000));
  assert.throws(() => rl1XmlFilename(1999, "NP123456", 1));
});

test("the XML download refusal names the partner-gated specification", () => {
  assert.match(RL1_XML_DOWNLOAD_REFUSAL, /IN-800/);
  assert.match(RL1_XML_DOWNLOAD_REFUSAL, /not generated/);
  assert.match(RL1_XML_DOWNLOAD_REFUSAL, /slip data above\s+is complete/);
});

test("the RL-1 registers onto the CA pack's year-end filings, idempotently", () => {
  registerRl1Filing();
  registerRl1Filing(); // a second bootstrap call must not double-declare
  assert.ok(payrollPackFilings("CA").yearEnd.some((filing) => filing.key === "rl1"));
  const filing = yearEndFiling("CA", "rl1");
  assert.equal(filing.label, "RL-1 slips (Revenu Québec)");
  // No electronic file is offered — the refusal is declared in its place.
  assert.equal(filing.download, undefined);
  assert.equal(filing.downloadRefusal, RL1_XML_DOWNLOAD_REFUSAL);
});
