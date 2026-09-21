/**
 * Static proof for the list_views one-live-personal-isDefault repair.
 *
 * Baseline unique extras on list_views are only
 * list_views_org_scope_type_name and list_views_org_type. Storage can
 * therefore keep two live personal defaults for the same
 * (org_id, owner_id, record_type). This file is the machine-checkable
 * done criterion: 0219 must publish a unique partial index, fail closed
 * on dirty duplicates, pair the Drizzle extras, and never rewrite
 * 0001 or 0207-0218. Chosen independently of the catalog inventory in
 * canonical-baseline.test.ts.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const generatedDir = join(dirname(fileURLToPath(import.meta.url)), "generated");
const publishedSql = readdirSync(generatedDir)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const shippedBaseline = "0001_baseline.sql";
const predecessor = "0218_pay_run_adjustments_component_tenant_coherence.sql";
const repairName = publishedSql.find((file) =>
  /^\d{4}_list_views_one_live_personal_default\.sql$/.test(file),
);
const priorRepairs = [
  "0207_allocation_kernel_tenant_fks.sql",
  "0208_pay_run_adjustments_run_tenant_coherence.sql",
  "0209_pay_stubs_pay_run_tenant_coherence.sql",
  "0210_payment_runs_source_schedule_tenant_coherence.sql",
  "0212_payment_schedules_last_payment_run_tenant_coherence.sql",
  "0213_flow_runs_flow_tenant_coherence.sql",
  "0214_flow_gates_tenant_coherence.sql",
  "0215_flow_locks_tenant_coherence.sql",
  "0216_flow_run_effects_tenant_coherence.sql",
  "0217_pay_run_holiday_assertions_run_tenant_coherence.sql",
  "0218_pay_run_adjustments_component_tenant_coherence.sql",
];

test("0219 unique partial index enforces one live personal list-view isDefault", () => {
  assert.ok(
    repairName,
    "a forward migration named NNNN_list_views_one_live_personal_default.sql must be published",
  );
  assert.ok(
    publishedSql.includes(shippedBaseline),
    "0001 remains the shipped baseline; the repair must not rewrite it",
  );
  assert.ok(
    publishedSql.includes(predecessor),
    "0218 remains the pay-run adjustment component repair; this slice must not invent a second one",
  );
  assert.ok(
    repairName > shippedBaseline,
    `${repairName} must apply after ${shippedBaseline}`,
  );
  assert.ok(
    repairName > predecessor,
    `${repairName} must be the next free ordinal after 0218`,
  );
  assert.equal(repairName, "0219_list_views_one_live_personal_default.sql");
  const unexpected211 = publishedSql.filter(
    (file) => file.startsWith("0211_") && file !== "0211_pay_run_bank_file_zengin_cnab240.sql",
  );
  assert.deepEqual(
    unexpected211,
    [],
    "0211 is reserved for Payroll (0211_pay_run_bank_file_zengin_cnab240.sql); this goal must not publish a 0211_* of its own",
  );
  assert.equal(
    publishedSql.filter((file) => file.startsWith("0220_")).length,
    0,
    "0220 is unused; generated/ must contain no 0220_* from this slice",
  );
  for (const prior of priorRepairs) {
    assert.ok(publishedSql.includes(prior), `${prior} must remain published`);
  }

  const shipped = readFileSync(join(generatedDir, shippedBaseline), "utf8");
  assert.match(
    shipped,
    /CREATE UNIQUE INDEX list_views_org_scope_type_name ON public\.list_views USING btree \(org_id, scope, record_type, name\)/,
  );
  assert.doesNotMatch(shipped, /list_views_one_live_personal_default/);

  const predecessorSql = readFileSync(join(generatedDir, predecessor), "utf8");
  assert.match(
    predecessorSql,
    /^-- OpenBooks forward migration 0218_pay_run_adjustments_component_tenant_coherence\./,
  );
  assert.doesNotMatch(predecessorSql, /list_views_one_live_personal_default/);

  const migration = readFileSync(join(generatedDir, repairName), "utf8");
  assert.match(
    migration,
    /^-- OpenBooks forward migration \d{4}_list_views_one_live_personal_default\./,
  );
  assert.match(migration, /DO \$list_views_one_live_personal_default_preflight\$/);
  assert.match(
    migration,
    /legacy data violates unique live personal default: public\.list_views/,
  );
  assert.match(migration, /ERRCODE = '23514'/);
  assert.match(migration, /this migration will not rewrite list_views rows/i);
  assert.doesNotMatch(migration, /^\s*(?:UPDATE|DELETE\s+FROM)\s/im);
  assert.doesNotMatch(migration, /0001_baseline/);
  assert.doesNotMatch(
    migration,
    /0207_allocation|0208_pay_run|0209_pay_stubs|0210_payment_runs|0212_payment_schedules|0213_flow_runs|0214_flow_gates|0215_flow_locks|0216_flow_run_effects|0217_pay_run_holiday|0218_pay_run/,
  );

  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS list_views_one_live_personal_default\s+ON public\.list_views USING btree \(org_id, owner_id, record_type\)\s+WHERE \(\(scope = 'user'\) AND is_default AND is_active\)/,
  );

  assert.match(migration, /[^\n]\n$/);
  assert.doesNotMatch(migration, /\n\n$/);
});

test("Drizzle list_views declares the unique partial live personal default", () => {
  const drizzle = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "customization.ts"),
    "utf8",
  );
  assert.match(
    drizzle,
    /uniqueIndex\("list_views_one_live_personal_default"\)\.on\(t\.orgId, t\.ownerId, t\.recordType\)\.where\(sql`\$\{t\.scope\} = 'user' AND \$\{t\.isDefault\} AND \$\{t\.isActive\}`\)/,
  );
});
