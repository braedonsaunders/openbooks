import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./gl-reconcile.ts", import.meta.url), "utf8");

function queryFor(constant: string): string {
  const start = source.indexOf(`const ${constant} =`);
  assert.notEqual(start, -1, `${constant} query should exist`);
  const end = source.indexOf(";", start);
  assert.notEqual(end, -1, `${constant} query should be terminated`);
  return source.slice(start, end);
}

test("GL reconciliation excludes unposted journal entries from ledger totals", () => {
  const oursQuery = queryFor("ours");
  assert.match(
    oursQuery,
    /join journal_entries je on je\.id = jl\.entry_id and je\.status in \('posted', 'reversed'\)/,
    "P&L totals must include only posted or reversed entries",
  );
});

test("GL reconciliation filters the source on transaction date, not period start", () => {
  assert.doesNotMatch(
    source,
    /ap\.startdate\s*>=/,
    "a mid-period --since must cover the same transaction population on both sides",
  );
  assert.match(
    source,
    /sourcePlQuery\(SINCE\)/,
    "source P&L must come from the shared transaction-date query builder",
  );
  assert.match(
    source,
    /sourceInvoiceQuery\(SINCE\)/,
    "source invoices must come from the shared transaction-date query builder",
  );
});

test("GL reconciliation compares currency buckets, never a mixed scalar", () => {
  assert.match(source, /group by currency/, "invoices bucket by transaction currency");
  assert.match(
    source,
    /group by s\.base_currency, je\.subsidiary_id/,
    "P&L buckets by entity functional currency",
  );
  assert.match(source, /alignMoneyBuckets\(/, "buckets align on the union of labels");
  assert.match(source, /no combined total/, "no cross-currency figure is produced");
  assert.match(
    source,
    /have no base currency/,
    "postings without a functional currency refuse by name",
  );
  assert.match(
    source,
    /sourceIsoCurrency\(/,
    "unresolvable source currencies refuse by name through the shared resolver",
  );
});

test("GL reconciliation compares exactly and gates automation on the exit code", () => {
  assert.doesNotMatch(
    source,
    /0\.005/,
    "no percentage tolerance may hide a delta",
  );
  assert.doesNotMatch(source, /process\.exit\(0\)/, "differences must not exit 0");
  assert.match(source, /compareMoneyBucket\(/, "decimals compare to the unit");
  assert.match(source, /compareCountBucket\(/, "counts compare to the integer");
  assert.match(source, /process\.exitCode = 1/, "any DIFFERS exits nonzero");
  assert.match(source, /verdictsDiffer\(verdicts\)/, "the exit follows the verdicts");
});

test("GL reconciliation excludes unposted journal entries from project detail", () => {
  const jobQuery = queryFor("job");
  assert.match(
    jobQuery,
    /join journal_entries je on je\.id = jl\.entry_id and je\.status in \('posted', 'reversed'\)/,
    "project totals must include only posted or reversed entries",
  );
});
