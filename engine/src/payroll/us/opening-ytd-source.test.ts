import assert from "node:assert/strict";
import test from "node:test";
import { usOpeningAccountBaseForEin, usOpeningFieldForEin } from "./opening-ytd-source.ts";
import { US_FICA_WAGES_ACCOUNT_BASE } from "./opening-ytd.ts";

type Source = Parameters<typeof usOpeningFieldForEin>[0];
const einA = "00000000-0000-4000-8000-000000000001";
const einB = "00000000-0000-4000-8000-000000000002";
function source(): Source {
  return {
    hasOpening: true,
    hasMaterialHistory: true,
    hasWageHistory: true,
    hasFutaWageHistory: true,
    hasSuiWageHistory: false,
    facts: {
      originalCountry: "US",
      originalCurrency: "USD",
      coverageStart: "2026-01-01",
      coverageEnd: "2026-06-30",
      coverageComplete: true,
    },
    authority: {
      openingBalanceId: einA,
      subsidiaryId: einA,
      authorityId: einA,
      employerAuthorityId: einA,
      sourceFileId: einA,
      sourceVersionId: einA,
      sourceSha256: "a".repeat(64),
      sourceReference: "Original payroll report",
      openingSha256: "b".repeat(64),
    },
    openingSnapshot: {
      pensionable_ytd: "1234.5678",
      non_periodic_ytd: "42.0001",
      fica_withheld_ytd: "94.4444",
    },
    openingChildren: { components: [], programBases: [], accountBases: [], suiStates: [] },
    allocations: [
      {
        programKey: "us_futa",
        region: "US",
        subRegion: "",
        filingAccountId: einA,
        federalAccountId: einA,
        amount: "1234.5678",
      },
    ],
  };
}
test("source-qualified aggregate amounts follow the original EIN without current-profile substitution", () => {
  const original = source();
  assert.equal(usOpeningFieldForEin(original, einA, "pensionable_ytd"), "1234.5678");
  assert.equal(usOpeningFieldForEin(original, einA, "non_periodic_ytd"), "42.0001");
  assert.equal(usOpeningFieldForEin(original, einB, "pensionable_ytd"), "0");
  assert.equal(usOpeningFieldForEin(original, null, "non_periodic_ytd"), "0");
});
test("unknown original context and malformed exact amounts refuse while another certified pack contributes no US prior", () => {
  const original = source();
  assert.throws(
    () => usOpeningFieldForEin({ ...original, facts: null }, einA, "pensionable_ytd"),
    /exact original country/,
  );
  assert.throws(
    () => usOpeningFieldForEin({ ...original, openingChildren: null }, einA, "pensionable_ytd"),
    /exact original country/,
  );
  assert.throws(
    () =>
      usOpeningFieldForEin(
        {
          ...original,
          openingSnapshot: { ...original.openingSnapshot, pensionable_ytd: 1234.5678 },
        },
        einA,
        "pensionable_ytd",
      ),
    /exact decimal/,
  );
  assert.equal(
    usOpeningFieldForEin(
      {
        ...original,
        facts: { ...original.facts!, originalCountry: "CA", originalCurrency: "CAD" },
      },
      einA,
      "pensionable_ytd",
    ),
    "0",
  );
});
test("aggregate multi-EIN and duplicate aggregate/account bases refuse instead of merging room", () => {
  const original = source();
  assert.throws(
    () =>
      usOpeningFieldForEin(
        {
          ...original,
          allocations: [
            ...original.allocations,
            { ...original.allocations[0]!, filingAccountId: einB, federalAccountId: einB },
          ],
        },
        einA,
        "pensionable_ytd",
      ),
    /no unique original EIN/,
  );
  const account = {
    program_key: US_FICA_WAGES_ACCOUNT_BASE,
    filing_account_id: einA,
    region: null,
    insurable_ytd: "1234.5678",
  };
  assert.throws(
    () =>
      usOpeningFieldForEin(
        { ...original, openingChildren: { ...original.openingChildren!, accountBases: [account] } },
        einA,
        "pensionable_ytd",
      ),
    /both aggregate and EIN-specific/,
  );
});
test("sealed account children retain exact separate EIN bases and reject duplicate native identity", () => {
  const original = source();
  const account = {
    program_key: US_FICA_WAGES_ACCOUNT_BASE,
    filing_account_id: einA,
    region: null,
    insurable_ytd: "1234.5678",
  };
  original.openingChildren!.accountBases = [
    account,
    { ...account, filing_account_id: einB, insurable_ytd: "9876.5432" },
  ];
  assert.equal(usOpeningAccountBaseForEin(original, einA, US_FICA_WAGES_ACCOUNT_BASE), "1234.5678");
  assert.equal(usOpeningAccountBaseForEin(original, einB, US_FICA_WAGES_ACCOUNT_BASE), "9876.5432");
  assert.throws(
    () =>
      usOpeningAccountBaseForEin(
        {
          ...original,
          openingChildren: { ...original.openingChildren!, accountBases: [account, account] },
        },
        einA,
        US_FICA_WAGES_ACCOUNT_BASE,
      ),
    /ambiguous/,
  );
});
