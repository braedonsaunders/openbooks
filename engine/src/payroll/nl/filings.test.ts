import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { isFilingRowUuid } from "../filing-registry.ts";
import { isValidBsn } from "./bsn.ts";
import { NL_PAYROLL_PACK } from "./pack.ts";

/**
 * The jaaropgaaf row grammar, pack-declared: one row per dienstbetrekking
 * (§15.1) — the bare employee UUID for an unstamped legacy statement, or
 * `employee:employment` for a stamped one — the inverse of what the
 * population builds. The subsidiary-scope guard parses every row id through
 * this before authorizing a byte, so a foreign grammar must read as null,
 * never as someone's employee.
 */
const jaaropgaaf = () => NL_PAYROLL_PACK.filings().yearEnd.find((filing) => filing.key === "jaaropgaaf")!;

test("BSNs require nine digits and the 11-proef", () => {
  assert.equal(isValidBsn("111222333"), true);
  assert.equal(isValidBsn("123456782"), true);
  assert.equal(isValidBsn("123456789"), false);
  assert.equal(isValidBsn("12345678"), false);
  assert.equal(isValidBsn(null), false);
});

test("a jaaropgaaf row id parses to the employee that owns it", () => {
  const employee = randomUUID();
  assert.deepEqual(jaaropgaaf().parseRowId(employee), { employees: [employee], accounts: [] });
  // A stamped dienstbetrekking scopes to the same employee: the employment
  // leg identifies the statement, never a second owner.
  const employment = randomUUID();
  assert.deepEqual(jaaropgaaf().parseRowId(`${employee}:${employment}`), {
    employees: [employee], accounts: [],
  });
});

test("a jaaropgaaf row id refuses every foreign grammar", () => {
  assert.equal(jaaropgaaf().parseRowId(""), null);
  assert.equal(jaaropgaaf().parseRowId("not-a-uuid"), null);
  // Three legs (the T4's employee:province:account) is not an NL row.
  assert.equal(jaaropgaaf().parseRowId(`${randomUUID()}:${randomUUID()}:${randomUUID()}`), null);
  assert.equal(jaaropgaaf().parseRowId(`${randomUUID()}:1`), null);
  assert.equal(jaaropgaaf().parseRowId(`1:${randomUUID()}`), null);
});

test("the local row-id legs agree with the registry's single definition", () => {
  // UUID_RE above is a verbatim local copy of isFilingRowUuid (a runtime
  // registry import would cycle through packs.ts during pack evaluation).
  // This pins the two together on bare legs: a drift that 404s real rows
  // fails here. Composite rows are not UUIDs, so only their legs agree.
  const samples = [
    "",
    "not-a-uuid",
    randomUUID(),
    "00000000-0000-0000-0000-000000000000",
    "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
  ];
  for (const sample of samples) {
    assert.equal(
      jaaropgaaf().parseRowId(sample) !== null,
      isFilingRowUuid(sample),
      `agreement on ${JSON.stringify(sample)}`,
    );
  }
});
