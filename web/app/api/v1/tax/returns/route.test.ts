import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-tax-returns-route-test");
interface RouteState { calls: number }
const routeState: RouteState = { calls: 0 };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:v1",
    `export async function withV1Request(request, label, operation) {
      const result = await operation({ user: { orgId: "org-1" } }, { authz: { user: { orgId: "org-1" } } })
      return Response.json(result.body, { status: result.status })
    }`,
  ],
  [
    "mock:tax",
    `const state = globalThis[Symbol.for('openbooks.v1-tax-returns-route-test')]
     export async function listApplicationTaxReturnForms(_context) {
       state.calls += 1
       return { total: 0, forms: [] }
     }`,
  ],
]);
const mockUrls = new Map<string, string>([
  ["../../../../../lib/api/v1-request", "mock:v1"],
  ["../../../../../lib/application/tax-read", "mock:tax"],
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
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

test("GET /api/v1/tax/returns lists the filing-screen forms", async () => {
  const response = await GET(new Request("http://openbooks.test/api/v1/tax/returns"));
  assert.equal(response.status, 200);
  assert.equal(routeState.calls, 1);
  assert.deepEqual(await response.json(), { total: 0, forms: [] });
});
