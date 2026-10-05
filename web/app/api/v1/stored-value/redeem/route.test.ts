import assert from "node:assert/strict";
import { stubModules } from "../../../../../testing/stub-modules";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-stored-value-redeem-route-test");
interface RouteState {
  calls: Array<Record<string, unknown>>;
}

const routeState: RouteState = { calls: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "../../../../../lib/api/v1-request": `
      export async function withV1Request(request, label, operation) {
        try {
          const result = await operation(
            { user: { orgId: "org-1" }, keyId: "key-1" },
            { authz: { user: { orgId: "org-1" } } },
          )
          const headers = result.replayed === undefined ? {} : { "idempotency-replayed": String(result.replayed) }
          return Response.json(result.body, { status: result.status, headers })
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
    "../../../../../lib/application/stored-value": `
      const state = globalThis[Symbol.for('openbooks.v1-stored-value-redeem-route-test')]
      export async function redeemStoredValueForInvoice(_context, input) {
        state.calls.push(input)
        if (input.code === "BROKE") {
          const error = new Error("Stored-value …0011 holds 5.0000, which is less than the requested 40.0000.")
          error.code = "stored_value_insufficient_balance"
          error.status = 409
          throw error
        }
        return { replayed: false, result: { status: "posted", paymentId: "pay-1", entryId: "je-1", accountId: "acc-1", balance: "100000" } }
      }
    `,
  },
});

const { POST } = (await import("./route.ts")) as typeof import("./route.ts");

function post(body: unknown, idempotencyKey?: string): Promise<Response> {
  return POST(
    new Request("http://openbooks.test/api/v1/stored-value/redeem", {
      method: "POST",
      headers: {
        authorization: "Bearer [REDACTED]",
        "content-type": "application/json",
        ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
      },
      body: JSON.stringify(body),
    }),
  );
}

const INVOICE = "11111111-1111-4111-8111-111111111111";

test("POST /api/v1/stored-value/redeem posts the receipt and carries the idempotency key", async () => {
  routeState.calls.length = 0;
  const response = await post({ code: "ABCD-EFGH", amount: "40.00", invoiceId: INVOICE }, "redeem-key-1");
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    status: "posted",
    paymentId: "pay-1",
    entryId: "je-1",
    accountId: "acc-1",
    balance: "100000",
  });
  assert.equal(routeState.calls[0]?.idempotencyKey, "redeem-key-1");
  assert.equal(routeState.calls[0]?.invoiceId, INVOICE);
});

test("POST /api/v1/stored-value/redeem requires the Idempotency-Key header", async () => {
  routeState.calls.length = 0;
  const response = await post({ code: "ABCD-EFGH", amount: "40.00", invoiceId: INVOICE });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error, "invalid_input");
  assert.equal(routeState.calls.length, 0);
});

test("POST /api/v1/stored-value/redeem refuses an overdraft with the usable refusal", async () => {
  routeState.calls.length = 0;
  const response = await post({ code: "BROKE", amount: "40.00", invoiceId: INVOICE }, "redeem-key-2");
  assert.equal(response.status, 409);
  const body = (await response.json()) as { error: string; message: string };
  assert.equal(body.error, "stored_value_insufficient_balance");
  assert.match(body.message, /holds 5\.0000/);
});
