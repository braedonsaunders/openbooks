import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-open-items-route-test");
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
    "mock:open-items",
    `
      const state = globalThis[Symbol.for('openbooks.v1-open-items-route-test')]
      export async function listApplicationOpenItems(_context, input) {
        state.input = input
        return { side: input.side, asOf: "2026-09-22", total: 0, items: [] }
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../lib/api/v1-request", "mock:v1"],
  ["../../../../lib/application/open-items", "mock:open-items"],
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

test("GET /api/v1/open-items forwards side, asOf, partyId, and limit", async () => {
  const response = await GET(new Request(
    "http://openbooks.test/api/v1/open-items?side=ar&asOf=2026-09-01&partyId=p1&limit=10",
  ));
  assert.equal(response.status, 200);
  assert.deepEqual(routeState.input, {
    side: "ar",
    asOf: "2026-09-01",
    partyId: "p1",
    limit: 10,
  });
});
