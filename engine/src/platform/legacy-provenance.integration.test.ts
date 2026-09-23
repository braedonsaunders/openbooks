import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "./db.ts";
import { isLegacyProvenance } from "./legacy-provenance.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("legacy provenance reads by membership, scoped to the tenant", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  const other = await withBypass(() => createScratchOrg());
  const rowId = randomUUID();
  try {
    await withBypass(async () => {
      await db.execute(sql`
        insert into upgrade_legacy_provenance (org_id, migration, table_name, row_id, note)
        values (${org.orgId}, '0297_recognition_rule_versions', 'recognition_rules', ${rowId}, 'test mark')`);
    });
    await withBypass(async () => {
      assert.equal(
        await isLegacyProvenance(db, org.orgId, "recognition_rules", rowId),
        true,
        "a recorded row reads legacy",
      );
      assert.equal(
        await isLegacyProvenance(db, org.orgId, "recognition_rules", randomUUID()),
        false,
        "an unrecorded row reads current",
      );
      assert.equal(
        await isLegacyProvenance(db, other.orgId, "recognition_rules", rowId),
        false,
        "another tenant's mark is invisible",
      );
      // Membership decides while the registry exists; the transitional
      // fallback only fires before 0326 applies.
      assert.equal(
        await isLegacyProvenance(db, org.orgId, "recognition_rules", randomUUID(), { fallback: true }),
        false,
        "the fallback never promotes an unmarked row once the table exists",
      );
    });
  } finally {
    // Teardown clears the registry itself (it enumerates org tables
    // dynamically); deleting here first would hold uncommitted row locks
    // across the wipe and block it.
    await dropScratchOrg(org.orgId);
    await dropScratchOrg(other.orgId);
  }
});
