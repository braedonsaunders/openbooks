import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { reverseProjectGlEntry } from "./project-recognition.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "./test-fixtures.ts";

test("project GL reversal preserves original FX and complete line evidence", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Reversal evidence", "admin");
    const entryId = randomUUID();
    await db.transaction(async (tx) => {
      const segmentId = randomUUID(), valueId = randomUUID();
      await tx.execute(sql`insert into segment_definitions(id,org_id,key,name,plural_name)
        values(${segmentId},${org.orgId},'cost_pool','Cost pool','Cost pools')`);
      await tx.execute(sql`insert into segment_values(id,org_id,segment_id,name)
        values(${valueId},${org.orgId},${segmentId},'North')`);
      await tx.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,
        posting_date,period_id,status,origin,created_by,updated_by)
        values(${entryId},${org.orgId},${org.bookId},${org.subsidiaryId},'PROJECT-FX-MIRROR',
          ${org.date},${org.periodId},'draft','manual',${actor},${actor})`);
      await tx.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,
        amount,currency,txn_amount,fx_rate,location_id,party_id,quantity,unit,custom,extra_dims,memo)
        values
        (${org.orgId},${entryId},3,${org.accounts.adjustment},${org.subsidiaryId},
          125,'USD',100,1.25,${org.locationId},${org.vendorId},2.5,'hours',
          '{"evidence":"original-cost"}'::jsonb,${JSON.stringify({ cost_pool: valueId })}::jsonb,'Original evidence'),
        (${org.orgId},${entryId},7,${org.accounts.bank},${org.subsidiaryId},
          -125,'USD',-100,1.25,null,null,null,null,'{}'::jsonb,'{}'::jsonb,'Cash funding')`);
      await tx.execute(sql`update journal_entries set status='posted',posted_at=now(),posted_by=${actor}
        where org_id=${org.orgId} and id=${entryId}`);
    });
    const reversalId = await reverseProjectGlEntry(org.orgId, actor, entryId, "Correct entire original evidence", org.date);
    assert.ok(reversalId);
    const evidence = (await db.execute<{ exact: number; count: number }>(sql`
      select count(*)::int as count,count(*) filter(where
        r.amount=-s.amount and r.txn_amount=-s.txn_amount
        and r.quantity is not distinct from -s.quantity
        and (to_jsonb(r)-array['id','entry_id','amount','txn_amount','quantity']::text[])
          =(to_jsonb(s)-array['id','entry_id','amount','txn_amount','quantity']::text[]))::int as exact
      from journal_lines s join journal_lines r on r.org_id=s.org_id and r.line_number=s.line_number
        and r.entry_id=${reversalId}
      where s.org_id=${org.orgId} and s.entry_id=${entryId}`)).rows[0]!;
    assert.deepEqual(evidence, { count: 2, exact: 2 });
    const again = await reverseProjectGlEntry(org.orgId, actor, entryId, "Repeat same controlled reversal", org.date);
    assert.equal(again, null);
    const totals = (await db.execute<{ amount: string; txn: string; quantity: string }>(sql`
      select sum(amount)::text as amount,sum(txn_amount)::text as txn,sum(quantity)::text as quantity
      from journal_lines where org_id=${org.orgId} and entry_id in(${entryId},${reversalId})
        and location_id=${org.locationId}`)).rows[0]!;
    assert.deepEqual(totals, { amount: "0.0000", txn: "0.0000", quantity: "0.0000" });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
