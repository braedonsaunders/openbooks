import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-reports-run-route-test");
interface RouteState {
  calls: Array<Record<string, unknown>>;
  refuseRestricted?: boolean;
}

const routeState: RouteState = { calls: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:v1",
    `
      export async function withV1Request(request, _label, operation) {
        try {
          const result = await operation(
            { user: { orgId: "org-1" }, keyId: "key-1" },
            { authz: { user: { orgId: "org-1" }, allowedSubsidiaryIds: null } },
          )
          return Response.json(result.body, { status: result.status })
        } catch (error) {
          return Response.json(
            { error: error.code ?? "internal_error", message: error.message, details: error.details },
            { status: error.status ?? 500 },
          )
        }
      }
      export async function readV1JsonObject(request) {
        return await request.json()
      }
    `,
  ],
  [
    "mock:reports",
    `
      const state = globalThis[Symbol.for('openbooks.v1-reports-run-route-test')]
      export async function runApplicationReport(_context, input) {
        state.calls.push(input)
        return { title: "Profit and Loss", groups: [] }
      }
    `,
  ],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "../../../../../../lib/api/v1-request") {
      return { url: "mock:v1", shortCircuit: true };
    }
    if (specifier === "../../../../../../lib/application/reports") {
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

const { POST } = (await import("./route.ts")) as typeof import("./route.ts");
hooks.deregister();

test("POST /api/v1/reports/{id}/run binds the path id and period override", async () => {
  routeState.calls.length = 0;
  const response = await POST(
    new Request("http://openbooks.test/api/v1/reports/00000000-0000-4000-8000-000000000001/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ period: "last-month" }),
    }),
    { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000001" }) },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { title: "Profit and Loss", groups: [] });
  assert.equal(routeState.calls[0]?.definitionId, "00000000-0000-4000-8000-000000000001");
  assert.equal(routeState.calls[0]?.period, "last-month");
});
