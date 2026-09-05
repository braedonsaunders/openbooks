import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from './db.ts';
import { createScratchOrg, seedFlowActors, dropScratchOrg } from './test-fixtures.ts';
import { receiveInventory, createTransferOrder, shipTransferOrder, receiveTransferOrder, getOnHand, InventoryError } from './inventory.ts';
import { addCalendarDays } from './business-date.ts';

for (const scenario of ['chronology','transit identity','legacy transit identity'] as const) {
  test(`inventory transfer lifecycle: ${scenario}`, {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const transit = randomUUID();
      await db.execute(sql`insert into stock_locations(id,org_id,location_id,code,kind,is_active) values (${transit},${org.orgId},${org.locationId},'TRANSIT-A','transit',true)`);
      await receiveInventory(org.orgId,actor,{itemId:org.items.fifo,stockLocationId:org.stockLocationId,quantity:'5',unitCost:'10',subsidiaryId:org.subsidiaryId,offsetAccountId:org.accounts.clearing,date:org.date});
      const order = await createTransferOrder(org.orgId,actor,{fromStockLocationId:org.stockLocationId,toStockLocationId:org.stockLocationId2,subsidiaryId:org.subsidiaryId,orderedOn:org.date,lines:[{itemId:org.items.fifo,quantity:'2'}]});
      if (scenario === 'chronology') {
        await assert.rejects(shipTransferOrder(org.orgId,actor,order.id,addCalendarDays(org.date,-1)),InventoryError);
      }
      await shipTransferOrder(org.orgId,actor,order.id,org.date);
      if (scenario === 'chronology') {
        await assert.rejects(receiveTransferOrder(org.orgId,actor,order.id,addCalendarDays(org.date,-1)),InventoryError);
        assert.equal((await db.execute<{status:string}>(sql`select status from transfer_orders where org_id=${org.orgId} and id=${order.id}`)).rows[0]!.status,'in_transit');
      } else {
        if (scenario === 'transit identity') {
          assert.equal((await db.execute<{transit_stock_location_id:string}>(sql`select transit_stock_location_id from transfer_orders where org_id=${org.orgId} and id=${order.id}`)).rows[0]!.transit_stock_location_id,transit);
        } else {
          await db.execute(sql`update transfer_orders set transit_stock_location_id=null where org_id=${org.orgId} and id=${order.id}`);
        }
        await db.execute(sql`insert into stock_locations(id,org_id,location_id,code,kind,is_active,created_at) values (${randomUUID()},${org.orgId},${org.locationId},'TRANSIT-B','transit',true,'2000-01-01')`);
      }
      await receiveTransferOrder(org.orgId,actor,order.id,org.date);
      assert.equal((await getOnHand(org.orgId,org.items.fifo,transit)).quantity,'0.0000');
      assert.equal((await getOnHand(org.orgId,org.items.fifo,org.stockLocationId2)).quantity,'2.0000');
      assert.equal((await getOnHand(org.orgId,org.items.fifo,org.stockLocationId2)).value,'20.0000');
      assert.equal((await db.execute(sql`select entry_id from journal_lines where org_id=${org.orgId} group by entry_id having sum(amount)<>0`)).rows.length,0);
    } finally { await dropScratchOrg(org.orgId); }
  });
}
