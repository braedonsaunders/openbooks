import assert from "node:assert/strict";
import { stubModules } from "../../../../../testing/stub-modules";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-tax-returns-route-test");
interface RouteState { calls: number }
const routeState: RouteState = { calls: 0 };
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
    "../../../../../lib/application/tax-read": `const state = globalThis[Symbol.for('openbooks.v1-tax-returns-route-test')]
     export async function listApplicationTaxReturnForms(_context) {
       state.calls += 1
       return { total: 0, forms: [] }
     }`,
  },
});
const { GET } = (await import("./route.ts")) as typeof import("./route.ts");

test("GET /api/v1/tax/returns lists the filing-screen forms", async () => {
  const response = await GET(new Request("http://openbooks.test/api/v1/tax/returns"));
  assert.equal(response.status, 200);
  assert.equal(routeState.calls, 1);
  assert.deepEqual(await response.json(), { total: 0, forms: [] });
});
