import assert from "node:assert/strict";
import test from "node:test";
import { constrainedSchemaOwnerRefusal } from "../../../scripts/bootstrap-roles.ts";

// The constrained schema-owner escape hatch must fail closed: a migration
// login with any superuser-class attribute (superuser, bypassrls, createdb,
// createrole, replication — critical now that RLS bypass is a dedicated
// role), an identical runtime login outside dev/test, an unowned table, or
// a missing posture row each refuse by name. Same predicate bootstrap.ts
// enforces, so this fails when the rule weakens. (Lock ordering and
// seed-guard posture remain
// covered by execution: scripts/bootstrap-*.test.ts and the advisory-lock
// deployment path.)
test("constrained schema-owner migration refuses unsafe posture by name", () => {
  const migration = new URL("postgres://tenant_owner:owner@host/books");
  const runtime = new URL("postgres://tenant_app:runtime@host/books");
  const verified = { current_user: "tenant_owner", current_database: "books", unsafe: false, unowned_tables: 0 };
  assert.equal(constrainedSchemaOwnerRefusal(verified, migration, runtime, "tenant_app", "production"), null);
  assert.match(constrainedSchemaOwnerRefusal({ ...verified, unsafe: true }, migration, runtime, "tenant_app", "production") ?? "", /restricted role that owns every public table/);
  assert.match(constrainedSchemaOwnerRefusal({ ...verified, current_user: "tenant_app" }, migration, runtime, "tenant_app", undefined) ?? "", /refuses a runtime role identical to the migration login/);
  assert.match(constrainedSchemaOwnerRefusal({ ...verified, unowned_tables: 2 }, migration, runtime, "tenant_app", "production") ?? "", /restricted role that owns every public table/);
  assert.match(constrainedSchemaOwnerRefusal(null, migration, runtime, "tenant_app", "production") ?? "", /restricted role that owns every public table/);
});
