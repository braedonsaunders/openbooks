import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "./db.ts";
import { importSettlementBatch, postSettlementBatch, PspSettlementError } from "./psp-settlement.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

for (const policy of ["restricted account", "inactive subsidiary", "inactive book", "non-posting book"] as const) {
  test(`PSP settlement refuses ${policy} before creating a journal`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      const branchId = randomUUID();
      await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values(${branchId},${org.orgId},${org.subsidiaryId},'Settlement branch','CAD','CA')`);
      const subsidiaryId = policy === "inactive subsidiary" ? branchId : org.subsidiaryId;
      const { batchId } = await importSettlementBatch(org.orgId, actorId, {
        provider: "stripe", externalRef: `policy-${policy}`, settlementDate: org.date, currency: "CAD",
        lines: [{ kind: "charge", amount: "100", currency: "CAD" }, { kind: "fee", amount: "3", currency: "CAD" }],
      }, { bankAccountId: org.accounts.bank, feeAccountId: org.accounts.freight,
        clearingAccountId: org.accounts.clearing, subsidiaryId });
      if (policy === "restricted account") await db.execute(sql`update accounts
        set subsidiary_id=${branchId},subsidiary_include_children=false where org_id=${org.orgId} and id=${org.accounts.bank}`);
      if (policy === "inactive subsidiary") await db.execute(sql`update subsidiaries set is_active=false
        where org_id=${org.orgId} and id=${branchId}`);
      if (policy === "inactive book") await db.execute(sql`update accounting_books set is_active=false
        where org_id=${org.orgId} and id=${org.bookId}`);
      if (policy === "non-posting book") await db.execute(sql`update accounting_books set posts_gl=false
        where org_id=${org.orgId} and id=${org.bookId}`);
      await assert.rejects(postSettlementBatch(org.orgId, batchId, actorId), (error: unknown) => {
        assert.ok(error instanceof PspSettlementError);
        assert.match(error.message, policy === "restricted account" ? /restricted to another subsidiary/
          : policy === "inactive subsidiary" ? /inactive/ : /active primary posting book/);
        return true;
      });
      const state = (await db.execute<{ status: string; journal_entry_id: string | null; journals: number }>(sql`
        select status,journal_entry_id,(select count(*)::int from journal_entries where org_id=${org.orgId}) as journals
        from psp_settlement_batches where org_id=${org.orgId} and id=${batchId}`)).rows[0]!;
      assert.deepEqual(state, { status: "draft", journal_entry_id: null, journals: 0 });
      await db.execute(sql`update accounts set subsidiary_id=${org.subsidiaryId},subsidiary_include_children=true
        where org_id=${org.orgId} and id=${org.accounts.bank}`);
      await db.execute(sql`update subsidiaries set is_active=true where org_id=${org.orgId} and id=${branchId}`);
      await db.execute(sql`update accounting_books set is_active=true,posts_gl=true where org_id=${org.orgId} and id=${org.bookId}`);
      const result = await postSettlementBatch(org.orgId, batchId, actorId);
      assert.ok(result.entryId);
      assert.deepEqual(await postSettlementBatch(org.orgId, batchId, actorId), result);
    } finally { await dropScratchOrg(org.orgId); }
  });
}

test("PSP posting rechecks an account restriction committed while it waits", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  const writer = await pool.connect();
  let pending: Promise<PromiseSettledResult<{ entryId: string }>> | undefined;
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const branchId = randomUUID();
    await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
      values(${branchId},${org.orgId},${org.subsidiaryId},'Concurrent settlement branch','CAD','CA')`);
    const { batchId } = await importSettlementBatch(org.orgId, actorId, {
      provider: "stripe", externalRef: "concurrent-policy", settlementDate: org.date, currency: "CAD",
      lines: [{ kind: "charge", amount: "100", currency: "CAD" }],
    }, { bankAccountId: org.accounts.bank, feeAccountId: org.accounts.freight,
      clearingAccountId: org.accounts.clearing, subsidiaryId: org.subsidiaryId });
    await writer.query("begin");
    await writer.query("select set_config('app.bypass_rls','on',true)");
    await writer.query("update accounts set subsidiary_id=$1,subsidiary_include_children=false where org_id=$2 and id=$3",
      [branchId, org.orgId, org.accounts.bank]);
    const pid = (await writer.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    pending = postSettlementBatch(org.orgId, batchId, actorId)
      .then((value) => ({ status: "fulfilled", value }), (reason: unknown) => ({ status: "rejected", reason }));
    let blocked = false;
    for (let attempt = 0; attempt < 400; attempt++) {
      const count = (await pool.query<{ n: number }>(
        "select count(*)::int as n from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))", [pid],
      )).rows[0]!.n;
      if (count) { blocked = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(blocked, "posting must wait for the account policy write");
    await writer.query("commit");
    const result = await pending;
    assert.equal(result.status, "rejected");
    if (result.status !== "rejected") assert.fail("restriction must refuse posting");
    assert.ok(result.reason instanceof PspSettlementError);
    assert.match(result.reason.message, /restricted to another subsidiary/);
    const state = (await db.execute<{ status: string; journals: number }>(sql`
      select status,(select count(*)::int from journal_entries where org_id=${org.orgId}) as journals
      from psp_settlement_batches where org_id=${org.orgId} and id=${batchId}`)).rows[0]!;
    assert.deepEqual(state, { status: "draft", journals: 0 });
  } finally {
    await writer.query("rollback");
    writer.release();
    await pending;
    await dropScratchOrg(org.orgId);
  }
});
