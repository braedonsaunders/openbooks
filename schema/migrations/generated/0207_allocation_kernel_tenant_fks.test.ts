import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

/**
 * Independent done criterion for the allocation-kernel tenant-FK repair.
 *
 * 0160's comment promises composite (org_id, id) FKs "where the parent
 * exposes (org_id, id)", then installs three single-column edges: class,
 * journal_line, and book. This file pins the repair without trusting
 * 0160's comment or the house canonical-baseline registry: 0160 stays
 * shipped as-is, 0207 replaces those three names with composite keys,
 * and the drizzle mirror matches.
 */
const kernelPath = new URL("./0160_allocation_kernel.sql", import.meta.url);
const repairPath = new URL("./0207_allocation_kernel_tenant_fks.sql", import.meta.url);
const schemaPath = new URL("../../src/allocations.ts", import.meta.url);

const repaired = [
  {
    name: "allocation_rule_targets_class_id_fkey",
    table: "allocation_rule_targets",
    columns: "org_id, class_id",
    parent: "classes",
    drizzleColumns: "t.orgId, t.classId",
    drizzleParent: "classes.orgId, classes.id",
  },
  {
    name: "allocation_lineage_journal_line_id_fkey",
    table: "allocation_lineage",
    columns: "org_id, journal_line_id",
    parent: "journal_lines",
    drizzleColumns: "t.orgId, t.journalLineId",
    drizzleParent: "journalLines.orgId, journalLines.id",
  },
  {
    name: "allocation_runs_book_id_fkey",
    table: "allocation_runs",
    columns: "org_id, book_id",
    parent: "accounting_books",
    drizzleColumns: "t.orgId, t.bookId",
    drizzleParent: "accountingBooks.orgId, accountingBooks.id",
  },
  {
    name: "allocation_lineage_source_journal_line_id_fkey",
    table: "allocation_lineage",
    columns: "org_id, source_journal_line_id",
    parent: "journal_lines",
    drizzleColumns: "t.orgId, t.sourceJournalLineId",
    drizzleParent: "journalLines.orgId, journalLines.id",
  },
] as const;

test("0160 stays shipped with the three single-column allocation kernel FKs", () => {
  const kernel = readFileSync(kernelPath, "utf8");
  assert.match(
    kernel,
    /ADD CONSTRAINT allocation_rule_targets_class_id_fkey\s+FOREIGN KEY \(class_id\) REFERENCES public\.classes\(id\)/,
  );
  assert.match(
    kernel,
    /ADD CONSTRAINT allocation_lineage_journal_line_id_fkey\s+FOREIGN KEY \(journal_line_id\) REFERENCES public\.journal_lines\(id\)/,
  );
  assert.match(
    kernel,
    /ADD CONSTRAINT allocation_runs_book_id_fkey\s+FOREIGN KEY \(book_id\) REFERENCES public\.accounting_books\(id\)/,
  );
  assert.doesNotMatch(kernel, /0001_baseline/);
});

test("0207 fail-closed replaces the single-column FKs and adds source_journal_line composite", () => {
  const repair = readFileSync(repairPath, "utf8");
  assert.match(repair, /^-- OpenBooks forward migration 0207_allocation_kernel_tenant_fks\./);
  assert.match(repair, /DO \$allocation_kernel_tenant_fks_preflight\$/);
  assert.match(repair, /legacy data violates tenant coherence: public\.allocation_rule_targets\.class_id/);
  assert.match(repair, /legacy data violates tenant coherence: public\.allocation_lineage\.journal_line_id/);
  assert.match(repair, /legacy data violates tenant coherence: public\.allocation_lineage\.source_journal_line_id/);
  assert.match(repair, /legacy data violates tenant coherence: public\.allocation_runs\.book_id/);
  assert.match(repair, /this migration will not rewrite financial evidence/);
  assert.doesNotMatch(repair, /^\s*(?:INSERT|UPDATE|DELETE\s+FROM|TRUNCATE)\b/im);
  assert.doesNotMatch(repair, /0001_baseline/);

  assert.match(
    repair,
    /CREATE UNIQUE INDEX IF NOT EXISTS classes_org_id_id_unique\s+ON public\.classes USING btree \(org_id, id\)/,
  );
  assert.match(
    repair,
    /CREATE UNIQUE INDEX IF NOT EXISTS journal_lines_org_id_id_unique\s+ON public\.journal_lines USING btree \(org_id, id\)/,
  );
  assert.match(
    repair,
    /CREATE UNIQUE INDEX IF NOT EXISTS accounting_books_org_id_id_unique\s+ON public\.accounting_books USING btree \(org_id, id\)/,
  );

  for (const edge of repaired) {
    assert.match(repair, new RegExp(`DROP CONSTRAINT IF EXISTS ${edge.name}`));
    assert.match(
      repair,
      new RegExp(
        `ADD CONSTRAINT ${edge.name}\\s+FOREIGN KEY \\(${edge.columns}\\)\\s+REFERENCES public\\.${edge.parent} \\(org_id, id\\)\\s+DEFERRABLE NOT VALID`,
      ),
    );
    assert.match(repair, new RegExp(`VALIDATE CONSTRAINT ${edge.name}`));
  }

  assert.match(repair, /[^\n]\n$/);
  assert.doesNotMatch(repair, /\n\n$/);
});

test("0207 is named in the exact reviewed-migration registry", () => {
  const inventoryPath = new URL("../../canonical-baseline.test.ts", import.meta.url);
  assert.ok(existsSync(repairPath), "0207 SQL must be shipped");
  assert.ok(existsSync(inventoryPath), "canonical-baseline test must exist");
  const inventory = readFileSync(inventoryPath, "utf8");
  const registry = inventory.match(
    /assert\.deepEqual\(generated, \[([\s\S]*?)\]\);/,
  )?.[1];
  assert.ok(registry, "the reviewed-migration registry must exist");
  assert.match(
    registry,
    /"0207_allocation_kernel_tenant_fks\.sql"/,
    "0207 must appear in the exact reviewed-migration registry",
  );
});

test("drizzle allocations schema publishes the same composite FKs", () => {
  const schema = readFileSync(schemaPath, "utf8");
  for (const edge of repaired) {
    assert.match(
      schema,
      new RegExp(
        `foreignKey\\(\\{\\s+name: "${edge.name}",\\s+columns: \\[${edge.drizzleColumns}\\],\\s+foreignColumns: \\[${edge.drizzleParent}\\],\\s+\\}\\)`,
      ),
    );
  }
  assert.doesNotMatch(
    schema,
    /name: "allocation_runs_book_id_fkey",\s+columns: \[t\.bookId\],\s+foreignColumns: \[accountingBooks\.id\]/,
  );
});
