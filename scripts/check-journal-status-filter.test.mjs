import assert from "node:assert/strict";
import test from "node:test";
import { scanSource } from "./check-journal-status-filter.mjs";

const scan = (statement) => scanSource("fixture.ts", `const q = sql\`${statement}\`;`);

test("journal status filters retain reversed originals and exact live intent", () => {
  assert.deepEqual(scan("select je.id from journal_entries je where je.status = 'posted'").map(({ alias, relation }) => [alias, relation]), [["je", "journal_entries"]]);
  for (const query of [
    "select je.id from journal_entries je where je.status in ('posted', 'reversed')",
    "select id from journal_entries where status = 'posted' or status = 'reversed'",
    "select je.id from journal_entries je where je.status = 'posted' -- Live entries only: current candidates exclude reversed entries",
    "select je.id from journal_entries je\n-- Live entries only: an entry already reversed cannot be reversed again\nwhere je.status = 'posted'",
  ]) assert.deepEqual(scan(query), []);
  assert.deepEqual(scanSource("fixture.ts", "// Live entries only: a reversed entry authorizes nothing\nconst q = sql`select je.id from journal_entries je where je.status = 'posted'`;"), []);
  for (const query of [
    "select je.id from journal_entries je\n-- Live entries only: reversed entries are excluded\n\nwhere je.status = 'posted'",
    "select je.id from journal_entries je\n-- Keep this posted-only: reversed entries are excluded\nwhere je.status = 'posted'",
    "select je.id from journal_entries je\nwhere je.kind = 'manual' -- Live entries only: reversed entries are excluded\nand je.status = 'posted'",
  ]) assert.equal(scan(query).length, 1, query);
});

test("document aggregates distinguish voided history from reversed status", () => {
  assert.equal(scan("select sum(d.total) from documents d where d.status in ('posted', 'reversed')").length, 1);
  for (const query of [
    "select sum(d.total) from documents d where d.status = 'posted' or (d.voided_at is not null and d.voided_at::date > ${asOf}::date)",
    "select sum(d.total) from documents d where d.status = 'posted' -- Live entries only: voided records are excluded from the live queue",
    "select sum(d.total) from documents d\n-- Live entries only: voided records are excluded from the live queue\nwhere d.status = 'posted'",
    "select sum(d.total) from documents d where d.status = 'posted' or d.status = 'voided'",
    "select sum(d.total) from documents d where d.status in ('posted') or d.status in ('voided')",
  ]) assert.deepEqual(scan(query), []);
  assert.equal(scan("select sum(d.total) from documents d where d.status = 'posted' -- Current records only: voided records are excluded").length, 1);
});

test("status predicates without a same-template relation are not assigned an alias", () => {
  assert.deepEqual(scanSource("fixture.ts", "const predicate = sql`je.status = 'posted'`"), []);
});
