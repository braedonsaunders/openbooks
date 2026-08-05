import assert from "node:assert/strict";
import test from "node:test";
import { computeExpected, fromCents, ReferenceLedger, toCents } from "./reference-ledger.ts";
import { generateCorpus } from "./corpus.ts";
import type { Corpus } from "../corpus-lib/types.ts";

const BASE: Pick<Corpus, "accounts" | "parties"> = {
  accounts: [
    { key: "bank", number: "1000", name: "Bank", type: "asset_bank" },
    { key: "ar", number: "1100", name: "AR", type: "asset_receivable" },
    { key: "ap", number: "2000", name: "AP", type: "liability_payable" },
    { key: "employeePayable", number: "2110", name: "Emp Payable", type: "liability_current_other" },
    { key: "revenueService", number: "4000", name: "Revenue", type: "income" },
    { key: "office", number: "6400", name: "Office", type: "expense" },
    { key: "travel", number: "6650", name: "Travel", type: "expense" },
  ],
  parties: [
    { key: "c1", name: "Customer One", roles: ["customer"] },
    { key: "v1", name: "Vendor One", roles: ["vendor"] },
    { key: "e1", name: "Employee One", roles: ["employee"] },
  ],
};

test("cents arithmetic is exact and rejects loose input", () => {
  assert.equal(toCents("10.05"), 1005n);
  assert.equal(toCents("-0.02"), -2n);
  assert.equal(fromCents(-2n), "-0.02");
  assert.equal(fromCents(1005n), "10.05");
  assert.throws(() => toCents("1.005"));
  assert.throws(() => toCents("1e3"));
});

test("posting semantics: invoice, partial payment, credit, AP bill cycle", () => {
  const ledger = new ReferenceLedger(BASE);
  ledger.apply({
    id: "INV-1", kind: "customer_invoice", date: "2026-01-05", party: "c1",
    lines: [
      { account: "revenueService", amount: "66.67" },
      { account: "revenueService", amount: "33.33" },
    ],
  });
  ledger.apply({
    id: "PAY-1", kind: "customer_payment", date: "2026-01-20", party: "c1",
    allocations: [{ event: "INV-1", amount: "40.00" }],
  });
  ledger.apply({
    id: "CR-1", kind: "customer_credit", date: "2026-01-21", party: "c1",
    lines: [{ account: "revenueService", amount: "10.00" }],
  });
  ledger.apply({
    id: "BILL-1", kind: "vendor_bill", date: "2026-01-06", party: "v1",
    lines: [{ account: "office", amount: "25.10" }],
  });
  ledger.apply({
    id: "VPAY-1", kind: "vendor_payment", date: "2026-01-25", party: "v1",
    allocations: [{ event: "BILL-1", amount: "25.10" }],
  });
  ledger.apply({
    id: "EXP-1", kind: "expense_report", date: "2026-01-10", party: "e1",
    lines: [{ account: "travel", amount: "12.34" }],
  });

  const r = ledger.result();
  // AR = 100 invoice − 40 payment − 10 credit = 50 in the GL…
  assert.equal(r.trialBalance.ar, "50.00");
  // …but the OPEN ITEMS are invoice remaining 60 and an unapplied credit −10.
  assert.deepEqual(r.openBalances.c1, { ar: "50.00" });
  assert.equal(r.trialBalance.bank, "14.90"); // +40 − 25.10
  assert.equal(r.trialBalance.ap, undefined); // settled exactly
  assert.deepEqual(r.openBalances.v1, undefined);
  assert.deepEqual(r.openBalances.e1, { ap: "-12.34" });
  assert.equal(r.trialBalance.revenueService, "-90.00");
});

test("over-application and unbalanced journals are rejected", () => {
  const ledger = new ReferenceLedger(BASE);
  ledger.apply({
    id: "INV-1", kind: "customer_invoice", date: "2026-01-05", party: "c1",
    lines: [{ account: "revenueService", amount: "100.00" }],
  });
  assert.throws(
    () => ledger.apply({
      id: "PAY-1", kind: "customer_payment", date: "2026-01-06", party: "c1",
      allocations: [{ event: "INV-1", amount: "100.01" }],
    }),
    /over-application/,
  );
  assert.throws(
    () => ledger.apply({
      id: "JE-1", kind: "journal", date: "2026-01-07",
      lines: [{ account: "bank", amount: "1.00" }, { account: "office", amount: "-0.99" }],
    }),
    /does not balance/,
  );
  // Cross-party application must be refused.
  assert.throws(
    () => ledger.apply({
      id: "PAY-2", kind: "customer_payment", date: "2026-01-08", party: "c1",
      allocations: [{ event: "MISSING", amount: "1.00" }],
    }),
    /unknown event/,
  );
});

test("generator is deterministic and every corpus validates against the oracle", () => {
  const opts = { seed: "test-seed", startDate: "2026-01-01", endDate: "2026-02-28" };
  const a = generateCorpus(opts);
  const b = generateCorpus(opts);
  assert.deepEqual(a, b);

  const expected = computeExpected(a); // throws if any event is invalid
  assert.ok(a.events.length > 100, `expected substantial traffic, got ${a.events.length}`);
  assert.ok(Object.keys(expected.trialBalance).length >= 10);

  // The trial balance must foot to zero (checked inside result(); re-assert via sum).
  const net = Object.values(expected.trialBalance).reduce((acc, v) => acc + toCents(v), 0n);
  assert.equal(net, 0n);

  // A different seed must produce a different corpus.
  const c = generateCorpus({ ...opts, seed: "other-seed" });
  assert.notDeepEqual(a.events, c.events);
});
