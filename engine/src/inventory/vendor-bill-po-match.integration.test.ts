import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * A drawer-created vendor bill hand-coded against received stock: the bill
 * carries no purchase-order links and no capture evidence — its stocked
 * lines debit received-not-billed directly, the way an operator mimics a
 * matched bill by hand — while its purchase order is fully received and
 * unbilled. Posting must refuse naming the open order (billing it blind
 * would receive the stock a second time), and the refusal must stay
 * matchable: linking the bill lines to their purchase-order lines lets the
 * same bill post, clearing received-not-billed at the receipt value with
 * any invoice/order price difference in purchase price variance.
 * Runs in a child with React's server condition like its siblings.
 */
test("a hand-coded bill for received stock refuses until matched, then posts through RNB", { skip: !DB }, () => {
  const source = `
    import assert from "node:assert/strict";
    import { randomUUID } from "node:crypto";
    import { sql } from "drizzle-orm";
    import { db, withOrg } from "./engine/src/platform/db.ts";
    import { installTrustedTestDatabaseBypass } from "./engine/src/testing/database-bypass.ts";
    import { postDocument } from "./engine/src/ledger/posting-document.ts";
    import { toUnits } from "./engine/src/money/money.ts";
    import { createOrderDraft, receivePurchaseOrder } from "./web/lib/order-cycle.ts";
    import { createScratchOrg, createScratchUser, dropScratchOrg } from "./engine/src/testing/fixtures.ts";

    installTrustedTestDatabaseBypass();

    const org = await createScratchOrg();
    try {
      const userId = await createScratchUser(org.orgId, "AP Clerk", "admin");
      await db.execute(sql\`
        update item_inventory_profiles set unit_conversions = '{"lb": 1}'::jsonb
         where org_id = \${org.orgId} and item_id in (\${org.items.fifo}, \${org.items.movingAvg})
      \`);
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
      const currency = (await db.execute(sql\`select base_currency as c from orgs where id = \${org.orgId}\`)).rows[0].c;
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

      // The blind bill must refuse naming the open order: posting it would
      // receive already-received stock a second time.
      await assert.rejects(
        withOrg(org.orgId, () => postDocument(billId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } })),
        (error) => /still open on purchase order/.test(error.message) && /match the bill/.test(error.message),
      );
      const stayed = (await db.execute(sql\`select status from documents where id = \${billId}\`)).rows[0];
      assert.equal(stayed.status, "approved", "a refused post leaves the bill approved");
      console.log("M27-HAND-CODED-BILL-REFUSES");

      // ---- Matching links the lines, then the same bill posts ------------
      const { matchVendorBillLines, billMatchCandidates } = await import("./engine/src/payables/vendor-bill-matching.ts");
      const suggestions = await withOrg(org.orgId, () => billMatchCandidates(org.orgId, billId));
      assert.equal(suggestions.lines.length, 3);
      assert.equal(suggestions.lines[0].candidates.length, 1, "the received line offers its purchase-order line");
      assert.equal(suggestions.lines[0].candidates[0].purchaseOrderLineNumber, 1);
      assert.equal(suggestions.lines[0].candidates[0].receipts.length, 1, "the candidate names its goods receipt");
      assert.equal(suggestions.lines[2].candidates.length, 0, "the freight line has nothing to match");

      const billLineIds = (await db.execute(sql\`
        select id, line_number as ln from document_lines
         where org_id = \${org.orgId} and document_id = \${billId} and line_number in (1, 2) order by line_number
      \`)).rows;
      const matched = await withOrg(org.orgId, () => matchVendorBillLines({
        orgId: org.orgId, billId, actorId: userId,
        matches: [
          { billLineId: billLineIds[0].id, purchaseOrderLineId: sourceA },
          { billLineId: billLineIds[1].id, purchaseOrderLineId: sourceB },
        ],
      }));
      assert.equal(matched.matched.length, 2);
      await assert.rejects(
        withOrg(org.orgId, () => matchVendorBillLines({
          orgId: org.orgId, billId, actorId: userId,
          matches: [{ billLineId: billLineIds[0].id, purchaseOrderLineId: sourceA }],
        })),
        /already matched/,
      );

      await postDocument(billId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
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
  assert.match(result.stdout, /M27-HAND-CODED-BILL-REFUSES/);
  assert.match(result.stdout, /M27-MATCHED-BILL-POSTS/);
  assert.match(result.stdout, /M27-MATCHED-BILL-VOID-RESTORES/);
});
