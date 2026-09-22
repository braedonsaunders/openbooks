import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-close-runs-route-test");
interface RouteState {
  lists: Array<Record<string, unknown>>;
  starts: Array<Record<string, unknown>>;
}

const routeState: RouteState = { lists: [], starts: [] };
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
    "mock:close",
    `
      const state = globalThis[Symbol.for('openbooks.v1-close-runs-route-test')]
      export async function listCloseRuns(_context, input) {
        state.lists.push(input)
        return [{ id: "run-1", status: "open" }]
      }
      export async function startApplicationCloseRun(_context, input) {
        state.starts.push(input)
        return { replayed: false, status: 201, result: { id: "run-2", status: "open" } }
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../../lib/api/v1-request", "mock:v1"],
  ["../../../../../lib/application/close", "mock:close"],
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

const { GET, POST } = (await import("./route.ts?v1-close-runs")) as typeof import("./route.ts");
hooks.deregister();

test("GET /api/v1/close/runs lists runs with status and limit filters", async () => {
  routeState.lists.length = 0;
  const response = await GET(
    new Request("http://openbooks.test/api/v1/close/runs?status=open&limit=10", {
      headers: { authorization: "Bearer test-key" },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { runs: [{ id: "run-1", status: "open" }] });
  assert.deepEqual(routeState.lists, [{ status: "open", limit: 10 }]);
});

test("POST /api/v1/close/runs starts a run with the idempotency key", async () => {
  routeState.starts.length = 0;
  const response = await POST(
    new Request("http://openbooks.test/api/v1/close/runs", {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
        "idempotency-key": "close-key-1",
      },
      body: JSON.stringify({ periodId: "period-1", bookId: "book-1" }),
    }),
  );
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: "run-2", status: "open" });
  assert.deepEqual(routeState.starts[0], {
    periodId: "period-1",
    bookId: "book-1",
    blueprintId: undefined,
    reportingPackageId: undefined,
    targetCloseDate: undefined,
    subsidiaryIds: undefined,
    idempotencyKey: "close-key-1",
  });
});
