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
import { assembleRl1Slip, openingYtdIntoRl1Aggregates, rl1YearCaps, RL1_UNSUPPORTED_BOXES, type Rl1SlipAggregates } from "./canada/quebec/rl1.ts";
import type { OpeningYearEndYtd } from "./yearend.ts";
import {
  RL1_XML_DOWNLOAD_REFUSAL,
  rl1TransmitterProblems,
  rl1XmlFilename,
} from "./canada/quebec/rl1xml.ts";
import { registerRl1Filing } from "./canada/quebec/rl1-filing.ts";
import { payrollPackFilings, yearEndFiling } from "./filing-registry.ts";

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
  qpipInsurable: "52000.00",
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

test("box I reads the QPIP program base, not the EI base (C-12/C-14)", () => {
  // The same employee with diverging program bases: EI-insurable 52,000,
  // QPIP-insurable 30,000 (e.g. benefits the QPIP program excludes but EI
  // includes). Box I must carry the QPIP figure; the EI base must not leak in.
  const low = assembleRl1Slip(
    aggregates({ insurable: "52000.00", qpipInsurable: "30000.00" }),
    rl1YearCaps(2026),
  );
  assert.equal(low.boxI, "30000.00");
  // And the reverse: a QPIP base above the EI base passes through whole.
  const high = assembleRl1Slip(
    aggregates({ insurable: "52000.00", qpipInsurable: "60000.00" }),
    rl1YearCaps(2026),
  );
  assert.equal(high.boxI, "60000.00");
});

test("box I caps at the QPIP maximum insurable earnings (RL-1.G s. 5.11)", () => {
  const slip = assembleRl1Slip(
    aggregates({ insurable: "52000.00", qpipInsurable: "110000.00" }),
    rl1YearCaps(2026),
  );
  assert.equal(slip.boxI, "103000");
});

test("the boxes the data cannot populate are published, not implied", () => {
  assert.match(RL1_UNSUPPORTED_BOXES, /box(es)? D/i);
});

const opening = (overrides: Partial<OpeningYearEndYtd> = {}): OpeningYearEndYtd => ({
  pensionableYtd: "0", insurableYtd: "0", cppYtd: "0", cpp2Ytd: "0",
  eiYtd: "0", qpipYtd: "0", taxableYtd: "0", taxYtd: "0", ficaWithheldYtd: "0", ...overrides,
});

test("RL-1 carry-in: pre-adoption YTD is additive with committed QC stubs", () => {
  // A mid-year adopter's RL-1 must reconcile to the prior provider's YTD
  // report exactly as their T4 does: taxable/QPP/QPP2/EI/QPIP/pensionable
  // ride the same per-employee opening the T4 and W-2 builders fold in.
  const carried = openingYtdIntoRl1Aggregates(
    aggregates(),
    opening({
      taxableYtd: "21000.50", cppYtd: "700.00", cpp2Ytd: "120.00",
      eiYtd: "210.75", qpipYtd: "33.25", pensionableYtd: "22000.00",
      insurableYtd: "11000.25", taxYtd: "3150.75",
    }),
  );
  assert.equal(carried.taxableIncome, "73000.5000");
  assert.equal(carried.qpp, "3760.0500");
  assert.equal(carried.qpp2, "120.0000");
  assert.equal(carried.ei, "886.7500");
  assert.equal(carried.qpip, "256.8500");
  assert.equal(carried.pensionable, "74000.0000");
});

test("RL-1 carry-in leaves boxes E, F and I alone: no opening source exists", () => {
  // tax_ytd is the T4-box-22 federal money and insurable_ytd the EI base —
  // neither is Québec income tax, union dues, or the QPIP salary base, so
  // carrying them into boxes E/F/I would invent a Québec return the same way
  // the T4 refuses box 44 and box 56.
  const before = aggregates();
  const carried = openingYtdIntoRl1Aggregates(
    before,
    opening({
      taxableYtd: "100.00", taxYtd: "20.00", pensionableYtd: "100.00",
      insurableYtd: "80.00", cppYtd: "5.00", cpp2Ytd: "2.00",
      eiYtd: "3.00", qpipYtd: "1.00",
    }),
  );
  assert.equal(carried.qcIncomeTax, before.qcIncomeTax);
  assert.equal(carried.unionDues, before.unionDues);
  assert.equal(carried.insurable, before.insurable);
});

test("RL-1 carry-in is capped with the stubs, not after them", () => {
  // 70,000 of QPP-pensionable salary with the prior provider leaves only
  // 4,600 of YMPE room: the cap consumes the combined base, so carrying the
  // opening in after capping would overstate box G by the opening amount.
  const carried = openingYtdIntoRl1Aggregates(
    aggregates({ pensionable: "20000.00" }),
    opening({ pensionableYtd: "70000.00" }),
  );
  const slip = assembleRl1Slip(carried, rl1YearCaps(2026));
  assert.equal(slip.boxG, "74600");
});

test("RL-1 artifacts pin slips and totals to one repeatable-read snapshot", () => {
  const source = readFileSync(new URL("./canada/quebec/rl1.ts", import.meta.url), "utf8");
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
