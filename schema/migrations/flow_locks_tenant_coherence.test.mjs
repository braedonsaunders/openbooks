/**
 * Static proof for the flow_locks tenant-coherence repair.
 *
 * Baseline flow_locks_flow_id_fkey is FOREIGN KEY (flow_id) REFERENCES
 * flows(id). flows is org-scoped and is not a 0044 tenant anchor, so the
 * catalog rewrite never touches this edge. RLS WITH CHECK only compares the
 * child org_id to the session GUC. This file is the machine-checkable done
 * criterion: the last published definition of that constraint must bind
 * org_id, fail closed on legacy mismatches, and never rewrite lock history.
 * Chosen independently of the catalog inventory in canonical-baseline.test.ts.
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
const predecessor = "0214_flow_gates_tenant_coherence.sql";
const repairName = publishedSql.find((file) =>
  /^\d{4}_flow_locks_tenant_coherence\.sql$/.test(file),
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

test("flow_locks flow FK binds the child org_id", () => {
  const lock = lastForeignKey("flow_locks_flow_id_fkey");
  assert.ok(lock, "flow_locks_flow_id_fkey must be published");
  assert.equal(
    lock.childColumns,
    "org_id,flow_id",
    `effective flow FK from ${lock.file} must include org_id`,
  );
  assert.equal(lock.parentTable, "flows");
  assert.equal(lock.parentColumns, "org_id,id");
});

test("flow_locks tenant-FK repair is fail-closed and does not rewrite history", () => {
  assert.ok(
    repairName,
    "a forward migration named NNNN_flow_locks_tenant_coherence.sql must be published",
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
    publishedSql.includes(predecessor),
    "0214 remains the flow_gates repair; this slice must not invent a second one",
  );
  assert.ok(
    repairName > predecessor,
    `${repairName} must be the next free ordinal after 0214`,
  );
  assert.equal(repairName, "0215_flow_locks_tenant_coherence.sql");
  assert.equal(
    publishedSql.filter((file) => file.startsWith("0211_")).length,
    0,
    "0211 is reserved for Payroll; generated/ must contain no 0211_* from this goal",
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
  ]) {
    assert.ok(publishedSql.includes(prior), `${prior} must remain published`);
  }

  const shipped = readFileSync(join(generatedDir, shippedBaseline), "utf8");
  assert.match(
    shipped,
    /ADD CONSTRAINT flow_locks_flow_id_fkey FOREIGN KEY \(flow_id\) REFERENCES public\.flows\(id\) ON DELETE CASCADE/,
  );

  const migration = readFileSync(join(generatedDir, repairName), "utf8");
  assert.match(
    migration,
    /^-- OpenBooks forward migration \d{4}_flow_locks_tenant_coherence\./,
  );

  assert.match(migration, /DO \$flow_locks_tenant_preflight\$/);
  assert.match(
    migration,
    /legacy data violates tenant coherence: public\.flow_locks\.flow_id/,
  );
  assert.match(migration, /ERRCODE = '23514'/);
  assert.match(migration, /this migration will not rewrite financial history/i);
  assert.doesNotMatch(migration, /^\s*(?:UPDATE|DELETE\s+FROM)\s/im);
  assert.doesNotMatch(migration, /0001_baseline/);
  assert.doesNotMatch(migration, /0200_stock_count/);
  assert.doesNotMatch(
    migration,
    /0207_allocation|0208_pay_run|0209_pay_stubs|0210_payment_runs|0212_payment_schedules|0213_flow_runs|0214_flow_gates/,
  );

  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS flows_org_id_id_unique\s+ON public\.flows USING btree \(org_id, id\)/,
  );
  assert.match(
    migration,
    /DROP CONSTRAINT IF EXISTS flow_locks_flow_id_fkey/,
  );
  assert.match(
    migration,
    /ADD CONSTRAINT flow_locks_flow_id_fkey\s+FOREIGN KEY \(org_id, flow_id\)\s+REFERENCES public\.flows \(org_id, id\)\s+ON DELETE CASCADE\s+DEFERRABLE NOT VALID/,
  );
  assert.match(
    migration,
    /VALIDATE CONSTRAINT flow_locks_flow_id_fkey/,
  );
  assert.doesNotMatch(
    migration,
    /FOREIGN KEY \(flow_id\) REFERENCES public\.flows\(id\)/,
  );

  assert.match(migration, /[^\n]\n$/);
  assert.doesNotMatch(migration, /\n\n$/);
});

test("Drizzle flow_locks declare the composite tenant key, not a single-column flow FK", () => {
  const drizzle = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "flows.ts"),
    "utf8",
  );
  assert.match(
    drizzle,
    /uniqueIndex\("flows_org_id_id_unique"\)\.on\(t\.orgId, t\.id\)/,
  );
  assert.match(
    drizzle,
    /name: "flow_locks_flow_id_fkey"[\s\S]*columns: \[t\.orgId, t\.flowId\][\s\S]*foreignColumns: \[flows\.orgId, flows\.id\]/,
  );
  assert.doesNotMatch(
    drizzle,
    /name: "flow_locks_flow_id_fkey"[\s\S]*columns: \[t\.flowId\]/,
  );
});
