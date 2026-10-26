import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrg } from "@openbooks/engine/platform/db";
import { receiveInventory } from "@openbooks/engine/inventory/movements";
import {
  createPickList,
  createShipment,
  pickCandidates,
  releasePickList,
  setShipmentCarrier,
} from "@openbooks/engine/sales/fulfillment/module";
import { createScratchOrg, dropScratchOrg } from "@openbooks/engine/testing/fixtures";
import {
  confirmFixturePick,
  createWarehouseOperator,
  packFixtureShipment,
} from "@openbooks/engine/testing/warehouse-execution";
import { completeShipment } from "./shipments";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

test(
  "kit shipments complete when recipes include non-stocked components",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actorId = await withBypassContext(() =>
        createWarehouseOperator(org.orgId, "Kit shipper"),
      );
      const binId = randomUUID();
      const orderId = randomUUID();
      const lineId = randomUUID();
      const carrierId = randomUUID();
      const scoped = { allowedSubsidiaryIds: null };

      await withBypassContext(async () => {
        await db.execute(sql`
          update orgs set settings = jsonb_set(settings, '{features}',
            coalesce(settings->'features', '{}'::jsonb) ||
            '{"orders": true, "warehousing": true, "fulfillment": true}'::jsonb)
           where id = ${org.orgId}`);
        await db.execute(
          sql`update items set kind = 'kit' where org_id = ${org.orgId} and id = ${org.items.assembly}`,
        );
        await db.execute(sql`
          insert into bom_components
            (org_id, assembly_item_id, component_item_id, quantity_per, sort_order)
          values (${org.orgId}, ${org.items.assembly}, ${org.items.service}, '1', 1)`);
        await db.execute(sql`
          insert into stock_locations (id, org_id, location_id, parent_id, code, kind, is_active)
          values (${binId}, ${org.orgId}, ${org.locationId}, ${org.stockLocationId}, 'KIT-A1', 'bin', true)`);
        await receiveInventory(org.orgId, actorId, {
          itemId: org.items.component,
          stockLocationId: binId,
          quantity: "10",
          unitCost: "2",
          subsidiaryId: org.subsidiaryId,
          offsetAccountId: org.accounts.clearing,
          date: org.date,
        });
        await db.execute(sql`
          insert into documents
            (id, org_id, kind, document_number, party_id, document_date, currency,
             status, subsidiary_id, subtotal, tax_total, total)
          values (${orderId}, ${org.orgId}, 'sales_order', 'SO-KIT-SERVICE', ${org.customerId},
            ${org.date}, 'CAD', 'draft', ${org.subsidiaryId}, '25', '0', '25')`);
        await db.execute(sql`
          insert into document_lines
            (id, org_id, document_id, line_number, item_id, account_id, description,
             quantity, unit, unit_price, amount, tax_amount, stock_location_id)
          values (${lineId}, ${org.orgId}, ${orderId}, 1, ${org.items.assembly}, ${org.accounts.revenue},
            'Starter kit', '1', 'ea', '25', '25', '0', ${org.stockLocationId})`);
        await db.execute(
          sql`update documents set status = 'approved' where org_id = ${org.orgId} and id = ${orderId}`,
        );
        await db.execute(sql`
          insert into carriers (id, org_id, code, name, services, tracking_url_template)
          values (${carrierId}, ${org.orgId}, 'KIT-PARCEL', 'Kit parcel', array['Ground'], null)`);
      });

      const candidates = await withOrg(org.orgId, () =>
        pickCandidates(db, org.orgId, orderId, null),
      );
      const kitComponents = candidates?.lines[0]?.kitComponents ?? [];
      assert.deepEqual(
        kitComponents.map((component) => component.componentItemId),
        [org.items.component],
      );

      const pickList = await withOrg(org.orgId, () =>
        db.transaction((tx) =>
          createPickList(tx, org.orgId, actorId, {
            salesOrderId: orderId,
            lines: [
              {
                salesOrderLineId: lineId,
                kitComponentItemId: org.items.component,
                binId,
                quantity: "2",
              },
            ],
            ...scoped,
          }),
        ),
      );
      await releasePickList(org.orgId, actorId, { pickListId: pickList.id, ...scoped });
      await confirmFixturePick(org.orgId, actorId, pickList.id);
      const shipment = await withOrg(org.orgId, () =>
        db.transaction((tx) =>
          createShipment(tx, org.orgId, actorId, {
            pickListId: pickList.id,
            documentDate: org.date,
            ...scoped,
          }),
        ),
      );
      await packFixtureShipment(org.orgId, actorId, shipment.id, binId);
      await withOrg(org.orgId, () =>
        db.transaction((tx) =>
          setShipmentCarrier(tx, org.orgId, actorId, {
            shipmentId: shipment.id,
            carrierId,
            service: "Ground",
            ...scoped,
          }),
        ),
      );

      const completed = await withOrg(org.orgId, () =>
        completeShipment(org.orgId, actorId, {
          shipmentId: shipment.id,
          ...scoped,
        }),
      );
      assert.equal(completed.replayed, false);
      const issues = await db.execute<{ item_id: string; quantity: string }>(
        sql`
        select item_id, quantity::text from inventory_movements
         where org_id = ${org.orgId} and kind = 'issue'
           and document_line_id in (
             select id from document_lines where org_id = ${org.orgId} and document_id = ${completed.fulfillmentId}
           )
         order by item_id`,
        "objects",
      );
      assert.deepEqual(issues, [{ item_id: org.items.component, quantity: "-2.0000" }]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
