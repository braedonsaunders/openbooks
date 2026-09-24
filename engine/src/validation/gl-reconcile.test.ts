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

test("GL reconciliation excludes unposted journal entries from project detail", () => {
  const jobQuery = queryFor("job");
  assert.match(
    jobQuery,
    /join journal_entries je on je\.id = jl\.entry_id and je\.status in \('posted', 'reversed'\)/,
    "project totals must include only posted or reversed entries",
  );
});
