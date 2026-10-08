import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withMaintenanceTransaction, withOrgTransaction, withTransactionSavepoint } from "../platform/db.ts";
import { errorChainMatches } from "../testing/error-chain.ts";
import { createScratchOrg, dropScratchOrgReporting } from "../testing/fixtures.ts";

test("bulk journal inserts maintain exact summaries with one write per group and preserve tenant refusals and rollback", {
  skip: !process.env.OPENBOOKS_DB_URL,
}, async () => {
  const org = await createScratchOrg();
  const foreign = await createScratchOrg();
  const entryId = randomUUID();
  let failure: unknown;
  try {
    const summary = async () => (await db.execute(sql`
      select account_id,debit_total::text,credit_total::text,line_count::text
        from gl_month_activity where org_id=${org.orgId}
       order by account_id`)).rows;
    await withMaintenanceTransaction(null, async () => {
      // The same native maintenance flags used for retained history permit
      // posted INSERTs; account, tenant and deferred balance guards still run.
      await db.execute(sql`select set_config('openbooks.migration','on',true),
        set_config('openbooks.amend','on',true),set_config('openbooks.clone','on',true)`);
      await db.execute(sql`insert into journal_entries
        (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,posted_at)
        values(${entryId},${org.orgId},${org.bookId},${org.subsidiaryId},${`BULK-${entryId}`},
          ${org.date},${org.periodId},'posted','manual',now())`);
      const writes = async () => {
        await db.execute(sql`select pg_stat_clear_snapshot()`);
        const row = (await db.execute<{ inserted: string; updated: string }>(sql`
          select n_tup_ins::text as inserted,n_tup_upd::text as updated
          from pg_stat_xact_user_tables where relid='public.gl_month_activity'::regclass`)).rows[0]!;
        return BigInt(row.inserted) + BigInt(row.updated);
      };
      const beforeWrites = await writes();
      const values = Array.from({ length: 24 }, (_, index) => sql`
        (${org.orgId},${entryId},${index + 1},${index % 2 === 0 ? org.accounts.bank : org.accounts.revenue},
         ${org.subsidiaryId},${index % 2 === 0 ? '1.25' : '-1.25'},'CAD',
         ${index % 2 === 0 ? '1.25' : '-1.25'},1)`);
      await db.execute(sql`insert into journal_lines
        (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
        values ${sql.join(values,sql`,`)}`);
      assert.equal(await writes() - beforeWrites, 2n, "bulk load must not rewrite a summary for every line");
      const afterWrites = await writes();
      await db.execute(sql`insert into journal_lines
        (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
        select org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate
        from journal_lines where org_id=${org.orgId} and false`);
      assert.equal(await writes(), afterWrites, "an empty inserted set must not touch summaries");
      await db.execute(sql`set constraints all immediate`);
      const expected = [
        { account_id: org.accounts.bank, debit_total: '15.0000', credit_total: '0.0000', line_count: '12' },
        { account_id: org.accounts.revenue, debit_total: '0.0000', credit_total: '15.0000', line_count: '12' },
      ].sort((a,b) => a.account_id.localeCompare(b.account_id));
      assert.deepEqual(await summary(), expected);
      assert.deepEqual((await db.execute(sql`select * from openbooks_gl_activity_verify(${org.orgId})`)).rows, []);
      const sentinel = new Error("Roll back an inserted journal batch");
      await assert.rejects(withTransactionSavepoint(db, async () => {
        await db.execute(sql`set constraints all deferred`);
        await db.execute(sql`insert into journal_lines
          (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
          values(${org.orgId},${entryId},25,${org.accounts.bank},${org.subsidiaryId},2,'CAD',2,1),
                (${org.orgId},${entryId},26,${org.accounts.revenue},${org.subsidiaryId},-2,'CAD',-2,1)`);
        assert.notDeepEqual(await summary(), expected);
        throw sentinel;
      }), (error: unknown) => error === sentinel);
      assert.deepEqual(await summary(), expected);
    });
    const original = await summary();
    await assert.rejects(withOrgTransaction(org.orgId, () => db.execute(sql`
      insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
      values(${org.orgId},${entryId},25,${org.accounts.bank},${org.subsidiaryId},1,'CAD',1,1)`)),
    (error: unknown) => errorChainMatches(error,/lines of a posted journal entry are immutable/));
    await assert.rejects(withOrgTransaction(foreign.orgId, () => db.execute(sql`
      insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
      values(${foreign.orgId},${entryId},25,${foreign.accounts.bank},${foreign.subsidiaryId},1,'CAD',1,1)`)),
    (error: unknown) => errorChainMatches(error,/does not exist in organization|foreign key/));
    assert.deepEqual(await summary(), original);
    assert.equal((await db.execute(sql`select 1 from gl_month_activity where org_id=${foreign.orgId}`)).rows.length,0);
    await withOrgTransaction(foreign.orgId, async () => {
      const draftId = randomUUID();
      await db.execute(sql`insert into journal_entries
        (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
        values(${draftId},${foreign.orgId},${foreign.bookId},${foreign.subsidiaryId},${`DRAFT-${draftId}`},
          ${foreign.date},${foreign.periodId},'draft','manual')`);
      await db.execute(sql`insert into journal_lines
        (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
        values(${foreign.orgId},${draftId},1,${foreign.accounts.bank},${foreign.subsidiaryId},3,'CAD',3,1),
              (${foreign.orgId},${draftId},2,${foreign.accounts.revenue},${foreign.subsidiaryId},-3,'CAD',-3,1)`);
      assert.equal((await db.execute(sql`select 1 from gl_month_activity where org_id=${foreign.orgId}`)).rows.length,0);
      await db.execute(sql`update journal_entries set status='posted',posted_at=now()
        where org_id=${foreign.orgId} and id=${draftId}`);
      assert.equal((await db.execute(sql`select 1 from gl_month_activity where org_id=${foreign.orgId}`)).rows.length,2);
      assert.deepEqual((await db.execute(sql`select * from openbooks_gl_activity_verify(${foreign.orgId})`)).rows,[]);
    });
    assert.deepEqual(await summary(), original, "another tenant's posting cannot change these summaries");
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([
      dropScratchOrgReporting(foreign.orgId), dropScratchOrgReporting(org.orgId),
    ]);
    const errors = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(failure ? [failure,...errors] : errors,
      'Journal aggregate fixture cleanup failed', { cause: failure ?? errors[0] });
  }
});
