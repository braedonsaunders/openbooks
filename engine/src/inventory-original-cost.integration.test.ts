import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { withSimClock } from "./clock.ts";
import { sum, toUnits } from "./money.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from "./test-fixtures.ts";
import { getOnHand, issueInventory, receiveInventory, reverseInventoryMovement, transferInventory,
  postLandedCostVoucher, reverseLandedCostVoucher, revalueOpenLayersToStandardCost } from "./inventory.ts";
import { reverseInventoryWritedown, writeDownInventoryToNrv } from "./inventory-nrv.ts";

const skip = !process.env.OPENBOOKS_DB_URL;
const position = (org: ScratchOrg, itemId = org.items.movingAvg) => ({ itemId,
  stockLocationId: org.stockLocationId, subsidiaryId: org.subsidiaryId, date: org.date });
async function basis(org: ScratchOrg, itemId = org.items.movingAvg, locationId = org.stockLocationId) {
  return (await db.execute<{ basis: string; unknown: number }>(sql`select
    coalesce(sum(remaining_original_cost),0)::text as basis,
    count(*) filter(where remaining_original_cost is null)::int as unknown
    from cost_layers where org_id=${org.orgId} and item_id=${itemId}
      and stock_location_id=${locationId} and remaining_quantity>0`)).rows[0]!;
}
async function snapshot(org: ScratchOrg) {
  return (await db.execute(sql`select
    (select jsonb_agg(to_jsonb(l) order by id) from cost_layers l where org_id=${org.orgId}) as layers,
    (select jsonb_agg(to_jsonb(w) order by id) from inventory_writedowns w where org_id=${org.orgId}) as writedowns,
    (select count(*) from journal_entries where org_id=${org.orgId}) as journals,
    (select count(*) from audit_log where org_id=${org.orgId}) as audits`)).rows;
}
async function ifrs(org: ScratchOrg) {
  await db.execute(sql`update orgs set settings=settings || '{"reportingFramework":"ifrs"}'::jsonb where id=${org.orgId}`);
}

for (const quantity of ["0.5", "1"]) {
  test(`an old inventory writer invalidates known basis on a ${quantity}-unit withdrawal`, { skip }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const p = position(org);
      await receiveInventory(org.orgId, actor, { ...p, quantity: "1", unitCost: "100", offsetAccountId: org.accounts.clearing });
      // Simulate the pre-basis UPDATE. It has no writer marker and no knowledge
      // of the new column, so even exhaustion must safely become unknown.
      const rows = (await db.execute<{ remaining_original_cost: null }>(sql`update cost_layers
        set remaining_quantity=remaining_quantity-${quantity}::numeric
        where org_id=${org.orgId} returning remaining_original_cost`)).rows;
      assert.deepEqual(rows, [{ remaining_original_cost: null }]);
      const audit = (await db.execute<{ actor_id: null }>(sql`select actor_id from audit_log
        where org_id=${org.orgId} and changes->>'reason'='Original-cost provenance invalidated by an unversioned inventory writer'`)).rows;
      assert.deepEqual(audit, [{ actor_id: null }]);
    } finally { await dropScratchOrg(org.orgId); }
  });
}

test("a current writer preserves known basis when fractional relief rounds to zero", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const p = position(org);
    await receiveInventory(org.orgId, null, { ...p, quantity: "1", unitCost: "0.0001", offsetAccountId: org.accounts.clearing });
    await db.execute(sql`update stock_locations set location_id=${org.locationId}
      where org_id=${org.orgId} and id=${org.stockLocationId2}`);
    const issue = await transferInventory(org.orgId, null, { itemId: p.itemId,
      fromStockLocationId: p.stockLocationId, toStockLocationId: org.stockLocationId2,
      subsidiaryId: p.subsidiaryId, date: p.date, quantity: "0.0001" });
    assert.equal(toUnits(issue.value), 0n);
    assert.deepEqual(await basis(org), { basis: "0.0001", unknown: 0 });
    const consumption = (await db.execute<{ original_cost: string }>(sql`select original_cost from cost_layer_consumptions
      where org_id=${org.orgId} and issue_movement_id=${issue.fromMovementId}`)).rows;
    assert.deepEqual(consumption, [{ original_cost: "0.0000" }]);
  } finally { await dropScratchOrg(org.orgId); }
});

test("fractional FIFO recovery cannot leave an over-cost residual after withdrawal", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const p = position(org, org.items.fifo);
    await ifrs(org);
    const first = await receiveInventory(org.orgId, null, { ...p, quantity: "3", unitCost: "1.0001", offsetAccountId: org.accounts.clearing });
    await receiveInventory(org.orgId, null, { ...p, quantity: "7", unitCost: "1", offsetAccountId: org.accounts.clearing });
    await writeDownInventoryToNrv(org.orgId, null, { ...p, nrvPerUnit: "0.1" });
    await reverseInventoryWritedown(org.orgId, null, { ...p, nrvPerUnit: "1" });
    const before = (await db.execute<{ value: string; rate: string }>(sql`select
      sum(round(remaining_quantity*unit_cost,4))::text as value,max(unit_cost)::text as rate from cost_layers
      where org_id=${org.orgId} and source_movement_id=${first.movementId} and remaining_quantity>0`)).rows[0]!;
    assert.equal(before.value, "3.0002");
    assert.equal(before.rate, "1.0001");
    await issueInventory(org.orgId, null, { ...p, quantity: "2" });
    const remaining = (await db.execute<{ value: string; basis: string }>(sql`select
      sum(round(remaining_quantity*unit_cost,4))::text as value,sum(remaining_original_cost)::text as basis from cost_layers
      where org_id=${org.orgId} and source_movement_id=${first.movementId} and remaining_quantity>0`)).rows[0]!;
    assert.deepEqual(remaining, { value: "1.0001", basis: "1.0001" });
  } finally { await dropScratchOrg(org.orgId); }
});

for (const standardCost of ["80", "50", "20"]) {
  test(`standard policy revaluation to ${standardCost} replaces prior NRV basis`, { skip }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const p = position(org, org.items.standard);
      await ifrs(org);
      await db.execute(sql`update item_inventory_profiles set standard_cost='100' where org_id=${org.orgId} and item_id=${p.itemId}`);
      await receiveInventory(org.orgId, actor, { ...p, quantity: "1", unitCost: "100", offsetAccountId: org.accounts.clearing });
      await writeDownInventoryToNrv(org.orgId, actor, { ...p, nrvPerUnit: "50" });
      await withSimClock(org.date, () => db.transaction(async (tx) => {
        await tx.execute(sql`update item_inventory_profiles set standard_cost=${standardCost} where org_id=${org.orgId} and item_id=${p.itemId}`);
        await revalueOpenLayersToStandardCost(tx, org.orgId, actor, p.itemId, {
          standardCost, assetAccountId: org.accounts.invAsset, varianceAccountId: org.accounts.adjustment,
        });
      }));
      assert.equal(toUnits((await basis(org, p.itemId)).basis), toUnits(standardCost));
      assert.equal(toUnits((await getOnHand(org.orgId, p.itemId, p.stockLocationId)).value), toUnits(standardCost));
      const before = await snapshot(org);
      await assert.rejects(reverseInventoryWritedown(org.orgId, actor, { ...p, nrvPerUnit: "200" }), /no unreversed write-down remains/);
      assert.deepEqual(await snapshot(org), before);
    } finally { await dropScratchOrg(org.orgId); }
  });
}

test("original-cost evidence follows fractional issue, transfer and exact controlled reversals", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const p = position(org);
    await receiveInventory(org.orgId, actor, { ...p, quantity: "124.9114", unitCost: "641.9975", offsetAccountId: org.accounts.clearing });
    const issue = await issueInventory(org.orgId, actor, { ...p, quantity: "42.0967" });
    const consumed = (await db.execute<{ original_cost: string }>(sql`select original_cost from cost_layer_consumptions
      where org_id=${org.orgId} and issue_movement_id=${issue.movementId}`)).rows;
    assert.equal(sum(consumed.map((c) => c.original_cost)), "27025.9762");
    assert.deepEqual(await basis(org), { basis: "53166.8303", unknown: 0 });
    await assert.rejects(db.execute(sql`update cost_layer_consumptions set original_cost=original_cost+0.0001
      where org_id=${org.orgId} and issue_movement_id=${issue.movementId}`), (error: unknown) => {
        const cause = (error as { cause?: { code?: string; constraint?: string } }).cause;
        return cause?.code === "23514" && cause.constraint === "inventory_consumed_original_cost_immutable";
      });
    const transfer = await transferInventory(org.orgId, actor, { itemId: p.itemId,
      fromStockLocationId: p.stockLocationId, toStockLocationId: org.stockLocationId2,
      subsidiaryId: p.subsidiaryId, date: p.date, quantity: "10.125" });
    assert.equal((await basis(org, p.itemId, org.stockLocationId2)).basis, transfer.value);
    await reverseInventoryMovement(org.orgId, actor, { movementId: transfer.fromMovementId,
      reversalDate: org.date, reason: "Restore transferred original-cost evidence" });
    await reverseInventoryMovement(org.orgId, actor, { movementId: issue.movementId,
      reversalDate: org.date, reason: "Restore fractional consumed original-cost evidence" });
    assert.deepEqual(await basis(org), { basis: "80192.8065", unknown: 0 });
    const audit = (await db.execute<{ actor_id: string }>(sql`select actor_id from audit_log where org_id=${org.orgId}
      and table_name='cost_layers' and changes->>'reason'='Inventory original-cost balance change'`)).rows;
    assert.ok(audit.length > 4);
    assert.ok(audit.every((row) => row.actor_id === actor));
  } finally { await dropScratchOrg(org.orgId); }
});

test("equal carrying rates still withdraw weighted original basis across restored origins", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const p = position(org);
    await ifrs(org);
    await receiveInventory(org.orgId, actor, { ...p, quantity: "2", unitCost: "100", offsetAccountId: org.accounts.clearing });
    await writeDownInventoryToNrv(org.orgId, actor, { ...p, nrvPerUnit: "50" });
    const issue = await issueInventory(org.orgId, actor, { ...p, quantity: "2" });
    await receiveInventory(org.orgId, actor, { ...p, quantity: "1", unitCost: "50", offsetAccountId: org.accounts.clearing });
    await reverseInventoryMovement(org.orgId, actor, { movementId: issue.movementId,
      reversalDate: org.date, reason: "Restore written-down pool after replenishment" });
    assert.equal((await basis(org)).basis, "250.0000");
    const next = await issueInventory(org.orgId, actor, { ...p, quantity: "1" });
    assert.equal(next.value, "-50.0000");
    assert.equal((await basis(org)).basis, "166.6667");
    const recovered = await reverseInventoryWritedown(org.orgId, actor, { ...p, nrvPerUnit: "100" });
    assert.equal(recovered.amount, "66.6667");
    assert.equal((await getOnHand(org.orgId, p.itemId, p.stockLocationId)).value, "166.6667");
  } finally { await dropScratchOrg(org.orgId); }
});

test("legacy unknown basis propagates through pooling and recovery refuses atomically", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const p = position(org);
    await ifrs(org);
    await receiveInventory(org.orgId, null, { ...p, quantity: "2", unitCost: "100", offsetAccountId: org.accounts.clearing });
    await db.execute(sql`update cost_layers set remaining_original_cost=null where org_id=${org.orgId}`);
    await writeDownInventoryToNrv(org.orgId, null, { ...p, nrvPerUnit: "50" });
    await receiveInventory(org.orgId, null, { ...p, quantity: "1", unitCost: "10", offsetAccountId: org.accounts.clearing });
    assert.ok((await basis(org)).unknown > 0);
    const before = await snapshot(org);
    await assert.rejects(reverseInventoryWritedown(org.orgId, null, { ...p, nrvPerUnit: "100" }), /original-cost provenance is unavailable/);
    assert.deepEqual(await snapshot(org), before);
  } finally { await dropScratchOrg(org.orgId); }
});

test("an exhausted historical loss cannot create fractional headroom in replacement stock", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const p = position(org);
    await ifrs(org);
    await receiveInventory(org.orgId, null, { ...p, quantity: "2", unitCost: "100", offsetAccountId: org.accounts.clearing });
    await writeDownInventoryToNrv(org.orgId, null, { ...p, nrvPerUnit: "50" });
    await issueInventory(org.orgId, null, { ...p, quantity: "2" });
    for (const [quantity, unitCost] of [["1", "1"], ["2", "2"]]) {
      await receiveInventory(org.orgId, null, { ...p, quantity: quantity!, unitCost: unitCost!, offsetAccountId: org.accounts.clearing });
    }
    const onHand = await getOnHand(org.orgId, p.itemId, p.stockLocationId);
    assert.equal(onHand.value, "5.0000");
    assert.equal((await basis(org)).basis, "5.0000");
    const before = await snapshot(org);
    await assert.rejects(reverseInventoryWritedown(org.orgId, null, { ...p, nrvPerUnit: "100" }), /no unreversed write-down remains/);
    assert.deepEqual(await snapshot(org), before);
    await issueInventory(org.orgId, null, { ...p, quantity: "0.5" });
    assert.equal((await basis(org)).basis, (await getOnHand(org.orgId, p.itemId, p.stockLocationId)).value);
  } finally { await dropScratchOrg(org.orgId); }
});

test("landed-cost split and its reversal conserve original cost at ledger precision", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const p = position(org, org.items.fifo);
    await receiveInventory(org.orgId, actor, { ...p, quantity: "3", unitCost: "1", offsetAccountId: org.accounts.clearing });
    const voucher = await postLandedCostVoucher(org.orgId, actor, { amount: "0.0001", basis: "quantity",
      freightAccountId: org.accounts.freight, subsidiaryId: org.subsidiaryId, voucherDate: org.date,
      targets: [{ itemId: p.itemId, stockLocationId: p.stockLocationId }] });
    assert.equal((await basis(org, p.itemId)).basis, "3.0001");
    await reverseLandedCostVoucher(org.orgId, actor, { voucherId: voucher.id,
      reversalDate: org.date, reason: "Remove exact original-cost landed allocation" });
    assert.equal((await basis(org, p.itemId)).basis, "3.0000");
    const balance = (await db.execute<{ value: string }>(sql`select sum(amount)::text as value from journal_lines
      where org_id=${org.orgId} and account_id=${org.accounts.invAsset}`)).rows[0]!;
    assert.equal(toUnits(balance.value), toUnits("3"));
  } finally { await dropScratchOrg(org.orgId); }
});
