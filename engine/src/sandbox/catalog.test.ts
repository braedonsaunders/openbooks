import assert from "node:assert/strict";
import test from "node:test";
import {
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
