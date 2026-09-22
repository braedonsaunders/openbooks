import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-search-route-test");
interface RouteState {
  input: unknown;
}
const routeState: RouteState = { input: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:v1",
    `
      export async function withV1Request(request, label, operation) {
        const result = await operation(
          { user: { orgId: "org-1" }, keyId: "key-1" },
          { authz: { user: { orgId: "org-1" } } },
        )
        return Response.json(result.body, { status: result.status })
      }
    `,
  ],
  [
    "mock:search-read",
    `
      const state = globalThis[Symbol.for('openbooks.v1-search-route-test')]
      export async function searchApplication(_context, input) {
        state.input = input
        return { q: input.q, groups: [], total: 0 }
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../lib/api/v1-request", "mock:v1"],
  ["../../../../lib/application/search-read", "mock:search-read"],
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
