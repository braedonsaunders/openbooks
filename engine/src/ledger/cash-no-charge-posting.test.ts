import assert from "node:assert/strict";
import test from "node:test";
import { isMeasurementLeg, retainedKernelLines } from "../journal/posting-invariants.ts";
import {
  PostingError,
  type CashPostingTender,
  type PostingDeps,
  type PostingDocument,
  type PostingDocumentLine,
} from "../journal/posting-contracts.ts";
import { assertCashTendersPresent } from "../sales/cash-tenders.ts";
import type { Money } from "../money/brands.ts";
import { RULES } from "./posting-rules.ts";

const doc = (kind: "cash_sale" | "cash_refund") =>
  ({
    id: "doc",
    kind,
    documentNumber: kind === "cash_sale" ? "CS-1" : "CR-1",
    partyId: "customer",
    subsidiaryId: "sub",
    currency: "CAD",
    fxRate: "1",
    custom: {},
  }) as unknown as PostingDocument;

const line = (lineNumber: number, amount: string, quantity: string, unit: string | null = "ea") =>
  ({
    id: `line-${lineNumber}`,
    lineNumber,
    accountId: "income",
    amount,
    taxAmount: "0",
    quantity,
    unit,
    description: `Item ${lineNumber}`,
  }) as unknown as PostingDocumentLine;

const deps = (tenders: CashPostingTender[], extra: Partial<PostingDeps> = {}): PostingDeps => ({
  control: { ar: "ar", ap: "ap", bank: "bank" },
  cashTenders: tenders,
  cashCloseout: null,
  noChargeUnitsAccountId: "units",
  ...extra,
});

const cashTender = (amount: string): CashPostingTender =>
  ({
    kind: "cash",
    methodLabel: "Cash",
    accountId: "till",
    amount: amount as Money,
    reference: null,
  }) as CashPostingTender;

test("an empty tender set is allowed only when nothing is due", () => {
  assert.doesNotThrow(() => assertCashTendersPresent([], "0.0000", "CS-1", "cash sale"));
  assert.throws(
    () => assertCashTendersPresent([], "0.0100", "CS-1", "cash sale"),
    (error: unknown) => error instanceof PostingError && /has no tenders/.test(error.message),
  );
  assert.doesNotThrow(() =>
    assertCashTendersPresent([cashTender("5.0000")], "5.0000", "CS-1", "cash sale"),
  );
});

test("a sale comped in full posts its quantities as zero-money measurements on the statistical no-charge account", () => {
  const legs = RULES.cash_sale!(
    doc("cash_sale"),
    [line(1, "0.0000", "2.00000000"), line(2, "0.0000", "1.5", null)],
    deps([]),
  );
  assert.deepEqual(
    legs.map((leg) => [leg.accountId, leg.amount, leg.quantity, leg.unit, leg.isOpenItem ?? false]),
    [
      ["units", "0.0000", "2", "ea", false],
      ["units", "0.0000", "1.5", "unit", false],
    ],
  );
  assert.equal(retainedKernelLines(legs, false).length, 2);
});

test("the refund of a no-charge sale records the returned quantity negatively", () => {
  const legs = RULES.cash_refund!(doc("cash_refund"), [line(1, "0.0000", "2")], deps([]));
  assert.deepEqual(
    legs.map((leg) => [leg.amount, leg.quantity]),
    [["0.0000", "-2"]],
  );
  // One measurement is a complete entry on its own.
  assert.equal(retainedKernelLines(legs, false).length, 1);
});

test("a comped sale with no No-charge units account configured is refused with the Setup remedy", () => {
  assert.throws(
    () =>
      RULES.cash_sale!(
        doc("cash_sale"),
        [line(1, "0.0000", "1")],
        deps([], { noChargeUnitsAccountId: null }),
      ),
    (error: unknown) =>
      error instanceof PostingError && /No-charge units account in Setup/.test(error.message),
  );
});

test("offsetting lines with nothing to tender post as they are", () => {
  const legs = RULES.cash_sale!(
    doc("cash_sale"),
    [
      line(1, "10.0000", "1"),
      { ...line(2, "-10.0000", "1"), accountId: "discount" } as PostingDocumentLine,
    ],
    deps([]),
  );
  assert.deepEqual(
    retainedKernelLines(legs, false).map((leg) => [
      leg.accountId,
      leg.amount,
      leg.quantity ?? null,
    ]),
    [
      ["income", "-10.0000", null],
      ["discount", "10.0000", null],
    ],
  );
});

test("a sale with an amount due and no tenders is still refused", () => {
  assert.throws(
    () => RULES.cash_sale!(doc("cash_sale"), [line(1, "5.0000", "1")], deps([])),
    (error: unknown) => error instanceof PostingError && /has no tenders/.test(error.message),
  );
  assert.throws(
    () => RULES.cash_refund!(doc("cash_refund"), [line(1, "5.0000", "1")], deps([])),
    (error: unknown) => error instanceof PostingError && /has no tenders/.test(error.message),
  );
});

test("a zero-total sale that names a tender is refused by the cross-foot", () => {
  assert.throws(
    () =>
      RULES.cash_sale!(doc("cash_sale"), [line(1, "0.0000", "1")], deps([cashTender("5.0000")])),
    (error: unknown) =>
      error instanceof PostingError && /tenders must sum to the document total/.test(error.message),
  );
});

test("a zero-total close-out that still collects tips needs its tenders", () => {
  assert.throws(
    () =>
      RULES.cash_sale!(
        doc("cash_sale"),
        [line(1, "0.0000", "1")],
        deps([], {
          cashCloseout: {
            tipsTotal: "3.0000",
            feeTotal: "0.0000",
            overShort: "0.0000",
            tipsPayableAccountId: "tips",
            processorFeeAccountId: null,
            cashOverShortAccountId: null,
            serverPartyId: null,
          } as PostingDeps["cashCloseout"],
        }),
      ),
    (error: unknown) => error instanceof PostingError && /has no tenders/.test(error.message),
  );
});

test("a no-charge line with a quantity beyond four decimal places is refused rather than rounded", () => {
  assert.throws(
    () => RULES.cash_sale!(doc("cash_sale"), [line(1, "0.0000", "1.12345678")], deps([])),
    (error: unknown) =>
      error instanceof PostingError && /at most four decimal places/.test(error.message),
  );
});

test("a no-charge document with no quantity at all records nothing and is refused", () => {
  assert.throws(
    () => RULES.cash_sale!(doc("cash_sale"), [line(1, "0.0000", "0")], deps([])),
    (error: unknown) => error instanceof PostingError && /records no quantity/.test(error.message),
  );
});

test("only measurements survive as single zero-money legs", () => {
  assert.equal(isMeasurementLeg({ amount: "0.0000", quantity: "2", unit: "ea" }), true);
  assert.equal(isMeasurementLeg({ amount: "0.0000", quantity: "2", unit: " " }), false);
  assert.equal(isMeasurementLeg({ amount: "0.0000", quantity: "0", unit: "ea" }), false);
  assert.equal(isMeasurementLeg({ amount: "1.0000", quantity: "2", unit: "ea" }), false);
  assert.throws(
    () => retainedKernelLines([{ amount: "0.0000" }, { amount: "0.0000" }], false),
    (error: unknown) => error instanceof PostingError && /fewer than 2 lines/.test(error.message),
  );
  assert.throws(() => retainedKernelLines([{ amount: "5.0000" }], false), /fewer than 2 lines/);
  assert.equal(retainedKernelLines([{ amount: "0.0000", quantity: "3" }], true).length, 1);
});
