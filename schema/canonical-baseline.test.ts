import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const baselinePath = "schema/migrations/generated/0001_baseline.sql";
const baseline = readFileSync(baselinePath, "utf8");

test("fresh installations have exactly one canonical prerelease baseline", () => {
  const generated = readdirSync("schema/migrations/generated")
    .filter((file) => file.endsWith(".sql"))
    .sort();
  // The canonical baseline plus reviewed forward migrations — anything else in
  // this directory is an unreviewed artifact, not a migration.
  assert.deepEqual(generated, [
    "0001_baseline.sql",
    "0002_kernel_hardening.sql",
    "0003_pay_application_invoice_fk.sql",
    "0004_scheduler_outbox.sql",
    "0005_posting_effects.sql",
    "0006_recurring_occurrence_guard.sql",
    "0006_terminal_failure_surfacing.sql",
    "0007_posting_effects_terminal_lifecycle.sql",
  ]);
  assert.deepEqual(
    readdirSync("schema/migrations").filter((file) => file.endsWith(".sql")).sort(),
    ["environments.sql"],
  );
  assert.match(baseline, /CREATE TABLE public\.orgs/);
  assert.match(baseline, /CREATE FUNCTION public\.je_check_posted_balance/);
  assert.match(baseline, /CREATE POLICY org_isolation/);
  assert.match(baseline, /SELECT public\.openbooks_refresh_query_catalog\(\)/);
});

test("the baseline contains standards, payroll, authentication, and operational guards", () => {
  for (const table of [
    "lease_agreements",
    "lease_agreement_schedule_lines",
    "inventory_writedowns",
    "pay_schedules",
    "pay_components",
    "pay_run_adjustments",
    "employee_payroll_profiles",
    "employee_pay_components",
    "pay_runs",
    "pay_stubs",
    "pay_stub_lines",
    "payroll_opening_balances",
    "union_agreements",
    "union_classifications",
    "union_fringes",
    "auth_sessions",
    "auth_login_events",
    "auth_mfa_factors",
    "auth_oidc_identities",
  ]) {
    assert.match(baseline, new RegExp(`CREATE TABLE public\\.${table}`));
  }
  assert.match(baseline, /CREATE FUNCTION public\.posted_document_financial_guard\(\)/);
  assert.match(baseline, /CREATE TRIGGER documents_posted_financial_guard/);
  assert.match(baseline, /CREATE UNIQUE INDEX backup_runs_one_inflight_per_org/);
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

test("pay-run adjustments ship inside the tenant-safe canonical baseline", () => {
  assert.match(baseline, /CREATE TABLE public\.pay_run_adjustments/);
  assert.match(
    baseline,
    /ALTER TABLE ONLY public\.pay_run_adjustments FORCE ROW LEVEL SECURITY/,
  );
  assert.match(
    baseline,
    /CREATE POLICY org_isolation ON public\.pay_run_adjustments/,
  );
  assert.match(
    baseline,
    /COMMENT ON POLICY org_isolation ON public\.pay_run_adjustments IS 'openbooks:org_isolation:v1'/,
  );
  assert.match(
    baseline,
    /ALTER TABLE public\.pay_run_adjustments ENABLE ROW LEVEL SECURITY/,
  );
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
  const safeRelations = baseline.match(
    /safe_relations constant text\[\] := array\[([\s\S]*?)\n  \];/,
  )?.[1] ?? "";
  // Payroll is reportable — but "reportable" means present in the catalog, by
  // EITHER route. A relation that holds a secret earns a curated column list
  // instead of the generic `select *`, so asserting allowlist membership would
  // pin the unsafe mechanism in place. employee_payroll_profiles is exactly
  // that case: it carries sealed SIN ciphertext.
  const inCatalog = (relation: string) =>
    new RegExp(`'${relation}'`).test(safeRelations)
    || new RegExp(`create view openbooks_query\\.${relation} `).test(baseline);
  for (const relation of [
    "pay_schedules",
    "pay_components",
    "pay_run_adjustments",
    "employee_payroll_profiles",
    "employee_pay_components",
    "pay_runs",
    "pay_stubs",
    "pay_stub_lines",
    "payroll_opening_balances",
    "union_agreements",
    "union_classifications",
    "union_fringes",
  ]) {
    assert.ok(inCatalog(relation), `${relation} is not in the governed query catalog`);
  }
  assert.doesNotMatch(safeRelations, /user_org_access|auth_[a-z0-9_]+/);
  assert.match(
    baseline,
    /revoke all privileges on all tables in schema public from openbooks_read/i,
  );
});
