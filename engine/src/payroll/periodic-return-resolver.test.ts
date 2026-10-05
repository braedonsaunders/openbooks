import assert from "node:assert/strict";
import test from "node:test";
import { payrollPack } from "./packs.ts";
import { periodicReturnAccountResolver } from "./yearend.ts";

/**
 * The account a committed stub's wages are filed under on a country's
 * account-grouped periodic return is a pack declaration, not a country
 * branch in the shared layer. The US files by the legal employer's EIN
 * (see us/employer-scope.ts); every other pack files under the account
 * the stub records, so the resolver is the identity there.
 */

test("the US pack declares employer-account periodic filing", () => {
  assert.equal(payrollPack("US").periodicReturnFilesByEmployerAccount, true);
});

test("packs without employer-account filing do not declare it", () => {
  assert.ok(!payrollPack("CA").periodicReturnFilesByEmployerAccount);
});

test("a non-employer pack resolves under the stub account, untouched", async () => {
  const resolve = await periodicReturnAccountResolver("org-unused", "CA");
  assert.equal(resolve("stub-account", "subsidiary-1"), "stub-account");
  assert.equal(resolve(null, "subsidiary-1"), null);
});
