import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * Sales fulfillment crosses the web order service and the engine inventory
 * kernel. Run the live assertion in a child with React's server condition so
 * the ordinary repository command can still register/skip this committed
 * regression when no PostgreSQL test environment is present.
 */
test("partial sales fulfillments move inventory and fence billing exactly once", { skip: !DB }, () => {
  const source = `
    import assert from "node:assert/strict";
    import { randomUUID } from "node:crypto";
    import { sql } from "drizzle-orm";
    import { db, withOrg } from "./engine/src/db.ts";
    import { installTrustedTestDatabaseBypass } from "./engine/src/test-database-bypass.ts";
    import { receiveInventory } from "./engine/src/inventory.ts";
    import { postDocument } from "./engine/src/posting.ts";
    import { toUnits } from "./engine/src/money.ts";
    import {
      convertOrder,
      createOrderDraft,
      fulfillSalesOrder,
    } from "./web/lib/order-cycle.ts";
    import {
      createScratchOrg,
      createScratchUser,
      dropScratchOrg,
    } from "./engine/src/test-fixtures.ts";

    installTrustedTestDatabaseBypass();

    const org = await createScratchOrg();
    try {
      const userId = await createScratchUser(org.orgId, "Shipping Clerk", "admin");
      await receiveInventory(org.orgId, userId, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "10",
        unitCost: "2",
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
      });

      const order = await withOrg(org.orgId, () =>
        createOrderDraft(org.orgId, userId, "sales_order"),
      );
      const sourceLineId = randomUUID();
      await db.execute(sql\`
        insert into document_lines
          (id, org_id, document_id, line_number, item_id, account_id,
           description, quantity, unit, unit_price, amount, tax_amount,
           quantity_fulfilled, quantity_billed, stock_location_id, custom)
        values
          (\${sourceLineId}, \${org.orgId}, \${order.id}, 1, \${org.items.fifo},
           \${org.accounts.revenue}, 'Widget', '10', 'ea', '10', '100', '0',
           '0', '0', \${org.stockLocationId}, '{}'::jsonb)
      \`);
      await db.execute(sql\`
        update documents
           set status = 'approved', party_id = \${org.customerId},
               subsidiary_id = \${org.subsidiaryId}, document_date = \${org.date},
               subtotal = '100', total = '100'
         where id = \${order.id} and org_id = \${org.orgId}
      \`);

      const firstCommand = {
        fulfillmentDate: org.date,
        idempotencyKey: "shipment-partial-four",
        lines: [{ sourceLineId, quantity: "4" }],
      };
      const first = await withOrg(org.orgId, () =>
        fulfillSalesOrder(org.orgId, userId, order.id, firstCommand),
      );
      const firstReplay = await withOrg(org.orgId, () =>
        fulfillSalesOrder(org.orgId, userId, order.id, firstCommand),
      );
      assert.equal(firstReplay.id, first.id, "a retry must replay the stored fulfillment document");
      assert.equal(firstReplay.replayed, true);

      const firstFacts = (await db.execute(sql\`
        select
          fulfillment.kind,
          fulfillment.status,
          fulfillment.subsidiary_id,
          fulfillment.currency,
          fulfillment.fx_rate::text as fx_rate,
          source_line.quantity_fulfilled::text as quantity_fulfilled,
          (select count(*)::int from document_links link
            where link.org_id = \${org.orgId}
              and link.from_document_id = \${order.id}
              and link.to_document_id = \${first.id}
              and link.link_type = 'fulfills') as edge_count,
          (select count(*)::int from inventory_movements movement
             join document_lines fulfillment_line
               on fulfillment_line.id = movement.document_line_id
              and fulfillment_line.org_id = movement.org_id
            where movement.org_id = \${org.orgId}
              and fulfillment_line.document_id = \${first.id}
              and movement.kind = 'issue') as movement_count,
          (select coalesce(sum(movement.quantity), 0)::text
             from inventory_movements movement
             join document_lines fulfillment_line
               on fulfillment_line.id = movement.document_line_id
              and fulfillment_line.org_id = movement.org_id
            where movement.org_id = \${org.orgId}
              and fulfillment_line.document_id = \${first.id}
              and movement.kind = 'issue') as moved_quantity,
          entry.book_id,
          entry.subsidiary_id as entry_subsidiary_id,
          entry.period_id,
          entry.posting_date::text as posting_date,
          (select min(line.currency) from journal_lines line
            where line.org_id = \${org.orgId} and line.entry_id = entry.id) as entry_currency,
          (select coalesce(sum(line.amount), 0)::text from journal_lines line
            where line.org_id = \${org.orgId} and line.entry_id = entry.id
              and line.account_id = \${org.accounts.cogs}) as cogs,
          (select coalesce(sum(line.amount), 0)::text from journal_lines line
            where line.org_id = \${org.orgId} and line.entry_id = entry.id
              and line.account_id = \${org.accounts.invAsset}) as inventory
        from documents fulfillment
        join document_lines source_line
          on source_line.document_id = \${order.id} and source_line.org_id = fulfillment.org_id
        join document_lines fulfillment_line
          on fulfillment_line.document_id = fulfillment.id and fulfillment_line.org_id = fulfillment.org_id
        join inventory_movements movement
          on movement.document_line_id = fulfillment_line.id and movement.org_id = fulfillment.org_id
        join journal_entries entry
          on entry.id = movement.journal_entry_id and entry.org_id = movement.org_id
       where fulfillment.id = \${first.id} and fulfillment.org_id = \${org.orgId}
       limit 1
      \`)).rows[0];
      assert.equal(firstFacts.kind, "sales_fulfillment");
      assert.equal(firstFacts.status, "approved");
      assert.equal(firstFacts.subsidiary_id, org.subsidiaryId);
      assert.equal(firstFacts.currency, "CAD");
      assert.equal(toUnits(firstFacts.fx_rate), toUnits("1"));
      assert.equal(toUnits(firstFacts.quantity_fulfilled), toUnits("4"));
      assert.equal(firstFacts.edge_count, 1);
      assert.equal(firstFacts.movement_count, 1);
      assert.equal(toUnits(firstFacts.moved_quantity), toUnits("-4"));
      assert.equal(firstFacts.book_id, org.bookId);
      assert.equal(firstFacts.entry_subsidiary_id, org.subsidiaryId);
      assert.equal(firstFacts.period_id, org.periodId);
      assert.equal(firstFacts.posting_date, org.date);
      assert.equal(firstFacts.entry_currency, "CAD");
      assert.equal(toUnits(firstFacts.cogs), toUnits("8"));
      assert.equal(toUnits(firstFacts.inventory), toUnits("-8"));

      // Billing is capped at the governed shipped-and-unbilled quantity.
      const firstInvoice = await withOrg(org.orgId, () =>
        convertOrder(org.orgId, userId, order.id, "customer_invoice"),
      );
      const invoiceQuantity = (await db.execute(sql\`
        select line.id, line.quantity::text as quantity
          from document_lines line
         where line.org_id = \${org.orgId} and line.document_id = \${firstInvoice.id}
      \`)).rows[0];
      assert.equal(toUnits(invoiceQuantity.quantity), toUnits("4"));
      await db.execute(sql\`
        update documents set status = 'approved'
         where id = \${firstInvoice.id} and org_id = \${org.orgId}
      \`);
      await postDocument(firstInvoice.id, {
        control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
      });
      const invoiceIssues = (await db.execute(sql\`
        select count(*)::int as count
          from inventory_movements
         where org_id = \${org.orgId} and document_line_id = \${invoiceQuantity.id}
           and kind = 'issue'
      \`)).rows[0];
      assert.equal(invoiceIssues.count, 0, "billing a fulfilled order must not issue stock again");

      // Two distinct commands race for the six units left. The source-row lock
      // admits exactly one; the loser observes the committed ceiling.
      const remainderCommands = ["shipment-remainder-a", "shipment-remainder-b"].map((idempotencyKey) => ({
        fulfillmentDate: org.date,
        idempotencyKey,
        lines: [{ sourceLineId, quantity: "6" }],
      }));
      const raced = await Promise.allSettled(remainderCommands.map((command) =>
        withOrg(org.orgId, () => fulfillSalesOrder(org.orgId, userId, order.id, command)),
      ));
      const fulfilledIndexes = raced.flatMap((result, index) => result.status === "fulfilled" ? [index] : []);
      const rejected = raced.filter((result) => result.status === "rejected");
      assert.equal(fulfilledIndexes.length, 1, "one concurrent remainder shipment must win");
      assert.equal(rejected.length, 1, "one concurrent remainder shipment must be fenced");
      const winningIndex = fulfilledIndexes[0];
      const winningResult = raced[winningIndex].value;
      const winningReplay = await withOrg(org.orgId, () =>
        fulfillSalesOrder(org.orgId, userId, order.id, remainderCommands[winningIndex]),
      );
      assert.equal(winningReplay.id, winningResult.id);
      assert.equal(winningReplay.replayed, true);

      const secondInvoice = await withOrg(org.orgId, () =>
        convertOrder(org.orgId, userId, order.id, "customer_invoice"),
      );
      const finalFacts = (await db.execute(sql\`
        select
          source_line.quantity_fulfilled::text as fulfilled,
          source_line.quantity_billed::text as billed,
          (select quantity::text from document_lines
            where org_id = \${org.orgId} and document_id = \${secondInvoice.id}) as remainder_invoice_quantity,
          (select count(*)::int from document_links
            where org_id = \${org.orgId} and from_document_id = \${order.id}
              and link_type = 'fulfills') as fulfillment_edges,
          (select count(*)::int
             from inventory_movements movement
             join document_lines line
               on line.id = movement.document_line_id and line.org_id = movement.org_id
             join documents fulfillment
               on fulfillment.id = line.document_id and fulfillment.org_id = line.org_id
            where movement.org_id = \${org.orgId} and movement.kind = 'issue'
              and fulfillment.kind = 'sales_fulfillment') as fulfillment_movements,
          (select coalesce(sum(movement.quantity), 0)::text
             from inventory_movements movement
             join document_lines line
               on line.id = movement.document_line_id and line.org_id = movement.org_id
             join documents fulfillment
               on fulfillment.id = line.document_id and fulfillment.org_id = line.org_id
            where movement.org_id = \${org.orgId} and movement.kind = 'issue'
              and fulfillment.kind = 'sales_fulfillment') as shipped_quantity
        from document_lines source_line
       where source_line.org_id = \${org.orgId} and source_line.id = \${sourceLineId}
      \`)).rows[0];
      assert.equal(toUnits(finalFacts.fulfilled), toUnits("10"));
      assert.equal(toUnits(finalFacts.billed), toUnits("10"));
      assert.equal(toUnits(finalFacts.remainder_invoice_quantity), toUnits("6"));
      assert.equal(finalFacts.fulfillment_edges, 2);
      assert.equal(finalFacts.fulfillment_movements, 2);
      assert.equal(toUnits(finalFacts.shipped_quantity), toUnits("-10"));

      await assert.rejects(
        withOrg(org.orgId, () => convertOrder(org.orgId, userId, order.id, "customer_invoice")),
        /already fully converted|do not cover/,
      );
      console.log("SALES-FULFILLMENT-EXACTLY-ONCE");
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
  assert.match(result.stdout, /SALES-FULFILLMENT-EXACTLY-ONCE/);
});
