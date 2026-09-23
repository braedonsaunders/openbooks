import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-orders-lib-test");
interface RouteState {
  created: Array<Record<string, unknown>>;
  converted: Array<Record<string, unknown>>;
  listed: string[];
  got: Array<{ typeKey: string; id: string }>;
}
const routeState: RouteState = { created: [], converted: [], listed: [], got: [] };
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
      export async function convertApplicationOrder(_context, input) {
        state.converted.push(input)
        return { replayed: false, result: { id: "order-2", documentNumber: "SO-1", kind: input.targetKind } }
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
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
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

const { v1CreateOrder, v1ConvertOrder, v1ListOrders, v1GetOrder } = await import("./v1-orders.ts");
hooks.deregister();

test("v1CreateOrder maps the record key to the order-cycle kind", async () => {
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
  assert.deepEqual(routeState.created, [{ kind: "quote", idempotencyKey: "key-1" }]);
});

test("v1CreateOrder maps purchase-orders to purchase_order", async () => {
  routeState.created = [];
  await v1CreateOrder(
    new Request("http://openbooks.test/api/v1/purchase-orders", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "key-2" },
      body: "{}",
    }),
    "purchase-orders",
  );
  assert.equal(routeState.created[0]?.kind, "purchase_order");
});

test("v1ConvertOrder refuses a missing targetKind with the allowed targets", async () => {
  routeState.converted = [];
  await assert.rejects(
    () => v1ConvertOrder(
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
  assert.deepEqual(routeState.converted, [{
    documentId: "q1",
    targetKind: "sales_order",
    expectedUpdatedAt: "rev-1",
    creditOverrideReason: undefined,
    idempotencyKey: "key-4",
    expectedKind: "quote",
  }]);
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

test("v1ListOrders and v1GetOrder bind the record type", async () => {
  routeState.listed = [];
  routeState.got = [];
  await v1ListOrders(new Request("http://openbooks.test/api/v1/sales-orders"), "sales-orders");
  await v1GetOrder(new Request("http://openbooks.test/api/v1/sales-orders/so-1"), "sales-orders", "so-1");
  assert.deepEqual(routeState.listed, ["sales-orders"]);
  assert.deepEqual(routeState.got, [{ typeKey: "sales-orders", id: "so-1" }]);
});
