import assert from "node:assert/strict";
import test from "node:test";
import {
  isExplicitLocalEnvironment,
  readsLocalEnvFile,
  runtimeDatabaseRoleCheckRequired,
} from "./runtime-database-role.ts";

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

test("shared local-environment predicates treat unset as unknown (fail closed)", () => {
  assert.equal(isExplicitLocalEnvironment(undefined), false);
  assert.equal(isExplicitLocalEnvironment(""), false);
  assert.equal(isExplicitLocalEnvironment("production"), false);
  assert.equal(isExplicitLocalEnvironment("development"), true);
  assert.equal(isExplicitLocalEnvironment("test"), true);
  // Only development reads the repo .env file; every other runtime —
  // including an unset NODE_ENV — must supply its endpoints explicitly.
  assert.equal(readsLocalEnvFile(undefined), false);
  assert.equal(readsLocalEnvFile(""), false);
  assert.equal(readsLocalEnvFile("test"), false);
  assert.equal(readsLocalEnvFile("production"), false);
  assert.equal(readsLocalEnvFile("development"), true);
});
