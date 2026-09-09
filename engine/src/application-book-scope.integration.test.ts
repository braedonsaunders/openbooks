import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "./db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting, type ScratchOrg } from "./test-fixtures.ts";

const migration = readFileSync(new URL("../../schema/migrations/generated/0101_application_book_scope.sql", import.meta.url), "utf8");
const baseline = readFileSync(new URL("../../schema/migrations/generated/0001_baseline.sql", import.meta.url), "utf8");
const originalFunction = baseline.slice(
  baseline.indexOf("CREATE FUNCTION public.app_validate_endpoints()"),
  baseline.indexOf("\nend $$;", baseline.indexOf("CREATE FUNCTION public.app_validate_endpoints()")) + "\nend $$;".length,
).replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION");

async function openLine(org: ScratchOrg, actor: string, book: string, amount: "100" | "-100") {
  return withOrgTransaction(org.orgId, async () => {
    const entry = randomUUID();
    const line = randomUUID();
    await db.execute(sql`
      insert into journal_entries (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,created_by)
      values (${entry},${org.orgId},${book},${org.subsidiaryId},${`APP-${entry}`},${org.date},${org.periodId},'draft','manual',${actor})`);
    await db.execute(sql`
      insert into journal_lines (id,org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,party_id,is_open_item)
      values (${line},${org.orgId},${entry},1,${org.accounts.ar},${org.subsidiaryId},${amount},'CAD',${amount},1,${org.customerId},true),
             (${randomUUID()},${org.orgId},${entry},2,${org.accounts.bank},${org.subsidiaryId},${amount === "100" ? "-100" : "100"},'CAD',${amount === "100" ? "-100" : "100"},1,null,false)`);
    await db.execute(sql`update journal_entries set status='posted',posted_by=${actor} where id=${entry} and org_id=${org.orgId}`);
    return line;
  });
}

async function apply(org: ScratchOrg, actor: string, from: string, to: string) {
  const id = randomUUID();
  await db.execute(sql`
    insert into applications (id,org_id,from_line_id,to_line_id,amount,source_amount,
      source_transaction_amount,source_transaction_currency,target_transaction_amount,target_transaction_currency,
      settlement_rate,settlement_rate_source,settlement_rate_reference,applied_on,created_by)
    values (${id},${org.orgId},${from},${to},25,25,25,'CAD',25,'CAD',1,'same_currency','same transaction currency',${org.date},${actor})`);
  return id;
}

function isBookRefusal(error: unknown): boolean {
  for (let current: unknown = error; current && typeof current === "object"; current = (current as { cause?: unknown }).cause) {
    const candidate = current as { code?: string; message?: string };
    if (candidate.code === "23514" && candidate.message?.includes("share an accounting book")) return true;
  }
  return false;
}

test("application storage isolates books and preserves controlled legacy unapplication", { skip: !process.env.OPENBOOKS_DB_URL }, async (t) => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Application reviewer", "admin");
    const taxBook = randomUUID();
    await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl)
      values (${taxBook},${org.orgId},'TAX','Tax',false,true,true)`);
    const primarySource = await openLine(org, actor, org.bookId, "-100");
    const primaryTarget = await openLine(org, actor, org.bookId, "100");
    const taxSource = await openLine(org, actor, taxBook, "-100");
    const taxTarget = await openLine(org, actor, taxBook, "100");

    await t.test("primary-to-tax and tax-to-primary writes fail atomically", async () => {
      for (const [from, to] of [[primarySource, taxTarget], [taxSource, primaryTarget]]) {
        await assert.rejects(withOrgTransaction(org.orgId, () => apply(org, actor, from!, to!)), isBookRefusal);
      }
      const rows = await db.execute<{ count: number }>(sql`select count(*)::int as count from applications where org_id=${org.orgId}`);
      assert.equal(rows.rows[0]!.count, 0);
    });
    await t.test("each book independently permits valid applications", async () => {
      for (const [from, to] of [[primarySource, primaryTarget], [taxSource, taxTarget]]) {
        await withOrgTransaction(org.orgId, () => apply(org, actor, from!, to!));
      }
    });
    await t.test("forward upgrade preserves evidence and permits unapplying old cross-book mistakes", async () => {
      // Function replacement and legacy evidence are confined to one rollback:
      // other sessions never see the old policy, including parallel test files.
      const rollback = new Error("rollback legacy fixture");
      await assert.rejects(db.transaction(async (tx) => {
        await tx.execute(sql.raw(originalFunction));
        const legacyId = randomUUID();
        await tx.execute(sql`
          insert into applications (id,org_id,from_line_id,to_line_id,amount,source_amount,
            source_transaction_amount,source_transaction_currency,target_transaction_amount,target_transaction_currency,
            settlement_rate,settlement_rate_source,settlement_rate_reference,applied_on,created_by)
          values (${legacyId},${org.orgId},${primarySource},${taxTarget},25,25,25,'CAD',25,'CAD',1,'same_currency','legacy book error',${org.date},${actor})`);
        await tx.execute(sql.raw(migration));
        const preserved = await tx.execute<{ count: number }>(sql`select count(*)::int as count from applications where id=${legacyId} and unapplied_at is null`);
        assert.equal(preserved.rows[0]!.count, 1);
        await tx.execute(sql`update applications set unapplied_at=now(),updated_by=${actor},updated_at=now() where id=${legacyId}`);
        const corrected = await tx.execute<{ corrected: boolean }>(sql`select unapplied_at is not null as corrected from applications where id=${legacyId}`);
        assert.equal(corrected.rows[0]!.corrected, true);
        throw rollback;
      }), (error) => error === rollback);
    });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
