import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { db, env } from "./db.ts";
import { createScratchOrg, seedFlowActors, dropScratchOrg } from "./test-fixtures.ts";
import { receiveInventory, issueInventory, getOnHand } from "./inventory.ts";
import { writeDownInventoryToNrv, reverseInventoryWritedown } from "./inventory-nrv.ts";

test("NRV serializes its layer snapshot with an in-flight receipt", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  const receiptWriter = new pg.Client({ connectionString: env.OPENBOOKS_DB_URL });
  let pending: ReturnType<typeof writeDownInventoryToNrv> | undefined;
  try {
    assert.ok(env.OPENBOOKS_DB_URL, "explicit disposable database connection is required");
    await receiptWriter.connect();
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const receipt = { itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "10", unitCost: "10", subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: "2026-07-15" };
    await receiveInventory(org.orgId, actor, receipt);
    await receiptWriter.query("begin");
    await receiptWriter.query("select set_config('app.bypass_rls','on',true)");
    await receiptWriter.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`inventory:${org.items.fifo}:${org.stockLocationId}`]);
    await receiptWriter.query("select id from cost_layers where org_id=$1 and item_id=$2 for update", [org.orgId, org.items.fifo]);
    const pid = (await receiptWriter.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    pending = writeDownInventoryToNrv(org.orgId, actor, { itemId: org.items.fifo, stockLocationId: org.stockLocationId, subsidiaryId: org.subsidiaryId, date: "2026-07-16", nrvPerUnit: "6" });
    void pending.catch(() => {});
    let blocked = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const waiting = await receiptWriter.query<{ blocked: boolean }>("select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked", [pid]);
      if (waiting.rows[0]!.blocked) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(blocked, "remeasurement reaches the held inventory fence before receipt commit");
    await receiveInventory(org.orgId, actor, { ...receipt, date: "2026-07-16", tx: drizzle({ client: receiptWriter }) });
    await receiptWriter.query("commit");
    await pending;
    assert.equal((await getOnHand(org.orgId, org.items.fifo, org.stockLocationId)).value, "120.0000");
    const issued = await issueInventory(org.orgId, actor, { itemId: org.items.fifo, stockLocationId: org.stockLocationId, subsidiaryId: org.subsidiaryId, quantity: "1", offsetAccountId: org.accounts.cogs, date: "2026-07-17" });
    assert.equal(issued.value, "-6.0000", "FIFO must use a coherent remeasurement of both receipt layers");
  } finally {
    await receiptWriter.query("rollback").catch(() => {});
    if (pending) await pending.catch(() => {});
    await receiptWriter.end();
    await dropScratchOrg(org.orgId);
  }
});

for (const operation of ["write-down", "reversal"] as const) {
  test(`NRV waits for reviewed accounting configuration: ${operation}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    const editor = new pg.Client({ connectionString: env.OPENBOOKS_DB_URL });
    let pending: ReturnType<typeof writeDownInventoryToNrv> | undefined;
    try {
      await editor.connect();
      const actor = (await seedFlowActors(org.orgId)).adminId;
      await db.execute(sql`update orgs set settings=settings || '{"reportingFramework":"ifrs"}'::jsonb where id=${org.orgId}`);
      await receiveInventory(org.orgId, actor, {
        itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "10", unitCost: "10",
        subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
      });
      const common = { itemId: org.items.fifo, stockLocationId: org.stockLocationId, subsidiaryId: org.subsidiaryId, date: org.date };
      if (operation === "reversal") await writeDownInventoryToNrv(org.orgId, actor, { ...common, nrvPerUnit: "6" });
      await editor.query("begin");
      await editor.query("select set_config('app.bypass_rls','on',true)");
      await editor.query("update item_inventory_profiles set adjustment_account_id=$1 where org_id=$2 and item_id=$3", [org.accounts.freight, org.orgId, org.items.fifo]);
      const pid = (await editor.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      pending = operation === "reversal"
        ? reverseInventoryWritedown(org.orgId, actor, { ...common, nrvPerUnit: "10" })
        : writeDownInventoryToNrv(org.orgId, actor, { ...common, nrvPerUnit: "6" });
      let completed = false;
      void pending.then(() => { completed = true; }, () => { completed = true; });
      let blocked = false;
      const deadline = Date.now() + 10_000;
      while (!completed && Date.now() < deadline) {
        const waiting = await editor.query<{ blocked: boolean }>("select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked", [pid]);
        if (waiting.rows[0]!.blocked) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.ok(blocked, "remeasurement must wait for the profile edit before reading accounts or layers");
      await editor.query("commit");
      const result = await pending;
      const accounts = (await db.execute<{ account_id: string }>(sql`select account_id from journal_lines where org_id=${org.orgId} and entry_id=${result.entryId} and account_id<>${org.accounts.invAsset}`)).rows;
      assert.deepEqual(accounts, [{ account_id: org.accounts.freight }]);
    } finally {
      await editor.query("rollback").catch(() => {});
      if (pending) await pending.catch(() => {});
      await editor.end();
      await dropScratchOrg(org.orgId);
    }
  });
}
