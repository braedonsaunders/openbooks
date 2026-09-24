import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { REPORT_ENTITY_MAP, runCustomQuery } from "@openbooks/reports";
import { db, pool } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

const duplicatePrimaryPreflight = readFileSync(
  new URL("../../../schema/migrations/preflight/0345_accounting_books_one_primary_per_org.sql", import.meta.url),
  "utf8",
).replaceAll("public.accounting_books", "pg_temp.accounting_books");

test("the primary-book preflight names duplicate organizations and book ids", async () => {
  const orgId = randomUUID();
  const firstBookId = randomUUID();
  const secondBookId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("create temp table accounting_books (id uuid, org_id uuid, is_primary boolean) on commit drop");
    await client.query(
      "insert into pg_temp.accounting_books (id, org_id, is_primary) values ($1, $2, true), ($3, $2, true)",
      [firstBookId, orgId, secondBookId],
    );
    const findings = (await client.query(duplicatePrimaryPreflight)).rows as Record<string, unknown>[];
    assert.equal(findings.length, 1);
    const finding = findings[0]!;
    assert.equal(finding.subject, orgId);
    assert.match(String(finding.detail), new RegExp(orgId));
    assert.match(String(finding.detail), new RegExp(firstBookId));
    assert.match(String(finding.detail), new RegExp(secondBookId));
    assert.equal(finding.severity, "refuse");
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
});

test("a second primary book is refused and the fixed-asset report keeps one row per asset", async () => {
  const org = await createScratchOrg();
  try {
    await assert.rejects(db.execute(sql`
      insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
      values (${randomUUID()}, ${org.orgId}, 'SECOND-PRIMARY', 'Second primary', true, true, true)`));

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

    const result = await runCustomQuery(pool, {
      entity: "fixed_assets",
      mode: "rows",
      columns: ["asset_number", "remaining_cost"],
    }, {
      orgId: org.orgId,
      entityMap: REPORT_ENTITY_MAP,
    });
    assert.deepEqual(result.groups.flatMap((group) => group.rows).map((row) => row[0]), ["REPORT-PRIMARY-BOOK"]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
