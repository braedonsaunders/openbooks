/**
 * Custom-field definitions are unique per tenant, target table, normalized
 * target kind (NULL and '' are the same scope) and key, including inactive
 * definitions, so a retired definition can never be shadowed by a new one
 * that silently re-binds its stored values.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { createScratchOrg, dropScratchOrg } from "@openbooks/engine/testing/fixtures";

function uniqueViolation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth < 8; depth++) {
    if ((current as { code?: string }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function define(
  orgId: string,
  targetTable: string,
  targetKind: string | null,
  key: string,
): Promise<void> {
  await db.execute(sql`
    insert into custom_field_defs (org_id, target_table, target_kind, key, label, field_type)
    values (${orgId}, ${targetTable}, ${targetKind}, ${key}, ${key}, 'text')`);
}

test(
  "custom-field definitions enforce one definition per normalized scope on inserts and updates",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    const otherOrg = await createScratchOrg();
    try {
      const index = await db.execute<{ definition: string }>(
        sql`
      select indexdef as definition from pg_indexes
       where schemaname = 'public' and tablename = 'custom_field_defs'
         and indexname = 'custom_field_defs_scope_key_unique'`,
        "objects",
      );
      assert.equal(index.length, 1, "the scope uniqueness index exists");
      assert.match(
        index[0]!.definition,
        /^CREATE UNIQUE INDEX .* \(org_id, target_table, COALESCE\(target_kind, ''::text\), key\)$/,
      );

      await define(org.orgId, "parties", null, "review_note");
      for (const kind of [null, ""]) {
        await assert.rejects(
          () => define(org.orgId, "parties", kind, "review_note"),
          uniqueViolation,
          `target kind ${JSON.stringify(kind)} shares the unscoped definition`,
        );
      }

      await db.execute(
        sql`update custom_field_defs set is_active = false where org_id = ${org.orgId} and key = 'review_note'`,
      );
      await assert.rejects(
        () => define(org.orgId, "parties", null, "review_note"),
        uniqueViolation,
        "an inactive definition still owns its key",
      );

      await define(org.orgId, "documents", "vendor_bill", "review_note");
      await define(org.orgId, "documents", "invoice", "review_note");
      await define(otherOrg.orgId, "parties", null, "review_note");
      await define(org.orgId, "projects", null, "review_note");
      await define(org.orgId, "parties", null, "other_note");
      await assert.rejects(
        () =>
          db.execute(
            sql`update custom_field_defs set key = 'review_note' where org_id = ${org.orgId} and target_table = 'parties' and key = 'other_note'`,
          ),
        uniqueViolation,
        "renaming onto an occupied scope is refused",
      );

      const raced = await Promise.allSettled(
        Array.from({ length: 8 }, () => define(org.orgId, "parties", null, "raced_note")),
      );
      assert.equal(
        raced.filter((result) => result.status === "fulfilled").length,
        1,
        "concurrent definitions admit exactly one winner",
      );
      assert.ok(
        raced.every((result) => result.status === "fulfilled" || uniqueViolation(result.reason)),
      );
    } finally {
      await db.execute(
        sql`delete from custom_field_defs where org_id in (${org.orgId}, ${otherOrg.orgId})`,
      );
      await dropScratchOrg(otherOrg.orgId);
      await dropScratchOrg(org.orgId);
    }
  },
);
