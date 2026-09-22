import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-alias-route-test");
interface RouteState {
  lists: string[];
  reserved: string[];
}

const routeState: RouteState = { lists: [], reserved: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:records",
    `
      const state = globalThis[Symbol.for('openbooks.v1-alias-route-test')]
      export async function v1ListAliasedRecords(_request, typeKey) {
        state.lists.push(typeKey)
        if (typeKey === 'close' || typeKey === 'reports') {
          state.reserved.push(typeKey)
          return Response.json({ error: 'not_found', message: 'record type not found' }, { status: 404 })
        }
        return Response.json({ records: [], total: 0, page: 1, perPage: 25, typeKey })
      }
      export async function v1CreateAliasedRecord() {
        return Response.json({ id: 'created-1' }, { status: 201 })
      }
    `,
  ],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "../../../../lib/api/v1-records") {
      return { url: "mock:records", shortCircuit: true };
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

test("GET /api/v1/{typeKey} lists through the aliased records helper", async () => {
  routeState.lists.length = 0;
  const response = await GET(
    new Request("http://openbooks.test/api/v1/invoices"),
    { params: Promise.resolve({ typeKey: "invoices" }) },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { records: [], total: 0, page: 1, perPage: 25, typeKey: "invoices" });
  assert.deepEqual(routeState.lists, ["invoices"]);
});

test("GET /api/v1/{typeKey} keeps reserved static folders off the records catalog", async () => {
  routeState.lists.length = 0;
  routeState.reserved.length = 0;
  const response = await GET(
    new Request("http://openbooks.test/api/v1/close"),
    { params: Promise.resolve({ typeKey: "close" }) },
  );
  assert.equal(response.status, 404);
  assert.deepEqual(routeState.reserved, ["close"]);
});
