import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-field-tickets-route-test");
interface RouteState {
  created: Array<Record<string, unknown>>;
  listed: string[];
}
const routeState: RouteState = { created: [], listed: [] };
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
          return Response.json({ error: error.message }, { status: error.status ?? 500 })
        }
      }
      export async function readV1JsonObject(request) { return await request.json() }
      export function requireV1IdempotencyKey(request) {
        const key = request.headers.get("idempotency-key")?.trim()
        if (!key) throw new Error("Idempotency-Key header is required")
        return key
      }
    `,
  ],
  [
    "mock:records",
    `
      const state = globalThis[Symbol.for('openbooks.v1-field-tickets-route-test')]
      export async function v1ListRecords(_request, typeKey) {
        state.listed.push(typeKey)
        return Response.json({ typeKey })
      }
    `,
  ],
  [
    "mock:errors",
    `
      export class ApplicationError extends Error {
        constructor(code, message, status, details) { super(message); this.code = code; this.status = status; this.details = details }
      }
      export function invalidInput(message) {
        const error = new Error(message)
        error.status = 422
        throw error
      }
    `,
  ],
  [
    "mock:tickets",
    `
      const state = globalThis[Symbol.for('openbooks.v1-field-tickets-route-test')]
      export async function createApplicationFieldTicket(_context, input) {
        state.created.push(input)
        return { replayed: false, result: { id: "ticket-1", documentNumber: "FT-1" } }
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../lib/api/v1-request", "mock:v1"],
  ["../../../../lib/api/v1-records", "mock:records"],
  ["../../../../lib/application/errors", "mock:errors"],
  ["../../../../lib/application/field-tickets", "mock:tickets"],
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

const { GET, POST } = (await import("./route.ts")) as typeof import("./route.ts");
hooks.deregister();

test("GET /api/v1/field-tickets lists through the field-tickets record type", async () => {
  routeState.listed = [];
  const response = await GET(new Request("http://openbooks.test/api/v1/field-tickets"));
  assert.equal(response.status, 200);
  assert.deepEqual(routeState.listed, ["field-tickets"]);
});

test("POST /api/v1/field-tickets creates through createApplicationFieldTicket", async () => {
  routeState.created = [];
  const response = await POST(new Request("http://openbooks.test/api/v1/field-tickets", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "key-1" },
    body: JSON.stringify({ projectId: "11111111-1111-4111-8111-111111111111", period: "week" }),
  }));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: "ticket-1", documentNumber: "FT-1" });
  assert.equal(routeState.created[0]?.projectId, "11111111-1111-4111-8111-111111111111");
  assert.equal(routeState.created[0]?.period, "week");
});

test("POST /api/v1/field-tickets refuses a missing projectId naming GET /api/v1/projects", async () => {
  routeState.created = [];
  const response = await POST(new Request("http://openbooks.test/api/v1/field-tickets", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "key-1" },
    body: "{}",
  }));
  assert.equal(response.status, 422);
  assert.match((await response.json() as { error: string }).error, /GET \/api\/v1\/projects/);
  assert.equal(routeState.created.length, 0);
});
