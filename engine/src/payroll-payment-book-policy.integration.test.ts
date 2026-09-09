import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { calculatedRun, seedAdoption } from "./payroll-filing-test-fixtures.ts";
import { recordPayRunPayment } from "./payroll-payment.ts";
import { commitPayRun } from "./payroll-run.ts";
import { postDocument } from "./posting.ts";
import { dropScratchOrgReporting } from "./test-fixtures.ts";

for (const policy of ["inactive", "non-posting", "non-primary"] as const) {
  test(`payroll settlement book policy: ${policy}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const fx = await seedAdoption();
    try {
      const { input } = await calculatedRun(fx);
      await commitPayRun(input);
      const accounts = (await db.execute<{ id: string; type: string }>(sql`
        select id,type from accounts where org_id=${fx.orgId}`)).rows;
      const account = (type: string) => {
        const id = accounts.find((row) => row.type === type)?.id;
        assert.ok(id, `fixture account ${type}`);
        return id;
      };
      const bankAccountId = account("asset_bank");
      await db.execute(sql`update documents set status='approved' where org_id=${fx.orgId} and id=${input.documentId}`);
      await postDocument(input.documentId, {
        control: { ar: account("asset_receivable"), ap: account("liability_payable"), bank: bankAccountId },
      });
      const source = (await db.execute<{ id: string; book_id: string }>(sql`
        select e.id,e.book_id from documents d join journal_entries e on e.id=d.posted_entry_id and e.org_id=d.org_id
        where d.org_id=${fx.orgId} and d.id=${input.documentId}`)).rows[0]!;
      if (policy === "inactive") await db.execute(sql`update accounting_books set is_active=false where org_id=${fx.orgId} and id=${source.book_id}`);
      if (policy === "non-posting") await db.execute(sql`update accounting_books set posts_gl=false where org_id=${fx.orgId} and id=${source.book_id}`);
      if (policy === "non-primary") {
        // Model imported/legacy history. Ordinary reassignment after posting
        // is now refused by the primary-book history guard. Only fixture
        // construction uses the trusted migration exemption; settlement below
        // runs after this transaction ends with every normal control enabled.
        await db.transaction(async (tx) => {
          await tx.execute(sql`set local openbooks.migration='on'`);
          await tx.execute(sql`update accounting_books set is_primary=false where org_id=${fx.orgId} and id=${source.book_id}`);
          await tx.execute(sql`insert into accounting_books(org_id,code,name,is_primary,is_active,posts_gl)
            values(${fx.orgId},'NEW','New primary book',true,true,true)`);
        });
      }
      const pay = () => recordPayRunPayment({ ...input, bankAccountId });
      if (policy !== "non-primary") {
        await assert.rejects(pay, /active posting book/);
        const state = (await db.execute<{ paid_at: string | null; paid_entry_id: string | null; entries: number; applications: number }>(sql`
          select paid_at,paid_entry_id,
            (select count(*)::int from journal_entries where org_id=${fx.orgId}) as entries,
            (select count(*)::int from applications where org_id=${fx.orgId}) as applications
          from pay_runs where org_id=${fx.orgId} and document_id=${input.documentId}`)).rows[0]!;
        assert.deepEqual(state, { paid_at: null, paid_entry_id: null, entries: 1, applications: 0 });
        await db.execute(sql`update accounting_books set is_active=true,posts_gl=true where org_id=${fx.orgId} and id=${source.book_id}`);
      }
      const payment = await pay();
      const entry = (await db.execute<{ book_id: string; status: string }>(sql`
        select book_id,status from journal_entries where org_id=${fx.orgId} and id=${payment.entryId}`)).rows[0]!;
      assert.deepEqual(entry, { book_id: source.book_id, status: "posted" });
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  });
}
