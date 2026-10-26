import assert from "node:assert/strict";
import test from "node:test";
import {
  assembleBatchList,
  pickStatementEmail,
  type StatementBalanceRow,
  type StatementBatchFilters,
  type StatementPartyInfo,
} from "./statement-batch.ts";

const filters: StatementBatchFilters = { to: "2026-10-01" };

function party(overrides: Partial<StatementPartyInfo> = {}): StatementPartyInfo {
  return {
    displayName: "Acme",
    email: "billing@acme.test",
    subsidiaryId: null,
    currency: "CAD",
    contacts: [],
    ...overrides,
  };
}

test("statement mailbox prefers the billing contact over the party email", () => {
  assert.equal(
    pickStatementEmail(
      [{ role: "Sales", email: "sales@acme.test", isPrimary: false, isActive: true }],
      "billing@acme.test",
    ),
    "billing@acme.test",
  );
  assert.equal(
    pickStatementEmail(
      [
        { role: "Sales", email: "sales@acme.test", isPrimary: true, isActive: true },
        { role: "Billing", email: "ap@acme.test", isPrimary: false, isActive: true },
      ],
      "billing@acme.test",
    ),
    "ap@acme.test",
  );
  assert.equal(
    pickStatementEmail(
      [{ role: "statement", email: "statements@acme.test", isPrimary: false, isActive: true }],
      null,
    ),
    "statements@acme.test",
  );
});

test("statement mailbox skips inactive contacts and invalid addresses", () => {
  assert.equal(
    pickStatementEmail(
      [{ role: "Billing", email: "gone@acme.test", isPrimary: false, isActive: false }],
      "billing@acme.test",
    ),
    "billing@acme.test",
  );
  assert.equal(
    pickStatementEmail(
      [{ role: "Billing", email: "not-an-email", isPrimary: false, isActive: true }],
      null,
    ),
    null,
  );
  assert.equal(pickStatementEmail([], "  "), null);
  assert.equal(pickStatementEmail([], null), null);
});

function assemble(
  balances: StatementBalanceRow[],
  parties: Map<string, StatementPartyInfo>,
  extra: {
    filters?: StatementBatchFilters;
    allowedSubsidiaryIds?: Set<string> | null;
    overdue?: Map<string, string>;
  } = {},
) {
  return assembleBatchList({
    balances,
    parties,
    overdueByParty: extra.overdue ?? new Map(),
    filters: extra.filters ?? filters,
    allowedSubsidiaryIds:
      extra.allowedSubsidiaryIds === undefined ? null : extra.allowedSubsidiaryIds,
  });
}

test("batch list drops zero balances and files no-email customers as exclusions", () => {
  const balances: StatementBalanceRow[] = [
    { id: "a", display_name: "Owes", balance: "100.0000" },
    { id: "b", display_name: "Settled", balance: "0.0000" },
    { id: "c", display_name: "No mailbox", balance: "50.0000" },
    { id: null, display_name: "Unassigned", balance: "10.0000" },
  ];
  const parties = new Map([
    ["a", party()],
    ["b", party()],
    ["c", party({ email: null })],
  ]);
  const { recipients, excluded } = assemble(balances, parties);
  assert.deepEqual(
    recipients.map((r) => r.partyId),
    ["a"],
  );
  assert.equal(recipients[0]!.toEmail, "billing@acme.test");
  assert.deepEqual(
    excluded.map((e) => e.partyId),
    ["c"],
  );
  assert.equal(excluded[0]!.reason, "no-email");
  assert.equal(excluded[0]!.fixHref, "/parties?party=c");
});

test("batch list honours overdue-only, currency, and subsidiary filters", () => {
  const balances: StatementBalanceRow[] = [
    { id: "a", display_name: "Current", balance: "100.0000" },
    { id: "b", display_name: "Late", balance: "200.0000" },
  ];
  const parties = new Map([
    ["a", party()],
    ["b", party({ email: "b@acme.test", currency: "USD", subsidiaryId: "sub-1" })],
  ]);
  const overdue = new Map([["b", "200.0000"]]);
  assert.deepEqual(
    assemble(balances, parties, {
      filters: { ...filters, overdueOnly: true },
      overdue,
    }).recipients.map((r) => r.partyId),
    ["b"],
  );
  assert.deepEqual(
    assemble(balances, parties, { filters: { ...filters, currency: "usd" } }).recipients.map(
      (r) => r.partyId,
    ),
    ["b"],
  );
  assert.deepEqual(
    assemble(balances, parties, { filters: { ...filters, subsidiaryId: "sub-1" } }).recipients.map(
      (r) => r.partyId,
    ),
    ["a", "b"],
  );
});

test("batch list keeps out-of-scope subsidiaries silent", () => {
  const balances: StatementBalanceRow[] = [
    { id: "a", display_name: "Foreign", balance: "100.0000" },
  ];
  const parties = new Map([["a", party({ subsidiaryId: "sub-9" })]]);
  const { recipients, excluded } = assemble(balances, parties, {
    allowedSubsidiaryIds: new Set(["sub-1"]),
  });
  assert.deepEqual(recipients, []);
  assert.deepEqual(excluded, []);
});
