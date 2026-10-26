/**
 * An account typed asset_bank shows as cash everywhere, so a mistyped
 * clearing, provision, or facility account silently inflates cash. The typing
 * check is a WARNING (never a refusal): it fires when the asset_bank type is
 * uncorroborated — no bank-like name, not statement-reconcilable, and no
 * statements ever imported for the account.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  accountNameKey,
  assetBankHygieneWarning,
  duplicateAccountNameWarning,
  DUPLICATE_ACCOUNT_NAME,
} from "./accounts-hygiene";

test("a bank-named account needs no corroboration", () => {
  assert.equal(assetBankHygieneWarning({ type: "asset_bank", name: "RBC Bank" }), null);
  assert.equal(assetBankHygieneWarning({ type: "asset_bank", name: "SAVINGS" }), null);
  assert.equal(
    assetBankHygieneWarning({ type: "asset_bank", name: "Staff Chequing Account" }),
    null,
  );
});

test("canonical cash names are cash by definition, not mistypes", () => {
  assert.equal(assetBankHygieneWarning({ type: "asset_bank", name: "Cash" }), null);
  assert.equal(assetBankHygieneWarning({ type: "asset_bank", name: "Petty Cash" }), null);
  assert.equal(assetBankHygieneWarning({ type: "asset_bank", name: "Undeposited Funds" }), null);
});

test("reconcilable or statement-backed accounts need no name match", () => {
  assert.equal(
    assetBankHygieneWarning({ type: "asset_bank", name: "Operating", reconcilable: true }),
    null,
  );
  assert.equal(
    assetBankHygieneWarning({ type: "asset_bank", name: "Operating", hasStatements: true }),
    null,
  );
});

test("an uncorroborated asset_bank warns naming the account", () => {
  for (const name of [
    "Operating",
    "Provision for Future Income Tax",
    "Payroll Clearing",
    "RBC Line of Credit",
  ]) {
    const warning = assetBankHygieneWarning({ type: "asset_bank", name });
    assert.ok(warning, `${name} should warn`);
    assert.equal(warning!.code, "asset_bank_uncorroborated");
    assert.equal(warning!.name, name);
    assert.match(warning!.message, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("other types, summaries, and empty names never warn", () => {
  assert.equal(assetBankHygieneWarning({ type: "expense", name: "Provision for Claims" }), null);
  assert.equal(assetBankHygieneWarning({ type: "asset_receivable", name: "RBC Bank" }), null);
  // Summary accounts never post; the cash queries exclude them.
  assert.equal(
    assetBankHygieneWarning({ type: "asset_bank", name: "Misc", isSummary: true }),
    null,
  );
});

test("account name keys ignore case and whitespace runs only", () => {
  assert.equal(accountNameKey("  Interest   Expense "), "interest expense");
  assert.equal(accountNameKey("Interest\tExpense"), "interest expense");
  assert.notEqual(accountNameKey("Interest Expense"), accountNameKey("Interest Expenses"));
});

test("a same-name holder produces a warning that names the existing account", () => {
  const warning = duplicateAccountNameWarning(" interest expense ", [
    { id: "a7000", number: "7000", name: "Interest Expense" },
  ]);
  assert.ok(warning);
  assert.equal(warning.code, DUPLICATE_ACCOUNT_NAME);
  assert.equal(warning.name, "interest expense");
  assert.equal(warning.existingAccountId, "a7000");
  assert.equal(warning.existingAccountName, "Interest Expense");
  assert.equal(warning.existingAccountNumber, "7000");
  assert.match(warning.message, /7000 Interest Expense/);
});

test("no holder means no duplicate warning", () => {
  assert.equal(duplicateAccountNameWarning("Interest Expense", []), null);
});

test("a holder without an account number is named by its name alone", () => {
  const warning = duplicateAccountNameWarning("Clearing", [
    { id: "x", number: null, name: "Clearing" },
  ]);
  assert.ok(warning);
  assert.equal(warning.existingAccountNumber, null);
  assert.match(warning.message, /\(Clearing\)/);
});
