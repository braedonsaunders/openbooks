import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-reports-route-test");
interface RouteState {
  queries: Array<string | undefined>;
}

const routeState: RouteState = { queries: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:v1",
    `
      export async function withV1Request(request, _label, operation) {
        const result = await operation(
          { user: { orgId: "org-1" }, keyId: "key-1" },
          { authz: { user: { orgId: "org-1" }, allowedSubsidiaryIds: null } },
        )
        return Response.json(result.body, { status: result.status })
      }
    `,
  ],
  [
    "mock:reports",
    `
      const state = globalThis[Symbol.for('openbooks.v1-reports-route-test')]
      export async function listApplicationReports(_context, input) {
        state.queries.push(input.query)
        return { definitions: [{ id: "def-1", name: "Profit and Loss", reportType: "statement" }] }
      }
    `,
  ],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "../../../../lib/api/v1-request") {
      return { url: "mock:v1", shortCircuit: true };
    }
    if (specifier === "../../../../lib/application/reports") {
      return { url: "mock:reports", shortCircuit: true };
    }
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

test("GET /api/v1/reports lists through the application report catalog", async () => {
  routeState.queries.length = 0;
  const response = await GET(new Request("http://openbooks.test/api/v1/reports?q=profit"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    definitions: [{ id: "def-1", name: "Profit and Loss", reportType: "statement" }],
  });
  assert.deepEqual(routeState.queries, ["profit"]);
});
