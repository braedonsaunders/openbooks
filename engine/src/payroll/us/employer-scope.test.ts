import assert from "node:assert/strict";
import test from "node:test";
import { calculatePub15T } from "./pub15t.ts";
import { caEttWagesYtd } from "./compute-statutory.ts";
import { caEttWithholding } from "./states/ca.ts";
import {
  resolveUsEmployerScope,
  resolveUsFederalFilingAccount,
  resolveUsStateSuiAccount,
  resolveUsW2StateAccount,
  type UsFilingAccountRef,
} from "./employer-scope.ts";
import type { UsFilingAccountLineage } from "./filing-account-lineage.ts";

const DATE = "2026-07-21";
const ACME = "acme";
const OTHER = "other";
const account = (
  id: string,
  programType: string,
  subsidiaryId: string | null,
  stateCode: string | null = null,
): UsFilingAccountRef => ({
  id,
  name: id.toUpperCase(),
  programType,
  subsidiaryId,
  stateCode,
  isActive: true,
});
const affiliation = (
  filingAccountId: string,
  federalAccountId: string,
  subsidiaryId: string,
  effectiveFrom = "2026-01-01",
  effectiveTo: string | null = null,
): UsFilingAccountLineage => ({
  id: filingAccountId + effectiveFrom,
  filingAccountId,
  federalAccountId,
  subsidiaryId,
  effectiveFrom,
  effectiveTo,
  sourceReference: "Original employer registration",
});
const ACCOUNTS: UsFilingAccountRef[] = [
  account("ein", "us_ein", ACME),
  {
    ...account("ny-sui", "us_state_sui", ACME, "NY"),
    affiliations: [affiliation("ny-sui", "ein", ACME)],
  },
  {
    ...account("nj-sui", "us_state_sui", ACME, "NJ"),
    affiliations: [affiliation("nj-sui", "ein", ACME)],
  },
  account("other-ein", "us_ein", OTHER),
  {
    ...account("other-nj", "us_state_sui", OTHER, "NJ"),
    affiliations: [affiliation("other-nj", "other-ein", OTHER)],
  },
];

test("federal bases follow original dated EIN across state accounts and rehires within the same legal employer", () => {
  assert.equal(resolveUsEmployerScope(ACCOUNTS, "nj-sui", ACME, DATE).federalAccountId, "ein");
  assert.equal(resolveUsFederalFilingAccount(ACCOUNTS, "ny-sui", ACME, "2026-02-01"), "ein");
  assert.equal(resolveUsEmployerScope(ACCOUNTS, "ein", ACME, DATE).federalAccountId, "ein");
  assert.equal(resolveUsFederalFilingAccount(ACCOUNTS, "other-nj", OTHER, DATE), "other-ein");
  const continued = calculatePub15T({
    payDate: "2025-07-15",
    periodsPerYear: 26,
    wages: "10000",
    filingStatus: "single",
    ytd: { ssWages: "170000", medicareWages: "195000" },
  });
  assert.equal(continued.ss, "378.2000");
  assert.equal(continued.ssEmployer, "378.2000");
  assert.equal(continued.additionalMedicare, "45.0000");
});

test("dated state ownership keeps original federal history after EIN activation changes", () => {
  const accounts = [
    { ...account("ein-old", "us_ein", ACME), isActive: false },
    account("ein-new", "us_ein", ACME),
    {
      ...account("nj", "us_state_sui", ACME, "NJ"),
      affiliations: [
        affiliation("nj", "ein-old", ACME, "2026-01-01", "2026-06-30"),
        affiliation("nj", "ein-new", ACME, "2026-07-01"),
      ],
    },
  ];
  assert.equal(resolveUsFederalFilingAccount(accounts, "nj", ACME, "2026-06-30"), "ein-old");
  assert.equal(resolveUsFederalFilingAccount(accounts, "nj", ACME, "2026-07-01"), "ein-new");
  assert.equal(resolveUsFederalFilingAccount(accounts, "ein-old", ACME, DATE), "ein-old");
  const reversedActivation = accounts.map((row) => ({ ...row, isActive: !row.isActive }));
  assert.equal(
    resolveUsFederalFilingAccount(reversedActivation, "nj", ACME, "2026-06-30"),
    "ein-old",
  );
});

test("multiple EINs under one legal employer remain independent with explicitly dated state affiliations", () => {
  const accounts = [
    ...ACCOUNTS,
    account("ein-2", "us_ein", ACME),
    {
      ...account("nj-2", "us_state_sui", ACME, "NJ"),
      affiliations: [affiliation("nj-2", "ein-2", ACME)],
    },
  ];
  assert.equal(resolveUsStateSuiAccount(accounts, "ein", ACME, "NJ", DATE), "nj-sui");
  assert.equal(resolveUsStateSuiAccount(accounts, "ein-2", ACME, "NJ", DATE), "nj-2");
  assert.equal(resolveUsFederalFilingAccount(accounts, "ein-2", ACME, DATE), "ein-2");
});

test("unknown or ambiguous original affiliation refuses with the native history editor remedy", () => {
  const bare = [account("ein", "us_ein", ACME), account("nj", "us_state_sui", ACME, "NJ")];
  assert.throws(
    () => resolveUsFederalFilingAccount(bare, "nj", ACME, DATE),
    /unknown.*Filing Accounts → Employer EIN history/,
  );
  assert.throws(
    () => resolveUsStateSuiAccount(bare, "ein", ACME, "NJ", DATE),
    /ownership.*unknown/,
  );
  const ambiguous = [
    ...bare.slice(0, 1),
    { ...bare[1]!, affiliations: [affiliation("nj", "ein", ACME), affiliation("nj", "ein", ACME)] },
  ];
  assert.throws(
    () => resolveUsFederalFilingAccount(ambiguous, "nj", ACME, DATE),
    /ambiguous.*Employer EIN history/,
  );
  assert.throws(
    () => resolveUsFederalFilingAccount(ACCOUNTS, "nj-sui", ACME, "2025-12-31"),
    /unknown/,
  );
  assert.throws(
    () => resolveUsFederalFilingAccount(ACCOUNTS, "nj-sui", ACME, "2026-02-30"),
    /actual payroll source date/,
  );
});

test("org-wide state accounts use explicitly retained legal employers and cannot borrow another employer EIN", () => {
  const accounts = [
    account("ein", "us_ein", ACME),
    account("other-ein", "us_ein", OTHER),
    {
      ...account("state", "us_state_sui", null, "NJ"),
      affiliations: [
        affiliation("state", "ein", ACME, "2026-01-01", "2026-06-30"),
        affiliation("state", "other-ein", OTHER, "2026-07-01"),
      ],
    },
  ];
  assert.equal(resolveUsFederalFilingAccount(accounts, "state", ACME, "2026-06-30"), "ein");
  assert.equal(resolveUsFederalFilingAccount(accounts, "state", OTHER, DATE), "other-ein");
  assert.throws(
    () => resolveUsFederalFilingAccount(accounts, "state", ACME, DATE),
    /another original legal employer/,
  );
  assert.equal(resolveUsStateSuiAccount(accounts, "ein", ACME, "NJ", DATE), null);
  assert.throws(() => resolveUsFederalFilingAccount(accounts, "state", null, DATE), /unknown/);
  assert.throws(
    () => resolveUsFederalFilingAccount(ACCOUNTS, "ny-sui", OTHER, DATE),
    /original pay-run legal employer/,
  );
  const crossEmployer = accounts.map((row) =>
    row.id === "state" ? { ...row, affiliations: [affiliation("state", "other-ein", ACME)] } : row,
  );
  assert.throws(
    () => resolveUsFederalFilingAccount(crossEmployer, "state", ACME, DATE),
    /original pay-run legal employer/,
  );
});

test("explicit EIN-only and unassigned histories stay intact without unrelated state-affiliation inference", () => {
  const accounts = [
    account("old", "us_ein", ACME),
    account("new", "us_ein", ACME),
    account("unqualified", "us_state_sui", ACME, "NJ"),
  ];
  assert.equal(resolveUsFederalFilingAccount(accounts, "old", ACME, DATE), "old");
  assert.equal(resolveUsFederalFilingAccount(accounts, "new", ACME, DATE), "new");
  assert.equal(resolveUsFederalFilingAccount(accounts, null, ACME, DATE), null);
  assert.equal(resolveUsStateSuiAccount(accounts.slice(0, 2), "old", ACME, "TX", DATE), null);
});

test("W-2 state identity uses the original source date even after registration retirement", () => {
  const retired = ACCOUNTS.map((row) => ({ ...row, isActive: false }));
  assert.equal(resolveUsW2StateAccount(retired, "ny-sui", ACME, "NY", DATE), "ny-sui");
  assert.equal(resolveUsW2StateAccount(retired, "ein", ACME, "NJ", DATE), "nj-sui");
  assert.equal(resolveUsW2StateAccount(retired, "ny-sui", ACME, "TX", DATE), null);
  assert.equal(resolveUsStateSuiAccount(retired, "other-ein", OTHER, "NJ", DATE), "other-nj");
});

test("California ETT consumes the entered California SUI carry-in", () => {
  // $5,000 of California UI wages carried in leaves $2,000 of the $7,000
  // ETT base: 0.1% of $2,000 on a $3,000 period, not of the whole $3,000.
  const carried = caEttWagesYtd({ suiCurrentRegion: "0", suiOpeningCurrentRegion: "5000" }, null);
  assert.equal(caEttWithholding("2026-07-21", "3000", carried), "2.0000");
  assert.equal(
    caEttWithholding(
      "2026-07-21",
      "3000",
      caEttWagesYtd({ suiCurrentRegion: "0", suiOpeningCurrentRegion: "7000" }, null),
    ),
    "0.0000",
  );
  // A priced SUI year-to-date (credited prior-state wages included) is the base.
  assert.equal(
    caEttWithholding(
      "2026-07-21",
      "3000",
      caEttWagesYtd({ suiCurrentRegion: "0", suiOpeningCurrentRegion: "0" }, "6500"),
    ),
    "0.5000",
  );
});
