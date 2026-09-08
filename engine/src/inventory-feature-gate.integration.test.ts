import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool, withOrgTransaction } from "./db.ts";
import {
  adjustInventory, buildAssembly, createTransferOrder, issueInventory,
  postLandedCostVoucher, receiveInventory, receiveTransferOrder, reverseInventoryMovement,
  shipTransferOrder, transferInventory,
} from "./inventory.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";

async function evidence(orgId: string) {
  return (await db.execute<{ state: unknown }>(sql`select jsonb_build_object(
    'movements',(select jsonb_agg(to_jsonb(m) order by id) from inventory_movements m where org_id=${orgId}),
    'layers',(select jsonb_agg(to_jsonb(l) order by id) from cost_layers l where org_id=${orgId}),
    'journals',(select jsonb_agg(to_jsonb(j) order by id) from journal_entries j where org_id=${orgId}),
    'lines',(select jsonb_agg(to_jsonb(l) order by id) from journal_lines l where org_id=${orgId}),
    'locations',(select jsonb_agg(to_jsonb(l) order by id) from stock_locations l where org_id=${orgId}),
    'sequences',(select jsonb_agg(to_jsonb(s) order by id) from number_sequences s where org_id=${orgId}),
    'vouchers',(select jsonb_agg(to_jsonb(v) order by id) from landed_cost_vouchers v where org_id=${orgId}),
    'orders',(select jsonb_agg(to_jsonb(o) order by id) from transfer_orders o where org_id=${orgId}),
    'orderLines',(select jsonb_agg(to_jsonb(l) order by id) from transfer_order_lines l where org_id=${orgId})
  ) as state`)).rows[0]!.state;
}

for (const operation of ["receipt", "issue", "adjustment", "transfer", "build", "ship order", "receive order", "create order", "landed cost"] as const) {
  test(`disabled Inventory refuses ${operation} without changing stock or accounting`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      const input = { itemId: org.items.fifo, stockLocationId: org.stockLocationId, subsidiaryId: org.subsidiaryId,
        quantity: "1", unitCost: "5", date: org.date, offsetAccountId: org.accounts.clearing };
      await receiveInventory(org.orgId, actorId, { ...input, quantity: "10" });
      await receiveInventory(org.orgId, actorId, { ...input, itemId: org.items.component, quantity: "10" });
      let orderId = "";
      if (operation === "ship order" || operation === "receive order") {
        const transitId = randomUUID();
        await db.execute(sql`insert into stock_locations(id,org_id,location_id,code,kind,is_active)
          values(${transitId},${org.orgId},${org.locationId},'FEATURE-TRANSIT','transit',true)`);
        orderId = (await createTransferOrder(org.orgId, actorId, { fromStockLocationId: org.stockLocationId,
          toStockLocationId: org.stockLocationId2, subsidiaryId: org.subsidiaryId, orderedOn: org.date,
          transitStockLocationId: transitId,
          lines: [{ itemId: org.items.fifo, quantity: "1" }] })).id;
        if (operation === "receive order") await shipTransferOrder(org.orgId, actorId, orderId, org.date);
      }
      const before = await evidence(org.orgId);
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"inventory":false}'::jsonb) where id=${org.orgId}`);
      const run = () => operation === "receipt" ? receiveInventory(org.orgId, actorId, input)
        : operation === "issue" ? issueInventory(org.orgId, actorId, input)
        : operation === "adjustment" ? adjustInventory(org.orgId, actorId, { ...input, quantityDelta: "1" })
        : operation === "transfer" ? transferInventory(org.orgId, actorId, { ...input, fromStockLocationId: org.stockLocationId, toStockLocationId: org.stockLocationId2 })
        : operation === "build" ? buildAssembly(org.orgId, actorId, { ...input, assemblyItemId: org.items.assembly })
        : operation === "create order" ? createTransferOrder(org.orgId, actorId, { fromStockLocationId: org.stockLocationId,
          toStockLocationId: org.stockLocationId2, subsidiaryId: org.subsidiaryId, orderedOn: org.date,
          lines: [{ itemId: org.items.fifo, quantity: "1" }] })
        : operation === "landed cost" ? postLandedCostVoucher(org.orgId, actorId, { amount: "5", basis: "quantity",
          freightAccountId: org.accounts.freight, subsidiaryId: org.subsidiaryId, voucherDate: org.date,
          targets: [{ itemId: org.items.fifo, stockLocationId: org.stockLocationId }] })
        : operation === "ship order" ? shipTransferOrder(org.orgId, actorId, orderId, org.date)
        : receiveTransferOrder(org.orgId, actorId, orderId, org.date);
      await withOrgTransaction(org.orgId, async () => {
        await assert.rejects(run(), /inventory feature is disabled/i);
        assert.deepEqual(await evidence(org.orgId), before, "caught feature refusal cannot leave stock, ledger, or transit fragments");
      });
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,inventory}','true'::jsonb) where id=${org.orgId}`);
      assert.ok(await run());
    } finally { await dropScratchOrg(org.orgId); }
  });
}

test("inventory receipt waits for concurrent feature disable before writing", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  const writer = await pool.connect();
  let pending: Promise<PromiseSettledResult<unknown>> | undefined;
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const before = await evidence(org.orgId);
    await writer.query("begin");
    await writer.query("select set_config('app.bypass_rls','on',true)");
    await writer.query("update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{\"inventory\":false}'::jsonb) where id=$1", [org.orgId]);
    const pid = (await writer.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    pending = receiveInventory(org.orgId, actorId, { itemId: org.items.fifo, stockLocationId: org.stockLocationId,
      subsidiaryId: org.subsidiaryId, quantity: "1", unitCost: "5", offsetAccountId: org.accounts.clearing, date: org.date })
      .then((value) => ({ status: "fulfilled", value }), (reason: unknown) => ({ status: "rejected", reason }));
    let blocked = false;
    for (let attempt = 0; attempt < 400; attempt++) {
      const row = (await pool.query<{ blocked: boolean }>("select exists(select 1 from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))) as blocked", [pid])).rows[0]!;
      if (row.blocked) { blocked = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(blocked, "receipt must wait for authoritative feature ownership");
    await writer.query("commit");
    const result = await pending;
    if (result.status !== "rejected") assert.fail("disabled Inventory must refuse receipt");
    assert.ok(result.reason instanceof Error);
    assert.match(result.reason.message, /inventory feature is disabled/i);
    assert.deepEqual(await evidence(org.orgId), before);
  } finally {
    await writer.query("rollback"); writer.release(); await pending;
    await dropScratchOrg(org.orgId);
  }
});

test("disabled Inventory retains controlled reversal of historical movements", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const receipt = await receiveInventory(org.orgId, actorId, { itemId: org.items.fifo, stockLocationId: org.stockLocationId,
      subsidiaryId: org.subsidiaryId, quantity: "1", unitCost: "5", offsetAccountId: org.accounts.clearing, date: org.date });
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"inventory":false}'::jsonb) where id=${org.orgId}`);
    assert.ok(await reverseInventoryMovement(org.orgId, actorId, {
      movementId: receipt.movementId, reversalDate: org.date, reason: "Correct historical inventory receipt",
    }));
  } finally { await dropScratchOrg(org.orgId); }
});
