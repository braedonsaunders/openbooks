import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool, withOrg } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { lockApplicationEvidence } from "./application-lock.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("application evidence lock holds both source documents and endpoints through its transaction", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const documentId = randomUUID();
  const entryId = randomUUID();
  const lineId = randomUUID();
  try {
    await withOrg(org.orgId, async () => {
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id,
           document_date, currency, fx_rate, subtotal, tax_total, total)
        values (${documentId}, ${org.orgId}, 'customer_invoice', 'approved', ${documentId},
          ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1', 10, 0, 10)
      `);
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id,
           status, source_document_id)
        values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${entryId},
          ${org.date}, ${org.periodId}, 'draft', ${documentId})
      `);
      await db.execute(sql`
        insert into journal_lines
          (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount,
           currency, txn_amount, fx_rate, party_id, is_open_item)
        values (${lineId}, ${org.orgId}, ${entryId}, 1, ${org.accounts.ar},
          ${org.subsidiaryId}, 10, 'CAD', 10, '1', ${org.customerId}, true)
      `);
      await db.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount,
           currency, txn_amount, fx_rate, is_open_item)
        values (${org.orgId}, ${entryId}, 2, ${org.accounts.revenue},
          ${org.subsidiaryId}, -10, 'CAD', -10, '1', false)
      `);
      await db.execute(sql`update journal_entries set status = 'posted' where id = ${entryId} and org_id = ${org.orgId}`);
    });

    let unlock!: () => void;
    let locked!: () => void;
    const lockReady = new Promise<void>((resolve) => { locked = resolve; });
    const release = new Promise<void>((resolve) => { unlock = resolve; });
    const holder = withOrg(org.orgId, () => db.transaction(async (tx) => {
      const result = await lockApplicationEvidence(tx, org.orgId, [lineId]);
      assert.deepEqual(result.documentIds, [documentId]);
      assert.deepEqual(result.lineIds, [lineId]);
      locked();
      await release;
    }));
    await lockReady;

    const contender = await pool.connect();
    try {
      await contender.query("begin");
      await contender.query(
        "select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'off', true)",
        [org.orgId],
      );
      await contender.query("set local lock_timeout = '100ms'");
      await assert.rejects(
        contender.query("select id from documents where id = $1 and org_id = $2 for update", [documentId, org.orgId]),
        (error: unknown) => (error as { code?: string }).code === "55P03",
      );
      await contender.query("rollback");
      await contender.query("begin");
      await contender.query(
        "select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'off', true)",
        [org.orgId],
      );
      await contender.query("set local lock_timeout = '100ms'");
      await assert.rejects(
        contender.query("select id from journal_lines where id = $1 and org_id = $2 for update", [lineId, org.orgId]),
        (error: unknown) => (error as { code?: string }).code === "55P03",
      );
    } finally {
      await contender.query("rollback").catch(() => undefined);
      contender.release();
      unlock();
      await holder;
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
