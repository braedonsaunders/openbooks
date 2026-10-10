import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * Default receiving warehouse per legal entity: the designated row wins,
 * then the company row, then the implicit single warehouse. A first receipt
 * for a single-site org with no warehouse creates it through the warehouse
 * service, audited. Runs in a child with React's server condition like the
 * purchase-receipt counterpart.
 */
test("warehouse defaults resolve, auto-create, and refuse with a route", { skip: !DB }, () => {
  const source = `
    import assert from "node:assert/strict";
    import { randomUUID } from "node:crypto";
    import { sql } from "drizzle-orm";
    import { db, withOrg, withBypassContext } from "./engine/src/platform/db.ts";
    const run = (work) => withBypassContext(work);
    import { installTrustedTestDatabaseBypass } from "./engine/src/testing/database-bypass.ts";
    import { toUnits } from "./engine/src/money/money.ts";
    import { resolveDefaultWarehouse } from "./engine/src/inventory/warehouses.ts";
    import { createOrderDraft, receivePurchaseOrder } from "./web/lib/order-cycle.ts";
    import { createScratchOrg, createScratchUser, dropScratchOrg } from "./engine/src/testing/fixtures.ts";

    installTrustedTestDatabaseBypass();

    const enableFeatures = async (orgId) => {
      await run(() => db.execute(sql\`
        update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
             || '{"orders": true, "inventory": true, "warehousing": true, "fulfillment": true}'::jsonb)
         where id = \${orgId}
      \`));
    };
    const designate = async (orgId, subsidiaryId, warehouseId) => {
      await run(() => db.execute(sql\`
        insert into warehouse_defaults (id, org_id, subsidiary_id, warehouse_id, is_active)
        values (\${randomUUID()}, \${orgId}, \${subsidiaryId}, \${warehouseId}, true)
      \`));
    };
    const deactivateWarehouses = async (orgId) => {
      await run(() => db.execute(sql\`update stock_locations set is_active = false where org_id = \${orgId} and kind = 'warehouse'\`));
    };
    const warehouseCount = async (orgId) => (await db.execute(sql\`
      select count(*)::int as n from stock_locations where org_id = \${orgId} and is_active and kind = 'warehouse'
    \`)).rows[0].n;
    const draftPo = async (org, userId, total) => {
      const order = await withOrg(org.orgId, () => createOrderDraft(org.orgId, userId, "purchase_order", randomUUID(), null));
      const sourceLineId = randomUUID();
      await db.execute(sql\`
        insert into document_lines
          (id, org_id, document_id, line_number, item_id, account_id, description, quantity, unit,
           unit_price, amount, tax_amount, quantity_fulfilled, quantity_billed, stock_location_id, custom)
        values
          (\${sourceLineId}, \${org.orgId}, \${order.id}, 1, \${org.items.fifo}, \${org.accounts.invAsset},
           'Widget', '10', 'ea', '2', \${total}, '0', '0', '0', null, '{}'::jsonb)
      \`);
      await db.execute(sql\`
        update documents
           set status = 'approved', party_id = \${org.vendorId}, subsidiary_id = \${org.subsidiaryId},
               document_date = \${org.date}, subtotal = \${total}, total = \${total}
         where id = \${order.id} and org_id = \${org.orgId}
      \`);
      return { order, sourceLineId };
    };
    const receive = (org, userId, order, sourceLineId, key) =>
      withOrg(org.orgId, () => receivePurchaseOrder(org.orgId, userId, order.id, {
        receiptDate: org.date, idempotencyKey: key, lines: [{ sourceLineId, quantity: "10" }],
      }));
    const receiptWarehouse = async (orgId, receiptId) => (await db.execute(sql\`
      select stock_location_id as id from document_lines where org_id = \${orgId} and document_id = \${receiptId} limit 1
    \`)).rows[0].id;

    // ---- Designated company row wins over the implicit pair ------------
    {
      const org = await createScratchOrg();
      await enableFeatures(org.orgId);
      try {
        const userId = await createScratchUser(org.orgId, "Receiving Clerk", "admin");
        const main = (await db.execute(sql\`
          select id from stock_locations where org_id = \${org.orgId} and code = 'MAIN'
        \`)).rows[0].id;
        await designate(org.orgId, null, main);
        assert.equal(await resolveDefaultWarehouse(db, org.orgId, org.subsidiaryId), main);
        const { order, sourceLineId } = await draftPo(org, userId, "20");
        const receipt = await receive(org, userId, order, sourceLineId, "receipt-designated");
        assert.equal(await receiptWarehouse(org.orgId, receipt.id), main, "blank lines land in the designated warehouse");
      } finally {
        await dropScratchOrg(org.orgId);
      }
    }

    // ---- A dead designation fails closed naming the setting -------------
    {
      const org = await createScratchOrg();
      await enableFeatures(org.orgId);
      try {
        const userId = await createScratchUser(org.orgId, "Receiving Clerk", "admin");
        const main = (await db.execute(sql\`
          select id from stock_locations where org_id = \${org.orgId} and code = 'MAIN'
        \`)).rows[0].id;
        await designate(org.orgId, null, main);
        await deactivateWarehouses(org.orgId);
        await assert.rejects(
          resolveDefaultWarehouse(db, org.orgId, org.subsidiaryId),
          /Setup → Warehouse defaults/,
        );
        const { order, sourceLineId } = await draftPo(org, userId, "20");
        await assert.rejects(
          receive(org, userId, order, sourceLineId, "receipt-dead-default"),
          /Setup → Warehouse defaults/,
        );
      } finally {
        await dropScratchOrg(org.orgId);
      }
    }

    // ---- First receipt auto-creates the default under one location ------
    {
      const org = await createScratchOrg();
      await enableFeatures(org.orgId);
      try {
        const userId = await createScratchUser(org.orgId, "Receiving Clerk", "admin");
        await deactivateWarehouses(org.orgId);
        await run(() => db.execute(sql\`update locations set is_active = false where org_id = \${org.orgId} and name = 'DC'\`));
        assert.equal(await warehouseCount(org.orgId), 0);
        const { order, sourceLineId } = await draftPo(org, userId, "20");
        const receipt = await receive(org, userId, order, sourceLineId, "receipt-auto-default");
        assert.equal(await warehouseCount(org.orgId), 1, "exactly one warehouse is created");
        const created = (await db.execute(sql\`
          select sl.id, sl.code, w.status, w.name from stock_locations sl
            join warehouses w on w.stock_location_id = sl.id and w.org_id = sl.org_id
           where sl.org_id = \${org.orgId} and sl.kind = 'warehouse' and sl.code = 'HQ-WH'
        \`)).rows[0];
        assert.ok(created, "the default warehouse is created under the single location");
        assert.equal(created.status, "active", "the default arrives ready to receive");
        assert.equal(await receiptWarehouse(org.orgId, receipt.id), created.id);
        const audit = (await db.execute(sql\`
          select changes from audit_log where org_id = \${org.orgId} and table_name = 'warehouses' and row_id = \${created.id}
        \`)).rows;
        assert.ok(audit.some((row) => row.changes?.event === "warehouse_created"), "auto-creation is audited");
        const onHand = (await db.execute(sql\`
          select coalesce(sum(quantity), 0)::text as quantity from inventory_movements
           where org_id = \${org.orgId} and item_id = \${org.items.fifo} and status = 'posted'
        \`)).rows[0].quantity;
        assert.equal(toUnits(onHand), toUnits("10"));
      } finally {
        await dropScratchOrg(org.orgId);
      }
    }

    // ---- Several locations with no warehouse still refuse with a route ---
    {
      const org = await createScratchOrg();
      await enableFeatures(org.orgId);
      try {
        const userId = await createScratchUser(org.orgId, "Receiving Clerk", "admin");
        await deactivateWarehouses(org.orgId);
        assert.equal(await warehouseCount(org.orgId), 0);
        const { order, sourceLineId } = await draftPo(org, userId, "20");
        await assert.rejects(
          receive(org, userId, order, sourceLineId, "receipt-no-default"),
          /Warehouse → Warehouses/,
        );
      } finally {
        await dropScratchOrg(org.orgId);
      }
    }

    // ---- Entity isolation and designation precedence ------------------
    {
      const org = await createScratchOrg();
      await enableFeatures(org.orgId);
      try {
        const userId = await createScratchUser(org.orgId, "Receiving Clerk", "admin");
        await run(() => db.execute(sql\`update stock_locations set is_active = false where org_id = \${org.orgId} and code = 'STAGE'\`));
        const main = (await run(() => db.execute(sql\`
          select id from stock_locations where org_id = \${org.orgId} and code = 'MAIN'
        \`))).rows[0].id;
        const branchId = randomUUID();
        await run(() => db.execute(sql\`
          insert into subsidiaries (id, org_id, name, parent_id, base_currency, country, tax_ids, is_elimination, is_active, custom)
          values (\${branchId}, \${org.orgId}, 'Branch', \${org.subsidiaryId}, 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
        \`));
        const branchLocation = randomUUID();
        await run(() => db.execute(sql\`
          insert into locations (id, org_id, name, subsidiary_id, is_active, custom, subsidiary_include_children)
          values (\${branchLocation}, \${org.orgId}, 'Branch DC', \${branchId}, true, '{}'::jsonb, true)
        \`));
        const branchWarehouse = randomUUID();
        await run(() => db.execute(sql\`
          insert into stock_locations (id, org_id, location_id, code, kind, is_active)
          values (\${branchWarehouse}, \${org.orgId}, \${branchLocation}, 'BRANCH-WH', 'warehouse', true)
        \`));
        assert.equal(
          await resolveDefaultWarehouse(db, org.orgId, org.subsidiaryId),
          main,
          "the root entity sees only its own single warehouse",
        );
        await designate(org.orgId, null, main);
        await designate(org.orgId, branchId, branchWarehouse);
        assert.equal(
          await resolveDefaultWarehouse(db, org.orgId, branchId),
          branchWarehouse,
          "the entity row beats the company row",
        );
        assert.equal(
          await resolveDefaultWarehouse(db, org.orgId, org.subsidiaryId),
          main,
          "the root entity keeps the company row",
        );
        await run(() => db.execute(sql\`update stock_locations set is_active = false where org_id = \${org.orgId} and code = 'MAIN'\`));
        await assert.rejects(
          resolveDefaultWarehouse(db, org.orgId, org.subsidiaryId),
          /Setup → Warehouse defaults/,
          "a dead company designation fails closed instead of silently moving on",
        );
        await run(() => db.execute(sql\`delete from warehouse_defaults where org_id = \${org.orgId} and subsidiary_id is null\`));
        assert.equal(
          await resolveDefaultWarehouse(db, org.orgId, org.subsidiaryId),
          null,
          "the branch warehouse stays invisible to the root entity",
        );
        assert.equal(
          await resolveDefaultWarehouse(db, org.orgId, branchId),
          branchWarehouse,
          "the branch entity keeps resolving its own warehouse",
        );
      } finally {
        await dropScratchOrg(org.orgId);
      }
    }

    console.log("WAREHOUSE-DEFAULTS");
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
  assert.match(result.stdout, /WAREHOUSE-DEFAULTS/);
});
