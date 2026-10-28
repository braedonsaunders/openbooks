import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-orders-lib-test");
interface RouteState {
  created: Array<Record<string, unknown>>;
  full: Array<Record<string, unknown>>;
  replaced: Array<Record<string, unknown>>;
  issued: Array<Record<string, unknown>>;
  converted: Array<Record<string, unknown>>;
  listed: string[];
  got: Array<{ typeKey: string; id: string }>;
}
const routeState: RouteState = {
  created: [],
  full: [],
  replaced: [],
  issued: [],
  converted: [],
  listed: [],
  got: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:v1",
    `
      export async function withV1Request(request, label, operation) {
        const result = await operation(
          { user: { orgId: "org-1" }, keyId: "key-1" },
          { authz: { user: { orgId: "org-1" } } },
        )
        return Response.json(result.body, { status: result.status })
      }
      export async function readV1JsonObject(request) { return await request.json() }
      export function requireV1IdempotencyKey(request) {
        const key = request.headers.get("idempotency-key")?.trim()
        if (!key) throw new Error("Idempotency-Key header is required")
        return key
      }
    `,
  ],
  [
    "mock:errors",
    `
      export class ApplicationError extends Error {
        constructor(code, message, status, details) { super(message); this.code = code; this.status = status; this.details = details }
      }
      export function invalidInput(message) { throw new Error(message) }
      export function notFound(resource) { throw new Error("not_found:" + resource) }
    `,
  ],
  [
    "mock:orders",
    `
      const state = globalThis[Symbol.for('openbooks.v1-orders-lib-test')]
      export const ORDER_TYPE_KIND = {
        quotes: "quote",
        "sales-orders": "sales_order",
        "purchase-orders": "purchase_order",
      }
      export async function createApplicationOrder(_context, input) {
        state.created.push(input)
        return { replayed: false, result: { id: "order-1", documentNumber: "Q-1" } }
      }
      export async function createFullApplicationOrder(_context, input) {
        state.full.push(input)
        return { replayed: false, result: { id: "order-full", documentNumber: "SO-9" } }
      }
      export async function replaceApplicationOrderLines(_context, input) {
        state.replaced.push(input)
        return { result: { id: input.documentId, documentNumber: "SO-9" } }
      }
      export async function issueApplicationOrder(_context, input) {
        state.issued.push(input)
        return { status: 200, result: { id: input.documentId, documentNumber: "SO-9", status: "approved" } }
      }
      export async function convertApplicationOrder(_context, input) {
        state.converted.push(input)
        return { replayed: false, result: { id: "order-2", documentNumber: "SO-1", kind: input.targetKind } }
      }
    `,
  ],
  [
    "mock:application-records",
    `
      const state = globalThis[Symbol.for('openbooks.v1-orders-lib-test')]
      export async function createApplicationRecord(_context, input) {
        state.created.push(input)
        return { replayed: false, status: 201, result: { id: "order-1", documentNumber: "Q-1" } }
      }
    `,
  ],
  [
    "mock:records",
    `
      const state = globalThis[Symbol.for('openbooks.v1-orders-lib-test')]
      export async function v1ListRecords(_request, typeKey) {
        state.listed.push(typeKey)
        return Response.json({ typeKey })
      }
      export async function v1GetRecord(_request, typeKey, id) {
        state.got.push({ typeKey, id })
        return Response.json({ typeKey, id })
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["./v1-request", "mock:v1"],
  ["../application/errors", "mock:errors"],
  ["../application/orders", "mock:orders"],
  ["./v1-records", "mock:records"],
  ["../application/records", "mock:application-records"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const {
  v1CreateOrder,
  v1ConvertOrder,
  v1ListOrders,
  v1GetOrder,
  v1ReplaceOrderLines,
  v1IssueOrder,
} = await import("./v1-orders.ts");
hooks.deregister();

test("v1CreateOrder creates through the shared record writer with only the subsidiary", async () => {
  routeState.created = [];
  const response = await v1CreateOrder(
    new Request("http://openbooks.test/api/v1/quotes", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "key-1" },
      body: "{}",
    }),
    "quotes",
  );
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: "order-1", documentNumber: "Q-1" });
  assert.deepEqual(routeState.created, [
    { typeKey: "quotes", body: { subsidiaryId: null }, idempotencyKey: "key-1" },
  ]);
});

test("v1CreateOrder keeps the purchase-orders record key", async () => {
  routeState.created = [];
  await v1CreateOrder(
    new Request("http://openbooks.test/api/v1/purchase-orders", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "key-2" },
      body: JSON.stringify({ memo: "ignored for an empty draft" }),
    }),
    "purchase-orders",
  );
  assert.deepEqual(routeState.created[0], {
    typeKey: "purchase-orders",
    body: { subsidiaryId: null },
    idempotencyKey: "key-2",
  });
});

test("v1CreateOrder forwards an explicit subsidiaryId in either spelling", async () => {
  routeState.created = [];
  for (const body of [
    { subsidiaryId: "11111111-1111-4111-8111-111111111111" },
    { subsidiary_id: "11111111-1111-4111-8111-111111111111" },
  ]) {
    await v1CreateOrder(
      new Request("http://openbooks.test/api/v1/purchase-orders", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "key-sub" },
        body: JSON.stringify(body),
      }),
      "purchase-orders",
    );
  }
  assert.deepEqual(
    routeState.created.map((input) => input.body),
    [
      { subsidiaryId: "11111111-1111-4111-8111-111111111111" },
      { subsidiaryId: "11111111-1111-4111-8111-111111111111" },
    ],
  );
});

test("v1ConvertOrder refuses a missing targetKind with the allowed targets", async () => {
  routeState.converted = [];
  await assert.rejects(
    () =>
      v1ConvertOrder(
        new Request("http://openbooks.test/api/v1/quotes/q1/convert", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": "key-3" },
          body: "{}",
        }),
        "quotes",
        "q1",
      ),
    /sales_order or customer_invoice/,
  );
  assert.equal(routeState.converted.length, 0);
});

test("v1ConvertOrder forwards the path id and targetKind", async () => {
  routeState.converted = [];
  const response = await v1ConvertOrder(
    new Request("http://openbooks.test/api/v1/quotes/q1/convert", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "key-4" },
      body: JSON.stringify({ targetKind: "sales_order", expectedUpdatedAt: "rev-1" }),
    }),
    "quotes",
    "q1",
  );
  assert.equal(response.status, 201);
  assert.deepEqual(routeState.converted, [
    {
      documentId: "q1",
      targetKind: "sales_order",
      expectedUpdatedAt: "rev-1",
      creditOverrideReason: undefined,
      idempotencyKey: "key-4",
      expectedKind: "quote",
    },
  ]);
});

test("v1ConvertOrder binds the route kind so a sibling-kind id cannot convert", async () => {
  routeState.converted = [];
  await v1ConvertOrder(
    new Request("http://openbooks.test/api/v1/purchase-orders/po-1/convert", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "key-5" },
      body: JSON.stringify({ targetKind: "vendor_bill", expectedUpdatedAt: "rev-2" }),
    }),
    "purchase-orders",
    "po-1",
  );
  assert.equal(routeState.converted[0]?.expectedKind, "purchase_order");
  assert.equal(routeState.converted[0]?.documentId, "po-1");
});

test("v1CreateOrder passes a sales-order body through whole for the full-order path", async () => {
  routeState.created = [];
  const body = {
    customer: { id: "11111111-1111-4111-8111-111111111111" },
    lines: [{ itemCode: "WIDGET", quantity: "2", unitPrice: "19.99" }],
    externalRef: "EXT-1",
    externalSource: "shopify",
  };
  const response = await v1CreateOrder(
    new Request("http://openbooks.test/api/v1/sales-orders", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "key-full" },
      body: JSON.stringify(body),
    }),
    "sales-orders",
  );
  assert.equal(response.status, 201);
  assert.deepEqual(routeState.created, [
    { typeKey: "sales-orders", body, idempotencyKey: "key-full" },
  ]);
});

test("v1CreateOrder sends a content-free sales-orders body unchanged", async () => {
  routeState.created = [];
  await v1CreateOrder(
    new Request("http://openbooks.test/api/v1/sales-orders", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "key-empty" },
      body: "{}",
    }),
    "sales-orders",
  );
  assert.deepEqual(routeState.created, [
    { typeKey: "sales-orders", body: {}, idempotencyKey: "key-empty" },
  ]);
});

test("v1ReplaceOrderLines forwards the path id and revision token", async () => {
  routeState.replaced = [];
  const response = await v1ReplaceOrderLines(
    new Request("http://openbooks.test/api/v1/sales-orders/so-1/lines", {
      method: "PATCH",
      headers: { "content-type": "application/json", "idempotency-key": "key-lines" },
      body: JSON.stringify({ expectedUpdatedAt: "42", lines: [] }),
    }),
    "sales-orders",
    "so-1",
  );
  assert.equal(response.status, 200);
  assert.deepEqual(routeState.replaced, [
    {
      documentId: "so-1",
      expectedUpdatedAt: "42",
      lines: [],
      shippingLines: undefined,
    },
  ]);
});

test("v1IssueOrder forwards the path id and revision token", async () => {
  routeState.issued = [];
  const response = await v1IssueOrder(
    new Request("http://openbooks.test/api/v1/sales-orders/so-1/issue", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "key-issue" },
      body: JSON.stringify({ expectedUpdatedAt: "43" }),
    }),
    "sales-orders",
    "so-1",
  );
  assert.equal(response.status, 200);
  assert.deepEqual(routeState.issued, [
    {
      documentId: "so-1",
      expectedUpdatedAt: "43",
      creditOverrideReason: undefined,
    },
  ]);
});

test("v1ListOrders and v1GetOrder bind the record type", async () => {
  routeState.listed = [];
  routeState.got = [];
  await v1ListOrders(new Request("http://openbooks.test/api/v1/sales-orders"), "sales-orders");
  await v1GetOrder(
    new Request("http://openbooks.test/api/v1/sales-orders/so-1"),
    "sales-orders",
    "so-1",
  );
  assert.deepEqual(routeState.listed, ["sales-orders"]);
  assert.deepEqual(routeState.got, [{ typeKey: "sales-orders", id: "so-1" }]);
});
