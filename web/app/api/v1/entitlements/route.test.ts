import assert from "node:assert/strict";
import { stubModules } from "../../../../testing/stub-modules";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-entitlements-route-test");
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
    "../../../../lib/api/v1-request": `
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
    `,
    "../../../../lib/application/entitlements": `
      const state = globalThis[Symbol.for('openbooks.v1-entitlements-route-test')]
      export async function getV1Entitlements(_context, query) {
        state.calls.push(query)
        if (query.customer === "Nobody Here") {
          const error = new Error("No customer is named Nobody Here in this organization.")
          error.code = "not_found"
          error.status = 404
          error.details = { remedy: "Check the spelling, or query by customer id or external reference." }
          throw error
        }
        return { customer: { id: "cust-1", displayName: "Acme" }, subscriptions: [], check: null }
      }
    `,
  },
});

const { GET } = (await import("./route.ts")) as typeof import("./route.ts");

function get(query: string): Promise<Response> {
  return GET(
    new Request(`http://openbooks.test/api/v1/entitlements${query}`, {
      method: "GET",
      headers: { authorization: "Bearer [REDACTED]" },
    }),
  );
}

test("GET /api/v1/entitlements forwards customer, feature and usage filters", async () => {
  routeState.calls.length = 0;
  const response = await get("?customer=Acme&feature=seats_included&used=130");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    customer: { id: "cust-1", displayName: "Acme" },
    subscriptions: [],
    check: null,
  });
  assert.deepEqual(routeState.calls[0], {
    customer: "Acme",
    externalRef: undefined,
    subscription: undefined,
    at: undefined,
    feature: "seats_included",
    used: "130",
  });
});

test("GET /api/v1/entitlements surfaces an unknown customer name as not found", async () => {
  routeState.calls.length = 0;
  const response = await get("?customer=Nobody%20Here");
  assert.equal(response.status, 404);
  const body = (await response.json()) as { error: string; message: string };
  assert.equal(body.error, "not_found");
  assert.equal(body.message, "No customer is named Nobody Here in this organization.");
});
