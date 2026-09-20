import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { seedPayrollComponents } from "./run.ts";
import { createScratchOrg, dropScratchOrgReporting } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Migration 0189: a pay component's identity is (org, country, system_key,
 * kind) — two country packs may each own one system key.
 *
 * Canada's TAX deduction and Japan's GENSEN deduction share the `income_tax`
 * system key (Italy collides on the same key). Under the old three-column
 * unique index installing Japan after Canada died with a unique violation on
 * pay_components_org_system, and the seeder's `on conflict (org_id, code)`
 * could not absorb it because it was idempotent on the wrong identity.
 *
 * This test pins three halves: the two packs coexist after install, a
 * reinstall of either pack is absorbed, and the pre-existing guarantee still
 * holds — two rows with the same (org, system_key, kind) and NULL country
 * are still refused (what NULLS NOT DISTINCT buys, and exactly what a naive
 * plain four-column index would have permitted). A fourth assertion pins the
 * partial predicate: NULL system_key user rows (union fringes, custom
 * components) stay unconstrained, as under the old index.
 */

async function componentRows(orgId: string): Promise<{ code: string; country: string | null; system_key: string | null; kind: string }[]> {
  return (await withBypassContext(async () => (await db.execute<{ code: string; country: string | null; system_key: string | null; kind: string }>(sql`
    select code, country, system_key, kind from pay_components where org_id = ${orgId}`)).rows));
}

async function insertRaw(
  orgId: string, code: string, kind: string, systemKey: string | null, country: string | null,
): Promise<void> {
  await withBypassContext(async () => {
    await db.execute(sql`insert into pay_components(id, org_id, code, name, kind, system_key, country)
      values(${randomUUID()}, ${orgId}, ${code}, ${code}, ${kind}, ${systemKey}, ${country})`);
  });
}

function isIdentityViolation(error: unknown): boolean {
  const cause = (error as { cause?: { message?: unknown } })?.cause;
  const text = `${(error as Error)?.message ?? ""} ${cause?.message ?? ""}`;
  return /pay_components_org_system/.test(text);
}

test(
  "country packs coexist on one system key; NULL-country duplicates still refused; NULL-key rows unconstrained",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await withBypassContext(async () => {
        await seedPayrollComponents(org.orgId, null, "CA");
        await seedPayrollComponents(org.orgId, null, "JP");
      });

      const rows = await componentRows(org.orgId);
      const incomeTax = rows.filter((row) => row.system_key === "income_tax" && row.kind === "deduction");
      assert.equal(incomeTax.length, 2, "CA and JP must each own an income_tax deduction");
      assert.deepEqual(
        incomeTax.map((row) => row.country).sort(),
        ["CA", "JP"],
        "the two income_tax rows must be country-scoped, not absorbed into one",
      );
      assert.ok(incomeTax.some((row) => row.code === "TAX"), "CA TAX must persist");
      assert.ok(incomeTax.some((row) => row.code === "GENSEN"), "JP GENSEN must persist");

      // Reinstalling either pack is absorbed on identity, never an error, and
      // changes nothing.
      const before = rows.length;
      await withBypassContext(async () => {
        await seedPayrollComponents(org.orgId, null, "CA");
        await seedPayrollComponents(org.orgId, null, "JP");
      });
      assert.equal(
        (await componentRows(org.orgId)).length, before,
        "reinstalling an installed pack must change nothing",
      );

      // The pre-existing guarantee: two rows with the same
      // (org, system_key, kind) and NULL country are still refused. A naive
      // plain four-column index permits this (NULL <> NULL) — the refusal is
      // what NULLS NOT DISTINCT buys.
      await insertRaw(org.orgId, "SHARED-A", "earning", "shared_key", null);
      await assert.rejects(
        insertRaw(org.orgId, "SHARED-B", "earning", "shared_key", null),
        (error: unknown) => {
          assert.ok(isIdentityViolation(error), `expected pay_components_org_system violation, got: ${String(error)}`);
          return true;
        },
        "duplicate NULL-country (org, system_key, kind) must still be refused",
      );

      // Same system key in the SAME country twice is refused; in ANOTHER
      // country it coexists.
      await insertRaw(org.orgId, "SCOPED-CA", "deduction", "scoped_key", "CA");
      await assert.rejects(
        insertRaw(org.orgId, "SCOPED-CA2", "deduction", "scoped_key", "CA"),
        (error: unknown) => isIdentityViolation(error),
        "duplicate (org, country, system_key, kind) must be refused",
      );
      await insertRaw(org.orgId, "SCOPED-JP", "deduction", "scoped_key", "JP");

      // NULL system_key user rows stay unconstrained (the partial predicate):
      // two custom deductions with NULL keys coexist, as under the old index.
      await insertRaw(org.orgId, "CUSTOM-A", "deduction", null, null);
      await insertRaw(org.orgId, "CUSTOM-B", "deduction", null, null);
      const customs = (await componentRows(org.orgId)).filter((row) => row.system_key == null);
      assert.ok(
        customs.some((row) => row.code === "CUSTOM-A") && customs.some((row) => row.code === "CUSTOM-B"),
        "NULL-key user rows must both persist",
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
