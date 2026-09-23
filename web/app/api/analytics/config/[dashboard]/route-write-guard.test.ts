import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Unit regression for the dashboard-config write guard: an UPDATE that
// matches zero rows (an RLS-hidden org row reports success with no effect)
// must refuse with a named 409 and write no audit evidence. Only the
// database is doubled — validation and money stay real, because a double of
// a pure function can only drift from the refusals it is meant to prove.

const stateKey = Symbol.for("openbooks.analytics-config-write-guard-test");
interface RouteState {
  executed: string[];
  updateRowCount: number;
}
const state: RouteState = { executed: [], updateRowCount: 1 };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

/** Flatten drizzle SQL chunks into text for deterministic scripted replies. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      const value = (chunk as { value?: unknown[] })?.value;
      if (Array.isArray(value)) return value.map(String).join("");
      if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return sqlText(chunk);
      return "";
    })
    .join("");
}
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksAnalyticsConfigSqlText = sqlText;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      export async function guardPermission() {
        return { user: { orgId: 'org-1', id: 'user-1' } }
      }
    `,
  ],
  [
    "mock:features",
    `
      export async function isFeatureEnabled() {
        return true
      }
    `,
  ],
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.analytics-config-write-guard-test')]
      const sqlText = globalThis.openbooksAnalyticsConfigSqlText
      const execute = async (query) => {
        const text = sqlText(query)
        state.executed.push(text)
        if (text.includes('for update')) {
          return { rows: [{ cfg: null, rev: 0 }], rowCount: 1 }
        }
        if (text.includes('update orgs')) {
          return { rows: [], rowCount: state.updateRowCount }
        }
        if (text.includes('insert into audit_log')) {
          return { rows: [], rowCount: 1 }
        }
        throw new Error('unexpected database query: ' + text)
      }
      export const db = {
        execute,
        transaction: async (work) => work({ execute }),
      }
    `,
  ],
]);

// Neither '@/lib/api/json', the decimal classifier, nor the money kernel is
// mocked: hand doubles of validation and money cannot produce the refusals
// the real modules enforce, so every bad-body case behind them would report
// green untested.
const mockUrls = new Map<string, string>([
  ["../../../../../lib/authz", "mock:authz"],
  ["../../../../../lib/features", "mock:features"],
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
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

const routeUrl = "./route.ts?analytics-config-write-guard-test";
const { PUT } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

function reset(updateRowCount: number): void {
  state.executed = [];
  state.updateRowCount = updateRowCount;
}

function put(body: Record<string, unknown>): Promise<Response> {
  return PUT(
    new Request("http://openbooks.test/api/analytics/config/sentinel", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ dashboard: "sentinel" }) },
  );
}

const VALID = {
  duplicateDays: 14,
  duplicateMinAmount: 100,
  sequentialMinCount: 3,
  sequentialMinDays: 7,
};

test("a zero-row update refuses with a named 409 and writes no audit", async () => {
  reset(0);

  const response = await put({ expectedRevision: 0, values: VALID });

  assert.equal(response.status, 409);
  assert.match(((await response.json()) as { error: string }).error, /was not saved/);
  assert.ok(
    state.executed.some((query) => query.includes("update orgs")),
    "the settings mutation was attempted",
  );
  assert.ok(
    !state.executed.some((query) => query.includes("insert into audit_log")),
    "a refused write must leave no audit evidence",
  );
});

test("a refused payload never reaches the database at all", async () => {
  reset(1);

  const response = await put({
    expectedRevision: 0,
    values: { ...VALID, duplicateDays: "bad" },
  });

  assert.equal(response.status, 422);
  assert.match(((await response.json()) as { error: string }).error, /duplicateDays/);
  assert.deepEqual(state.executed, [], "validation runs before any lock or write");
});
