import assert from "node:assert/strict";
import test from "node:test";
import { mulRate, toUnits } from "../money/money.ts";
import {
  allocatePairNetting,
  carryingForSettlement,
  carryingRateLines,
  NettingMathError,
  spotTranslation,
  type NettingComponent,
} from "./netting-math.ts";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const PAIR = "00000000-0000-4000-8000-0000000000aa";

function item(
  key: string,
  subsidiaryId: string,
  openTransaction: string,
  overrides: Partial<NettingComponent> = {},
): NettingComponent {
  return {
    key,
    pairId: PAIR,
    subsidiaryId,
    counterpartySubsidiaryId: subsidiaryId === A ? B : A,
    currency: "USD",
    functionalCurrency: "USD",
    component: "open_item",
    accountId: `acct-${subsidiaryId}`,
    journalLineId: key,
    documentId: null,
    partyId: null,
    openTransaction,
    openCarrying: openTransaction,
    sortKey: "2026-01-01|2026-01-01",
    ...overrides,
  };
}

const par = () => "1";

test("each entity nets what it is owed against what it owes, and both sides agree", () => {
  const result = allocatePairNetting({
    pairId: PAIR,
    currency: "USD",
    fromSubsidiaryId: A,
    toSubsidiaryId: B,
    settleCash: false,
    rateFor: par,
    components: [
      item("a-ar", A, "100.0000"),
      item("a-ap", A, "-60.0000"),
      item("b-ap", B, "-100.0000"),
      item("b-ar", B, "60.0000"),
    ],
  });
  assert.equal(result.fromNet, "40.0000");
  assert.equal(result.toNet, "-40.0000");
  assert.equal(result.unreconciled, "0.0000");
  assert.equal(result.fromNetted, "60.0000");
  assert.equal(result.toNetted, "60.0000");
  assert.equal(result.cashToFrom, "0.0000");
  const byKey = new Map(result.allocations.map((a) => [a.key, a]));
  assert.equal(byKey.get("a-ar")!.netted, "60.0000");
  assert.equal(byKey.get("a-ap")!.netted, "-60.0000");
  assert.equal(byKey.get("b-ap")!.netted, "-60.0000");
  assert.equal(byKey.get("b-ar")!.netted, "60.0000");
  // Inside each entity the netting is balanced: cleared amounts sum to zero.
  for (const subsidiaryId of [A, B]) {
    const total = result.allocations
      .filter((a) => a.subsidiaryId === subsidiaryId)
      .reduce((sum, a) => sum + toUnits(a.netted), 0n);
    assert.equal(total, 0n);
  }
});

test("cash settles the remaining net position oldest first and never more than either entity's books show", () => {
  const result = allocatePairNetting({
    pairId: PAIR,
    currency: "USD",
    fromSubsidiaryId: A,
    toSubsidiaryId: B,
    settleCash: true,
    rateFor: par,
    components: [
      item("a-new", A, "70.0000", { sortKey: "2026-03-01|2026-03-01" }),
      item("a-old", A, "30.0000", { sortKey: "2026-01-01|2026-01-01" }),
      item("b-only", B, "-90.0000"),
    ],
  });
  // B has recorded only 90 of A's 100: cash moves 90 and 10 stays open.
  assert.equal(result.cashToFrom, "90.0000");
  assert.equal(result.unreconciled, "10.0000");
  const byKey = new Map(result.allocations.map((a) => [a.key, a]));
  assert.equal(byKey.get("a-old")!.cash, "30.0000");
  assert.equal(byKey.get("a-new")!.cash, "60.0000");
  assert.equal(byKey.get("b-only")!.cash, "-90.0000");
});

test("no cash moves when the entities disagree about who owes whom", () => {
  const result = allocatePairNetting({
    pairId: PAIR,
    currency: "USD",
    fromSubsidiaryId: A,
    toSubsidiaryId: B,
    settleCash: true,
    rateFor: par,
    components: [item("a", A, "50.0000"), item("b", B, "20.0000")],
  });
  assert.equal(result.cashToFrom, "0.0000");
  assert.equal(result.unreconciled, "70.0000");
  assert.ok(result.allocations.every((a) => toUnits(a.cash) === 0n && toUnits(a.netted) === 0n));
});

test("open items settle before the running due-to/due-from position", () => {
  const result = allocatePairNetting({
    pairId: PAIR,
    currency: "USD",
    fromSubsidiaryId: A,
    toSubsidiaryId: B,
    settleCash: false,
    rateFor: par,
    components: [
      item("a-position", A, "-50.0000", {
        component: "due_position",
        journalLineId: null,
        sortKey: "~",
      }),
      item("a-bill", A, "-50.0000"),
      item("a-invoice", A, "50.0000"),
    ],
  });
  const byKey = new Map(result.allocations.map((a) => [a.key, a]));
  assert.equal(byKey.get("a-bill")!.netted, "-50.0000");
  assert.equal(byKey.get("a-position")!.netted, "0.0000");
});

test("a foreign-currency settlement realizes the difference between spot and carrying value", () => {
  const result = allocatePairNetting({
    pairId: PAIR,
    currency: "EUR",
    fromSubsidiaryId: A,
    toSubsidiaryId: B,
    settleCash: true,
    rateFor: (subsidiaryId) => (subsidiaryId === A ? "1.2000000000" : "1"),
    components: [
      item("a-ar", A, "100.0000", {
        currency: "EUR",
        functionalCurrency: "USD",
        openCarrying: "110.0000",
      }),
      item("b-ap", B, "-100.0000", {
        currency: "EUR",
        functionalCurrency: "EUR",
        openCarrying: "-100.0000",
      }),
    ],
  });
  const byKey = new Map(result.allocations.map((a) => [a.key, a]));
  const receivable = byKey.get("a-ar")!;
  assert.equal(receivable.cash, "100.0000");
  assert.equal(receivable.spotCleared, "120.0000");
  assert.equal(receivable.carryingCleared, "110.0000");
  assert.equal(receivable.realizedFx, "10.0000");
  assert.equal(byKey.get("b-ap")!.realizedFx, "0.0000");
});

test("a partial settlement releases carrying value in proportion and a full one releases all of it", () => {
  assert.equal(carryingForSettlement("100.0000", "30.0000", "10.0000"), "33.3333");
  assert.equal(carryingForSettlement("100.0000", "30.0000", "30.0000"), "100.0000");
  assert.equal(carryingForSettlement("-100.0000", "-30.0000", "-30.0000"), "-100.0000");
  assert.throws(() => carryingForSettlement("100.0000", "30.0000", "31.0000"), NettingMathError);
});

test("a component whose carrying value has the opposite sign is refused, not settled", () => {
  assert.throws(
    () =>
      allocatePairNetting({
        pairId: PAIR,
        currency: "USD",
        fromSubsidiaryId: A,
        toSubsidiaryId: B,
        settleCash: false,
        rateFor: par,
        components: [item("bad", A, "10.0000", { openCarrying: "-10.0000" })],
      }),
    /opposite sign/,
  );
});

test("spot translation is symmetric in sign", () => {
  assert.equal(spotTranslation("10.0005", "1.5000000000"), "15.0008");
  assert.equal(spotTranslation("-10.0005", "1.5000000000"), "-15.0008");
});

test("carrying-rate lines reproduce any carrying value exactly at ledger precision", () => {
  let seed = 7n;
  const next = () => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 63n);
    return seed;
  };
  for (let i = 0; i < 400; i += 1) {
    const txnUnits = (next() % 10_000_000_000_000n) + 1n; // up to 1e9 currency units
    const rateMilli = (next() % 3000n) + 1n; // 0.001 .. 3.000
    const carryingUnits = (txnUnits * rateMilli) / 1000n + (next() % 7n);
    if (carryingUnits <= 0n) continue;
    const sign = i % 2 === 0 ? 1n : -1n;
    const txn = formatUnits(sign * txnUnits);
    const carrying = formatUnits(sign * carryingUnits);
    const lines = carryingRateLines(txn, carrying);
    assert.ok(lines.length >= 1 && lines.length <= 2);
    let txnSum = 0n;
    let amountSum = 0n;
    for (const line of lines) {
      // A positive rate at the ledger's ten-decimal scale.
      assert.match(line.fxRate, /^\d{1,9}\.\d{10}$/);
      assert.ok(/[1-9]/.test(line.fxRate));
      // The stored functional amount is exactly the rounded product.
      const magnitude = mulRate(line.txnAmount.replace("-", ""), line.fxRate);
      assert.equal(line.amount.replace("-", ""), magnitude);
      txnSum += toUnits(line.txnAmount);
      amountSum += toUnits(line.amount);
    }
    assert.equal(txnSum, toUnits(txn));
    assert.equal(amountSum, toUnits(carrying));
  }
});

test("carrying-rate lines refuse values that cannot be represented", () => {
  assert.throws(() => carryingRateLines("10.0000", "0.0000"), NettingMathError);
  assert.throws(() => carryingRateLines("10.0000", "-5.0000"), NettingMathError);
  assert.throws(() => carryingRateLines("0.0000", "5.0000"), NettingMathError);
});

function formatUnits(units: bigint): string {
  const negative = units < 0n;
  const magnitude = negative ? -units : units;
  return `${negative ? "-" : ""}${magnitude / 10_000n}.${(magnitude % 10_000n).toString().padStart(4, "0")}`;
}

for (const [title, components, from, to, refusal] of [
  [
    "duplicate component identities cannot clear an open item twice",
    [item("same", A, "100"), item("same", A, "100"), item("payable", B, "-200")],
    A,
    B,
    /only once/,
  ],
  [
    "a netting component cannot name an unrelated counterparty",
    [item("receivable", A, "100", { counterpartySubsidiaryId: "another-entity" })],
    A,
    B,
    /other entity/,
  ],
  ["an entity cannot net against itself", [], A, A, /different entities/],
] as const) {
  test(title, () => {
    assert.throws(
      () =>
        allocatePairNetting({
          pairId: PAIR,
          currency: "USD",
          fromSubsidiaryId: from,
          toSubsidiaryId: to,
          components: [...components],
          settleCash: true,
          rateFor: par,
        }),
      refusal,
    );
  });
}
