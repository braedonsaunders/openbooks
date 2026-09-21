import assert from "node:assert/strict";
import test from "node:test";
import { precreatedRolesEnabled } from "./bootstrap-roles.ts";

const configured = {
  OPENBOOKS_PRECREATED_ROLES: "1",
  OPENBOOKS_BOOTSTRAP: "1",
  OPENBOOKS_MIGRATION_DB_URL: "postgres://tenant_owner:owner@host/books",
  OPENBOOKS_RUNTIME_DB_URL: "postgres://tenant_app:runtime@host/books",
};

test("pre-created provisioning is explicit and preserves the default mode", () => {
  assert.equal(precreatedRolesEnabled({}), false);
  assert.equal(precreatedRolesEnabled({ OPENBOOKS_PRECREATED_ROLES: "0" }), false);
  assert.equal(precreatedRolesEnabled(configured), true);
  assert.equal(precreatedRolesEnabled({ ...configured, OPENBOOKS_RUNTIME_DB_URL: "postgresql://tenant_app:runtime@host:5432/books" }), true);
  assert.throws(() => precreatedRolesEnabled({ OPENBOOKS_PRECREATED_ROLES: "true" }), /must be 0 or 1/);
});

test("a typo cannot silently select an owner connection or a partial bootstrap", () => {
  for (const missing of ["OPENBOOKS_BOOTSTRAP", "OPENBOOKS_MIGRATION_DB_URL", "OPENBOOKS_RUNTIME_DB_URL"]) {
    assert.throws(() => precreatedRolesEnabled({ ...configured, [missing]: undefined }), /requires OPENBOOKS_BOOTSTRAP=1/);
  }
  for (const mode of ["OPENBOOKS_CONSTRAINED_SCHEMA_OWNER_MIGRATION", "OPENBOOKS_TEST_OWNERSHIP_TRANSFER"]) {
    assert.throws(() => precreatedRolesEnabled({ ...configured, [mode]: "1" }), /cannot be combined/);
  }
  assert.throws(() => precreatedRolesEnabled({ ...configured, OPENBOOKS_RUNTIME_DB_URL: configured.OPENBOOKS_MIGRATION_DB_URL }), /separate migration-owner and runtime logins/);
  for (const target of ["postgres://tenant_app:p@elsewhere/books", "postgres://tenant_app:p@host:6432/books", "postgres://tenant_app:p@host/elsewhere"]) {
    assert.throws(() => precreatedRolesEnabled({ ...configured, OPENBOOKS_RUNTIME_DB_URL: target }), /same host, port and database/);
  }
});
