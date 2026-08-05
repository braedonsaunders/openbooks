import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const baselinePath = "schema/migrations/generated/0001_baseline.sql";
const baseline = readFileSync(baselinePath, "utf8");

test("fresh installations have one canonical baseline followed by ordered forward migrations", () => {
  const generated = readdirSync("schema/migrations/generated")
    .filter((file) => file.endsWith(".sql"))
    .sort();
  assert.equal(generated[0], "0001_baseline.sql");
  assert.ok(generated.includes("0129_auth_security.sql"));
  assert.ok(generated.includes("0130_backup_run_concurrency.sql"));
  assert.ok(generated.every((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file)));
  assert.deepEqual(
    readdirSync("schema/migrations").filter((file) => file.endsWith(".sql")).sort(),
    ["environments.sql"],
  );
  assert.match(baseline, /CREATE TABLE public\.orgs/);
  assert.match(baseline, /CREATE FUNCTION public\.je_check_posted_balance/);
  assert.match(baseline, /CREATE POLICY org_isolation/);
  assert.match(baseline, /SELECT public\.openbooks_refresh_query_catalog\(\)/);
});

test("authentication hardening is an additive migration", () => {
  const authMigration = readFileSync(
    "schema/migrations/generated/0129_auth_security.sql",
    "utf8",
  );
  assert.match(authMigration, /create table public\.auth_sessions/i);
  assert.match(authMigration, /create table public\.auth_login_events/i);
  assert.match(authMigration, /create table public\.auth_mfa_factors/i);
  assert.match(authMigration, /create table public\.auth_oidc_identities/i);
  assert.match(authMigration, /references public\.users\(id\) on delete cascade/i);
});

test("the canonical catalog contains no upgrade-only evidence model", () => {
  for (const retiredObject of [
    "orphaned_tax_component_evidence",
    "_migration_control_exceptions",
    "_migration_schema_convergence",
    "selection_source",
    "legacy_json_migration",
    "validation_replay",
    ["admin", "app2"].join(""),
  ]) {
    assert.doesNotMatch(baseline, new RegExp(retiredObject, "i"));
  }
});

test("external source identities are scoped by tenant and source system", () => {
  assert.match(baseline, /CREATE UNIQUE INDEX parties_org_source_identity/);
  assert.match(baseline, /CREATE UNIQUE INDEX projects_org_source_identity/);
  assert.match(baseline, /custom -> 'source'/);
  assert.match(baseline, /'system'/);
  assert.match(baseline, /'externalId'/);
});

test("the governed query catalog exposes views, never access-control tables", () => {
  assert.match(baseline, /'managed_properties'/);
  assert.match(baseline, /'property_leases'/);
  assert.doesNotMatch(
    baseline.match(/safe_relations constant text\[\] := array\[([\s\S]*?)\n  \];/)?.[1] ?? "",
    /user_org_access/,
  );
  assert.match(
    baseline,
    /revoke all privileges on all tables in schema public from openbooks_read/i,
  );
});
