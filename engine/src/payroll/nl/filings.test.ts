import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { isFilingRowUuid } from "../filing-registry.ts";
import { NL_PAYROLL_PACK } from "./pack.ts";

/**
 * The jaaropgaaf row grammar, pack-declared: one row per employee, so the row
 * id is the bare employee UUID — the inverse of what the population builds.
 * The subsidiary-scope guard parses every row id through this before
 * authorizing a byte, so a foreign grammar must read as null, never as
 * someone's employee.
 */
const jaaropgaaf = () => NL_PAYROLL_PACK.filings().yearEnd.find((filing) => filing.key === "jaaropgaaf")!;

test("a jaaropgaaf row id parses to the employee that owns it", () => {
  const employee = randomUUID();
  assert.deepEqual(jaaropgaaf().parseRowId(employee), { employees: [employee], accounts: [] });
});

test("a jaaropgaaf row id refuses every foreign grammar", () => {
  assert.equal(jaaropgaaf().parseRowId(""), null);
  assert.equal(jaaropgaaf().parseRowId("not-a-uuid"), null);
  // Another pack's grammar (the W-2's employee:account pair) is not an NL row.
  assert.equal(jaaropgaaf().parseRowId(`${randomUUID()}:${randomUUID()}`), null);
  assert.equal(jaaropgaaf().parseRowId(`${randomUUID()}:1`), null);
});

test("the local row-id shape agrees with the registry's single definition", () => {
  // The grammar above is a verbatim local copy of isFilingRowUuid (a runtime
  // registry import would cycle through packs.ts during pack evaluation).
  // This pins the two together: a drift that 404s real rows fails here.
  const samples = [
    "",
    "not-a-uuid",
    randomUUID(),
    "00000000-0000-0000-0000-000000000000",
    "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    `${randomUUID()}:${randomUUID()}`,
    `${randomUUID()}:1`,
  ];
  for (const sample of samples) {
    assert.equal(
      jaaropgaaf().parseRowId(sample) !== null,
      isFilingRowUuid(sample),
      `agreement on ${JSON.stringify(sample)}`,
    );
  }
});
