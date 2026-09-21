/**
 * Static proof for the pay_run_adjustments component tenant-coherence repair.
 *
 * Baseline pay_run_adjustments_component_fkey is FOREIGN KEY (component_id)
 * REFERENCES pay_components(id). pay_components is org-scoped and is not a
 * 0044 tenant anchor, so the catalog rewrite never touches this edge. RLS
 * WITH CHECK only compares the child org_id to the session GUC. This file
 * is the machine-checkable done criterion: the last published definition
 * of that constraint must bind org_id, fail closed on legacy mismatches,
 * and never rewrite adjustment history. Chosen independently of the
 * catalog inventory in canonical-baseline.test.ts.
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
const introducedHoliday = "0181_payroll_holiday_eligibility.sql";
const predecessor = "0217_pay_run_holiday_assertions_run_tenant_coherence.sql";
const repairName = publishedSql.find((file) =>
  /^\d{4}_pay_run_adjustments_component_tenant_coherence\.sql$/.test(file),
);

function lastForeignKey(constraintName) {
  const pattern = new RegExp(
    `ADD CONSTRAINT ${constraintName}\\s+FOREIGN KEY \\(([^)]+)\\)\\s+REFERENCES public\\.([a-z_]+)\\s*\\(([^)]+)\\)`,
    "gs",
  );
  let last = null;
  for (const file of publishedSql) {
    const source = readFileSync(join(generatedDir, file), "utf8");
    for (const match of source.matchAll(pattern)) {
      last = {
        file,
        childColumns: match[1].replaceAll(/\s+/g, ""),
        parentTable: match[2],
        parentColumns: match[3].replaceAll(/\s+/g, ""),
      };
    }
  }
  return last;
}

test("pay_run_adjustments component FK binds the child org_id", () => {
  const component = lastForeignKey("pay_run_adjustments_component_fkey");
  assert.ok(component, "pay_run_adjustments_component_fkey must be published");
  assert.equal(
    component.childColumns,
    "org_id,component_id",
    `effective component FK from ${component.file} must include org_id`,
  );
  assert.equal(component.parentTable, "pay_components");
  assert.equal(component.parentColumns, "org_id,id");
});

test("pay-run adjustment component tenant-FK repair is fail-closed and does not rewrite history", () => {
  assert.ok(
    repairName,
    "a forward migration named NNNN_pay_run_adjustments_component_tenant_coherence.sql must be published",
  );
  assert.ok(
    publishedSql.includes(shippedBaseline),
    "0001 remains the shipped baseline; the repair must not rewrite it",
  );
  assert.ok(
    publishedSql.includes(introducedHoliday),
    "0181 remains the holiday-eligibility install; this slice must not rewrite it",
  );
  assert.ok(
    repairName > shippedBaseline,
    `${repairName} must apply after ${shippedBaseline}`,
  );
  assert.ok(
    publishedSql.includes(predecessor),
    "0217 remains the holiday-assertion run repair; this slice must not invent a second one",
  );
  assert.ok(
    repairName > predecessor,
    `${repairName} must be the next free ordinal after 0217`,
  );
  assert.equal(repairName, "0218_pay_run_adjustments_component_tenant_coherence.sql");
  const unexpected211 = publishedSql.filter(
    (file) => file.startsWith("0211_") && file !== "0211_pay_run_bank_file_zengin_cnab240.sql",
  );
  assert.deepEqual(
    unexpected211,
    [],
    "0211 is reserved for Payroll (0211_pay_run_bank_file_zengin_cnab240.sql); this goal must not publish a 0211_* of its own",
  );
  assert.ok(
    publishedSql.includes("0200_stock_count_subsidiary.sql"),
    "0200 remains stock-count subsidiary; this repair must not reuse that ordinal",
  );
  for (const prior of [
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
  ]) {
    assert.ok(publishedSql.includes(prior), `${prior} must remain published`);
  }

  const shipped = readFileSync(join(generatedDir, shippedBaseline), "utf8");
  assert.match(
    shipped,
    /ADD CONSTRAINT pay_run_adjustments_component_fkey FOREIGN KEY \(component_id\) REFERENCES public\.pay_components\(id\)/,
  );

  const holiday = readFileSync(join(generatedDir, introducedHoliday), "utf8");
  assert.match(
    holiday,
    /ADD CONSTRAINT pay_run_holiday_assertions_run_fkey\s+FOREIGN KEY \(pay_run_document_id\) REFERENCES public\.pay_runs\(document_id\) ON DELETE CASCADE DEFERRABLE/,
  );

  const migration = readFileSync(join(generatedDir, repairName), "utf8");
  assert.match(
    migration,
    /^-- OpenBooks forward migration \d{4}_pay_run_adjustments_component_tenant_coherence\./,
  );

  assert.match(migration, /DO \$pay_run_adjustments_component_tenant_preflight\$/);
  assert.match(
    migration,
    /legacy data violates tenant coherence: public\.pay_run_adjustments\.component_id/,
  );
  assert.match(migration, /ERRCODE = '23514'/);
  assert.match(migration, /this migration will not rewrite financial history/i);
  assert.doesNotMatch(migration, /^\s*(?:UPDATE|DELETE\s+FROM)\s/im);
  assert.doesNotMatch(migration, /0001_baseline/);
  assert.doesNotMatch(migration, /0200_stock_count/);
  assert.doesNotMatch(
    migration,
    /0181_payroll|0207_allocation|0208_pay_run|0209_pay_stubs|0210_payment_runs|0212_payment_schedules|0213_flow_runs|0214_flow_gates|0215_flow_locks|0216_flow_run_effects|0217_pay_run_holiday/,
  );

  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS pay_components_org_id_id_unique\s+ON public\.pay_components USING btree \(org_id, id\)/,
  );
  assert.match(
    migration,
    /DROP CONSTRAINT IF EXISTS pay_run_adjustments_component_fkey/,
  );
  assert.match(
    migration,
    /ADD CONSTRAINT pay_run_adjustments_component_fkey\s+FOREIGN KEY \(org_id, component_id\)\s+REFERENCES public\.pay_components \(org_id, id\)\s+ON DELETE CASCADE\s+DEFERRABLE NOT VALID/,
  );
  assert.match(
    migration,
    /VALIDATE CONSTRAINT pay_run_adjustments_component_fkey/,
  );
  assert.doesNotMatch(
    migration,
    /FOREIGN KEY \(component_id\) REFERENCES public\.pay_components\(id\)/,
  );

  assert.match(migration, /[^\n]\n$/);
  assert.doesNotMatch(migration, /\n\n$/);
});

test("Drizzle pay_components/pay_run_adjustments declare the composite tenant key, not a single-column component FK", () => {
  const drizzle = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "payroll.ts"),
    "utf8",
  );
  assert.match(
    drizzle,
    /uniqueIndex\("pay_components_org_id_id_unique"\)\.on\(t\.orgId, t\.id\)/,
  );
  assert.match(
    drizzle,
    /name: "pay_run_adjustments_component_fkey"[\s\S]*columns: \[t\.orgId, t\.componentId\][\s\S]*foreignColumns: \[payComponents\.orgId, payComponents\.id\]/,
  );
  assert.doesNotMatch(
    drizzle,
    /name: "pay_run_adjustments_component_fkey"[\s\S]*columns: \[t\.componentId\]/,
  );
});
