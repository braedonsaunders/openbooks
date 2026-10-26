import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { REPORT_ENTITY_MAP, runCustomQuery } from "@openbooks/reports";
import { db, pool } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

test("a second primary book is refused and the fixed-asset report keeps one row per asset", async () => {
  const org = await createScratchOrg();
  try {
    await assert.rejects(
      db.execute(sql`
      insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
      values (${randomUUID()}, ${org.orgId}, 'SECOND-PRIMARY', 'Second primary', true, true, true)`),
      (error: unknown) => {
        const cause = (error as { cause?: { code?: string; constraint?: string } }).cause;
        return (
          cause?.code === "23505" && cause.constraint === "accounting_books_one_primary_per_org"
        );
      },
    );

    const categoryId = randomUUID();
    await db.execute(sql`
      insert into asset_categories
        (id, org_id, name, asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id)
      values (${categoryId}, ${org.orgId}, 'Report category', ${org.accounts.invAsset},
              ${org.accounts.clearing}, ${org.accounts.adjustment})`);
    await db.execute(sql`
      insert into fixed_assets
        (id, org_id, subsidiary_id, category_id, asset_number, name, acquisition_cost)
      values (${randomUUID()}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId},
              'REPORT-PRIMARY-BOOK', 'Report primary book asset', 100)`);

    const result = await runCustomQuery(
      pool,
      {
        entity: "fixed_assets",
        mode: "rows",
        columns: ["asset_number", "remaining_cost"],
      },
      {
        orgId: org.orgId,
        entityMap: REPORT_ENTITY_MAP,
      },
    );
    assert.deepEqual(
      result.groups.flatMap((group) => group.rows).map((row) => row[0]),
      ["REPORT-PRIMARY-BOOK"],
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
