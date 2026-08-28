import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

interface RouteState {
  pingResult: { ok: boolean; detail?: string };
  pingError: Error | null;
  updates: string[];
}

const stateKey = Symbol.for("openbooks.connection-test-route-test");
const routeState: RouteState = {
  pingResult: { ok: true, detail: "Connected" },
  pingError: null,
  updates: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((chunk) => {
      if (chunk === null) return "null";
      if (typeof chunk === "string") return chunk;
      const value = (chunk as { value?: unknown[] })?.value;
      if (Array.isArray(value)) return value.map(String).join("");
      if ((chunk as { queryChunks?: unknown[] })?.queryChunks)
        return sqlText(chunk);
      return "";
    })
    .join("");
}
(
  globalThis as typeof globalThis & Record<string, unknown>
).connectionTestSqlText = sqlText;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      export async function guardPermission() {
        return {
          user: { orgId: "org-1", id: "user-1" },
          permissions: new Set(["admin.setup.manage"]),
          allowedSubsidiaryIds: null,
        }
      }
    `,
  ],
  [
    "mock:connection",
    `
      const state = globalThis[Symbol.for("openbooks.connection-test-route-test")]
      export async function getConnection() {
        return { id: "connection-1", orgId: "org-1", source: "test", config: {}, secrets: null }
      }
      export function buildSource() {
        return {
          ping: async () => {
            if (state.pingError) throw state.pingError
            return state.pingResult
          },
          trialBalance: async () => [],
        }
      }
    `,
  ],
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for("openbooks.connection-test-route-test")]
      const sqlText = globalThis.connectionTestSqlText
      export const db = {
        execute(query) {
          state.updates.push(sqlText(query))
          return Promise.resolve({ rows: [] })
        },
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/src/db.ts", "mock:db"],
  ["@openbooks/engine/src/sync/connection.ts", "mock:connection"],
  ["../../../../../../lib/authz", "mock:authz"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined)
      return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?connection-test-route-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

function reset(): void {
  routeState.pingResult = { ok: true, detail: "Connected" };
  routeState.pingError = null;
  routeState.updates.length = 0;
}

function call(): Promise<Response> {
  return POST(
    new Request(
      "http://openbooks.test/api/platform/connections/connection-1/test",
      { method: "POST" },
    ),
    { params: Promise.resolve({ id: "connection-1" }) },
  );
}

test("a false ping records error status and preserves provider detail", async () => {
  reset();
  routeState.pingResult = { ok: false, detail: "token rejected by provider" };

  const response = await call();

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: false,
    detail: "token rejected by provider",
  });
  assert.equal(routeState.updates.length, 1);
  assert.match(routeState.updates[0]!, /status = '?error/);
  assert.match(
    routeState.updates[0]!,
    /last_error = token rejected by provider/,
  );
});

test("a successful ping activates the connection and clears stale errors", async () => {
  reset();

  const response = await call();

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, detail: "Connected" });
  assert.equal(routeState.updates.length, 1);
  assert.match(routeState.updates[0]!, /status = '?active/);
  assert.match(routeState.updates[0]!, /last_error = null/);
});

test("a thrown ping records its error evidence and returns a failed probe", async () => {
  reset();
  routeState.pingError = new Error("provider unavailable");

  const response = await call();

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "provider unavailable",
  });
  assert.equal(routeState.updates.length, 1);
  assert.match(routeState.updates[0]!, /status = '?error/);
  assert.match(routeState.updates[0]!, /last_error = provider unavailable/);
});
