import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { NON_TRANSACTABLE_ISO_CODES, SUPPORTED_CURRENCIES } from "./currencies.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "the installed currency registry carries every transactable ISO 4217 code with registry values",
  { skip: !DB },
  async () => {
    const rows = await db.execute<{ code: string; name: string; minor_units: number }>(
      sql`select code, name, minor_units from currencies`,
      "objects",
    );
    const byCode = new Map(rows.map((row) => [row.code, row]));
    assert.ok(SUPPORTED_CURRENCIES.length > 0, "the registry must not be empty");
    for (const currency of SUPPORTED_CURRENCIES) {
      const row = byCode.get(currency.code);
      assert.ok(row, `${currency.code} must be installed`);
      assert.deepEqual(
        [row.name, Number(row.minor_units)],
        [currency.name, currency.minorUnits],
        `${currency.code} must carry the registry name and minor units`,
      );
    }
    for (const code of NON_TRANSACTABLE_ISO_CODES) {
      assert.ok(!byCode.has(code), `${code} has no quantum and must not be installed`);
    }
  },
);
