/**
 * 0261 backfills the dimension-FK indexes the three big ledger tables were
 * missing. Deleting a department (or any sandbox refresh / org purge
 * touching a referenced row) fires one FK check per referencing row, and
 * with no index each check scans all of the org's lines.
 *
 * This pins the migration's contract from the file itself: the exact 28
 * indexes (name, table, key, partial predicate), CONCURRENTLY with
 * IF NOT EXISTS throughout, the no-transaction directive the runner needs
 * for CONCURRENTLY, the INVALID-index cleanup that makes a retry safe (a
 * failed CONCURRENTLY build leaves an INVALID name that IF NOT EXISTS
 * would otherwise skip forever), and parity with the Drizzle declarations
 * in schema/src. Whether the file APPLIES is proven by a full bootstrap
 * on a fresh database (28/28 present and valid, ledger row recorded),
 * which no file-level test can stand in for.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  join(here, "migrations", "generated", "0261_ledger_dimension_fk_indexes.sql"),
  "utf8",
);

// name -> [table, key columns, partial predicate or null]
const EXPECTED = new Map([
  ["jl_org_department", ["journal_lines", "(org_id, department_id)", null]],
  ["jl_org_class", ["journal_lines", "(org_id, class_id)", null]],
  ["jl_org_location", ["journal_lines", "(org_id, location_id)", null]],
  ["jl_org_tax_code", ["journal_lines", "(org_id, tax_code_id)", "(tax_code_id IS NOT NULL)"]],
  ["jl_org_payment_card", ["journal_lines", "(org_id, payment_card_id)", "(payment_card_id IS NOT NULL)"]],
  ["jl_org_equipment_unit", ["journal_lines", "(org_id, equipment_unit_id)", "(equipment_unit_id IS NOT NULL)"]],
  ["doc_lines_item", ["document_lines", "(org_id, item_id)", null]],
  ["doc_lines_tax_code", ["document_lines", "(org_id, tax_code_id)", null]],
  ["doc_lines_account", ["document_lines", "(org_id, account_id)", null]],
  ["doc_lines_employee", ["document_lines", "(org_id, employee_id)", "(employee_id IS NOT NULL)"]],
  ["doc_lines_equipment_unit", ["document_lines", "(org_id, equipment_unit_id)", "(equipment_unit_id IS NOT NULL)"]],
  ["doc_lines_rate_version", ["document_lines", "(org_id, rate_version_id)", "(rate_version_id IS NOT NULL)"]],
  ["doc_lines_recovery_account", ["document_lines", "(org_id, recovery_account_id)", "(recovery_account_id IS NOT NULL)"]],
  ["doc_lines_stock_location", ["document_lines", "(org_id, stock_location_id)", "(stock_location_id IS NOT NULL)"]],
  ["doc_lines_subsidiary", ["document_lines", "(org_id, subsidiary_id)", "(subsidiary_id IS NOT NULL)"]],
  ["doc_lines_tax_group", ["document_lines", "(org_id, tax_group_id)", "(tax_group_id IS NOT NULL)"]],
  ["doc_lines_time_type", ["document_lines", "(org_id, time_type_id)", "(time_type_id IS NOT NULL)"]],
  ["time_entries_item", ["time_entries", "(org_id, item_id)", null]],
  ["time_entries_project_task", ["time_entries", "(org_id, project_task_id)", null]],
  ["time_entries_department", ["time_entries", "(org_id, department_id)", null]],
  ["time_entries_bill_rate_book", ["time_entries", "(org_id, bill_rate_book_id)", "(bill_rate_book_id IS NOT NULL)"]],
  ["time_entries_bill_rate_line", ["time_entries", "(org_id, bill_rate_line_id)", "(bill_rate_line_id IS NOT NULL)"]],
  ["time_entries_bill_rate_version", ["time_entries", "(org_id, bill_rate_version_id)", "(bill_rate_version_id IS NOT NULL)"]],
  ["time_entries_labor_cost_rate", ["time_entries", "(org_id, labor_cost_rate_id)", "(labor_cost_rate_id IS NOT NULL)"]],
  ["time_entries_cost_rate_subsidiary", ["time_entries", "(org_id, cost_rate_subsidiary_id)", "(cost_rate_subsidiary_id IS NOT NULL)"]],
  ["time_entries_cost_rate_currency", ["time_entries", "(org_id, cost_rate_currency)", "(cost_rate_currency IS NOT NULL)"]],
  ["time_entries_wage_currency", ["time_entries", "(org_id, wage_currency)", "(wage_currency IS NOT NULL)"]],
  ["time_entries_time_type", ["time_entries", "(org_id, time_type_id)", "(time_type_id IS NOT NULL)"]],
]);

function createdIndexes() {
  const found = new Map();
  const pattern =
    /CREATE INDEX CONCURRENTLY IF NOT EXISTS ([a-z_]+)\s+ON public\.([a-z_]+) USING btree \(([^)]+)\)(\s+WHERE \(([^)]+)\))?;/g;
  for (const match of migration.matchAll(pattern)) {
    found.set(match[1], [match[2], `(${(match[3] ?? "").trim()})`, match[5] ? `(${match[5].trim()})` : null]);
  }
  return found;
}

test("0261 declares exactly the 28 missing dimension-FK indexes", () => {
  const found = createdIndexes();
  assert.deepEqual(
    [...found.keys()].sort(),
    [...EXPECTED.keys()].sort(),
    "an added, dropped, or renamed index changes FK coverage",
  );
  for (const [name, spec] of EXPECTED) {
    assert.deepEqual(found.get(name), spec, `${name} must stay composite (org_id, fk)`);
  }
});

test("0261 runs outside a transaction and leaves the runner's bound alone", () => {
  assert.ok(
    migration.split("\n").some((line) => /^\s*--\s*openbooks:\s*no-transaction\s*$/i.test(line)),
    "CONCURRENTLY refuses any transaction block, so the directive is load-bearing",
  );
  // Prose may discuss lock_timeout; CODE may not set it (same rule the
  // check-migration-headers gate enforces — comments stripped first).
  const code = migration
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  assert.doesNotMatch(code, /lock_timeout/i);
  assert.doesNotMatch(code, /set_config/i);
});

test("0261 drops its own INVALID indexes before rebuilding", () => {
  for (const name of EXPECTED.keys()) {
    assert.ok(
      migration.includes(`'${name}'`),
      `${name} must be in the INVALID-cleanup list or a failed build wedges it`,
    );
  }
  assert.match(migration, /WHERE NOT i\.indisvalid/);
});

test("0261 matches the Drizzle declarations in schema/src", () => {
  const sources = {
    jl_org: readFileSync(join(here, "src", "ledger.ts"), "utf8"),
    doc_lines: readFileSync(join(here, "src", "documents.ts"), "utf8"),
    time_entries: readFileSync(join(here, "src", "time.ts"), "utf8"),
  };
  const owners = [...EXPECTED.keys()].map((name) => [
    name,
    name.startsWith("jl_org")
      ? sources.jl_org
      : name.startsWith("doc_lines")
        ? sources.doc_lines
        : sources.time_entries,
  ]);
  for (const [name, source] of owners) {
    assert.ok(
      source.includes(`"${name}"`),
      `${name} must be declared in schema/src alongside the migration`,
    );
  }
});
