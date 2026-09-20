/**
 * Static proof for the payment_runs source-schedule tenant-coherence repair.
 *
 * Baseline payment_runs_source_schedule_id_fkey is FOREIGN KEY
 * (source_schedule_id) REFERENCES payment_schedules(id). payment_schedules is
 * org-scoped and is not a 0044 tenant anchor, so the catalog rewrite never
 * touches this edge. RLS WITH CHECK only compares the run's org_id to the
 * session GUC. This file is the machine-checkable done criterion: the last
 * published definition of that constraint must bind org_id, fail closed on
 * legacy mismatches, and never rewrite payment-run history. Chosen
 * independently of the catalog inventory in canonical-baseline.test.ts.
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
const repairName = publishedSql.find((file) =>
  /^\d{4}_payment_runs_source_schedule_tenant_coherence\.sql$/.test(file),
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

test("payment_runs source-schedule FK binds the child org_id", () => {
  const run = lastForeignKey("payment_runs_source_schedule_id_fkey");
  assert.ok(run, "payment_runs_source_schedule_id_fkey must be published");
  assert.equal(
    run.childColumns,
    "org_id,source_schedule_id",
    `effective source-schedule FK from ${run.file} must include org_id`,
  );
  assert.equal(run.parentTable, "payment_schedules");
  assert.equal(run.parentColumns, "org_id,id");
});

test("payment-run source-schedule tenant-FK repair is fail-closed and does not rewrite history", () => {
  assert.ok(
    repairName,
    "a forward migration named NNNN_payment_runs_source_schedule_tenant_coherence.sql must be published",
  );
  assert.ok(
    publishedSql.includes(shippedBaseline),
    "0001 remains the shipped baseline; the repair must not rewrite it",
  );
  assert.ok(
    repairName > shippedBaseline,
    `${repairName} must apply after ${shippedBaseline}`,
  );

  const shipped = readFileSync(join(generatedDir, shippedBaseline), "utf8");
  assert.match(
    shipped,
    /ADD CONSTRAINT payment_runs_source_schedule_id_fkey FOREIGN KEY \(source_schedule_id\) REFERENCES public\.payment_schedules\(id\)/,
  );

  const migration = readFileSync(join(generatedDir, repairName), "utf8");
  assert.match(
    migration,
    /^-- OpenBooks forward migration \d{4}_payment_runs_source_schedule_tenant_coherence\./,
  );

  assert.match(migration, /DO \$payment_runs_source_schedule_tenant_preflight\$/);
  assert.match(
    migration,
    /legacy data violates tenant coherence: public\.payment_runs\.source_schedule_id/,
  );
  assert.match(migration, /this migration will not rewrite financial history/i);
  assert.doesNotMatch(migration, /^\s*(?:UPDATE|DELETE\s+FROM)\s/im);
  assert.doesNotMatch(migration, /0001_baseline/);

  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS payment_schedules_org_id_id_unique\s+ON public\.payment_schedules USING btree \(org_id, id\)/,
  );
  assert.match(
    migration,
    /DROP CONSTRAINT IF EXISTS payment_runs_source_schedule_id_fkey/,
  );
  assert.match(
    migration,
    /ADD CONSTRAINT payment_runs_source_schedule_id_fkey\s+FOREIGN KEY \(org_id, source_schedule_id\)\s+REFERENCES public\.payment_schedules \(org_id, id\)\s+DEFERRABLE NOT VALID/,
  );
  assert.match(
    migration,
    /VALIDATE CONSTRAINT payment_runs_source_schedule_id_fkey/,
  );
  assert.doesNotMatch(
    migration,
    /FOREIGN KEY \(source_schedule_id\) REFERENCES public\.payment_schedules\(id\)/,
  );

  assert.match(migration, /[^\n]\n$/);
  assert.doesNotMatch(migration, /\n\n$/);
});

test("Drizzle payment_schedules/payment_runs declare the composite tenant key, not a single-column schedule FK", () => {
  const schedules = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "payment-operations.ts"),
    "utf8",
  );
  const runs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "banking.ts"),
    "utf8",
  );
  assert.match(
    schedules,
    /uniqueIndex\("payment_schedules_org_id_id_unique"\)\.on\(t\.orgId, t\.id\)/,
  );
  assert.match(
    runs,
    /name: "payment_runs_source_schedule_id_fkey"[\s\S]*columns: \[t\.orgId, t\.sourceScheduleId\][\s\S]*foreignColumns: \[paymentSchedules\.orgId, paymentSchedules\.id\]/,
  );
  assert.doesNotMatch(
    runs,
    /name: "payment_runs_source_schedule_id_fkey"[\s\S]*columns: \[t\.sourceScheduleId\]/,
  );
});
