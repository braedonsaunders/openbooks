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

test("1257L parses cumulative with the £12,570 allowance", () => {
  assert.deepEqual(parseGbTaxCode("1257L"), {
    kind: "suffix", allowanceAnnual: "12570", welsh: false, nonCumulative: false,
  });
  assert.deepEqual(parseGbTaxCode(" 1257l "), {
    kind: "suffix", allowanceAnnual: "12570", welsh: false, nonCumulative: false,
  });
});

test("W1/M1/X suffixes parse non-cumulative", () => {
  for (const code of ["1257L W1", "1257L M1", "1257L X", "1257LW1"]) {
    const parsed = parseGbTaxCode(code);
    assert.equal(parsed.kind, "suffix", code);
    assert.equal((parsed as { nonCumulative: boolean }).nonCumulative, true, code);
  }
});

test("flat codes price whole pay at their HMRC rate", () => {
  assert.deepEqual(parseGbTaxCode("BR"), { kind: "flat", rate: "0.20", welsh: false });
  assert.deepEqual(parseGbTaxCode("D0"), { kind: "flat", rate: "0.40", welsh: false });
  assert.deepEqual(parseGbTaxCode("D1"), { kind: "flat", rate: "0.45", welsh: false });
});

test("Welsh C-prefix codes alias the identical rUK arithmetic", () => {
  assert.deepEqual(parseGbTaxCode("C1257L"), {
    kind: "suffix", allowanceAnnual: "12570", welsh: true, nonCumulative: false,
  });
  assert.deepEqual(parseGbTaxCode("CBR"), { kind: "flat", rate: "0.20", welsh: true });
  assert.deepEqual(parseGbTaxCode("CD0"), { kind: "flat", rate: "0.40", welsh: true });
  assert.deepEqual(parseGbTaxCode("CD1"), { kind: "flat", rate: "0.45", welsh: true });
  assert.deepEqual(parseGbTaxCode("C0T"), {
    kind: "suffix", allowanceAnnual: "0", welsh: true, nonCumulative: false,
  });
});

test("0T, NT and K codes parse", () => {
  assert.deepEqual(parseGbTaxCode("0T"), {
    kind: "suffix", allowanceAnnual: "0", welsh: false, nonCumulative: false,
  });
  assert.deepEqual(parseGbTaxCode("NT"), { kind: "none" });
  assert.deepEqual(parseGbTaxCode("K475"), {
    kind: "k", addedAnnual: "4750", welsh: false, nonCumulative: false,
  });
  assert.deepEqual(parseGbTaxCode("CK100"), {
    kind: "k", addedAnnual: "1000", welsh: true, nonCumulative: false,
  });
});

test("Scottish codes are refused by name, never fallen through", () => {
  for (const code of ["S1257L", "SBR", "SD0", "SD1", "SD2", "SD3", "S0T", "SK500", "S"]) {
    assert.throws(() => parseGbTaxCode(code), PayrollPackError, code);
    assert.throws(() => parseGbTaxCode(code), /Scottish/, code);
  }
});

test("non-1257 numeric, marriage-allowance, T and unknown codes are refused by name", () => {
  for (const code of ["1100L", "900L", "431L", "1257M", "1257N", "T", "BR W1", "K0", "K", ""]) {
    assert.throws(() => parseGbTaxCode(code), PayrollPackError, code || "(blank)");
  }
  assert.throws(() => parseGbTaxCode("1100L"), /only the standard 1257L/);
  assert.throws(() => parseGbTaxCode("1257M"), /marriage-allowance/);
  assert.throws(() => parseGbTaxCode("T"), /under HMRC review/);
});
