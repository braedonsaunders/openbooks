import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

// GET /api/v1/inventory/available — on hand, committed and available from
// the availability engine, plus incoming from approved purchase orders.
const { db, withBypassContext, withOrgContext } = await import(
  "@openbooks/engine/src/platform/db.ts"
);
const { sql } = await import("drizzle-orm");
const { toUnits } = await import("@openbooks/engine/src/money/money.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { receiveInventory } = await import("@openbooks/engine/src/inventory/movements.ts");
const { generateApiKey } = await import("../../../../../lib/api-auth.ts");
const { v1CreateOrder, v1IssueOrder } = await import("../../../../../lib/api/v1-orders.ts");
const { GET } = await import("./route.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

interface Setup {
  orgId: string;
  subsidiaryId: string;
  date: string;
  customerId: string;
  vendorId: string;
  itemId: string;
  itemCode: string;
  warehouseId: string;
  clearingAccountId: string;
  key: string;
  actor: string;
}

async function setup(): Promise<Setup> {
  const org = await withBypassContext(() => createScratchOrg());
  await withBypassContext(() => db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features', '{}'::jsonb)
        || '{"orders":true,"warehousing":true,"fulfillment":true,"apiAccess":true}'::jsonb)
    where id = ${org.orgId}`));
  const actor = await withBypassContext(() => createScratchUser(org.orgId, "Api", "api_owner"));
  await withBypassContext(() => db.execute(sql`
    update app_roles set permissions = '["*"]'::jsonb where org_id = ${org.orgId} and key = 'api_owner'`));
  const generated = generateApiKey();
  await withBypassContext(() => db.execute(sql`
    insert into api_keys (org_id, user_id, name, key_prefix, key_hash, key_preview, scopes, is_active)
    values (${org.orgId}, ${actor}, 'available test', ${generated.keyPrefix}, ${generated.keyHash},
            ${generated.keyPreview}, '["items.read","ar.create","ar.read"]'::jsonb, true)`));
  const code = `WID-${randomUUID().slice(0, 8)}`;
  await withBypassContext(() => db.execute(sql`
    update items set code = ${code} where id = ${org.items.fifo} and org_id = ${org.orgId}`));
  return {
    orgId: org.orgId,
    subsidiaryId: org.subsidiaryId,
    date: org.date,
    customerId: org.customerId,
    vendorId: org.vendorId,
    itemId: org.items.fifo,
    itemCode: code,
    warehouseId: org.stockLocationId,
    clearingAccountId: org.accounts.clearing,
    key: generated.plaintext,
    actor,
  };
}

function jsonRequest(method: string, path: string, key: string, idempotencyKey: string, body: unknown): Request {
  return new Request(`http://openbooks.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

async function seed(supply: Setup): Promise<void> {
  // Ten on hand at the main warehouse.
  await withBypassContext(() =>
    receiveInventory(supply.orgId, supply.actor, {
      itemId: supply.itemId,
      stockLocationId: supply.warehouseId,
      quantity: "10",
      unitCost: "2",
      subsidiaryId: supply.subsidiaryId,
      offsetAccountId: supply.clearingAccountId,
      date: supply.date,
    }),
  );
  // Three committed through a storefront-issued order.
  const key = `avail-${randomUUID()}`;
  const created = await withOrgContext(supply.orgId, () =>
    v1CreateOrder(
      jsonRequest("POST", "/api/v1/sales-orders", supply.key, key, {
        customer: { id: supply.customerId },
        subsidiaryId: supply.subsidiaryId,
        documentDate: supply.date,
        lines: [{ itemId: supply.itemId, quantity: "3", unitPrice: "9.99", stockLocationId: supply.warehouseId }],
      }),
      "sales-orders",
    ),
  );
  const createdBody = (await created.json()) as { id: string; expectedUpdatedAt: string };
  assert.equal(created.status, 201, JSON.stringify(createdBody));
  const issued = await withOrgContext(supply.orgId, () =>
    v1IssueOrder(
      jsonRequest("POST", `/api/v1/sales-orders/${createdBody.id}/issue`, supply.key, `${key}-issue`, {
        expectedUpdatedAt: createdBody.expectedUpdatedAt,
      }),
      "sales-orders",
      createdBody.id,
    ),
  );
  const issuedBody = (await issued.json()) as Record<string, unknown>;
  assert.equal(issued.status, 200, JSON.stringify(issuedBody));
  // Five incoming on an approved purchase order.
  const poId = randomUUID();
  const lineId = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into documents (id, org_id, kind, document_number, party_id, document_date, currency, status, subsidiary_id)
    values (${poId}, ${supply.orgId}, 'purchase_order', ${`PO-${randomUUID().slice(0, 8)}`}, ${supply.vendorId}, ${supply.date}, 'CAD', 'draft', ${supply.subsidiaryId})`));
  await withBypassContext(() => db.execute(sql`
    insert into document_lines (id, org_id, document_id, line_number, item_id, description, quantity, unit,
                                unit_price, amount, tax_amount, stock_location_id, custom)
    values (${lineId}, ${supply.orgId}, ${poId}, 1, ${supply.itemId}, 'Widget', '5', 'ea',
            '4', '20', '0', ${supply.warehouseId}, '{}'::jsonb)`));
  await withBypassContext(() => db.execute(sql`
    update documents set status = 'approved' where id = ${poId} and org_id = ${supply.orgId}`));
}

async function getAvailable(
  supply: Setup,
  query: string,
): Promise<{ status: number; json: { subsidiaryId: string; rows: Array<Record<string, unknown>> } }> {
  const response = await withOrgContext(supply.orgId, () =>
    GET(
      new Request(`http://openbooks.test/api/v1/inventory/available${query}`, {
        headers: { authorization: `Bearer ${supply.key}` },
      }),
    ),
  );
  return { status: response.status, json: (await response.json()) as never };
}

test("available equals on hand minus committed, with incoming on order", { skip: !DB }, async () => {
  const supply = await setup();
  try {
    await seed(supply);
    const { status, json } = await getAvailable(supply, `?itemCode=${supply.itemCode}`);
    assert.equal(status, 200, JSON.stringify(json));
    assert.equal(json.rows.length, 1);
    const row = json.rows[0]!;
    assert.equal(row.itemId, supply.itemId);
    assert.equal(row.itemCode, supply.itemCode);
    assert.equal(row.baseUnit, "ea");
    assert.equal(toUnits(String(row.onHand)), toUnits("10"));
    assert.equal(toUnits(String(row.committed)), toUnits("3"));
    assert.equal(toUnits(String(row.available)), toUnits("7"));
    assert.equal(toUnits(String(row.incoming)), toUnits("5"));

    // The warehouse filter scopes to one row carrying its warehouse.
    const scoped = await getAvailable(supply, `?itemCode=${supply.itemCode}&locationId=${supply.warehouseId}`);
    assert.equal(scoped.status, 200, JSON.stringify(scoped.json));
    assert.equal(scoped.json.rows.length, 1);
    assert.equal(scoped.json.rows[0]!.warehouseId, supply.warehouseId);
    assert.equal(toUnits(String(scoped.json.rows[0]!.incoming)), toUnits("5"));

    // An unknown code is refused by name, never an empty list.
    const unknown = await getAvailable(supply, "?itemCode=NOPE-1");
    assert.equal(unknown.status, 422, JSON.stringify(unknown.json));

    // changedSince bounds the sync on the item's revision timestamp.
    await withBypassContext(() => db.execute(sql`
      update items set updated_at = '2020-01-01T00:00:00Z' where id = ${supply.itemId}`));
    const stale = await getAvailable(supply, `?itemCode=${supply.itemCode}&changedSince=2026-01-01T00:00:00Z`);
    assert.equal(stale.status, 200, JSON.stringify(stale.json));
    assert.equal(stale.json.rows.length, 0);
    const fresh = await getAvailable(supply, `?itemCode=${supply.itemCode}&changedSince=2019-01-01T00:00:00Z`);
    assert.equal(fresh.json.rows.length, 1);
  } finally {
    await withBypassContext(() => dropScratchOrg(supply.orgId));
  }
});
