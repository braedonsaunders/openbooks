import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-payments-route-test");
interface RouteState {
  calls: Array<Record<string, unknown>>;
}

const routeState: RouteState = { calls: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:v1",
    `
      export async function withV1Request(request, label, operation) {
        try {
          const result = await operation(
            { user: { orgId: "org-1" }, keyId: "key-1" },
            { authz: { user: { orgId: "org-1" } } },
          )
          return Response.json(result.body, { status: result.status })
        } catch (error) {
          return Response.json(
            { error: error.code ?? "internal_error", message: error.message, details: error.details },
            { status: error.status ?? 500 },
          )
        }
      }
      export async function readV1JsonObject(request) {
        return await request.json()
      }
      export function requireV1IdempotencyKey(request) {
        const key = request.headers.get("idempotency-key")
        if (!key) {
          const error = new Error("Idempotency-Key header is required")
          error.code = "invalid_input"
          error.status = 400
          throw error
        }
        return key
      }
    `,
  ],
  [
    "mock:errors",
    `
      export class ApplicationError extends Error {
        constructor(code, message, status, details) {
          super(message)
          this.code = code
          this.status = status
          this.details = details
        }
      }
    `,
  ],
  [
    "mock:payments",
    `
      const state = globalThis[Symbol.for('openbooks.v1-payments-route-test')]
      export async function createPayment(_context, input) {
        state.calls.push(input)
        return { replayed: false, status: 201, result: { id: "payment-1", kind: input.kind } }
      }
    `,
  ],
  [
    "mock:v1-records",
    `
      const state = globalThis[Symbol.for('openbooks.v1-payments-route-test')]
      export async function v1ListRecords(_request, typeKey) {
        state.calls.push({ list: typeKey })
        return Response.json({ records: [], total: 0, page: 1, perPage: 25, typeKey })
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../lib/api/v1-request", "mock:v1"],
  ["../../../../lib/application/errors", "mock:errors"],
  ["../../../../lib/application/payments", "mock:payments"],
  ["../../../../lib/api/v1-records", "mock:v1-records"],
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

const { GET, POST } = (await import("./route.ts")) as typeof import("./route.ts");
hooks.deregister();

function post(body: unknown, idempotencyKey = "payments-key-1"): Promise<Response> {
  return POST(
    new Request("http://openbooks.test/api/v1/payments", {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(body),
    }),
  );
}

test("POST /api/v1/payments rejects an invalid kind before reaching the writer", async () => {
  routeState.calls.length = 0;
  const response = await post({ kind: "wire_transfer" });
  assert.equal(response.status, 422);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error, "invalid_input");
  assert.equal(routeState.calls.length, 0);
});

test("POST /api/v1/payments creates a vendor payment with the idempotency key", async () => {
  routeState.calls.length = 0;
  const response = await post({ kind: "vendor_payment", partyId: "party-1" }, "payments-key-2");
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: "payment-1", kind: "vendor_payment" });
  assert.equal(routeState.calls[0]?.kind, "vendor_payment");
  assert.equal(routeState.calls[0]?.partyId, "party-1");
  assert.equal(routeState.calls[0]?.idempotencyKey, "payments-key-2");
});

test("GET /api/v1/payments lists through the payments record type", async () => {
  routeState.calls.length = 0;
  const response = await GET(new Request("http://openbooks.test/api/v1/payments"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { records: [], total: 0, page: 1, perPage: 25, typeKey: "payments" });
  assert.equal(routeState.calls[0]?.list, "payments");
});

test("POST /api/v1/payments creates a customer receipt", async () => {
  routeState.calls.length = 0;
  const response = await post({ kind: "customer_payment" }, "payments-key-3");
  assert.equal(response.status, 201);
  assert.equal(routeState.calls[0]?.kind, "customer_payment");
  assert.equal(routeState.calls[0]?.idempotencyKey, "payments-key-3");
});
