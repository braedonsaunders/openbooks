import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * One received-not-billed policy for every reader: the item costing profile
 * wins, otherwise the company control account applies, and only a missing
 * both refuses — naming both places. A hand-coded vendor bill for
 * receipt-tracked stock with an open purchase order refuses naming the
 * order instead of debiting inventory a second time. Runs in a child with
 * React's server condition like the purchase-receipt counterpart.
 */
test("received-not-billed resolves profile then company and never double-counts", { skip: !DB }, () => {
  const source = `
    import assert from "node:assert/strict";
    import { randomUUID } from "node:crypto";
    import { sql } from "drizzle-orm";
    import { db, withOrg } from "./engine/src/platform/db.ts";
    import { installTrustedTestDatabaseBypass } from "./engine/src/testing/database-bypass.ts";
    import { postDocument } from "./engine/src/ledger/posting-document.ts";
    import { toUnits } from "./engine/src/money/money.ts";
    import { convertOrder, createOrderDraft, receivePurchaseOrder } from "./web/lib/order-cycle.ts";
    import { createScratchOrg, createScratchUser, dropScratchOrg } from "./engine/src/testing/fixtures.ts";

    installTrustedTestDatabaseBypass();

    const balanceOf = async (orgId, accountId) => (await db.execute(sql\`
      select coalesce(sum(l.amount), 0)::text as amount from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
       where l.org_id = \${orgId} and l.account_id = \${accountId} and e.status = 'posted'
    \`)).rows[0].amount;
    const onHand = async (orgId, itemId) => (await db.execute(sql\`
      select coalesce(sum(quantity), 0)::text as quantity from inventory_movements
       where org_id = \${orgId} and item_id = \${itemId} and status = 'posted'
    \`)).rows[0].quantity;
    const approveOrder = async (org, orderId, total) => {
      await db.execute(sql\`
        update documents
           set status = 'approved', party_id = \${org.vendorId}, subsidiary_id = \${org.subsidiaryId},
               document_date = \${org.date}, subtotal = \${total}, total = \${total}
         where id = \${orderId} and org_id = \${org.orgId}
      \`);
    };
    const addPoLine = async (org, orderId, lineId, amount) => {
      await db.execute(sql\`
        insert into document_lines
          (id, org_id, document_id, line_number, item_id, account_id, description, quantity, unit,
           unit_price, amount, tax_amount, quantity_fulfilled, quantity_billed, stock_location_id, custom)
        values
          (\${lineId}, \${org.orgId}, \${orderId}, 1, \${org.items.fifo}, \${org.accounts.invAsset},
           'Widget', '10', 'ea', '2', \${amount}, '0', '0', '0', \${org.stockLocationId}, '{}'::jsonb)
      \`);
    };
    const addCompanyGrni = async (org) => {
      const id = randomUUID();
      await db.execute(sql\`
        insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
        values (\${id}, \${org.orgId}, '2160', 'Company GRNI', 'liability_current_other', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)
      \`);
      await db.execute(sql\`
        update orgs set settings = jsonb_set(settings, '{controlAccounts,receivedNotBilled}', to_jsonb(\${id}::text), true)
         where id = \${org.orgId}
      \`);
      return id;
    };
    const blankProfileRnb = async (org) => {
      await db.execute(sql\`
        update item_inventory_profiles set received_not_billed_account_id = null
         where org_id = \${org.orgId} and item_id = \${org.items.fifo}
      \`);
    };
    const baseCurrency = async (orgId) => (await db.execute(sql\`
      select base_currency as currency from orgs where id = \${orgId}
    \`)).rows[0].currency;

    // ---- Company default clears the receipt when the profile is blank -----
    {
      const org = await createScratchOrg();
      try {
        const userId = await createScratchUser(org.orgId, "Receiving Clerk", "admin");
        await blankProfileRnb(org);
        const companyGrni = await addCompanyGrni(org);
        const order = await withOrg(org.orgId, () => createOrderDraft(org.orgId, userId, "purchase_order", randomUUID(), null));
        const sourceLineId = randomUUID();
        await addPoLine(org, order.id, sourceLineId, "20");
        await approveOrder(org, order.id, "20");
        await withOrg(org.orgId, () => receivePurchaseOrder(org.orgId, userId, order.id, {
          receiptDate: org.date, idempotencyKey: "receipt-company-default", lines: [{ sourceLineId, quantity: "10" }],
        }));
        assert.equal(toUnits(await onHand(org.orgId, org.items.fifo)), toUnits("10"));
        assert.equal(toUnits(await balanceOf(org.orgId, org.accounts.invAsset)), toUnits("20"), "DR inventory");
        assert.equal(toUnits(await balanceOf(org.orgId, companyGrni)), toUnits("-20"), "CR company GRNI, not the blank profile");
        assert.equal(toUnits(await balanceOf(org.orgId, org.accounts.clearing)), toUnits("0"), "profile clearing untouched");

        const bill = await withOrg(org.orgId, () => convertOrder(org.orgId, userId, order.id, "vendor_bill"));
        await db.execute(sql\`update documents set status = 'approved' where id = \${bill.id} and org_id = \${org.orgId}\`);
        await postDocument(bill.id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
        assert.equal(toUnits(await onHand(org.orgId, org.items.fifo)), toUnits("10"), "the bill receives nothing again");
        assert.equal(toUnits(await balanceOf(org.orgId, org.accounts.invAsset)), toUnits("20"), "inventory carries the received cost once");
        assert.equal(toUnits(await balanceOf(org.orgId, companyGrni)), toUnits("0"), "the bill clears company GRNI to zero");
        assert.equal(toUnits(await balanceOf(org.orgId, org.accounts.ap)), toUnits("-20"));
      } finally {
        await dropScratchOrg(org.orgId);
      }
    }

    // ---- Neither configured refuses naming both places --------------------
    {
      const org = await createScratchOrg();
      try {
        const userId = await createScratchUser(org.orgId, "Receiving Clerk", "admin");
        await blankProfileRnb(org);
        const order = await withOrg(org.orgId, () => createOrderDraft(org.orgId, userId, "purchase_order", randomUUID(), null));
        const sourceLineId = randomUUID();
        await addPoLine(org, order.id, sourceLineId, "20");
        await approveOrder(org, order.id, "20");
        await assert.rejects(
          withOrg(org.orgId, () => receivePurchaseOrder(org.orgId, userId, order.id, {
            receiptDate: org.date, idempotencyKey: "receipt-no-rnb-anywhere", lines: [{ sourceLineId, quantity: "10" }],
          })),
          (error) => /costing profile/.test(error.message) && /Company Settings/.test(error.message),
        );
      } finally {
        await dropScratchOrg(org.orgId);
      }
    }

    // ---- A hand-coded bill with an open order refuses naming the order ----
    {
      const org = await createScratchOrg();
      try {
        const userId = await createScratchUser(org.orgId, "AP Clerk", "admin");
        const currency = await baseCurrency(org.orgId);
        const order = await withOrg(org.orgId, () => createOrderDraft(org.orgId, userId, "purchase_order", randomUUID(), null));
        await addPoLine(org, order.id, randomUUID(), "20");
        await approveOrder(org, order.id, "20");
        const billId = randomUUID();
        await db.execute(sql\`
          insert into documents (id, org_id, kind, document_number, party_id, document_date, due_date, currency,
                                 status, subsidiary_id, subtotal, tax_total, total, custom, created_by)
          values (\${billId}, \${org.orgId}, 'vendor_bill', 'BILL-MAN-1', \${org.vendorId}, \${org.date}, \${org.date},
                  \${currency}, 'draft', \${org.subsidiaryId}, '20', '0', '20', '{}'::jsonb, \${userId})
        \`);
        await db.execute(sql\`
          insert into document_lines
            (id, org_id, document_id, line_number, item_id, account_id, description, quantity, unit,
             unit_price, amount, tax_amount, stock_location_id, custom)
          values
            (\${randomUUID()}, \${org.orgId}, \${billId}, 1, \${org.items.fifo}, \${org.accounts.invAsset},
             'Widget', '10', 'ea', '2', '20', '0', \${org.stockLocationId}, '{}'::jsonb)
        \`);
        await db.execute(sql\`update documents set status = 'approved' where id = \${billId} and org_id = \${org.orgId}\`);
        await assert.rejects(
          postDocument(billId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } }),
          (error) => /still open on purchase order/.test(error.message) && /match the bill/.test(error.message),
        );
        assert.equal(toUnits(await onHand(org.orgId, org.items.fifo)), toUnits("0"), "a refused bill moves no stock");
      } finally {
        await dropScratchOrg(org.orgId);
      }
    }

    // ---- A counter purchase with no order keeps bill-is-the-receipt -------
    {
      const org = await createScratchOrg();
      try {
        const userId = await createScratchUser(org.orgId, "AP Clerk", "admin");
        const currency = await baseCurrency(org.orgId);
        await blankProfileRnb(org);
        const billId = randomUUID();
        await db.execute(sql\`
          insert into documents (id, org_id, kind, document_number, party_id, document_date, due_date, currency,
                                 status, subsidiary_id, subtotal, tax_total, total, custom, created_by)
          values (\${billId}, \${org.orgId}, 'vendor_bill', 'BILL-COUNTER-1', \${org.vendorId}, \${org.date}, \${org.date},
                  \${currency}, 'draft', \${org.subsidiaryId}, '20', '0', '20', '{}'::jsonb, \${userId})
        \`);
        await db.execute(sql\`
          insert into document_lines
            (id, org_id, document_id, line_number, item_id, account_id, description, quantity, unit,
             unit_price, amount, tax_amount, stock_location_id, custom)
          values
            (\${randomUUID()}, \${org.orgId}, \${billId}, 1, \${org.items.fifo}, \${org.accounts.invAsset},
             'Widget', '10', 'ea', '2', '20', '0', \${org.stockLocationId}, '{}'::jsonb)
        \`);
        await db.execute(sql\`update documents set status = 'approved' where id = \${billId} and org_id = \${org.orgId}\`);
        await postDocument(billId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
        assert.equal(toUnits(await onHand(org.orgId, org.items.fifo)), toUnits("10"), "a direct purchase still brings its stock in");
        assert.equal(toUnits(await balanceOf(org.orgId, org.accounts.invAsset)), toUnits("20"));
      } finally {
        await dropScratchOrg(org.orgId);
      }
    }

    console.log("RECEIVED-NOT-BILLED-POLICY");
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
  assert.match(result.stdout, /RECEIVED-NOT-BILLED-POLICY/);
});
