import assert from "node:assert/strict";
import test from "node:test";
import {
  alignMoneyBuckets,
  compareCountBucket,
  compareMoneyBucket,
  DEFAULT_SINCE,
  formatMoney,
  formatVerdict,
  parseSince,
  SOURCE_CURRENCY_SYMBOL_QUERY,
  SOURCE_SUBSIDIARY_QUERY,
  sourceInvoiceQuery,
  sourceIsoCurrency,
  sourcePlQuery,
  verdictsDiffer,
} from "./gl-reconcile-source-queries.ts";

test("since defaults to the cutover month", () => {
  assert.equal(parseSince(undefined), DEFAULT_SINCE);
});

test("since accepts aligned and mid-period dates alike", () => {
  assert.equal(parseSince("2024-06-01"), "2024-06-01");
  assert.equal(parseSince("2024-06-15"), "2024-06-15");
});

test("since refuses non-dates by name", () => {
  for (const raw of ["june", "2024-13-01", "2024-06-1", "2024/06/15", ""]) {
    assert.throws(() => parseSince(raw), /--since must be YYYY-MM-DD/);
  }
});

test("source P&L filters on the transaction date, not the period start", () => {
  const query = sourcePlQuery("2024-06-15");
  assert.match(query, /t\.trandate >= to_date\('2024-06-15','YYYY-MM-DD'\)/);
  assert.doesNotMatch(
    query,
    /ap\.startdate/,
    "a mid-period since must not drop the partial source period",
  );
});

test("source invoices filter on the transaction date, not the period start", () => {
  const query = sourceInvoiceQuery("2024-06-15");
  assert.match(query, /t\.trandate >= to_date\('2024-06-15','YYYY-MM-DD'\)/);
  assert.doesNotMatch(query, /ap\.startdate/);
});

test("a mid-period since builds the same predicate shape as an aligned one", () => {
  // The false-parity defect: June 1 and June 15 must cover the same
  // transaction population rule, differing only in the date literal.
  const aligned = sourcePlQuery("2024-06-01").replaceAll("2024-06-01", "SINCE");
  const midPeriod = sourcePlQuery("2024-06-15").replaceAll(
    "2024-06-15",
    "SINCE",
  );
  assert.equal(midPeriod, aligned);
});

test("source P&L groups by posting subsidiary for functional-currency buckets", () => {
  const query = sourcePlQuery("2024-06-01");
  assert.match(query, /select t\.subsidiary as subsidiary,/);
  assert.match(query, /group by t\.subsidiary/);
  assert.doesNotMatch(
    query,
    /sum\(case[\s\S]*from transactionaccountingline[\s\S]*\) revenue,\s*$/m,
    "no ungrouped scalar may mix functional currencies",
  );
});

test("source invoices group by transaction currency", () => {
  const query = sourceInvoiceQuery("2024-06-01");
  assert.match(query, /BUILTIN\.DF\(t\.currency\) as currency_label/);
  assert.match(query, /group by t\.currency, BUILTIN\.DF\(t\.currency\)/);
});

test("source currency resolution prefers the currency-table symbol", () => {
  const symbols = new Map([["7", "EUR"]]);
  assert.equal(sourceIsoCurrency("invoice currency", "1", "7", "Euro", symbols), "EUR");
});

test("source currency resolution falls back to the shared display mapping", () => {
  assert.equal(sourceIsoCurrency("subsidiary", "3", "3", "USA", new Map()), "USD");
  assert.equal(sourceIsoCurrency("subsidiary", "4", null, "eur", new Map()), "EUR");
});

test("source currency resolution refuses the unresolvable by name", () => {
  assert.throws(
    () => sourceIsoCurrency("subsidiary", "9", "9", "Martian Credits", new Map()),
    /cannot resolve ISO currency for source subsidiary 9 \(Martian Credits\)/,
  );
});

test("subsidiary and symbol probes use the connector's own record shapes", () => {
  assert.match(SOURCE_SUBSIDIARY_QUERY, /FROM subsidiary/);
  assert.match(SOURCE_SUBSIDIARY_QUERY, /BUILTIN\.DF\(currency\) AS currencylabel/);
  assert.match(SOURCE_CURRENCY_SYMBOL_QUERY, /SELECT id, symbol FROM currency/);
});

test("a two-currency scope aligns into two buckets", () => {
  const aligned = alignMoneyBuckets(
    [
      { currency: "USD", amount: "100.0000" },
      { currency: "EUR", amount: "100.0000" },
    ],
    [
      { currency: "USD", amount: "100.0000" },
      { currency: "EUR", amount: "100.0000" },
    ],
  );
  assert.deepEqual(
    aligned.map((bucket) => bucket.currency),
    ["EUR", "USD"],
  );
});

test("a mispriced EUR invoice stays visible when the scalar totals match", () => {
  // USD 100 + EUR 100 on both sides, but the EUR invoice is mispriced by 10
  // against a compensating USD-side shift that keeps the naive scalar at 200.
  const aligned = alignMoneyBuckets(
    [
      { currency: "USD", amount: "110.0000" },
      { currency: "EUR", amount: "90.0000" },
    ],
    [
      { currency: "USD", amount: "100.0000" },
      { currency: "EUR", amount: "100.0000" },
    ],
  );
  const eur = aligned.find((bucket) => bucket.currency === "EUR")!;
  const usd = aligned.find((bucket) => bucket.currency === "USD")!;
  assert.notEqual(eur.ours, eur.theirs);
  assert.notEqual(usd.ours, usd.theirs);
});

test("a currency one side lacks zero-fills instead of agreeing", () => {
  const aligned = alignMoneyBuckets([{ currency: "USD", amount: "50.0000" }], []);
  assert.deepEqual(aligned, [{ currency: "USD", ours: "50.0000", theirs: "0.0000" }]);
});

test("bucket alignment refuses an unlabelled bucket", () => {
  assert.throws(() => alignMoneyBuckets([{ currency: "", amount: "1" }], []), /no currency label/);
});

test("a sub-tolerance delta still differs: exact decimals, no 0.5% rule", () => {
  // 1,001,000 vs 1,000,000 is 0.1% of source: the old tolerance called it
  // ok while a million-scale unit hid inside. Exact comparison differs.
  const verdict = compareMoneyBucket("[USD] revenue", "1001000.0000", "1000000.0000");
  assert.equal(verdict.status, "DIFFERS");
  assert.equal(verdict.delta, "1000.0000");
  assert.ok(verdictsDiffer([verdict]));
});

test("agreement is exact to the unit", () => {
  const verdict = compareMoneyBucket("[USD] revenue", "1000000.0000", "1000000.0000");
  assert.equal(verdict.status, "ok");
  assert.equal(verdict.delta, "0.0000");
  assert.ok(!verdictsDiffer([verdict]));
});

test("counts compare to the integer, never the float", () => {
  assert.equal(compareCountBucket("[USD] count", 7, "7").status, "ok");
  assert.equal(compareCountBucket("[USD] count", 7, "8").status, "DIFFERS");
  assert.equal(compareCountBucket("[USD] count", 0, "1").status, "DIFFERS");
  assert.throws(
    () => compareCountBucket("[USD] count", "7.5", "7"),
    /fractional population count for \[USD\] count/,
  );
});

test("money display never passes through a float", () => {
  assert.equal(formatMoney("1234567.891"), "1234567.8910");
  assert.equal(formatMoney(0), "0.0000");
  const line = formatVerdict(compareMoneyBucket("[EUR] total", "100.0000", "90.0000"));
  assert.match(line, /\[EUR\] total/);
  assert.match(line, /DIFFERS/);
  assert.doesNotMatch(line, /%/);
});

test("query builders refuse unchecked since values", () => {
  assert.throws(
    () => sourcePlQuery("2024/06/15"),
    /unchecked since value/,
  );
  assert.throws(
    () => sourceInvoiceQuery("'; drop table x; --"),
    /unchecked since value/,
  );
});
