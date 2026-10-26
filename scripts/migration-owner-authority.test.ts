import assert from "node:assert/strict";
import test from "node:test";
import {
  migrationBusinessOwnerRole,
  migrationRequiresMaintenanceAuthority,
} from "./migration-owner-authority.ts";

test("a release baseline applies with the maintenance login and forward migrations as the business owner", () => {
  const digest = "a".repeat(64);
  assert.equal(migrationRequiresMaintenanceAuthority("baselines/alpha35.sql"), true);
  assert.equal(
    migrationBusinessOwnerRole("baselines/alpha35.sql", digest, "openbooks_schema_owner"),
    undefined,
  );
  assert.equal(
    migrationRequiresMaintenanceAuthority("generated/0001_inbound_mailboxes.sql"),
    false,
  );
  assert.equal(
    migrationBusinessOwnerRole(
      "generated/0001_inbound_mailboxes.sql",
      digest,
      "openbooks_schema_owner",
    ),
    "openbooks_schema_owner",
  );
  assert.equal(
    migrationBusinessOwnerRole("generated/0001_inbound_mailboxes.sql", digest, undefined),
    undefined,
  );
});
