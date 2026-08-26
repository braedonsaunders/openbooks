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
const documentTotalLineInvariantMigrationPath =
  "schema/migrations/generated/0017_document_total_line_invariant.sql";
const sandboxWipeGuardGucMigrationPath =
  "schema/migrations/generated/0019_sandbox_wipe_guard_guc.sql";
const closePostingFenceMigrationPath =
  "schema/migrations/generated/0022_close_posting_fence.sql";
const payrollCommitSelectionFenceMigrationPath =
  "schema/migrations/generated/0040_payroll_commit_selection_fence.sql";
const wipPrebillSandboxWipeMigrationPath =
  "schema/migrations/generated/0043_sandbox_wip_prebill_wipe_guard.sql";
const subsidiaryTreeGuardSerializationMigrationPath =
  "schema/migrations/generated/0045_subsidiary_tree_guard_serialization.sql";
const segmentValueHierarchySerializationMigrationPath =
  "schema/migrations/generated/0047_segment_value_hierarchy_serialization.sql";
const ownershipPolicyFirstUseSerializationMigrationPath =
  "schema/migrations/generated/0050_ownership_policy_first_use_serialization.sql";
const documentTenantForeignKeysMigrationPath =
  "schema/migrations/generated/0039_document_tenant_coherent_foreign_keys.sql";
const ledgerTenantCoherenceMigrationPath =
  "schema/migrations/generated/0038_ledger_tenant_coherent_foreign_keys.sql";
const paymentSurchargeRuleUniquenessMigrationPath =
  "schema/migrations/generated/0023_payment_surcharge_rule_uniqueness.sql";
const accountPostingClassificationSerializationMigrationPath =
  "schema/migrations/generated/0046_account_posting_classification_serialization.sql";
const subscriptionConfigurationInvariantsMigrationPath =
  "schema/migrations/generated/0041_subscription_configuration_invariants.sql";
const taxRateDomainConstraintsMigrationPath =
  "schema/migrations/generated/0042_tax_rate_domain_constraints.sql";
const effectiveDateOverlapExclusionMigrationPath =
  "schema/migrations/generated/0051_effective_date_overlap_exclusion_constraints.sql";

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
    "0007_posting_effects_terminal_lifecycle.sql",
    "0008_durable_work_lease_fencing.sql",
    "0009_posting_effect_idempotency_keys.sql",
    "0010_bank_statement_source_evidence.sql",
    "0011_payment_run_live_selection.sql",
    "0012_payment_run_posting_recovery.sql",
    "0013_document_revision_monotonic.sql",
    "0014_flow_email_outbox.sql",
    "0015_payment_instruction_posting_claim_fence.sql",
    "0016_gl_month_activity_book_id.sql",
    "0017_document_total_line_invariant.sql",
    "0019_sandbox_wipe_guard_guc.sql",
    "0020_inventory_subsidiary_ownership.sql",
    "0022_close_posting_fence.sql",
    "0023_payment_surcharge_rule_uniqueness.sql",
    "0035_terminal_failure_surfacing.sql",
    "0036_bank_statement_source_idempotency.sql",
    "0038_ledger_tenant_coherent_foreign_keys.sql",
    "0039_document_tenant_coherent_foreign_keys.sql",
    "0040_payroll_commit_selection_fence.sql",
    "0041_subscription_configuration_invariants.sql",
    "0042_tax_rate_domain_constraints.sql",
    "0043_sandbox_wip_prebill_wipe_guard.sql",
    "0045_subsidiary_tree_guard_serialization.sql",
    "0046_account_posting_classification_serialization.sql",
    "0047_segment_value_hierarchy_serialization.sql",
    "0050_ownership_policy_first_use_serialization.sql",
    "0051_effective_date_overlap_exclusion_constraints.sql",
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

test("account classification edits serialize with first journal-line inserts", () => {
  const migration = readFileSync(accountPostingClassificationSerializationMigrationPath, "utf8");

  const lineGuard = migration.match(
    /CREATE OR REPLACE FUNCTION public\.jl_check_account\(\) RETURNS trigger[\s\S]*?\$\$;/,
  )?.[0];
  assert.ok(lineGuard, "0046 must replace the direct journal-line account guard");
  assert.match(lineGuard, /where id = new\.account_id and org_id = new\.org_id\s+for share/i);

  const editGuard = migration.match(
    /CREATE OR REPLACE FUNCTION public\.account_posting_classification_guard\(\) RETURNS trigger[\s\S]*?\$\$;/,
  )?.[0];
  assert.ok(editGuard, "0046 must add a storage guard for direct account edits");
  assert.match(editGuard, /new\.type is distinct from old\.type/i);
  assert.match(editGuard, /new\.is_summary is distinct from old\.is_summary/i);
  assert.match(editGuard, /from journal_lines[\s\S]*org_id = old\.org_id[\s\S]*account_id = old\.id/i);
  assert.match(editGuard, /constraint = 'accounts_type_has_transactions'/i);
  assert.match(editGuard, /constraint = 'accounts_summary_has_transactions'/i);
  assert.match(
    migration,
    /CREATE TRIGGER account_posting_classification_guard\s+BEFORE UPDATE OF type, is_summary ON public\.accounts/i,
  );
  assert.doesNotMatch(migration, /^\s*(?:UPDATE|DELETE\s+FROM)\s/im);
});

test("base subscription configuration fails closed at the storage boundary", () => {
  const migration = readFileSync(subscriptionConfigurationInvariantsMigrationPath, "utf8");

  assert.match(migration, /legacy data violates subscription configuration invariant/i);
  assert.match(migration, /This migration never rewrites financial intent/);
  assert.doesNotMatch(migration, /^\s*(?:UPDATE|DELETE\s+FROM)\s/im);
  assert.match(
    migration,
    /CONSTRAINT subscription_plans_amount_nonnegative\s+CHECK \(amount >= 0\)/,
  );
  assert.match(
    migration,
    /CONSTRAINT subscription_plans_cadence_valid\s+CHECK \([\s\S]*?interval_count > 0/,
  );
  assert.match(
    migration,
    /CONSTRAINT subscriptions_pricing_valid\s+CHECK \(quantity > 0 AND \(price_override IS NULL OR price_override >= 0\)\)/,
  );
  assert.match(
    migration,
    /CONSTRAINT subscriptions_period_valid\s+CHECK \([\s\S]*?start_on <= next_bill_on[\s\S]*?current_period_start >= start_on AND current_period_start <= next_bill_on/,
  );
  for (const constraint of [
    "subscription_plans_amount_nonnegative",
    "subscription_plans_cadence_valid",
    "subscriptions_pricing_valid",
    "subscriptions_period_valid",
  ]) {
    assert.match(migration, new RegExp(`VALIDATE CONSTRAINT ${constraint}`));
  }
});

test("tax rates stay in the calculation engine's domain and setup codes stay unique per tenant", () => {
  const migration = readFileSync(taxRateDomainConstraintsMigrationPath, "utf8");

  // Fail closed on legacy violations instead of guessing a correction.
  assert.match(migration, /legacy data violates tax rate domain invariant/i);
  assert.match(migration, /This migration never rewrites tax policy/);
  assert.match(migration, /legacy setup rows duplicate a natural key/i);
  assert.match(migration, /never picks a winning duplicate/i);
  assert.doesNotMatch(migration, /^\s*(?:UPDATE|DELETE\s+FROM)\s/im);
  // The rate-domain scan must name the exact offending row before DDL runs.
  assert.match(migration, /FROM public\.tax_rates r\s+WHERE r\.rate_percent < 0/);
  // The duplicate scan matches the constraint semantics exactly: NULL codes
  // are distinct under UNIQUE, so only non-null codes can duplicate.
  assert.match(migration, /code IS NOT NULL/);
  assert.match(migration, /HAVING count\(\*\) > 1/);

  // Storage mirrors the calculation engine's contract: a nonnegative exact
  // numeric(19,4) rate. A statutory 0% rate remains representable.
  assert.match(
    migration,
    /ADD CONSTRAINT tax_rates_rate_percent_domain\s+CHECK \(rate_percent >= 0\) NOT VALID/,
  );
  assert.match(migration, /VALIDATE CONSTRAINT tax_rates_rate_percent_domain/);

  // Every authoritative setup table named by the audit gets tenant natural-key
  // uniqueness; tables that already had database uniqueness are untouched.
  for (const table of [
    "tax_codes",
    "tax_groups",
    "classes",
    "departments",
    "locations",
    "worker_comp_groups",
  ]) {
    assert.match(
      migration,
      new RegExp(`ADD CONSTRAINT ${table}_org_code_unique\\s+UNIQUE \\(org_id, code\\)`),
    );
    assert.match(
      migration,
      new RegExp(`COMMENT ON CONSTRAINT ${table}_org_code_unique`),
    );
  }
  assert.match(
    migration,
    /COMMENT ON CONSTRAINT tax_rates_rate_percent_domain/,
  );
});

test("document financial references are tenant-coherent without rewriting history", () => {
  const migration = readFileSync(documentTenantForeignKeysMigrationPath, "utf8");

  assert.match(migration, /legacy data violates tenant coherence/i);
  assert.match(migration, /referenced_org_id/);
  assert.match(
    migration,
    /FOREIGN KEY \(org_id, party_id\) REFERENCES public\.parties\(org_id, id\)/,
  );
  assert.match(
    migration,
    /FOREIGN KEY \(org_id, account_id\) REFERENCES public\.accounts\(org_id, id\)/,
  );
  assert.match(
    migration,
    /FOREIGN KEY \(org_id, from_document_id\) REFERENCES public\.documents\(org_id, id\)/,
  );
  assert.match(migration, /VALIDATE CONSTRAINT document_lines_account_id_fkey/);
  assert.doesNotMatch(migration, /^\s*(?:UPDATE|DELETE\s+FROM)\s/im);
});

test("active payment surcharge windows cannot overlap within one pricing identity", () => {
  const migration = readFileSync(paymentSurchargeRuleUniquenessMigrationPath, "utf8");
  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public/);
  assert.match(
    migration,
    /ADD CONSTRAINT payment_surcharge_rules_no_active_overlap\s+EXCLUDE USING gist/,
  );
  assert.match(migration, /org_id WITH =/);
  assert.match(migration, /COALESCE\(provider, '__all_providers__'::text\)\) WITH =/);
  assert.match(migration, /payment_method WITH =/);
  assert.match(migration, /daterange\(effective_from, effective_to, '\[\]'\)\) WITH &&/);
  assert.match(migration, /WHERE \(is_active\)/);
});

test("effective-date overlap guards are exclusion constraints, not racy triggers", () => {
  const migration = readFileSync(effectiveDateOverlapExclusionMigrationPath, "utf8");

  // One storage-side guard per former BEFORE-trigger guard; tax_rates (#28)
  // and income_tax_rates (0002) are deliberately out of scope.
  const excludedConstraints = [
    "fair_value_prices_no_active_overlap",
    "field_ticket_policies_no_active_overlap",
    "item_rate_book_assignments_no_active_overlap",
    "item_rate_versions_no_active_overlap",
    "labor_cost_rates_no_active_overlap",
    "overhead_rates_no_overlap",
    "subsidiary_ownership_interests_no_active_overlap",
    "tax_registrations_no_active_overlap",
    "project_financial_profile_versions_no_overlap",
  ];
  for (const constraint of excludedConstraints) {
    assert.match(
      migration,
      new RegExp(`ADD CONSTRAINT ${constraint}\\s+EXCLUDE USING gist`),
    );
    assert.match(migration, new RegExp(`COMMENT ON CONSTRAINT ${constraint}\\s`));
  }
  assert.match(migration, /daterange\(coalesce\(effective_from, '-infinity'::date\), effective_to, '\[\]'\)\) WITH &&/);
  assert.match(migration, /coalesce\(lower\(job_title\), ''\)\) WITH =/);
  assert.match(migration, /WHERE \(status = 'active'\)/);
  assert.doesNotMatch(migration, /ALTER TABLE public\.tax_rates\b/);
  assert.doesNotMatch(migration, /ALTER TABLE public\.income_tax_rates\b/);
  assert.doesNotMatch(migration, /DROP TRIGGER tax_rates_no_overlap/);

  // The six single-duty overlap triggers are gone; the three multi-duty
  // triggers keep their other invariants and lose only the racy overlap read.
  for (const retired of [
    "fair_value_prices_no_overlap_guard",
    "item_rate_book_assignments_no_overlap_guard",
    "item_rate_versions_no_overlap_guard",
    "labor_cost_rates_no_overlap_guard",
    "overhead_rates_no_overlap_guard",
    "tax_registrations_no_overlap_guard",
  ]) {
    assert.match(migration, new RegExp(`DROP FUNCTION public\\.${retired}\\(\\)`));
  }
  for (const replaced of [
    "field_ticket_policy_guard",
    "ownership_interest_guard",
    "project_financial_profile_version_guard",
  ]) {
    const definition = migration.match(
      new RegExp(
        `CREATE FUNCTION public\\.${replaced}\\(\\) RETURNS trigger[\\s\\S]*?\\n\\$\\$;`,
      ),
    )?.[0];
    assert.ok(definition, `0051 must replace ${replaced}`);
    assert.doesNotMatch(
      definition,
      /effective_date_ranges_overlap|daterange\(existing\.|daterange\(v\./,
      `${replaced} must delegate window exclusivity to its exclusion constraint`,
    );
  }
  assert.match(migration, /used ownership policy is immutable/);
  assert.match(migration, /published project financial profile versions are immutable/);

  // Repairs run before the constraints they make satisfiable, and consolidation-
  // referenced ownership policies are never silently rewritten.
  const firstRepair = migration.search(/DO \$fair_value_prices_repair\$/);
  const firstConstraint = migration.search(/ADD CONSTRAINT fair_value_prices_no_active_overlap/);
  assert.ok(firstRepair >= 0 && firstRepair < firstConstraint);
  assert.match(migration, /consolidation-used policies % and % overlap/);
  assert.match(migration, /RAISE NOTICE 'fair_value_prices repair/);
});

test("payroll commit has durable exact-source selection evidence", () => {
  const migration = readFileSync(payrollCommitSelectionFenceMigrationPath, "utf8");
  assert.match(migration, /ADD COLUMN calculation_source_snapshot jsonb/);
  assert.match(migration, /ADD COLUMN calculation_source_digest text/);
  assert.match(migration, /pay_runs_calculation_source_pair/);
  assert.match(migration, /\^\[0-9a-f\]\{64\}\$/);
  assert.match(migration, /openbooks_refresh_query_catalog/);
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

test("WIP pre-bill evidence is wipeable only through the scoped sandbox helper", () => {
  const migration = readFileSync(wipPrebillSandboxWipeMigrationPath, "utf8");
  const definition = migration.match(
    /CREATE OR REPLACE FUNCTION public\.wip_prebill_event_append_only_guard\(\) RETURNS trigger[\s\S]*?\$\$;/,
  )?.[0];
  assert.ok(definition, "0043 must replace the deployed WIP pre-bill event guard");
  assert.match(
    definition,
    /IF TG_OP = 'DELETE' AND public\.openbooks_sandbox_wipe_allowed\(OLD\.org_id\) THEN\s+RETURN OLD;/,
  );
  assert.doesNotMatch(definition, /current_setting\(/);
  assert.match(definition, /RAISE EXCEPTION 'WIP prebill events are append-only'/);
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

test("document header totals are enforced against the document's own lines", () => {
  const migration = readFileSync(documentTotalLineInvariantMigrationPath, "utf8");
  // One validator owns the commit-time assertion for commercial and
  // journal-shaped documents.
  assert.match(
    migration,
    /CREATE OR REPLACE FUNCTION public\.assert_document_totals_match_lines/,
  );
  assert.match(migration, /v_kind IN \('journal', 'pay_run'\)/);
  // A line mutation refreshes the list header inside storage. This preserves
  // native line-at-a-time writers without giving them authority to strand a
  // stale denormalized total.
  assert.match(
    migration,
    /CREATE TRIGGER document_lines_total_line_refresh/,
  );
  assert.match(
    migration,
    /AFTER INSERT OR DELETE OR UPDATE OF amount, tax_amount, document_id, org_id/,
  );
  // Both sides are then checked against the finished transaction shape, so an
  // explicit contradictory header write still fails at COMMIT.
  assert.match(migration, /CREATE CONSTRAINT TRIGGER documents_total_line_tieout/);
  assert.match(migration, /AFTER INSERT OR UPDATE ON public\.documents/);
  assert.match(
    migration,
    /CREATE CONSTRAINT TRIGGER document_lines_total_line_tieout/,
  );
  assert.match(
    migration,
    /AFTER INSERT OR UPDATE OR DELETE ON public\.document_lines/,
  );
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/);
  // Rollout heals the known legacy retainage drift from the lines themselves.
  assert.match(migration, /WITH line_agg AS/);
  assert.match(migration, /UPDATE public\.documents d/);
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

test("subsidiary tree mutations serialize before their cycle recheck", () => {
  const migration = readFileSync(subsidiaryTreeGuardSerializationMigrationPath, "utf8");
  assert.match(
    migration,
    /CREATE OR REPLACE FUNCTION public\.subsidiary_tree_guard\(\) RETURNS trigger\s+LANGUAGE plpgsql VOLATILE/,
  );
  assert.match(
    migration,
    /pg_advisory_xact_lock\(\s*hashtextextended\('subsidiary-tree:' \|\| tree_org::text, 0\)\s*\)/,
  );
  assert.match(migration, /LEAST\(OLD\.org_id::text, NEW\.org_id::text\)::uuid/);
  assert.match(migration, /GREATEST\(OLD\.org_id::text, NEW\.org_id::text\)::uuid/);
  const fence = migration.indexOf("pg_advisory_xact_lock(");
  const parentCheck = migration.indexOf("IF NEW.parent_id IS NOT NULL THEN");
  assert.ok(fence >= 0 && fence < parentCheck, "the tree fence must precede every parent/cycle read");
  assert.match(
    migration,
    /WITH RECURSIVE descendants AS[\s\S]*WHERE subsidiary\.org_id = NEW\.org_id/,
  );
  assert.match(migration, /COMMENT ON FUNCTION public\.subsidiary_tree_guard\(\) IS/);
});

test("segment value hierarchy mutations serialize before their cycle recheck", () => {
  const migration = readFileSync(segmentValueHierarchySerializationMigrationPath, "utf8");
  assert.match(
    migration,
    /CREATE OR REPLACE FUNCTION public\.segment_value_guard\(\) RETURNS trigger\s+LANGUAGE plpgsql VOLATILE/,
  );
  assert.match(
    migration,
    /pg_advisory_xact_lock\(\s*hashtextextended\('segment-value-tree:' \|\| tree_scope, 0\)\s*\)/,
  );
  assert.match(migration, /LEAST\(old_scope, new_scope\)/);
  assert.match(migration, /GREATEST\(old_scope, new_scope\)/);
  const fence = migration.indexOf("pg_advisory_xact_lock(");
  const segmentCheck = migration.indexOf("SELECT is_hierarchical INTO v_hierarchical");
  assert.ok(fence >= 0 && fence < segmentCheck, "the segment tree fence must precede every hierarchy read");
  assert.match(
    migration,
    /WITH RECURSIVE descendants AS[\s\S]*WHERE value\.org_id = NEW\.org_id[\s\S]*AND value\.segment_id = NEW\.segment_id/,
  );
  assert.match(migration, /COMMENT ON FUNCTION public\.segment_value_guard\(\) IS/);
});

test("ownership evidence insertion serializes with the policy's first use", () => {
  const migration = readFileSync(ownershipPolicyFirstUseSerializationMigrationPath, "utf8");

  assert.match(
    migration,
    /CREATE OR REPLACE FUNCTION public\.ownership_evidence_policy_fence\(\) RETURNS trigger\s+LANGUAGE plpgsql VOLATILE/,
  );
  // The lock must precede every other read and be an explicit FOR SHARE:
  // the FK's implicit FOR KEY SHARE does not conflict with material
  // (non-key) policy updates, which is exactly the first-use race.
  assert.match(
    migration,
    /FROM public\.subsidiary_ownership_interests policy\s+WHERE policy\.id = NEW\.interest_id\s+AND policy\.org_id = NEW\.org_id\s+FOR SHARE/,
  );
  assert.match(migration, /ERRCODE = '23503'/);
  assert.match(
    migration,
    /CREATE TRIGGER ownership_evidence_policy_fence\s+BEFORE INSERT ON public\.ownership_consolidation_entries/,
  );
  assert.match(migration, /COMMENT ON FUNCTION public\.ownership_evidence_policy_fence\(\) IS/);
  assert.doesNotMatch(migration, /^\s*(?:UPDATE|DELETE\s+FROM)\s/im);
});

test("ledger headers, lines, and trigger reads are tenant coherent", () => {
  const migration = readFileSync(ledgerTenantCoherenceMigrationPath, "utf8");

  assert.match(migration, /DO \$preflight\$/);
  assert.match(
    migration,
    /ledger tenant-coherence migration found a cross-organization reference/,
  );
  assert.match(migration, /this migration never rewrites ledger history/);

  const expectedForeignKeys = [
    ["journal_entries_book_id_fkey", "org_id, book_id", "accounting_books"],
    ["journal_entries_period_id_fkey", "org_id, period_id", "accounting_periods"],
    ["journal_entries_reverses_entry_id_fkey", "org_id, reverses_entry_id", "journal_entries"],
    ["journal_entries_source_document_id_fkey", "org_id, source_document_id", "documents"],
    ["journal_entries_subsidiary_id_fkey", "org_id, subsidiary_id", "subsidiaries"],
    ["journal_lines_account_id_fkey", "org_id, account_id", "accounts"],
    ["journal_lines_class_id_fkey", "org_id, class_id", "classes"],
    ["journal_lines_department_id_fkey", "org_id, department_id", "departments"],
    ["journal_lines_entry_id_fkey", "org_id, entry_id", "journal_entries"],
    ["journal_lines_equipment_unit_id_fkey", "org_id, equipment_unit_id", "equipment_units"],
    ["journal_lines_location_id_fkey", "org_id, location_id", "locations"],
    ["journal_lines_party_id_fkey", "org_id, party_id", "parties"],
    ["journal_lines_payment_card_id_fkey", "org_id, payment_card_id", "payment_cards"],
    ["journal_lines_project_id_fkey", "org_id, project_id", "projects"],
    ["journal_lines_subsidiary_id_fkey", "org_id, subsidiary_id", "subsidiaries"],
    ["journal_lines_tax_code_id_fkey", "org_id, tax_code_id", "tax_codes"],
  ] as const;
  for (const [constraint, columns, target] of expectedForeignKeys) {
    assert.match(
      migration,
      new RegExp(
        `ADD CONSTRAINT ${constraint}\\s+FOREIGN KEY \\(${columns}\\)\\s+REFERENCES public\\.${target} \\(org_id, id\\) DEFERRABLE NOT VALID`,
      ),
    );
    assert.match(
      migration,
      new RegExp(`VALIDATE CONSTRAINT ${constraint}`),
    );
  }

  assert.match(
    migration,
    /from accounts\s+where id = new\.account_id and org_id = new\.org_id/,
  );
  assert.match(
    migration,
    /from journal_lines\s+where entry_id = new\.id and org_id = new\.org_id/,
  );
  assert.match(migration, /where id = v_entry and org_id = v_line_org/);
  assert.match(migration, /e\.id = l\.entry_id and e\.org_id = l\.org_id/);
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
