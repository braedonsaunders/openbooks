import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-journals-route-test");
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
        const result = await operation(
          { user: { orgId: "org-1" }, keyId: "key-1" },
          { authz: { user: { orgId: "org-1" } } },
        )
        return Response.json(result.body, { status: result.status })
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
      const state = globalThis[Symbol.for('openbooks.v1-journals-route-test')]
      export async function v1ListRecords(_request, typeKey) {
        state.listed.push(typeKey)
        return Response.json({ typeKey })
      }
    `,
  ],
  [
    "mock:journals",
    `
      const state = globalThis[Symbol.for('openbooks.v1-journals-route-test')]
      export function parseJournalCreateBody(body) { return body }
      export function requireUuidIdempotencyKey(key) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) throw new Error("Idempotency-Key must be a UUID — it becomes the journal id")
        return key
      }
      export async function createApplicationJournal(_context, input) {
        state.created.push(input)
        return { created: true, replayed: false, journal: { id: input.idempotencyKey } }
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../lib/api/v1-request", "mock:v1"],
  ["../../../../lib/api/v1-records", "mock:records"],
  ["../../../../lib/application/journals", "mock:journals"],
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

test("GET /api/v1/journals lists through the journals record type", async () => {
  routeState.listed = [];
  const response = await GET(new Request("http://openbooks.test/api/v1/journals"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { typeKey: "journals" });
  assert.deepEqual(routeState.listed, ["journals"]);
});

test("POST /api/v1/journals creates through createApplicationJournal", async () => {
  routeState.created = [];
  const key = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const response = await POST(new Request("http://openbooks.test/api/v1/journals", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ memo: "opening", lines: [] }),
  }));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: key });
  assert.equal(routeState.created[0]?.idempotencyKey, key);
  assert.deepEqual(routeState.created[0]?.body, { memo: "opening", lines: [] });
});

test("POST /api/v1/journals refuses a non-UUID Idempotency-Key before the writer", async () => {
  routeState.created = [];
  await assert.rejects(
    () => POST(new Request("http://openbooks.test/api/v1/journals", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "not-a-uuid" },
      body: "{}",
    })),
    /Idempotency-Key must be a UUID/,
  );
  assert.equal(routeState.created.length, 0);
});
