/**
 * SG IR8A filing tests — pure, no database.
 *
 * Proves the declaration contract for the pack's year-end slip: the row-id
 * grammar round-trips (the subsidiary-scope guard parses through it before
 * authorizing a byte), a year the pack has not transcribed refuses by name
 * before touching the ledger, and both refusals name the real remedy.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SG_PAYROLL_PACK } from "./pack.ts";

function ir8a() {
  const filings = SG_PAYROLL_PACK.filings();
  const filing = filings.yearEnd.find((candidate) => candidate.key === "ir8a");
  assert.ok(filing, "the SG pack declares an IR8A filing");
  return filing;
}

test("the IR8A row grammar is a bare employee id, in both directions", () => {
  const filing = ir8a();
  const employee = randomUUID();
  assert.deepEqual(filing.parseRowId(employee), { employees: [employee], accounts: [] });
  assert.equal(filing.parseRowId("anything"), null);
  assert.equal(filing.parseRowId(`${employee}:extra`), null);
});

test("a year the pack has not transcribed refuses by name before the ledger", async () => {
  const filing = ir8a();
  // 2025 has no transcribed CPF table (rates.ts: 2026 only), so a 2025
  // IR8A cannot price compulsory CPF — the refusal must say so, naming
  // the year, rather than reporting an empty slip.
  await assert.rejects(() => filing.population("org", 2025), /2025/);
});

test("the IR8A amendment refusal names the real IRAS correction remedy", () => {
  const filing = ir8a();
  assert.equal(filing.amendment.supported, false);
  assert.match(filing.amendment.refusal, /amendment submission/);
});

test("the IR8A download refusal names the AIS submission standard not built", () => {
  const filing = ir8a();
  assert.ok(filing.downloadRefusal);
  assert.match(filing.downloadRefusal, /AIS/);
});
