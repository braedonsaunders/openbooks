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
    partyRefByFamily: { customer: new Map([["Acme", "C:c1"]]), vendor: new Map(), employee: new Map() },
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
    partyRefByFamily: { customer: new Map([["Acme", "C:c1"]]), vendor: new Map(), employee: new Map() },
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
    partyRefByFamily: { customer: new Map(), vendor: new Map(), employee: new Map() },
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
      { rowType: "DataRow", columns: { TxnID: "txn-bad", Date: "2024-02-01", Name: "Acme", Account: "Accounts Receivable", Debit: "10.0000" } },
      { rowType: "DataRow", columns: { TxnID: "txn-bad", Date: "2024-02-01", Account: "Sales", Credit: "9.9999" } },
    ],
    accountRefByName: new Map([["Accounts Receivable", "ar"], ["Sales", "sales"]]),
    partyRefByFamily: { customer: new Map([["Acme", "C:c1"]]), vendor: new Map(), employee: new Map() },
    ctx: context(), baseCurrency: "CAD",
  });
  assert.equal(built.documents.length, 0);
  assert.match(built.unbuildable[0]!.reason, /0\.0001/);
});

function emptyFamilies(): { customer: Map<string, string>; vendor: Map<string, string>; employee: Map<string, string> } {
  return { customer: new Map(), vendor: new Map(), employee: new Map() };
}

function partyContext(): NativeContext {
  const ctx = context();
  ctx.accountByRef.set("ap", { id: "ap-id", number: "2000", name: "Accounts Payable", type: "liability_payable" });
  ctx.accountByRef.set("expense", { id: "expense-id", number: "6000", name: "Office Expense", type: "expense" });
  ctx.accountByRef.set("bank", { id: "bank-id", number: "1000", name: "Checking", type: "asset_bank" });
  ctx.partyByRef.set("V:v1", "vendor-id");
  return ctx;
}

test("a balanced omitted pair on unmapped accounts is unbuildable and imports no journal", () => {
  // Mapped AR Dr100 / Sales Cr100 plus an unmapped Expense Dr10 / Cash Cr10:
  // the mapped legs net to zero, but the transaction is unbuildable — the
  // unmapped pair must never be silently lost.
  const built = buildQbdLedgerDocuments({
    rows: [
      { rowType: "DataRow", columns: { TxnID: "txn-bal", Date: "2024-03-01", Name: "Acme", Account: "Accounts Receivable", Debit: "100.0000" } },
      { rowType: "DataRow", columns: { TxnID: "txn-bal", Date: "2024-03-01", Account: "Sales", Credit: "100.0000" } },
      { rowType: "DataRow", columns: { TxnID: "txn-bal", Date: "2024-03-01", Account: "Unmapped Expense", Debit: "10.0000" } },
      { rowType: "DataRow", columns: { TxnID: "txn-bal", Date: "2024-03-01", Account: "Unmapped Cash", Credit: "10.0000" } },
    ],
    accountRefByName: new Map([["Accounts Receivable", "ar"], ["Sales", "sales"]]),
    partyRefByFamily: { customer: new Map([["Acme", "C:c1"]]), vendor: new Map(), employee: new Map() },
    ctx: context(), baseCurrency: "CAD",
  });
  assert.equal(built.documents.length, 0);
  assert.equal(built.unbuildable.length, 1);
  assert.equal(built.unbuildable[0]!.ref, "txn-bal");
  assert.match(built.unbuildable[0]!.reason, /has 2 line\(s\) on unmapped account\(s\): Unmapped Expense, Unmapped Cash/);
  assert.match(built.unbuildable[0]!.reason, /map them before import/);
});

test("a single unmapped nonzero leg is unbuildable", () => {
  const built = buildQbdLedgerDocuments({
    rows: [
      { rowType: "DataRow", columns: { TxnID: "txn-leg", Date: "2024-03-01", Name: "Acme", Account: "Accounts Receivable", Debit: "100.0000" } },
      { rowType: "DataRow", columns: { TxnID: "txn-leg", Date: "2024-03-01", Account: "Sales", Credit: "90.0000" } },
      { rowType: "DataRow", columns: { TxnID: "txn-leg", Date: "2024-03-01", Account: "Unmapped Discount", Credit: "10.0000" } },
    ],
    accountRefByName: new Map([["Accounts Receivable", "ar"], ["Sales", "sales"]]),
    partyRefByFamily: { customer: new Map([["Acme", "C:c1"]]), vendor: new Map(), employee: new Map() },
    ctx: context(), baseCurrency: "CAD",
  });
  assert.equal(built.documents.length, 0);
  assert.equal(built.unbuildable.length, 1);
  assert.match(built.unbuildable[0]!.reason, /has 1 line\(s\) on unmapped account\(s\): Unmapped Discount/);
});

test("a zero-amount row on an unmapped account is still skipped", () => {
  const built = buildQbdLedgerDocuments({
    rows: [
      { rowType: "DataRow", columns: { TxnID: "txn-zero", Date: "2024-03-01", Name: "Acme", Account: "Accounts Receivable", Debit: "100.0000" } },
      { rowType: "DataRow", columns: { TxnID: "txn-zero", Date: "2024-03-01", Account: "Sales", Credit: "100.0000" } },
      { rowType: "DataRow", columns: { TxnID: "txn-zero", Date: "2024-03-01", Account: "Unmapped Memo" } },
    ],
    accountRefByName: new Map([["Accounts Receivable", "ar"], ["Sales", "sales"]]),
    partyRefByFamily: { customer: new Map([["Acme", "C:c1"]]), vendor: new Map(), employee: new Map() },
    ctx: context(), baseCurrency: "CAD",
  });
  assert.equal(built.unbuildable.length, 0);
  assert.equal(built.documents.length, 1);
});

test("an AR line with an unmapped party is unbuildable and named", () => {
  const built = buildQbdLedgerDocuments({
    rows: [
      { rowType: "DataRow", columns: { TxnID: "txn-ar", Date: "2024-03-01", Name: "Acme", Account: "Accounts Receivable", Debit: "100.0000" } },
      { rowType: "DataRow", columns: { TxnID: "txn-ar", Date: "2024-03-01", Account: "Sales", Credit: "100.0000" } },
    ],
    accountRefByName: new Map([["Accounts Receivable", "ar"], ["Sales", "sales"]]),
    partyRefByFamily: emptyFamilies(),
    ctx: context(), baseCurrency: "CAD",
  });
  assert.equal(built.documents.length, 0);
  assert.equal(built.unbuildable.length, 1);
  assert.equal(
    built.unbuildable[0]!.reason,
    "ledger transaction txn-ar: party Acme on Accounts Receivable is not mapped — map the customer/vendor before import",
  );
});

test("a control line with no name is unbuildable", () => {
  const built = buildQbdLedgerDocuments({
    rows: [
      { rowType: "DataRow", columns: { TxnID: "txn-noname", Date: "2024-03-01", Account: "Accounts Receivable", Debit: "100.0000" } },
      { rowType: "DataRow", columns: { TxnID: "txn-noname", Date: "2024-03-01", Account: "Sales", Credit: "100.0000" } },
    ],
    accountRefByName: new Map([["Accounts Receivable", "ar"], ["Sales", "sales"]]),
    partyRefByFamily: emptyFamilies(),
    ctx: context(), baseCurrency: "CAD",
  });
  assert.equal(built.documents.length, 0);
  assert.equal(built.unbuildable.length, 1);
  assert.match(built.unbuildable[0]!.reason, /txn-noname.*Accounts Receivable requires a party/);
});

test("a control line resolves only to its own family, never the wrong one", () => {
  const built = buildQbdLedgerDocuments({
    rows: [
      { rowType: "DataRow", columns: { TxnID: "txn-wrong", Date: "2024-03-01", Name: "VendorOnly", Account: "Accounts Receivable", Debit: "100.0000" } },
      { rowType: "DataRow", columns: { TxnID: "txn-wrong", Date: "2024-03-01", Account: "Sales", Credit: "100.0000" } },
    ],
    accountRefByName: new Map([["Accounts Receivable", "ar"], ["Sales", "sales"]]),
    partyRefByFamily: { customer: new Map(), vendor: new Map([["VendorOnly", "V:v9"]]), employee: new Map() },
    ctx: partyContext(), baseCurrency: "CAD",
  });
  assert.equal(built.documents.length, 0);
  assert.equal(built.unbuildable.length, 1);
  assert.match(built.unbuildable[0]!.reason, /party VendorOnly on Accounts Receivable is not mapped/);
});

test("a name shared by a customer and a vendor resolves by account class", () => {
  const families = {
    customer: new Map([["Acme", "C:c1"]]),
    vendor: new Map([["Acme", "V:v1"]]),
    employee: new Map(),
  };
  const accountRefByName = new Map([
    ["Accounts Receivable", "ar"],
    ["Accounts Payable", "ap"],
    ["Office Expense", "expense"],
    ["Checking", "bank"],
    ["Sales", "sales"],
  ]);
  const built = buildQbdLedgerDocuments({
    rows: [
      { rowType: "DataRow", columns: { TxnID: "txn-ar3", Date: "2024-03-01", Name: "Acme", Account: "Accounts Receivable", Debit: "100.0000" } },
      { rowType: "DataRow", columns: { TxnID: "txn-ar3", Date: "2024-03-01", Account: "Sales", Credit: "100.0000" } },
      { rowType: "DataRow", columns: { TxnID: "txn-ap3", Date: "2024-03-01", Account: "Office Expense", Debit: "50.0000" } },
      { rowType: "DataRow", columns: { TxnID: "txn-ap3", Date: "2024-03-01", Name: "Acme", Account: "Accounts Payable", Credit: "50.0000" } },
      { rowType: "DataRow", columns: { TxnID: "txn-amb", Date: "2024-03-01", Name: "Acme", Account: "Checking", Debit: "25.0000" } },
      { rowType: "DataRow", columns: { TxnID: "txn-amb", Date: "2024-03-01", Account: "Sales", Credit: "25.0000" } },
    ],
    accountRefByName,
    partyRefByFamily: families,
    ctx: partyContext(), baseCurrency: "CAD",
  });
  const byRef = new Map(built.documents.map((doc) => [doc.sourceRef, doc]));
  // The AR line carries the customer, the AP line the vendor — never swapped.
  assert.equal(byRef.get("txn-ar3")?.lines.find((line) => line.accountId === "ar-id")?.partyId, "customer-id");
  assert.equal(byRef.get("txn-ap3")?.lines.find((line) => line.accountId === "ap-id")?.partyId, "vendor-id");
  // A non-control line cannot pick a family: the shared name is ambiguous.
  assert.ok(!byRef.has("txn-amb"));
  assert.equal(built.unbuildable.length, 1);
  assert.equal(built.unbuildable[0]!.ref, "txn-amb");
  assert.match(built.unbuildable[0]!.reason, /party Acme on Checking is ambiguous/);
});
