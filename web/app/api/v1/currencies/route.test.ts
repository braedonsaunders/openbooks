import assert from "node:assert/strict";
import { stubModules } from "../../../../testing/stub-modules";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-currencies-route-test");
interface RouteState { called: boolean }
const routeState: RouteState = { called: false };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "../../../../lib/api/v1-request": `export async function withV1Request(request, label, operation) {
      const result = await operation({ user: { orgId: "org-1" } }, { authz: { user: { orgId: "org-1" } } })
      return Response.json(result.body, { status: result.status })
    }`,
    "../../../../lib/application/fx-read": `const state = globalThis[Symbol.for('openbooks.v1-currencies-route-test')]
     export async function listApplicationCurrencies() {
       state.called = true
       return { baseCurrency: "USD", currencies: [{ code: "USD", name: "US Dollar" }] }
     }`,
  },
});
const { GET } = (await import("./route.ts")) as typeof import("./route.ts");

test("GET /api/v1/currencies lists the ISO registry through the application reader", async () => {
  const response = await GET(new Request("http://openbooks.test/api/v1/currencies"));
  assert.equal(response.status, 200);
  assert.equal(routeState.called, true);
  assert.deepEqual(await response.json(), {
    baseCurrency: "USD",
    currencies: [{ code: "USD", name: "US Dollar" }],
  });
});
