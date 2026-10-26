import assert from "node:assert/strict";
import test from "node:test";
import { EXCLUDE, insertionOrder, type TableInfo } from "./catalog.ts";
import { TENANT_TABLE_POLICIES } from "./tenant-table-policies.ts";

const table = (name: string): TableInfo => ({
  name,
  hasOrgId: true,
  hasId: true,
  columns: [],
  fks: {},
  hardFks: {},
  fkDeleteRules: {},
  forceRebase: new Set(),
});

test("financial copy admission has its retained parent graph before policy and ledger evidence", () => {
  const names = [
    "gl_audit_number_assignments",
    "journal_lines",
    "journal_entries",
    "gl_audit_number_policies",
    "subsidiary_accounting_preferences",
    "account_translation_policies",
    "fx_rate_types",
    "form_layouts",
    "accounting_periods",
    "fiscal_calendars",
    "accounting_books",
    "accounts",
    "users",
    "subsidiaries",
  ];
  const tables = names.map(table);
  const order = insertionOrder({ tables, tenantTables: tables, rebaseSet: new Set(names) });
  for (const [parent, child] of [
    ["fx_rate_types", "subsidiary_accounting_preferences"],
    ["fiscal_calendars", "subsidiary_accounting_preferences"],
    ["accounts", "account_translation_policies"],
    ["journal_entries", "journal_lines"],
    ["journal_lines", "gl_audit_number_assignments"],
    ["gl_audit_number_policies", "gl_audit_number_assignments"],
  ]) {
    assert.ok(order.indexOf(parent!) < order.indexOf(child!), `${parent} must precede ${child}`);
  }
});

test("source automatic reversal and renewal reminder execution is excluded while retained financial facts copy", () => {
  for (const name of [
    "journal_reversal_instructions",
    "subscription_renewal_policies",
    "subscription_renewal_occurrences",
  ] as const) {
    assert.equal(TENANT_TABLE_POLICIES[name], "skip:no-copy");
    assert.equal(EXCLUDE.has(name), true);
  }
  for (const name of [
    "fx_rate_types",
    "account_translation_policies",
    "subsidiary_accounting_preferences",
    "segment_balancing_policies",
    "gl_audit_number_policies",
    "gl_audit_number_assignments",
    "recognition_control_events",
    "rebate_agreements",
    "rebate_cost_attestations",
    "rebate_accruals",
    "rebate_claims",
    "rebate_settlement_reversals",
  ] as const) {
    assert.equal(TENANT_TABLE_POLICIES[name], "clone:catalog-uuid-rebase");
    assert.equal(EXCLUDE.has(name), false);
  }
});
