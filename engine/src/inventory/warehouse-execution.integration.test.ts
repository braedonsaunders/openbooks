import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgTransaction } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { createWarehouseOperator } from "../testing/warehouse-execution.ts";
import { receiveInventory } from "./movements.ts";
import { ensureLot, ensureSerial } from "./tracking.ts";
import { getOnHandWith } from "./position.ts";
import {
  confirmExecutionTask,
  executionTaskView,
} from "./directed-execution.ts";
import {
  suggestReceiptConfirmation,
  suggestPutaway,
  suggestCountObservation,
  executeInventoryDirection,
} from "./warehouse-directions.ts";
import {
  createStockCount,
  startStockCount,
  recordCountedQuantity,
} from "./stock-counts.ts";
import { getStockCountDetail } from "./stock-count-queries.ts";
import { purchaseReceiptQueue } from "./receiving-queue.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const native = <T>(work: () => Promise<T>) => withBypassContext(work);

test(
  "receipt, putaway and blind count scans retain combined identifiers, exceptions, replay and current authority",
  { skip: !DB },
  async () => {
    const org = await native(() => createScratchOrg());
    const other = await native(() => createScratchOrg());
    let scenarioError: unknown;
    try {
      const actor = await native(() =>
        createWarehouseOperator(org.orgId, "Receiver"),
      );
      const observer = await native(() =>
        createWarehouseOperator(org.orgId, "Count observer"),
      );
      const stage = randomUUID(),
        target = randomUUID(),
        wrong = randomUUID(),
        receipt = randomUUID(),
        line = randomUUID();
      await native(async () => {
        await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)
        ||'{"inventory":true,"warehousing":true,"barcodeScanning":true}'::jsonb) where id=${org.orgId}`);
        await db.execute(
          sql`update items set code='SCAN-WIDGET' where org_id=${org.orgId} and id=${org.items.fifo}`,
        );
        await db.execute(
          sql`update item_inventory_profiles set tracking='lot_serial' where org_id=${org.orgId} and item_id=${org.items.fifo}`,
        );
        for (const [id, code, kind] of [
          [stage, "SCAN-STAGE", "staging"],
          [target, "SCAN-A", "bin"],
          [wrong, "SCAN-B", "bin"],
        ]) {
          await db.execute(sql`insert into stock_locations(id,org_id,location_id,parent_id,code,kind,is_active)
          values(${id},${org.orgId},${org.locationId},${org.stockLocationId},${code},${kind},true)`);
        }
        await db.execute(sql`insert into putaway_rules(org_id,warehouse_id,sequence,item_id,strategy,target_location_id)
        values(${org.orgId},${org.stockLocationId},10,${org.items.fifo},'fixed-bin',${target})`);
        await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,document_date,currency,status,subsidiary_id,created_by)
        values(${receipt},${org.orgId},'purchase_receipt','PR-SCAN',${org.vendorId},${org.date},'CAD','draft',${org.subsidiaryId},${actor})`);
        await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,item_id,account_id,description,quantity,unit,unit_price,amount,tax_amount,stock_location_id)
        values(${line},${org.orgId},${receipt},1,${org.items.fifo},${org.accounts.invAsset},'Widget','1','ea','3','3','0',${stage})`);
        await db.execute(
          sql`update documents set status='approved',subtotal='3',total='3' where org_id=${org.orgId} and id=${receipt}`,
        );
      });
      const lot = await native(() =>
        ensureLot(org.orgId, org.items.fifo, "SCAN-LOT", null, actor),
      );
      const serial = await native(() =>
        ensureSerial(org.orgId, org.items.fifo, "SCAN-SERIAL", null, actor),
      );
      await native(() =>
        receiveInventory(org.orgId, actor, {
          itemId: org.items.fifo,
          stockLocationId: stage,
          subsidiaryId: org.subsidiaryId,
          lotId: lot,
          serialId: serial,
          quantity: "1",
          unitCost: "3",
          date: org.date,
          offsetAccountId: org.accounts.clearing,
          documentLineId: line,
        }),
      );
      const acknowledge = await suggestReceiptConfirmation(org.orgId, actor, {
        lineId: line,
        commandKey: randomUUID(),
      });
      const scan = {
        item: "SCAN-WIDGET",
        bin: "SCAN-STAGE",
        quantity: "1",
        lot: "SCAN-LOT",
        serial: "SCAN-SERIAL",
      };
      const confirm = (taskId: string, evidence = scan) =>
        confirmExecutionTask(
          org.orgId,
          actor,
          { taskId, scan: evidence },
          (tx, task) => executeInventoryDirection(tx, org.orgId, actor, task),
        );
      assert.equal(
        (await confirm(acknowledge.id, { ...scan, bin: "SCAN-B" })).status,
        "exception",
      );
      const before = await native(() =>
        db.execute(
          sql`select id from inventory_movements where org_id=${org.orgId}`,
        ),
      );
      assert.equal(
        before.rows.length,
        1,
        "scan exception never posts another receipt",
      );
      assert.equal((await confirm(acknowledge.id)).status, "done");
      const replay = await confirm(acknowledge.id);
      assert.ok(replay.status === "done" && replay.replayed);
      assert.deepEqual(
        await withOrgTransaction(org.orgId, () =>
          purchaseReceiptQueue(db, org.orgId, new Set()),
        ),
        [],
      );
      assert.deepEqual(
        await withOrgTransaction(org.orgId, () =>
          purchaseReceiptQueue(db, org.orgId, null),
        ),
        [],
      );

      const putawayInput = {
        warehouseId: org.stockLocationId,
        stagingLocationId: stage,
        itemId: org.items.fifo,
        subsidiaryId: org.subsidiaryId,
        quantity: "1",
        date: org.date,
        lotId: lot,
        serialId: serial,
        commandKey: randomUUID(),
      };
      const putaway = await suggestPutaway(org.orgId, actor, putawayInput);
      assert.deepEqual(
        [putaway.to_stock_location_id, putaway.lot_id, putaway.serial_id],
        [target, lot, serial],
      );
      assert.equal(
        (await confirm(putaway.id, { ...scan, bin: "SCAN-A", quantity: "0" }))
          .status,
        "exception",
      );
      // A changed native rule refuses instead of applying an obsolete bin suggestion.
      await native(() =>
        db.execute(
          sql`update putaway_rules set target_location_id=${wrong} where org_id=${org.orgId} and warehouse_id=${org.stockLocationId}`,
        ),
      );
      await assert.rejects(
        confirm(putaway.id, { ...scan, bin: "SCAN-A" }),
        /suggest|changed|target/i,
      );
      assert.equal(
        (
          await native(() =>
            db.execute(
              sql`select id from warehouse_scan_events where org_id=${org.orgId} and task_id=${putaway.id} and outcome='confirmed'`,
            ),
          )
        ).rows.length,
        0,
        "failed transfer rolls confirmation evidence back",
      );
      await native(() =>
        db.execute(
          sql`update putaway_rules set target_location_id=${target} where org_id=${org.orgId} and warehouse_id=${org.stockLocationId}`,
        ),
      );
      assert.equal(
        (await confirm(putaway.id, { ...scan, bin: "SCAN-A" })).status,
        "done",
      );
      assert.equal(
        (
          await native(() =>
            getOnHandWith(db, org.orgId, org.items.fifo, target, {
              subsidiaryId: org.subsidiaryId,
              lotId: lot,
              serialId: serial,
            }),
          )
        ).quantity,
        "1.0000",
      );
      const position = (
        await native(() =>
          db.execute<{ current_stock_location_id: string }>(
            sql`select current_stock_location_id from serials where org_id=${org.orgId} and id=${serial}`,
          ),
        )
      ).rows[0];
      assert.equal(position?.current_stock_location_id, target);
      const movementCount = (
        await native(() =>
          db.execute(
            sql`select id from inventory_movements where org_id=${org.orgId}`,
          ),
        )
      ).rows.length;
      await confirm(putaway.id, { ...scan, bin: "SCAN-A" });
      assert.equal(
        (
          await native(() =>
            db.execute(
              sql`select id from inventory_movements where org_id=${org.orgId}`,
            ),
          )
        ).rows.length,
        movementCount,
      );
      await assert.rejects(
        confirmExecutionTask(
          other.orgId,
          actor,
          { taskId: putaway.id, scan },
          async () => ({}),
        ),
        /not found/i,
      );
      await native(() =>
        db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features,warehousing}','false') where id=${org.orgId}`,
        ),
      );
      await assert.rejects(
        confirm(putaway.id, { ...scan, bin: "SCAN-A" }),
        /Turn on warehousing/i,
      );
      await native(() =>
        db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features,warehousing}','true') where id=${org.orgId}`,
        ),
      );

      const count = await native(() =>
        createStockCount(org.orgId, actor, {
          locationId: org.locationId,
          subsidiaryId: org.subsidiaryId,
          countedOn: org.date,
          blind: true,
          lines: [
            {
              itemId: org.items.fifo,
              stockLocationId: target,
              lotId: lot,
              serialId: serial,
            },
          ],
        }),
      );
      await native(() => startStockCount(org.orgId, actor, count.id));
      const detail = await native(() =>
        getStockCountDetail(org.orgId, count.id, null),
      );
      assert.equal(detail.lines[0]!.expectedQuantity, null);
      const countLine = detail.lines[0]!.id;
      await assert.rejects(
        native(() =>
          recordCountedQuantity(org.orgId, actor, {
            countId: count.id,
            lineId: countLine,
            countedQuantity: "0",
          }),
        ),
        /Scan the suggested/,
      );
      const first = await suggestCountObservation(org.orgId, actor, {
        lineId: countLine,
        quantity: "0",
        observation: "first",
        commandKey: randomUUID(),
      });
      const view = await withOrgTransaction(org.orgId, () =>
        executionTaskView(db, org.orgId, actor, first.id),
      );
      assert.match(view.quantity, /^0(?:\.0+)?$/);
      assert.ok(
        !("expectedQuantity" in view) && !("expectedQuantity" in first.basis),
      );
      assert.equal(
        (await confirm(first.id, { ...scan, bin: "SCAN-A", quantity: "0" }))
          .status,
        "done",
      );
      const second = await suggestCountObservation(org.orgId, observer, {
        lineId: countLine,
        quantity: "0",
        observation: "second",
        commandKey: randomUUID(),
      });
      const result = await confirmExecutionTask(
        org.orgId,
        observer,
        { taskId: second.id, scan: { ...scan, bin: "SCAN-A", quantity: "0" } },
        (tx, task) => executeInventoryDirection(tx, org.orgId, observer, task),
      );
      assert.equal(result.status, "done");
      const counted = (
        await native(() =>
          db.execute<{
            first_counted_by: string;
            second_counted_by: string;
          }>(sql`
      select first_counted_by,second_counted_by from stock_count_lines where org_id=${org.orgId} and id=${countLine}`),
        )
      ).rows[0];
      assert.deepEqual(counted, {
        first_counted_by: actor,
        second_counted_by: observer,
      });
    } catch (error) {
      scenarioError = error;
      throw error;
    } finally {
      try {
        await native(() => dropScratchOrg(other.orgId));
        await native(() => dropScratchOrg(org.orgId));
      } catch (cleanupError) {
        throw scenarioError
          ? new AggregateError(
              [scenarioError, cleanupError],
              "Warehouse scenario and cleanup failed",
            )
          : cleanupError;
      }
    }
  },
);
