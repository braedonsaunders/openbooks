import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

interface RouteState {
  pingResult: { ok: boolean; detail?: string };
  pingError: Error | null;
  queries: string[];
  updates: string[];
  config: Record<string, unknown>;
  pingCalls: number;
  updateMatches: boolean;
}

const stateKey = Symbol.for("openbooks.connection-test-route-test");
const routeState: RouteState = {
  pingResult: { ok: true, detail: "Connected" },
  pingError: null,
  queries: [],
  updates: [],
  config: {},
  pingCalls: 0,
  updateMatches: true,
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
      export function guardUnrestrictedScope(authz) { return authz.allowedSubsidiaryIds == null ? null : new Response(JSON.stringify({ error: "requires unrestricted subsidiary access" }), { status: 403 }) }
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
      export function buildSource() {
        return {
          ping: async () => {
            state.pingCalls += 1
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
          const text = sqlText(query)
          state.queries.push(text)
          if (text.includes("update connections")) {
            state.updates.push(text)
            return Promise.resolve({ rows: state.updateMatches ? [{ id: "connection-1" }] : [] })
          }
          if (text.includes("from connections")) {
            return Promise.resolve({
              rows: [{
                id: "connection-1",
                orgId: "org-1",
                source: "test",
                displayName: "Test",
                authKind: "token",
                status: "active",
                config: state.config,
                secrets: null,
                updatedAt: "t0",
              }],
            })
          }
          return Promise.resolve({ rows: [] })
        },
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
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
  routeState.queries.length = 0;
  routeState.updates.length = 0;
  routeState.config = {};
  routeState.pingCalls = 0;
  routeState.updateMatches = true;
}

function updateSql(): string {
  return routeState.updates.find((text) => text.includes("update connections")) ?? "";
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

  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    ok: false,
    detail: "token rejected by provider",
  });
  assert.match(updateSql(), /status = '?error/);
  assert.match(updateSql(), /last_error = token rejected by provider/);
  assert.match(updateSql(), /updated_at is not distinct from/);
  assert.match(updateSql(), /config is not distinct from/);
});

test("a successful ping activates the connection and clears stale errors", async () => {
  reset();

  const response = await call();

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, detail: "Connected" });
  assert.match(updateSql(), /status = '?active/);
  assert.match(updateSql(), /last_error = null/);
  assert.match(updateSql(), /updated_at is not distinct from/);
});

test("a thrown ping records its error evidence and returns a failed probe", async () => {
  reset();
  routeState.pingError = new Error("provider unavailable");

  const response = await call();

  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "provider unavailable",
  });
  assert.match(updateSql(), /status = '?error/);
  assert.match(updateSql(), /last_error = provider unavailable/);
});

test("a stale ping does not stamp a rotated connection", async () => {
  reset();
  routeState.updateMatches = false;

  const response = await call();

  assert.equal(response.status, 409);
  const body = (await response.json()) as { errorCode?: string; ok?: boolean };
  assert.equal(body.errorCode, "CONNECTION_CHANGED");
  assert.notEqual(body.ok, true);
  assert.equal(routeState.pingCalls, 1);
  assert.match(updateSql(), /returning id/);
});

test("probe target and version token come from one connections read", async () => {
  reset();

  const response = await call();
  assert.equal(response.status, 200);

  const captures = routeState.queries.filter(
    (text) =>
      /select/i.test(text) &&
      text.includes("from connections") &&
      !text.includes("update connections"),
  );
  assert.equal(
    captures.length,
    1,
    "a later SELECT for version is the defect: probe URL and version must come from one row",
  );
  assert.match(captures[0]!, /updated_at/);
  assert.match(captures[0]!, /config/);
  assert.match(captures[0]!, /id/);
  assert.match(captures[0]!, /org_id/);
  assert.match(updateSql(), /updated_at is not distinct from t0/);
});

const refusedConnectorUrls = [
  ["loopback IPv4", { url: "http://127.0.0.1/" }],
  ["localhost", { url: "http://localhost:8069" }],
  ["metadata", { url: "http://169.254.169.254/latest/meta-data/" }],
  ["loopback IPv6", { url: "http://[::1]/" }],
  ["file scheme", { url: "file:///etc/passwd" }],
  ["NetSuite host loopback", { host: "https://127.0.0.1" }],
  ["IPv4-mapped IPv6 hex", { url: "http://[::ffff:7f00:1]/" }],
  ["IPv4-mapped IPv6 dotted", { url: "http://[::ffff:127.0.0.1]/" }],
  ["RFC1918 10.0.0.1", { url: "http://10.0.0.1/" }],
  ["IPv6 ULA fd00::1", { url: "http://[fd00::1]/" }],
  ["unspecified 0.0.0.0", { url: "http://0.0.0.0/" }],
] as const;

for (const [name, config] of refusedConnectorUrls) {
  test(`test skips ping for a ${name} connector URL`, async () => {
    reset();
    routeState.config = { ...config };

    const response = await call();

    assert.equal(response.status, 422);
    const body = (await response.json()) as { errorCode?: string; error?: string };
    assert.equal(body.errorCode, "CONNECTOR_URL_REFUSED");
    assert.match(String(body.error), /loopback|link-local|metadata|http/i);
    assert.equal(routeState.pingCalls, 0, "must not ping a refused connector URL");
    assert.equal(routeState.updates.length, 0, "must not write status for a refused URL");
  });
}
