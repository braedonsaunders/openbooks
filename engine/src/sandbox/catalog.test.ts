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

test("sandbox deletion preserves immediate parent order inside deferred cycles", () => {
  const refs: Record<string, Record<string, string>> = {
    departments: {},
    mfg_work_centers: { department_id: "departments", movement_id: "inventory_movements" },
    inventory_movements: { serial_id: "serials" },
    serials: { current_missing_count_movement_id: "inventory_movements", center_id: "mfg_work_centers" },
  };
  const tables = Object.entries(refs).map(([name, fks]) => ({
    ...table("NO ACTION"), name, fks, hardFks: {},
    fkDeleteRules: Object.fromEntries(Object.keys(fks).map(key => [key, key === "department_id" ? "RESTRICT" : "NO ACTION"])),
  }));
  const cat = { tables, tenantTables: tables, rebaseSet: new Set(Object.keys(refs)) };
  assert.ok(deferredDeletionTables(cat).has("departments"));
  const order = deletionOrder(cat);
  assert.ok(order.indexOf("mfg_work_centers") < order.indexOf("departments"));
  assert.equal(new Set(order).size, tables.length);
  const cyclic = tables.map(t => t.name === "departments"
    ? { ...t, fks: { center_id: "mfg_work_centers" }, fkDeleteRules: { center_id: "RESTRICT" } }
    : t);
  const cyclicOrder = deletionOrder({ ...cat, tables: cyclic });
  assert.equal(new Set(cyclicOrder).size, tables.length, "structural cycles retain every table for native row validation");
  assert.equal(Math.abs(cyclicOrder.indexOf("departments") - cyclicOrder.indexOf("mfg_work_centers")), 1);
});

test("sandbox insertion resolves inventory ownership and tracking parents inside a deferred cycle", () => {
  const nodes = ["inventory_movements", "consignment_stock", "item_inventory_profiles", "items", "stock_locations", "serials", "lots", "cost_layers"];
  const refs: Record<string, Record<string, string>> = {
    inventory_movements: { item_id: "items", serial_id: "serials" },
    consignment_stock: { item_id: "items" },
    item_inventory_profiles: { item_id: "items" },
    items: { last_movement_id: "inventory_movements" },
    stock_locations: {},
    serials: { lot_id: "lots", current_missing_count_movement_id: "inventory_movements" },
    lots: {},
    cost_layers: { source_movement_id: "inventory_movements" },
  };
  const tables = nodes.map(name => ({ ...table("NO ACTION"), name, fks: refs[name]!, hardFks: {} }));
  const order = insertionOrder({ tables, tenantTables: tables, rebaseSet: new Set(nodes) });
  assert.ok(order.indexOf("item_inventory_profiles") < order.indexOf("inventory_movements"));
  assert.ok(order.indexOf("item_inventory_profiles") < order.indexOf("consignment_stock"));
  for (const parent of ["stock_locations", "lots", "serials"]) {
    assert.ok(order.indexOf(parent) < order.indexOf("inventory_movements"));
    assert.ok(order.indexOf(parent) < order.indexOf("consignment_stock"));
  }
  assert.ok(order.indexOf("lots") < order.indexOf("serials"));
  assert.ok(order.indexOf("cost_layers") < order.indexOf("consignment_stock"));
  assert.equal(new Set(order).size, nodes.length);
  const deferred = deferredDeletionTables({ tables, tenantTables: tables, rebaseSet: new Set(nodes) });
  assert.ok(deferred.has("serials"), "native teardown must defer the current count movement cycle");
  assert.ok(deferred.has("inventory_movements"));
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
  const tickets = table("NO ACTION");
  tickets.name = "field_tickets";
  tickets.fks = { document_id: "documents", submitted_by: "users" };
  tickets.hardFks = {};
  const signatures = table("NO ACTION");
  signatures.name = "field_ticket_signatures";
  signatures.fks = { field_ticket_id: "documents", signature_file_id: "files" };
  signatures.hardFks = {};
  const users = table("NO ACTION");
  users.name = "users";
  users.fks = {};
  users.hardFks = {};
  const files = table("NO ACTION");
  files.name = "files";
  files.fks = {};
  files.hardFks = {};
  const documents = table("NO ACTION");
  documents.name = "documents";
  documents.fks = { labor_snapshot_id: "field_ticket_labor_snapshots" };
  documents.hardFks = {};

  const tables = [laborLines, snapshots, signatures, tickets, documents, users, files];
  const order = insertionOrder({
    tables,
    tenantTables: tables,
    rebaseSet: new Set(),
  });
  assert.ok(order.indexOf("documents") < order.indexOf("field_ticket_labor_lines"));
  assert.ok(order.indexOf("documents") < order.indexOf("field_tickets"));
  assert.ok(order.indexOf("users") < order.indexOf("field_tickets"));
  assert.ok(order.indexOf("field_tickets") < order.indexOf("field_ticket_labor_snapshots"));
  assert.ok(order.indexOf("users") < order.indexOf("field_ticket_labor_snapshots"));
  assert.ok(order.indexOf("field_tickets") < order.indexOf("field_ticket_signatures"));
  assert.ok(order.indexOf("files") < order.indexOf("field_ticket_signatures"));
  assert.ok(order.indexOf("field_ticket_labor_snapshots") < order.indexOf("field_ticket_labor_lines"));
});

test("sandbox insertion retains assignment ownership order through employment history cycles", () => {
  const nodes = ["employment_assignment_versions", "employment_assignments", "employment_changes", "worker_employment_versions", "worker_employments"];
  const refs: Record<string, Record<string, string>> = {
    employment_assignment_versions: { assignment_id: "employment_assignments", closed_by_change_id: "employment_changes", employment_id: "worker_employments" },
    employment_assignments: { employment_id: "worker_employments" },
    employment_changes: { assignment_id: "employment_assignments", employment_id: "worker_employments" },
    worker_employment_versions: { closed_by_change_id: "employment_changes", employment_id: "worker_employments" },
    worker_employments: { current_version_id: "worker_employment_versions" },
  };
  const tables = nodes.map(name => ({ ...table("NO ACTION"), name, fks: refs[name]!, hardFks: {} }));
  const order = insertionOrder({ tables, tenantTables: tables, rebaseSet: new Set(nodes) });
  assert.ok(order.indexOf("employment_assignments") < order.indexOf("employment_assignment_versions"));
  assert.ok(order.indexOf("employment_assignments") < order.indexOf("employment_changes"));
  assert.equal(new Set(order).size, nodes.length);
});

test("sandbox insertion resolves project adjustment ownership inside the deferred document cycle", () => {
  const nodes = ["project_financial_adjustments", "project_overhead_adjustments",
    "project_financial_profile_versions", "projects", "documents", "project_types"];
  const refs: Record<string, Record<string, string>> = {
    project_financial_adjustments: { project_id: "projects", reverses_adjustment_id: "project_financial_adjustments" },
    project_overhead_adjustments: { project_id: "projects", reverses_adjustment_id: "project_overhead_adjustments" },
    project_financial_profile_versions: { project_type_id: "project_types" },
    projects: { source_document_id: "documents", project_type_id: "project_types" },
    documents: { project_id: "projects" },
    project_types: { current_version_id: "project_financial_profile_versions" },
  };
  const tables = nodes.map(name => ({ ...table("NO ACTION"), name, fks: refs[name]!, hardFks: {} }));
  const order = insertionOrder({ tables, tenantTables: tables, rebaseSet: new Set(nodes) });
  assert.ok(order.indexOf("projects") < order.indexOf("project_financial_adjustments"));
  assert.ok(order.indexOf("projects") < order.indexOf("project_overhead_adjustments"));
  assert.ok(order.indexOf("project_types") < order.indexOf("project_financial_profile_versions"));
  assert.equal(new Set(order).size, nodes.length);
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
