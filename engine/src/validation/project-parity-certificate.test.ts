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

test("Field Ticket parity compares immutable commercial evidence, not time approval", () => {
  assert.match(source, /join field_ticket_labor_snapshots snapshot/i);
  assert.match(source, /join field_ticket_labor_lines line/i);
  assert.match(source, /snapshot\.superseded_at is null/i);
  assert.match(source, /snapshot\.evidence_basis = 'source_import'/i);
  assert.doesNotMatch(
    source,
    /from time_entries te/i,
    "commercial ticket evidence must not be inferred from operational time",
  );
});
