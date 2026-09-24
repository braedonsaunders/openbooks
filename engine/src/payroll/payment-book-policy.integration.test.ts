import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { calculatedRun, seedAdoption } from "./filing-test-fixtures.ts";
import { recordPayRunPayment } from "./payment.ts";
import { commitPayRun } from "./run-commit.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";

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
      if (policy === "non-primary") {
        // Undo the legacy flip the same way it was seeded: with posted
        // history the guard refuses the pooled-slot reset's is_primary
        // restore, failing the release after the test itself passed.
        await db.transaction(async (tx) => {
          await tx.execute(sql`set local openbooks.migration='on'`);
          await tx.execute(sql`delete from accounting_books where org_id=${fx.orgId} and code='NEW'`);
          await tx.execute(sql`update accounting_books set is_primary=true where org_id=${fx.orgId} and id=${source.book_id}`);
        });
      }
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  });
}

test("payroll settlement into a closed period is refused by name; reopened it posts", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  // The bypass defect: resolveCoveringPeriod returned the period without
  // checking its status, and the settlement entry was flipped draft→posted by
  // a direct UPDATE past the posting kernel — so a closed-period paidOn either
  // landed posted history in a closed period or died with a driver error. The
  // kernel's own period gate now refuses by name before the first write.
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
    const payDate = (await db.execute<{ pay_date: string }>(sql`
      select pay_date::text as pay_date from pay_runs where org_id=${fx.orgId} and document_id=${input.documentId}`)).rows[0]!.pay_date;
    const period = (await db.execute<{ id: string }>(sql`
      select id from accounting_periods
       where org_id=${fx.orgId} and starts_on <= ${payDate} and ends_on >= ${payDate}
       limit 1`)).rows[0]!;
    assert.ok(period, `a covering period for ${payDate}`);

    await db.execute(sql`
      insert into period_locks (org_id, period_id, book_id, subsidiary_id, module, state, reason, locked_at, locked_by)
      values (${fx.orgId}, ${period.id}, ${source.book_id}, null, 'gl', 'closed',
              'close the books on schedule', now(), ${fx.actorId})`);

    await assert.rejects(
      recordPayRunPayment({ ...input, bankAccountId, paidOn: payDate }),
      /cannot record payment on .*GL is closed for this period/,
    );
    const refused = (await db.execute<{ paid_at: string | null; paid_entry_id: string | null; entries: number; applications: number }>(sql`
      select paid_at,paid_entry_id,
        (select count(*)::int from journal_entries where org_id=${fx.orgId}) as entries,
        (select count(*)::int from applications where org_id=${fx.orgId}) as applications
      from pay_runs where org_id=${fx.orgId} and document_id=${input.documentId}`)).rows[0]!;
    assert.deepEqual(refused, { paid_at: null, paid_entry_id: null, entries: 1, applications: 0 });

    await db.execute(sql`
      delete from period_locks
       where org_id=${fx.orgId} and period_id=${period.id} and book_id=${source.book_id}`);
    const payment = await recordPayRunPayment({ ...input, bankAccountId, paidOn: payDate });
    const entry = (await db.execute<{ book_id: string; status: string; period_id: string }>(sql`
      select book_id,status,period_id from journal_entries where org_id=${fx.orgId} and id=${payment.entryId}`)).rows[0]!;
    assert.deepEqual(entry, { book_id: source.book_id, status: "posted", period_id: period.id });
    const balance = (await db.execute<{ total: string }>(sql`
      select sum(amount)::text as total from journal_lines where org_id=${fx.orgId} and entry_id=${payment.entryId}`)).rows[0]!;
    assert.equal(Number(balance.total), 0, "the settlement journal balances");
    const applications = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from applications where org_id=${fx.orgId}`)).rows[0]!;
    assert.ok(applications.n > 0, "the posted settlement links to the run's open items");
  } finally {
    await dropScratchOrgReporting(fx.orgId);
  }
});
