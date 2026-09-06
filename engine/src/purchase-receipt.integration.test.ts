import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * Goods receipts close the procure-to-pay gap for stock: before this document
 * existed nothing advanced a purchase-order line's received quantity, so the
 * receipt-governed vendor bill and AP capture refused every stock line
 * forever. The receipt brings stock in at the order price against
 * received-not-billed; the bill clears that account instead of receiving the
 * stock a second time, and any invoice/order price difference lands in PPV.
 * Runs in a child with React's server condition like the sales counterpart.
 */
test("goods receipts bring stock in once, govern billing, and clear received-not-billed", { skip: !DB }, () => {
  const source = `
    import assert from "node:assert/strict";
    import { randomUUID } from "node:crypto";
    import { sql } from "drizzle-orm";
    import { db, withOrg } from "./engine/src/db.ts";
    import { installTrustedTestDatabaseBypass } from "./engine/src/test-database-bypass.ts";
    import { postDocument } from "./engine/src/posting.ts";
    import { toUnits } from "./engine/src/money.ts";
    import { convertOrder, createOrderDraft, receivePurchaseOrder } from "./web/lib/order-cycle.ts";
    import { createScratchOrg, createScratchUser, dropScratchOrg } from "./engine/src/test-fixtures.ts";

    installTrustedTestDatabaseBypass();

    const org = await createScratchOrg();
    try {
      const userId = await createScratchUser(org.orgId, "Receiving Clerk", "admin");
      const order = await withOrg(org.orgId, () => createOrderDraft(org.orgId, userId, "purchase_order"));
      const sourceLineId = randomUUID();
      await db.execute(sql\`
        insert into document_lines
          (id, org_id, document_id, line_number, item_id, account_id, description, quantity, unit,
           unit_price, amount, tax_amount, quantity_fulfilled, quantity_billed, stock_location_id, custom)
        values
          (\${sourceLineId}, \${org.orgId}, \${order.id}, 1, \${org.items.fifo}, \${org.accounts.invAsset},
           'Widget', '10', 'ea', '2', '20', '0', '0', '0', \${org.stockLocationId}, '{}'::jsonb)
      \`);
      await db.execute(sql\`
        update documents
           set status = 'approved', party_id = \${org.vendorId}, subsidiary_id = \${org.subsidiaryId},
               document_date = \${org.date}, subtotal = '20', total = '20'
         where id = \${order.id} and org_id = \${org.orgId}
      \`);

      const clearingBalance = async () => (await db.execute(sql\`
        select coalesce(sum(l.amount), 0)::text as amount from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
         where l.org_id = \${org.orgId} and l.account_id = \${org.accounts.clearing} and e.status = 'posted'
      \`)).rows[0].amount;
      const accountBalance = async (accountId) => (await db.execute(sql\`
        select coalesce(sum(l.amount), 0)::text as amount from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
         where l.org_id = \${org.orgId} and l.account_id = \${accountId} and e.status = 'posted'
      \`)).rows[0].amount;
      const onHand = async () => (await db.execute(sql\`
        select coalesce(sum(quantity), 0)::text as quantity from inventory_movements
         where org_id = \${org.orgId} and item_id = \${org.items.fifo} and status = 'posted'
      \`)).rows[0].quantity;

      // ---- Partial receipt, exactly once -----------------------------------
      const command = { receiptDate: org.date, idempotencyKey: "receipt-partial-four", lines: [{ sourceLineId, quantity: "4" }] };
      const first = await withOrg(org.orgId, () => receivePurchaseOrder(org.orgId, userId, order.id, command));
      const replay = await withOrg(org.orgId, () => receivePurchaseOrder(org.orgId, userId, order.id, command));
      assert.equal(replay.id, first.id, "a retry must replay the stored receipt");
      assert.equal(replay.replayed, true);
      await assert.rejects(
        withOrg(org.orgId, () => receivePurchaseOrder(org.orgId, userId, order.id, { ...command, lines: [{ sourceLineId, quantity: "3" }] })),
        /already used with a different receipt/,
      );
      const facts = (await db.execute(sql\`
        select r.kind, r.status, r.subsidiary_id, r.document_number,
               (select quantity_fulfilled::text from document_lines where id = \${sourceLineId}) as received,
               (select count(*)::int from document_links where org_id = \${org.orgId}
                 and from_document_id = \${order.id} and to_document_id = r.id and link_type = 'fulfills') as edges,
               (select coalesce(sum(m.quantity), 0)::text from inventory_movements m
                 join document_lines rl on rl.id = m.document_line_id and rl.org_id = m.org_id
                where m.org_id = \${org.orgId} and rl.document_id = r.id and m.kind = 'receipt') as moved,
               (select min(m.unit_cost)::text from inventory_movements m
                 join document_lines rl on rl.id = m.document_line_id and rl.org_id = m.org_id
                where m.org_id = \${org.orgId} and rl.document_id = r.id and m.kind = 'receipt') as unit_cost
          from documents r where r.id = \${first.id} and r.org_id = \${org.orgId}
      \`)).rows[0];
      assert.equal(facts.kind, "purchase_receipt");
      assert.equal(facts.status, "approved");
      assert.equal(facts.subsidiary_id, org.subsidiaryId);
      assert.match(facts.document_number, /^RCPT-/);
      assert.equal(toUnits(facts.received), toUnits("4"));
      assert.equal(facts.edges, 1);
      assert.equal(toUnits(facts.moved), toUnits("4"));
      assert.equal(toUnits(facts.unit_cost), toUnits("2"), "received at the order price");
      assert.equal(toUnits(await onHand()), toUnits("4"));
      assert.equal(toUnits(await accountBalance(org.accounts.invAsset)), toUnits("8"));
      assert.equal(toUnits(await clearingBalance()), toUnits("-8"), "DR inventory / CR received-not-billed");

      // ---- Over-receipt is refused against the committed ceiling -----------
      await assert.rejects(
        withOrg(org.orgId, () => receivePurchaseOrder(org.orgId, userId, order.id, {
          receiptDate: org.date, idempotencyKey: "receipt-too-many", lines: [{ sourceLineId, quantity: "7" }],
        })),
        /has only 6(\.0+)? remaining to receive/,
      );

      // ---- The bill is governed by the received quantity and clears GRNI ---
      const bill = await withOrg(org.orgId, () => convertOrder(org.orgId, userId, order.id, "vendor_bill"));
      const billLine = (await db.execute(sql\`
        select id, quantity::text as quantity, amount::text as amount, custom
          from document_lines where org_id = \${org.orgId} and document_id = \${bill.id}
      \`)).rows[0];
      assert.equal(toUnits(billLine.quantity), toUnits("4"), "only received stock can be billed");
      assert.equal(billLine.custom.purchaseOrderLineId, sourceLineId, "the bill line keeps its order-line provenance");
      await db.execute(sql\`update documents set status = 'approved' where id = \${bill.id} and org_id = \${org.orgId}\`);
      await postDocument(bill.id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
      const billReceipts = (await db.execute(sql\`
        select count(*)::int as count from inventory_movements
         where org_id = \${org.orgId} and document_line_id = \${billLine.id} and kind = 'receipt'
      \`)).rows[0].count;
      assert.equal(billReceipts, 0, "billing received stock must not receive it again");
      assert.equal(toUnits(await onHand()), toUnits("4"));
      assert.equal(toUnits(await clearingBalance()), toUnits("0"), "the bill clears received-not-billed for the billed quantity");
      assert.equal(toUnits(await accountBalance(org.accounts.ap)), toUnits("-8"));

      // ---- Remainder through the conversion surface, then a priced-up bill --
      // The conversion surface receives on the business date; give the scratch
      // org an open period for the current month (the fixture seeds July only).
      const today = new Date().toISOString().slice(0, 10);
      const monthStart = today.slice(0, 8) + "01";
      const monthEnd = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10);
      if (!(monthStart <= org.date && org.date <= monthEnd)) {
        await db.execute(sql\`
          insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
          select \${randomUUID()}, org_id, \${Number(today.slice(0, 4))}, \${Number(today.slice(5, 7))}, \${today.slice(0, 7)},
                 \${monthStart}, \${monthEnd}, false, fiscal_calendar_id
            from accounting_periods where id = \${org.periodId}
        \`);
      }
      const remainder = await withOrg(org.orgId, () => convertOrder(org.orgId, userId, order.id, "purchase_receipt"));
      assert.equal(remainder.kind, "purchase_receipt");
      const again = await withOrg(org.orgId, () => convertOrder(org.orgId, userId, order.id, "purchase_receipt"));
      assert.equal(again.id, remainder.id, "nothing left to receive replays the latest receipt");
      assert.equal(again.replayed, true);
      assert.equal(toUnits(await onHand()), toUnits("10"));
      assert.equal(toUnits(await clearingBalance()), toUnits("-12"));

      const secondBill = await withOrg(org.orgId, () => convertOrder(org.orgId, userId, order.id, "vendor_bill"));
      const secondLine = (await db.execute(sql\`
        select id, quantity::text as quantity from document_lines
         where org_id = \${org.orgId} and document_id = \${secondBill.id}
      \`)).rows[0];
      assert.equal(toUnits(secondLine.quantity), toUnits("6"));
      // The supplier invoices 2.50 a unit against an order at 2.00: the
      // difference is purchase price variance, never a second stock receipt.
      await db.execute(sql\`
        update document_lines set unit_price = '2.5', amount = '15' where id = \${secondLine.id} and org_id = \${org.orgId}
      \`);
      await db.execute(sql\`
        update documents set subtotal = '15', total = '15', status = 'approved'
         where id = \${secondBill.id} and org_id = \${org.orgId}
      \`);
      await postDocument(secondBill.id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
      assert.equal(toUnits(await onHand()), toUnits("10"), "the priced-up bill receives nothing");
      assert.equal(toUnits(await clearingBalance()), toUnits("0"), "received-not-billed nets to zero after PPV");
      assert.equal(toUnits(await accountBalance(org.accounts.adjustment)), toUnits("3"), "6 × (2.50 − 2.00) purchase price variance");
      assert.equal(toUnits(await accountBalance(org.accounts.invAsset)), toUnits("20"), "inventory stays at the receipt cost");
      assert.equal(toUnits(await accountBalance(org.accounts.ap)), toUnits("-23"));

      // ---- Replaying the posting effect drain never books PPV twice --------
      const { applyInventoryReceiptsForBill } = await import("./engine/src/inventory.ts");
      const entry = (await db.execute(sql\`
        select posted_entry_id as id from documents
         where id = \${secondBill.id} and org_id = \${org.orgId}
      \`)).rows[0];
      await applyInventoryReceiptsForBill(org.orgId, userId, secondBill.id, entry.id, org.date, org.subsidiaryId);
      assert.equal(toUnits(await accountBalance(org.accounts.adjustment)), toUnits("3"));

      await assert.rejects(
        withOrg(org.orgId, () => convertOrder(org.orgId, userId, order.id, "vendor_bill")),
        /already fully converted|do not cover/,
      );

      // ---- An item with no received-not-billed account cannot be received --
      await db.execute(sql\`
        update item_inventory_profiles set received_not_billed_account_id = null
         where org_id = \${org.orgId} and item_id = \${org.items.movingAvg}
      \`);
      const bare = await withOrg(org.orgId, () => createOrderDraft(org.orgId, userId, "purchase_order"));
      const bareLineId = randomUUID();
      await db.execute(sql\`
        insert into document_lines
          (id, org_id, document_id, line_number, item_id, account_id, description, quantity, unit,
           unit_price, amount, tax_amount, stock_location_id, custom)
        values
          (\${bareLineId}, \${org.orgId}, \${bare.id}, 1, \${org.items.movingAvg}, \${org.accounts.invAsset},
           'Gadget', '1', 'ea', '5', '5', '0', \${org.stockLocationId}, '{}'::jsonb)
      \`);
      await db.execute(sql\`
        update documents set status = 'approved', party_id = \${org.vendorId}, subsidiary_id = \${org.subsidiaryId},
               document_date = \${org.date}, subtotal = '5', total = '5'
         where id = \${bare.id} and org_id = \${org.orgId}
      \`);
      await assert.rejects(
        withOrg(org.orgId, () => convertOrder(org.orgId, userId, bare.id, "purchase_receipt")),
        /no received-not-billed account/,
      );
      const untouched = (await db.execute(sql\`
        select quantity_fulfilled::text as received from document_lines where id = \${bareLineId}
      \`)).rows[0];
      assert.equal(toUnits(untouched.received), toUnits("0"), "a refused receipt leaves the order untouched");

      console.log("PURCHASE-RECEIPT-EXACTLY-ONCE");
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
      "./engine/src/test-database-bypass.ts",
      "--input-type=module",
      "-e",
      source,
    ],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PURCHASE-RECEIPT-EXACTLY-ONCE/);
});
