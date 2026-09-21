/**
 * Static proof for the pay_stubs pay-run tenant-coherence repair.
 *
 * Baseline pay_stubs_pay_run_document_id_fkey is FOREIGN KEY
 * (pay_run_document_id) REFERENCES pay_runs(document_id). pay_runs is
 * org-scoped and is not a 0044 tenant anchor (its primary key is
 * document_id, not id), so the catalog rewrite never touches this edge.
 * RLS WITH CHECK only compares the child org_id to the session GUC. This
 * file is the machine-checkable done criterion: the last published
 * definition of that constraint must bind org_id, fail closed on legacy
 * mismatches, and never rewrite stub history. Chosen independently of the
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
const repairName = publishedSql.find((file) =>
  /^\d{4}_pay_stubs_pay_run_tenant_coherence\.sql$/.test(file),
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

test("pay_stubs pay-run FK binds the child org_id", () => {
  const run = lastForeignKey("pay_stubs_pay_run_document_id_fkey");
  assert.ok(run, "pay_stubs_pay_run_document_id_fkey must be published");
  assert.equal(
    run.childColumns,
    "org_id,pay_run_document_id",
    `effective pay-run FK from ${run.file} must include org_id`,
  );
  assert.equal(run.parentTable, "pay_runs");
  assert.equal(run.parentColumns, "org_id,document_id");
});

test("pay stub pay-run tenant-FK repair is fail-closed and does not rewrite history", () => {
  assert.ok(
    repairName,
    "a forward migration named NNNN_pay_stubs_pay_run_tenant_coherence.sql must be published",
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
    /ADD CONSTRAINT pay_stubs_pay_run_document_id_fkey FOREIGN KEY \(pay_run_document_id\) REFERENCES public\.pay_runs\(document_id\)/,
  );

  const migration = readFileSync(join(generatedDir, repairName), "utf8");
  assert.match(
    migration,
    /^-- OpenBooks forward migration \d{4}_pay_stubs_pay_run_tenant_coherence\./,
  );

  assert.match(migration, /DO \$pay_stubs_pay_run_tenant_preflight\$/);
  assert.match(
    migration,
    /legacy data violates tenant coherence: public\.pay_stubs\.pay_run_document_id/,
  );
  assert.match(migration, /this migration will not rewrite financial history/i);
  assert.doesNotMatch(migration, /^\s*(?:UPDATE|DELETE\s+FROM)\s/im);
  assert.doesNotMatch(migration, /0001_baseline/);

  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS pay_runs_org_id_document_id_unique\s+ON public\.pay_runs USING btree \(org_id, document_id\)/,
  );
  assert.match(
    migration,
    /DROP CONSTRAINT IF EXISTS pay_stubs_pay_run_document_id_fkey/,
  );
  assert.match(
    migration,
    /ADD CONSTRAINT pay_stubs_pay_run_document_id_fkey\s+FOREIGN KEY \(org_id, pay_run_document_id\)\s+REFERENCES public\.pay_runs \(org_id, document_id\)\s+ON DELETE CASCADE\s+DEFERRABLE NOT VALID/,
  );
  assert.match(
    migration,
    /VALIDATE CONSTRAINT pay_stubs_pay_run_document_id_fkey/,
  );
  assert.doesNotMatch(
    migration,
    /FOREIGN KEY \(pay_run_document_id\) REFERENCES public\.pay_runs\(document_id\)/,
  );

  assert.match(migration, /[^\n]\n$/);
  assert.doesNotMatch(migration, /\n\n$/);
});

test("Drizzle pay_runs/pay_stubs declare the composite tenant key, not a single-column pay-run FK", () => {
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
    /name: "pay_stubs_pay_run_document_id_fkey"[\s\S]*columns: \[t\.orgId, t\.payRunDocumentId\][\s\S]*foreignColumns: \[payRuns\.orgId, payRuns\.documentId\]/,
  );
  assert.doesNotMatch(
    drizzle,
    /name: "pay_stubs_pay_run_document_id_fkey"[\s\S]*columns: \[t\.payRunDocumentId\]/,
  );
});
