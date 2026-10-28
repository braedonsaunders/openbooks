import assert from "node:assert/strict";
import test from "node:test";
import {
  ENGLISH_SEARCH_VOCABULARY,
  mergeVocabulary,
  parseAmountToken,
  parseSearchQuery,
  wordTerms,
  withoutChip,
  type ParseOptions,
} from "./search-query.ts";

const options: ParseOptions = {
  vocabulary: mergeVocabulary(null, null),
  today: "2026-10-27",
  dateOrder: "mdy",
  fiscalYearStartMonth: 1,
};
const parse = (q: string, over: Partial<ParseOptions> = {}) =>
  parseSearchQuery(q, { ...options, ...over });
const words = (q: string) => parse(q).words.map((word) => word.text);

test("plain language reads as scope, amount, words and dates", () => {
  const parsed = parse("invoices over 1,000 from acme this year");
  assert.deepEqual(parsed.scopes, ["invoice"]);
  assert.deepEqual(parsed.amount, { min: "100001", max: null, approximate: false });
  assert.deepEqual(words("invoices over 1,000 from acme this year"), ["acme"]);
  assert.deepEqual(parsed.dates, { from: "2026-01-01", to: "2026-12-31" });
  assert.deepEqual(
    parsed.chips.map((chip) => chip.kind),
    ["scope", "amount", "date"],
  );
});

test("amounts read exactly in every written form and never through a float", () => {
  for (const [typed, cents] of [
    ["$7,298.08", "729808"],
    ["7298.08", "729808"],
    ["-7298.08", "729808"],
    ["(7,298.08)", "729808"],
    ["CAD 7298.08", "729808"],
    ["7.298,08", "729808"],
    ["€7.298,08", "729808"],
    ["9007199254740993.00", "900719925474099300"],
  ] as const) {
    assert.deepEqual(parse(typed).amount, { min: cents, max: cents, approximate: false }, typed);
    assert.deepEqual(parse(typed).words, [], `${typed} is an amount, not a word`);
  }
});

test("an amount written short covers every amount it begins, so typing narrows", () => {
  assert.deepEqual(parse("$1,234").amount, { min: "123400", max: "123499", approximate: false });
  assert.deepEqual(parse("1234.5").amount, { min: "123450", max: "123459", approximate: false });
  assert.deepEqual(parse("1234.567").amount, { min: "123457", max: "123457", approximate: false });
});

test("a bare number is both a word and an amount it begins", () => {
  const parsed = parse("3668");
  assert.equal(parsed.amount, null, "no amount constraint is imposed");
  assert.deepEqual(parsed.words, [
    { text: "3668", terms: ["3668"], exact: false, amount: { min: "366800", max: "366899" } },
  ]);
  assert.equal(parse("0003668").words[0]?.amount, null, "a zero-padded number is not an amount");
});

test("malformed commas stay text instead of inventing a number", () => {
  for (const ambiguous of ["1,2", "12,34", "1,23,4"]) {
    assert.equal(parseAmountToken(ambiguous), null, ambiguous);
    assert.equal(parse(ambiguous).amount, null, ambiguous);
  }
});

test("operators and ranges bound amounts", () => {
  assert.deepEqual(parse(">5000").amount, { min: "500001", max: null, approximate: false });
  assert.deepEqual(parse(">= 5000").amount, { min: "500000", max: null, approximate: false });
  assert.deepEqual(parse("under $50").amount, { min: "0", max: "4999", approximate: false });
  assert.deepEqual(parse("at most 50").amount, { min: "0", max: "5000", approximate: false });
  assert.deepEqual(parse("between 100 and 250").amount, {
    min: "10000",
    max: "25000",
    approximate: false,
  });
  assert.deepEqual(parse("250..100").amount, { min: "10000", max: "25000", approximate: false });
  assert.deepEqual(parse("~1000").amount, { min: "99000", max: "101000", approximate: true });
  assert.deepEqual(parse("about $1,000").amount, {
    min: "99000",
    max: "101000",
    approximate: true,
  });
});

test("document numbers and identifiers split like the index", () => {
  assert.deepEqual(wordTerms("INV-0003668"), ["inv", "0003668"]);
  assert.deepEqual(wordTerms("inv3668"), ["inv", "3668"]);
  assert.deepEqual(wordTerms("M24-BCC"), ["m", "24", "bcc"]);
  assert.deepEqual(words("INV 3668"), ["3668"], "INV reads as the invoice scope");
  assert.deepEqual(parse("INV 3668").scopes, ["invoice"]);
});

test("prefix syntax scopes the rest of the token", () => {
  const parsed = parse("inv:3668");
  assert.deepEqual(parsed.scopes, ["invoice"]);
  assert.deepEqual(words("inv:3668"), ["3668"]);
  assert.deepEqual(parse("cust:acme").scopes, ["customer"]);
  assert.deepEqual(parse("je:").scopes, ["journal"]);
  assert.deepEqual(parse("http://example").scopes, [], "an unknown prefix stays text");
  assert.deepEqual(words("http://example"), ["http://example"]);
});

test("quotes keep text literal and exact", () => {
  const parsed = parse('"invoice" rental');
  assert.deepEqual(parsed.scopes, []);
  assert.deepEqual(
    parsed.words.map((word) => [word.text, word.exact]),
    [
      ["invoice", true],
      ["rental", false],
    ],
  );
});

test("dates read in the reader's order, with relative periods from the business date", () => {
  assert.deepEqual(parse("2026-04-15").dates, { from: "2026-04-15", to: "2026-04-15" });
  assert.deepEqual(parse("04/05/2026").dates, { from: "2026-04-05", to: "2026-04-05" });
  assert.deepEqual(parse("04/05/2026", { dateOrder: "dmy" }).dates, {
    from: "2026-05-04",
    to: "2026-05-04",
  });
  assert.deepEqual(
    parse("13/05/2026").dates,
    { from: "2026-05-13", to: "2026-05-13" },
    "an impossible month reads day first",
  );
  assert.equal(parse("02/30/2026").dates, null, "an impossible day is not a date");
  assert.deepEqual(parse("apr 15").dates, { from: "2026-04-15", to: "2026-04-15" });
  assert.deepEqual(parse("April 15, 2025").dates, { from: "2025-04-15", to: "2025-04-15" });
  assert.deepEqual(parse("15 april 2025").dates, { from: "2025-04-15", to: "2025-04-15" });
  assert.deepEqual(parse("april 2025").dates, { from: "2025-04-01", to: "2025-04-30" });
  assert.deepEqual(parse("today").dates, { from: "2026-10-27", to: "2026-10-27" });
  assert.deepEqual(parse("yesterday").dates, { from: "2026-10-26", to: "2026-10-26" });
  assert.deepEqual(parse("last month").dates, { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(parse("this week").dates, { from: "2026-10-26", to: "2026-11-01" });
  assert.deepEqual(parse("last quarter").dates, { from: "2026-07-01", to: "2026-09-30" });
  assert.deepEqual(parse("Q1 2026").dates, { from: "2026-01-01", to: "2026-03-31" });
  assert.deepEqual(parse("ytd").dates, { from: "2026-01-01", to: "2026-10-27" });
  assert.deepEqual(parse("past 30 days").dates, { from: "2026-09-28", to: "2026-10-27" });
  assert.deepEqual(parse("since 2026-10-01").dates, { from: "2026-10-01", to: null });
  assert.deepEqual(parse("before 2026-10-01").dates, { from: null, to: "2026-09-30" });
  assert.deepEqual(parse("2026-01-01 to 2026-03-31").dates, {
    from: "2026-01-01",
    to: "2026-03-31",
  });
  assert.deepEqual(parse("in 2025").dates, { from: "2025-01-01", to: "2025-12-31" });
  assert.deepEqual(
    parse("in november").dates,
    { from: "2025-11-01", to: "2025-11-30" },
    "the most recent November",
  );
  assert.deepEqual(words("april"), ["april"], "a month alone stays a word: it names things too");
});

test("fiscal years and quarters follow the organization's fiscal calendar", () => {
  const april = { fiscalYearStartMonth: 4 };
  assert.deepEqual(parse("FY26", april).dates, { from: "2025-04-01", to: "2026-03-31" });
  assert.deepEqual(parse("this year", april).dates, { from: "2026-04-01", to: "2027-03-31" });
  assert.deepEqual(
    parse("Q1", april).dates,
    { from: "2026-04-01", to: "2026-06-30" },
    "Q1 of the current fiscal year",
  );
  assert.deepEqual(parse("last quarter", april).dates, { from: "2026-07-01", to: "2026-09-30" });
});

test("statuses and scopes are understood, the longest phrase first", () => {
  assert.equal(parse("overdue invoices").status, "overdue");
  assert.equal(parse("past due bills").status, "overdue");
  assert.deepEqual(parse("purchase orders acme").scopes, ["purchaseOrder"]);
  assert.deepEqual(parse("journal entries").scopes, ["journal"]);
  assert.equal(parse("pending approval").status, "pending");
});

test("words are not lost: names, punctuation and stopwords", () => {
  assert.deepEqual(words("Goss, Terry"), ["goss", "terry"]);
  assert.deepEqual(words("acme inc."), ["acme", "inc."]);
  assert.deepEqual(words("the"), ["the"], "a lone stopword is still searched");
});

test("amount chips say how the amount was written", () => {
  const chip = (q: string) => parse(q).chips.find((c) => c.kind === "amount");
  assert.deepEqual(
    [chip("over 1,000"), chip("7298.08"), chip("1234"), chip("~1000"), chip("100..250")].map((c) =>
      c && c.kind === "amount" ? [c.op, c.value] : null,
    ),
    [["gt", "100000"], ["eq", "729808"], null, ["approx", "100000"], ["range", "10000"]],
  );
  assert.deepEqual(
    (({ op, value }) => [op, value])(chip("$1,234") as { op: string; value: string }),
    ["prefix", "123400"],
  );
});

test("chips name their source text, and removing one keeps the rest as typed", () => {
  const q = "invoices over 1,000 from acme this year";
  const parsed = parse(q);
  const amount = parsed.chips.find((chip) => chip.kind === "amount")!;
  assert.equal(q.slice(amount.start, amount.end), "over 1,000");
  assert.equal(withoutChip(q, amount), "invoices from acme this year");
  const date = parsed.chips.find((chip) => chip.kind === "date")!;
  assert.equal(q.slice(date.start, date.end), "this year");
});

test("the reader's language is understood beside English", () => {
  const french = mergeVocabulary(
    {
      scopes: { invoice: ["facture", "factures"] },
      greater: ["plus de"],
      thisPeriod: ["cette"],
      year: ["année"],
    },
    [["janvier", "janv"]],
  );
  const parsed = parseSearchQuery("factures plus de 500 acme cette année", {
    ...options,
    vocabulary: french,
  });
  assert.deepEqual(parsed.scopes, ["invoice"]);
  assert.deepEqual(parsed.amount, { min: "50001", max: null, approximate: false });
  assert.deepEqual(parsed.dates, { from: "2026-01-01", to: "2026-12-31" });
  assert.deepEqual(parseSearchQuery("invoices", { ...options, vocabulary: french }).scopes, [
    "invoice",
  ]);
  assert.deepEqual(parseSearchQuery("janvier 2026", { ...options, vocabulary: french }).dates, {
    from: "2026-01-01",
    to: "2026-01-31",
  });
  assert.ok(ENGLISH_SEARCH_VOCABULARY.scopes.invoice?.includes("invoices"));
});
