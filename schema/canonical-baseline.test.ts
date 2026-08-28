import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { PERMISSION_CATALOGUE } from "@openbooks/engine/src/permissions.ts";

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
const rateBookCurrencySerializationMigrationPath =
  "schema/migrations/generated/0048_rate_book_currency_serialization.sql";
const ownershipPolicyFirstUseSerializationMigrationPath =
  "schema/migrations/generated/0050_ownership_policy_first_use_serialization.sql";
const documentTenantForeignKeysMigrationPath =
  "schema/migrations/generated/0039_document_tenant_coherent_foreign_keys.sql";
const ledgerTenantCoherenceMigrationPath =
  "schema/migrations/generated/0038_ledger_tenant_coherent_foreign_keys.sql";
const paymentSurchargeRuleUniquenessMigrationPath =
  "schema/migrations/generated/0023_payment_surcharge_rule_uniqueness.sql";
const taxRateEffectiveRangeExclusionMigrationPath =
  "schema/migrations/generated/0024_tax_rate_effective_range_exclusion.sql";
const schedulerOutboxTerminalAuditMigrationPath =
  "schema/migrations/generated/0026_scheduler_outbox_terminal_audit.sql";
const sftpUsernameGlobalUniqueMigrationPath =
  "schema/migrations/generated/0029_sftp_username_global_unique.sql";
const sftpRootPrefixTenantContainmentMigrationPath =
  "schema/migrations/generated/0030_sftp_root_prefix_tenant_containment.sql";
const apiKeyExplicitScopesMigrationPath =
  "schema/migrations/generated/0031_api_key_explicit_scopes.sql";
const documentNumberSequenceGlobalityMigrationPath =
  "schema/migrations/generated/0032_document_number_sequence_globality.sql";
const reportingFrameworkPolicyMigrationPath =
  "schema/migrations/generated/0033_reporting_framework_policy.sql";
const documentLineImmutabilityMigrationPath =
  "schema/migrations/generated/0034_document_line_immutability.sql";
const accountPostingClassificationSerializationMigrationPath =
  "schema/migrations/generated/0046_account_posting_classification_serialization.sql";
const subscriptionConfigurationInvariantsMigrationPath =
  "schema/migrations/generated/0041_subscription_configuration_invariants.sql";
const taxRateDomainConstraintsMigrationPath =
  "schema/migrations/generated/0042_tax_rate_domain_constraints.sql";
const effectiveDateOverlapExclusionMigrationPath =
  "schema/migrations/generated/0051_effective_date_overlap_exclusion_constraints.sql";
const emailDeliveryIdentityReconciliationMigrationPath =
  "schema/migrations/generated/0059_email_delivery_identity_reconciliation.sql";
const emailDeliveryIdempotencyMigrationPath =
  "schema/migrations/generated/0063_email_delivery_idempotency.sql";
const bankFeedAttemptWatermarkMigrationPath =
  "schema/migrations/generated/0054_bank_feed_attempt_watermark.sql";
const scriptRunActorMigrationPath =
  "schema/migrations/generated/0056_script_run_actor.sql";
const leaseBaseRentWindowExclusiveMigrationPath =
  "schema/migrations/generated/0060_lease_base_rent_window_exclusive.sql";
const camPoolSourceAccountOverlapMigrationPath =
  "schema/migrations/generated/0061_cam_pool_source_account_overlap.sql";
const recognitionEventsMigrationPath =
  "schema/migrations/generated/0062_recognition_events.sql";
const sandboxWipeGuardAuthorizationMigrationPath =
  "schema/migrations/generated/0078_sandbox_wipe_guard_authorization.sql";

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
    "0008_scheduler_outbox_terminal_columns.sql",
    "0009_posting_effect_idempotency_keys.sql",
    "0010_bank_statement_source_evidence.sql",
    "0011_payment_run_live_selection.sql",
    "0012_payment_run_posting_recovery.sql",
    "0013_document_revision_monotonic.sql",
    "0014_flow_email_outbox.sql",
    "0015_payment_instruction_posting_claim_fence.sql",
    "0016_gl_month_activity_book_id.sql",
    "0017_document_total_line_invariant.sql",
    "0018_field_ticket_evidence_integrity_guard.sql",
    "0019_sandbox_wipe_guard_guc.sql",
    "0020_inventory_subsidiary_ownership.sql",
    "0022_close_posting_fence.sql",
    "0023_payment_surcharge_rule_uniqueness.sql",
    "0024_tax_rate_effective_range_exclusion.sql",
    "0026_scheduler_outbox_terminal_audit.sql",
    "0029_sftp_username_global_unique.sql",
    "0030_sftp_root_prefix_tenant_containment.sql",
    "0031_api_key_explicit_scopes.sql",
    "0032_document_number_sequence_globality.sql",
    "0033_reporting_framework_policy.sql",
    "0034_document_line_immutability.sql",
    "0035_terminal_failure_surfacing.sql",
    "0036_bank_statement_source_idempotency.sql",
    "0037_payment_acceptance_account_references.sql",
    "0038_ledger_tenant_coherent_foreign_keys.sql",
    "0039_document_tenant_coherent_foreign_keys.sql",
    "0040_payroll_commit_selection_fence.sql",
    "0041_subscription_configuration_invariants.sql",
    "0042_tax_rate_domain_constraints.sql",
    "0043_sandbox_wip_prebill_wipe_guard.sql",
    "0044_tenant_foreign_key_org_coherence.sql",
    "0045_subsidiary_tree_guard_serialization.sql",
    "0046_account_posting_classification_serialization.sql",
    "0047_segment_value_hierarchy_serialization.sql",
    "0048_rate_book_currency_serialization.sql",
    "0049_payment_schedule_occurrence_durability.sql",
    "0050_ownership_policy_first_use_serialization.sql",
    "0051_effective_date_overlap_exclusion_constraints.sql",
    "0052_durable_work_lease_fencing.sql",
    "0053_application_idempotency_app_source.sql",
    "0054_bank_feed_attempt_watermark.sql",
    "0055_flow_scheduled_occurrence_durability.sql",
    "0056_script_run_actor.sql",
    "0057_close_automation_claim_lease.sql",
    "0058_fx_provider_run_lease_fencing.sql",
    "0059_email_delivery_identity_reconciliation.sql",
    "0060_lease_base_rent_window_exclusive.sql",
    "0061_cam_pool_source_account_overlap.sql",
    "0062_recognition_events.sql",
    "0063_email_delivery_idempotency.sql",
    "0064_order_quantity_progress_precision.sql",
    "0065_payroll_voided_run_replacement.sql",
    "0066_change_set_review_approval_audit.sql",
    "0067_insights_home_uniqueness.sql",
    "0068_equipment_capitalization_concurrency.sql",
    "0070_governed_query_private_projection.sql",
    "0071_information_return_root_uniqueness.sql",
    "0072_payroll_parallel_unattributed_uniqueness.sql",
    "0073_pay_application_invoice_tenant_fk.sql",
    "0074_recognition_event_idempotency.sql",
    "0075_payroll_bank_file_release_status_evidence.sql",
    "0076_work_schedule_group_expression_uniqueness.sql",
    "0077_project_overhead_adjustment_reversal_uniqueness.sql",
    "0078_sandbox_wipe_guard_authorization.sql",
    "0079_budget_subsidiary.sql",
    "0080_payment_instruction_claim_fence_bundle_guard.sql",
    "0081_account_group_member_dimension_uniqueness.sql",
    "0082_asset_draft_number_uniqueness.sql",
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

test("reporting framework policy is explicit and preserves the legacy effective value", () => {
  const migration = readFileSync(reportingFrameworkPolicyMigrationPath, "utf8");

  // The upgrade writes only the org settings document and is rerunnable.  Its
  // CASE is the exact pre-0033 read rule: IAS 12 meant IFRS; everything else
  // meant US GAAP.
  assert.match(migration, /UPDATE public\.orgs[\s\S]*settings = jsonb_set/);
  assert.match(
    migration,
    /CASE\s+WHEN settings->>'taxFramework'\s*=\s*'ias12'\s+THEN\s*'ifrs'\s+ELSE\s*'us_gaap'\s+END/,
  );
  assert.match(
    migration,
    /settings->>'reportingFramework' IS NULL\s+OR settings->>'reportingFramework' NOT IN \('us_gaap', 'ifrs'\)/,
  );
  const updateTargets = [
    ...migration.matchAll(/^\s*UPDATE\s+(?:ONLY\s+)?(?:public\.)?([a-z_]+)/gm),
  ].map((match) => match[1]);
  assert.deepEqual(updateTargets, ["orgs"]);
  assert.doesNotMatch(migration, /0001_baseline/);
});

test("document numbering allocates from one org-wide sequence with monotonic safety", () => {
  const migration = readFileSync(documentNumberSequenceGlobalityMigrationPath, "utf8");

  // Document numbers are org-wide identities (documents UNIQUE org/kind/number
  // has no subsidiary column), so storage must force exactly ONE sequence row
  // per (organization, kind): the old per-subsidiary unique constraint is
  // replaced and per-subsidiary rows are refused outright.
  assert.match(
    migration,
    /ADD CONSTRAINT sequences_org_kind_sub UNIQUE \(org_id, document_kind\)/,
  );
  assert.match(
    migration,
    /ADD CONSTRAINT number_sequences_org_wide_sequence CHECK \(subsidiary_id IS NULL\)/,
  );
  assert.match(
    migration,
    /ADD CONSTRAINT number_sequences_next_number_positive CHECK \(next_number >= 1\)/,
  );

  // Monotonic safety: every issued counter value raises the watermark, and a
  // used sequence can neither decrease into an occupied output range nor
  // change the output format it already issued.
  const watermark = migration.match(
    /CREATE OR REPLACE FUNCTION public\.number_sequences_allocation_watermark\(\) RETURNS trigger[\s\S]*?^\$\$;/m,
  )?.[0];
  assert.ok(watermark, "0032 must install the allocation watermark");
  assert.match(watermark, /GREATEST\(NEW\.allocated_through, NEW\.next_number\)/);
  const guard = migration.match(
    /CREATE OR REPLACE FUNCTION public\.number_sequences_monotonic_guard\(\) RETURNS trigger[\s\S]*?^\$\$;/m,
  )?.[0];
  assert.ok(guard, "0032 must install the monotonic guard");
  assert.match(guard, /NEW\.next_number < OLD\.allocated_through/);
  assert.match(guard, /NEW\.prefix IS DISTINCT FROM OLD\.prefix/);
  assert.match(guard, /NEW\.padding IS DISTINCT FROM OLD\.padding/);
  assert.match(
    migration,
    /CREATE TRIGGER number_sequences_monotonic_guard\s+BEFORE UPDATE\s+ON public\.number_sequences/i,
  );

  // The deterministic legacy repair runs BEFORE enforcement lands, and the
  // only rows it deletes are per-subsidiary sequence configuration — never
  // documents or any financial history.
  const firstRepair = migration.search(/CREATE OR REPLACE FUNCTION public\.openbooks_repair_document_sequences/);
  const firstEnforcement = migration.search(
    /ADD CONSTRAINT sequences_org_kind_sub UNIQUE/,
  );
  assert.ok(firstRepair >= 0 && firstEnforcement > firstRepair, "repair must precede enforcement");
  const updateTargets = [...migration.matchAll(/^\s*(?:UPDATE|DELETE FROM)\s+(?:ONLY\s+)?(?:public\.)?([a-z_]+)/gm)].map(
    (m) => m[1],
  );
  assert.notEqual(updateTargets.length, 0);
  assert.deepEqual(updateTargets.filter((target) => target !== "number_sequences"), []);
  assert.match(migration, /DELETE FROM public\.number_sequences WHERE subsidiary_id IS NOT NULL/);
});

test("document lines are storage-immutable outside draft status", () => {
  const migration = readFileSync(documentLineImmutabilityMigrationPath, "utf8");
  const guard = migration.match(
    /CREATE OR REPLACE FUNCTION public\.document_line_immutability_guard\(\) RETURNS trigger[\s\S]*?\$\$;/,
  )?.[0];
  assert.ok(guard, "0034 must install the document-line lifecycle guard");
  assert.match(guard, /FROM public\.documents d/);
  assert.match(guard, /ORDER BY d\.id\s+FOR UPDATE/);
  assert.match(guard, /v_parent\.org_id IS DISTINCT FROM/);
  assert.match(guard, /v_(?:old|new)_status IS DISTINCT FROM 'draft'/);
  assert.match(guard, /openbooks_sandbox_wipe_allowed/);
  assert.match(guard, /current_setting\('openbooks\.migration'/);
  assert.match(guard, /current_setting\('openbooks\.amend'/);
  assert.match(
    migration,
    /CREATE TRIGGER document_line_immutability\s+BEFORE INSERT OR DELETE OR UPDATE ON public\.document_lines/i,
  );
  // Replaying the forward file replaces the function and recreates one named
  // trigger; it does not rewrite any document or line history.
  assert.match(migration, /DROP TRIGGER IF EXISTS document_line_immutability/);
  assert.doesNotMatch(migration, /^\s*(?:UPDATE|DELETE FROM)\s+public\.(?:documents|document_lines)/im);
});

test("CAM pools cannot bill one GL expense twice through shared sources", () => {
  const migration = readFileSync(camPoolSourceAccountOverlapMigrationPath, "utf8");

  // Exclusivity lives at the storage boundary inside a trigger: the advisory
  // fence must precede every read so mutually uncommitted writers serialize
  // instead of each passing an application-level check (0051's race class).
  const guard = migration.match(
    /CREATE FUNCTION public\.cam_pool_source_account_guard\(\) RETURNS trigger[\s\S]*?\$\$;/,
  )?.[0];
  assert.ok(guard, "0061 must install a storage-side CAM pool guard");
  const fenceAt = guard.indexOf("pg_advisory_xact_lock(");
  const overlapReadAt = guard.indexOf("FROM public.cam_pools other");
  assert.ok(fenceAt >= 0 && overlapReadAt > fenceAt, "the fence must precede the overlap read");
  assert.match(
    guard,
    /hashtextextended\('cam-pool:' \|\| new\.org_id::text \|\| ':' \|\| new\.property_id::text, 0\)/,
  );
  // Inclusive window overlap plus account intersection, self-excluded on update.
  assert.match(guard, /other\.period_starts_on <= new\.period_ends_on/);
  assert.match(guard, /other\.period_ends_on >= new\.period_starts_on/);
  assert.match(guard, /\(TG_OP = 'INSERT' OR other\.id <> new\.id\)/);
  assert.match(guard, /jsonb_array_elements_text\(new\.expense_account_ids\)/);
  // Retiring always succeeds; both creation and updates are arbitrated.
  assert.match(guard, /IF new\.status = 'cancelled' THEN/);
  assert.match(
    migration,
    /CREATE TRIGGER cam_pool_source_account_guard\s+BEFORE INSERT OR UPDATE ON public\.cam_pools/i,
  );
  assert.match(migration, /COMMENT ON FUNCTION public\.cam_pool_source_account_guard\(\) IS/);

  // Repair runs before enforcement is installed, and the only situations it
  // refuses to heal automatically are financially committed on both sides —
  // the non-destructive review policy. Nothing else rewrites history.
  const firstRepair = migration.search(/DO \$cam_pool_source_overlap_repair\$/);
  const firstEnforcement = migration.search(/CREATE FUNCTION public\.cam_pool_source_account_guard/);
  assert.ok(firstRepair >= 0 && firstRepair < firstEnforcement, "repair must precede the trigger");
  assert.match(migration, /resolve them manually before migrating/);
  // The repair's only writes are CAM pool cancellations; no history is
  // deleted or re-dated.
  const updateTargets = [...migration.matchAll(/^\s*UPDATE\s+(?:ONLY\s+)?(?:public\.)?([a-z_]+)/gm)].map((m) => m[1]);
  assert.notEqual(updateTargets.length, 0);
  assert.deepEqual(updateTargets.filter((target) => target !== "cam_pools"), []);
  assert.doesNotMatch(migration, /DELETE FROM/i);
});

test("script runs attribute their trigger at the storage boundary", () => {
  const migration = readFileSync(scriptRunActorMigrationPath, "utf8");

  assert.match(
    migration,
    /ALTER TABLE public\.script_runs ADD COLUMN IF NOT EXISTS created_by uuid/,
  );
  // Attribution semantics are documented where every query can see them.
  assert.match(migration, /interactive triggers persist users\.id; NULL means the system triggered/);
  // Actor provenance is an additive column, never a history rewrite.
  assert.doesNotMatch(migration, /^\s*(?:UPDATE|DELETE\s+FROM)\s/im);
});

test("base-rent windows are exclusive at the storage boundary", () => {
  const migration = readFileSync(leaseBaseRentWindowExclusiveMigrationPath, "utf8");

  // One partial GiST exclusion constraint owns base-rent exclusivity for
  // every writer — API, import, and direct SQL alike (0051's pattern).
  assert.match(
    migration,
    /ADD CONSTRAINT lease_charges_base_rent_no_overlap\s+EXCLUDE USING gist \(\s+org_id WITH =,\s+lease_id WITH =,\s+\(daterange\(effective_from, effective_to, '\[\]'\)\) WITH &&\s+\)\s+WHERE \(charge_type = 'base_rent'\)/,
  );
  // The repair runs before the constraint is added, never deletes billed
  // history (only orphanless duplicates), and escalations' adjacent-window
  // supersede convention stays representable under inclusive ranges.
  assert.match(migration, /lease_charges_base_rent_repair\$/);
  assert.match(migration, /status = 'scheduled'/);
  assert.doesNotMatch(
    migration,
    /DELETE FROM public\.lease_schedule_lines/,
    "repair must not delete schedule lines",
  );
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

test("scheduler outbox terminal failures carry immutable, exactly-once audit evidence", () => {
  const migration = readFileSync(schedulerOutboxTerminalAuditMigrationPath, "utf8");

  // The evidence channel is append-only at the storage boundary — no UPDATE
  // and no DELETE can rewrite a transition that already happened, for tenant
  // and org-less system scans alike. Only the scoped sandbox wipe helper may
  // remove rows, mirroring every other append-only evidence table.
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.scheduler_outbox_terminal_audit/);
  const guard = migration.match(
    /CREATE OR REPLACE FUNCTION public\.scheduler_outbox_terminal_audit_append_only_guard\(\)\s+RETURNS trigger[\s\S]*?\$\$;/,
  )?.[0];
  assert.ok(guard, "0026 must install an append-only guard over the evidence table");
  assert.match(guard, /openbooks_sandbox_wipe_allowed\(OLD\.org_id\)/);
  assert.match(guard, /RAISE EXCEPTION 'scheduler_outbox_terminal_audit is append-only'/);
  assert.match(
    migration,
    /CREATE TRIGGER scheduler_outbox_terminal_audit_append_only\s+BEFORE UPDATE OR DELETE ON public\.scheduler_outbox_terminal_audit/,
  );
  // Exactly-once: one terminal-failure record and one replay authorization per
  // outbox occurrence, enforced by storage instead of worker discipline.
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS scheduler_outbox_terminal_audit_one_failure\s+ON public\.scheduler_outbox_terminal_audit USING btree \(outbox_row_id\)\s+WHERE event <> 'replay_authorized'/,
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS scheduler_outbox_terminal_audit_one_replay\s+ON public\.scheduler_outbox_terminal_audit USING btree \(outbox_row_id\)\s+WHERE event = 'replay_authorized'/,
  );

  // Replay authorization is transaction-scoped to exactly one organization.
  assert.match(
    migration,
    /CREATE OR REPLACE FUNCTION public\.openbooks_scheduler_outbox_replay_allowed\(\s*p_org_id uuid\s*\)/,
  );
  assert.match(migration, /current_setting\('openbooks\.scheduler_outbox_replay_org', true\)\s*=\s*p_org_id::text/);

  // A stamped row freezes its audit-bearing facts: any rewrite without the
  // replay authorization raises, and clearing the stamps requires BOTH the
  // prior replay evidence and the organization's transaction pin in the same
  // transaction — an unevidenced reset rolls back with everything else.
  const terminalGuard = migration.match(
    /CREATE OR REPLACE FUNCTION public\.scheduler_outbox_terminal_guard\(\)\s+RETURNS trigger[\s\S]*?\$\$;/,
  )?.[0];
  assert.ok(terminalGuard, "0026 must freeze stamped scheduler_outbox rows");
  assert.match(terminalGuard, /IF OLD\.terminal_failed_at IS NULL THEN/);
  for (const frozenFact of [
    "NEW\\.org_id IS DISTINCT FROM OLD\\.org_id",
    "NEW\\.kind IS DISTINCT FROM OLD\\.kind",
    "NEW\\.occurrence_key IS DISTINCT FROM OLD\\.occurrence_key",
    "NEW\\.payload IS DISTINCT FROM OLD\\.payload",
    "NEW\\.terminal_failed_at IS DISTINCT FROM OLD\\.terminal_failed_at",
    "NEW\\.terminal_failed_by IS DISTINCT FROM OLD\\.terminal_failed_by",
  ]) {
    assert.match(terminalGuard, new RegExp(frozenFact), `guard must freeze ${frozenFact}`);
  }
  assert.match(
    terminalGuard,
    /RAISE EXCEPTION 'scheduler_outbox terminal-failure evidence is immutable; authorize a replay to reset it'/,
  );
  const stampClearAt = terminalGuard.indexOf("NEW.terminal_failed_at IS NOT DISTINCT FROM OLD.terminal_failed_at");
  const evidenceReadAt = terminalGuard.indexOf("FROM public.scheduler_outbox_terminal_audit prior");
  const pinReadAt = terminalGuard.indexOf("openbooks_scheduler_outbox_replay_allowed(OLD.org_id)");
  assert.ok(stampClearAt >= 0 && evidenceReadAt > stampClearAt && pinReadAt > evidenceReadAt,
    "stamp-clearing must be gated by prior evidence, then by the pin");
  assert.match(terminalGuard, /prior\.event = 'replay_authorized'/);
  assert.match(
    terminalGuard,
    /RAISE EXCEPTION 'a scheduler_outbox replay reset requires its replay_authorized audit evidence first'/,
  );
  assert.match(
    migration,
    /CREATE TRIGGER scheduler_outbox_terminal_guard_trigger\s+BEFORE UPDATE ON public\.scheduler_outbox/,
  );

  // Pre-existing poison arrives with its history intact: the backfill is
  // additive, marks its provenance, and never duplicates on re-execution.
  assert.match(migration, /INSERT INTO public\.scheduler_outbox_terminal_audit/);
  assert.match(migration, /'pre_0026_backfill'/);
  assert.doesNotMatch(migration, /^\s*(?:UPDATE|DELETE\s+FROM)\s/im);
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
  assert.match(
    migration,
    /COALESCE\(provider, '__all_providers__'::text\)\) WITH =/,
  );
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

test("one effective tax-rate window per tax code is enforced by storage, not by the racy trigger read", () => {
  const migration = readFileSync(taxRateEffectiveRangeExclusionMigrationPath, "utf8");

  // The overlap trigger stays: it is what turns a duplicate write into the
  // product's readable conflict message for every serial writer. Only its
  // blind spot — mutually uncommitted windows — is covered here.
  assert.doesNotMatch(migration, /DROP TRIGGER|DROP FUNCTION/);

  // GiST needs uuid operator classes from btree_gist; omitting it silently
  // would silently omit the invariant.
  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public/);
  assert.match(
    migration,
    /ADD CONSTRAINT tax_rates_effective_range_exclusion\s+EXCLUDE USING gist/,
  );
  // Identity columns key equality exactly like the trigger's WHERE clause.
  assert.match(migration, /org_id WITH =/);
  assert.match(migration, /tax_code_id WITH =/);
  // The range constructor must accept exactly what
  // effective_date_ranges_overlap accepts: inclusive bounds and an open-ended
  // null effective_to folded onto 'infinity'. A plain daterange on a nullable
  // effective_to would diverge from the product's own semantics.
  assert.match(
    migration,
    /\(daterange\(effective_from, COALESCE\(effective_to, 'infinity'::date\), '\[\]'\)\) WITH &&/,
  );
  assert.match(
    migration,
    /COMMENT ON CONSTRAINT tax_rates_effective_range_exclusion/,
  );
  // The baseline keeps its published trigger untouched.
  assert.match(baseline, /CREATE FUNCTION public\.tax_rates_no_overlap_guard/);
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
  const effectiveFunctions = new Map<string, string>();
  const functionDefinition =
    /CREATE(?: OR REPLACE)? FUNCTION public\.([a-z0-9_]+)\([^;]*?\)\s+RETURNS[\s\S]*?\s+AS (\$[a-z0-9_]*\$)([\s\S]*?)\2;/gi;
  for (const source of migrationSources.values()) {
    for (const match of source.matchAll(functionDefinition)) {
      effectiveFunctions.set(match[1]!, match[3]!);
    }
  }
  const effectiveWipeBodies = new Map(
    [...effectiveFunctions].filter(([, body]) => body.includes("sandbox_wipe")),
  );
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

test("0078 authorizes sandbox wipe exemptions only for tenant deletes", () => {
  const migration = readFileSync(sandboxWipeGuardAuthorizationMigrationPath, "utf8");
  assert.doesNotMatch(
    migration,
    /current_setting\(['"](?:openbooks|app)\.sandbox_wipe['"]/i,
    "0078 must not trust a raw wipe GUC in a guard body",
  );
  assert.doesNotMatch(migration, /0001_baseline/);

  const expectedFunctions = [
    "depreciation_evidence_attachment_guard",
    "inventory_provisional_immutable",
    "openbooks_guard_depreciation_evidence",
    "je_guard",
    "openbooks_gl_activity_entry",
    "openbooks_gl_activity_line",
    "openbooks_je_cascade_posting_date",
    "openbooks_party_payment_stats",
    "posted_document_financial_guard",
    "protect_country_tax_pack_installation",
    "subscription_amendment_immutable_guard",
    "subscription_period_invoice_immutable_guard",
    "subscription_plan_version_immutable_guard",
    "subscription_version_component_immutable_guard",
    "recurring_occurrence_document_immutable_guard",
    "enforce_payment_instruction_posting_claim",
    "assert_document_totals_match_lines",
    "refresh_document_totals_from_lines",
    "document_lines_total_line_refresh",
    "documents_total_line_tieout",
    "document_lines_total_line_tieout",
  ];
  for (const functionName of expectedFunctions) {
    assert.match(
      migration,
      new RegExp(`CREATE OR REPLACE FUNCTION public\\.${functionName}\\(`),
      `0078 must replace ${functionName}`,
    );
  }

  const deleteOnlyFunctions = [
    "depreciation_evidence_attachment_guard",
    "inventory_provisional_immutable",
    "openbooks_guard_depreciation_evidence",
    "je_guard",
    "openbooks_gl_activity_entry",
    "openbooks_gl_activity_line",
    "openbooks_party_payment_stats",
    "posted_document_financial_guard",
    "protect_country_tax_pack_installation",
    "subscription_amendment_immutable_guard",
    "subscription_period_invoice_immutable_guard",
    "subscription_plan_version_immutable_guard",
    "subscription_version_component_immutable_guard",
    "recurring_occurrence_document_immutable_guard",
    "enforce_payment_instruction_posting_claim",
    "document_lines_total_line_refresh",
    "document_lines_total_line_tieout",
  ];
  for (const functionName of deleteOnlyFunctions) {
    const definition = migration.match(
      new RegExp(
        `CREATE OR REPLACE FUNCTION public\\.${functionName}\\([\\s\\S]*?\\$\\$;`,
      ),
    )?.[0];
    assert.ok(definition, `0078 definition missing for ${functionName}`);
    assert.match(
      definition,
      /TG_OP\s*=\s*'DELETE'\s+AND\s+(?:public\.)?openbooks_sandbox_wipe_allowed\(/i,
      `${functionName} may bypass only an authorized DELETE`,
    );
    assert.doesNotMatch(definition, /current_setting\([^)]*sandbox_wipe/i);
  }
  const cascade = migration.match(
    /CREATE OR REPLACE FUNCTION public\.openbooks_je_cascade_posting_date\([\s\S]*?\$\$;/,
  )?.[0];
  assert.ok(cascade);
  assert.doesNotMatch(cascade, /sandbox_wipe|current_setting\(/i);
  for (const functionName of ["assert_document_totals_match_lines", "refresh_document_totals_from_lines"]) {
    const definition = migration.match(
      new RegExp(`CREATE OR REPLACE FUNCTION public\\.${functionName}\\([\\s\\S]*?\\$\\$;`),
    )?.[0];
    assert.ok(definition);
    assert.doesNotMatch(definition, /sandbox_wipe|current_setting\(/i);
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

test("email delivery attempts share one canonical identity and uncertain outcomes are representable", () => {
  const migration = readFileSync(emailDeliveryIdentityReconciliationMigrationPath, "utf8");

  // One stable per-delivery identity, unique when present, so a retried
  // attempt claims the same canonical email_log row instead of minting
  // parallel histories.
  assert.match(migration, /ADD COLUMN IF NOT EXISTS delivery_key text/);
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS email_log_delivery_key\s+ON public\.email_log USING btree \(delivery_key\)\s+WHERE delivery_key IS NOT NULL/,
  );
  assert.match(migration, /COMMENT ON COLUMN public\.email_log\.delivery_key IS/);
  // Historical rows are never assigned a guessed identity.
  assert.doesNotMatch(migration, /^\s*UPDATE\s/im);
});

test("email delivery idempotency enforces delivery key format at the storage boundary", () => {
  const migration = readFileSync(emailDeliveryIdempotencyMigrationPath, "utf8");

  // The CHECK constraint validates the obem_ prefix + 40 hex chars format
  // derived by packages/emails/outcome.ts. NULL passes (historical rows).
  assert.match(
    migration,
    /CHECK \(delivery_key IS NULL OR delivery_key ~ '\^obem_\[0-9a-f\]\{40\}\$'\)/,
  );
  assert.match(migration, /NOT VALID/);
  assert.match(migration, /VALIDATE CONSTRAINT email_log_delivery_key_format/);
  assert.match(
    migration,
    /COMMENT ON CONSTRAINT email_log_delivery_key_format ON public\.email_log IS/,
  );

  // Composite index for tenant-scoped claim lookups.
  assert.match(
    migration,
    /CREATE INDEX IF NOT EXISTS email_log_org_delivery\s+ON public\.email_log USING btree \(org_id, delivery_key\)\s+WHERE delivery_key IS NOT NULL/,
  );
  assert.match(migration, /COMMENT ON INDEX public\.email_log_org_delivery IS/);
  // No data manipulation — only additive DDL.
  assert.doesNotMatch(migration, /^\s*(?:UPDATE|DELETE\s+FROM)\s/im);
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

test("first rate version creation serializes with rate-book currency edits", () => {
  const migration = readFileSync(rateBookCurrencySerializationMigrationPath, "utf8");

  // The storage guard must pin the tenant-owned book row with FOR SHARE from
  // before the insert until commit, so a racing currency UPDATE cannot pass
  // rate_book_currency_guard's history check while first-version creation is
  // in flight — for API, import, and direct writers alike.
  const lockGuard = migration.match(
    /CREATE OR REPLACE FUNCTION public\.rate_version_book_lock_guard\(\) RETURNS trigger[\s\S]*?\$\$;/,
  )?.[0];
  assert.ok(lockGuard, "0048 must add a storage guard locking the book before a version insert");
  assert.match(
    lockGuard,
    /from public\.item_rate_books book\s+where book\.id = new\.rate_book_id\s+and book\.org_id = new\.org_id\s+for share/i,
  );
  assert.match(lockGuard, /rate version must reference a tenant-owned rate book/i);

  assert.match(
    migration,
    /CREATE TRIGGER item_rate_versions_book_lock\s+BEFORE INSERT ON public\.item_rate_versions/i,
  );
  assert.match(migration, /COMMENT ON FUNCTION public\.rate_version_book_lock_guard\(\) IS/);
  assert.doesNotMatch(migration, /^\s*(?:UPDATE|DELETE\s+FROM)\s/im);
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

test("bank-feed sync bookkeeping separates the attempt watermark from the success watermark", () => {
  const migration = readFileSync(bankFeedAttemptWatermarkMigrationPath, "utf8");

  assert.match(
    migration,
    /ALTER TABLE public\.bank_feed_connections\s+ADD COLUMN last_attempt_at timestamp with time zone/,
  );
  // The attempt cursor is pure addition: no backfill, no data rewrite, and no
  // touch of last_sync_at (the success-only pull cursor sinceFor reads).
  assert.match(migration, /COMMENT ON COLUMN public\.bank_feed_connections\.last_attempt_at/);
  assert.doesNotMatch(migration, /^\s*(?:UPDATE|DELETE\s+FROM)\s/im);
});

test("sftp root prefixes are tenant-contained: quarantined, never rewritten, storage-enforced", () => {
  const migration = readFileSync(sftpRootPrefixTenantContainmentMigrationPath, "utf8");
  const schema = readFileSync("schema/src/banking.ts", "utf8");

  // The conformance predicate is durable and inspectable: tenant namespace
  // binding (sftp/<orgId>/) plus the escape-shape refusals, one definition for
  // quarantine, verification and operator review.
  assert.match(
    migration,
    /CREATE FUNCTION public\.sftp_root_prefix_tenant_conforms\(p_org_id uuid, p_root_prefix text\)\s+RETURNS boolean\s+LANGUAGE sql\s+IMMUTABLE/,
  );
  assert.match(migration, /\^sftp\/' \|\| p_org_id::text \|\| '\(\/\|\$\)'/);

  // Evidence precedes enforcement: the quarantine (audit insert +
  // deterministic deactivation) must run before the CHECK exists, or the
  // guard's first UPDATE would trip over the legacy prefix it must preserve.
  const firstEvidence = migration.search(/INSERT INTO public\.audit_log/);
  const firstConstraint = migration.search(/ADD CONSTRAINT sftp_servers_root_prefix_safe/);
  assert.ok(firstEvidence >= 0 && firstEvidence < firstConstraint, "quarantine must precede the constraint");

  // The exact prior prefix is preserved verbatim as immutable evidence —
  // before == after on the prefix, only is_active flips. No data is destroyed
  // or rewritten: no prefix value is edited and nothing is deleted.
  const quarantine = migration.match(/WITH quarantined AS MATERIALIZED \([\s\S]*?UPDATE public\.sftp_servers s[\s\S]*?AND s\.is_active;/)?.[0];
  assert.ok(quarantine, "0030 must quarantine deterministically in one atomic unit");
  assert.match(quarantine, /'root_prefix', q\.root_prefix/);
  assert.match(quarantine, /'is_active', true/);
  assert.match(quarantine, /'is_active', false/);
  assert.match(quarantine, /SET is_active = false/);
  assert.doesNotMatch(quarantine, /SET root_prefix/);
  assert.doesNotMatch(migration, /^\s*DELETE\s+FROM\s/im);
  assert.match(migration, /'migration:0030_sftp_root_prefix_tenant_containment'/);
  assert.match(migration, /recreate the SFTP server with a root prefix under sftp\//);

  // Storage enforcement mirrors schema/src/banking.ts: relative, traversal-
  // proof prefixes only. NOT VALID, because quarantined rows keep their exact
  // prior prefix — and any UPDATE re-validates, so a quarantined login cannot
  // be reactivated without remediation.
  const constraint = migration.match(/ALTER TABLE public\.sftp_servers[\s\S]*?NOT VALID;/)?.[0];
  assert.ok(constraint, "0030 must install the storage guard");
  assert.equal(
    constraint,
    `ALTER TABLE public.sftp_servers
  ADD CONSTRAINT sftp_servers_root_prefix_safe
  CHECK (
    root_prefix ~ '^[^/%]+(/[^/%]+)*$'
    AND root_prefix !~ '\\\\'
    AND root_prefix !~ '(^|/)\\.\\.?(/|$)'
  )
  NOT VALID;`,
  );
  assert.match(migration, /COMMENT ON CONSTRAINT sftp_servers_root_prefix_safe/);
  assert.match(
    schema,
    /check\(\s+"sftp_servers_root_prefix_safe",/,
    "the storage guard must be mirrored in the drizzle schema",
  );

  // Fail closed: the migration ends by proving no ACTIVE login resolves
  // outside its tenant namespace or carries an escape shape.
  const verification = migration.match(/DO \$sftp_root_prefix_containment_verification\$[\s\S]*?\$sftp_root_prefix_containment_verification\$;/)?.[0];
  assert.ok(verification, "0030 must verify the end state");
  assert.match(verification, /NOT public\.sftp_root_prefix_tenant_conforms\(s\.org_id, s\.root_prefix\)/);
  assert.match(verification, /RAISE EXCEPTION/);
});

test("recognition_events table stores milestone and usage recognition evidence", () => {
  const migration = readFileSync(recognitionEventsMigrationPath, "utf8");

  // Additive-only: a new table, no existing tables modified.
  assert.match(migration, /CREATE TABLE public\.recognition_events/);
  assert.match(migration, /obligation_id uuid NOT NULL/);
  assert.match(migration, /period_month text NOT NULL/);
  assert.match(migration, /amount numeric\(19,4\) NOT NULL/);
  // FK to performance_obligations ensures events cannot reference deleted obligations.
  assert.match(
    migration,
    /FOREIGN KEY \(obligation_id\)\s+REFERENCES public\.performance_obligations\s+\(id\)/,
  );
  // RLS scoped to the tenant.
  assert.match(migration, /ALTER TABLE public\.recognition_events ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /CREATE POLICY org_isolation ON public\.recognition_events/);
  assert.match(migration, /CREATE POLICY org_isolation ON public\.recognition_events[\s\S]*?TO PUBLIC/);
  assert.doesNotMatch(migration, /TO openbooks_app/);
  // No data rewrite.
  assert.doesNotMatch(migration, /^\s*(?:UPDATE|DELETE\s+FROM)\s/im);
});

test("the SFTP login username is globally unique in storage, not by allocation luck", () => {
  const migration = readFileSync(sftpUsernameGlobalUniqueMigrationPath, "utf8");
  const schemaSource = readFileSync("schema/src/banking.ts", "utf8");

  // Rollout fails closed on legacy collisions and never picks a winning
  // duplicate: the daemon routes by username alone, so an arbitrary winner
  // would hand one tenant's filesystem to another tenant's login.
  assert.match(migration, /DO \$sftp_username_global_preflight\$/);
  assert.match(migration, /legacy sftp_servers rows duplicate the global login name/);
  assert.match(migration, /GROUP BY s\.username\s+HAVING count\(\*\) > 1/);
  assert.match(migration, /never picks a winning duplicate/);
  assert.doesNotMatch(migration, /^\s*(?:UPDATE|DELETE\s+FROM)\s/im);

  // Storage owns the invariant for every writer: the plain username lookup
  // index is replaced by the global unique one (uniqueness is not scoped to
  // is_active — a deactivated login keeps its name reserved).
  assert.match(migration, /DROP INDEX IF EXISTS public\.sftp_servers_username;/);
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS sftp_servers_username_global\s+ON public\.sftp_servers USING btree \(username\);/,
  );
  assert.match(migration, /COMMENT ON INDEX public\.sftp_servers_username_global IS/);

  // The drizzle mirror matches the published migration exactly.
  assert.match(
    schemaSource,
    /uniqueIndex\("sftp_servers_username_global"\)\.on\(t\.username\)/,
  );
  assert.doesNotMatch(schemaSource, /index\("sftp_servers_username"\)/);
});

test("API keys state their scopes explicitly: legacy empty sets freeze to the catalogue snapshot", () => {
  const migration = readFileSync(apiKeyExplicitScopesMigrationPath, "utf8");
  const schemaSource = readFileSync("schema/src/api.ts", "utf8");

  // Legacy '[]' rows meant "the owner's whole effective set", so the backfill
  // targets exactly those rows and stamps the explicit permission catalogue
  // snapshot — never a sentinel, wildcard, or inherit marker.
  assert.match(migration, /UPDATE public\.api_keys/);
  assert.match(migration, /WHERE scopes = '\[\]'::jsonb/);
  assert.match(migration, /DO \$api_key_explicit_scopes_backfill\$/);
  assert.doesNotMatch(migration, /'inherit_all'|'full_scope'|'\*'/);
  const snapshot = JSON.parse(
    migration.match(/SET scopes = '(\[[\s\S]*?\])'::jsonb/)?.[1] ?? "null",
  ) as string[];
  assert.deepEqual(snapshot, [...PERMISSION_CATALOGUE]);

  // Storage owns the invariant for every writer afterwards: the empty shape
  // is unrepresentable (non-empty JSON array CHECK, validated) and the '[]'
  // default is gone, so omitting scopes fails at write time.
  assert.match(migration, /ALTER COLUMN scopes DROP DEFAULT/);
  assert.match(
    migration,
    /ADD CONSTRAINT api_keys_scopes_non_empty\s+CHECK \(jsonb_typeof\(scopes\) = 'array' AND jsonb_array_length\(scopes\) > 0\)\s+NOT VALID/,
  );
  assert.match(migration, /VALIDATE CONSTRAINT api_keys_scopes_non_empty/);
  assert.match(migration, /COMMENT ON CONSTRAINT api_keys_scopes_non_empty ON public\.api_keys IS/);
  assert.match(migration, /COMMENT ON COLUMN public\.api_keys\.scopes IS/);

  // The drizzle mirror matches the published migration: no '[]' default and
  // the same non-empty CHECK.
  assert.doesNotMatch(schemaSource, /scopes:[^\n]*\.default\(\[\]\)/);
  assert.match(
    schemaSource,
    /check\(\s*"api_keys_scopes_non_empty",\s*sql`jsonb_typeof\(\$\{t\.scopes\}\) = 'array' AND jsonb_array_length\(\$\{t\.scopes\}\) > 0`,?\s*\)/,
  );
});
