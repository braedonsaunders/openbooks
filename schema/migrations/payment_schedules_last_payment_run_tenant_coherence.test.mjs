/**
 * Static proof for the payment_schedules last-run tenant-coherence repair.
 *
 * Baseline payment_schedules_last_payment_run_id_fkey is FOREIGN KEY
 * (last_payment_run_id) REFERENCES payment_runs(id). payment_runs is
 * org-scoped and is not a 0044 tenant anchor, so the catalog rewrite never
 * touches this edge. RLS WITH CHECK only compares the schedule's org_id to
 * the session GUC. This file is the machine-checkable done criterion: the
 * last published definition of that constraint must bind org_id, fail closed
 * on legacy mismatches, and never rewrite schedule history. Chosen
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
  /^\d{4}_payment_schedules_last_payment_run_tenant_coherence\.sql$/.test(file),
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

test("payment_schedules last-payment-run FK binds the child org_id", () => {
  const schedule = lastForeignKey("payment_schedules_last_payment_run_id_fkey");
  assert.ok(schedule, "payment_schedules_last_payment_run_id_fkey must be published");
  assert.equal(
    schedule.childColumns,
    "org_id,last_payment_run_id",
    `effective last-payment-run FK from ${schedule.file} must include org_id`,
  );
  assert.equal(schedule.parentTable, "payment_runs");
  assert.equal(schedule.parentColumns, "org_id,id");
});

test("payment-schedule last-run tenant-FK repair is fail-closed and does not rewrite history", () => {
  assert.ok(
    repairName,
    "a forward migration named NNNN_payment_schedules_last_payment_run_tenant_coherence.sql must be published",
  );
  assert.ok(
    publishedSql.includes(shippedBaseline),
    "0001 remains the shipped baseline; the repair must not rewrite it",
  );
  assert.ok(
    repairName > shippedBaseline,
    `${repairName} must apply after ${shippedBaseline}`,
  );
  assert.ok(
    publishedSql.includes("0210_payment_runs_source_schedule_tenant_coherence.sql"),
    "0210 remains the source-schedule repair; this slice must not invent a second one",
  );
  assert.ok(
    repairName > "0210_payment_runs_source_schedule_tenant_coherence.sql",
    `${repairName} must be the next free ordinal after 0210`,
  );
  assert.equal(repairName, "0212_payment_schedules_last_payment_run_tenant_coherence.sql");
  assert.equal(
    publishedSql.filter((file) => file.startsWith("0211_")).length,
    0,
    "0211 is reserved for Payroll; generated/ must contain no 0211_* from this goal",
  );

  const shipped = readFileSync(join(generatedDir, shippedBaseline), "utf8");
  assert.match(
    shipped,
    /ADD CONSTRAINT payment_schedules_last_payment_run_id_fkey FOREIGN KEY \(last_payment_run_id\) REFERENCES public\.payment_runs\(id\)/,
  );

  const migration = readFileSync(join(generatedDir, repairName), "utf8");
  assert.match(
    migration,
    /^-- OpenBooks forward migration \d{4}_payment_schedules_last_payment_run_tenant_coherence\./,
  );

  assert.match(migration, /DO \$payment_schedules_last_payment_run_tenant_preflight\$/);
  assert.match(
    migration,
    /legacy data violates tenant coherence: public\.payment_schedules\.last_payment_run_id/,
  );
  assert.match(migration, /this migration will not rewrite financial history/i);
  assert.doesNotMatch(migration, /^\s*(?:UPDATE|DELETE\s+FROM)\s/im);
  assert.doesNotMatch(migration, /0001_baseline/);
  assert.doesNotMatch(migration, /source_schedule_id/);

  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS payment_runs_org_id_id_unique\s+ON public\.payment_runs USING btree \(org_id, id\)/,
  );
  assert.match(
    migration,
    /DROP CONSTRAINT IF EXISTS payment_schedules_last_payment_run_id_fkey/,
  );
  assert.match(
    migration,
    /ADD CONSTRAINT payment_schedules_last_payment_run_id_fkey\s+FOREIGN KEY \(org_id, last_payment_run_id\)\s+REFERENCES public\.payment_runs \(org_id, id\)\s+DEFERRABLE NOT VALID/,
  );
  assert.match(
    migration,
    /VALIDATE CONSTRAINT payment_schedules_last_payment_run_id_fkey/,
  );
  assert.doesNotMatch(
    migration,
    /FOREIGN KEY \(last_payment_run_id\) REFERENCES public\.payment_runs\(id\)/,
  );

  assert.match(migration, /[^\n]\n$/);
  assert.doesNotMatch(migration, /\n\n$/);
});

test("Drizzle payment_runs/payment_schedules declare the composite tenant key, not a single-column last-run FK", () => {
  const schedules = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "payment-operations.ts"),
    "utf8",
  );
  const runs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "banking.ts"),
    "utf8",
  );
  assert.match(
    runs,
    /uniqueIndex\("payment_runs_org_id_id_unique"\)\.on\(t\.orgId, t\.id\)/,
  );
  assert.match(
    schedules,
    /name: "payment_schedules_last_payment_run_id_fkey"[\s\S]*columns: \[t\.orgId, t\.lastPaymentRunId\][\s\S]*foreignColumns: \[paymentRuns\.orgId, paymentRuns\.id\]/,
  );
  assert.doesNotMatch(
    schedules,
    /name: "payment_schedules_last_payment_run_id_fkey"[\s\S]*columns: \[t\.lastPaymentRunId\]/,
  );
});
