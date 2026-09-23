import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SINCE,
  parseSince,
  sourceInvoiceQuery,
  sourcePlQuery,
} from "./gl-reconcile-queries.ts";

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
