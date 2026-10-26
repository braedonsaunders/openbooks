import assert from "node:assert/strict";
import test from "node:test";
import { canadaOriginalOpeningYtd, type CanadaYtdRow } from "./compute-statutory.ts";

type Source = Parameters<typeof canadaOriginalOpeningYtd>[0];
const id = "00000000-0000-4000-8000-000000000001";
const expected: CanadaYtdRow = {
  pensionable: "10000000000000.0001",
  insurable: "2345.6789",
  cpp: "123.4567",
  cpp2: "11.0001",
  ei: "23.4567",
  qpip: "12.3456",
  qpip_employer: "17.0001",
  non_periodic: "100.1234",
  pension_deductions_bonus: "10.0001",
  f5b: "1.0001",
  qc_csb: "2.0001",
};
const zero: CanadaYtdRow = Object.fromEntries(
  Object.keys(expected).map((key) => [key, "0.0000"]),
) as CanadaYtdRow;
function source(): Source {
  return {
    hasOpening: true,
    hasMaterialHistory: true,
    hasWageHistory: true,
    hasFutaWageHistory: false,
    hasSuiWageHistory: false,
    facts: {
      originalCountry: "CA",
      originalCurrency: "CAD",
      coverageStart: "2026-01-01",
      coverageEnd: "2026-05-30",
      coverageComplete: true,
    },
    authority: {
      openingBalanceId: id,
      subsidiaryId: id,
      authorityId: id,
      employerAuthorityId: id,
      sourceFileId: id,
      sourceVersionId: id,
      sourceSha256: "a".repeat(64),
      sourceReference: "Original statutory payroll report",
      openingSha256: "b".repeat(64),
    },
    openingSnapshot: {
      pensionable_ytd: expected.pensionable,
      insurable_ytd: expected.insurable,
      cpp_ytd: expected.cpp,
      cpp2_ytd: expected.cpp2,
      ei_ytd: expected.ei,
      qpip_ytd: expected.qpip,
      qpip_employer_ytd: expected.qpip_employer,
      non_periodic_ytd: expected.non_periodic,
      non_periodic_pension_deductions_ytd: expected.pension_deductions_bonus,
      cpp2_bonus_ytd: expected.f5b,
      qc_csb_ytd: expected.qc_csb,
    },
    openingChildren: { components: [], programBases: [], accountBases: [], suiStates: [] },
    allocations: [],
  };
}

test("original Canadian statutory openings preserve all exact contribution and bonus inputs", () => {
  assert.deepEqual(canadaOriginalOpeningYtd(source()), expected);
});

test("a qualified original US opening contributes no Canadian annual or bonus prior for the same payer", () => {
  const original = source();
  assert.deepEqual(
    canadaOriginalOpeningYtd({
      ...original,
      facts: { ...original.facts!, originalCountry: "US", originalCurrency: "USD" },
    }),
    zero,
  );
});

test("any material opening requires the original source context, including contribution-only histories", () => {
  for (const missing of ["facts", "authority", "openingSnapshot", "openingChildren"] as const) {
    assert.throws(
      () => canadaOriginalOpeningYtd({ ...source(), [missing]: null }),
      /exact original country/,
    );
  }
  const original = source();
  assert.throws(
    () =>
      canadaOriginalOpeningYtd({
        ...original,
        facts: { ...original.facts!, originalCurrency: "USD" },
      }),
    /Canadian-dollar/,
  );
});

test("missing, binary-number and overprecision Canadian source amounts refuse instead of becoming zero", () => {
  for (const invalid of [undefined, null, 123.4567, "1.00001", "-1"]) {
    const original = source();
    assert.throws(
      () =>
        canadaOriginalOpeningYtd({
          ...original,
          openingSnapshot: { ...original.openingSnapshot, cpp_ytd: invalid },
        }),
      /exact non-negative decimal/,
    );
  }
});

test("an unsigned all-zero opening and an opening excluded by original payer are inert", () => {
  const unsigned = {
    ...source(),
    hasMaterialHistory: false,
    facts: null,
    authority: null,
    openingSnapshot: null,
    openingChildren: null,
  };
  assert.deepEqual(canadaOriginalOpeningYtd(unsigned), zero);
  assert.deepEqual(canadaOriginalOpeningYtd({ ...unsigned, hasOpening: false }), zero);
});
