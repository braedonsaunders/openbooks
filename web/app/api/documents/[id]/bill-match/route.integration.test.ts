import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { SessionUser } from "../../../../../lib/auth";

/**
 * A drawer-created bill for received stock gains its three-way match
 * after the fact: GET names each unmatched stocked line with its open
 * purchase-order lines and goods receipts, POST stamps the links, and the
 * matched bill posts through the actions route clearing received-not-billed.
 */
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __billMatchUser: state });
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: "data:text/javascript," + encodeURIComponent(source),
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next-intl/server")
      return virtual(
        'export async function getTranslations(){return (key)=>key}; export async function getLocale(){return "en"}',
      );
    if (
      (specifier === "./auth" || specifier.endsWith("/lib/auth")) &&
      context.parentURL?.endsWith("/web/lib/authz.ts")
    ) {
      return virtual("export async function currentUser(){return globalThis.__billMatchUser.user}");
    }
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { createOrderDraft, receivePurchaseOrder } = await import("@/lib/order-cycle.ts");
const { GET, POST } = await import("./route.ts");
const { POST: postAction } = await import("../../actions/route.ts");

const actorFor = (id: string, orgId: string): SessionUser => ({
  id,
  orgId,
  name: "AP clerk",
  email: "ap@scratch.test",
  roles: [],
  isSuperAdmin: false,
  envKind: "production",
  productionOrgId: orgId,
  homeOrgId: orgId,
  homeUserId: id,
});
const billMatch = (billId: string, init?: RequestInit) =>
  new Request(`http://probe.local/api/documents/${billId}/bill-match`, { method: "GET", ...init });
const postBill = (billId: string, body: unknown) =>
  new Request("http://probe.local/api/documents/actions", {
    method: "POST",
    body: JSON.stringify(body),
  });

async function seedMatchedShape(org: Awaited<ReturnType<typeof createScratchOrg>>, actor: string) {
  await withBypassContext(() =>
    db.execute(sql`update item_inventory_profiles set unit_conversions = '{"lb": 1}'::jsonb
      where org_id = ${org.orgId} and item_id in (${org.items.fifo}, ${org.items.movingAvg})`),
  );
  const po = await withOrgContext(org.orgId, () =>
    createOrderDraft(org.orgId, actor, "purchase_order", randomUUID(), null),
  );
  const sourceA = randomUUID();
  const sourceB = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, item_id, account_id, description, quantity, unit,
         unit_price, amount, tax_amount, quantity_fulfilled, quantity_billed, stock_location_id, custom)
      values
        (${sourceA}, ${org.orgId}, ${po.id}, 1, ${org.items.fifo}, ${org.accounts.invAsset},
         'Grain A', '2432', 'lb', '6', '14592', '0', '0', '0', ${org.stockLocationId}, '{}'::jsonb),
        (${sourceB}, ${org.orgId}, ${po.id}, 2, ${org.items.movingAvg}, ${org.accounts.invAsset},
         'Grain B', '2128', 'lb', '5', '10640', '0', '0', '0', ${org.stockLocationId}, '{}'::jsonb)`);
    await db.execute(sql`
      update documents set status = 'approved', party_id = ${org.vendorId}, subsidiary_id = ${org.subsidiaryId},
             document_date = ${org.date}, subtotal = '25232', total = '25232'
       where id = ${po.id} and org_id = ${org.orgId}`);
  });
  await withOrgContext(org.orgId, () =>
    receivePurchaseOrder(org.orgId, actor, po.id, {
      receiptDate: org.date,
      idempotencyKey: "m27-route-receipt",
      lines: [
        { sourceLineId: sourceA, quantity: "2432" },
        { sourceLineId: sourceB, quantity: "2128" },
      ],
    }),
  );
  const billId = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into documents (id, org_id, kind, document_number, party_id, document_date, due_date, currency,
                             status, subsidiary_id, subtotal, tax_total, total, custom, created_by)
      values (${billId}, ${org.orgId}, 'vendor_bill', 'BILL-M27-R', ${org.vendorId}, ${org.date}, ${org.date},
              'CAD', 'draft', ${org.subsidiaryId}, '26571.20', '0', '26571.20', '{}'::jsonb, ${actor})`);
    await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, item_id, account_id, description, quantity, unit,
         unit_price, amount, tax_amount, stock_location_id, custom)
      values
        (${randomUUID()}, ${org.orgId}, ${billId}, 1, ${org.items.fifo}, ${org.accounts.clearing},
         'Grain A', '2432', 'lb', '6.20', '15078.40', '0', ${org.stockLocationId}, '{}'::jsonb),
        (${randomUUID()}, ${org.orgId}, ${billId}, 2, ${org.items.movingAvg}, ${org.accounts.clearing},
         'Grain B', '2128', 'lb', '5.10', '10852.80', '0', ${org.stockLocationId}, '{}'::jsonb),
        (${randomUUID()}, ${org.orgId}, ${billId}, 3, null, ${org.accounts.invAsset},
         'Freight', '1', 'lot', '640', '640', '0', ${org.stockLocationId}, '{}'::jsonb)`);
  });
  return { billId, sourceA, sourceB };
}

test("bill-match candidates name the open order lines and their receipts", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() =>
      createScratchUser(org.orgId, "AP clerk", "ap_clerk"),
    );
    await withBypassContext(() =>
      db.execute(sql`update app_roles set permissions='["ap.read","ap.create","ap.post"]'::jsonb
      where org_id = ${org.orgId} and key = 'ap_clerk'`),
    );
    const { billId } = await seedMatchedShape(org, actor);
    state.user = actorFor(actor, org.orgId);
    const response = await withOrgContext(org.orgId, () =>
      GET(billMatch(billId), { params: Promise.resolve({ id: billId }) }),
    );
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const body = (await response.json()) as {
      lines: {
        lineNumber: number;
        candidates: {
          purchaseOrderLineNumber: number;
          billableQuantity: string;
          receipts: { documentNumber: string }[];
        }[];
      }[];
    };
    assert.equal(body.lines.length, 3);
    assert.equal(body.lines[0]!.candidates.length, 1);
    assert.equal(body.lines[0]!.candidates[0]!.purchaseOrderLineNumber, 1);
    assert.equal(body.lines[0]!.candidates[0]!.receipts.length, 1);
    assert.equal(body.lines[2]!.candidates.length, 0);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("bill-match links lines, refuses a second match, and the bill posts", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() =>
      createScratchUser(org.orgId, "AP clerk", "ap_clerk"),
    );
    await withBypassContext(() =>
      db.execute(sql`update app_roles set permissions='["ap.read","ap.create","ap.post"]'::jsonb
      where org_id = ${org.orgId} and key = 'ap_clerk'`),
    );
    const { billId, sourceA, sourceB } = await seedMatchedShape(org, actor);
    state.user = actorFor(actor, org.orgId);
    const lineIds = (
      await withBypassContext(() =>
        db.execute<{ id: string }>(
          sql`
      select id from document_lines where org_id = ${org.orgId} and document_id = ${billId} and line_number in (1, 2)
      order by line_number`,
          "objects",
        ),
      )
    ).map((row) => row.id);
    const matched = await withOrgContext(org.orgId, () =>
      POST(
        billMatch(billId, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            matches: [
              { billLineId: lineIds[0], purchaseOrderLineId: sourceA },
              { billLineId: lineIds[1], purchaseOrderLineId: sourceB },
            ],
          }),
        }),
        { params: Promise.resolve({ id: billId }) },
      ),
    );
    assert.equal(matched.status, 200, JSON.stringify(await matched.clone().json()));
    assert.equal(((await matched.json()) as { matched: unknown[] }).matched.length, 2);

    const again = await withOrgContext(org.orgId, () =>
      POST(
        billMatch(billId, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            matches: [{ billLineId: lineIds[0], purchaseOrderLineId: sourceA }],
          }),
        }),
        { params: Promise.resolve({ id: billId }) },
      ),
    );
    assert.equal(again.status, 422, JSON.stringify(await again.clone().json()));
    assert.match(((await again.json()) as { error: string }).error, /already matched/);

    await withBypassContext(() =>
      db.execute(sql`update documents set status = 'approved' where id = ${billId}`),
    );
    const posted = await withOrgContext(org.orgId, () =>
      postAction(postBill(billId, { action: "post", documentId: billId })),
    );
    assert.equal(posted.status, 200, JSON.stringify(await posted.clone().json()));
    const status = await withBypassContext(() =>
      db.execute<{ status: string }>(
        sql`
      select status from documents where id = ${billId}`,
        "objects",
      ),
    );
    assert.equal(status[0]!.status, "posted");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("bill-match refuses without the edit grant and on unknown bills", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() =>
      createScratchUser(org.orgId, "AP clerk", "ap_clerk"),
    );
    await withBypassContext(() =>
      db.execute(sql`update app_roles set permissions='["ap.read"]'::jsonb
      where org_id = ${org.orgId} and key = 'ap_clerk'`),
    );
    const { billId } = await seedMatchedShape(org, actor);
    state.user = actorFor(actor, org.orgId);
    const forbidden = await withOrgContext(org.orgId, () =>
      POST(
        billMatch(billId, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            matches: [{ billLineId: randomUUID(), purchaseOrderLineId: randomUUID() }],
          }),
        }),
        { params: Promise.resolve({ id: billId }) },
      ),
    );
    assert.equal(forbidden.status, 403);
    const missing = await withOrgContext(org.orgId, () =>
      GET(billMatch(randomUUID()), { params: Promise.resolve({ id: randomUUID() }) }),
    );
    assert.equal(missing.status, 404);
    const malformed = await withOrgContext(org.orgId, () =>
      GET(billMatch("nope"), { params: Promise.resolve({ id: "nope" }) }),
    );
    assert.equal(malformed.status, 404);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
