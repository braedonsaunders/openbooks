import assert from "node:assert/strict";
import { stubModules } from "../../../../testing/stub-modules";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-setup-catalog-route-test");
interface RouteState {
  listed: boolean;
}
const routeState: RouteState = { listed: false };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "../../../../lib/api/v1-request": `
      export async function withV1Request(request, label, operation) {
        const result = await operation(
          { user: { orgId: "org-1", id: "user-1" }, keyId: "key-1" },
          { authz: { user: { orgId: "org-1", id: "user-1" }, permissions: [] } },
        )
        return Response.json(result.body, { status: result.status })
      }
    `,
    "../../../../lib/application/setup-read": `
      const state = globalThis[Symbol.for('openbooks.v1-setup-catalog-route-test')]
      export async function listSetupEntities() {
        state.listed = true
        return { entities: [{ key: "tax-codes", enabled: true }] }
      }
    `,
  },
});

const { GET } = (await import("./route.ts")) as typeof import("./route.ts");

test("GET /api/v1/setup lists through listSetupEntities", async () => {
  routeState.listed = false;
  const response = await GET(new Request("http://openbooks.test/api/v1/setup"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { entities: [{ key: "tax-codes", enabled: true }] });
  assert.equal(routeState.listed, true);
});
