import assert from "node:assert/strict";
import { stubModules } from "../../../../../testing/stub-modules";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-fx-rates-route-test");
interface RouteState { input: unknown }
const routeState: RouteState = { input: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "../../../../../lib/api/v1-request": `export async function withV1Request(request, label, operation) {
      const result = await operation({ user: { orgId: "org-1" } }, { authz: { user: { orgId: "org-1" } } })
      return Response.json(result.body, { status: result.status })
    }`,
    "../../../../../lib/application/fx-read": `const state = globalThis[Symbol.for('openbooks.v1-fx-rates-route-test')]
     export async function listApplicationFxRates(_context, input) {
       state.input = input
       return { fromCurrency: input.fromCurrency, toCurrency: input.toCurrency, total: 0, rates: [] }
     }`,
  },
});
const { GET } = (await import("./route.ts")) as typeof import("./route.ts");

test("GET /api/v1/fx/rates uppercases the pair and forwards asOf", async () => {
  const response = await GET(new Request("http://openbooks.test/api/v1/fx/rates?fromCurrency=usd&toCurrency=cad&asOf=2026-09-01"));
  assert.equal(response.status, 200);
  assert.deepEqual(routeState.input, {
    fromCurrency: "USD",
    toCurrency: "CAD",
    asOf: "2026-09-01",
    rateType: undefined,
    limit: undefined,
  });
});
