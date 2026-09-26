import assert from "node:assert/strict";
import { stubModules } from "../../../../../../testing/stub-modules";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-budgets-route-test");
interface RouteState {
  updates: Array<Record<string, unknown>>;
}

const routeState: RouteState = { updates: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "../../../../../../lib/api/v1-request": `
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
    "../../../../../../lib/application/budgets": `
      const state = globalThis[Symbol.for('openbooks.v1-budgets-route-test')]
      export async function updateBudgetCells(_context, input) {
        state.updates.push(input)
        return { replayed: false, result: { revision: 2 } }
      }
    `,
  },
});

const { POST } = (await import("./route.ts")) as typeof import("./route.ts");

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
