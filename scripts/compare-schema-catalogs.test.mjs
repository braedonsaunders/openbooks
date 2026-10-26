import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const empty = () => ({ relations: [], columns: [], constraints: [], indexes: [], triggers: [], functions: [], policies: [] });

function compare(actual, reference) {
  const dir = mkdtempSync(join(tmpdir(), "catalog-compare-"));
  writeFileSync(join(dir, "actual.json"), JSON.stringify(actual));
  writeFileSync(join(dir, "reference.json"), JSON.stringify(reference));
  return JSON.parse(execFileSync("node", ["scripts/compare-schema-catalogs.mjs", join(dir, "actual.json"), join(dir, "reference.json")], { encoding: "utf8" }));
}

function withTable(catalog, name) {
  catalog.relations.push({ relation: name, kind: "r", row_level_security: false, force_row_level_security: false });
  catalog.columns.push({ relation: name, position: 1, column: "filename", data_type: "text", not_null: true });
  catalog.constraints.push({ relation: name, constraint: `${name}_pkey`, type: "p", definition: "PRIMARY KEY (filename)" });
  catalog.indexes.push({ table_name: name, index: `${name}_pkey`, definition: `CREATE UNIQUE INDEX ${name}_pkey ON public.${name} USING btree (filename)` });
  return catalog;
}

test("migration ledger history kept by an upgraded install is not a schema difference", () => {
  const result = compare(withTable(empty(), "_migration_execution_corrections"), empty());
  assert.equal(result.equivalent, true);
});

test("an extra product table still makes the catalogs differ", () => {
  const result = compare(withTable(empty(), "vendor_notes"), empty());
  assert.equal(result.equivalent, false);
  assert.deepEqual(result.relations.extra, ["vendor_notes"]);
});
