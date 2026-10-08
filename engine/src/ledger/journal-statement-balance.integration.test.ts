import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withMaintenanceTransaction, withOrgTransaction, withTransactionSavepoint } from "../platform/db.ts";
import { errorChainMatches } from "../testing/error-chain.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

test("bulk journal balance checks keep each entry, subsidiary and configured segment independent and roll back refusals", {
  skip: !process.env.OPENBOOKS_DB_URL,
}, async () => {
  const org = await createScratchOrg();
  let failure: unknown;
  try {
    const child = randomUUID();
    await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,code,name,currency,is_active)
      values(${child},${org.orgId},${org.subsidiaryId},'BRANCH','Branch','CAD',true)`);
    const evidence = async () => (await db.execute<{ evidence: unknown }>(sql`
      select jsonb_build_object(
        'entries',(select coalesce(jsonb_agg(to_jsonb(e) order by e.id),'[]'::jsonb)
          from journal_entries e where e.org_id=${org.orgId}),
        'lines',(select coalesce(jsonb_agg(to_jsonb(l) order by l.id),'[]'::jsonb)
          from journal_lines l where l.org_id=${org.orgId}),
        'activity',(select coalesce(jsonb_agg(to_jsonb(g) order by g.account_id,g.subsidiary_id),'[]'::jsonb)
          from gl_month_activity g where g.org_id=${org.orgId})) as evidence`)).rows[0]!.evidence;
    const headers = async (ids: readonly string[], status: "draft" | "posted" = "posted") => {
      await db.execute(sql`insert into journal_entries
        (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin,posted_at)
        values ${sql.join(ids.map(id => sql`(${id},${org.orgId},${org.bookId},${org.subsidiaryId},
          ${`BALANCE-${id}`},${org.date},${org.periodId},${status},'manual',
          case when ${status}='posted' then now() else null end)`),sql`,`)}`);
    };
    const lines = async (rows: readonly {
      entryId: string; number: number; amount: string; subsidiaryId?: string; dims?: Record<string,string>;
    }[]) => {
      await db.execute(sql`insert into journal_lines
        (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,extra_dims)
        values ${sql.join(rows.map(row => sql`(${org.orgId},${row.entryId},${row.number},
          ${row.amount.startsWith('-') ? org.accounts.revenue : org.accounts.bank},
          ${row.subsidiaryId ?? org.subsidiaryId},${row.amount},'CAD',${row.amount},1,
          ${JSON.stringify(row.dims ?? {})}::jsonb)`),sql`,`)}`);
    };
    const ids = Array.from({ length: 16 }, () => randomUUID());
    await withMaintenanceTransaction(null, async () => {
      await db.execute(sql`select set_config('openbooks.migration','on',true),
        set_config('openbooks.amend','on',true),set_config('openbooks.clone','on',true)`);
      await headers(ids);
      await lines(ids.flatMap(entryId => [
        { entryId, number: 1, amount: '1.2500' },
        { entryId, number: 2, amount: '-1.2500' },
      ]));
      await db.execute(sql`set constraints all immediate`);
      assert.deepEqual((await db.execute(sql`select * from openbooks_gl_activity_verify(${org.orgId})`)).rows,[]);
      const before = await evidence();
      await db.execute(sql`insert into journal_lines
        (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
        select org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate
        from journal_lines where org_id=${org.orgId} and false`);
      assert.deepEqual(await evidence(),before,"an empty statement must leave retained journal evidence unchanged");
      const refusal = async (work: () => Promise<void>, message: RegExp) => {
        await assert.rejects(withTransactionSavepoint(db, async () => {
          await db.execute(sql`set constraints all deferred`);
          await work();
        }), (error: unknown) => errorChainMatches(error,message));
        assert.deepEqual(await evidence(),before,"failed statements must preserve all prior journal and aggregate rows");
      };
      // The batch totals zero, but each affected entry is independently wrong.
      // A validator that checks only the combined batch would admit it.
      await refusal(async () => {
        await lines([
          { entryId: ids[0]!, number: 3, amount: '1' },
          { entryId: ids[1]!, number: 3, amount: '-1' },
        ]);
      },/journal entry .* does not balance \(sum = -?1\.0000\)/);
      await refusal(async () => {
        const id = randomUUID();
        await headers([id]);
        await lines([
          { entryId: id, number: 1, amount: '10' },
          { entryId: id, number: 2, amount: '-10', subsidiaryId: child },
        ]);
      },/journal entry .* does not balance for subsidiary .* \(sum = -?10\.0000\)/);
      // Reversing the signs preserves batch-level subsidiary totals too;
      // subsidiary balances must still be enforced per entry.
      await refusal(async () => {
        const [a,b] = [randomUUID(),randomUUID()];
        await headers([a,b]);
        await lines([
          { entryId: a, number: 1, amount: '10' },
          { entryId: a, number: 2, amount: '-10', subsidiaryId: child },
          { entryId: b, number: 1, amount: '-10' },
          { entryId: b, number: 2, amount: '10', subsidiaryId: child },
        ]);
      },/does not balance for subsidiary/);
      await refusal(async () => {
        await db.execute(sql`update journal_lines set amount=amount+1,txn_amount=txn_amount+1
          where org_id=${org.orgId} and entry_id=${ids[0]} and line_number=1`);
      },/lines of a posted journal entry are immutable/);
      await refusal(async () => {
        await db.execute(sql`delete from journal_lines
          where org_id=${org.orgId} and entry_id=${ids[0]} and line_number=2`);
      },/lines of a posted journal entry are immutable/);
    });

    const segmentId = randomUUID();
    const valueA = randomUUID();
    const valueB = randomUUID();
    await db.execute(sql`insert into segment_definitions(id,org_id,key,name,plural_name,source_kind,is_balancing)
      values(${segmentId},${org.orgId},'allocation','Allocation','Allocations','custom',true)`);
    await db.execute(sql`insert into segment_values(id,org_id,segment_id,code,name)
      values(${valueA},${org.orgId},${segmentId},'A','Allocation A'),
            (${valueB},${org.orgId},${segmentId},'B','Allocation B')`);
    const beforeSegment = await evidence();
    await assert.rejects(withMaintenanceTransaction(null, async () => {
      await db.execute(sql`select set_config('openbooks.migration','on',true),
        set_config('openbooks.amend','on',true),set_config('openbooks.clone','on',true)`);
      const [a,b] = [randomUUID(),randomUUID()];
      await headers([a,b]);
      await lines([
        { entryId: a, number: 1, amount: '10', dims: { allocation: valueA } },
        { entryId: a, number: 2, amount: '-10', dims: { allocation: valueB } },
        { entryId: b, number: 1, amount: '-10', dims: { allocation: valueA } },
        { entryId: b, number: 2, amount: '10', dims: { allocation: valueB } },
      ]);
    }), (error: unknown) => errorChainMatches(error,/journal entry .* does not balance for segment allocation value .* \(sum = -?10\.0000\)/));
    assert.deepEqual(await evidence(),beforeSegment);
    await assert.rejects(withOrgTransaction(org.orgId, async () => {
      await db.execute(sql`select set_config('openbooks.migration','on',true),
        set_config('openbooks.amend','on',true),set_config('openbooks.clone','on',true)`);
      await lines([{ entryId: ids[0]!, number: 3, amount: '1' }]);
    }), (error: unknown) => errorChainMatches(error,/lines of a posted journal entry are immutable/));
    assert.deepEqual(await evidence(),beforeSegment);

    await withMaintenanceTransaction(null, async () => {
      await db.execute(sql`select set_config('openbooks.migration','on',true),
        set_config('openbooks.amend','on',true),set_config('openbooks.clone','on',true)`);
      const balanced = randomUUID();
      await headers([balanced]);
      await lines([
        { entryId: balanced, number: 1, amount: '10', dims: { allocation: valueA } },
        { entryId: balanced, number: 2, amount: '-10', dims: { allocation: valueA } },
        { entryId: balanced, number: 3, amount: '5', dims: { allocation: valueB } },
        { entryId: balanced, number: 4, amount: '-5', dims: { allocation: valueB } },
      ]);
      await db.execute(sql`set constraints all immediate`);
      assert.equal((await db.execute(sql`select 1 from journal_lines
        where org_id=${org.orgId} and entry_id=${balanced}`)).rows.length,4);
    });

    const draft = randomUUID();
    await withOrgTransaction(org.orgId, async () => {
      await headers([draft],'draft');
      await lines([{ entryId: draft, number: 1, amount: '2' }]);
    });
    await withOrgTransaction(org.orgId, async () => {
      await lines([{ entryId: draft, number: 2, amount: '-2' }]);
      const posted = await db.execute(sql`update journal_entries set status='posted',posted_at=now()
        where org_id=${org.orgId} and id=${draft} returning id`);
      assert.equal(posted.rows.length,1,"drafts can be constructed across statements and post only when balanced");
    });
    assert.deepEqual((await db.execute(sql`select * from openbooks_gl_activity_verify(${org.orgId})`)).rows,[]);
  } catch (error) {
    failure=error;
    throw error;
  } finally {
    try { await dropScratchOrg(org.orgId); }
    catch (cleanup) {
      if (failure) throw new AggregateError([failure,cleanup],"Journal balance fixture cleanup failed",{ cause: failure });
      throw cleanup;
    }
  }
});
