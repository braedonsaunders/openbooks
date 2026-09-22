/**
 * GB tax-code parsing tests — run with `node --import tsx
 * engine/src/payroll/gb/tax-codes.test.ts`.
 *
 * Every supported code is quoted to its HMRC page in tax-codes.ts; every
 * refusal names the code. Scottish codes are refused even though the rUK
 * engine could price their numbers — falling through would be wrong money
 * for every Scottish employee.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PayrollPackError } from "../payroll-error.ts";
import { parseGbTaxCode } from "./tax-codes.ts";

test("1257L parses cumulative with £12,579 of free pay (code x 10 + 9)", () => {
  assert.deepEqual(parseGbTaxCode("1257L"), {
    kind: "suffix", freePayAnnual: "12579", welsh: false, scottish: false, nonCumulative: false,
  });
  assert.deepEqual(parseGbTaxCode(" 1257l "), {
    kind: "suffix", freePayAnnual: "12579", welsh: false, scottish: false, nonCumulative: false,
  });
});

test("S1257L parses Scottish cumulative with the same £12,579 of free pay", () => {
  assert.deepEqual(parseGbTaxCode("S1257L"), {
    kind: "suffix", freePayAnnual: "12579", welsh: false, scottish: true, nonCumulative: false,
  });
  for (const code of ["S1257L W1", "S1257L M1", "S1257L X", "S1257LW1"]) {
    const parsed = parseGbTaxCode(code);
    assert.equal(parsed.kind, "suffix", code);
    assert.equal((parsed as { scottish: boolean }).scottish, true, code);
    assert.equal((parsed as { nonCumulative: boolean }).nonCumulative, true, code);
  }
});

test("Scottish flat codes carry their Tables-B rates", () => {
  assert.deepEqual(parseGbTaxCode("SBR"), { kind: "flat", rate: "0.20", welsh: false, scottish: true });
  assert.deepEqual(parseGbTaxCode("SD0"), { kind: "flat", rate: "0.21", welsh: false, scottish: true });
  assert.deepEqual(parseGbTaxCode("SD1"), { kind: "flat", rate: "0.42", welsh: false, scottish: true });
  assert.deepEqual(parseGbTaxCode("SD2"), { kind: "flat", rate: "0.45", welsh: false, scottish: true });
  assert.deepEqual(parseGbTaxCode("SD3"), { kind: "flat", rate: "0.48", welsh: false, scottish: true });
});

test("W1/M1/X suffixes parse non-cumulative", () => {
  for (const code of ["1257L W1", "1257L M1", "1257L X", "1257LW1"]) {
    const parsed = parseGbTaxCode(code);
    assert.equal(parsed.kind, "suffix", code);
    assert.equal((parsed as { nonCumulative: boolean }).nonCumulative, true, code);
  }
});

test("flat codes price whole pay at their HMRC rate", () => {
  assert.deepEqual(parseGbTaxCode("BR"), { kind: "flat", rate: "0.20", welsh: false, scottish: false });
  assert.deepEqual(parseGbTaxCode("D0"), { kind: "flat", rate: "0.40", welsh: false, scottish: false });
  assert.deepEqual(parseGbTaxCode("D1"), { kind: "flat", rate: "0.45", welsh: false, scottish: false });
});

test("Welsh C-prefix codes alias the identical rUK arithmetic", () => {
  assert.deepEqual(parseGbTaxCode("C1257L"), {
    kind: "suffix", freePayAnnual: "12579", welsh: true, scottish: false, nonCumulative: false,
  });
  assert.deepEqual(parseGbTaxCode("CBR"), { kind: "flat", rate: "0.20", welsh: true, scottish: false });
  assert.deepEqual(parseGbTaxCode("CD0"), { kind: "flat", rate: "0.40", welsh: true, scottish: false });
  assert.deepEqual(parseGbTaxCode("CD1"), { kind: "flat", rate: "0.45", welsh: true, scottish: false });
  assert.deepEqual(parseGbTaxCode("C0T"), {
    kind: "suffix", freePayAnnual: "0", welsh: true, scottish: false, nonCumulative: false,
  });
});

test("0T, NT and K codes parse", () => {
  assert.deepEqual(parseGbTaxCode("0T"), {
    kind: "suffix", freePayAnnual: "0", welsh: false, scottish: false, nonCumulative: false,
  });
  assert.deepEqual(parseGbTaxCode("NT"), { kind: "none" });
  assert.deepEqual(parseGbTaxCode("K475"), {
    kind: "k", addedAnnual: "4750", welsh: false, scottish: false, nonCumulative: false,
  });
  assert.deepEqual(parseGbTaxCode("CK100"), {
    kind: "k", addedAnnual: "1000", welsh: true, scottish: false, nonCumulative: false,
  });
});

test("untranscribed S-prefix codes are refused by name, never fallen through", () => {
  for (const code of ["S0T", "SNT", "SK500", "SK1", "ST", "S1100L", "S1257M", "S1257N", "S", "SC1257L", "CS1257L", "SBR W1", "SD3 M1"]) {
    assert.throws(() => parseGbTaxCode(code), PayrollPackError, code);
  }
  assert.throws(() => parseGbTaxCode("S0T"), /S0T is refused by name/);
  assert.throws(() => parseGbTaxCode("SNT"), /SNT is refused by name/);
  assert.throws(() => parseGbTaxCode("SK500"), /SK-numbers are refused by name/);
  assert.throws(() => parseGbTaxCode("S1100L"), /only the standard S1257L/);
  assert.throws(() => parseGbTaxCode("S1257M"), /marriage-allowance/);
  assert.throws(() => parseGbTaxCode("S"), /bare S/);
  assert.throws(() => parseGbTaxCode("SC1257L"), /never combines/);
  assert.throws(() => parseGbTaxCode("SBR W1"), /W1\/M1\/X marker/);
});

test("non-1257 numeric, marriage-allowance, T and unknown codes are refused by name", () => {
  for (const code of ["1100L", "900L", "431L", "1257M", "1257N", "T", "BR W1", "K0", "K", ""]) {
    assert.throws(() => parseGbTaxCode(code), PayrollPackError, code || "(blank)");
  }
  assert.throws(() => parseGbTaxCode("1100L"), /only the standard 1257L/);
  assert.throws(() => parseGbTaxCode("1257M"), /marriage-allowance/);
  assert.throws(() => parseGbTaxCode("T"), /under HMRC review/);
});
