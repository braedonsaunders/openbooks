/**
 * Settlement-allocation money math (D15).
 *
 * allocatePairApplications is the kernel's per-pair settlement allocator:
 * every row it emits becomes an `applications` insert, and every remaining
 * it fails to decrement over-settles the same line twice. These tests assert
 * exact rows, exact post-call remainings, and exact unallocated cents —
 * including the multi-line and multi-cap cases where a dropped accumulator
 * hides. groupSettlementRows / settlementGroupAdjustment and
 * allocateFxEntryNumber are covered for the same reason: they decide the
 * realized-FX evidence entries.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateFxEntryNumber,
  allocatePairApplications,
  groupSettlementRows,
  settlementGroupAdjustment,
  type AllocatableLine,
  type PendingApplication,
} from "./applications";
import { fromUnits, toUnits } from "../money/money";

let seq = 0;

type LineSpec = Omit<Partial<AllocatableLine>, "remaining" | "remainingTransaction"> & {
  remaining?: string;
  remainingTransaction?: string;
};

function line(over?: LineSpec): AllocatableLine {
  seq += 1;
  return {
    lineId: `line-${seq}`,
    date: "2026-07-15",
    accountId: "acct-ap",
    partyId: "party-1",
    subsidiaryId: "sub-1",
    currency: "CAD",
    sign: "1",
    fxRate: "1",
    functionalCurrency: "CAD",
    bookId: "book-1",
    periodId: "period-1",
    documentId: "doc-1",
    ...over,
    remaining: toUnits(over?.remaining ?? "0.00"),
    remainingTransaction: toUnits(over?.remainingTransaction ?? "0.00"),
  };
}

const units = (l: AllocatableLine, field: "remaining" | "remainingTransaction"): string =>
  fromUnits(l[field]);

test("a same-currency pair settles exactly with zero FX drift", () => {
  const pay = line({ sign: "1", remaining: "100.00", remainingTransaction: "100.00" });
  const app = line({ sign: "-1", remaining: "100.00", remainingTransaction: "100.00" });
  const out = allocatePairApplications("PAY-1", [pay], [app], toUnits("100.00"), 0n);
  assert.equal(out.alreadySettled, false);
  assert.equal(out.rows.length, 1);
  const row = out.rows[0]!;
  assert.equal(fromUnits(row.amount), "100.0000");
  assert.equal(fromUnits(row.sourceAmount), "100.0000");
  assert.equal(fromUnits(row.sourceTransactionAmount), "100.0000");
  assert.equal(fromUnits(row.targetTransactionAmount), "100.0000");
  assert.equal(row.fxAdjustment, 0n);
  assert.equal(row.fromLineId, pay.lineId);
  assert.equal(row.toLineId, app.lineId);
  assert.equal(row.paymentRef, "PAY-1");
  assert.equal(out.unallocated, 0n);
  assert.equal(units(pay, "remaining"), "0.0000");
  assert.equal(units(app, "remaining"), "0.0000");
});

test("allocation spreads across compatible lines and spends every capacity", () => {
  const pay = line({ sign: "1", remaining: "100.00", remainingTransaction: "100.00" });
  const app1 = line({ sign: "-1", remaining: "60.00", remainingTransaction: "60.00" });
  const app2 = line({ sign: "-1", remaining: "60.00", remainingTransaction: "60.00" });
  const out = allocatePairApplications("PAY-1", [pay], [app1, app2], toUnits("100.00"), 0n);
  assert.deepEqual(out.rows.map((r) => fromUnits(r.amount)), ["60.0000", "40.0000"]);
  assert.equal(out.unallocated, 0n);
  // Every capacity is spent exactly: a dropped remaining decrement would
  // leave one of these positive (or over-allocate the rows above).
  assert.equal(units(pay, "remaining"), "0.0000");
  assert.equal(units(pay, "remainingTransaction"), "0.0000");
  assert.equal(units(app1, "remaining"), "0.0000");
  assert.equal(units(app1, "remainingTransaction"), "0.0000");
  assert.equal(units(app2, "remaining"), "20.0000");
  assert.equal(units(app2, "remainingTransaction"), "20.0000");
});

test("capacity beyond the applied lines lands in unallocated, never forced", () => {
  const pay = line({ sign: "1", remaining: "100.00", remainingTransaction: "100.00" });
  const app = line({ sign: "-1", remaining: "60.00", remainingTransaction: "60.00" });
  const out = allocatePairApplications("PAY-1", [pay], [app], toUnits("100.00"), 0n);
  assert.deepEqual(out.rows.map((r) => fromUnits(r.amount)), ["60.0000"]);
  assert.equal(fromUnits(out.unallocated), "40.0000");
});

test("an already-settled pair reports settled with no rows", () => {
  const pay = line({ sign: "1", remaining: "100.00", remainingTransaction: "100.00" });
  const app = line({ sign: "-1", remaining: "100.00", remainingTransaction: "100.00" });
  for (const have of [toUnits("100.00"), toUnits("140.00")]) {
    const out = allocatePairApplications("PAY-1", [pay], [app], toUnits("100.00"), have);
    assert.equal(out.alreadySettled, true);
    assert.deepEqual(out.rows, []);
    assert.equal(out.unallocated, 0n);
  }
  assert.equal(units(pay, "remaining"), "100.0000", "a settled pair touches nothing");
});

test("a prior partial application reduces the want first", () => {
  const pay = line({ sign: "1", remaining: "100.00", remainingTransaction: "100.00" });
  const app = line({ sign: "-1", remaining: "100.00", remainingTransaction: "100.00" });
  const out = allocatePairApplications("PAY-1", [pay], [app], toUnits("100.00"), toUnits("30.00"));
  assert.deepEqual(out.rows.map((r) => fromUnits(r.amount)), ["70.0000"]);
  assert.equal(out.unallocated, 0n);
});

test("incompatible lines never settle", () => {
  const pay = line({ sign: "1", remaining: "100.00", remainingTransaction: "100.00" });
  const variants: LineSpec[] = [
    { accountId: "acct-other" },
    { partyId: "party-2" },
    { partyId: null },
    { subsidiaryId: "sub-2" },
    { currency: "USD" },
    { sign: "1" },
    { remaining: "0.00", remainingTransaction: "100.00" },
    { remaining: "100.00", remainingTransaction: "0.00" },
  ];
  for (const variant of variants) {
    const app = line({ sign: "-1", remaining: "100.00", remainingTransaction: "100.00", ...variant });
    const out = allocatePairApplications("PAY-1", [pay], [app], toUnits("100.00"), 0n);
    assert.deepEqual(out.rows, [], `variant settles: ${JSON.stringify(variant)}`);
    assert.equal(out.unallocated, toUnits("100.00"));
  }
  // The same physical line never settles against itself, even when every
  // other dimension is compatible.
  const self = line({ sign: "-1", remaining: "100.00", remainingTransaction: "100.00" });
  self.lineId = pay.lineId;
  const selfOut = allocatePairApplications("PAY-1", [pay], [self], toUnits("100.00"), 0n);
  assert.deepEqual(selfOut.rows, []);
  assert.equal(selfOut.unallocated, toUnits("100.00"));
});

test("the transaction cap binds before the functional cap", () => {
  const pay = line({
    sign: "1", currency: "USD", fxRate: "1.36",
    remaining: "136.00", remainingTransaction: "100.00",
  });
  const app = line({
    sign: "-1", currency: "USD", fxRate: "1.36",
    remaining: "68.00", remainingTransaction: "50.00",
  });
  const out = allocatePairApplications("PAY-1", [pay], [app], toUnits("136.00"), 0n);
  assert.equal(out.rows.length, 1);
  assert.equal(fromUnits(out.rows[0]!.sourceTransactionAmount), "50.0000");
  assert.equal(fromUnits(out.rows[0]!.sourceAmount), "68.0000");
  assert.equal(fromUnits(out.unallocated), "68.0000");
  assert.equal(units(app, "remainingTransaction"), "0.0000");
});

test("a shared applied line cannot spend its transaction capacity twice", () => {
  const pay1 = line({ sign: "1", remaining: "60.00", remainingTransaction: "60.00" });
  const pay2 = line({ sign: "1", remaining: "60.00", remainingTransaction: "60.00" });
  const app = line({ sign: "-1", remaining: "100.00", remainingTransaction: "50.00" });
  const out = allocatePairApplications("PAY-1", [pay1, pay2], [app], toUnits("100.00"), 0n);
  // The applied line's 50.00 of transaction capacity settles once: the first
  // payment takes all of it, and the second finds nothing left.
  assert.deepEqual(out.rows.map((r) => fromUnits(r.targetTransactionAmount)), ["50.0000"]);
  assert.equal(fromUnits(out.unallocated), "50.0000");
  assert.equal(units(app, "remainingTransaction"), "0.0000");
});

test("a dust remainder that cannot price a transaction allocates nothing", () => {
  // 0.0001 of functional want at a 1000000 rate prices zero transaction
  // units, so the allocator must break with no rows — not emit a zero-amount
  // row.
  const pay = line({ sign: "1", fxRate: "1000000", remaining: "100.00", remainingTransaction: "100.00" });
  const app = line({ sign: "-1", remaining: "100.00", remainingTransaction: "100.00" });
  const out = allocatePairApplications("PAY-1", [pay], [app], toUnits("0.0001"), 0n);
  assert.deepEqual(out.rows, []);
  assert.equal(fromUnits(out.unallocated), "0.0001");
});

test("flipped debit/credit signs still net zero drift at one rate", () => {
  const pay = line({ sign: "-1", remaining: "100.00", remainingTransaction: "100.00" });
  const app = line({ sign: "1", remaining: "100.00", remainingTransaction: "100.00" });
  const out = allocatePairApplications("PAY-1", [pay], [app], toUnits("100.00"), 0n);
  assert.equal(out.rows.length, 1);
  assert.equal(fromUnits(out.rows[0]!.amount), "100.0000");
  assert.equal(out.rows[0]!.fxAdjustment, 0n);
});

test("evidence rows group by control dimension, never across parties", () => {
  const row = (over: Partial<PendingApplication>): PendingApplication => ({
    fromLineId: "f", toLineId: "t", amount: 0n, sourceAmount: 0n,
    sourceTransactionAmount: 0n, targetTransactionAmount: 0n, date: "2026-07-15",
    currency: "CAD", fxGainLossEntryId: null, fxAdjustment: 0n, paymentRef: "PAY-1",
    sourceDocumentId: "doc-1", bookId: "book-1", periodId: "period-1",
    subsidiaryId: "sub-1", accountId: "acct-ap", partyId: "party-1",
    functionalCurrency: "CAD", ...over,
  });
  const groups = groupSettlementRows([
    row({ toLineId: "t1" }),
    row({ toLineId: "t2", partyId: "party-2" }),
    row({ toLineId: "t3", partyId: null }),
    row({ toLineId: "t4", partyId: "" }),
    row({ toLineId: "t5", subsidiaryId: "sub-2" }),
  ]);
  // party-1 | party-2 | (null and "" normalize together) | party-1/sub-2.
  assert.equal(groups.size, 4);
  assert.deepEqual(
    [...groups.values()].map((g) => g.map((r) => r.toLineId).sort()),
    [["t1"], ["t2"], ["t3", "t4"], ["t5"]],
  );
});

test("a group's FX drift nets exactly, and an empty group drifts nothing", () => {
  const row = (fxAdjustment: bigint): PendingApplication => ({
    fromLineId: "f", toLineId: "t", amount: 0n, sourceAmount: 0n,
    sourceTransactionAmount: 0n, targetTransactionAmount: 0n, date: "2026-07-15",
    currency: "CAD", fxGainLossEntryId: null, fxAdjustment, paymentRef: "PAY-1",
    sourceDocumentId: "doc-1", bookId: "book-1", periodId: "period-1",
    subsidiaryId: "sub-1", accountId: "acct-ap", partyId: "party-1",
    functionalCurrency: "CAD",
  });
  assert.equal(settlementGroupAdjustment([row(1000n), row(-300n)]), 700n);
  assert.equal(settlementGroupAdjustment([]), 0n);
});

function stubClient(taken: Set<string>): {
  query: (text: string, params?: unknown[]) => Promise<{ rows: { one: number }[] }>;
} {
  return {
    query: async (_text: string, params?: unknown[]) => {
      const entryNumber = params?.[1];
      return { rows: typeof entryNumber === "string" && taken.has(entryNumber) ? [{ one: 1 }] : [] };
    },
  };
}

test("FX evidence numbering prefers the bare name and steps past collisions", async () => {
  assert.equal(await allocateFxEntryNumber(stubClient(new Set()), "org-1", "DOC-FX"), "DOC-FX");
  assert.equal(
    await allocateFxEntryNumber(stubClient(new Set(["DOC-FX"])), "org-1", "DOC-FX"),
    "DOC-FX-2",
  );
  assert.equal(
    await allocateFxEntryNumber(stubClient(new Set(["DOC-FX", "DOC-FX-2", "DOC-FX-3"])), "org-1", "DOC-FX"),
    "DOC-FX-4",
  );
});

test("FX evidence numbering refuses when every generation is taken", async () => {
  const taken = new Set<string>();
  for (let generation = 1; generation <= 200; generation += 1) {
    taken.add(generation === 1 ? "DOC-FX" : `DOC-FX-${generation}`);
  }
  await assert.rejects(
    allocateFxEntryNumber(stubClient(taken), "org-1", "DOC-FX"),
    /could not allocate a realized-FX entry number/,
  );
});
