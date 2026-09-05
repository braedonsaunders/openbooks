import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg } from "./db.ts";
import { issueSalesOrder } from "./sales-orders.ts";
import { requestDocumentVoid, DocumentVoidError } from "./document-void.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "./test-fixtures.ts";

async function seed(org: ScratchOrg, actor: string, kind: "quote" | "sales_order") {
  const id = randomUUID();
  await db.execute(sql`insert into documents (id,org_id,kind,document_number,document_date,currency,party_id,subsidiary_id)
    values (${id},${org.orgId},${kind},${`REV-${id}`},${org.date},'CAD',${org.customerId},${org.subsidiaryId})`);
  await db.execute(sql`insert into document_lines (org_id,document_id,line_number,account_id,quantity,unit_price,amount)
    values (${org.orgId},${id},1,${org.accounts.revenue},'1','100','100')`);
  if (kind === "quote") await db.execute(sql`update documents set status='approved',submitted_by=${actor} where id=${id}`);
  await db.execute(sql`update documents set updated_at=date_trunc('second',now()+interval '1 day')+interval '123450 microseconds' where id=${id}`);
  const revision = (await db.execute<{ revision: string }>(sql`select to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as revision from documents where id=${id}`)).rows[0]!.revision;
  return { id, revision };
}

for (const operation of ["issue", "void"] as const) {
  test(`${operation} rejects a revision superseded by one microsecond`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Revision controller", "admin");
      const doc = await seed(org, actor, operation === "issue" ? "sales_order" : "quote");
      await db.execute(sql`update documents set memo='Unreviewed edit',updated_at=updated_at+interval '1 microsecond' where id=${doc.id}`);
      const run = operation === "issue"
        ? issueSalesOrder({ orgId: org.orgId, actorId: actor, salesOrderId: doc.id, expectedUpdatedAt: doc.revision })
        : requestDocumentVoid({ orgId: org.orgId, actorId: actor, documentId: doc.id, expectedUpdatedAt: doc.revision, reversalDate: org.date, reason: "Cancel reviewed revision" });
      await assert.rejects(run, /changed after you opened it/);
      assert.equal((await db.execute<{ status: string }>(sql`select status from documents where id=${doc.id}`)).rows[0]!.status, operation === "issue" ? "draft" : "approved");
    } finally { await dropScratchOrg(org.orgId); }
  });
}

for (const date of ["2026-02-30", "0000-01-01", "", "  "]) {
  test(`void refuses an explicitly invalid calendar instruction ${JSON.stringify(date)}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = await createScratchUser(org.orgId, "Void controller", "admin");
      const doc = await seed(org, actor, "quote");
      await assert.rejects(requestDocumentVoid({ orgId: org.orgId, actorId: actor, documentId: doc.id,
        expectedUpdatedAt: doc.revision, reversalDate: date, reason: "Reject invalid calendar instruction" }),
        error => error instanceof DocumentVoidError && /reversalDate must be a valid/.test(error.message));
      assert.equal((await db.execute<{ status: string }>(sql`select status from documents where id=${doc.id}`)).rows[0]!.status, "approved");
    } finally { await dropScratchOrg(org.orgId); }
  });
}

test("void rechecks the reviewed revision after a concurrent edit commits", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  let release = () => {};
  let edit: Promise<unknown> | undefined;
  let command: ReturnType<typeof requestDocumentVoid> | undefined;
  try {
    const actor = await createScratchUser(org.orgId, "Void controller", "admin");
    const doc = await seed(org, actor, "quote");
    let ready!: () => void, pid = 0;
    const staged = new Promise<void>(resolve => { ready = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    edit = withOrg(org.orgId, async () => {
      pid = (await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
      await db.execute(sql`update documents set memo='Concurrent edit',updated_at=updated_at+interval '1 second' where id=${doc.id}`);
      ready(); await hold;
    });
    await Promise.race([staged, edit]);
    command = requestDocumentVoid({ orgId: org.orgId, actorId: actor, documentId: doc.id,
      expectedUpdatedAt: doc.revision, reversalDate: org.date, reason: "Cancel reviewed revision" });
    let settled = false, blocked = false;
    void command.then(() => { settled = true; }, () => { settled = true; });
    const deadline = Date.now()+10_000;
    while (!settled && Date.now()<deadline) {
      blocked = (await db.execute<{ blocked: boolean }>(sql`select exists(select 1 from pg_stat_activity
        where datname=current_database() and ${pid}=any(pg_blocking_pids(pid))) as blocked`)).rows[0]!.blocked;
      if (blocked) break;
      await new Promise(resolve => setTimeout(resolve,10));
    }
    assert.ok(blocked, "void must reach the aggregate lock");
    release(); await edit;
    await assert.rejects(command, /changed after you opened it/);
    assert.deepEqual((await db.execute(sql`select status,memo,void_requested_at from documents where id=${doc.id}`)).rows[0],
      { status: "approved", memo: "Concurrent edit", void_requested_at: null });
  } finally { release(); await Promise.allSettled([edit,command]); await dropScratchOrg(org.orgId); }
});
