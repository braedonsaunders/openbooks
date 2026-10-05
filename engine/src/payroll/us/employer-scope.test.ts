import assert from "node:assert/strict";
import test from "node:test";
import { calculatePub15T } from "./pub15t.ts";
import { caEttWagesYtd } from "./compute-statutory.ts";
import { caEttWithholding } from "./states/ca.ts";
import {
  resolveUsEmployerScope, resolveUsFederalFilingAccount, resolveUsStateSuiAccount, resolveUsW2StateAccount,
  type UsFilingAccountRef,
} from "./employer-scope.ts";

const account = (
  id: string, programType: string, subsidiaryId: string | null, stateCode: string | null = null,
): UsFilingAccountRef => ({ id, name: id.toUpperCase(), programType, subsidiaryId, stateCode, isActive: true });

const ACME = "acme";
const OTHER = "other";
const ACCOUNTS = [
  account("ein", "us_ein", ACME),
  account("ny-sui", "us_state_sui", ACME, "NY"),
  account("nj-sui", "us_state_sui", ACME, "NJ"),
  account("other-ein", "us_ein", OTHER),
  account("other-nj", "us_state_sui", OTHER, "NJ"),
];

test("federal wage bases follow the EIN across its state accounts, never into another employer", () => {
  const scope = resolveUsEmployerScope(ACCOUNTS, "nj-sui", ACME);
  assert.equal(scope.federalAccountId, "ein");
  assert.deepEqual([...scope.stubAccountIds!].sort(), ["ein", "nj-sui", "ny-sui"]);
  // The same EIN reached from the EIN itself shares exactly the same history.
  assert.deepEqual([...resolveUsEmployerScope(ACCOUNTS, "ein", ACME).stubAccountIds!].sort(),
    ["ein", "nj-sui", "ny-sui"]);

  // $170,000 already paid under the New York account, $10,000 now under
  // New Jersey (2025 base $176,100): Social Security prices only the $6,100
  // left to the base, and the employer matches the same $378.20. Restarting
  // the base at the new state account would charge $620.00 each side.
  const continued = calculatePub15T({
    payDate: "2025-07-15", periodsPerYear: 26, wages: "10000", filingStatus: "single",
    ytd: { ssWages: "170000", medicareWages: "195000" },
  });
  assert.equal(continued.ss, "378.2000");
  assert.equal(continued.ssEmployer, "378.2000");
  // $195,000 + $10,000 crosses the $200,000 Additional Medicare threshold by $5,000.
  assert.equal(continued.additionalMedicare, "45.0000");
});

test("the run's state SUI account is the employer's account for the work state, whichever account the profile names", () => {
  assert.equal(resolveUsStateSuiAccount(ACCOUNTS, "ein", ACME, "NJ"), "nj-sui");
  assert.equal(resolveUsStateSuiAccount(ACCOUNTS, "ny-sui", ACME, "NJ"), "nj-sui");
  assert.equal(resolveUsStateSuiAccount(ACCOUNTS, "other-ein", OTHER, "NJ"), "other-nj");
  assert.equal(resolveUsStateSuiAccount(ACCOUNTS, "ein", ACME, "TX"), null);
});

test("two live EINs under one legal employer refuse by name instead of merging or splitting the base", () => {
  const accounts = [...ACCOUNTS, account("ein-2", "us_ein", ACME)];
  assert.throws(
    () => resolveUsEmployerScope(accounts, "nj-sui", ACME),
    /NJ-SUI filing account: its legal employer holds 2 EIN accounts \(EIN, EIN-2\).*Deactivate the superseded EIN, or assign each EIN to its own subsidiary, in Payroll Setup → Filing accounts/,
  );
  // A superseded, inactive EIN is history, not a second employer.
  const superseded = accounts.map((row) => row.id === "ein-2" ? { ...row, isActive: false } : row);
  assert.equal(resolveUsEmployerScope(superseded, "nj-sui", ACME).federalAccountId, "ein");
});

test("W-2 and Form 941 report a state account's wages under its employer's EIN, with box 15 from the state's account", () => {
  // Filed by EIN: the New Jersey account's stubs belong on Acme's EIN, never
  // on a return addressed to the state account or to another employer's EIN.
  assert.equal(resolveUsFederalFilingAccount(ACCOUNTS, "nj-sui", ACME), "ein");
  assert.equal(resolveUsFederalFilingAccount(ACCOUNTS, "ein", ACME), "ein");
  assert.equal(resolveUsFederalFilingAccount(ACCOUNTS, "other-nj", OTHER), "other-ein");
  assert.equal(resolveUsFederalFilingAccount(ACCOUNTS, null, ACME), null);
  // No EIN on file: the unassigned return, not a state number printed as an EIN.
  assert.equal(resolveUsFederalFilingAccount([account("tx-sui", "us_state_sui", "solo", "TX")], "tx-sui", "solo"), null);
  assert.throws(
    () => resolveUsFederalFilingAccount([...ACCOUNTS, account("ein-2", "us_ein", ACME)], "ny-sui", ACME),
    /NY-SUI filing account cannot be attributed to one EIN: its legal employer holds 2 EIN accounts \(EIN, EIN-2\)\. Deactivate the superseded EIN/,
  );
  // Box 15: an EIN-profile stub worked in New York prints the New York
  // account; a stub filed under the state's own account keeps it even after
  // the account is retired; no account for the state prints no ID.
  assert.equal(resolveUsW2StateAccount(ACCOUNTS, "ein", ACME, "NY"), "ny-sui");
  assert.equal(resolveUsW2StateAccount(ACCOUNTS, "ny-sui", ACME, "NJ"), "nj-sui");
  const retired = ACCOUNTS.map((row) => row.id === "ny-sui" ? { ...row, isActive: false } : row);
  assert.equal(resolveUsW2StateAccount(retired, "ny-sui", ACME, "NY"), "ny-sui");
  assert.equal(resolveUsW2StateAccount(ACCOUNTS, "ny-sui", ACME, "TX"), null);
});

test("California ETT consumes the entered California SUI carry-in", () => {
  // $5,000 of California UI wages carried in leaves $2,000 of the $7,000
  // ETT base: 0.1% of $2,000 on a $3,000 period, not of the whole $3,000.
  const carried = caEttWagesYtd({ suiCurrentRegion: "0", suiOpeningCurrentRegion: "5000" }, null);
  assert.equal(caEttWithholding("2026-07-21", "3000", carried), "2.0000");
  assert.equal(caEttWithholding("2026-07-21", "3000",
    caEttWagesYtd({ suiCurrentRegion: "0", suiOpeningCurrentRegion: "7000" }, null)), "0.0000");
  // A priced SUI year-to-date (credited prior-state wages included) is the base.
  assert.equal(caEttWithholding("2026-07-21", "3000",
    caEttWagesYtd({ suiCurrentRegion: "0", suiOpeningCurrentRegion: "0" }, "6500")), "0.5000");
});
