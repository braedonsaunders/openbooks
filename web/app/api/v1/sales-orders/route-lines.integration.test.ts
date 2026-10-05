import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

// Full order create through POST /api/v1/sales-orders, line replacement, and
// issue — the same drawer writer end to end, with the storefront dedupe key.
const { db, withBypassContext, withOrgContext } = await import(
  "@openbooks/engine/src/platform/db.ts"
);
const { sql } = await import("drizzle-orm");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { generateApiKey } = await import("../../../../lib/api-auth.ts");
const { v1CreateOrder, v1IssueOrder, v1ReplaceOrderLines } = await import(
  "../../../../lib/api/v1-orders.ts"
);
const { createApplicationOrder } = await import("../../../../lib/application/orders.ts");
const { applyOrderEdit } = await import("../../../../lib/order-draft-edit.ts");
const { orderEditServices } = await import("../../_order/handlers.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

interface Setup {
  orgId: string;
  subsidiaryId: string;
  date: string;
  customerId: string;
  itemId: string;
  itemCode: string;
  revenueAccountId: string;
  key: string;
}

async function setup(): Promise<Setup> {
  const org = await withBypassContext(() => createScratchOrg());
  await withBypassContext(() => db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"orders":true,"apiAccess":true}'::jsonb)
    where id = ${org.orgId}`));
  const actor = await withBypassContext(() => createScratchUser(org.orgId, "Api", "api_owner"));
  await withBypassContext(() => db.execute(sql`
    update app_roles set permissions = '["*"]'::jsonb where org_id = ${org.orgId} and key = 'api_owner'`));
  const generated = generateApiKey();
  await withBypassContext(() => db.execute(sql`
    insert into api_keys (org_id, user_id, name, key_prefix, key_hash, key_preview, scopes, is_active)
    values (${org.orgId}, ${actor}, 'route lines test', ${generated.keyPrefix}, ${generated.keyHash},
            ${generated.keyPreview}, '["ar.create","ar.read","parties.manage","parties.read","items.read"]'::jsonb, true)`));
  const code = `SVC-${randomUUID().slice(0, 8)}`;
  await withBypassContext(() => db.execute(sql`
    update items set code = ${code} where id = ${org.items.service} and org_id = ${org.orgId}`));
  const item = (await withBypassContext(() => db.execute<{ id: string; code: string | null }>(sql`
    select id, code from items where id = ${org.items.service} and org_id = ${org.orgId}`))).rows[0]!;
  assert.equal(item.code, code, "the scratch service item takes a code");
  return {
    orgId: org.orgId,
    subsidiaryId: org.subsidiaryId,
    date: org.date,
    customerId: org.customerId,
    itemId: item.id,
    itemCode: item.code!,
    revenueAccountId: org.accounts.revenue,
    key: generated.plaintext,
  };
}

async function teardown(orgId: string): Promise<void> {
  await withBypassContext(() => dropScratchOrg(orgId));
}

function request(
  method: string,
  path: string,
  key: string,
  idempotencyKey: string,
  body: unknown,
): Request {
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

async function callV1(
  orgId: string,
  fn: (request: Request) => Promise<Response>,
  req: Request,
): Promise<{ status: number; replayed: string | null; json: Record<string, unknown> }> {
  const response = await withOrgContext(orgId, () => fn(req));
  const json = (await response.json()) as Record<string, unknown>;
  return { status: response.status, replayed: response.headers.get("idempotency-replayed"), json };
}

function fullBody(setup: Setup, ref: string) {
  return {
    customer: { id: setup.customerId },
    documentDate: setup.date,
    currency: "CAD",
    lines: [{ itemCode: setup.itemCode, quantity: "2", unitPrice: "19.99", discountPercent: "10" }],
    shippingLines: [{ accountId: setup.revenueAccountId, description: "Freight", amount: "5.00" }],
    externalRef: ref,
    externalSource: "shopify",
  };
}

test("full order create posts the drawer's totals and lines", { skip: !DB }, async () => {
  const fixture = await setup();
  try {
    const ref = `SO-${randomUUID().slice(0, 8)}`;
    const created = await callV1(
      fixture.orgId,
      (req) => v1CreateOrder(req, "sales-orders"),
      request("POST", "/api/v1/sales-orders", fixture.key, `full-${ref}`, fullBody(fixture, ref)),
    );
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const result = created.json as {
      id: string;
      documentNumber: string;
      expectedUpdatedAt: string;
      total: string;
      subtotal: string;
      taxTotal: string;
      lines: Array<Record<string, unknown>>;
    };
    assert.match(result.id, /^[0-9a-f-]{36}$/);
    assert.match(result.documentNumber, /^SO-/);
    assert.match(result.expectedUpdatedAt, /^\d{1,20}$/, "the create returns the revision token");
    assert.equal(result.lines.length, 2);

    // The same commercial intent through the drawer's own writer, priced at
    // the net the discount maps to: totals and line amounts must agree.
    const actor = await withBypassContext(() => createScratchUser(fixture.orgId, "Drawer", "drawer_probe"));
    const draft = await withOrgContext(fixture.orgId, () =>
      createApplicationOrder(
        {
          authz: {
            user: {
              id: actor,
              orgId: fixture.orgId,
              name: "Drawer",
              email: "drawer@scratch.test",
              roles: [],
              isSuperAdmin: false,
              envKind: "production",
              productionOrgId: fixture.orgId,
              homeOrgId: fixture.orgId,
              homeUserId: actor,
            },
            permissions: new Set(["ar.create"]),
            allowedSubsidiaryIds: null,
          },
          source: "api",
          requestId: randomUUID(),
          apiKeyId: null,
        },
        { kind: "sales_order", idempotencyKey: `drawer-${ref}`, subsidiaryId: fixture.subsidiaryId },
      ),
    );
    const token = (await withBypassContext(() => db.execute<{ t: string }>(sql`
      select revision_seq::text as t from documents where id = ${draft.result.id}`))).rows[0]!.t;
    const drawer = await withOrgContext(fixture.orgId, () =>
      applyOrderEdit(
        {
          orgId: fixture.orgId,
          userId: actor,
          user: {
            id: actor,
            orgId: fixture.orgId,
            name: "Drawer",
            email: "drawer@scratch.test",
            roles: [],
            isSuperAdmin: false,
            envKind: "production",
            productionOrgId: fixture.orgId,
            homeOrgId: fixture.orgId,
            homeUserId: actor,
          },
          allowedSubsidiaryIds: null,
          permissions: new Set(["ar.create"]),
          services: orderEditServices,
        },
        { kind: "sales_order", readPerm: "ar.read", createPerm: "ar.create" },
        draft.result.id,
        {
          expectedUpdatedAt: token,
          partyId: fixture.customerId,
          documentDate: fixture.date,
          lines: [
            { itemId: fixture.itemId, quantity: "2", unitPrice: "17.991" },
            { accountId: fixture.revenueAccountId, description: "Freight", quantity: "1", unitPrice: "5" },
          ],
        },
      ),
    );
    assert.equal(drawer.status, 200);
    const drawerBody = (await drawer.json()) as { doc: Record<string, unknown>; lines: Array<Record<string, unknown>> };
    assert.equal(result.total, String(drawerBody.doc.total));
    assert.equal(result.subtotal, String(drawerBody.doc.subtotal));
    assert.equal(result.taxTotal, String(drawerBody.doc.tax_total));
    assert.deepEqual(
      result.lines.map((line) => String(line.amount)),
      drawerBody.lines.map((line) => String(line.amount)),
    );

    // The dedupe key landed on the stored row.
    const stored = (await withBypassContext(() => db.execute<{ external_ref: string | null; external_source: string | null; status: string }>(sql`
      select external_ref, external_source, status from documents
       where id = ${result.id} and org_id = ${fixture.orgId}`))).rows[0];
    assert.equal(stored?.external_ref, ref);
    assert.equal(stored?.external_source, "shopify");
    assert.equal(stored?.status, "draft");
  } finally {
    await teardown(fixture.orgId);
  }
});

test("idempotency replay returns the same order", { skip: !DB }, async () => {
  const fixture = await setup();
  try {
    const ref = `SO-${randomUUID().slice(0, 8)}`;
    const first = await callV1(
      fixture.orgId,
      (req) => v1CreateOrder(req, "sales-orders"),
      request("POST", "/api/v1/sales-orders", fixture.key, `replay-${ref}`, fullBody(fixture, ref)),
    );
    assert.equal(first.status, 201);
    const second = await callV1(
      fixture.orgId,
      (req) => v1CreateOrder(req, "sales-orders"),
      request("POST", "/api/v1/sales-orders", fixture.key, `replay-${ref}`, fullBody(fixture, ref)),
    );
    assert.equal(second.status, 201);
    assert.equal(second.json.id, first.json.id);
    assert.equal(second.replayed, "true");
  } finally {
    await teardown(fixture.orgId);
  }
});

test("a duplicate external reference returns 409 with the existing id", { skip: !DB }, async () => {
  const fixture = await setup();
  try {
    const ref = `SO-${randomUUID().slice(0, 8)}`;
    const first = await callV1(
      fixture.orgId,
      (req) => v1CreateOrder(req, "sales-orders"),
      request("POST", "/api/v1/sales-orders", fixture.key, `dup-a-${ref}`, fullBody(fixture, ref)),
    );
    assert.equal(first.status, 201);
    const second = await callV1(
      fixture.orgId,
      (req) => v1CreateOrder(req, "sales-orders"),
      request("POST", "/api/v1/sales-orders", fixture.key, `dup-b-${ref}`, fullBody(fixture, ref)),
    );
    assert.equal(second.status, 409, JSON.stringify(second.json));
    assert.equal(
      (second.json.details as { existingId?: string } | undefined)?.existingId,
      first.json.id,
    );
    const count = (await withBypassContext(() => db.execute<{ n: string }>(sql`
      select count(*)::text as n from documents
       where org_id = ${fixture.orgId} and external_source = 'shopify' and external_ref = ${ref}`))).rows[0]!.n;
    assert.equal(count, "1");
  } finally {
    await teardown(fixture.orgId);
  }
});

test("an ambiguous decimal is refused naming both readings", { skip: !DB }, async () => {
  const fixture = await setup();
  try {
    const ref = `SO-${randomUUID().slice(0, 8)}`;
    const body = fullBody(fixture, ref);
    body.lines[0]!.quantity = "1,234";
    const refused = await callV1(
      fixture.orgId,
      (req) => v1CreateOrder(req, "sales-orders"),
      request("POST", "/api/v1/sales-orders", fixture.key, `amb-${ref}`, body),
    );
    assert.equal(refused.status, 422, JSON.stringify(refused.json));
    assert.match(String(refused.json.message), /thousands separator/);
    assert.match(String(refused.json.message), /decimal comma/);
  } finally {
    await teardown(fixture.orgId);
  }
});

test("an unknown item code is refused by name", { skip: !DB }, async () => {
  const fixture = await setup();
  try {
    const ref = `SO-${randomUUID().slice(0, 8)}`;
    const body = fullBody(fixture, ref);
    body.lines[0]!.itemCode = "NOPE-1";
    const refused = await callV1(
      fixture.orgId,
      (req) => v1CreateOrder(req, "sales-orders"),
      request("POST", "/api/v1/sales-orders", fixture.key, `code-${ref}`, body),
    );
    assert.equal(refused.status, 422, JSON.stringify(refused.json));
    assert.match(String(refused.json.message), /NOPE-1.*not found in this organization/);
  } finally {
    await teardown(fixture.orgId);
  }
});

test("lines replace and issue drive a draft to issued", { skip: !DB }, async () => {
  const fixture = await setup();
  try {
    const ref = `SO-${randomUUID().slice(0, 8)}`;
    const created = await callV1(
      fixture.orgId,
      (req) => v1CreateOrder(req, "sales-orders"),
      request("POST", "/api/v1/sales-orders", fixture.key, `cycle-${ref}`, fullBody(fixture, ref)),
    );
    assert.equal(created.status, 201);
    const id = String(created.json.id);
    const token = String(created.json.expectedUpdatedAt);

    const replaced = await callV1(
      fixture.orgId,
      (req) => v1ReplaceOrderLines(req, "sales-orders", id),
      request(
        "PATCH",
        `/api/v1/sales-orders/${id}/lines`,
        fixture.key,
        `lines-${ref}`,
        {
          expectedUpdatedAt: token,
          lines: [{ itemCode: fixture.itemCode, quantity: "1", unitPrice: "10.00" }],
        },
      ),
    );
    assert.equal(replaced.status, 200, JSON.stringify(replaced.json));
    const nextToken = String(replaced.json.expectedUpdatedAt);
    assert.notEqual(nextToken, token);
    assert.equal((replaced.json.lines as unknown[]).length, 1);

    const stale = await callV1(
      fixture.orgId,
      (req) => v1ReplaceOrderLines(req, "sales-orders", id),
      request(
        "PATCH",
        `/api/v1/sales-orders/${id}/lines`,
        fixture.key,
        `stale-${ref}`,
        { expectedUpdatedAt: token, lines: [] },
      ),
    );
    assert.equal(stale.status, 409, JSON.stringify(stale.json));

    const issued = await callV1(
      fixture.orgId,
      (req) => v1IssueOrder(req, "sales-orders", id),
      request(
        "POST",
        `/api/v1/sales-orders/${id}/issue`,
        fixture.key,
        `issue-${ref}`,
        { expectedUpdatedAt: nextToken },
      ),
    );
    assert.equal(issued.status, 200, JSON.stringify(issued.json));
    assert.equal(issued.json.status, "approved");
    const status = (await withBypassContext(() => db.execute<{ status: string }>(sql`
      select status from documents where id = ${id} and org_id = ${fixture.orgId}`))).rows[0]!.status;
    assert.equal(status, "approved");

    const currentToken = (await withBypassContext(() => db.execute<{ t: string }>(sql`
      select revision_seq::text as t from documents where id = ${id}`))).rows[0]!.t;
    assert.equal(String(issued.json.expectedUpdatedAt), currentToken);
    const reissued = await callV1(
      fixture.orgId,
      (req) => v1IssueOrder(req, "sales-orders", id),
      request(
        "POST",
        `/api/v1/sales-orders/${id}/issue`,
        fixture.key,
        `reissue-${ref}`,
        { expectedUpdatedAt: currentToken },
      ),
    );
    assert.equal(reissued.status, 422, JSON.stringify(reissued.json));
    assert.match(String(reissued.json.message), /only a draft can be issued/);
  } finally {
    await teardown(fixture.orgId);
  }
});
