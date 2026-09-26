import assert from "node:assert/strict";
import { stubModules } from "../../../../testing/stub-modules";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-search-route-test");
interface RouteState {
  input: unknown;
}
const routeState: RouteState = { input: null };
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
          { user: { orgId: "org-1" }, keyId: "key-1" },
          { authz: { user: { orgId: "org-1" } } },
        )
        return Response.json(result.body, { status: result.status })
      }
    `,
    "../../../../lib/application/search-read": `
      const state = globalThis[Symbol.for('openbooks.v1-search-route-test')]
      export async function searchApplication(_context, input) {
        state.input = input
        return { q: input.q, groups: [], total: 0 }
      }
    `,
  },
});

const { GET } = (await import("./route.ts")) as typeof import("./route.ts");

test("GET /api/v1/search forwards q and limit", async () => {
  const response = await GET(new Request("http://openbooks.test/api/v1/search?q=needle&limit=10"));
  assert.equal(response.status, 200);
  assert.deepEqual(routeState.input, { q: "needle", limit: 10 });
});

test("GET /api/v1/search leaves limit undefined when absent", async () => {
  const response = await GET(new Request("http://openbooks.test/api/v1/search?q=needle"));
  assert.equal(response.status, 200);
  assert.deepEqual(routeState.input, { q: "needle", limit: undefined });
});
