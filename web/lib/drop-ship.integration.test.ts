import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/platform/db";
import { requestDocumentVoid } from "@openbooks/engine/ledger/document-void";
import { postDocument } from "@openbooks/engine/ledger/posting-document";
import { DropShipRefusal } from "@openbooks/engine/sales/drop-ship";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "@openbooks/engine/testing/fixtures";
import type { ApplicationContext } from "./application/context";
import { confirmDropShip, createDropShipPurchaseOrder, routeSalesOrderLine } from "./drop-ship.ts";
import { convertOrder, createOrderDraft } from "./order-cycle.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

test(
  "drop-ship confirmation posts cost once, covers the vendor bill, invoices, replays and voids as a pair",
  { skip: !DB },
  async () => {
    // bypass: cross-org-by-design — createScratchOrg initializes an organization before its tenant context exists.
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actorId = await withOrgContext(org.orgId, () =>
        createScratchUser(org.orgId, "Drop Ship Clerk", "admin"),
      );
      const context = {
        authz: {
          user: { id: actorId, orgId: org.orgId, roles: [] },
          permissions: new Set([
            "orders.fulfill",
            "ap.create",
            "purchase_orders.create",
            "goods_receipts.create",
            "items.post",
            "ar.create",
          ]),
          allowedSubsidiaryIds: null,
        },
        source: "api",
        requestId: randomUUID(),
        apiKeyId: null,
      } as unknown as ApplicationContext;
      await withOrgContext(org.orgId, async () => {
        await db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{features}',
          coalesce(settings->'features', '{}'::jsonb) || '{"orders":true,"inventory":true,"dropShipping":true}'::jsonb)
         where id = ${org.orgId}`);
        await db.execute(
          sql`insert into vendor_roles (org_id, party_id, is_active) values (${org.orgId}, ${org.vendorId}, true)`,
        );
        await db.execute(sql`
        insert into addresses (id, org_id, party_id, label, line1, city, region, postal_code, country, is_default_shipping)
        values (${randomUUID()}, ${org.orgId}, ${org.customerId}, 'Receiving', '10 Main St', 'Toronto', 'ON', 'M5V 1A1', 'CA', true)`);
      });
      const order = await withOrgContext(org.orgId, () =>
        createOrderDraft(org.orgId, actorId, "sales_order", randomUUID(), org.subsidiaryId),
      );
      const salesLineId = randomUUID();
      await withOrgContext(org.orgId, async () => {
        await db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, item_id, account_id, description, quantity,
           unit, unit_price, amount, tax_amount, quantity_fulfilled, quantity_billed, stock_location_id)
        values (${salesLineId}, ${org.orgId}, ${order.id}, 1, ${org.items.fifo}, ${org.accounts.revenue},
          'Drop-shipped widget', '3', 'ea', '50', '150', '0', '0', '0', ${org.stockLocationId})`);
        const approved = await db.execute<{ id: string }>(
          sql`
        update documents set status = 'approved', party_id = ${org.customerId}, document_date = ${org.date},
          subtotal = '150', total = '150'
         where id = ${order.id} and org_id = ${org.orgId} and status = 'draft' returning id`,
          "objects",
        );
        assert.equal(approved.length, 1);
      });
      await withOrgContext(org.orgId, () =>
        routeSalesOrderLine(context, {
          salesOrderId: order.id,
          salesOrderLineId: salesLineId,
          routed: true,
        }),
      );
      const purchaseOrderKey = randomUUID();
      await withOrgContext(org.orgId, async () => {
        await db.execute(
          sql`update items set default_cost = null where org_id = ${org.orgId} and id = ${org.items.fifo}`,
        );
        await db.execute(
          sql`update item_inventory_profiles set standard_cost = null where org_id = ${org.orgId} and item_id = ${org.items.fifo}`,
        );
      });
      const purchaseOrderCount = async () =>
        (
          await withOrgContext(org.orgId, () =>
            db.execute<{ count: string }>(
              sql`
      select count(*)::text as count from documents where org_id = ${org.orgId} and kind = 'purchase_order'`,
              "objects",
            ),
          )
        )[0]!.count;
      const ordersBeforeRefusal = await purchaseOrderCount();
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          createDropShipPurchaseOrder(context, {
            salesOrderId: order.id,
            vendorId: org.vendorId,
            idempotencyKey: purchaseOrderKey,
          }),
        ),
        (error: unknown) => error instanceof DropShipRefusal && error.code === "item_cost_required",
      );
      assert.equal(
        await purchaseOrderCount(),
        ordersBeforeRefusal,
        "a refused routed line does not leave a purchase-order draft",
      );
      await withOrgContext(org.orgId, () =>
        db.execute(
          sql`update items set default_cost = '20' where org_id = ${org.orgId} and id = ${org.items.fifo}`,
        ),
      );
      const po = await withOrgContext(org.orgId, () =>
        createDropShipPurchaseOrder(context, {
          salesOrderId: order.id,
          vendorId: org.vendorId,
          idempotencyKey: purchaseOrderKey,
        }),
      );
      await withOrgContext(org.orgId, async () => {
        await db.execute(
          sql`insert into currencies (code, name, minor_units) values ('USD', 'US Dollar', 2) on conflict (code) do nothing`,
        );
        await db.execute(sql`update documents set currency = 'USD', fx_rate = '1.5'
        where org_id = ${org.orgId} and id = ${po.id} and kind = 'purchase_order' and status = 'draft'`);
        await db.execute(sql`update documents set status = 'approved'
        where org_id = ${org.orgId} and id = ${po.id} and kind = 'purchase_order' and status = 'draft'`);
      });
      const poLines = await withOrgContext(org.orgId, () =>
        db.execute<{ id: string; amount: string }>(
          sql`
      select id, amount::text as amount from document_lines where org_id = ${org.orgId} and document_id = ${po.id}`,
          "objects",
        ),
      );
      assert.equal(poLines.length, 1);
      assert.equal(poLines[0]!.amount, "60.0000");
      const confirmationLines = [{ purchaseOrderLineId: poLines[0]!.id, quantity: "3" }];

      await withOrgContext(org.orgId, () =>
        db.execute(sql`
      update item_inventory_profiles set received_not_billed_account_id = null
       where org_id = ${org.orgId} and item_id = ${org.items.fifo}`),
      );
      const unconfiguredConfirmation = {
        purchaseOrderId: po.id,
        confirmationDate: org.date,
        idempotencyKey: randomUUID(),
        lines: confirmationLines,
      };
      await assert.rejects(
        withOrgContext(org.orgId, () => confirmDropShip(context, unconfiguredConfirmation)),
        (error: unknown) =>
          error instanceof DropShipRefusal &&
          error.code === "received_not_billed_account_required" &&
          /FIFO Widget/.test(error.message) &&
          /received-not-billed/.test(error.message) &&
          /Company Settings/.test(error.remedy ?? ""),
      );
      await withOrgContext(org.orgId, () =>
        db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{controlAccounts}',
        coalesce(settings->'controlAccounts', '{}'::jsonb) || jsonb_build_object('receivedNotBilled', ${org.accounts.clearing}::text), true)
       where id = ${org.orgId}`),
      );
      const confirmation = {
        purchaseOrderId: po.id,
        confirmationDate: org.date,
        idempotencyKey: randomUUID(),
        lines: confirmationLines,
      };

      const first = await withOrgContext(org.orgId, () => confirmDropShip(context, confirmation));
      const replay = await withOrgContext(org.orgId, () => confirmDropShip(context, confirmation));
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.purchaseReceipt, first.purchaseReceipt);
      assert.deepEqual(replay.salesFulfillment, first.salesFulfillment);
      const facts = await withOrgContext(org.orgId, () =>
        db.execute<{
          po_received: string;
          so_fulfilled: string;
          receipt_status: string;
          fulfillment_status: string;
          movement_count: number;
          cost: string;
          clearing: string;
          entry_count: number;
          receipt_currency: string;
          receipt_fx_rate: string;
          receipt_subtotal: string;
          receipt_total: string;
        }>(
          sql`
      select pol.quantity_fulfilled::text as po_received, sol.quantity_fulfilled::text as so_fulfilled,
        receipt.status as receipt_status, fulfillment.status as fulfillment_status,
        receipt.currency as receipt_currency, receipt.fx_rate::text as receipt_fx_rate,
        receipt.subtotal::text as receipt_subtotal, receipt.total::text as receipt_total,
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
       where pol.org_id = ${org.orgId} and pol.id = ${poLines[0]!.id}`,
          "objects",
        ),
      );
      assert.equal(facts[0]!.po_received, "3.00000000");
      assert.equal(facts[0]!.so_fulfilled, "3.00000000");
      assert.equal(facts[0]!.receipt_status, "approved");
      assert.equal(facts[0]!.fulfillment_status, "approved");
      assert.equal(facts[0]!.movement_count, 0);
      assert.equal(facts[0]!.receipt_currency, "USD");
      assert.equal(facts[0]!.receipt_fx_rate, "1.5000000000");
      assert.equal(facts[0]!.receipt_subtotal, "60.0000");
      assert.equal(facts[0]!.receipt_total, "60.0000");
      assert.equal(facts[0]!.cost, "90.0000");
      assert.equal(facts[0]!.clearing, "-90.0000");
      assert.equal(facts[0]!.entry_count, 1);

      const bill = await withOrgContext(org.orgId, () =>
        convertOrder(org.orgId, actorId, po.id, "vendor_bill"),
      );
      await withOrgContext(org.orgId, async () => {
        await db.execute(
          sql`update document_lines set unit_price = '25', amount = '75' where org_id = ${org.orgId} and document_id = ${bill.id}`,
        );
        await db.execute(
          sql`update documents set subtotal = '75', total = '75', document_date = ${org.date}, status = 'approved' where org_id = ${org.orgId} and id = ${bill.id}`,
        );
        await postDocument(bill.id, {
          control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
        });
      });
      const clearingAfterBill = await withOrgContext(org.orgId, () =>
        db.execute<{ balance: string; ppv: string }>(
          sql`
      select
        (select coalesce(sum(l.amount), 0)::text from journal_lines l join journal_entries e on e.id = l.entry_id
          where l.org_id = ${org.orgId} and e.org_id = l.org_id and e.book_id = ${org.bookId}
            and e.status in ('posted', 'reversed') and l.account_id = ${org.accounts.clearing}) as balance,
        (select coalesce(sum(l.amount), 0)::text from journal_lines l join journal_entries e on e.id = l.entry_id
          where l.org_id = ${org.orgId} and e.org_id = l.org_id and e.book_id = ${org.bookId}
            and e.status in ('posted', 'reversed') and l.account_id = ${org.accounts.adjustment}) as ppv`,
          "objects",
        ),
      );
      assert.equal(clearingAfterBill[0]!.balance, "0.0000");
      assert.equal(clearingAfterBill[0]!.ppv, "22.5000");

      const invoice = await withOrgContext(org.orgId, () =>
        convertOrder(org.orgId, actorId, order.id, "customer_invoice"),
      );
      const invoiceLine = await withOrgContext(org.orgId, () =>
        db.execute<{ quantity: string }>(
          sql`
      select quantity::text as quantity from document_lines where org_id = ${org.orgId} and document_id = ${invoice.id}`,
          "objects",
        ),
      );
      assert.equal(invoiceLine[0]!.quantity, "3.00000000");
      await withOrgContext(org.orgId, async () => {
        await db.execute(
          sql`update documents set document_date = ${org.date}, status = 'approved' where org_id = ${org.orgId} and id = ${invoice.id}`,
        );
        await postDocument(invoice.id, {
          control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
        });
      });
      await withOrgContext(org.orgId, () =>
        requestDocumentVoid({
          documentId: invoice.id,
          orgId: org.orgId,
          actorId,
          reason: "Correct the customer invoice",
          reversalDate: org.date,
          source: "api",
        }),
      );
      await withOrgContext(org.orgId, () =>
        requestDocumentVoid({
          documentId: bill.id,
          orgId: org.orgId,
          actorId,
          reason: "Correct the vendor bill",
          reversalDate: org.date,
          source: "api",
        }),
      );
      await withOrgContext(org.orgId, () =>
        requestDocumentVoid({
          documentId: first.salesFulfillment.id,
          orgId: org.orgId,
          actorId,
          reason: "Reverse the vendor confirmation",
          reversalDate: org.date,
          source: "api",
        }),
      );
      const voidFacts = await withOrgContext(org.orgId, () =>
        db.execute<{
          receipt_status: string;
          fulfillment_status: string;
          confirmation_entries: number;
          reversed: number;
          cogs_net: string;
          clearing_net: string;
          so_fulfilled: string;
          po_received: string;
        }>(
          sql`
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
       where receipt.org_id = ${org.orgId} and receipt.id = ${first.purchaseReceipt.id} limit 1`,
          "objects",
        ),
      );
      assert.equal(voidFacts[0]!.receipt_status, "voided");
      assert.equal(voidFacts[0]!.fulfillment_status, "voided");
      assert.equal(voidFacts[0]!.confirmation_entries, 1);
      assert.equal(voidFacts[0]!.reversed, 1);
      assert.equal(voidFacts[0]!.cogs_net, "0.0000");
      assert.equal(voidFacts[0]!.clearing_net, "0.0000");
      assert.equal(voidFacts[0]!.so_fulfilled, "0.00000000");
      assert.equal(voidFacts[0]!.po_received, "0.00000000");
    } finally {
      await withOrgContext(org.orgId, () => dropScratchOrg(org.orgId));
    }
  },
);
