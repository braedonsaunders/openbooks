import assert from "node:assert/strict";
import { stubModules } from "../../../../testing/stub-modules";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-field-tickets-route-test");
interface RouteState {
  created: Array<Record<string, unknown>>;
  listed: string[];
}
const routeState: RouteState = { created: [], listed: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "../../../../lib/api/v1-request": `
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
    "../../../../lib/api/v1-records": `
      const state = globalThis[Symbol.for('openbooks.v1-field-tickets-route-test')]
      export async function v1ListRecords(_request, typeKey) {
        state.listed.push(typeKey)
        return Response.json({ typeKey })
      }
    `,
    "../../../../lib/application/errors": `
      export class ApplicationError extends Error {
        constructor(code, message, status, details) { super(message); this.code = code; this.status = status; this.details = details }
      }
      export function invalidInput(message) {
        const error = new Error(message)
        error.status = 422
        throw error
      }
    `,
    "../../../../lib/application/field-tickets": `
      const state = globalThis[Symbol.for('openbooks.v1-field-tickets-route-test')]
      export async function createApplicationFieldTicket(_context, input) {
        state.created.push(input)
        return { replayed: false, result: { id: "ticket-1", documentNumber: "FT-1" } }
      }
    `,
  },
});

const { GET, POST } = (await import("./route.ts")) as typeof import("./route.ts");

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
