import assert from "node:assert/strict";
import test from "node:test";
import { runtimeDatabaseRoleCheckRequired } from "./runtime-database-role.ts";

test("unsafe-role startup check fails closed when NODE_ENV is unset or production", () => {
  assert.equal(runtimeDatabaseRoleCheckRequired(undefined), true);
  assert.equal(runtimeDatabaseRoleCheckRequired(""), true);
  assert.equal(runtimeDatabaseRoleCheckRequired("production"), true);
  assert.equal(runtimeDatabaseRoleCheckRequired("staging"), true);
});

test("unsafe-role startup check skips only an explicit local environment", () => {
  assert.equal(runtimeDatabaseRoleCheckRequired("development"), false);
  assert.equal(runtimeDatabaseRoleCheckRequired("test"), false);
});
