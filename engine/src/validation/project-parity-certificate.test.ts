import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  "engine/src/validation/project-parity-certificate.ts",
  "utf8",
);

test("project GL parity uses NetSuite posted accounting lines", () => {
  assert.match(source, /from transactionaccountingline tal/i);
  assert.match(source, /sum\(tal\.amount\) as amount/i);
  assert.doesNotMatch(
    source,
    /sum\(tl\.netamount\) as amount/i,
    "commercial transaction-line netamount is not authoritative GL impact",
  );
});

test("multi-book source GL requires an explicit accounting-book choice", () => {
  assert.match(source, /--source-accounting-book=<id> explicitly/);
  assert.match(source, /source project GL artifact spans accounting books/);
  assert.match(
    source,
    /row\.accountingbook\) === sourceAccountingBook/,
  );
});
