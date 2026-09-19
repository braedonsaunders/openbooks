import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "./db.ts";
import { createScratchOrg, dropScratchOrgReporting } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Migration 0187: pay_components.tax_treatment is pack-declared, shape-checked.
 *
 * Every value the old CHECK admitted was Canadian (T4127 factors F, U1, F2).
 * Packs declare their pre-tax treatments (`deductionTreatments` in
 * engine/src/payroll/packs.ts), so the database must never enumerate which
 * treatments may exist — every new pack vocabulary would otherwise die in a
 * fixture with a check-constraint violation no pack author can act on. What
 * the database owns is SHAPE: a treatment is a stable machine identifier
 * (lowercase snake_case), and typos must still fail at write time. Which
 * treatments exist is the pack declaration's job, enforced at the API
 * boundary by payComponentTreatmentProblem.
 *
 * This test pins both halves: treatments a pack may legitimately declare
 * insert, and malformed treatments do not.
 */

// Every value the pre-0187 enumeration admitted: the opening must not
// narrow what already exists.
const LEGACY_TREATMENTS = ["none", "pension_f", "union_dues", "alimony"];

// Pack-declared treatments that never appeared in the enumeration: AU
// salary sacrifice is the vocabulary that forced the opening.
const PACK_DECLARED_TREATMENTS = ["salary_sacrifice"];

// The typo class: each must violate pay_components_tax_treatment.
const TYPO_TREATMENTS = ["Pension_F", "salary sacrifice", "sacrifice!", "", "2nd_half"];

async function insertComponent(orgId: string, code: string, taxTreatment: string): Promise<void> {
  await withBypassContext(async () => {
    await db.execute(sql`insert into pay_components(id, org_id, code, name, kind, tax_treatment)
      values(${randomUUID()}, ${orgId}, ${code}, ${code}, 'deduction', ${taxTreatment})`);
  });
}

test(
  "pay_components.tax_treatment accepts pack-declared treatments and legacy values, rejects typos",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      for (const treatment of [...LEGACY_TREATMENTS, ...PACK_DECLARED_TREATMENTS]) {
        await insertComponent(org.orgId, `TREAT-${treatment}`, treatment);
      }
      const stored = await withBypassContext(async () => (await db.execute<{ tax_treatment: string }>(sql`
        select tax_treatment from pay_components where org_id = ${org.orgId} and code like 'TREAT-%'`)).rows);
      assert.equal(stored.length, LEGACY_TREATMENTS.length + PACK_DECLARED_TREATMENTS.length);
      assert.ok(
        stored.some((row) => row.tax_treatment === "salary_sacrifice"),
        "pack-declared 'salary_sacrifice' must persist",
      );

      let typoSequence = 0;
      for (const typo of TYPO_TREATMENTS) {
        typoSequence += 1;
        // The driver wraps the PostgreSQL error: the constraint name lives
        // in the cause, not in the top-level message a bare regex would see.
        // Match through the wrapper so the pin names the exact constraint.
        await assert.rejects(
          insertComponent(org.orgId, `TYPO-${typoSequence}`, typo),
          (error: unknown) => {
            const cause = (error as { cause?: { message?: unknown } })?.cause;
            const text = `${(error as Error)?.message ?? ""} ${cause?.message ?? ""}`;
            assert.match(text, /pay_components_tax_treatment/);
            return true;
          },
          `typo treatment ${JSON.stringify(typo)} must violate the shape check`,
        );
      }
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
