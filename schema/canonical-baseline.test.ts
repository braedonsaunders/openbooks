import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const baselinePath = "schema/migrations/generated/0001_baseline.sql";
const baseline = readFileSync(baselinePath, "utf8");
const bankStatementSourceEvidenceMigrationPath =
  "schema/migrations/generated/0010_bank_statement_source_evidence.sql";
const paymentRunLiveSelectionMigrationPath =
  "schema/migrations/generated/0011_payment_run_live_selection.sql";
const paymentRunPostingRecoveryMigrationPath =
  "schema/migrations/generated/0012_payment_run_posting_recovery.sql";
const documentRevisionMonotonicMigrationPath =
  "schema/migrations/generated/0013_document_revision_monotonic.sql";
const flowEmailOutboxMigrationPath =
  "schema/migrations/generated/0014_flow_email_outbox.sql";
const sandboxWipeGuardGucMigrationPath =
  "schema/migrations/generated/0019_sandbox_wipe_guard_guc.sql";
const closePostingFenceMigrationPath =
  "schema/migrations/generated/0022_close_posting_fence.sql";

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
    "0008_durable_work_lease_fencing.sql",
    "0009_posting_effect_idempotency_keys.sql",
    "0010_bank_statement_source_evidence.sql",
    "0010_bank_statement_source_idempotency.sql",
    "0011_payment_run_live_selection.sql",
    "0012_payment_run_posting_recovery.sql",
    "0013_document_revision_monotonic.sql",
    "0014_flow_email_outbox.sql",
    "0015_payment_instruction_posting_claim_fence.sql",
    "0016_gl_month_activity_book_id.sql",
    "0019_sandbox_wipe_guard_guc.sql",
    "0020_inventory_subsidiary_ownership.sql",
    "0022_close_posting_fence.sql",
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

test("bank statement source evidence is mandatory after forward migrations", () => {
  const migration = readFileSync(bankStatementSourceEvidenceMigrationPath, "utf8");
  assert.match(migration, /WHERE raw_file_ref IS NULL/);
  assert.match(migration, /RAISE EXCEPTION/);
  assert.match(
    migration,
    /ALTER COLUMN raw_file_ref SET NOT NULL/,
  );
});

test("every effective sandbox-wipe guard reads the GUC the wipe source sets", () => {
  const generatedDir = "schema/migrations/generated";
  const migrationFiles = readdirSync(generatedDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const migrationSources = new Map(
    migrationFiles.map((file) => [file, readFileSync(`${generatedDir}/${file}`, "utf8")]),
  );
  const migration = readFileSync(sandboxWipeGuardGucMigrationPath, "utf8");
  const lifecycleSource = readFileSync("engine/src/sandbox/lifecycle.ts", "utf8");
  const fixtureWipeSource = readFileSync("engine/src/test-fixtures.ts", "utf8");
  const setterMatch = lifecycleSource.match(
    /set_config\('([a-z0-9_.]+\.sandbox_wipe)', 'on', true\)/,
  );
  assert.ok(setterMatch, "sandbox lifecycle must set its wipe GUC explicitly");
  const wipeGuc = setterMatch[1]!;
  assert.match(
    fixtureWipeSource,
    new RegExp(`set_config\\('${wipeGuc.replaceAll(".", "\\.")}', 'on', true\\)`),
    "scratch teardown must use the same wipe GUC as sandbox lifecycle",
  );

  const legacyGuardNames = new Set<string>();
  for (const [file, source] of migrationSources) {
    if (file >= "0019_sandbox_wipe_guard_guc.sql") continue;
    for (const occurrence of source.matchAll(/current_setting\('app\.sandbox_wipe'/g)) {
      const definitions = [
        ...source.slice(0, occurrence.index).matchAll(
          /CREATE(?: OR REPLACE)? FUNCTION public\.([a-z0-9_]+)\(/gi,
        ),
      ];
      const functionName = definitions.at(-1)?.[1];
      assert.ok(functionName, `${file} has a legacy wipe GUC outside a function body`);
      legacyGuardNames.add(functionName);
    }
  }
  assert.deepEqual([...legacyGuardNames].sort(), [
    "subscription_amendment_immutable_guard",
    "subscription_period_invoice_immutable_guard",
    "subscription_plan_version_immutable_guard",
    "subscription_version_component_immutable_guard",
    "wip_prebill_event_append_only_guard",
  ]);

  for (const functionName of legacyGuardNames) {
    const definition = migration.match(
      new RegExp(
        `CREATE OR REPLACE FUNCTION public\\.${functionName}\\(\\) RETURNS trigger[\\s\\S]*?\\$\\$;`,
      ),
    )?.[0];
    assert.ok(definition, `0019 must replace legacy guard ${functionName}`);
    assert.match(
      definition,
      new RegExp(`current_setting\\('${wipeGuc.replaceAll(".", "\\.")}'`),
    );
    assert.doesNotMatch(definition, /app\.sandbox_wipe/);
  }

  // Build the final function catalog in filename order. This checks guards
  // that were already correct as well as the five repaired above, and catches
  // a later forward migration that accidentally reintroduces another name.
  const effectiveWipeBodies = new Map<string, string>();
  const functionDefinition =
    /CREATE(?: OR REPLACE)? FUNCTION public\.([a-z0-9_]+)\([^;]*?\)\s+RETURNS[\s\S]*?\s+AS (\$[a-z0-9_]*\$)([\s\S]*?)\2;/gi;
  for (const source of migrationSources.values()) {
    for (const match of source.matchAll(functionDefinition)) {
      if (match[3]!.includes("sandbox_wipe")) effectiveWipeBodies.set(match[1]!, match[3]!);
    }
  }
  assert.ok(effectiveWipeBodies.size > legacyGuardNames.size);
  for (const [functionName, body] of effectiveWipeBodies) {
    assert.match(
      body,
      new RegExp(
        `(?:current_setting\\('${wipeGuc.replaceAll(".", "\\.")}'|openbooks_sandbox_wipe_allowed\\()`,
      ),
      `${functionName} must read the wipe source's GUC directly or through its canonical helper`,
    );
    assert.doesNotMatch(body, /app\.sandbox_wipe/, `${functionName} retains the drifted GUC`);
  }
});

test("an instruction's lifecycle fan-out can never cross payment runs", () => {
  const migration = readFileSync(paymentRunLiveSelectionMigrationPath, "utf8");
  // The historical repair predicates on the instruction's own run, so a
  // cross-run reference is never advanced or released by a foreign
  // instruction's terminal state.
  assert.match(migration, /AND item\.payment_run_id = instruction\.payment_run_id/);
  // A stray reference is refused outright instead of guessed into a run.
  assert.match(migration, /\$payment_run_item_instruction_run_preflight\$/);
  assert.match(
    migration,
    /references an instruction of another payment run/,
  );
  // Storage makes the shape unrepresentable for every future writer: an
  // item's (org, run) must equal its instruction's (org, run).
  assert.match(
    migration,
    /ADD CONSTRAINT payment_run_items_instruction_run\s+FOREIGN KEY \(org_id, payment_run_id, payment_instruction_id\)\s+REFERENCES public\.payment_instructions \(org_id, payment_run_id, id\)/,
  );
  // Every lifecycle branch carries the same run predicate as defense in
  // depth — one payment run's instruction can never move another run's
  // live reservation, even for data planted before the key existed.
  const scopedBranches = migration.match(
    /and payment_run_id = new\.payment_run_id\s+and payment_instruction_id = new\.id/g,
  );
  assert.equal(scopedBranches?.length, 4);
});

test("payment-run posting claims are leased and stranded claims are released on rollout", () => {
  const migration = readFileSync(paymentRunPostingRecoveryMigrationPath, "utf8");
  for (const column of ["posting_claim_token", "posting_claimed_at", "posting_claimed_by"]) {
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
    assert.match(migration, new RegExp(`COMMENT ON COLUMN public\\.payment_runs\\.${column}`));
  }
  // A pre-token `processing` row has no live owner: it must leave the
  // unreachable state for the resumable one, with run-scoped evidence.
  assert.match(migration, /WHERE status = 'processing'/);
  assert.match(migration, /'run_posting_recovered'/);
});

test("document revisions can never repeat: storage forces every update to advance updated_at", () => {
  const migration = readFileSync(documentRevisionMonotonicMigrationPath, "utf8");
  // The guard intervenes only on the collapse shape — an update whose stored
  // revision is byte-identical to the previous one — and forces strictly
  // forward motion. Explicit advancing or backdating writes stay untouched.
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.documents_revision_monotonic\(\)/);
  assert.match(migration, /IF NEW\.updated_at = OLD\.updated_at THEN/);
  assert.match(
    migration,
    /NEW\.updated_at := greatest\(\s*clock_timestamp\(\),\s*OLD\.updated_at \+ interval '1 microsecond'\s*\)/,
  );
  assert.match(migration, /BEFORE UPDATE ON public\.documents/);
  assert.match(migration, /CREATE TRIGGER documents_revision_monotonic/);
  assert.match(migration, /COMMENT ON FUNCTION public\.documents_revision_monotonic\(\) IS/);
});

test("transactional flow emails defer through the durable scheduler outbox", () => {
  const migration = readFileSync(flowEmailOutboxMigrationPath, "utf8");
  // The rendered delivery rides the row, so the eventual send never depends
  // on later record mutations.
  assert.match(migration, /ADD COLUMN IF NOT EXISTS payload jsonb/);
  assert.match(migration, /COMMENT ON COLUMN public\.scheduler_outbox\.payload IS/);
  // The kind and scope guards must admit flow_email — org + run + payload —
  // while leaving the scan and escalation shapes exactly as they were.
  const kindCheck = migration.match(
    /ADD CONSTRAINT scheduler_outbox_kind\s+CHECK \(([\s\S]*?)\)\);/,
  )?.[1];
  assert.ok(kindCheck, "migration must (re)create the scheduler_outbox_kind check");
  assert.match(kindCheck, /'flow_email'::text/);
  for (const priorKind of [
    "'dunning'::text",
    "'subscription_billing'::text",
    "'property_billing'::text",
    "'fx_providers'::text",
    "'approval_escalation'::text",
  ]) {
    assert.ok(kindCheck.includes(priorKind), `kind check lost ${priorKind}`);
  }
  const scopeCheck = migration.match(
    /ADD CONSTRAINT scheduler_outbox_scope CHECK \(\(([\s\S]*?)\)\);/,
  )?.[1];
  assert.ok(scopeCheck, "migration must (re)create the scheduler_outbox_scope check");
  assert.match(scopeCheck, /\(kind = 'flow_email'\) AND \(org_id IS NOT NULL\) AND \(subject_id IS NOT NULL\) AND \(payload IS NOT NULL\)/);
});

test("journal posting serializes with period close through a shared advisory fence", () => {
  const migration = readFileSync(closePostingFenceMigrationPath, "utf8");
  // The fence helper must hash byte-identically to the engine's exclusive
  // side (periodScopeAdvisoryLock in engine/src/close.ts), or the two sides
  // would serialize on different keys and the race would stay open. Shared
  // mode is the _shared advisory variant — the one call that lets parallel
  // postings stay parallel while still conflicting with the close writer's
  // exclusive acquisition.
  assert.match(
    migration,
    /pg_advisory_xact_lock_shared\(\s*\n\s*hashtextextended\('period-lock:' \|\| p_org::text \|\| ':' \|\| p_period::text \|\| ':' \|\| p_book::text, 0\)\s*\n?\s*\)/,
  );
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.period_posting_fence/);
  assert.match(migration, /LANGUAGE plpgsql VOLATILE/);
  assert.match(migration, /COMMENT ON FUNCTION public\.period_posting_fence\(uuid, uuid, uuid\) IS/);
  // je_guard keeps its prior rules but takes the fence before every branch
  // that consults GL period state: posted-entry deletion, amend rematerialize
  // (old and new scope), and draft -> posted.
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.je_guard\(\)/);
  const fences = migration.match(/perform period_posting_fence\(/g);
  assert.equal(fences?.length, 4, "every ledger-mutating je_guard branch must take the fence");
  assert.match(
    migration,
    /perform period_posting_fence\(new\.org_id, new\.period_id, new\.book_id\);\s*\n\s*if period_module_blocks_write/,
  );
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
