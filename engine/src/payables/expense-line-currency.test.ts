import assert from "node:assert/strict";
import test from "node:test";
import { add } from "../money/money.ts";
import {
  convertExpenseAtRate,
  convertExpenseFromBilled,
  currencyMinorUnits,
  expenseFxRate,
  ExpenseFxInputError,
  parseExpenseLineForeign,
} from "./expense-line-currency.ts";

const valid = {
  currency: "EUR",
  amount: "100.00",
  taxAmount: "20",
  rateDate: "2026-09-28",
  method: "rate_table",
};

test("a foreign-currency statement parses into exact amounts and refuses what it cannot convert", () => {
  assert.deepEqual(parseExpenseLineForeign(valid, 1, "CAD"), {
    currency: "EUR",
    amount: "100.0000",
    taxAmount: "20.0000",
    rateDate: "2026-09-28",
    method: "rate_table",
    rate: null,
    reason: null,
    billedAmount: null,
  });
  const refused = (raw: Record<string, unknown>, code: string) =>
    assert.throws(
      () => parseExpenseLineForeign(raw, 3, "CAD"),
      (error: unknown) =>
        error instanceof ExpenseFxInputError &&
        error.code === code &&
        error.message.startsWith("Line 3:") &&
        error.remedy.length > 0,
    );
  refused({ ...valid, currency: "EURO" }, "expense_fx_currency_invalid");
  refused({ ...valid, currency: "CAD" }, "expense_fx_same_currency");
  refused({ ...valid, amount: "1,234" }, "expense_fx_amount_invalid");
  refused({ ...valid, amount: "10.12345" }, "expense_fx_amount_invalid");
  refused({ ...valid, rateDate: "2026-02-30" }, "expense_fx_date_invalid");
  refused({ ...valid, method: "guess" }, "expense_fx_method_invalid");
  refused({ ...valid, method: "override" }, "expense_fx_rate_required");
  refused(
    { ...valid, method: "override", rate: "1.48", reason: "bank" },
    "expense_fx_reason_required",
  );
  refused(
    { ...valid, method: "override", rate: "0", reason: "Bank conversion advice" },
    "expense_fx_rate_invalid",
  );
  refused({ ...valid, method: "billed_amount" }, "expense_fx_billed_required");
});

test("a rate converts each amount once, straight to the report currency's minor unit", () => {
  // 0.1249 × 1.0004803843 is 0.12495999…: one rounding gives 0.12. Rounding
  // first to four places (0.1250) and then to cents would give 0.13.
  assert.deepEqual(
    convertExpenseAtRate({
      amount: "0.1249",
      taxAmount: null,
      rate: "1.0004803843",
      minorUnits: 2,
    }),
    { amount: "0.1200", taxAmount: null },
  );
  assert.deepEqual(
    convertExpenseAtRate({
      amount: "100.00",
      taxAmount: "20.00",
      rate: "1.4823000000",
      minorUnits: 2,
    }),
    { amount: "148.2300", taxAmount: "29.6500" },
  );
  assert.deepEqual(
    convertExpenseAtRate({ amount: "100.00", taxAmount: null, rate: "157.3312", minorUnits: 0 }),
    { amount: "15733.0000", taxAmount: null },
    "yen has no minor unit",
  );
  assert.deepEqual(
    convertExpenseAtRate({ amount: "100.00", taxAmount: null, rate: "0.37654", minorUnits: 3 }),
    { amount: "37.6540", taxAmount: null },
    "dinars keep three places",
  );
  assert.deepEqual(
    convertExpenseAtRate({ amount: "-12.50", taxAmount: null, rate: "1.5", minorUnits: 2 }),
    { amount: "-18.7500", taxAmount: null },
    "a refund line converts with its sign",
  );
});

test("a billed amount is the converted gross exactly and its rate is derived from it", () => {
  const billed = convertExpenseFromBilled({
    amount: "100.00",
    taxAmount: "20.00",
    billedAmount: "178.91",
    minorUnits: 2,
  })!;
  assert.equal(
    add(billed.amount, billed.taxAmount!),
    "178.9100",
    "net plus tax is exactly the billed amount",
  );
  assert.equal(billed.taxAmount, "29.8200");
  assert.equal(billed.rate, "1.4909166667");
  assert.deepEqual(
    convertExpenseFromBilled({
      amount: "42.00",
      taxAmount: null,
      billedAmount: "61.17",
      minorUnits: 2,
    }),
    { amount: "61.1700", taxAmount: null, rate: "1.4564285714" },
  );
  const refund = convertExpenseFromBilled({
    amount: "-10.00",
    taxAmount: "-2.00",
    billedAmount: "-17.50",
    minorUnits: 2,
  })!;
  assert.equal(add(refund.amount, refund.taxAmount!), "-17.5000");
  assert.equal(
    convertExpenseFromBilled({
      amount: "10.00",
      taxAmount: null,
      billedAmount: "-10.00",
      minorUnits: 2,
    }),
    null,
    "opposite signs give no rate",
  );
  assert.equal(
    convertExpenseFromBilled({ amount: "0", taxAmount: null, billedAmount: "5", minorUnits: 2 }),
    null,
    "nothing spent gives no rate",
  );
});

test("stored rates fit the ledger's rate column and minor units come from the ISO registry", () => {
  assert.equal(expenseFxRate("1.48"), "1.4800000000");
  assert.equal(expenseFxRate("1234567890"), null, "ten whole digits do not fit");
  assert.equal(expenseFxRate("abc"), null);
  assert.equal(currencyMinorUnits("CAD"), 2);
  assert.equal(currencyMinorUnits("JPY"), 0);
  assert.equal(currencyMinorUnits("BHD"), 3);
  assert.equal(currencyMinorUnits("XXX"), null);
});
