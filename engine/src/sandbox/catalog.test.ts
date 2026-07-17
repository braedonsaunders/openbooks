import assert from "node:assert/strict";
import test from "node:test";
import {
  deferredDeletionTables,
  deletionOrder,
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
