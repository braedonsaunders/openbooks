import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * A drawer-created vendor bill hand-coded against received stock: the bill
 * carries no purchase-order links and no capture evidence. Posting matches
 * each stocked line to its purchase-order line automatically when exactly
 * one order line covers it — the bill clears received-not-billed at the
 * receipt value with any invoice/order price difference in purchase price
 * variance, and no second inventory movement posts. An ambiguous bill
 * (several order lines covering one bill line) still refuses naming the
 * open orders with the Match remedy, and voiding the posted bill walks
 * the billed cover and the variance entries back.
 * Runs in a child with React's server condition like its siblings.
 */
test(
  "a hand-coded bill for received stock auto-matches on post and refuses duplicate receipt claims",
  { skip: !DB },
  () => {
    const source = `
    import assert from "node:assert/strict";
    import { randomUUID } from "node:crypto";
    import { sql } from "drizzle-orm";
    import { db, withOrg } from "./engine/src/platform/db.ts";
    import { installTrustedTestDatabaseBypass } from "./engine/src/testing/database-bypass.ts";
    import { postDocument } from "./engine/src/ledger/posting-document.ts";
    import { toUnits } from "./engine/src/money/money.ts";
    import { toQuantityUnits } from "./engine/src/money/quantity.ts";
    import { createOrderDraft, receivePurchaseOrder } from "./web/lib/order-cycle.ts";
    import { createScratchOrg, createScratchUser, dropScratchOrg } from "./engine/src/testing/fixtures.ts";

    installTrustedTestDatabaseBypass();

    const org = await createScratchOrg();
    try {
      const userId = await createScratchUser(org.orgId, "AP Clerk", "admin");
      await db.execute(sql\`
        update item_inventory_profiles set unit_conversions = '{"lb": 1}'::jsonb
         where org_id = \${org.orgId} and item_id in (\${org.items.fifo}, \${org.items.movingAvg}, \${org.items.standard})
      \`);
      // Two lines cannot claim the same received quantity twice in one
      // Match action, even though the order line still has ordered quantity.
      const partialOrder = await withOrg(org.orgId, () => createOrderDraft(org.orgId, userId, "purchase_order", randomUUID(), null));
      const partialSource = randomUUID();
      await db.execute(sql\`
        insert into document_lines
          (id, org_id, document_id, line_number, item_id, account_id, description, quantity, unit,
           unit_price, amount, tax_amount, quantity_fulfilled, quantity_billed, stock_location_id, custom)
        values
          (\${partialSource}, \${org.orgId}, \${partialOrder.id}, 1, \${org.items.standard}, \${org.accounts.invAsset},
           'Partially received grain', '20', 'lb', '6', '120', '0', '0', '0', \${org.stockLocationId}, '{}'::jsonb)
      \`);
      await db.execute(sql\`
        update documents
           set status = 'approved', party_id = \${org.vendorId}, subsidiary_id = \${org.subsidiaryId},
               document_date = \${org.date}, subtotal = '120', total = '120'
         where id = \${partialOrder.id} and org_id = \${org.orgId}
      \`);
      // Seed historical counter-only receipt evidence: this case verifies
      // repeated bill lines cannot reuse cover, without adding unrelated
      // inventory and received-not-billed balances to the posting scenario.
      await db.execute(sql\`update documents set status = 'draft' where id = \${partialOrder.id} and org_id = \${org.orgId}\`);
      await db.execute(sql\`update document_lines set quantity_fulfilled = '10' where id = \${partialSource} and org_id = \${org.orgId}\`);
      await db.execute(sql\`update documents set status = 'approved' where id = \${partialOrder.id} and org_id = \${org.orgId}\`);
      const partialBillId = randomUUID();
      const partialBillLineA = randomUUID();
      const partialBillLineB = randomUUID();
      const currency = (await db.execute(sql\`select base_currency as c from orgs where id = \${org.orgId}\`)).rows[0].c;
      await db.execute(sql\`
        insert into documents (id, org_id, kind, document_number, party_id, document_date, due_date, currency,
                               status, subsidiary_id, subtotal, tax_total, total, custom, created_by)
        values (\${partialBillId}, \${org.orgId}, 'vendor_bill', 'BILL-M27-PARTIAL', \${org.vendorId}, \${org.date}, \${org.date},
                \${currency}, 'draft', \${org.subsidiaryId}, '120', '0', '120', '{}'::jsonb, \${userId})
      \`);
      await db.execute(sql\`
        insert into document_lines
          (id, org_id, document_id, line_number, item_id, account_id, description, quantity, unit,
           unit_price, amount, tax_amount, stock_location_id, custom)
        values
          (\${partialBillLineA}, \${org.orgId}, \${partialBillId}, 1, \${org.items.standard}, \${org.accounts.clearing},
           'Partially received grain A', '10', 'lb', '6', '60', '0', \${org.stockLocationId}, '{}'::jsonb),
          (\${partialBillLineB}, \${org.orgId}, \${partialBillId}, 2, \${org.items.standard}, \${org.accounts.clearing},
           'Partially received grain B', '10', 'lb', '6', '60', '0', \${org.stockLocationId}, '{}'::jsonb)
      \`);
      const { matchVendorBillLines } = await import("./engine/src/payables/vendor-bill-matching.ts");
      await assert.rejects(
        withOrg(org.orgId, () => matchVendorBillLines({
          orgId: org.orgId, billId: partialBillId, actorId: userId,
          matches: [
            { billLineId: partialBillLineA, purchaseOrderLineId: partialSource },
            { billLineId: partialBillLineB, purchaseOrderLineId: partialSource },
          ],
        })),
        /only 0\.0000 received and unbilled/,
      );
      const partialBilled = (await db.execute(sql\`
        select quantity_billed::text as billed from document_lines where id = \${partialSource}
      \`)).rows[0].billed;
      assert.equal(toQuantityUnits(partialBilled), toQuantityUnits("0"), "a refused multi-line match leaves billed quantity unchanged");

      const order = await withOrg(org.orgId, () => createOrderDraft(org.orgId, userId, "purchase_order", randomUUID(), null));
      const sourceA = randomUUID();
      const sourceB = randomUUID();
      await db.execute(sql\`
        insert into document_lines
          (id, org_id, document_id, line_number, item_id, account_id, description, quantity, unit,
           unit_price, amount, tax_amount, quantity_fulfilled, quantity_billed, stock_location_id, custom)
        values
          (\${sourceA}, \${org.orgId}, \${order.id}, 1, \${org.items.fifo}, \${org.accounts.invAsset},
           'Grain A', '2432', 'lb', '6', '14592', '0', '0', '0', \${org.stockLocationId}, '{}'::jsonb),
          (\${sourceB}, \${org.orgId}, \${order.id}, 2, \${org.items.movingAvg}, \${org.accounts.invAsset},
           'Grain B', '2128', 'lb', '5', '10640', '0', '0', '0', \${org.stockLocationId}, '{}'::jsonb)
      \`);
      await db.execute(sql\`
        update documents
           set status = 'approved', party_id = \${org.vendorId}, subsidiary_id = \${org.subsidiaryId},
               document_date = \${org.date}, subtotal = '25232', total = '25232'
         where id = \${order.id} and org_id = \${org.orgId}
      \`);
      await withOrg(org.orgId, () => receivePurchaseOrder(org.orgId, userId, order.id, {
        receiptDate: org.date, idempotencyKey: "m27-full-receipt",
        lines: [{ sourceLineId: sourceA, quantity: "2432" }, { sourceLineId: sourceB, quantity: "2128" }],
      }));

      // A drawer-created bill: no document links, no match evidence — the
      // stocked lines are hand-coded straight to received-not-billed and a
      // freight line rides the inventory asset, exactly the tenant shape.
      const billId = randomUUID();
      await db.execute(sql\`
        insert into documents (id, org_id, kind, document_number, party_id, document_date, due_date, currency,
                               status, subsidiary_id, subtotal, tax_total, total, custom, created_by)
        values (\${billId}, \${org.orgId}, 'vendor_bill', 'BILL-M27-1', \${org.vendorId}, \${org.date}, \${org.date},
                \${currency}, 'draft', \${org.subsidiaryId}, '26571.20', '0', '26571.20', '{}'::jsonb, \${userId})
      \`);
      await db.execute(sql\`
        insert into document_lines
          (id, org_id, document_id, line_number, item_id, account_id, description, quantity, unit,
           unit_price, amount, tax_amount, stock_location_id, custom)
        values
          (\${randomUUID()}, \${org.orgId}, \${billId}, 1, \${org.items.fifo}, \${org.accounts.clearing},
           'Grain A', '2432', 'lb', '6.20', '15078.40', '0', \${org.stockLocationId}, '{}'::jsonb),
          (\${randomUUID()}, \${org.orgId}, \${billId}, 2, \${org.items.movingAvg}, \${org.accounts.clearing},
           'Grain B', '2128', 'lb', '5.10', '10852.80', '0', \${org.stockLocationId}, '{}'::jsonb),
          (\${randomUUID()}, \${org.orgId}, \${billId}, 3, null, \${org.accounts.invAsset},
           'Freight', '1', 'lot', '640', '640', '0', \${org.stockLocationId}, '{}'::jsonb)
      \`);
      await db.execute(sql\`update documents set status = 'approved' where id = \${billId} and org_id = \${org.orgId}\`);

      const links = (await db.execute(sql\`
        select count(*)::int as count from document_links where org_id = \${org.orgId} and to_document_id = \${billId}
      \`)).rows[0].count;
      assert.equal(links, 0, "the drawer bill carries no purchase-order links");

      // ---- The Match dialog offers each received line its order line ----
      const { billMatchCandidates } = await import("./engine/src/payables/vendor-bill-matching.ts");
      const suggestions = await withOrg(org.orgId, () => billMatchCandidates(org.orgId, billId));
      assert.equal(suggestions.lines.length, 3);
      assert.equal(suggestions.lines[0].candidates.length, 1, "the received line offers its purchase-order line");
      assert.equal(suggestions.lines[0].candidates[0].purchaseOrderLineNumber, 1);
      assert.equal(suggestions.lines[0].candidates[0].receipts.length, 1, "the candidate names its goods receipt");
      assert.equal(suggestions.lines[2].candidates.length, 0, "the freight line has nothing to match");

      // ---- Posting matches each line automatically: no second receipt ----
      await postDocument(billId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
      const stamps = (await db.execute(sql\`
        select line_number as ln, custom from document_lines
         where org_id = \${org.orgId} and document_id = \${billId} and line_number in (1, 2) order by line_number
      \`)).rows;
      assert.equal(stamps[0].custom.purchaseOrderLineId, sourceA, "posting stamps the drawn-from order line");
      assert.equal(stamps[1].custom.purchaseOrderLineId, sourceB);
      assert.ok(stamps[0].custom.convertedFrom, "posting stamps conversion-grade cover the void walks back");
      const edge = (await db.execute(sql\`
        select count(*)::int as count from document_links
         where org_id = \${org.orgId} and to_document_id = \${billId} and link_type = 'bills'
      \`)).rows[0].count;
      assert.equal(edge, 1, "posting links the order to the bill");
      const audit = (await db.execute(sql\`
        select count(*)::int as count from audit_log
         where org_id = \${org.orgId} and row_id = \${billId} and changes->>'mode' = 'bill_lines_auto_matched'
      \`)).rows[0].count;
      assert.equal(audit, 1, "the automatic match is audited");
      console.log("M27-HAND-CODED-BILL-AUTO-MATCHES");

      // A posted bill can no longer be matched through the dialog action.
      const billLineIds = (await db.execute(sql\`
        select id, line_number as ln from document_lines
         where org_id = \${org.orgId} and document_id = \${billId} and line_number in (1, 2) order by line_number
      \`)).rows;
      await assert.rejects(
        withOrg(org.orgId, () => matchVendorBillLines({
          orgId: org.orgId, billId, actorId: userId,
          matches: [{ billLineId: billLineIds[0].id, purchaseOrderLineId: sourceA }],
        })),
        /only a draft or approved bill/,
      );
      const facts = (await db.execute(sql\`
        select (select status from documents where id = \${billId}) as status,
               (select coalesce(sum(quantity), 0)::text from inventory_movements
                 where org_id = \${org.orgId} and status = 'posted'
                   and item_id in (\${org.items.fifo}, \${org.items.movingAvg})) as on_hand,
               (select count(*)::int from inventory_movements m
                 join document_lines l on l.id = m.document_line_id and l.org_id = m.org_id
                where m.org_id = \${org.orgId} and l.document_id = \${billId} and m.kind = 'receipt') as bill_receipts
      \`)).rows[0];
      assert.equal(facts.status, "posted");
      assert.equal(toUnits(facts.on_hand), toUnits("4560"), "the matched bill receives nothing again");
      assert.equal(facts.bill_receipts, 0);
      const balanceOf = async (accountId) => (await db.execute(sql\`
        select coalesce(sum(l.amount), 0)::text as amount from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
         where l.org_id = \${org.orgId} and l.account_id = \${accountId} and e.status = 'posted'
      \`)).rows[0].amount;
      assert.equal(toUnits(await balanceOf(org.accounts.clearing)), toUnits("0"), "the bill clears received-not-billed");
      assert.equal(toUnits(await balanceOf(org.accounts.adjustment)), toUnits("699.20"), "invoice/order price differences land in PPV");
      assert.equal(toUnits(await balanceOf(org.accounts.invAsset)), toUnits("25872"), "inventory keeps receipt cost plus freight");
      assert.equal(toUnits(await balanceOf(org.accounts.ap)), toUnits("-26571.20"));
      const billed = (await db.execute(sql\`
        select quantity_billed::text as billed from document_lines where id in (\${sourceA}, \${sourceB}) order by line_number
      \`)).rows;
      assert.equal(toUnits(billed[0].billed), toUnits("2432"));
      assert.equal(toUnits(billed[1].billed), toUnits("2128"));
      console.log("M27-MATCHED-BILL-POSTS");

      // ---- An ambiguous bill still refuses with the Match remedy ---------
      const order2 = await withOrg(org.orgId, () => createOrderDraft(org.orgId, userId, "purchase_order", randomUUID(), null));
      const sourceC = randomUUID();
      const sourceD = randomUUID();
      await db.execute(sql\`
        insert into document_lines
          (id, org_id, document_id, line_number, item_id, account_id, description, quantity, unit,
           unit_price, amount, tax_amount, quantity_fulfilled, quantity_billed, stock_location_id, custom)
        values
          (\${sourceC}, \${org.orgId}, \${order2.id}, 1, \${org.items.fifo}, \${org.accounts.invAsset},
           'Grain A', '100', 'lb', '6', '600', '0', '0', '0', \${org.stockLocationId}, '{}'::jsonb),
          (\${sourceD}, \${org.orgId}, \${order2.id}, 2, \${org.items.fifo}, \${org.accounts.invAsset},
           'Grain A again', '50', 'lb', '6', '300', '0', '0', '0', \${org.stockLocationId}, '{}'::jsonb)
      \`)
      await db.execute(sql\`
        update documents
           set status = 'approved', party_id = \${org.vendorId}, subsidiary_id = \${org.subsidiaryId},
               document_date = \${org.date}, subtotal = '900', total = '900'
         where id = \${order2.id} and org_id = \${org.orgId}
      \`)
      await withOrg(org.orgId, () => receivePurchaseOrder(org.orgId, userId, order2.id, {
        receiptDate: org.date, idempotencyKey: "m27-second-receipt",
        lines: [{ sourceLineId: sourceC, quantity: "100" }, { sourceLineId: sourceD, quantity: "50" }],
      }));
      const bill2Id = randomUUID();
      await db.execute(sql\`
        insert into documents (id, org_id, kind, document_number, party_id, document_date, due_date, currency,
                               status, subsidiary_id, subtotal, tax_total, total, custom, created_by)
        values (\${bill2Id}, \${org.orgId}, 'vendor_bill', 'BILL-M27-2', \${org.vendorId}, \${org.date}, \${org.date},
                \${currency}, 'draft', \${org.subsidiaryId}, '600', '0', '600', '{}'::jsonb, \${userId})
      \`)
      await db.execute(sql\`
        insert into document_lines
          (id, org_id, document_id, line_number, item_id, account_id, description, quantity, unit,
           unit_price, amount, tax_amount, stock_location_id, custom)
        values
          (\${randomUUID()}, \${org.orgId}, \${bill2Id}, 1, \${org.items.fifo}, \${org.accounts.clearing},
           'Grain A', '100', 'lb', '6', '600', '0', \${org.stockLocationId}, '{}'::jsonb)
      \`)
      await db.execute(sql\`update documents set status = 'approved' where id = \${bill2Id} and org_id = \${org.orgId}\`);
      await assert.rejects(
        withOrg(org.orgId, () => postDocument(bill2Id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } })),
        (error) => /still open on purchase order/.test(error.message) && /Match this bill/.test(error.remedy ?? ""),
      );
      const stayed = (await db.execute(sql\`select status from documents where id = \${bill2Id}\`)).rows[0];
      assert.equal(stayed.status, "approved", "a refused post leaves the bill approved");
      console.log("M27-AMBIGUOUS-BILL-REFUSES");

      // ---- Voiding the matched bill walks the cover back ------------------
      const { requestDocumentVoid } = await import("./engine/src/ledger/document-void.ts");
      const voided = await withOrg(org.orgId, () => requestDocumentVoid({
        documentId: billId, orgId: org.orgId, actorId: userId,
        reason: "supplier reissued the invoice", reversalDate: org.date,
      }));
      assert.equal(voided.status, "voided");
      const restored = (await db.execute(sql\`
        select quantity_billed::text as billed from document_lines where id in (\${sourceA}, \${sourceB}) order by line_number
      \`)).rows;
      assert.equal(toUnits(restored[0].billed), toUnits("0"), "voiding the bill releases its billed cover");
      assert.equal(toUnits(restored[1].billed), toUnits("0"));
      // Reversed entries carry the unwound half, so the economic lens sums
      // posted and reversed: the payable and the variance net to zero, the
      // receipt's received-not-billed credit stands (goods still on hand,
      // no longer billed), and inventory keeps the receipt cost alone.
      const balanceOfAll = async (accountId) => (await db.execute(sql\`
        select coalesce(sum(l.amount), 0)::text as amount from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
         where l.org_id = \${org.orgId} and l.account_id = \${accountId} and e.status in ('posted', 'reversed')
      \`)).rows[0].amount;
      assert.equal(toUnits(await balanceOfAll(org.accounts.adjustment)), toUnits("0"), "voiding the bill reverses its price variance");
      assert.equal(toUnits(await balanceOfAll(org.accounts.ap)), toUnits("0"), "voiding the bill reverses its payable");
      assert.equal(toUnits(await balanceOfAll(org.accounts.clearing)), toUnits("-26132"), "the receipts' received-not-billed credits stand un-billed");
      assert.equal(toUnits(await balanceOfAll(org.accounts.invAsset)), toUnits("26132"), "inventory keeps the receipts' cost alone");
      const afterVoid = (await db.execute(sql\`
        select coalesce(sum(quantity), 0)::text as on_hand from inventory_movements
         where org_id = \${org.orgId} and status = 'posted'
           and item_id in (\${org.items.fifo}, \${org.items.movingAvg})
      \`)).rows[0].on_hand;
      assert.equal(toUnits(afterVoid), toUnits("4710"), "voiding a matched bill moves no stock");
      console.log("M27-MATCHED-BILL-VOID-RESTORES");
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
    assert.match(result.stdout, /M27-HAND-CODED-BILL-AUTO-MATCHES/);
    assert.match(result.stdout, /M27-MATCHED-BILL-POSTS/);
    assert.match(result.stdout, /M27-AMBIGUOUS-BILL-REFUSES/);
    assert.match(result.stdout, /M27-MATCHED-BILL-VOID-RESTORES/);
  },
);
