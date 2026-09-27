import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { toUnits } from "../money/money.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { getAvailableToPromise, releasableBackorders } from "./availability.ts";
import { issueInventory, receiveInventory } from "./movements.ts";
import { getOnHandWith } from "./position.ts";
import { replenishmentProposals } from "./replenishment.ts";
import { transferInventory } from "./transfers.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const run = <T>(work: () => Promise<T>) => withBypassContext(work);

type OrderLine = { quantity: string; location: string | null };

test("available to promise agrees with the layer math term by term, and replenishment proposes from projected supply", { skip: !DB }, async () => {
  const org = await run(() => createScratchOrg());
  try {
    const user = await run(() => createScratchUser(org.orgId, "Planner", "admin"));
    const item = org.items.fifo;
    const [main, stage, bin, subB] = [org.stockLocationId, org.stockLocationId2, randomUUID(), randomUUID()];
    const subA = org.subsidiaryId;
    await run(async () => {
      await db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
               || '{"orders": true, "warehousing": true, "fulfillment": true}'::jsonb) where id = ${org.orgId}`);
      await db.execute(sql`
        insert into stock_locations (id, org_id, location_id, parent_id, code, kind, is_active)
        values (${bin}, ${org.orgId}, ${org.locationId}, ${main}, 'MAIN-A1', 'bin', true)`);
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values (${subB}, ${org.orgId}, ${subA}, 'Sub Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
      await db.execute(sql`
        update item_inventory_profiles set reorder_point = 20, preferred_stock_level = 30
         where org_id = ${org.orgId} and item_id = ${item}`);
    });

    /** An issued order; lines are written while it is a draft, as the order drawer does. */
    const order = (kind: "sales_order" | "purchase_order" | "purchase_receipt", number: string, date: string, subsidiaryId: string, lines: OrderLine[]) =>
      run(async () => {
        const id = randomUUID();
        const party = kind === "sales_order" ? org.customerId : org.vendorId;
        await db.execute(sql`
          insert into documents (id, org_id, kind, document_number, party_id, document_date, currency, status, subsidiary_id)
          values (${id}, ${org.orgId}, ${kind}, ${number}, ${party}, ${date}, 'CAD', 'draft', ${subsidiaryId})`);
        const lineIds: string[] = [];
        for (const [index, line] of lines.entries()) {
          const lineId = randomUUID();
          lineIds.push(lineId);
          await db.execute(sql`
            insert into document_lines (id, org_id, document_id, line_number, item_id, description, quantity, unit,
                                        unit_price, amount, tax_amount, stock_location_id, custom)
            values (${lineId}, ${org.orgId}, ${id}, ${index + 1}, ${item}, 'Widget', ${line.quantity}, 'ea',
                    '0', '0', '0', ${line.location}, '{}'::jsonb)`);
        }
        if (kind !== "purchase_receipt") {
          await db.execute(sql`update documents set status = 'approved' where id = ${id} and org_id = ${org.orgId}`);
        }
        return { id, lineIds };
      });
    /** Advance an issued line the way fulfilment and cancellation do: reopen, advance, restore. */
    const advance = (documentId: string, lineId: string, column: "quantity_fulfilled" | "quantity_cancelled", quantity: string) =>
      run(async () => {
        await db.execute(sql`update documents set status = 'draft' where id = ${documentId} and org_id = ${org.orgId}`);
        await db.execute(sql`
          update document_lines set ${sql.raw(column)} = ${sql.raw(column)} + ${quantity}::numeric
           where id = ${lineId} and org_id = ${org.orgId}`);
        await db.execute(sql`update documents set status = 'approved' where id = ${documentId} and org_id = ${org.orgId}`);
      });
    const receive = (stockLocationId: string, quantity: string, subsidiaryId = subA, documentLineId: string | null = null) =>
      run(() => receiveInventory(org.orgId, user, {
        itemId: item, stockLocationId, quantity, unitCost: "2", subsidiaryId,
        offsetAccountId: org.accounts.clearing, date: org.date, documentLineId,
      }));
    const atp = (warehouseId?: string) =>
      run(() => getAvailableToPromise(db, org.orgId, { itemId: item, subsidiaryId: subA, warehouseId }));
    const terms = (result: Awaited<ReturnType<typeof atp>>) =>
      [result.onHand, result.committed, result.available, result.unallocated].map(toUnits);

    // Receipts, an issue and a bin transfer; another entity's stock shares the warehouse.
    const receipt = await order("purchase_receipt", "RCPT-1", "2026-07-01", subA, [{ quantity: "4", location: stage }]);
    await receive(stage, "4", subA, receipt.lineIds[0]!);
    await receive(main, "10");
    await receive(bin, "5");
    await receive(main, "50", subB);
    await run(() => issueInventory(org.orgId, user, { itemId: item, stockLocationId: main, quantity: "2", subsidiaryId: subA, date: org.date }));
    await run(() => transferInventory(org.orgId, user, {
      itemId: item, fromStockLocationId: main, toStockLocationId: bin, quantity: "3", subsidiaryId: subA, date: org.date,
    }));

    let layers = 0n;
    for (const location of [main, bin]) {
      layers += toUnits((await run(() => getOnHandWith(db, org.orgId, item, location, { subsidiaryId: subA }))).quantity);
    }
    assert.equal(layers, toUnits("13"));
    assert.equal(toUnits((await atp(main)).onHand), layers, "on hand in a warehouse is the layer read over its locations");
    assert.deepEqual(terms(await atp()), ["17", "0", "17", "0"].map(toUnits), "every location of the entity, and never another entity's layers");

    // Demand: the later-numbered order is the earlier one, an unplaced line, and another entity's order.
    const early = await order("sales_order", "SO-200", "2026-07-01", subA, [{ quantity: "9", location: bin }]);
    const late = await order("sales_order", "SO-100", "2026-07-10", subA, [{ quantity: "6", location: main }]);
    await order("sales_order", "SO-300", "2026-07-05", subA, [{ quantity: "2", location: null }]);
    await order("sales_order", "SO-900", "2026-07-02", subB, [{ quantity: "7", location: main }]);
    assert.deepEqual(terms(await atp(main)), ["13", "15", "-2", "2"].map(toUnits));

    const releasable = await run(() => releasableBackorders(db, org.orgId, { subsidiaryId: subA, warehouseId: main }));
    assert.deepEqual(
      releasable.map((line) => [line.documentNumber, toUnits(line.releasable)]),
      [["SO-200", toUnits("9")], ["SO-100", toUnits("4")]],
      "stock goes to the earliest order date first, whatever the document number",
    );
    assert.equal(releasable[0]!.warehouseId, main);

    await advance(late.id, late.lineIds[0]!, "quantity_fulfilled", "2");
    assert.equal(toUnits((await atp(main)).committed), toUnits("13"), "a fulfilled quantity is no longer committed");
    await advance(early.id, early.lineIds[0]!, "quantity_cancelled", "1");
    assert.equal(toUnits((await atp(main)).committed), toUnits("12"), "a cancelled remainder is no longer committed");

    // projected = 17 on hand − 12 committed − 2 unallocated + 0 on order = 3 ≤ 20 → order 30 − 3.
    const proposals = async () => new Map((await run(() => replenishmentProposals(db, org.orgId, { subsidiaryId: subA })))
      .map((line) => [line.itemId, line]));
    const proposed = (await proposals()).get(item)!;
    assert.deepEqual(
      [proposed.status, proposed.projected, proposed.proposed, proposed.vendorId].map(String),
      ["reorder", "3.0000", "27.0000", org.vendorId],
      "the proposal restores the preferred level and names the vendor of the last receipt",
    );
    const unset = (await proposals()).get(org.items.movingAvg)!;
    assert.deepEqual([unset.status, unset.proposed], ["no_reorder_point", "0.0000"], "an item without points is listed, not proposed");

    await order("purchase_order", "PO-1", "2026-07-12", subA, [{ quantity: "27", location: main }]);
    const covered = (await proposals()).get(item)!;
    assert.deepEqual([covered.status, covered.onOrder, covered.proposed], ["covered", "27.0000", "0.0000"]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
