import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/platform/db.ts";
import { requestDocumentVoid } from "@openbooks/engine/src/ledger/document-void.ts";
import { postDocument } from "@openbooks/engine/src/ledger/posting-document.ts";
import { DropShipRefusal } from "@openbooks/engine/src/sales/drop-ship.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "@openbooks/engine/src/testing/fixtures.ts";
import type { ApplicationContext } from "./application/context";
import { confirmDropShip, createDropShipPurchaseOrder, routeSalesOrderLine } from "./drop-ship.ts";
import { convertOrder, createOrderDraft } from "./order-cycle.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

test("drop-ship confirmation posts cost once, covers the vendor bill, invoices, replays and voids as a pair", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Drop Ship Clerk", "admin"));
    const context = {
      authz: {
        user: { id: actorId, orgId: org.orgId, roles: [] },
        permissions: new Set(["orders.fulfill", "ap.create", "items.post", "ar.create"]),
        allowedSubsidiaryIds: null,
      },
      source: "api",
      requestId: randomUUID(),
      apiKeyId: null,
    } as unknown as ApplicationContext;
    await withBypassContext(async () => {
      await db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{features}',
          coalesce(settings->'features', '{}'::jsonb) || '{"orders":true,"inventory":true,"dropShipping":true}'::jsonb)
         where id = ${org.orgId}`);
      await db.execute(sql`update items set default_cost = '20' where org_id = ${org.orgId} and id = ${org.items.fifo}`);
      await db.execute(sql`insert into vendor_roles (org_id, party_id, is_active) values (${org.orgId}, ${org.vendorId}, true)`);
      await db.execute(sql`
        insert into addresses (id, org_id, party_id, label, line1, city, region, postal_code, country, is_default_shipping)
        values (${randomUUID()}, ${org.orgId}, ${org.customerId}, 'Receiving', '10 Main St', 'Toronto', 'ON', 'M5V 1A1', 'CA', true)`);
    });
    const order = await withBypassContext(() => createOrderDraft(org.orgId, actorId, "sales_order", randomUUID(), org.subsidiaryId));
    const salesLineId = randomUUID();
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, item_id, account_id, description, quantity,
           unit, unit_price, amount, tax_amount, quantity_fulfilled, quantity_billed, stock_location_id)
        values (${salesLineId}, ${org.orgId}, ${order.id}, 1, ${org.items.fifo}, ${org.accounts.revenue},
          'Drop-shipped widget', '3', 'ea', '50', '150', '0', '0', '0', ${org.stockLocationId})`);
      const approved = await db.execute<{ id: string }>(sql`
        update documents set status = 'approved', party_id = ${org.customerId}, document_date = ${org.date},
          subtotal = '150', total = '150'
         where id = ${order.id} and org_id = ${org.orgId} and status = 'draft' returning id`);
      assert.equal(approved.rows.length, 1);
    });
    await withBypassContext(() => routeSalesOrderLine(context, { salesOrderId: order.id, salesOrderLineId: salesLineId, routed: true }));
    const po = await withBypassContext(() => createDropShipPurchaseOrder(context, {
      salesOrderId: order.id, vendorId: org.vendorId, idempotencyKey: randomUUID(),
    }));
    await withBypassContext(() => db.execute(sql`
      update documents set status = 'approved'
       where org_id = ${org.orgId} and id = ${po.id} and kind = 'purchase_order' and status = 'draft'`));
    const poLines = await withBypassContext(() => db.execute<{ id: string; amount: string }>(sql`
      select id, amount::text as amount from document_lines where org_id = ${org.orgId} and document_id = ${po.id}`));
    assert.equal(poLines.rows.length, 1);
    assert.equal(poLines.rows[0]!.amount, "60.0000");
    const confirmation = { purchaseOrderId: po.id, confirmationDate: org.date, idempotencyKey: randomUUID(),
      lines: [{ purchaseOrderLineId: poLines.rows[0]!.id, quantity: "3" }] };

    await withBypassContext(() => db.execute(sql`
      update item_inventory_profiles set received_not_billed_account_id = null
       where org_id = ${org.orgId} and item_id = ${org.items.fifo}`));
    await assert.rejects(withBypassContext(() => confirmDropShip(context, confirmation)), (error: unknown) =>
      error instanceof DropShipRefusal && error.code === "received_not_billed_account_required"
        && /FIFO Widget/.test(error.message) && /received-not-billed/.test(error.message) && /Costing profile/.test(error.remedy ?? ""));
    await withBypassContext(() => db.execute(sql`
      update item_inventory_profiles set received_not_billed_account_id = ${org.accounts.clearing}
       where org_id = ${org.orgId} and item_id = ${org.items.fifo}`));

    const first = await withBypassContext(() => confirmDropShip(context, confirmation));
    const replay = await withBypassContext(() => confirmDropShip(context, confirmation));
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.purchaseReceipt, first.purchaseReceipt);
    assert.deepEqual(replay.salesFulfillment, first.salesFulfillment);
    const facts = await withBypassContext(() => db.execute<{
      po_received: string; so_fulfilled: string; receipt_status: string; fulfillment_status: string;
      movement_count: number; cost: string; clearing: string; entry_count: number;
    }>(sql`
      select pol.quantity_fulfilled::text as po_received, sol.quantity_fulfilled::text as so_fulfilled,
        receipt.status as receipt_status, fulfillment.status as fulfillment_status,
        (select count(*)::int from inventory_movements m join document_lines l
          on l.org_id = m.org_id and l.id = m.document_line_id
          where m.org_id = ${org.orgId} and l.document_id = receipt.id) as movement_count,
        (select coalesce(sum(jl.amount), 0)::text from journal_entries je join journal_lines jl
          on jl.org_id = je.org_id and jl.entry_id = je.id
          where je.org_id = ${org.orgId} and je.book_id = ${org.bookId}
            and je.custom->'dropShipConfirmation'->>'receiptId' = receipt.id::text
            and jl.account_id = ${org.accounts.cogs}) as cost,
        (select coalesce(sum(jl.amount), 0)::text from journal_entries je join journal_lines jl
          on jl.org_id = je.org_id and jl.entry_id = je.id
          where je.org_id = ${org.orgId} and je.book_id = ${org.bookId}
            and je.custom->'dropShipConfirmation'->>'receiptId' = receipt.id::text
            and jl.account_id = ${org.accounts.clearing}) as clearing,
        (select count(*)::int from journal_entries je where je.org_id = ${org.orgId}
          and je.book_id = ${org.bookId}
          and je.custom->'dropShipConfirmation'->>'receiptId' = receipt.id::text) as entry_count
       from document_lines pol join drop_ship_lines routed
         on routed.org_id = pol.org_id and routed.purchase_order_line_id = pol.id
       join document_lines sol on sol.org_id = routed.org_id and sol.id = routed.sales_order_line_id
       join documents receipt on receipt.org_id = pol.org_id and receipt.id = ${first.purchaseReceipt.id}
       join documents fulfillment on fulfillment.org_id = pol.org_id and fulfillment.id = ${first.salesFulfillment.id}
       where pol.org_id = ${org.orgId} and pol.id = ${poLines.rows[0]!.id}`));
    assert.equal(facts.rows[0]!.po_received, "3.00000000");
    assert.equal(facts.rows[0]!.so_fulfilled, "3.00000000");
    assert.equal(facts.rows[0]!.receipt_status, "approved");
    assert.equal(facts.rows[0]!.fulfillment_status, "approved");
    assert.equal(facts.rows[0]!.movement_count, 0);
    assert.equal(facts.rows[0]!.cost, "60.0000");
    assert.equal(facts.rows[0]!.clearing, "-60.0000");
    assert.equal(facts.rows[0]!.entry_count, 1);

    const bill = await withBypassContext(() => convertOrder(org.orgId, actorId, po.id, "vendor_bill"));
    await withBypassContext(async () => {
      await db.execute(sql`update document_lines set unit_price = '25', amount = '75' where org_id = ${org.orgId} and document_id = ${bill.id}`);
      await db.execute(sql`update documents set subtotal = '75', total = '75', document_date = ${org.date}, status = 'approved' where org_id = ${org.orgId} and id = ${bill.id}`);
      await postDocument(bill.id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
    });
    const clearingAfterBill = await withBypassContext(() => db.execute<{ balance: string; ppv: string }>(sql`
      select
        (select coalesce(sum(l.amount), 0)::text from journal_lines l join journal_entries e on e.id = l.entry_id
          where l.org_id = ${org.orgId} and e.org_id = l.org_id and e.book_id = ${org.bookId}
            and e.status in ('posted', 'reversed') and l.account_id = ${org.accounts.clearing}) as balance,
        (select coalesce(sum(l.amount), 0)::text from journal_lines l join journal_entries e on e.id = l.entry_id
          where l.org_id = ${org.orgId} and e.org_id = l.org_id and e.book_id = ${org.bookId}
            and e.status in ('posted', 'reversed') and l.account_id = ${org.accounts.adjustment}) as ppv`));
    assert.equal(clearingAfterBill.rows[0]!.balance, "0.0000");
    assert.equal(clearingAfterBill.rows[0]!.ppv, "15.0000");

    const invoice = await withBypassContext(() => convertOrder(org.orgId, actorId, order.id, "customer_invoice"));
    const invoiceLine = await withBypassContext(() => db.execute<{ quantity: string }>(sql`
      select quantity::text as quantity from document_lines where org_id = ${org.orgId} and document_id = ${invoice.id}`));
    assert.equal(invoiceLine.rows[0]!.quantity, "3.00000000");
    await withBypassContext(async () => {
      await db.execute(sql`update documents set document_date = ${org.date}, status = 'approved' where org_id = ${org.orgId} and id = ${invoice.id}`);
      await postDocument(invoice.id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
    });
    await requestDocumentVoid({ documentId: invoice.id, orgId: org.orgId, actorId, reason: "Correct the customer invoice", reversalDate: org.date, source: "api" });
    await requestDocumentVoid({ documentId: bill.id, orgId: org.orgId, actorId, reason: "Correct the vendor bill", reversalDate: org.date, source: "api" });
    await requestDocumentVoid({ documentId: first.salesFulfillment.id, orgId: org.orgId, actorId, reason: "Reverse the vendor confirmation", reversalDate: org.date, source: "api" });
    const voidFacts = await withBypassContext(() => db.execute<{ receipt_status: string; fulfillment_status: string; confirmation_entries: number; reversed: number; cogs_net: string; clearing_net: string; so_fulfilled: string; po_received: string }>(sql`
      select receipt.status as receipt_status, fulfillment.status as fulfillment_status,
        (select count(*)::int from journal_entries original where original.org_id = ${org.orgId}
          and original.book_id = ${org.bookId}
          and original.custom->'dropShipConfirmation'->>'receiptId' = receipt.id::text
          and original.status in ('posted', 'reversed')) as confirmation_entries,
        (select count(*)::int from journal_entries reversal where reversal.org_id = ${org.orgId}
          and reversal.book_id = ${org.bookId} and reversal.status in ('posted', 'reversed')
          and reversal.reverses_entry_id in (select original.id from journal_entries original
            where original.org_id = ${org.orgId} and original.book_id = ${org.bookId}
              and original.status in ('posted', 'reversed')
              and original.custom->'dropShipConfirmation'->>'receiptId' = receipt.id::text)) as reversed,
        (select coalesce(sum(line.amount), 0)::text from journal_entries entry
          join journal_lines line on line.org_id = entry.org_id and line.entry_id = entry.id
          where entry.org_id = ${org.orgId} and entry.book_id = ${org.bookId}
            and entry.status in ('posted', 'reversed') and line.account_id = ${org.accounts.cogs}
            and (entry.custom->'dropShipConfirmation'->>'receiptId' = receipt.id::text
              or entry.reverses_entry_id in (select original.id from journal_entries original
                where original.org_id = ${org.orgId} and original.book_id = ${org.bookId}
                  and original.status in ('posted', 'reversed')
                  and original.custom->'dropShipConfirmation'->>'receiptId' = receipt.id::text))) as cogs_net,
        (select coalesce(sum(line.amount), 0)::text from journal_entries entry
          join journal_lines line on line.org_id = entry.org_id and line.entry_id = entry.id
          where entry.org_id = ${org.orgId} and entry.book_id = ${org.bookId}
            and entry.status in ('posted', 'reversed') and line.account_id = ${org.accounts.clearing}
            and (entry.custom->'dropShipConfirmation'->>'receiptId' = receipt.id::text
              or entry.reverses_entry_id in (select original.id from journal_entries original
                where original.org_id = ${org.orgId} and original.book_id = ${org.bookId}
                  and original.status in ('posted', 'reversed')
                  and original.custom->'dropShipConfirmation'->>'receiptId' = receipt.id::text))) as clearing_net,
        sol.quantity_fulfilled::text as so_fulfilled, pol.quantity_fulfilled::text as po_received
       from documents receipt join documents fulfillment on fulfillment.org_id = receipt.org_id
        and fulfillment.custom->'dropShipConfirmation'->>'purchaseReceiptId' = receipt.id::text
       join drop_ship_orders ds on ds.org_id = receipt.org_id
        and ds.purchase_order_id = (select from_document_id from document_links
          where org_id = receipt.org_id and to_document_id = receipt.id and link_type = 'fulfills' limit 1)
       join drop_ship_lines routed on routed.org_id = ds.org_id
       join document_lines sol on sol.org_id = routed.org_id and sol.id = routed.sales_order_line_id
       join document_lines pol on pol.org_id = routed.org_id and pol.id = routed.purchase_order_line_id
       where receipt.org_id = ${org.orgId} and receipt.id = ${first.purchaseReceipt.id} limit 1`));
    assert.equal(voidFacts.rows[0]!.receipt_status, "voided");
    assert.equal(voidFacts.rows[0]!.fulfillment_status, "voided");
    assert.equal(voidFacts.rows[0]!.confirmation_entries, 1);
    assert.equal(voidFacts.rows[0]!.reversed, 1);
    assert.equal(voidFacts.rows[0]!.cogs_net, "0.0000");
    assert.equal(voidFacts.rows[0]!.clearing_net, "0.0000");
    assert.equal(voidFacts.rows[0]!.so_fulfilled, "0.00000000");
    assert.equal(voidFacts.rows[0]!.po_received, "0.00000000");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
