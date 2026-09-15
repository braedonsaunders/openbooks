import assert from "node:assert/strict";
import test from "node:test";
import { resolveLinkFunctional } from "./applications.ts";

/**
 * Settlement links arrive STATED (amount in an explicit currency), never
 * assumed functional. The reconciler resolves each link to functional
 * carrying value itself and refuses — with a named error, failing the run
 * honestly — anything it cannot price. It must never silently under-apply a
 * foreign face value again.
 */
const line = (currency: string, fxRate: string, functionalCurrency = "CAD") => ({
  currency,
  fxRate,
  functionalCurrency,
});

const link = (amount: string, currency: string, rate?: string | null) => ({
  paymentRef: "pay-1",
  appliedRef: "inv-1",
  amount,
  currency,
  ...(rate === undefined ? {} : { rate }),
});

test("a base-currency link passes through untouched", () => {
  assert.equal(resolveLinkFunctional(link("100", "CAD"), line("CAD", "1")), 100_0000n);
});

test("a transaction-currency link converts at the payment line's booked rate", () => {
  assert.equal(resolveLinkFunctional(link("100", "EUR"), line("EUR", "1.2")), 120_0000n);
  assert.equal(resolveLinkFunctional(link("100", "EUR"), line("EUR", "1.1")), 110_0000n);
});

test("currency matching is case-insensitive", () => {
  assert.equal(resolveLinkFunctional(link("100", "eur"), line("EUR", "1.2")), 120_0000n);
});

test("the books' line rate wins over a stale producer rate for the same currency", () => {
  // `have` accumulates carrying values at booked rates, so only the booked
  // rate keeps the pair loop convergent. The producer rate is a fallback for
  // currencies the books don't carry — never an override.
  assert.equal(
    resolveLinkFunctional(link("100", "EUR", "9.99"), line("EUR", "1.2")),
    120_0000n,
  );
});

test("a cross-currency link converts at the stated producer rate", () => {
  assert.equal(
    resolveLinkFunctional(link("100", "GBP", "1.5"), line("EUR", "1.2", "CAD")),
    150_0000n,
  );
});

test("a link with no currency is refused", () => {
  assert.throws(
    () => resolveLinkFunctional(link("100", "  "), line("EUR", "1.2")),
    /states no currency/,
  );
});

test("a link in an unresolvable currency with no rate is refused", () => {
  assert.throws(
    () => resolveLinkFunctional(link("100", "JPY"), line("EUR", "1.2")),
    /JPY/,
  );
});

test("a link with an unusable producer rate is refused", () => {
  assert.throws(
    () => resolveLinkFunctional(link("100", "JPY", "bogus"), line("EUR", "1.2")),
    /unusable conversion rate/,
  );
});

test("a transaction-currency link with an unusable line rate is refused", () => {
  assert.throws(
    () => resolveLinkFunctional(link("100", "EUR"), line("EUR", "zero")),
    /no usable rate/,
  );
});
