import assert from "node:assert/strict";
import { test } from "node:test";
import { toUnits } from "../money/money.ts";
import {
  BookTranslationError,
  rateKey,
  translateLinesIntoBook,
  type BookSubsidiaryBasis,
  type TranslatableLine,
} from "./book-translation.ts";

const US = "00000000-0000-4000-8000-000000000001";
const UK = "00000000-0000-4000-8000-000000000002";
const DIFF = "00000000-0000-4000-8000-0000000000dd";

const bases = new Map<string, BookSubsidiaryBasis>([
  [US, { subsidiaryId: US, functionalCurrency: "USD", bookCurrency: "EUR", rateType: "spot" }],
  [UK, { subsidiaryId: UK, functionalCurrency: "GBP", bookCurrency: "GBP", rateType: "spot" }],
]);

function line(
  accountId: string,
  subsidiaryId: string,
  amount: string,
  currency: string,
  txnAmount = amount,
  fxRate = "1",
  extra: Partial<TranslatableLine> = {},
): TranslatableLine {
  return { accountId, subsidiaryId, amount, currency, txnAmount, fxRate, ...extra };
}

const differenceLine = ({
  subsidiaryId,
  bookCurrency,
  amount,
}: {
  subsidiaryId: string;
  bookCurrency: string;
  amount: string;
}): TranslatableLine => line(DIFF, subsidiaryId, amount, bookCurrency, amount, "1");

const context = { bookLabel: "GAAP", entryLabel: "journal entry JE-1" };

function total(lines: readonly TranslatableLine[], subsidiaryId: string): bigint {
  return lines
    .filter((l) => l.subsidiaryId === subsidiaryId)
    .reduce((sum, l) => sum + toUnits(l.amount), 0n);
}

test("a subsidiary the book carries in its functional currency passes through unchanged", () => {
  const lines = [line("cash", UK, "100.0000", "GBP"), line("revenue", UK, "-100.0000", "GBP")];
  const out = translateLinesIntoBook(lines, bases, new Map(), differenceLine, context);
  assert.deepEqual(out.lines, lines);
  assert.deepEqual(out.absorbed, []);
  assert.deepEqual(out.differences, []);
});

test("functional lines translate at the book rate and keep their transaction currency", () => {
  const rates = new Map([[rateKey(US, "USD"), "0.9200000000"]]);
  const out = translateLinesIntoBook(
    [line("cash", US, "250.0000", "USD"), line("revenue", US, "-250.0000", "USD")],
    bases,
    rates,
    differenceLine,
    context,
  );
  assert.deepEqual(
    out.lines.map((l) => [l.amount, l.currency, l.txnAmount, l.fxRate]),
    [
      ["230.0000", "USD", "250.0000", "0.9200000000"],
      ["-230.0000", "USD", "-250.0000", "0.9200000000"],
    ],
  );
  assert.equal(total(out.lines, US), 0n);
});

test("per-line rounding of a single-currency posting is absorbed onto its largest ordinary line", () => {
  // Three thirds of 100.0000 at 0.333335 each round up by a fraction of a unit.
  const rates = new Map([[rateKey(US, "USD"), "0.3333350000"]]);
  const lines = [
    line("expense-a", US, "33.3333", "USD"),
    line("expense-b", US, "33.3333", "USD"),
    line("expense-c", US, "33.3334", "USD"),
    line("ap", US, "-100.0000", "USD", "-100.0000", "1", { isOpenItem: true }),
  ];
  const out = translateLinesIntoBook(lines, bases, rates, differenceLine, context);
  assert.equal(total(out.lines, US), 0n, "the translated subsidiary must balance");
  assert.equal(out.differences.length, 0, "rounding never posts to the difference account");
  assert.equal(out.absorbed.length, 1);
  // The open-item leg keeps its exact translated amount.
  assert.equal(out.lines.find((l) => l.accountId === "ap")!.amount, "-33.3335");
});

test("a mixed-currency posting posts its genuine currency difference to the difference account", () => {
  const rates = new Map([
    [rateKey(US, "USD"), "0.9000000000"],
    [rateKey(US, "GBP"), "1.2000000000"],
  ]);
  // GBP 100 receivable settled into USD 125 cash: the cross rate differs from the book rates.
  const out = translateLinesIntoBook(
    [
      line("cash", US, "125.0000", "USD"),
      line("ar", US, "-125.0000", "GBP", "-100.0000", "1.2500000000"),
    ],
    bases,
    rates,
    differenceLine,
    context,
  );
  assert.deepEqual(out.differences, [{ subsidiaryId: US, amount: "7.5000" }]);
  const diff = out.lines.find((l) => l.accountId === DIFF)!;
  assert.equal(diff.currency, "EUR");
  assert.equal(diff.amount, diff.txnAmount);
  assert.equal(total(out.lines, US), 0n);
});

test("a currency difference with no difference account refuses with the remedy", () => {
  const rates = new Map([
    [rateKey(US, "USD"), "0.9000000000"],
    [rateKey(US, "GBP"), "1.2000000000"],
  ]);
  assert.throws(
    () =>
      translateLinesIntoBook(
        [
          line("cash", US, "125.0000", "USD"),
          line("ar", US, "-125.0000", "GBP", "-100.0000", "1.2500000000"),
        ],
        bases,
        rates,
        () => null,
        context,
      ),
    (error: unknown) =>
      error instanceof BookTranslationError && /currency difference account/.test(error.message),
  );
});

test("a missing rate refuses instead of translating at par", () => {
  assert.throws(
    () =>
      translateLinesIntoBook(
        [line("cash", US, "10.0000", "USD"), line("revenue", US, "-10.0000", "USD")],
        bases,
        new Map(),
        differenceLine,
        context,
      ),
    (error: unknown) =>
      error instanceof BookTranslationError && /no spot rate for USD→EUR/.test(error.message),
  );
});

test("a functional-only remeasurement line has no book value and refuses", () => {
  const rates = new Map([[rateKey(US, "GBP"), "1.2000000000"]]);
  assert.throws(
    () =>
      translateLinesIntoBook(
        [
          line("ar", US, "5.0000", "GBP", "0.0000", "1.2500000000"),
          line("fx", US, "-5.0000", "GBP", "0.0000", "1.2500000000"),
        ],
        bases,
        rates,
        differenceLine,
        context,
      ),
    (error: unknown) =>
      error instanceof BookTranslationError &&
      /measures its own currency differences/.test(error.message),
  );
});

test("lines already in the book currency carry their transaction amount at rate 1", () => {
  const out = translateLinesIntoBook(
    [
      line("cash", US, "108.0000", "EUR", "100.0000", "1.0800000000"),
      line("revenue", US, "-108.0000", "EUR", "-100.0000", "1.0800000000"),
    ],
    bases,
    new Map(),
    differenceLine,
    context,
  );
  assert.deepEqual(
    out.lines.map((l) => [l.amount, l.fxRate]),
    [
      ["100.0000", "1"],
      ["-100.0000", "1"],
    ],
  );
});

test("translation is deterministic: the same inputs produce the same lines", () => {
  const rates = new Map([[rateKey(US, "USD"), "0.3333350000"]]);
  const make = () => [
    line("expense-a", US, "33.3333", "USD"),
    line("expense-b", US, "33.3333", "USD"),
    line("expense-c", US, "33.3334", "USD"),
    line("cash", US, "-100.0000", "USD"),
  ];
  const first = translateLinesIntoBook(make(), bases, rates, differenceLine, context);
  const second = translateLinesIntoBook(make(), bases, rates, differenceLine, context);
  assert.deepEqual(first, second);
});
