import test from "node:test";
import assert from "node:assert/strict";
import { toUnits } from "../money/money.ts";
import type { NativeContext } from "./native.ts";
import { buildQbdLedgerDocuments } from "./qbd-native.ts";

function context(): NativeContext {
  return {
    orgId: "org", refKey: "qbdId", baseCurrency: "CAD", control: { ar: "ar-id", ap: "ap-id", bank: "bank-id" },
    accountByRef: new Map([
      ["ar", { id: "ar-id", number: "1200", name: "Accounts Receivable", type: "asset_receivable" }],
      ["sales", { id: "sales-id", number: "4000", name: "Sales", type: "income" }],
    ]),
    accountRefById: new Map(), partyByRef: new Map([["C:c1", "customer-id"]]), deptByRef: new Map(),
    projectByRef: new Map(), itemByRef: new Map(), subsidiaryByRef: new Map(), segmentValueByRef: new Map(),
    rootSubsidiaryId: "sub", taxByRate: new Map(), taxCodeByRef: new Map(),
    periodByRef: new Map(), periodFor: () => "period",
  };
}

test("QuickBooks ledger rows build an exactly balanced journal with subledger party", () => {
  const built = buildQbdLedgerDocuments({
    rows: [
      { rowType: "DataRow", columns: { TxnID: "txn-1", Date: "2024-01-31", TxnType: "Invoice", RefNumber: "1001", Name: "Acme", Account: "Accounts Receivable", Debit: "1,234.5678" } },
      { rowType: "DataRow", columns: { TxnID: "txn-1", Date: "2024-01-31", Account: "Sales", Credit: "1234.5678" } },
    ],
    accountRefByName: new Map([["Accounts Receivable", "ar"], ["Sales", "sales"]]),
    partyRefByName: new Map([["Acme", "C:c1"]]),
    ctx: context(),
    baseCurrency: "CAD",
  });
  assert.equal(built.unbuildable.length, 0);
  assert.equal(built.documents.length, 1);
  const doc = built.documents[0]!;
  assert.equal(doc.lines[0]!.partyId, "customer-id");
  assert.equal(doc.currency, "CAD");
  assert.equal(doc.lines.reduce((sum, line) => sum + toUnits(line.amount), 0n), 0n);
  assert.deepEqual(doc.lines.map((line) => line.amount), ["1234.5678", "-1234.5678"]);
});

test("QuickBooks display dates normalize to the ISO document date", () => {
  // General-ledger report cells are locale display strings (amounts arrive
  // with thousands separators, dates as M/D/YYYY), while NativeDocument
  // requires an ISO yyyy-mm-dd document date. Passing the display string
  // through stores a non-canonical date, so the stored canonical key can
  // never equal the freshly built one and every mirror re-amends every
  // document; month slicing for verification breaks the same way.
  const built = buildQbdLedgerDocuments({
    rows: [
      { rowType: "DataRow", columns: { TxnID: "txn-us", Date: "1/31/2024", TxnType: "Invoice", RefNumber: "1001", Name: "Acme", Account: "Accounts Receivable", Debit: "100.0000" } },
      { rowType: "DataRow", columns: { TxnID: "txn-us", Date: "01/31/2024", Account: "Sales", Credit: "100.0000" } },
    ],
    accountRefByName: new Map([["Accounts Receivable", "ar"], ["Sales", "sales"]]),
    partyRefByName: new Map([["Acme", "C:c1"]]),
    ctx: context(),
    baseCurrency: "CAD",
  });
  assert.equal(built.unbuildable.length, 0);
  assert.equal(built.documents.length, 1);
  assert.equal(built.documents[0]!.documentDate, "2024-01-31");
});

test("a QuickBooks transaction with no parseable date is unbuildable, never mis-dated", () => {
  const built = buildQbdLedgerDocuments({
    rows: [
      { rowType: "DataRow", columns: { TxnID: "txn-nodate", Account: "Accounts Receivable", Debit: "100.0000" } },
      { rowType: "DataRow", columns: { TxnID: "txn-nodate", Account: "Sales", Credit: "100.0000" } },
    ],
    accountRefByName: new Map([["Accounts Receivable", "ar"], ["Sales", "sales"]]),
    partyRefByName: new Map(),
    ctx: context(),
    baseCurrency: "CAD",
  });
  assert.equal(built.documents.length, 0);
  assert.equal(built.unbuildable.length, 1);
  assert.match(built.unbuildable[0]!.reason, /date/i);
});

test("unmapped or unbalanced QuickBooks transactions are refused, never rounded into balance", () => {
  const built = buildQbdLedgerDocuments({
    rows: [
      { rowType: "DataRow", columns: { TxnID: "txn-bad", Date: "2024-02-01", Account: "Accounts Receivable", Debit: "10.0000" } },
      { rowType: "DataRow", columns: { TxnID: "txn-bad", Date: "2024-02-01", Account: "Sales", Credit: "9.9999" } },
    ],
    accountRefByName: new Map([["Accounts Receivable", "ar"], ["Sales", "sales"]]),
    partyRefByName: new Map(), ctx: context(), baseCurrency: "CAD",
  });
  assert.equal(built.documents.length, 0);
  assert.match(built.unbuildable[0]!.reason, /0\.0001/);
});
