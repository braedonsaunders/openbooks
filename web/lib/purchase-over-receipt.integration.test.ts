import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * Over-receipt tolerance: a Setup policy (percent and/or absolute quantity,
 * org-wide or per item category, effective-dated, default zero) lets a goods
 * receipt exceed a purchase-order line's remaining quantity within tolerance.
 * The excess is recorded on the receipt line, the order line's received
 * quantity lands above ordered, and anything past the allowance refuses with
 * the exact remaining-quantity message. The policy resolves effective on the
 * receipt date — never "current".
 */
test("goods receipts honor the effective over-receipt tolerance", { skip: !DB }, () => {
  const source = `
    import assert from "node:assert/strict";
    import { randomUUID } from "node:crypto";
    import { sql } from "drizzle-orm";
    import { db, withOrg } from "./engine/src/platform/db.ts";
    import { installTrustedTestDatabaseBypass } from "./engine/src/testing/database-bypass.ts";
    import { toUnits } from "./engine/src/money/money.ts";
    import { createOrderDraft, receivePurchaseOrder } from "./web/lib/order-cycle.ts";
    import { createScratchOrg, createScratchUser, dropScratchOrg } from "./engine/src/testing/fixtures.ts";

    installTrustedTestDatabaseBypass();

    const org = await createScratchOrg();
    try {
      const userId = await createScratchUser(org.orgId, "Receiving Clerk", "admin");
      await db.execute(sql\`update items set category = 'Consumables' where id = \${org.items.fifo} and org_id = \${org.orgId}\`);
      await db.execute(sql\`update items set category = 'Bulk' where id = \${org.items.movingAvg} and org_id = \${org.orgId}\`);

      const seedOrder = async (itemId, quantity) => {
        const order = await withOrg(org.orgId, () => createOrderDraft(org.orgId, userId, "purchase_order", randomUUID(), null));
        const sourceLineId = randomUUID();
        await db.execute(sql\`
          insert into document_lines
            (id, org_id, document_id, line_number, item_id, account_id, description, quantity, unit,
             unit_price, amount, tax_amount, quantity_fulfilled, quantity_billed, stock_location_id, custom)
          values
            (\${sourceLineId}, \${org.orgId}, \${order.id}, 1, \${itemId}, \${org.accounts.invAsset},
             'Widget', \${quantity}, 'ea', '2', '20', '0', '0', '0', \${org.stockLocationId}, '{}'::jsonb)
        \`);
        await db.execute(sql\`
          update documents
             set status = 'approved', party_id = \${org.vendorId}, subsidiary_id = \${org.subsidiaryId},
                 document_date = \${org.date}, subtotal = '20', total = '20'
           where id = \${order.id} and org_id = \${org.orgId}
        \`);
        return { orderId: order.id, sourceLineId };
      };
      const addTolerance = async (category, percent, quantity, from, to) => {
        await db.execute(sql\`
          insert into purchase_over_receipt_tolerances
            (org_id, item_category, tolerance_percent, tolerance_quantity, reason, effective_from, effective_to, created_by, updated_by)
          values (\${org.orgId}, \${category}, \${percent}, \${quantity}, 'over-receipt tolerance test', \${from}, \${to}, \${userId}, \${userId})
        \`);
      };
      const receive = (orderId, sourceLineId, quantity, key) => withOrg(org.orgId, () => receivePurchaseOrder(org.orgId, userId, orderId, {
        receiptDate: org.date, idempotencyKey: key, lines: [{ sourceLineId, quantity }],
      }));
      const fulfilled = async (sourceLineId) => (await db.execute(sql\`
        select quantity_fulfilled::text as fulfilled,
               quantity::text as ordered from document_lines where id = \${sourceLineId}
      \`)).rows[0];

      // ---- No policy: exact enforcement with the unchanged message --------
      {
        const { orderId, sourceLineId } = await seedOrder(org.items.fifo, "10");
        await assert.rejects(
          receive(orderId, sourceLineId, "11", "no-policy"),
          /has only 10(\\.0+)? remaining to receive/,
        );
      }

      // ---- Org-wide 10%: eleven lands, the excess is recorded -------------
      await addTolerance(null, "10", "0", org.date, null);
      {
        const { orderId, sourceLineId } = await seedOrder(org.items.fifo, "10");
        const receipt = await receive(orderId, sourceLineId, "11", "org-wide-ten-percent");
        const facts = await fulfilled(sourceLineId);
        assert.equal(toUnits(facts.fulfilled), toUnits("11"), "the received quantity lands above ordered");
        assert.equal(toUnits(facts.ordered), toUnits("10"));
        const line = (await db.execute(sql\`
          select custom from document_lines where org_id = \${org.orgId} and document_id = \${receipt.id}
        \`)).rows[0];
        assert.equal(toUnits(line.custom.overReceipt.excess), toUnits("1"), "the excess is recorded on the receipt line");
        assert.equal(line.custom.overReceipt.tolerancePercent, "10.0000");
        const moved = (await db.execute(sql\`
          select coalesce(sum(quantity), 0)::text as moved from inventory_movements
           where org_id = \${org.orgId} and item_id = \${org.items.fifo} and status = 'posted'
        \`)).rows[0].moved;
        assert.equal(toUnits(moved), toUnits("11"), "stock moves for the full received quantity");
      }

      // ---- Past the allowance: the exact refusal stands --------------------
      {
        const { orderId, sourceLineId } = await seedOrder(org.items.fifo, "10");
        await assert.rejects(
          receive(orderId, sourceLineId, "12", "past-allowance"),
          /has only 10(\\.0+)? remaining to receive/,
        );
      }

      // ---- Absolute quantity tolerance: 3 units over on a Bulk item --------
      await addTolerance("Bulk", "0", "3", org.date, null);
      {
        const { orderId, sourceLineId } = await seedOrder(org.items.movingAvg, "10");
        const receipt = await receive(orderId, sourceLineId, "12", "absolute-quantity");
        assert.equal(toUnits((await fulfilled(sourceLineId)).fulfilled), toUnits("12"));
        const line = (await db.execute(sql\`
          select custom from document_lines where org_id = \${org.orgId} and document_id = \${receipt.id}
        \`)).rows[0];
        assert.equal(toUnits(line.custom.overReceipt.excess), toUnits("2"));
        assert.equal(line.custom.overReceipt.toleranceQuantity, "3.00000000");
      }

      // ---- Category row wins over org-wide for its exact category ----------
      await addTolerance("Consumables", "50", "0", org.date, null);
      {
        const { orderId, sourceLineId } = await seedOrder(org.items.fifo, "10");
        await receive(orderId, sourceLineId, "14", "category-wins");
        assert.equal(toUnits((await fulfilled(sourceLineId)).fulfilled), toUnits("14"));
      }

      // ---- Another category falls back to org-wide and refuses -------------
      {
        await db.execute(sql\`update items set category = 'Grain' where id = \${org.items.fifo} and org_id = \${org.orgId}\`);
        const { orderId, sourceLineId } = await seedOrder(org.items.fifo, "10");
        await assert.rejects(
          receive(orderId, sourceLineId, "12", "category-fallback"),
          /has only 10(\\.0+)? remaining to receive/,
        );
      }

      // ---- A policy effective tomorrow does not govern today's receipt -----
      {
        const tomorrow = new Date(org.date + "T00:00:00Z");
        tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
        const next = tomorrow.toISOString().slice(0, 10);
        await addTolerance("Grain", "50", "0", next, null);
        const { orderId, sourceLineId } = await seedOrder(org.items.fifo, "10");
        await assert.rejects(
          receive(orderId, sourceLineId, "12", "not-yet-effective"),
          /has only 10(\\.0+)? remaining to receive/,
        );
      }
      console.log("OVER-RECEIPT-TOLERANCE-COVERAGE");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  `;

  const result = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "--import",
      "./engine/src/testing/database-bypass.ts",
      "--input-type=module",
      "-e",
      source,
    ],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /OVER-RECEIPT-TOLERANCE-COVERAGE/);
});
