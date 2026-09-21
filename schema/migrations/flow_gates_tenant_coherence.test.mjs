/**
 * Static proof for the flow_gates tenant-coherence repair.
 *
 * Baseline flow_gates_flow_id_fkey is FOREIGN KEY (flow_id) REFERENCES
 * flows(id) and flow_gates_run_id_fkey is FOREIGN KEY (run_id) REFERENCES
 * flow_runs(id). Both parents are org-scoped and are not 0044 tenant
 * anchors, so the catalog rewrite never touches these edges. RLS WITH
 * CHECK only compares the child org_id to the session GUC. This file is
 * the machine-checkable done criterion: the last published definition of
 * each constraint must bind org_id, fail closed on legacy mismatches, and
 * never rewrite gate history. Chosen independently of the catalog
 * inventory in canonical-baseline.test.ts.
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
const predecessor = "0213_flow_runs_flow_tenant_coherence.sql";
const repairName = publishedSql.find((file) =>
  /^\d{4}_flow_gates_tenant_coherence\.sql$/.test(file),
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

test("flow_gates flow FK binds the child org_id", () => {
  const gate = lastForeignKey("flow_gates_flow_id_fkey");
  assert.ok(gate, "flow_gates_flow_id_fkey must be published");
  assert.equal(
    gate.childColumns,
    "org_id,flow_id",
    `effective flow FK from ${gate.file} must include org_id`,
  );
  assert.equal(gate.parentTable, "flows");
  assert.equal(gate.parentColumns, "org_id,id");
});

test("flow_gates run FK binds the child org_id", () => {
  const gate = lastForeignKey("flow_gates_run_id_fkey");
  assert.ok(gate, "flow_gates_run_id_fkey must be published");
  assert.equal(
    gate.childColumns,
    "org_id,run_id",
    `effective run FK from ${gate.file} must include org_id`,
  );
  assert.equal(gate.parentTable, "flow_runs");
  assert.equal(gate.parentColumns, "org_id,id");
});

test("flow_gates tenant-FK repair is fail-closed and does not rewrite history", () => {
  assert.ok(
    repairName,
    "a forward migration named NNNN_flow_gates_tenant_coherence.sql must be published",
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
    "0213 remains the flow_runs repair; this slice must not invent a second one",
  );
  assert.ok(
    repairName > predecessor,
    `${repairName} must be the next free ordinal after 0213`,
  );
  assert.equal(repairName, "0214_flow_gates_tenant_coherence.sql");
  assert.equal(
    publishedSql.filter((file) => file.startsWith("0211_")).length,
    0,
    "0211 is reserved for Payroll; generated/ must contain no 0211_* from this goal",
  );
  assert.ok(
    publishedSql.includes("0200_stock_count_subsidiary.sql"),
    "0200 remains stock-count subsidiary; this repair must not reuse that ordinal",
  );

  const shipped = readFileSync(join(generatedDir, shippedBaseline), "utf8");
  assert.match(
    shipped,
    /ADD CONSTRAINT flow_gates_flow_id_fkey FOREIGN KEY \(flow_id\) REFERENCES public\.flows\(id\) ON DELETE CASCADE/,
  );
  assert.match(
    shipped,
    /ADD CONSTRAINT flow_gates_run_id_fkey FOREIGN KEY \(run_id\) REFERENCES public\.flow_runs\(id\) ON DELETE CASCADE/,
  );

  const migration = readFileSync(join(generatedDir, repairName), "utf8");
  assert.match(
    migration,
    /^-- OpenBooks forward migration \d{4}_flow_gates_tenant_coherence\./,
  );

  assert.match(migration, /DO \$flow_gates_tenant_preflight\$/);
  assert.match(
    migration,
    /legacy data violates tenant coherence: public\.flow_gates\.flow_id/,
  );
  assert.match(
    migration,
    /legacy data violates tenant coherence: public\.flow_gates\.run_id/,
  );
  assert.match(migration, /this migration will not rewrite financial history/i);
  assert.doesNotMatch(migration, /^\s*(?:UPDATE|DELETE\s+FROM)\s/im);
  assert.doesNotMatch(migration, /0001_baseline/);
  assert.doesNotMatch(migration, /0200_stock_count/);
  assert.doesNotMatch(
    migration,
    /0207_allocation|0208_pay_run|0209_pay_stubs|0210_payment_runs|0212_payment_schedules|0213_flow_runs/,
  );

  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS flows_org_id_id_unique\s+ON public\.flows USING btree \(org_id, id\)/,
  );
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS flow_runs_org_id_id_unique\s+ON public\.flow_runs USING btree \(org_id, id\)/,
  );
  assert.match(
    migration,
    /DROP CONSTRAINT IF EXISTS flow_gates_flow_id_fkey/,
  );
  assert.match(
    migration,
    /DROP CONSTRAINT IF EXISTS flow_gates_run_id_fkey/,
  );
  assert.match(
    migration,
    /ADD CONSTRAINT flow_gates_flow_id_fkey\s+FOREIGN KEY \(org_id, flow_id\)\s+REFERENCES public\.flows \(org_id, id\)\s+ON DELETE CASCADE\s+DEFERRABLE NOT VALID/,
  );
  assert.match(
    migration,
    /ADD CONSTRAINT flow_gates_run_id_fkey\s+FOREIGN KEY \(org_id, run_id\)\s+REFERENCES public\.flow_runs \(org_id, id\)\s+ON DELETE CASCADE\s+DEFERRABLE NOT VALID/,
  );
  assert.match(migration, /VALIDATE CONSTRAINT flow_gates_flow_id_fkey/);
  assert.match(migration, /VALIDATE CONSTRAINT flow_gates_run_id_fkey/);
  assert.doesNotMatch(
    migration,
    /FOREIGN KEY \(flow_id\) REFERENCES public\.flows\(id\)/,
  );
  assert.doesNotMatch(
    migration,
    /FOREIGN KEY \(run_id\) REFERENCES public\.flow_runs\(id\)/,
  );

  assert.match(migration, /[^\n]\n$/);
  assert.doesNotMatch(migration, /\n\n$/);
});

test("Drizzle flow_gates declare the composite tenant keys, not single-column FKs", () => {
  const drizzle = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "flows.ts"),
    "utf8",
  );
  assert.match(
    drizzle,
    /uniqueIndex\("flow_runs_org_id_id_unique"\)\.on\(t\.orgId, t\.id\)/,
  );
  assert.match(
    drizzle,
    /name: "flow_gates_flow_id_fkey"[\s\S]*columns: \[t\.orgId, t\.flowId\][\s\S]*foreignColumns: \[flows\.orgId, flows\.id\]/,
  );
  assert.match(
    drizzle,
    /name: "flow_gates_run_id_fkey"[\s\S]*columns: \[t\.orgId, t\.runId\][\s\S]*foreignColumns: \[flowRuns\.orgId, flowRuns\.id\]/,
  );
  assert.doesNotMatch(
    drizzle,
    /name: "flow_gates_flow_id_fkey"[\s\S]*columns: \[t\.flowId\]/,
  );
  assert.doesNotMatch(
    drizzle,
    /name: "flow_gates_run_id_fkey"[\s\S]*columns: \[t\.runId\]/,
  );
});
