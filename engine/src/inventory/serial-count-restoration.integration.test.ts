import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgTransaction } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { createInventoryOperator } from "../testing/inventory-counts.ts";
import { receiveInventory, issueInventory } from "./movements.ts";
import { transferInventory } from "./transfers.ts";
import { ensureLot, ensureSerial } from "./tracking.ts";
import { createStockCount, startStockCount, recordCountedQuantity, submitStockCountForReview, postStockCount } from "./stock-counts.ts";
import { recordSecondCount } from "./second-count.ts";
import { getStockCountDetail } from "./stock-count-queries.ts";
import { guardRefusalMessage } from "../platform/database-refusal.ts";
const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const run = <T>(work: () => Promise<T>) => withBypassContext(work);

test(
  "combined serial identity survives transfer, missing-stock count and governed found-stock restoration",
  { skip: !DB },
  async () => {
    const org = await run(() => createScratchOrg());
    try {
      const actor = await run(() =>
        createInventoryOperator(org.orgId, "Serial counter"),
      );
      await run(() =>
        db.execute(
          sql`update item_inventory_profiles set tracking='lot_serial' where org_id=${org.orgId} and item_id=${org.items.fifo}`,
        ),
      );
      const lot = await run(() =>
        ensureLot(org.orgId, org.items.fifo, "SERIAL-LOT", "2027-01-01", actor),
      );
      const serial = await run(() =>
        ensureSerial(org.orgId, org.items.fifo, "COUNT-SERIAL", null, actor),
      );
      await run(() =>
        receiveInventory(org.orgId, actor, {
          itemId: org.items.fifo,
          stockLocationId: org.stockLocationId,
          subsidiaryId: org.subsidiaryId,
          quantity: "1",
          unitCost: "3",
          offsetAccountId: org.accounts.clearing,
          date: org.date,
          lotId: lot,
          serialId: serial,
        }),
      );
      const moved = await run(() =>
        transferInventory(org.orgId, actor, {
          itemId: org.items.fifo,
          fromStockLocationId: org.stockLocationId,
          toStockLocationId: org.stockLocationId2,
          subsidiaryId: org.subsidiaryId,
          date: org.date,
          quantity: "1",
          lotId: lot,
          serialId: serial,
        }),
      );
      const transfer = (
        await run(() =>
          db.execute<{ lot_id: string; serial_id: string }>(
            sql`select lot_id,serial_id from inventory_movements where org_id=${org.orgId} and id=${moved.toMovementId}`,
          ),
        )
      ).rows[0]!;
      assert.equal(transfer.lot_id, lot);
      assert.equal(transfer.serial_id, serial);
      const destination = (await run(() => db.execute<{ location_id: string }>(sql`
        select location_id from stock_locations where org_id=${org.orgId} and id=${org.stockLocationId2}`))).rows[0]!;
      assert.ok(destination.location_id, "the transferred stock must have a business location");
      async function reviewCount(quantity: string) {
        const count = await run(() =>
          createStockCount(org.orgId, actor, {
            locationId: destination.location_id,
            subsidiaryId: org.subsidiaryId,
            countedOn: org.date,
            lines: [
              {
                itemId: org.items.fifo,
                stockLocationId: org.stockLocationId2,
                lotId: lot,
                serialId: serial,
              },
            ],
          }),
        );
        await run(() => startStockCount(org.orgId, actor, count.id));
        const detail = await run(() =>
            getStockCountDetail(org.orgId, count.id, null),
          ),
          line = detail.lines[0]!;
        await assert.rejects(
          run(() =>
            recordCountedQuantity(org.orgId, actor, {
              countId: count.id,
              lineId: line.id,
              countedQuantity: "2",
            }),
          ),
          /present.*absent/,
        );
        await run(() =>
          recordCountedQuantity(org.orgId, actor, {
            countId: count.id,
            lineId: line.id,
            countedQuantity: quantity,
          }),
        );
        await run(() =>
          recordSecondCount(org.orgId, actor, {
            countId: count.id,
            lineId: line.id,
            countedQuantity: quantity,
          }),
        );
        await run(() => submitStockCountForReview(org.orgId, actor, count.id));
        return { count, line };
      }
      const post = ({ count, line }: Awaited<ReturnType<typeof reviewCount>>) => run(() =>
        withOrgTransaction(org.orgId, () => postStockCount(org.orgId, actor, count.id, {
          foundUnitCosts: { [line.id]: "3" },
        })));
      const missing = await reviewCount("0");
      await post(missing);
      const missingLine = (await run(() => db.execute<{ adjustment_movement_id: string }>(sql`
        select adjustment_movement_id from stock_count_lines where org_id=${org.orgId} and id=${missing.line.id}`))).rows[0]!;
      const snapshot = () => run(async () => {
        const state = (await db.execute(sql`select status,current_stock_location_id,current_missing_count_movement_id
          from serials where org_id=${org.orgId} and id=${serial}`)).rows;
        const effects = (await db.execute(sql`select (select count(*) from inventory_movements where org_id=${org.orgId}) as movements,
          (select count(*) from journal_entries where org_id=${org.orgId}) as entries,
          (select sum(remaining_quantity) from cost_layers where org_id=${org.orgId}) as remaining`)).rows;
        return { state, effects };
      });
      const absent = await snapshot();
      assert.equal(absent.state[0]!.current_missing_count_movement_id, missingLine.adjustment_movement_id);
      await assert.rejects(run(() => db.execute(sql`update stock_count_lines set expected_quantity=0
        where org_id=${org.orgId} and id=${missing.line.id}`)),error => /immutable/.test(
          guardRefusalMessage(error,{includeRaisedCheckViolations:true}) ?? String(error)));
      const found = await reviewCount("1");
      const receiveFound = (overrides = {}) => run(() => receiveInventory(org.orgId, actor, {
        itemId: org.items.fifo,stockLocationId: org.stockLocationId2,subsidiaryId: org.subsidiaryId,
        quantity: "1",unitCost: "3",offsetAccountId: org.accounts.clearing,date: org.date,
        lotId: lot,serialId: serial,admission: "count",stockCountLineId: found.line.id,...overrides,
      }));
      // A genuine receipt and reviewed line still cannot commit without the posted count and audit.
      await assert.rejects(receiveFound(), error => /posted count.*journal.*review/i.test(
        guardRefusalMessage(error, { includeRaisedCheckViolations: true }) ?? String(error)));
      assert.deepEqual(await snapshot(), absent);
      await assert.rejects(receiveFound({ stockCountLineId: missing.line.id }), /unposted reviewed count line/);
      await assert.rejects(receiveFound({ stockLocationId: org.stockLocationId }), /reviewed count line/);
      const otherLot = await run(() => ensureLot(org.orgId,org.items.fifo,"WRONG-LOT",null,actor));
      await assert.rejects(receiveFound({ lotId: otherLot }), /different lot/);
      await assert.rejects(receiveFound({ subsidiaryId: randomUUID() }));
      await assert.rejects(run(() => receiveInventory(randomUUID(),actor,{
        itemId:org.items.fifo,stockLocationId:org.stockLocationId2,subsidiaryId:org.subsidiaryId,
        quantity:"1",unitCost:"3",offsetAccountId:org.accounts.clearing,date:org.date,
        lotId:lot,serialId:serial,admission:"count",stockCountLineId:found.line.id,
      })));
      await assert.rejects(run(() => withOrgTransaction(org.orgId, async () => {
        await postStockCount(org.orgId,actor,found.count.id,{foundUnitCosts:{[found.line.id]:"3"}});
        throw new Error("roll back the recovery");
      })), /roll back the recovery/);
      assert.deepEqual(await snapshot(), absent);
      assert.equal((await run(() => getStockCountDetail(org.orgId,found.count.id,null))).lines[0]!.adjustmentMovementId,null);
      await post(found);
      await assert.rejects(post(found), /posted|review/);
      assert.equal((await snapshot()).state[0]!.current_missing_count_movement_id,null);
      const missingAgain = await reviewCount("0");
      await post(missingAgain);
      assert.notEqual((await snapshot()).state[0]!.current_missing_count_movement_id,missingLine.adjustment_movement_id);
      await post(await reviewCount("1"));
      const restored = (
        await run(() =>
          db.execute<{
            status: string;
            lot_id: string;
            current_stock_location_id: string;
          }>(
            sql`select status,lot_id,current_stock_location_id from serials where org_id=${org.orgId} and id=${serial}`,
          ),
        )
      ).rows[0]!;
      assert.equal(restored.status, "in_stock");
      assert.equal(restored.lot_id, lot);
      assert.equal(restored.current_stock_location_id, org.stockLocationId2);
      await run(() => issueInventory(org.orgId,actor,{
        itemId:org.items.fifo,stockLocationId:org.stockLocationId2,subsidiaryId:org.subsidiaryId,
        quantity:"1",date:org.date,lotId:lot,serialId:serial,
      }));
      const shipped = await snapshot();
      assert.equal(shipped.state[0]!.current_missing_count_movement_id,null);
      await assert.rejects(post(await reviewCount("1")), /current posted missing-count issue.*source shipment return/);
      assert.deepEqual(await snapshot(),shipped,"historical missing cycles cannot restore ordinary customer shipments");
      await assert.rejects(run(() => db.execute(sql`update serials
        set current_missing_count_movement_id=${missingLine.adjustment_movement_id}
        where org_id=${org.orgId} and id=${serial}`)), error => /exact current count issue/i.test(
          guardRefusalMessage(error,{includeRaisedCheckViolations:true}) ?? String(error)));
      assert.deepEqual(await snapshot(),shipped);

    } finally {
      await run(() => dropScratchOrg(org.orgId));
    }
  },
);
