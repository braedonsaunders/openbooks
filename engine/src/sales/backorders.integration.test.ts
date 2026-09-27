import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * The backorder position spans the web fulfilment service and the engine, so
 * the live assertion runs in a child with React's server condition (the same
 * shape as sales-fulfillment.integration.test.ts).
 */
test("a sales-order line conserves quantity across fulfil, cancel and a voided shipment", { skip: !DB }, () => {
  const source = `
    import assert from "node:assert/strict";
    import { randomUUID } from "node:crypto";
    import { sql } from "drizzle-orm";
    import { db, withOrg } from "./engine/src/platform/db.ts";
    import { installTrustedTestDatabaseBypass } from "./engine/src/testing/database-bypass.ts";
    import { receiveInventory } from "./engine/src/inventory/movements.ts";
    import { getAvailableToPromise } from "./engine/src/inventory/availability.ts";
    import { requestDocumentVoid } from "./engine/src/ledger/document-void.ts";
    import { toUnits } from "./engine/src/money/money.ts";
    import { salesOrderLineRemainders } from "./engine/src/records/order-line-remainders.ts";
    import { backorderPosition, cancelOrderLineRemainder } from "./engine/src/sales/backorders.ts";
    import { routeDropShipLine, unrouteDropShipLine } from "./engine/src/sales/drop-ship.ts";
    import { createOrderDraft, fulfillSalesOrder } from "./web/lib/order-cycle.ts";
    import { createScratchOrg, createScratchUser, dropScratchOrg } from "./engine/src/testing/fixtures.ts";

    installTrustedTestDatabaseBypass();

    const org = await createScratchOrg();
    const other = await createScratchOrg();
    try {
      const userId = await createScratchUser(org.orgId, "Order Desk", "admin");
      await receiveInventory(org.orgId, userId, {
        itemId: org.items.fifo, stockLocationId: org.stockLocationId,
        quantity: "10", unitCost: "2", subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing, date: org.date,
      });
      const order = await withOrg(org.orgId, () => createOrderDraft(org.orgId, userId, "sales_order", randomUUID(), null));
      const lineId = randomUUID();
      await withOrg(org.orgId, async () => {
        await db.execute(sql\`
          insert into document_lines
            (id, org_id, document_id, line_number, item_id, account_id, description,
             quantity, unit, unit_price, amount, tax_amount, stock_location_id, custom)
          values
            (\${lineId}, \${org.orgId}, \${order.id}, 1, \${org.items.fifo}, \${org.accounts.revenue},
             'Widget', '10', 'ea', '10', '100', '0', \${org.stockLocationId}, '{}'::jsonb)
        \`);
        await db.execute(sql\`
          update documents
             set status = 'approved', party_id = \${org.customerId}, subsidiary_id = \${org.subsidiaryId},
                 document_date = \${org.date}, subtotal = '100', total = '100'
           where id = \${order.id} and org_id = \${org.orgId}
        \`);
      });

      const cancel = (orgId, input) => withOrg(orgId, () => db.transaction((tx) =>
        cancelOrderLineRemainder(tx, orgId, userId, { documentId: order.id, lineId, allowedSubsidiaryIds: null, ...input })));
      const conserved = async (expected) => {
        const [line] = await withOrg(org.orgId, () => salesOrderLineRemainders(db, org.orgId, { lineId }));
        assert.equal(toUnits(line.quantity), toUnits(line.fulfilled) + toUnits(line.open) + toUnits(line.cancelled));
        assert.deepEqual(
          [line.fulfilled, line.cancelled, line.open].map(toUnits),
          expected.map(toUnits),
        );
      };

      // Off by default: the capability refuses by name until Fulfillment is on.
      await assert.rejects(cancel(org.orgId, { quantity: "1", reason: "too early" }), { code: "feature_disabled" });
      for (const orgId of [org.orgId, other.orgId]) {
        await withOrg(orgId, () => db.execute(sql\`
          update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
                 || '{"warehousing": true, "fulfillment": true, "dropShipping": true}'::jsonb) where id = \${orgId}\`));
      }

      const routedOrder = await withOrg(org.orgId, () => createOrderDraft(org.orgId, userId, "sales_order", randomUUID(), null));
      const routedLineId = randomUUID();
      await withOrg(org.orgId, async () => {
        await db.execute(sql\`
          insert into document_lines
            (id, org_id, document_id, line_number, item_id, account_id, description,
             quantity, unit, unit_price, amount, tax_amount, stock_location_id, custom)
          values
            (\${routedLineId}, \${org.orgId}, \${routedOrder.id}, 1, \${org.items.fifo}, \${org.accounts.revenue},
             'Vendor routed', '2', 'ea', '10', '20', '0', \${org.stockLocationId}, '{}'::jsonb)
        \`);
        await db.execute(sql\`
          update documents set status = 'approved', party_id = \${org.customerId}, subsidiary_id = \${org.subsidiaryId},
                 document_date = \${org.date}, subtotal = '20', total = '20'
           where id = \${routedOrder.id} and org_id = \${org.orgId}
        \`);
      });
      await withOrg(org.orgId, () => routeDropShipLine({
        orgId: org.orgId, actorId: userId, salesOrderId: routedOrder.id,
        salesOrderLineId: routedLineId, allowedSubsidiaryIds: null,
      }));
      assert.deepEqual(await withOrg(org.orgId, () => salesOrderLineRemainders(db, org.orgId, { lineId: routedLineId })), []);
      assert.equal(toUnits((await withOrg(org.orgId, () => getAvailableToPromise(db, org.orgId, {
        itemId: org.items.fifo, subsidiaryId: org.subsidiaryId,
      }))).committed), toUnits('10'), 'routed demand is absent from ATP while the other order is still open');
      await withOrg(org.orgId, () => unrouteDropShipLine({
        orgId: org.orgId, actorId: userId, salesOrderId: routedOrder.id,
        salesOrderLineId: routedLineId, allowedSubsidiaryIds: null,
      }));
      assert.equal(toUnits((await withOrg(org.orgId, () => getAvailableToPromise(db, org.orgId, {
        itemId: org.items.fifo, subsidiaryId: org.subsidiaryId,
      }))).committed), toUnits('12'), 'unrouting restores the stock commitment');

      const shipment = await withOrg(org.orgId, () => fulfillSalesOrder(org.orgId, userId, order.id, {
        fulfillmentDate: org.date, idempotencyKey: "backorder-ship-four", lines: [{ sourceLineId: lineId, quantity: "4" }],
      }));
      await conserved(["4", "0", "6"]);

      await assert.rejects(cancel(org.orgId, { quantity: "7", reason: "customer reduced the order" }), (error) => {
        assert.equal(error.code, "exceeds_open_quantity");
        assert.match(error.message, /line 1 has 6 open; cannot cancel 7/);
        return true;
      });
      await assert.rejects(cancel(org.orgId, { quantity: "1", reason: "   " }), { code: "reason_required" });

      const result = await cancel(org.orgId, { quantity: "2", reason: "customer reduced the order" });
      assert.equal(toUnits(result.open), toUnits("4"));
      await conserved(["4", "2", "4"]);
      const evidence = (await withOrg(org.orgId, () => db.execute(sql\`
        select (select count(*)::int from order_line_cancellations
                 where org_id = \${org.orgId} and line_id = \${lineId} and reason = 'customer reduced the order') as rows,
               (select count(*)::int from audit_log
                 where org_id = \${org.orgId} and row_id = \${lineId}
                   and changes->>'mode' = 'order_line_remainder_cancelled') as audits
      \`))).rows[0];
      assert.deepEqual(evidence, { rows: 1, audits: 1 });
      await assert.rejects(withOrg(org.orgId, () => db.execute(sql\`
        update order_line_cancellations set reason = 'rewritten' where org_id = \${org.orgId}\`)),
        (error) => /append-only/.test(error.cause?.message ?? error.message));

      await withOrg(org.orgId, () => requestDocumentVoid({
        documentId: shipment.id, orgId: org.orgId, actorId: userId,
        reason: "shipment returned to stock", reversalDate: org.date,
      }));
      await conserved(["0", "2", "8"]);
      const position = await withOrg(org.orgId, () => backorderPosition(db, org.orgId, { documentId: order.id, allowedSubsidiaryIds: null }));
      assert.deepEqual(position.map((row) => [row.lineId, toUnits(row.open)]), [[lineId, toUnits("8")]]);

      // Another organization and an out-of-scope caller see nothing and cancel nothing.
      assert.deepEqual(await withOrg(other.orgId, () => backorderPosition(db, other.orgId, { documentId: order.id, allowedSubsidiaryIds: null })), []);
      await assert.rejects(cancel(other.orgId, { quantity: "1", reason: "not theirs" }), { code: "order_line_not_found", status: 404 });
      assert.deepEqual(await withOrg(org.orgId, () => backorderPosition(db, org.orgId, { documentId: order.id, allowedSubsidiaryIds: new Set() })), []);
      await assert.rejects(cancel(org.orgId, { quantity: "1", reason: "out of scope", allowedSubsidiaryIds: new Set() }), { code: "order_line_not_found" });
      await conserved(["0", "2", "8"]);
      console.log("BACKORDER-CONSERVATION");
    } finally {
      await dropScratchOrg(other.orgId);
      await dropScratchOrg(org.orgId);
    }
  `;

  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--import", "./engine/src/testing/database-bypass.ts", "--input-type=module", "-e", source],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /BACKORDER-CONSERVATION/);
});
