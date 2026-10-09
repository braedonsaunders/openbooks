import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgTransaction } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { receiveInventory, issueInventory } from "./movements.ts";
import { transferInventory } from "./transfers.ts";
import { ensureLot, ensureSerial } from "./tracking.ts";
import { allocationCandidates } from "./allocation.ts";
import { setStockHold } from "./stock-holds.ts";
import { getOnHandWith } from "./position.ts";
import { moveConsignment } from "./consignment.ts";
import {
  createStockCount,
  startStockCount,
  recordCountedQuantity,
  submitStockCountForReview,
  postStockCount,
} from "./stock-counts.ts";
import { recordSecondCount } from "./second-count.ts";
import { getStockCountDetail } from "./stock-count-queries.ts";
import { inventoryInquiry } from "./inquiry.ts";
import { createInventoryOperator } from "../testing/inventory-counts.ts";
import { cmp } from "../money/money.ts";
import { guardRefusalMessage } from "../platform/database-refusal.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const run = <T>(work: () => Promise<T>) => withBypassContext(work);

test(
  "FEFO physical candidates skip held and quarantined stock while FIFO layer rates and on-hand remain intact",
  { skip: !DB },
  async () => {
    const org = await run(() => createScratchOrg());
    try {
      const actor = await run(() =>
        createInventoryOperator(org.orgId, "Stock operator"),
      );
      const item = org.items.fifo;
      const areaId = randomUUID(), binId = randomUUID();
      const area = await run(() => db.execute(sql`insert into stock_locations(id,org_id,location_id,parent_id,code,kind,is_active)
        values(${areaId},${org.orgId},${org.locationId},${org.stockLocationId},'INSPECTION','bin',true) returning id`));
      assert.equal(area.rows.length, 1);
      const bin = await run(() => db.execute(sql`insert into stock_locations(id,org_id,location_id,parent_id,code,kind,is_active)
        values(${binId},${org.orgId},${org.locationId},${areaId},'INSPECTION-1','bin',true) returning id`));
      assert.equal(bin.rows.length, 1);
      await run(() =>
        db.execute(
          sql`update item_inventory_profiles set tracking='lot' where org_id=${org.orgId} and item_id=${item}`,
        ),
      );
      const late = await run(() =>
          ensureLot(org.orgId, item, "LATE", "2027-12-01", actor),
        ),
        early = await run(() =>
          ensureLot(org.orgId, item, "EARLY", "2027-01-01", actor),
        );
      const receive = (lotId: string, unitCost: string) =>
        run(() =>
          receiveInventory(org.orgId, actor, {
            itemId: item,
            stockLocationId: binId,
            subsidiaryId: org.subsidiaryId,
            quantity: "3",
            unitCost,
            date: org.date,
            offsetAccountId: org.accounts.clearing,
            lotId,
          }),
        );
      const first = await receive(late, "2"),
        second = await receive(early, "5");
      const choices = () =>
        run(() =>
          allocationCandidates(
            db,
            org.orgId,
            item,
            binId,
            org.subsidiaryId,
            null,
          ),
        );
      assert.deepEqual(
        (await choices()).map((c) => c.lotId),
        [early, late],
      );
      await run(() =>
        setStockHold(org.orgId, actor, {
          kind: "lot",
          id: early,
          held: true,
          reason: "Await quality clearance",
        }),
      );
      assert.deepEqual(
        (await choices()).map((c) => c.lotId),
        [late],
      );
      await assert.rejects(
        run(() =>
          issueInventory(org.orgId, actor, {
            itemId: item,
            stockLocationId: binId,
            subsidiaryId: org.subsidiaryId,
            quantity: "1",
            lotId: early,
            date: org.date,
          }),
        ),
        /held|quarantined/,
      );
      const physical = await run(() =>
        getOnHandWith(db, org.orgId, item, binId, {
          subsidiaryId: org.subsidiaryId,
        }),
      );
      const saleable = await run(() =>
        getOnHandWith(db, org.orgId, item, binId, {
          subsidiaryId: org.subsidiaryId,
          saleableOnly: true,
        }),
      );
      assert.equal(cmp(physical.quantity, "6"), 0);
      assert.equal(cmp(saleable.quantity, "3"), 0);
      await run(() =>
        setStockHold(org.orgId, actor, {
          kind: "lot",
          id: early,
          held: false,
          reason: "Inspection passed today",
        }),
      );
      const released = (
        await run(() =>
          db.execute<{ count: number }>(
            sql`select count(*)::int as count from audit_log where org_id=${org.orgId} and row_id=${early} and changes->>'operation'='release'`,
          ),
        )
      ).rows[0]!.count;
      assert.equal(released, 1);
      const inquiry = await run(() =>
        inventoryInquiry(org.orgId, actor, { view: "layers", itemId: item }),
      );
      assert.equal(inquiry.rows.length, 2);
      assert.deepEqual(
        new Set(inquiry.rows.map((r) => r.source_movement_id)),
        new Set([first.movementId, second.movementId]),
      );
      const quarantined = await run(() =>
        db.execute(
          sql`update stock_locations set kind='quarantine' where org_id=${org.orgId} and id=${areaId} returning id`,
        ),
      );
      assert.equal(quarantined.rows.length, 1);
      assert.deepEqual(await choices(), []);
      assert.equal(
        cmp(
          (
            await run(() =>
              getOnHandWith(db, org.orgId, item, binId, {
                subsidiaryId: org.subsidiaryId,
                saleableOnly: true,
              }),
            )
          ).quantity,
          "0",
        ),
        0,
      );
      assert.equal(cmp((await run(() => getOnHandWith(db, org.orgId, item, binId, {
        subsidiaryId: org.subsidiaryId,
      }))).quantity, "6"), 0, "quarantine preserves physical stock");
    } finally {
      await run(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "blind count APIs conceal the snapshot and require a second observation without changing the drift basis",
  { skip: !DB },
  async () => {
    const org = await run(() => createScratchOrg());
    try {
      const actor = await run(() =>
        createInventoryOperator(org.orgId, "Counter"),
      );
      await run(() =>
        receiveInventory(org.orgId, actor, {
          itemId: org.items.fifo,
          stockLocationId: org.stockLocationId,
          subsidiaryId: org.subsidiaryId,
          quantity: "10",
          unitCost: "2",
          offsetAccountId: org.accounts.clearing,
          date: org.date,
        }),
      );
      const count = await run(() =>
        createStockCount(org.orgId, actor, {
          locationId: org.locationId,
          subsidiaryId: org.subsidiaryId,
          countedOn: org.date,
          lines: [
            { itemId: org.items.fifo, stockLocationId: org.stockLocationId },
          ],
        }),
      );
      await run(() => startStockCount(org.orgId, actor, count.id));
      let detail = await run(() =>
        getStockCountDetail(org.orgId, count.id, null),
      );
      const line = detail.lines[0]!;
      assert.equal(line.expectedQuantity, null);
      assert.equal(line.variance, null);
      const result = await run(() =>
        recordCountedQuantity(org.orgId, actor, {
          countId: count.id,
          lineId: line.id,
          countedQuantity: "8",
        }),
      );
      assert.equal(result.variance, null);
      await assert.rejects(
        run(() => submitStockCountForReview(org.orgId, actor, count.id)),
        /second blind count/,
      );
      await assert.rejects(
        run(() =>
          recordSecondCount(org.orgId, actor, {
            countId: count.id,
            lineId: line.id,
            countedQuantity: "7",
          }),
        ),
        /Explain why/,
      );
      await run(() =>
        recordSecondCount(org.orgId, actor, {
          countId: count.id,
          lineId: line.id,
          countedQuantity: "8",
        }),
      );
      detail = await run(() => getStockCountDetail(org.orgId, count.id, null));
      assert.equal(detail.lines[0]!.expectedQuantity, null);
      await run(() => submitStockCountForReview(org.orgId, actor, count.id));
      await run(() =>
        withOrgTransaction(org.orgId, () =>
          postStockCount(org.orgId, actor, count.id),
        ),
      );
      assert.equal(
        cmp(
          (
            await run(() =>
              getOnHandWith(db, org.orgId, org.items.fifo, org.stockLocationId),
            )
          ).quantity,
          "8",
        ),
        0,
      );
    } finally {
      await run(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "external custody is unvalued until audited ownership acquisition posts a native receipt and combined identifiers survive",
  { skip: !DB },
  async () => {
    const org = await run(() => createScratchOrg());
    try {
      const actor = await run(() =>
          createInventoryOperator(org.orgId, "Custody operator"),
        ),
        external = randomUUID();
      await run(() =>
        db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"inventory":true,"consignment":true}'::jsonb) where id=${org.orgId}`,
        ),
      );
      await run(() =>
        db.execute(sql`insert into stock_locations(id,org_id,location_id,code,kind,inventory_ownership,owner_party_id)
    values(${external},${org.orgId},${org.locationId},'VENDOR-CUSTODY','bin','vendor',${org.vendorId})`),
      );
      await run(() =>
        db.execute(
          sql`update item_inventory_profiles set tracking='lot_serial' where org_id=${org.orgId} and item_id=${org.items.fifo}`,
        ),
      );
      const lot = await run(() =>
          ensureLot(org.orgId, org.items.fifo, "COMBINED", "2027-02-01", actor),
        ),
        serial = await run(() =>
          ensureSerial(org.orgId, org.items.fifo, "SERIAL-001", null, actor),
        );
      const receipt = await run(() =>
        moveConsignment(org.orgId, actor, {
          action: "receive",
          itemId: org.items.fifo,
          stockLocationId: external,
          subsidiaryId: org.subsidiaryId,
          quantity: "1",
          lotId: lot,
          serialId: serial,
          date: org.date,
          reason: "Vendor delivery into custody",
        }),
      );
      assert.equal(receipt.receiptMovementId, null);
      assert.equal(
        cmp(
          (
            await run(() =>
              getOnHandWith(db, org.orgId, org.items.fifo, external),
            )
          ).value,
          "0",
        ),
        0,
      );
      await assert.rejects(
        run(() =>
          receiveInventory(org.orgId, actor, {
            itemId: org.items.fifo,
            stockLocationId: org.stockLocationId,
            subsidiaryId: org.subsidiaryId,
            quantity: "1",
            unitCost: "12.3456",
            offsetAccountId: org.accounts.clearing,
            date: org.date,
            lotId: lot,
            serialId: serial,
          }),
        ),
        /externally owned/,
      );
      await assert.rejects(
        run(() =>
          moveConsignment(org.orgId, actor, {
            action: "take_ownership",
            stockId: receipt.stockId,
            quantity: "1",
            toStockLocationId: org.stockLocationId,
            date: org.date,
            unitCost: "12.3456",
            offsetAccountId: randomUUID(),
            reason: "Ownership account is not configured",
          }),
        ),
      );
      const afterRefusal = (
        await run(() =>
          db.execute<{ remaining_quantity: string }>(
            sql`select remaining_quantity::text from consignment_stock where org_id=${org.orgId} and id=${receipt.stockId}`,
          ),
        )
      ).rows[0]!;
      assert.equal(
        cmp(afterRefusal.remaining_quantity, "1"),
        0,
        "a failed native posting must restore the custody decrease",
      );
      assert.equal(
        cmp(
          (
            await run(() =>
              getOnHandWith(db, org.orgId, org.items.fifo, org.stockLocationId),
            )
          ).value,
          "0",
        ),
        0,
      );
      const acquired = await run(() =>
        moveConsignment(org.orgId, actor, {
          action: "take_ownership",
          stockId: receipt.stockId,
          quantity: "1",
          toStockLocationId: org.stockLocationId,
          date: org.date,
          unitCost: "12.3456",
          offsetAccountId: org.accounts.clearing,
          reason: "Ownership accepted at agreed price",
        }),
      );
      assert.ok(acquired.receiptMovementId);
      const movement = (
        await run(() =>
          db.execute<{
            lot_id: string;
            serial_id: string;
            journal_entry_id: string;
          }>(
            sql`select lot_id,serial_id,journal_entry_id from inventory_movements where org_id=${org.orgId} and id=${acquired.receiptMovementId}`,
          ),
        )
      ).rows[0]!;
      assert.equal(movement.lot_id, lot);
      assert.equal(movement.serial_id, serial);
      assert.ok(movement.journal_entry_id);
      assert.equal(
        cmp(
          (
            await run(() =>
              getOnHandWith(db, org.orgId, org.items.fifo, org.stockLocationId),
            )
          ).value,
          "12.3456",
        ),
        0,
      );
      await assert.rejects(
        run(() =>
          moveConsignment(org.orgId, actor, {
            action: "take_ownership",
            stockId: receipt.stockId,
            quantity: "1",
            toStockLocationId: org.stockLocationId,
            date: org.date,
            unitCost: "12.3456",
            offsetAccountId: org.accounts.clearing,
            reason: "Repeated ownership request",
          }),
        ),
        /exceeds stock/,
      );
    } finally {
      await run(() => dropScratchOrg(org.orgId));
    }
  },
);

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
      async function countAndPost(quantity: string, found: boolean) {
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
        await run(() =>
          withOrgTransaction(org.orgId, () =>
            postStockCount(org.orgId, actor, count.id, {
              foundUnitCosts: found ? { [line.id]: "3" } : undefined,
            }),
          ),
        );
      }
      await countAndPost("0", false);
      await countAndPost("1", true);
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
    } finally {
      await run(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "ABC count intervals require effective entity policies and snapshot the tolerance",
  { skip: !DB },
  async () => {
    const org = await run(() => createScratchOrg());
    try {
      const actor = await run(() =>
        createInventoryOperator(org.orgId, "Cycle planner"),
      );
      await run(() =>
        db.execute(
          sql`update item_inventory_profiles set abc_class='A' where org_id=${org.orgId} and item_id=${org.items.fifo}`,
        ),
      );
      const open = () =>
        run(() =>
          createStockCount(org.orgId, actor, {
            locationId: org.locationId,
            subsidiaryId: org.subsidiaryId,
            countedOn: org.date,
            lines: [
              { itemId: org.items.fifo, stockLocationId: org.stockLocationId },
            ],
          }),
        );
      await assert.rejects(open(), /effective A cycle-count policy/);
      const policy = (
        await run(() =>
          db.execute<{
            id: string;
          }>(sql`insert into inventory_count_policies(org_id,subsidiary_id,abc_class,interval_days,variance_tolerance,effective_from,created_by,updated_by)
   values(${org.orgId},${org.subsidiaryId},'A',7,'2',${org.date},${actor},${actor}) returning id`),
        )
      ).rows[0]!;
      const count = await open();
      const line = (
        await run(() =>
          db.execute<{ variance_tolerance: string }>(
            sql`select variance_tolerance::text from stock_count_lines where org_id=${org.orgId} and stock_count_id=${count.id}`,
          ),
        )
      ).rows[0]!;
      assert.equal(cmp(line.variance_tolerance, "2"), 0);
      const due = await run(() =>
        inventoryInquiry(org.orgId, actor, { view: "cycle_due" }),
      );
      const item = due.rows.find(
        (row) =>
          row.item_id === org.items.fifo &&
          row.subsidiary_id === org.subsidiaryId,
      )!;
      assert.equal(item.interval, 7);
      assert.equal(item.status, "due");
      await assert.rejects(
        run(() =>
          db.execute(
            sql`update inventory_count_policies set variance_tolerance=5 where org_id=${org.orgId} and id=${policy.id}`,
          ),
        ),
        (error: unknown) => {
          assert.match(guardRefusalMessage(error) ?? "", /immutable/);
          return true;
        },
      );
    } finally {
      await run(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "independent review includes an earlier second observer after a later correction replaces the current observation",
  { skip: !DB },
  async () => {
    const org = await run(() => createScratchOrg());
    try {
      const first = await run(() =>
        createInventoryOperator(org.orgId, "First counter"),
      );
      const second = await run(() =>
        createInventoryOperator(org.orgId, "Second counter"),
      );
      const reviewer = await run(() =>
        createInventoryOperator(org.orgId, "Count reviewer"),
      );
      await run(() =>
        db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{approvals}',coalesce(settings->'approvals','{}'::jsonb)||'{"requireStockCountReview":true}'::jsonb) where id=${org.orgId}`,
        ),
      );
      await run(() =>
        receiveInventory(org.orgId, first, {
          itemId: org.items.fifo,
          stockLocationId: org.stockLocationId,
          subsidiaryId: org.subsidiaryId,
          quantity: "10",
          unitCost: "2",
          offsetAccountId: org.accounts.clearing,
          date: org.date,
        }),
      );
      const count = await run(() =>
        createStockCount(org.orgId, first, {
          locationId: org.locationId,
          subsidiaryId: org.subsidiaryId,
          countedOn: org.date,
          lines: [
            { itemId: org.items.fifo, stockLocationId: org.stockLocationId },
          ],
        }),
      );
      await run(() => startStockCount(org.orgId, first, count.id));
      const line = (
        await run(() => getStockCountDetail(org.orgId, count.id, null))
      ).lines[0]!;
      await run(() =>
        recordCountedQuantity(org.orgId, first, {
          countId: count.id,
          lineId: line.id,
          countedQuantity: "8",
        }),
      );
      await run(() =>
        recordSecondCount(org.orgId, second, {
          countId: count.id,
          lineId: line.id,
          countedQuantity: "8",
        }),
      );
      await run(() =>
        recordCountedQuantity(org.orgId, first, {
          countId: count.id,
          lineId: line.id,
          countedQuantity: "9",
          reason: "Corrected the physical tally",
        }),
      );
      await run(() =>
        recordSecondCount(org.orgId, first, {
          countId: count.id,
          lineId: line.id,
          countedQuantity: "9",
        }),
      );
      await run(() => submitStockCountForReview(org.orgId, first, count.id));
      await assert.rejects(
        run(() =>
          withOrgTransaction(org.orgId, () =>
            postStockCount(org.orgId, second, count.id),
          ),
        ),
        /Second counter.*independent review/,
      );
      const posted = await run(() =>
        withOrgTransaction(org.orgId, () =>
          postStockCount(org.orgId, reviewer, count.id),
        ),
      );
      assert.equal(posted.status, "posted");
      const audit = (
        await run(() =>
          db.execute<{ contributors: string[] }>(
            sql`select changes->'review'->'contributors' as contributors from audit_log where org_id=${org.orgId} and table_name='stock_counts' and row_id=${count.id} and changes->>'operation'='post'`,
          ),
        )
      ).rows[0]!;
      assert.deepEqual(new Set(audit.contributors), new Set([first, second]));
    } finally {
      await run(() => dropScratchOrg(org.orgId));
    }
  },
);
