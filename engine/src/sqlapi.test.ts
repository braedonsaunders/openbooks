import assert from "node:assert/strict";
import test from "node:test";
import { validateUserSql } from "./sqlapi.ts";

test("query validation preserves PostgreSQL string literals and quoted identifiers", () => {
  const query = `select 'vendor_bill' as kind, "MixedCase" from documents where memo = 'a;b'`;
  assert.equal(validateUserSql(query), query);
});

test("query validation removes only a trailing statement terminator", () => {
  assert.equal(validateUserSql(" select 'expense_report'; "), "select 'expense_report'");
});

test("query validation still rejects multiple statements and write prefixes", () => {
  assert.throws(() => validateUserSql("select 1; select 2"), /one statement/);
  assert.throws(() => validateUserSql("update documents set memo = 'nope'"), /read-only/);
});
