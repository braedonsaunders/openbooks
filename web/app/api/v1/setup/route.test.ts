import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-setup-catalog-route-test");
interface RouteState {
  listed: boolean;
}
const routeState: RouteState = { listed: false };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:v1",
    `
      export async function withV1Request(request, label, operation) {
        const result = await operation(
          { user: { orgId: "org-1", id: "user-1" }, keyId: "key-1" },
          { authz: { user: { orgId: "org-1", id: "user-1" }, permissions: [] } },
        )
        return Response.json(result.body, { status: result.status })
      }
    `,
  ],
  [
    "mock:setup-read",
    `
      const state = globalThis[Symbol.for('openbooks.v1-setup-catalog-route-test')]
      export async function listSetupEntities() {
        state.listed = true
        return { entities: [{ key: "tax-codes", enabled: true }] }
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../lib/api/v1-request", "mock:v1"],
  ["../../../../lib/application/setup-read", "mock:setup-read"],
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

const { GET } = (await import("./route.ts")) as typeof import("./route.ts");
hooks.deregister();

test("GET /api/v1/setup lists through listSetupEntities", async () => {
  routeState.listed = false;
  const response = await GET(new Request("http://openbooks.test/api/v1/setup"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { entities: [{ key: "tax-codes", enabled: true }] });
  assert.equal(routeState.listed, true);
});
