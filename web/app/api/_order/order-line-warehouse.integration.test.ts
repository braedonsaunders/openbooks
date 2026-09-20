import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// F-coord-004: approved orders predating the line warehouse picker carry
// NULL warehouses and are storage-immutable, so fulfillment failed closed
// with a generic kernel error and no way forward. Fulfillment now refuses
// up front naming the line (ORDER_LINE_WAREHOUSE_REQUIRED), and a narrow
// assign-warehouse writer sets the single column through the established
// reopen-restore pattern. A scratch org ships two active warehouses, so a
// NULL-warehouse line is the legacy trap exactly. Needs a fixture database.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withOrg } = await import("@openbooks/engine/src/platform/db.ts");
const { installTrustedTestDatabaseBypass } = await import("@openbooks/engine/src/testing/database-bypass.ts");
const { documentRevisionCounterSql } = await import("@openbooks/engine/src/records/revision.ts");
const { receiveInventory } = await import("@openbooks/engine/src/inventory/inventory.ts");
const {
  assignOrderLineWarehouse,
  createOrderDraft,
  fulfillSalesOrder,
  receivePurchaseOrder,
  ConversionError,
  ORDER_LINE_WAREHOUSE_REQUIRED,
} = await import("../../../lib/order-cycle.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

installTrustedTestDatabaseBypass();

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  org: Awaited<ReturnType<typeof createScratchOrg>>;
  userId: string;
  orderId: string;
  lineId: string;
}

async function approvedOrder(
  kind: "sales_order" | "purchase_order",
  itemId: (org: Fixture["org"]) => string,
  warehouse: ((org: Fixture["org"]) => string) | null,
): Promise<Fixture> {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Warehouse Clerk", "admin");
    const order = await withOrg(org.orgId, () => createOrderDraft(org.orgId, userId, kind));
    const lineId = randomUUID();
    await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, item_id, account_id,
         description, quantity, unit, unit_price, amount, tax_amount,
         quantity_fulfilled, quantity_billed, stock_location_id, custom)
      values
        (${lineId}, ${org.orgId}, ${order.id}, 1, ${itemId(org)},
         ${kind === "sales_order" ? org.accounts.revenue : org.accounts.invAsset},
         'Widget', '10', 'ea', '10', '100', '0',
         '0', '0', ${warehouse ? warehouse(org) : null}, '{}'::jsonb)
    `);
    await db.execute(sql`
      update documents
         set status = 'approved',
             party_id = ${kind === "sales_order" ? org.customerId : org.vendorId},
             subsidiary_id = ${org.subsidiaryId}, document_date = ${org.date},
             subtotal = '100', total = '100'
       where id = ${order.id} and org_id = ${org.orgId}
    `);
    return { org, userId, orderId: order.id, lineId };
  } catch (error) {
    await dropScratchOrg(org.orgId);
    throw error;
  }
}

async function revisionOf(orgId: string, orderId: string): Promise<string> {
  const row = (await db.execute<{ updated_at: string }>(sql`
    select ${documentRevisionCounterSql(sql`revision_seq`)} as updated_at
      from documents where id = ${orderId} and org_id = ${orgId}`)).rows[0]!;
  return row.updated_at;
}

async function drop(fixture: Fixture): Promise<void> {
  await dropScratchOrg(fixture.org.orgId);
}

function refusal(error: unknown, lineNumber: number): boolean {
  return (
    error instanceof ConversionError &&
    error.status === 422 &&
    error.code === ORDER_LINE_WAREHOUSE_REQUIRED &&
    error.details !== undefined &&
    (error.details as { lineNumber?: number }).lineNumber === lineNumber &&
    /assign a warehouse to the line/.test(error.message)
  );
}

test("fulfillment names the warehouseless line instead of failing generically", { skip: !DB }, async () => {
  const f = await approvedOrder("sales_order", (org) => org.items.fifo, null);
  try {
    await assert.rejects(
      withOrg(f.org.orgId, async () =>
        fulfillSalesOrder(f.org.orgId, f.userId, f.orderId, {
          fulfillmentDate: f.org.date,
          idempotencyKey: "legacy-null-warehouse",
          lines: [{ sourceLineId: f.lineId, quantity: "4" }],
        }),
      ),
      (error: unknown) => refusal(error, 1),
      "the refusal names line 1 with the typed code",
    );
    const leftovers = (await db.execute<{ fulfillments: number; fulfilled: string }>(sql`
      select (select count(*)::int from documents
               where org_id = ${f.org.orgId} and kind = 'sales_fulfillment') as fulfillments,
             (select quantity_fulfilled::text from document_lines where id = ${f.lineId}) as fulfilled`)).rows[0]!;
    assert.equal(leftovers.fulfillments, 0, "the refused fulfillment creates nothing");
    assert.equal(Number(leftovers.fulfilled), 0, "no shipment evidence advances");
  } finally {
    await drop(f);
  }
});

test("assignment unblocks fulfillment and routes stock to the assigned warehouse", { skip: !DB }, async () => {
  const f = await approvedOrder("sales_order", (org) => org.items.fifo, null);
  try {
    await withOrg(f.org.orgId, async () =>
      receiveInventory(f.org.orgId, f.userId, {
        itemId: f.org.items.fifo,
        stockLocationId: f.org.stockLocationId2,
        quantity: "10",
        unitCost: "2",
        subsidiaryId: f.org.subsidiaryId,
        offsetAccountId: f.org.accounts.clearing,
        date: f.org.date,
      }),
    );
    const assigned = await withOrg(f.org.orgId, async () =>
      assignOrderLineWarehouse({
        orgId: f.org.orgId,
        userId: f.userId,
        orderId: f.orderId,
        kind: "sales_order",
        lineId: f.lineId,
        stockLocationId: f.org.stockLocationId2,
        expectedUpdatedAt: await revisionOf(f.org.orgId, f.orderId),
      }),
    );
    assert.equal(assigned.stockLocationId, f.org.stockLocationId2);
    const shipped = await withOrg(f.org.orgId, async () =>
      fulfillSalesOrder(f.org.orgId, f.userId, f.orderId, {
        fulfillmentDate: f.org.date,
        idempotencyKey: "legacy-after-assign",
        lines: [{ sourceLineId: f.lineId, quantity: "10" }],
      }),
    );
    const facts = (await db.execute<{
      status: string;
      line_warehouse: string;
      movement_warehouse: string | null;
    }>(sql`
      select (select status from documents where id = ${f.orderId}) as status,
             (select stock_location_id from document_lines where id = ${f.lineId}) as line_warehouse,
             (select m.stock_location_id from inventory_movements m
                join document_lines fl on fl.id = m.document_line_id and fl.org_id = m.org_id
               where m.org_id = ${f.org.orgId} and fl.document_id = ${shipped.id}
                 and m.kind = 'issue' limit 1) as movement_warehouse`)).rows[0]!;
    assert.equal(facts.status, "approved", "the order stays approved throughout");
    assert.equal(facts.line_warehouse, f.org.stockLocationId2);
    assert.equal(facts.movement_warehouse, f.org.stockLocationId2, "the issue relieves the assigned warehouse");
    const audit = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from audit_log
       where org_id = ${f.org.orgId} and table_name = 'document_lines' and row_id = ${f.lineId}`)).rows[0]!;
    assert.equal(audit.n, 1, "the assignment is audited");
  } finally {
    await drop(f);
  }
});

test("a draft order stays on the normal edit path", { skip: !DB }, async () => {
  const f = await approvedOrder("sales_order", (org) => org.items.fifo, null);
  try {
    await db.execute(sql`update documents set status = 'draft' where id = ${f.orderId} and org_id = ${f.org.orgId}`);
    await assert.rejects(
      withOrg(f.org.orgId, async () =>
        assignOrderLineWarehouse({
          orgId: f.org.orgId,
          userId: f.userId,
          orderId: f.orderId,
          kind: "sales_order",
          lineId: f.lineId,
          stockLocationId: f.org.stockLocationId,
          expectedUpdatedAt: await revisionOf(f.org.orgId, f.orderId),
        }),
      ),
      /still a draft/,
    );
  } finally {
    await drop(f);
  }
});

test("a warehouse does not apply to a non-stocked line", { skip: !DB }, async () => {
  const f = await approvedOrder("sales_order", (org) => org.items.service, null);
  try {
    await assert.rejects(
      withOrg(f.org.orgId, async () =>
        assignOrderLineWarehouse({
          orgId: f.org.orgId,
          userId: f.userId,
          orderId: f.orderId,
          kind: "sales_order",
          lineId: f.lineId,
          stockLocationId: f.org.stockLocationId,
          expectedUpdatedAt: await revisionOf(f.org.orgId, f.orderId),
        }),
      ),
      /not a stocked item/,
    );
  } finally {
    await drop(f);
  }
});

test("an inactive warehouse is refused", { skip: !DB }, async () => {
  const f = await approvedOrder("sales_order", (org) => org.items.fifo, null);
  try {
    await db.execute(sql`update stock_locations set is_active = false
      where id = ${f.org.stockLocationId2} and org_id = ${f.org.orgId}`);
    await assert.rejects(
      withOrg(f.org.orgId, async () =>
        assignOrderLineWarehouse({
          orgId: f.org.orgId,
          userId: f.userId,
          orderId: f.orderId,
          kind: "sales_order",
          lineId: f.lineId,
          stockLocationId: f.org.stockLocationId2,
          expectedUpdatedAt: await revisionOf(f.org.orgId, f.orderId),
        }),
      ),
      /not an active warehouse/,
    );
  } finally {
    await drop(f);
  }
});

test("a stale revision is refused before any write", { skip: !DB }, async () => {
  const f = await approvedOrder("sales_order", (org) => org.items.fifo, null);
  try {
    await assert.rejects(
      withOrg(f.org.orgId, async () =>
        assignOrderLineWarehouse({
          orgId: f.org.orgId,
          userId: f.userId,
          orderId: f.orderId,
          kind: "sales_order",
          lineId: f.lineId,
          stockLocationId: f.org.stockLocationId,
          expectedUpdatedAt: "stale-token",
        }),
      ),
      /changed after you opened it/,
    );
    const line = (await db.execute<{ stock_location_id: string | null }>(sql`
      select stock_location_id from document_lines where id = ${f.lineId}`)).rows[0]!;
    assert.equal(line.stock_location_id, null, "the refused assignment writes nothing");
  } finally {
    await drop(f);
  }
});

test("receipt names the warehouseless purchase-order line", { skip: !DB }, async () => {
  const f = await approvedOrder("purchase_order", (org) => org.items.fifo, null);
  try {
    await assert.rejects(
      withOrg(f.org.orgId, async () =>
        receivePurchaseOrder(f.org.orgId, f.userId, f.orderId, {
          receiptDate: f.org.date,
          idempotencyKey: "legacy-po-null-warehouse",
          lines: [{ sourceLineId: f.lineId, quantity: "4" }],
        }),
      ),
      (error: unknown) => refusal(error, 1),
      "the receipt refusal names line 1 with the typed code",
    );
  } finally {
    await drop(f);
  }
});
