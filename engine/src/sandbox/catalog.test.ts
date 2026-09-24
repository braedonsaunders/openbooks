import assert from "node:assert/strict";
import test from "node:test";
import {
  assertUuid,
  deferredDeletionTables,
  deletionOrder,
  insertionOrder,
  selfRefColumns,
  type TableInfo,
} from "./catalog.ts";

function table(deleteRule: string): TableInfo {
  return {
    name: "tree",
    hasOrgId: true,
    hasId: true,
    columns: [],
    fks: { parent_id: "tree" },
    fkDeleteRules: { parent_id: deleteRule },
    hardFks: { parent_id: "tree" },
    forceRebase: new Set<string>(),
  };
}

test("sandbox wipe pre-nulls self references only for ON DELETE RESTRICT", () => {
  assert.deepEqual(selfRefColumns(table("RESTRICT")), ["parent_id"]);
  assert.deepEqual(selfRefColumns(table("NO ACTION")), []);
  assert.deepEqual(selfRefColumns(table("CASCADE")), []);
});

test("sandbox wipe breaks document-ledger cycles without deferring the graph", () => {
  const applications = table("NO ACTION");
  applications.name = "applications";
  applications.fks = { to_line_id: "journal_lines" };
  applications.fkDeleteRules = { to_line_id: "NO ACTION" };
  const documents = table("NO ACTION");
  documents.name = "documents";
  documents.fks = { posted_entry_id: "journal_entries" };
  documents.fkDeleteRules = { posted_entry_id: "NO ACTION" };
  const journalLines = table("NO ACTION");
  journalLines.name = "journal_lines";
  journalLines.fks = { entry_id: "journal_entries" };
  journalLines.fkDeleteRules = { entry_id: "NO ACTION" };
  const journalEntries = table("NO ACTION");
  journalEntries.name = "journal_entries";
  journalEntries.fks = { source_document_id: "documents" };
  journalEntries.fkDeleteRules = { source_document_id: "NO ACTION" };

  const order = deletionOrder({
    tables: [applications, documents, journalLines, journalEntries],
    tenantTables: [applications, documents, journalLines, journalEntries],
    rebaseSet: new Set(),
  });
  assert.ok(order.indexOf("applications") < order.indexOf("journal_lines"));
  const deferred = deferredDeletionTables({
    tables: [applications, documents, journalLines, journalEntries],
    tenantTables: [applications, documents, journalLines, journalEntries],
    rebaseSet: new Set(),
  });
  assert.deepEqual([...deferred], []);
});

test("sandbox insertion orders inferred trigger-owned parents before children", () => {
  const projectTypes = table("NO ACTION");
  projectTypes.name = "project_types";
  projectTypes.fks = {};
  projectTypes.hardFks = {};
  const versions = table("NO ACTION");
  versions.name = "project_financial_profile_versions";
  versions.fks = { project_type_id: "project_types" };
  versions.hardFks = {};

  const order = insertionOrder({
    tables: [versions, projectTypes],
    tenantTables: [versions, projectTypes],
    rebaseSet: new Set(),
  });
  assert.ok(order.indexOf("project_types") < order.indexOf("project_financial_profile_versions"));
});

test("sandbox insertion opens the deferred document-ledger cycle at the declared breaker", () => {
  const documents = table("NO ACTION");
  documents.name = "documents";
  documents.fks = { posted_entry_id: "journal_entries" };
  documents.hardFks = {};
  const entries = table("NO ACTION");
  entries.name = "journal_entries";
  entries.fks = { source_document_id: "documents" };
  entries.hardFks = {};

  const order = insertionOrder({
    tables: [entries, documents],
    tenantTables: [entries, documents],
    rebaseSet: new Set(),
  });
  assert.ok(order.indexOf("documents") < order.indexOf("journal_entries"));
});

test("sandbox insertion orders trigger-required parents inside a deferrable FK cycle", () => {
  const laborLines = table("NO ACTION");
  laborLines.name = "field_ticket_labor_lines";
  laborLines.fks = { snapshot_id: "field_ticket_labor_snapshots", field_ticket_id: "documents" };
  laborLines.hardFks = {};
  const snapshots = table("NO ACTION");
  snapshots.name = "field_ticket_labor_snapshots";
  snapshots.fks = { field_ticket_id: "documents" };
  snapshots.hardFks = {};
  const documents = table("NO ACTION");
  documents.name = "documents";
  documents.fks = { labor_snapshot_id: "field_ticket_labor_snapshots" };
  documents.hardFks = {};

  const order = insertionOrder({
    tables: [laborLines, snapshots, documents],
    tenantTables: [laborLines, snapshots, documents],
    rebaseSet: new Set(),
  });
  assert.ok(order.indexOf("documents") < order.indexOf("field_ticket_labor_lines"));
  assert.ok(order.indexOf("field_ticket_labor_snapshots") < order.indexOf("field_ticket_labor_lines"));
});

/**
 * The boundary guard that makes the wipe's one remaining raw-SQL interpolation
 * (PARENT_FILTER's org id) provably safe: a value that passes here is a
 * canonical UUID and cannot carry a quote or a statement.
 */
test("assertUuid accepts a canonical uuid and refuses anything that could carry SQL", () => {
  assert.equal(assertUuid("00000000-0000-4000-8000-00000000c001"), "00000000-0000-4000-8000-00000000c001");
  for (const hostile of [
    "00000000-0000-4000-8000-00000000c001'; drop table orgs;--",
    "not-a-uuid",
    "",
    "00000000-0000-4000-8000-00000000c00",
    "00000000-0000-4000-8000-00000000c00z",
  ]) {
    assert.throws(() => assertUuid(hostile), /not a uuid/, `must refuse ${JSON.stringify(hostile)}`);
  }
});
