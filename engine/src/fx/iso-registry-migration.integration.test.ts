import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "../platform/db.ts";
import { NON_TRANSACTABLE_ISO_CODES, SUPPORTED_CURRENCIES } from "./currencies.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const migration = () =>
  readFileSync(
    new URL(
      "../../../schema/migrations/generated/0157_iso_4217_currency_registry.sql",
      import.meta.url,
    ),
    "utf8",
  );

/**
 * d5 — existing tenants were seeded by the 41-code registry, so documents in
 * a newly covered currency fail closed at validation for lack of a
 * `currencies` row. Migration 0157 backfills the missing rows and must never
 * touch an existing row (insert-if-missing only) and must re-run cleanly.
 */
test("0157 text is insert-if-missing by construction", { skip: !DB }, async () => {
  const text = migration();
  assert.match(text, /ON CONFLICT \(code\) DO NOTHING/);
  assert.doesNotMatch(text, /^\s*UPDATE\s/m, "backfill must never rewrite existing rows");
  assert.doesNotMatch(text, /^\s*DELETE\s/m, "backfill must never delete rows");
});

test("0157 fills missing codes, preserves existing rows, and re-runs cleanly", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // An obscure code no other suite touches, so the sentinel cannot leak
    // into anyone else's assertions even if this run dies mid-test. Upsert,
    // not update: on a legacy-seeded database the row may not exist yet.
    await db.execute(sql`insert into currencies (code, name, minor_units)
      values ('XCG', 'D5-SENTINEL', 2)
      on conflict (code) do update set name = 'D5-SENTINEL'`);
    // A legacy tenant row set: STN deleted as if seeded by the old registry.
    await db.execute(sql`delete from currencies where code = 'STN'`);
    try {
      const client = await pool.connect();
      try {
        await client.query(migration());
        await client.query(migration());
      } finally {
        client.release();
      }
      const sentinel = (await db.execute<{ name: string; minor_units: number }>(
        sql`select name, minor_units from currencies where code = 'XCG'`,
      )).rows[0]!;
      assert.equal(
        sentinel.name,
        "D5-SENTINEL",
        "0157 must never overwrite an existing row, even with a wrong name",
      );
      const filled = (await db.execute<{ name: string; minor_units: number }>(
        sql`select name, minor_units from currencies where code = 'STN'`,
      )).rows[0]!;
      assert.deepEqual(
        [filled.name, filled.minor_units],
        ["Dobra", 2],
        "0157 must insert the missing code with registry values",
      );
      const rows = (await db.execute<{ code: string; minor_units: number }>(
        sql`select code, minor_units from currencies`,
      )).rows;
      const byCode = new Map(rows.map((r) => [r.code, r.minor_units]));
      for (const c of SUPPORTED_CURRENCIES) {
        if (c.code === "XCG") continue; // sentinel row, asserted above
        assert.equal(
          byCode.get(c.code),
          c.minorUnits,
          `${c.code} must exist with the registry minor units after 0157`,
        );
      }
      for (const code of NON_TRANSACTABLE_ISO_CODES) {
        assert.ok(!byCode.has(code), `${code} has no quantum and must not be seeded`);
      }
    } finally {
      await db.execute(sql`update currencies set name = 'Caribbean Guilder' where code = 'XCG'`);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
