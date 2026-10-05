import assert from "node:assert/strict";
import { stubModules } from "../../../../../testing/stub-modules";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-stored-value-lookup-route-test");
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
          return Response.json(result.body, { status: result.status })
        } catch (error) {
          // Mirror the real wrapper: schema violations are 422 invalid_input.
          const isZod = Array.isArray(error.issues)
          return Response.json(
            { error: error.code ?? (isZod ? "invalid_input" : "internal_error"), message: error.message, details: error.details },
            { status: error.status ?? (isZod ? 422 : 500) },
          )
        }
      }
      export async function readV1JsonObject(request) {
        return await request.json()
      }
    `,
    "../../../../../lib/application/stored-value": `
      const state = globalThis[Symbol.for('openbooks.v1-stored-value-lookup-route-test')]
      export async function lookupStoredValueBalance(_context, input) {
        state.calls.push(input)
        if (input.code === "UNKNOWN") {
          const error = new Error("stored value not found")
          error.code = "not_found"
          error.status = 404
          throw error
        }
        return { kind: "gift_card", currency: "CAD", balance: "500000", status: "active", expiresOn: null }
      }
    `,
  },
});

const { POST } = (await import("./route.ts")) as typeof import("./route.ts");

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://openbooks.test/api/v1/stored-value/lookup", {
      method: "POST",
      headers: {
        authorization: "Bearer [REDACTED]",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

test("POST /api/v1/stored-value/lookup returns the balance without ever returning the code", async () => {
  routeState.calls.length = 0;
  const response = await post({ code: "ABCD-EFGH-IJKL-MNOP" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    kind: "gift_card",
    currency: "CAD",
    balance: "500000",
    status: "active",
    expiresOn: null,
  });
  assert.equal(routeState.calls[0]?.code, "ABCD-EFGH-IJKL-MNOP");
});

test("POST /api/v1/stored-value/lookup refuses an empty code before reaching the reader", async () => {
  routeState.calls.length = 0;
  const response = await post({ code: "" });
  assert.equal(response.status, 422);
  assert.equal(routeState.calls.length, 0);
});

test("POST /api/v1/stored-value/lookup surfaces an unknown code as not found", async () => {
  routeState.calls.length = 0;
  const response = await post({ code: "UNKNOWN" });
  assert.equal(response.status, 404);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error, "not_found");
});
