import assert from "node:assert/strict";
import test from "node:test";
import { db } from "../platform/db.ts";
import { payrollPack } from "./packs.ts";
import { periodicReturnAccountResolver } from "./yearend.ts";

/**
 * The account a committed stub's wages are filed under on a country's
 * account-grouped periodic return is a pack declaration, not a country
 * branch in the shared layer. The US files by the legal employer's EIN
 * (see us/employer-scope.ts); every other pack files under the account
 * the stub records, so the resolver is the identity there.
 */

test("the US pack declares employer-account periodic filing", () => {
  assert.equal(payrollPack("US").periodicReturnFilesByEmployerAccount, true);
});

test("packs without employer-account filing do not declare it", () => {
  assert.ok(!payrollPack("CA").periodicReturnFilesByEmployerAccount);
});

test("a non-employer pack resolves under the stub account, untouched", async () => {
  const resolve = await periodicReturnAccountResolver("org-unused", "CA");
  assert.equal(resolve("stub-account", "subsidiary-1", "2026-07-01"), "stub-account");
  assert.equal(resolve(null, "subsidiary-1", "2026-07-01"), null);
});

test("US periodic filing resolves each retained date and refuses an unqualified owner or date", async (t) => {
  const employerA = "00000000-0000-4000-8000-000000000001";
  const employerB = "00000000-0000-4000-8000-000000000002";
  const state = "00000000-0000-4000-8000-000000000003";
  const einA = "00000000-0000-4000-8000-000000000004";
  const einB = "00000000-0000-4000-8000-000000000005";
  const dialect = (
    db as unknown as {
      dialect: { sqlToQuery(query: Parameters<typeof db.execute>[0]): { sql: string } };
    }
  ).dialect;
  t.mock.method(db, "execute", async (query: Parameters<typeof db.execute>[0], mode?: string) => {
    const inMode = <T extends { rows: unknown }>(result: T) =>
      mode === "objects" ? result.rows : result;
    const built = dialect.sqlToQuery(query);
    if (built.sql.includes("from payroll_filing_accounts"))
      return inMode({
        rows: [
          {
            id: state,
            name: "Transferred state registration",
            program_type: "us_state_sui",
            subsidiary_id: null,
            state_code: "NJ",
            is_active: true,
            account_number: "NJ-123",
          },
          {
            id: einA,
            name: "Original EIN A",
            program_type: "us_ein",
            subsidiary_id: employerA,
            state_code: null,
            is_active: false,
            account_number: "12-3456789",
          },
          {
            id: einB,
            name: "Successor EIN B",
            program_type: "us_ein",
            subsidiary_id: employerB,
            state_code: null,
            is_active: true,
            account_number: "98-7654321",
          },
        ],
      });
    if (built.sql.includes("from payroll_us_filing_account_employer_lineage"))
      return inMode({
        rows: [
          {
            id: "lineage-a",
            filingAccountId: state,
            federalAccountId: einA,
            subsidiaryId: employerA,
            effectiveFrom: "2026-01-01",
            effectiveTo: "2026-06-30",
            sourceReference: "Original registration A",
          },
          {
            id: "lineage-b",
            filingAccountId: state,
            federalAccountId: einB,
            subsidiaryId: employerB,
            effectiveFrom: "2026-07-01",
            effectiveTo: null,
            sourceReference: "Successor registration B",
          },
        ],
      });
    assert.fail("Unexpected periodic resolver database boundary");
  });
  const resolve = await periodicReturnAccountResolver("00000000-0000-4000-8000-000000000099", "US");
  assert.equal(resolve(state, employerA, "2026-06-30"), einA);
  assert.equal(resolve(state, employerB, "2026-07-01"), einB);
  assert.equal(
    resolve(einA, employerA, "2026-08-01"),
    einA,
    "an inactive explicit EIN retains its identity",
  );
  assert.throws(() => resolve(state, employerB, "2026-06-30"), /another original legal employer/);
  assert.throws(() => resolve(state, employerA, "2025-12-31"), /unknown.*Employer EIN history/);
  assert.throws(() => resolve(state, employerA, "2026-02-30"), /actual payroll source date/);
});
