import assert from "node:assert/strict";
import test from "node:test";
import { compileTemplateHtml, renderTemplate } from "@openbooks/pdf";
import { createMoneyFormatter } from "../money-format";
import { FOREIGN_LINE_FIELDS, hasForeignLines, PDF_RECORD_TYPE_BY_KEY } from "./catalog";
import { starterTemplate } from "./starters";
import { foreignLineValues } from "./values";

// Expense report lines spent in another currency print their original amount,
// the rate and how it was obtained; every other document type's line section
// is unchanged.
const expense = PDF_RECORD_TYPE_BY_KEY.expense_report!;
const { money } = createMoneyFormatter("en", "CAD");

test("only expense reports offer the original-currency line fields to templates", () => {
  assert.equal(hasForeignLines(expense), true);
  const lineFields = expense.collections
    .find((collection) => collection.key === "lines")!
    .fields.map((field) => field.key);
  for (const field of FOREIGN_LINE_FIELDS) assert.ok(lineFields.includes(field.key), field.key);
  for (const [key, meta] of Object.entries(PDF_RECORD_TYPE_BY_KEY)) {
    if (key === "expense_report") continue;
    assert.equal(hasForeignLines(meta), false, `${key} lines carry no original-currency fields`);
    assert.ok(
      !starterTemplate(meta).sourceHtml.includes("original_currency"),
      `${key} starter is unchanged`,
    );
  }
});

test("a foreign line prints its original amount, rate and basis; a home-currency line prints nothing more", () => {
  const rated = foreignLineValues(
    {
      original_currency: "EUR",
      original_amount: "100.0000",
      original_fx_rate: "1.4823000000",
      original_fx_evidence: {
        method: "rate_table",
        rateDate: "2026-09-28",
        observationDate: "2026-09-25",
      },
    },
    "CAD",
    money,
    "en",
  );
  assert.deepEqual(rated, {
    original_currency: "EUR",
    original_amount: "€100.00",
    fx_rate: "1 EUR = 1.4823 CAD",
    fx_basis: "Dated rate of Sep 25, 2026",
  });
  assert.equal(
    foreignLineValues(
      {
        original_currency: "USD",
        original_amount: "20",
        original_fx_rate: "1.5",
        original_fx_evidence: { method: "override", reason: "Bank conversion advice" },
      },
      "CAD",
      money,
      "en",
    ).fx_basis,
    "Explicit rate: Bank conversion advice",
  );
  assert.equal(
    foreignLineValues(
      {
        original_currency: "USD",
        original_amount: "20",
        original_fx_rate: "1.37",
        original_fx_evidence: { method: "billed_amount", billedAmount: "27.4000" },
      },
      "CAD",
      money,
      "en",
    ).fx_basis,
    "Billed CA$27.40",
  );
  assert.deepEqual(foreignLineValues({ original_currency: null }, "CAD", money, "en"), {
    original_currency: "",
    original_amount: "",
    fx_rate: "",
    fx_basis: "",
  });

  const { compiledHtml } = compileTemplateHtml(starterTemplate(expense).sourceHtml);
  const html = renderTemplate(compiledHtml, {
    lines: [
      { description: "Hotel, Paris", amount: "CA$148.23", ...rated },
      { description: "Taxi", amount: "CA$25.00", ...foreignLineValues({}, "CAD", money, "en") },
    ],
  });
  assert.match(
    html,
    /Hotel, Paris[\s\S]*Spent €100\.00 · 1 EUR = 1\.4823 CAD · Dated rate of Sep 25, 2026/,
  );
  assert.equal(
    html.match(/Spent /g)?.length,
    1,
    "the home-currency line prints no original-currency block",
  );
});
