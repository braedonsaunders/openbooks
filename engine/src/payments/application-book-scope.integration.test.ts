import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "../testing/fixtures.ts";

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
    await db.execute(
      sql`update journal_entries set status='posted',posted_by=${actor} where id=${entry} and org_id=${org.orgId}`,
    );
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
  for (
    let current: unknown = error;
    current && typeof current === "object";
    current = (current as { cause?: unknown }).cause
  ) {
    const candidate = current as { code?: string; message?: string };
    if (candidate.code === "23514" && candidate.message?.includes("share an accounting book"))
      return true;
  }
  return false;
}

test(
  "application storage isolates books and keeps cross-book evidence correctable by unapplication",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async (t) => {
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
        for (const [from, to] of [
          [primarySource, taxTarget],
          [taxSource, primaryTarget],
        ]) {
          await assert.rejects(
            withOrgTransaction(org.orgId, () => apply(org, actor, from!, to!)),
            isBookRefusal,
          );
        }
        const rows = await db.execute<{ count: number }>(
          sql`select count(*)::int as count from applications where org_id=${org.orgId}`,
        );
        assert.equal(rows.rows[0]!.count, 0);
      });
      await t.test("each book independently permits valid applications", async () => {
        for (const [from, to] of [
          [primarySource, primaryTarget],
          [taxSource, taxTarget],
        ]) {
          await withOrgTransaction(org.orgId, () => apply(org, actor, from!, to!));
        }
      });
      await t.test(
        "cross-book evidence admitted by trusted replay is corrected through ordinary unapplication",
        async () => {
          // Trusted replay copies pre-validated history without the endpoint
          // checks; any cross-book row it carries must stay correctable through
          // the audited unapplication lifecycle. The fixture is confined to one
          // rollback so no other session observes the invalid evidence.
          const rollback = new Error("rollback cross-book fixture");
          await assert.rejects(
            db.transaction(async (tx) => {
              const legacyId = randomUUID();
              await tx.execute(sql`set local openbooks.migration = 'on'`);
              await tx.execute(sql`
          insert into applications (id,org_id,from_line_id,to_line_id,amount,source_amount,
            source_transaction_amount,source_transaction_currency,target_transaction_amount,target_transaction_currency,
            settlement_rate,settlement_rate_source,settlement_rate_reference,applied_on,created_by)
          values (${legacyId},${org.orgId},${primarySource},${taxTarget},25,25,25,'CAD',25,'CAD',1,'same_currency','cross-book evidence',${org.date},${actor})`);
              await tx.execute(sql`set local openbooks.migration = 'off'`);
              await tx.execute(
                sql`update applications set unapplied_at=now(),updated_by=${actor},updated_at=now() where id=${legacyId}`,
              );
              const corrected = await tx.execute<{ corrected: boolean }>(
                sql`select unapplied_at is not null as corrected from applications where id=${legacyId}`,
                "objects",
              );
              assert.deepEqual(corrected, [{ corrected: true }]);
              throw rollback;
            }),
            (error) => error === rollback,
          );
        },
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
