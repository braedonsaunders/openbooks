import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "./db.ts";
import { createScratchOrg, dropScratchOrgReporting } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Migration 0176: pay_components.system_key is pack-declared, shape-checked.
 *
 * Country packs declare the statutory components they need (`systemKey:
 * string` in engine/src/payroll/packs.ts), so the database must never
 * enumerate which keys may exist — every new pack levy would otherwise die
 * in a fixture with a check-constraint violation no pack author can act on.
 * What the database owns is SHAPE: a system key is a stable machine
 * identifier (lowercase snake_case), and typos must still fail at seed time.
 *
 * This test pins both halves: keys a pack may legitimately declare insert,
 * and malformed keys do not.
 */

// Every key the pre-0176 enumeration admitted: the opening must not narrow
// what already exists.
const LEGACY_KEYS = [
  "base_pay", "overtime", "bonus", "stat_holiday", "stat_holiday_premium",
  "vacation_accrual", "vacation_payout",
  "cpp", "cpp2", "ei", "qpip", "income_tax", "qc_income_tax",
  "fit", "ss", "medicare", "medicare_addl", "futa", "suta",
  "state_income_tax", "local_income_tax",
  "wcb", "eht",
];

// Pack-declared keys that never appeared in the enumeration: the Québec
// Health Services Fund slot ('hsf') is the levy that forced the opening.
const PACK_DECLARED_KEYS = ["hsf"];

// The typo class: each must violate pay_components_system_key.
const TYPO_KEYS = ["CPP", "income tax", "cpp!", "", "2cpp", "eht "];

async function insertComponent(orgId: string, code: string, systemKey: string | null): Promise<void> {
  await withBypassContext(async () => {
    await db.execute(sql`insert into pay_components(id, org_id, code, name, kind, system_key)
      values(${randomUUID()}, ${orgId}, ${code}, ${code}, 'employer_contribution', ${systemKey})`);
  });
}

test(
  "pay_components.system_key accepts pack-declared keys and legacy keys, rejects typos",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      for (const key of [...LEGACY_KEYS, ...PACK_DECLARED_KEYS]) {
        await insertComponent(org.orgId, `SYSKEY-${key}`, key);
      }
      await insertComponent(org.orgId, "SYSKEY-USER", null);
      const stored = await withBypassContext(async () => (await db.execute<{ system_key: string | null }>(sql`
        select system_key from pay_components where org_id = ${org.orgId} and code like 'SYSKEY-%'`)).rows);
      assert.equal(stored.length, LEGACY_KEYS.length + PACK_DECLARED_KEYS.length + 1);
      assert.ok(stored.some((row) => row.system_key === "hsf"), "pack-declared 'hsf' must persist");

      let typoSequence = 0;
      for (const typo of TYPO_KEYS) {
        typoSequence += 1;
        // The driver wraps the PostgreSQL error: the constraint name lives
        // in the cause, not in the top-level message a bare regex would see.
        // Match through the wrapper so the pin names the exact constraint.
        await assert.rejects(
          insertComponent(org.orgId, `TYPO-${typoSequence}`, typo),
          (error: unknown) => {
            const cause = (error as { cause?: { message?: unknown } })?.cause;
            const text = `${(error as Error)?.message ?? ""} ${cause?.message ?? ""}`;
            assert.match(text, /pay_components_system_key/);
            return true;
          },
          `typo system_key ${JSON.stringify(typo)} must violate the shape check`,
        );
      }
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
