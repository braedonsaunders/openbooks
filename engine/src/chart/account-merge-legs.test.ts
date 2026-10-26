import assert from "node:assert/strict";
import test from "node:test";
import { add, cmp, mulRate } from "../money/money.ts";
import {
  buildReclassEntries,
  mergeConsequenceDigest,
  transferRate,
  type BalanceGroup,
} from "./account-merge-legs.ts";

const SOURCE = "00000000-0000-4000-8000-00000000000a";
const TARGET = "00000000-0000-4000-8000-00000000000b";

function group(overrides: Partial<BalanceGroup> = {}): BalanceGroup {
  return {
    bookId: "book-1",
    subsidiaryId: "sub-1",
    functionalCurrency: "USD",
    currency: "USD",
    amount: "100.0000",
    txnAmount: "100.0000",
    departmentId: null,
    projectId: null,
    locationId: null,
    classId: null,
    partyId: null,
    equipmentUnitId: null,
    paymentCardId: null,
    extraDims: {},
    ...overrides,
  };
}

test("a functional-currency balance moves at rate one", () => {
  assert.deepEqual(transferRate(group()), { ok: true, fxRate: "1.0000000000" });
});

test("a foreign balance moves at its own historical rate, reproducing the functional amount", () => {
  const foreign = group({ currency: "EUR", amount: "123.4567", txnAmount: "100.0000" });
  const rate = transferRate(foreign);
  assert.equal(rate.ok, true);
  if (!rate.ok) return;
  assert.equal(rate.fxRate, "1.2345670000");
  // The ledger's jl_fx_consistent rule: |amount - round(txn x rate, 4)| <= 0.005.
  const reproduced = mulRate(foreign.txnAmount, rate.fxRate);
  assert.ok(cmp(reproduced, "123.4517") >= 0 && cmp(reproduced, "123.4617") <= 0);
});

test("credit balances keep a positive rate", () => {
  const rate = transferRate(group({ currency: "EUR", amount: "-55.0000", txnAmount: "-50.0000" }));
  assert.deepEqual(rate, { ok: true, fxRate: "1.1000000000" });
});

test("residues that no positive rate reproduces are refused, not fabricated", () => {
  // Opposite signs: a functional residue against a foreign balance of the other sign.
  assert.deepEqual(
    transferRate(group({ currency: "EUR", amount: "-7.0000", txnAmount: "10.0000" })),
    { ok: false, reason: "inconsistent_rate" },
  );
  // A functional residue with no foreign balance left (realised differences).
  assert.deepEqual(
    transferRate(group({ currency: "EUR", amount: "-10.0000", txnAmount: "0.0000" })),
    { ok: false, reason: "inconsistent_rate" },
  );
  // A foreign balance with no functional amount cannot post (lines are non-zero).
  assert.deepEqual(
    transferRate(group({ currency: "EUR", amount: "0.0000", txnAmount: "10.0000" })),
    { ok: false, reason: "zero_functional" },
  );
  // A functional-currency group whose transaction and functional amounts disagree.
  assert.deepEqual(transferRate(group({ amount: "10.0000", txnAmount: "9.0000" })), {
    ok: false,
    reason: "inconsistent_rate",
  });
});

test("reclass entries balance per entry, per subsidiary and per dimension, and zero the source", () => {
  const groups = [
    {
      ...group({ departmentId: "dept-a", amount: "100.0000", txnAmount: "100.0000" }),
      fxRate: "1.0000000000",
    },
    {
      ...group({ departmentId: "dept-b", amount: "-40.0000", txnAmount: "-40.0000" }),
      fxRate: "1.0000000000",
    },
    {
      ...group({
        subsidiaryId: "sub-2",
        currency: "EUR",
        functionalCurrency: "EUR",
        amount: "12.5000",
        txnAmount: "12.5000",
      }),
      fxRate: "1.0000000000",
    },
    { ...group({ bookId: "book-2", extraDims: { fund: "fund-1" } }), fxRate: "1.0000000000" },
  ];
  const entries = buildReclassEntries(groups, SOURCE, TARGET);
  assert.deepEqual(
    entries.map((entry) => `${entry.bookId}|${entry.subsidiaryId}`),
    ["book-1|sub-1", "book-1|sub-2", "book-2|sub-1"],
  );
  for (const entry of entries) {
    assert.equal(
      cmp(
        entry.lines.reduce((total, line) => add(total, line.amount), "0"),
        "0",
      ),
      0,
      "entry balances",
    );
    assert.ok(entry.lines.every((line) => line.subsidiaryId === entry.subsidiaryId));
    const sourceLines = entry.lines.filter((line) => line.accountId === SOURCE);
    const targetLines = entry.lines.filter((line) => line.accountId === TARGET);
    assert.equal(sourceLines.length, targetLines.length);
    sourceLines.forEach((line, index) => {
      const mirror = targetLines[index]!;
      assert.equal(cmp(add(line.amount, mirror.amount), "0"), 0);
      assert.equal(cmp(add(line.txnAmount, mirror.txnAmount), "0"), 0);
      assert.equal(line.departmentId, mirror.departmentId);
      assert.deepEqual(line.extraDims, mirror.extraDims);
      assert.equal(line.currency, mirror.currency);
      assert.equal(line.fxRate, mirror.fxRate);
    });
  }
  // Every grouped source balance is credited exactly: the source ends at zero.
  const sourceTotal = entries
    .flatMap((entry) => entry.lines)
    .filter((line) => line.accountId === SOURCE)
    .reduce((total, line) => add(total, line.amount), "0");
  const grouped = groups.reduce((total, row) => add(total, row.amount), "0");
  assert.equal(cmp(add(sourceTotal, grouped), "0"), 0);
});

test("reclass entries are deterministic regardless of input order", () => {
  const groups = [
    { ...group({ departmentId: "dept-b" }), fxRate: "1.0000000000" },
    { ...group({ departmentId: "dept-a" }), fxRate: "1.0000000000" },
  ];
  assert.deepEqual(
    buildReclassEntries(groups, SOURCE, TARGET),
    buildReclassEntries([...groups].reverse(), SOURCE, TARGET),
  );
});

test("the consequence digest is stable and changes with any consequence", () => {
  const base = {
    sourceAccountId: SOURCE,
    targetAccountId: TARGET,
    effectiveDate: "2026-07-31",
    references: [{ key: "items.expense_account_id", redirect: 2 }],
  };
  assert.equal(mergeConsequenceDigest(base), mergeConsequenceDigest({ ...base }));
  assert.match(mergeConsequenceDigest(base), /^[0-9a-f]{64}$/);
  assert.notEqual(
    mergeConsequenceDigest(base),
    mergeConsequenceDigest({ ...base, effectiveDate: "2026-08-01" }),
  );
  assert.notEqual(
    mergeConsequenceDigest(base),
    mergeConsequenceDigest({
      ...base,
      references: [{ key: "items.expense_account_id", redirect: 3 }],
    }),
  );
});
