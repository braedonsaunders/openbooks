import assert from "node:assert/strict";
import test from "node:test";
import { scanSource } from "./check-journal-status-filter.mjs";

test("journal entry status filters retain reversed originals", () => {
  const rejected = scanSource("fixture.ts", "const q = sql`select je.id from journal_entries je where je.status = 'posted'`;");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].alias, "je");
  assert.equal(rejected[0].relation, "journal_entries");

  const accepted = scanSource("fixture.ts", "const q = sql`select je.id from journal_entries je where je.status in ('posted', 'reversed')`;");
  assert.deepEqual(accepted, []);
});

test("document amount aggregates distinguish voided from reversed status values", () => {
  const query = "const q = sql`select sum(d.total) from documents d where d.status in ('posted', 'reversed')`;";
  const rejected = scanSource("fixture.ts", query);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].relation, "documents");

  const asOf = "const q = sql`select sum(d.total) from documents d where (d.status = 'posted' or (d.voided_at is not null and d.voided_at::date > ${asOf}::date))`;";
  const intent = "const q = sql`select sum(d.total) from documents d where d.status = 'posted' -- Live entries only: voided records are excluded from the live queue\n`";
  assert.deepEqual(scanSource("fixture.ts", asOf), []);
  assert.deepEqual(scanSource("fixture.ts", intent), []);
});

test("status predicates without a same-template relation are not assigned an alias", () => {
  const findings = scanSource("fixture.ts", "const predicate = sql`je.status = 'posted'`;");
  assert.deepEqual(findings, []);
});
