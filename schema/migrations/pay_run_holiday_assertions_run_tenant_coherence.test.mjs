/**
 * Static proof for the pay_run_holiday_assertions run tenant-coherence repair.
 *
 * 0181 installed pay_run_holiday_assertions_run_fkey as FOREIGN KEY
 * (pay_run_document_id) REFERENCES pay_runs(document_id). pay_runs is
 * org-scoped and is not a 0044 tenant anchor (its primary key is
 * document_id, not id), so the catalog rewrite never touches this edge.
 * RLS WITH CHECK only compares the child org_id to the session GUC. This
 * file is the machine-checkable done criterion: the last published
 * definition of that constraint must bind org_id, fail closed on legacy
 * mismatches, and never rewrite assertion history. Chosen independently
 * of the catalog inventory in canonical-baseline.test.ts.
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
const introduced = "0181_payroll_holiday_eligibility.sql";
const predecessor = "0216_flow_run_effects_tenant_coherence.sql";
const repairName = publishedSql.find((file) =>
  /^\d{4}_pay_run_holiday_assertions_run_tenant_coherence\.sql$/.test(file),
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

test("pay_run_holiday_assertions run FK binds the child org_id", () => {
  const run = lastForeignKey("pay_run_holiday_assertions_run_fkey");
  assert.ok(run, "pay_run_holiday_assertions_run_fkey must be published");
  assert.equal(
    run.childColumns,
    "org_id,pay_run_document_id",
    `effective run FK from ${run.file} must include org_id`,
  );
  assert.equal(run.parentTable, "pay_runs");
  assert.equal(run.parentColumns, "org_id,document_id");
});

test("holiday-assertion run tenant-FK repair is fail-closed and does not rewrite history", () => {
  assert.ok(
    repairName,
    "a forward migration named NNNN_pay_run_holiday_assertions_run_tenant_coherence.sql must be published",
  );
  assert.ok(
    publishedSql.includes(shippedBaseline),
    "0001 remains the shipped baseline; the repair must not rewrite it",
  );
  assert.ok(
    publishedSql.includes(introduced),
    "0181 remains the holiday-eligibility install; this slice must not rewrite it",
  );
  assert.ok(
    repairName > shippedBaseline,
    `${repairName} must apply after ${shippedBaseline}`,
  );
  assert.ok(
    publishedSql.includes(predecessor),
    "0216 remains the flow_run_effects repair; this slice must not invent a second one",
  );
  assert.ok(
    repairName > predecessor,
    `${repairName} must be the next free ordinal after 0216`,
  );
  assert.equal(repairName, "0217_pay_run_holiday_assertions_run_tenant_coherence.sql");
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
  ]) {
    assert.ok(publishedSql.includes(prior), `${prior} must remain published`);
  }

  const shipped = readFileSync(join(generatedDir, shippedBaseline), "utf8");
  assert.doesNotMatch(shipped, /pay_run_holiday_assertions_run_fkey/);

  const original = readFileSync(join(generatedDir, introduced), "utf8");
  assert.match(
    original,
    /ADD CONSTRAINT pay_run_holiday_assertions_run_fkey\s+FOREIGN KEY \(pay_run_document_id\) REFERENCES public\.pay_runs\(document_id\) ON DELETE CASCADE DEFERRABLE/,
  );

  const migration = readFileSync(join(generatedDir, repairName), "utf8");
  assert.match(
    migration,
    /^-- OpenBooks forward migration \d{4}_pay_run_holiday_assertions_run_tenant_coherence\./,
  );

  assert.match(migration, /DO \$pay_run_holiday_assertions_run_tenant_preflight\$/);
  assert.match(
    migration,
    /legacy data violates tenant coherence: public\.pay_run_holiday_assertions\.pay_run_document_id/,
  );
  assert.match(migration, /ERRCODE = '23514'/);
  assert.match(migration, /this migration will not rewrite financial history/i);
  assert.doesNotMatch(migration, /^\s*(?:UPDATE|DELETE\s+FROM)\s/im);
  assert.doesNotMatch(migration, /0001_baseline/);
  assert.doesNotMatch(migration, /0200_stock_count/);
  assert.doesNotMatch(
    migration,
    /0207_allocation|0208_pay_run|0209_pay_stubs|0210_payment_runs|0212_payment_schedules|0213_flow_runs|0214_flow_gates|0215_flow_locks|0216_flow_run_effects/,
  );

  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS pay_runs_org_id_document_id_unique\s+ON public\.pay_runs USING btree \(org_id, document_id\)/,
  );
  assert.match(
    migration,
    /DROP CONSTRAINT IF EXISTS pay_run_holiday_assertions_run_fkey/,
  );
  assert.match(
    migration,
    /ADD CONSTRAINT pay_run_holiday_assertions_run_fkey\s+FOREIGN KEY \(org_id, pay_run_document_id\)\s+REFERENCES public\.pay_runs \(org_id, document_id\)\s+ON DELETE CASCADE\s+DEFERRABLE NOT VALID/,
  );
  assert.match(
    migration,
    /VALIDATE CONSTRAINT pay_run_holiday_assertions_run_fkey/,
  );
  assert.doesNotMatch(
    migration,
    /FOREIGN KEY \(pay_run_document_id\) REFERENCES public\.pay_runs\(document_id\)/,
  );

  assert.match(migration, /[^\n]\n$/);
  assert.doesNotMatch(migration, /\n\n$/);
});

test("Drizzle pay_runs/pay_run_holiday_assertions declare the composite tenant key, not a single-column pay-run FK", () => {
  const drizzle = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "payroll.ts"),
    "utf8",
  );
  assert.match(
    drizzle,
    /uniqueIndex\("pay_runs_org_id_document_id_unique"\)\.on\(t\.orgId, t\.documentId\)/,
  );
  assert.match(
    drizzle,
    /name: "pay_run_holiday_assertions_run_fkey"[\s\S]*columns: \[t\.orgId, t\.payRunDocumentId\][\s\S]*foreignColumns: \[payRuns\.orgId, payRuns\.documentId\]/,
  );
  assert.doesNotMatch(
    drizzle,
    /name: "pay_run_holiday_assertions_run_fkey"[\s\S]*columns: \[t\.payRunDocumentId\]/,
  );
});
