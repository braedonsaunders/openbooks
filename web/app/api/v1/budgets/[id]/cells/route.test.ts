import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-budgets-route-test");
interface RouteState {
  updates: Array<Record<string, unknown>>;
}

const routeState: RouteState = { updates: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:v1",
    `
      export async function withV1Request(request, label, operation) {
        try {
          const result = await operation(
            { user: { orgId: "org-1" }, keyId: "key-1" },
            { authz: { user: { orgId: "org-1" } } },
          )
          return Response.json(result.body, { status: result.status })
        } catch (error) {
          return Response.json(
            { error: error.code ?? "internal_error", message: error.message },
            { status: error.status ?? 500 },
          )
        }
      }
      export async function readV1JsonObject(request) {
        return await request.json()
      }
      export function requireV1IdempotencyKey(request) {
        const key = request.headers.get("idempotency-key")
        if (!key) {
          const error = new Error("Idempotency-Key header is required")
          error.code = "invalid_input"
          error.status = 400
          throw error
        }
        return key
      }
    `,
  ],
  [
    "mock:budgets",
    `
      const state = globalThis[Symbol.for('openbooks.v1-budgets-route-test')]
      export async function updateBudgetCells(_context, input) {
        state.updates.push(input)
        return { replayed: false, result: { revision: 2 } }
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../../../lib/api/v1-request", "mock:v1"],
  ["../../../../../../lib/application/budgets", "mock:budgets"],
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

const { POST } = (await import("./route.ts")) as typeof import("./route.ts");
hooks.deregister();

function post(scenarioId: string, body: unknown, idempotencyKey?: string): Promise<Response> {
  return POST(
    new Request(`http://openbooks.test/api/v1/budgets/${scenarioId}/cells`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: scenarioId }) },
  );
}

test("POST /api/v1/budgets/:id/cells takes the scenario id from the path", async () => {
  routeState.updates.length = 0;
  const scenarioId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const cells = [
    {
      accountId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      periodId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      amount: "100.00",
    },
  ];
  const response = await post(scenarioId, { expectedRevision: 1, cells }, "budget-key-1");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revision: 2 });
  assert.deepEqual(routeState.updates[0], {
    scenarioId,
    expectedRevision: 1,
    cells,
    idempotencyKey: "budget-key-1",
  });
});

test("POST /api/v1/budgets/:id/cells refuses a missing Idempotency-Key", async () => {
  const response = await post("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", { expectedRevision: 1, cells: [] });
  assert.equal(response.status, 400);
});
