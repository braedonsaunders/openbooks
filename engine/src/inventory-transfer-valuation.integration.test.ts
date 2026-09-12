import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { exactCostFragments, extendCost } from "./inventory-costing.ts";
import { sum } from "./money.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "./test-fixtures.ts";
import {
  createTransferOrder, getOnHand, receiveInventory, receiveTransferOrder,
  shipTransferOrder, transferInventory, reverseInventoryMovement, issueInventory,
} from "./inventory.ts";

test("moving-average withdrawal after exhaustion and old issue reversal remains weighted", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const position = { itemId: org.items.movingAvg, stockLocationId: org.stockLocationId,
      subsidiaryId: org.subsidiaryId, date: org.date };
    await receiveInventory(org.orgId, actor, { ...position, quantity: "1", unitCost: "10", offsetAccountId: org.accounts.clearing });
    const exhausted = await issueInventory(org.orgId, actor, { ...position, quantity: "1" });
    await receiveInventory(org.orgId, actor, { ...position, quantity: "1", unitCost: "20", offsetAccountId: org.accounts.clearing });
    await reverseInventoryMovement(org.orgId, actor, { movementId: exhausted.movementId,
      reversalDate: org.date, reason: "Restore prior receipt after stock replenishment" });
    assert.equal((await getOnHand(org.orgId, position.itemId, position.stockLocationId)).value, "30.0000");
    const next = await issueInventory(org.orgId, actor, { ...position, quantity: "1" });
    assert.equal(next.value, "-15.0000", "all restored and replenished stock participates in moving average");
    assert.equal((await getOnHand(org.orgId, position.itemId, position.stockLocationId)).value, "15.0000");
  } finally { await dropScratchOrg(org.orgId); }
});

test("exact carried-cost fragments preserve quantity and value at fractional and large scales", () => {
  for (const [quantity, value] of [["0.0001", "0.0001"], ["0.5", "1.6667"], ["1.9", "0.0017"], ["3", "5"], ["30000", "50000"], ["3.125", "0"]]) {
    const fragments = exactCostFragments(quantity!, value!);
    assert.equal(sum(fragments.map((fragment) => fragment.quantity)), sum([quantity!]));
    assert.equal(sum(fragments.map((fragment) => extendCost(fragment.quantity, fragment.unitCost))), sum([value!]));
  }
});

for (const item of ["fifo", "movingAvg"] as const) {
test(`inventory audit: a mixed-cost ${item} transfer preserves the exact source value`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    for (const [quantity, unitCost] of [["10000", "1"], ["20000", "2"]]) {
      await receiveInventory(org.orgId, actor, {
        itemId: org.items[item], stockLocationId: org.stockLocationId,
        quantity: quantity!, unitCost: unitCost!, subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing, date: org.date,
      });
    }
    const before = await getOnHand(org.orgId, org.items[item], org.stockLocationId);
    const moved = await transferInventory(org.orgId, actor, {
      itemId: org.items[item], fromStockLocationId: org.stockLocationId,
      toStockLocationId: org.stockLocationId2, quantity: "30000",
      subsidiaryId: org.subsidiaryId, date: org.date,
    });
    const after = await getOnHand(org.orgId, org.items[item], org.stockLocationId2);
    const gl = (await db.execute<{ value: string }>(sql`
      select sum(amount)::text as value from journal_lines
      where org_id=${org.orgId} and account_id=${org.accounts.invAsset}`)).rows[0]!.value;
    assert.equal(gl, before.value);
    assert.equal(moved.value, before.value);
    assert.equal(after.value, before.value, "a location transfer must preserve the exact source carrying value");
    const reversal = { movementId: moved.fromMovementId, reversalDate: org.date, reason: "Undo the complete carried-cost transfer" };
    await reverseInventoryMovement(org.orgId, actor, reversal);
    assert.deepEqual(await getOnHand(org.orgId, org.items[item], org.stockLocationId), before);
    assert.equal((await getOnHand(org.orgId, org.items[item], org.stockLocationId2)).value, "0.0000");
    assert.equal((await reverseInventoryMovement(org.orgId, actor, reversal)).alreadyReversed, true);
  } finally { await dropScratchOrg(org.orgId); }
});
}

for (const [item, legacy] of [["fifo", false], ["movingAvg", false], ["movingAvg", true]] as const) {
test(`inventory ${item}${legacy ? " legacy" : ""} transfer orders retain their own shipment basis when received out of order`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const transitId = randomUUID();
    await db.execute(sql`insert into stock_locations(id,org_id,location_id,code,kind,is_active)
      values (${transitId},${org.orgId},${org.locationId},'AUDIT-TRANSIT','transit',true)`);
    const transitAccounts = [randomUUID(), randomUUID()];
    for (let index = 0; index < transitAccounts.length; index++) {
      await db.execute(sql`insert into accounts
        (id,org_id,number,name,type,is_summary,is_active,eliminate,reconcilable,required_dimensions,custom,subsidiary_include_children)
        values (${transitAccounts[index]},${org.orgId},${`139${index}`},${`Transit ${index}`},
          'asset_current_other',false,true,false,false,'[]'::jsonb,'{}'::jsonb,true)`);
    }
    const orders: string[] = [];
    for (const [index, unitCost] of ["10", "20"].entries()) {
      await receiveInventory(org.orgId, actor, {
        itemId: org.items[item], stockLocationId: org.stockLocationId,
        quantity: "5", unitCost, subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing, date: org.date,
      });
      const order = await createTransferOrder(org.orgId, actor, {
        fromStockLocationId: org.stockLocationId, toStockLocationId: org.stockLocationId2,
        transitStockLocationId: transitId, inTransitAccountId: transitAccounts[index]!,
        subsidiaryId: org.subsidiaryId, orderedOn: org.date,
        lines: [{ itemId: org.items[item], quantity: "5" }],
      });
      orders.push(order.id);
      await shipTransferOrder(org.orgId, actor, order.id, org.date);
    }
    if (legacy) {
      // Pre-fix moving-average transit storage blended both native shipment
      // movements into the first layer: ten units @ 15, still worth exactly 150.
      const layers = (await db.execute<{ id: string }>(sql`select id from cost_layers
        where org_id=${org.orgId} and stock_location_id=${transitId} and remaining_quantity>0
        order by received_at,created_at,id`)).rows;
      assert.equal(layers.length, 2);
      await db.execute(sql`update cost_layers set original_quantity='10',remaining_quantity='10',unit_cost='15',remaining_original_cost=null
        where org_id=${org.orgId} and id=${layers[0]!.id}`);
      await db.execute(sql`update cost_layers set original_quantity='0',remaining_quantity='0',remaining_original_cost=null
        where org_id=${org.orgId} and id=${layers[1]!.id}`);
      await db.execute(sql`update cost_layers set unit_cost='15.0001' where org_id=${org.orgId} and id=${layers[0]!.id}`);
      const before = (await db.execute(sql`select
        (select jsonb_agg(to_jsonb(l) order by l.id) from cost_layers l where org_id=${org.orgId}) as layers,
        (select count(*) from journal_entries where org_id=${org.orgId}) as journals`)).rows;
      await assert.rejects(receiveTransferOrder(org.orgId, actor, orders[1]!, org.date), /shipment layers have changed/);
      assert.deepEqual((await db.execute(sql`select
        (select jsonb_agg(to_jsonb(l) order by l.id) from cost_layers l where org_id=${org.orgId}) as layers,
        (select count(*) from journal_entries where org_id=${org.orgId}) as journals`)).rows, before);
      // Restore the intentionally perturbed fixture; only an exactly reconciling
      // historical pool qualifies for automatic provenance reconstruction.
      await db.execute(sql`update cost_layers set unit_cost='15' where org_id=${org.orgId} and id=${layers[0]!.id}`);
    }
    await receiveTransferOrder(org.orgId, actor, orders[1]!, org.date);
    if (legacy) {
      const audit = (await db.execute<{ actor_id: string; changes: { reason: string } }>(sql`select actor_id,changes from audit_log
        where org_id=${org.orgId} and table_name='cost_layers' and changes->>'reason' like 'Restore untouched legacy transit%'`)).rows;
      assert.equal(audit.length, 1);
      assert.equal(audit[0]!.actor_id, actor);
      assert.match(audit[0]!.changes.reason, /immutable movement evidence/);
    }
    const secondDestination = await getOnHand(org.orgId, org.items[item], org.stockLocationId2);
    await receiveTransferOrder(org.orgId, actor, orders[0]!, org.date);
    const evidence = (await db.execute<{ document_number: string; status: string; shipped_value: string; received_value: string }>(sql`
      select o.document_number,o.status,(-ship.total_value)::text as shipped_value,received.total_value::text as received_value
      from transfer_orders o join transfer_order_lines l on l.transfer_order_id=o.id and l.org_id=o.org_id
      join inventory_movements ship on ship.id=l.ship_movement_id and ship.org_id=l.org_id
      join inventory_movements received on received.id=l.receive_movement_id and received.org_id=l.org_id
      where o.org_id=${org.orgId} order by o.document_number`)).rows;
    const balances = (await db.execute<{ number: string; balance: string }>(sql`
      select a.number,sum(l.amount)::text as balance from accounts a join journal_lines l on l.account_id=a.id and l.org_id=a.org_id
      where a.org_id=${org.orgId} and a.id in (${transitAccounts[0]},${transitAccounts[1]})
      group by a.number order by a.number`)).rows;
    assert.ok(evidence.every((row) => row.status === "received" && row.shipped_value === row.received_value));
    await assert.rejects(receiveTransferOrder(org.orgId, actor, orders[0]!, org.date), /is received/);
    assert.equal(secondDestination.value, "100.0000", "order B must receive its own $100 shipment basis");
    assert.deepEqual(balances.map((row) => row.balance), ["0.0000", "0.0000"], "received orders must clear their shipment reclass");
  } finally { await dropScratchOrg(org.orgId); }
});
}

for (const item of ["fifo", "movingAvg"] as const) {
  test(`inventory ${item}: fractional transfer and reversal preserve the rounded source carrying value`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      await receiveInventory(org.orgId, actor, {
        itemId: org.items[item], stockLocationId: org.stockLocationId, quantity: "1.5", unitCost: "3.3333",
        subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
      });
      const moved = await transferInventory(org.orgId, actor, {
        itemId: org.items[item], fromStockLocationId: org.stockLocationId, toStockLocationId: org.stockLocationId2,
        quantity: "0.5", subsidiaryId: org.subsidiaryId, date: org.date,
      });
      const source = await getOnHand(org.orgId, org.items[item], org.stockLocationId);
      const destination = await getOnHand(org.orgId, org.items[item], org.stockLocationId2);
      assert.equal(sum([source.value, destination.value]), "5.0000");
      assert.equal(moved.value, destination.value);
      await reverseInventoryMovement(org.orgId, actor, {
        movementId: moved.fromMovementId, reversalDate: org.date, reason: "Reverse the fractional inventory transfer",
      });
      assert.equal((await getOnHand(org.orgId, org.items[item], org.stockLocationId)).value, "5.0000");
      assert.equal((await getOnHand(org.orgId, org.items[item], org.stockLocationId2)).quantity, "0.0000");
    } finally { await dropScratchOrg(org.orgId); }
  });
}

async function seedTransit(orgId: string, locationId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into stock_locations(id,org_id,location_id,code,kind,is_active)
    values (${id},${orgId},${locationId},'TRANSFER-TRANSIT','transit',true)`);
  return id;
}

test("transfer receipt refuses a disabled shipment book despite an active alternate and retries cleanly", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const transitId = await seedTransit(org.orgId, org.locationId);
    await receiveInventory(org.orgId, actor, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "2.5", unitCost: "10",
      subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    const order = await createTransferOrder(org.orgId, actor, {
      fromStockLocationId: org.stockLocationId, toStockLocationId: org.stockLocationId2,
      transitStockLocationId: transitId, inTransitAccountId: org.accounts.bank,
      subsidiaryId: org.subsidiaryId, orderedOn: org.date,
      lines: [{ itemId: org.items.fifo, quantity: "2.5" }],
    });
    await shipTransferOrder(org.orgId, actor, order.id, org.date);
    const alternate = randomUUID();
    await assert.rejects(db.execute(sql`update accounting_books set is_primary=false where org_id=${org.orgId} and id=${org.bookId}`));
    await db.transaction(async (tx) => {
      await tx.execute(sql`update accounting_books set is_active=false where org_id=${org.orgId} and id=${org.bookId}`);
      await tx.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl)
        values (${alternate},${org.orgId},'SECOND','Active alternate',false,true,true)`);
    });
    await assert.rejects(receiveTransferOrder(org.orgId, actor, order.id, org.date), /active posting book/);
    assert.equal((await getOnHand(org.orgId, org.items.fifo, transitId)).quantity, "2.5000");
    assert.equal((await getOnHand(org.orgId, org.items.fifo, org.stockLocationId2)).quantity, "0.0000");
    await db.execute(sql`update accounting_books set is_active=true where org_id=${org.orgId} and id=${org.bookId}`);
    const received = await receiveTransferOrder(org.orgId, actor, order.id, org.date);
    const receiptBook = (await db.execute<{ book_id: string }>(sql`select book_id from journal_entries
      where org_id=${org.orgId} and id=${received.entryId}`)).rows[0]!.book_id;
    assert.equal(receiptBook, org.bookId);
    const balance = (await db.execute<{ balance: string }>(sql`select sum(l.amount)::text as balance
      from journal_lines l join journal_entries j on j.id=l.entry_id and j.org_id=l.org_id
      where l.org_id=${org.orgId} and l.account_id=${org.accounts.bank} and j.book_id=${org.bookId}`)).rows[0]!.balance;
    assert.equal(balance, "0.0000");
    assert.equal((await db.execute(sql`select id from journal_entries where org_id=${org.orgId} and book_id=${alternate}`)).rows.length, 0);
  } finally { await dropScratchOrg(org.orgId); }
});

test("transfer receipt refuses replacement transit stock and rolls back earlier lines and retries", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const transitId = await seedTransit(org.orgId, org.locationId);
    for (const itemId of [org.items.fifo, org.items.movingAvg]) {
      await receiveInventory(org.orgId, actor, {
        itemId, stockLocationId: org.stockLocationId, quantity: "5", unitCost: "10",
        subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
      });
    }
    const order = await createTransferOrder(org.orgId, actor, {
      fromStockLocationId: org.stockLocationId, toStockLocationId: org.stockLocationId2,
      transitStockLocationId: transitId, inTransitAccountId: org.accounts.bank,
      subsidiaryId: org.subsidiaryId, orderedOn: org.date,
      lines: [org.items.fifo, org.items.movingAvg].map((itemId) => ({ itemId, quantity: "5" })),
    });
    await shipTransferOrder(org.orgId, actor, order.id, org.date);
    await issueInventory(org.orgId, actor, {
      itemId: org.items.movingAvg, stockLocationId: transitId, quantity: "1",
      subsidiaryId: org.subsidiaryId, date: org.date,
    });
    await receiveInventory(org.orgId, actor, {
      itemId: org.items.movingAvg, stockLocationId: transitId, quantity: "1", unitCost: "10",
      subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    const snapshot = async () => (await db.execute(sql`select
      (select count(*) from journal_entries where org_id=${org.orgId}) as journals,
      (select count(*) from inventory_movements where org_id=${org.orgId}) as movements,
      (select jsonb_agg(to_jsonb(l) order by l.id) from cost_layers l where org_id=${org.orgId}) as layers,
      (select jsonb_agg(to_jsonb(l) order by l.id) from transfer_order_lines l where org_id=${org.orgId}) as lines`)).rows;
    const before = await snapshot();
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(receiveTransferOrder(org.orgId, actor, order.id, org.date), /shipment layers have changed/);
      assert.deepEqual(await snapshot(), before);
    }
    assert.equal((await getOnHand(org.orgId, org.items.fifo, org.stockLocationId2)).quantity, "0.0000");
  } finally { await dropScratchOrg(org.orgId); }
});

test("fractional issue reversals refuse out-of-order rounding drift and succeed after downstream reversal", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    await receiveInventory(org.orgId, actor, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "1.5", unitCost: "1.0001",
      subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    const input = { itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "0.5", subsidiaryId: org.subsidiaryId, date: org.date };
    const first = await issueInventory(org.orgId, actor, input);
    const second = await issueInventory(org.orgId, actor, input);
    const reverse = (movementId: string) => reverseInventoryMovement(org.orgId, actor, {
      movementId, reversalDate: org.date, reason: "Reverse the fractional stock withdrawal",
    });
    await assert.rejects(reverse(first.movementId), /restore the exact movement value/);
    await reverse(second.movementId);
    await reverse(first.movementId);
    assert.equal((await getOnHand(org.orgId, org.items.fifo, org.stockLocationId)).value, "1.5002");
    const gl = (await db.execute<{ value: string }>(sql`select sum(amount)::text as value from journal_lines
      where org_id=${org.orgId} and account_id=${org.accounts.invAsset}`)).rows[0]!.value;
    assert.equal(gl, "1.5002");
  } finally { await dropScratchOrg(org.orgId); }
});

test("transfer-order shipment cannot be reversed independently of its lifecycle and transit journal", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const transitId = await seedTransit(org.orgId, org.locationId);
    await receiveInventory(org.orgId, actor, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "5", unitCost: "10",
      subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    const order = await createTransferOrder(org.orgId, actor, {
      fromStockLocationId: org.stockLocationId, toStockLocationId: org.stockLocationId2,
      transitStockLocationId: transitId, inTransitAccountId: org.accounts.bank,
      subsidiaryId: org.subsidiaryId, orderedOn: org.date,
      lines: [{ itemId: org.items.fifo, quantity: "5" }],
    });
    await shipTransferOrder(org.orgId, actor, order.id, org.date);
    const line = (await db.execute<{ ship_movement_id: string }>(sql`select ship_movement_id from transfer_order_lines
      where org_id=${org.orgId} and transfer_order_id=${order.id}`)).rows[0]!;
    const snapshot = async () => (await db.execute(sql`select
      (select jsonb_agg(to_jsonb(o)) from transfer_orders o where org_id=${org.orgId}) as orders,
      (select count(*) from inventory_movements where org_id=${org.orgId}) as movements,
      (select count(*) from journal_entries where org_id=${org.orgId}) as journals,
      (select jsonb_agg(to_jsonb(l) order by l.id) from cost_layers l where org_id=${org.orgId}) as layers`)).rows;
    const before = await snapshot();
    await assert.rejects(reverseInventoryMovement(org.orgId, actor, {
      movementId: line.ship_movement_id, reversalDate: org.date, reason: "Attempt an incomplete shipment reversal",
    }), /controlled order reversal/);
    assert.deepEqual(await snapshot(), before);
    assert.equal((await getOnHand(org.orgId, org.items.fifo, transitId)).value, "50.0000");
    await receiveTransferOrder(org.orgId, actor, order.id, org.date);
    assert.equal((await getOnHand(org.orgId, org.items.fifo, org.stockLocationId2)).value, "50.0000");
  } finally { await dropScratchOrg(org.orgId); }
});

for (const [quantity, expectedCost, remainingValue] of [
  ["10000", "16666.6667", "33333.3333"], ["10000.125", "16666.8750", "33333.1250"],
] as const) {
for (const operation of ["issue", "transfer"] as const) {
  test(`moving-average ${operation} consumes exact fragments at the weighted pool cost for ${quantity} units`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      for (const [quantity, unitCost] of [["10000", "1"], ["20000", "2"]]) {
        await receiveInventory(org.orgId, actor, {
          itemId: org.items.movingAvg, stockLocationId: org.stockLocationId, quantity: quantity!, unitCost: unitCost!,
          subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
        });
      }
      if (operation === "issue") {
        const issued = await issueInventory(org.orgId, actor, {
          itemId: org.items.movingAvg, stockLocationId: org.stockLocationId, quantity,
          subsidiaryId: org.subsidiaryId, date: org.date,
        });
        assert.equal(issued.value, `-${expectedCost}`);
        assert.equal((await getOnHand(org.orgId, org.items.movingAvg, org.stockLocationId)).value, remainingValue);
        await reverseInventoryMovement(org.orgId, actor, {
          movementId: issued.movementId, reversalDate: org.date, reason: "Reverse the weighted inventory withdrawal",
        });
      } else {
        const moved = await transferInventory(org.orgId, actor, {
          itemId: org.items.movingAvg, fromStockLocationId: org.stockLocationId, toStockLocationId: org.stockLocationId2,
          quantity, subsidiaryId: org.subsidiaryId, date: org.date,
        });
        assert.equal(moved.value, expectedCost);
        assert.equal((await getOnHand(org.orgId, org.items.movingAvg, org.stockLocationId)).value, remainingValue);
        assert.equal((await getOnHand(org.orgId, org.items.movingAvg, org.stockLocationId2)).value, expectedCost);
        await reverseInventoryMovement(org.orgId, actor, {
          movementId: moved.fromMovementId, reversalDate: org.date, reason: "Reverse the weighted inventory transfer",
        });
      }
      assert.equal((await getOnHand(org.orgId, org.items.movingAvg, org.stockLocationId)).value, "50000.0000");
    } finally { await dropScratchOrg(org.orgId); }
  });
}
}

test("single-fragment moving average partitions fractional basis exactly and retains reversible consumption through re-pooling", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const receipt = await receiveInventory(org.orgId, actor, {
      itemId: org.items.movingAvg, stockLocationId: org.stockLocationId, quantity: "124.9114", unitCost: "641.9975",
      subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    assert.equal(receipt.value, "80192.8065");
    const first = await issueInventory(org.orgId, actor, {
      itemId: org.items.movingAvg, stockLocationId: org.stockLocationId, quantity: "42.0967",
      subsidiaryId: org.subsidiaryId, date: org.date,
    });
    assert.equal(first.value, "-27025.9762");
    assert.equal((await getOnHand(org.orgId, org.items.movingAvg, org.stockLocationId)).value, "53166.8303");
    const consumption = async () => (await db.execute(sql`select c.* from cost_layer_consumptions c
      where org_id=${org.orgId} and issue_movement_id=${first.movementId} order by id`)).rows;
    const before = await consumption();
    const audit = (await db.execute<{ actor_id: string; changes: { sourceMovementId: string; createdFragments: unknown[] } }>(sql`
      select actor_id,changes from audit_log where org_id=${org.orgId} and table_name='cost_layers'
        and changes->>'reason'='Partition remaining moving-average basis for an exact weighted withdrawal'`)).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.actor_id, actor);
    assert.equal(audit[0]!.changes.sourceMovementId, receipt.movementId);
    assert.ok(audit[0]!.changes.createdFragments.length >= 2);
    const second = await issueInventory(org.orgId, actor, {
      itemId: org.items.movingAvg, stockLocationId: org.stockLocationId, quantity: "10.125",
      subsidiaryId: org.subsidiaryId, date: org.date,
    });
    await receiveInventory(org.orgId, actor, {
      itemId: org.items.movingAvg, stockLocationId: org.stockLocationId, quantity: "1", unitCost: "700",
      subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    assert.deepEqual(await consumption(), before, "re-pooling must preserve old consumption evidence");
    for (const movement of [second, first]) {
      await reverseInventoryMovement(org.orgId, actor, {
        movementId: movement.movementId, reversalDate: org.date, reason: "Reverse the fractional weighted issue after re-pooling",
      });
    }
    const onHand = await getOnHand(org.orgId, org.items.movingAvg, org.stockLocationId);
    assert.equal(onHand.quantity, "125.9114");
    assert.equal(onHand.value, "80892.8065");
    const gl = (await db.execute<{ value: string; journals: number }>(sql`select sum(l.amount)::text as value,count(distinct l.entry_id)::int as journals
      from journal_lines l where l.org_id=${org.orgId} and l.account_id=${org.accounts.invAsset}`)).rows[0]!;
    assert.equal(gl.value, onHand.value);
    assert.equal(gl.journals, 6, "pool representation changes must not post extra GL entries");
  } finally { await dropScratchOrg(org.orgId); }
});

test("fractional moving-average withdrawals remain reversible after a later exact pool partition", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    await receiveInventory(org.orgId, actor, {
      itemId: org.items.movingAvg, stockLocationId: org.stockLocationId, quantity: "574.0536", unitCost: "630.7636",
      subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    const issue = (quantity: string) => issueInventory(org.orgId, actor, {
      itemId: org.items.movingAvg, stockLocationId: org.stockLocationId, quantity,
      subsidiaryId: org.subsidiaryId, date: org.date,
    });
    const first = await issue("188.1914");
    assert.equal(first.value, "-118704.2849");
    const second = await issue("112.2029");
    assert.equal(second.value, "-70773.5051");
    for (const movement of [second, first]) {
      await reverseInventoryMovement(org.orgId, actor, {
        movementId: movement.movementId, reversalDate: org.date, reason: "Reverse fractional issues in dependency order",
      });
    }
    const onHand = await getOnHand(org.orgId, org.items.movingAvg, org.stockLocationId);
    assert.equal(onHand.quantity, "574.0536");
    assert.equal(onHand.value, "362092.1153");
    const gl = (await db.execute<{ value: string }>(sql`select sum(amount)::text as value from journal_lines
      where org_id=${org.orgId} and account_id=${org.accounts.invAsset}`)).rows[0]!.value;
    assert.equal(gl, onHand.value);
  } finally { await dropScratchOrg(org.orgId); }
});

for (const reverseFirst of [true, false]) {
for (const exhaustPool of [false, true]) {
  test(`ordinary moving-average receipt re-pooling preserves issue reversal (reverse issue first: ${reverseFirst}, exhaust pool: ${exhaustPool})`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const receive = (quantity: string, unitCost: string) => receiveInventory(org.orgId, actor, {
        itemId: org.items.movingAvg, stockLocationId: org.stockLocationId, quantity, unitCost,
        subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
      });
      const issue = (quantity: string) => issueInventory(org.orgId, actor, {
        itemId: org.items.movingAvg, stockLocationId: org.stockLocationId, quantity,
        subsidiaryId: org.subsidiaryId, date: org.date,
      });
      const reverse = (movementId: string) => reverseInventoryMovement(org.orgId, actor, {
        movementId, reversalDate: org.date, reason: "Reverse ordinary moving-average inventory activity",
      });
      await receive("10", "10");
      const first = await issue("1");
      assert.equal(first.value, "-10.0000");
      const evidence = async () => (await db.execute(sql`select c.*,l.unit_cost as layer_unit_cost,
        l.source_movement_id from cost_layer_consumptions c join cost_layers l on l.id=c.cost_layer_id
        and l.org_id=c.org_id where c.org_id=${org.orgId} and c.issue_movement_id=${first.movementId}`)).rows;
      const before = await evidence();
      const laterReceipt = await receive("1", "20");
      assert.equal((await getOnHand(org.orgId, org.items.movingAvg, org.stockLocationId)).value, "110.0000");
      assert.deepEqual(await evidence(), before, "re-pooling must not rewrite a consumed layer rate");
      const audit = (await db.execute<{ actor_id: string; changes: { incomingMovementId: string; createdFragments: unknown[]; before: { unit_cost: string }; after: { unit_cost: string } } }>(sql`
        select actor_id, changes from audit_log where org_id=${org.orgId} and table_name='cost_layers'
          and changes->>'reason'='Re-pool remaining moving-average basis without changing historical rates'`)).rows;
      assert.equal(audit.length, 1);
      assert.equal(audit[0]!.actor_id, actor);
      assert.equal(audit[0]!.changes.incomingMovementId, laterReceipt.movementId);
      assert.equal(audit[0]!.changes.before.unit_cost, "10.0000");
      assert.equal(audit[0]!.changes.after.unit_cost, "10.0000");
      assert.ok(audit[0]!.changes.createdFragments.length > 0);
      const assertBlendedReceiptRefusal = async () => {
        const snapshot = async () => {
          const result: Record<string, unknown[]> = {};
          for (const table of ["inventory_movements", "cost_layers", "cost_layer_consumptions", "journal_entries", "journal_lines", "audit_log"]) {
            result[table] = (await db.execute(sql`select * from ${sql.identifier(table)}
              where org_id=${org.orgId} order by id`)).rows;
          }
          return result;
        };
        const beforeRefusal = await snapshot();
        await assert.rejects(reverse(laterReceipt.movementId), /exact receipt reversal is unavailable for blended provenance/);
        assert.deepEqual(await snapshot(), beforeRefusal, "refused blended receipt reversal must leave all accounting and audit evidence unchanged");
      };
      await assertBlendedReceiptRefusal();
      if (reverseFirst) await reverse(first.movementId);
      const second = await issue(exhaustPool ? (reverseFirst ? "11" : "10") : "1");
      assert.equal(second.value, exhaustPool ? (reverseFirst ? "-120.0000" : "-110.0000") : (reverseFirst ? "-10.9091" : "-11.0000"));
      await reverse(second.movementId);
      if (!reverseFirst) await reverse(first.movementId);
      assert.deepEqual(await evidence(), before, "receipt re-pooling preserves historical rates and consumptions");
      const onHand = await getOnHand(org.orgId, org.items.movingAvg, org.stockLocationId);
      assert.equal(onHand.quantity, "11.0000");
      assert.equal(onHand.value, "120.0000");
      const gl = (await db.execute<{ value: string }>(sql`select sum(amount)::text as value from journal_lines
        where org_id=${org.orgId} and account_id=${org.accounts.invAsset}`)).rows[0]!.value;
      assert.equal(gl, onHand.value);
      await assertBlendedReceiptRefusal();
      assert.deepEqual(await getOnHand(org.orgId, org.items.movingAvg, org.stockLocationId), onHand);
    } finally { await dropScratchOrg(org.orgId); }
  });
}
}
