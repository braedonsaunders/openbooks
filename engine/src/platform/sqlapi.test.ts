import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

interface LoggedQuery {
  text: string;
  params?: unknown[];
}

class GovernedPoolHarness {
  governedConnects = 0;
  requestConnects = 0;
  releases = 0;
  queries: LoggedQuery[] = [];

  reset(): void {
    this.governedConnects = 0;
    this.requestConnects = 0;
    this.releases = 0;
    this.queries = [];
  }

  async connectGovernedReadClient() {
    this.governedConnects += 1;
    return {
      query: async (text: string, params?: unknown[]) => {
        this.queries.push({ text, params });
        const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
        if (normalized === "select * from (select 42 as answer) __q limit 2") {
          return {
            rows: [{ answer: 42 }, { answer: 43 }],
            fields: [{ name: "answer" }],
            rowCount: 2,
          };
        }
        if (normalized.includes("from information_schema.columns")) {
          return {
            rows: [{
              table_name: "accounts",
              table_type: "VIEW",
              column_name: "id",
              data_type: "uuid",
              is_nullable: "NO",
              ordinal_position: 1,
            }],
            fields: [],
            rowCount: 1,
          };
        }
        if (normalized.includes("from pg_roles r")) {
          return { rows: [{ exists: 1 }], fields: [], rowCount: 1 };
        }
        return { rows: [], fields: [], rowCount: 0 };
      },
      release: () => {
        this.releases += 1;
      },
    };
  }

  async connectRequestClient(): Promise<never> {
    this.requestConnects += 1;
    throw new Error("governed SQL attempted to use the ordinary request pool");
  }
}

const harnessKey = Symbol.for("openbooks.sqlapi-governed-pool-test");
const harness = new GovernedPoolHarness();
;(globalThis as typeof globalThis & Record<symbol, unknown>)[harnessKey] = harness;
const stateExpression = `globalThis[Symbol.for('openbooks.sqlapi-governed-pool-test')]`;
const sqlapiUrl = new URL("./sqlapi.ts?governed-pool-boundary-test", import.meta.url).href;
const mockDbUrl = "mock:sqlapi-governed-db";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === sqlapiUrl && specifier === "./db.ts") {
      return { url: mockDbUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url !== mockDbUrl) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: `
        const state = ${stateExpression}
        export function connectGovernedReadClient() {
          return state.connectGovernedReadClient()
        }
        export const pool = {
          connect() { return state.connectRequestClient() }
        }
      `,
    };
  },
});

const {
  ensureReadRole,
  listSchema,
  runUserSql,
  validateUserSql,
} = await import(sqlapiUrl) as typeof import("./sqlapi.ts");
hooks.deregister();

test("query validation preserves PostgreSQL string literals and quoted identifiers", () => {
  const query = `select 'vendor_bill' as kind, "MixedCase" from documents where memo = 'a;b'`;
  assert.equal(validateUserSql(query), query);
});

test("query validation removes only a trailing statement terminator", () => {
  assert.equal(validateUserSql(" select 'expense_report'; "), "select 'expense_report'");
});

test("query validation still rejects multiple statements and write prefixes", () => {
  assert.throws(() => validateUserSql("select 1; select 2"), /one statement/);
  assert.throws(() => validateUserSql("update documents set memo = 'nope'"), /read-only/);
});

test("SQL API operations use only the isolated governed pool", async () => {
  harness.reset();

  const result = await runUserSql("select 42 as answer", {
    orgId: "00000000-0000-4000-8000-000000000001",
    maxRows: 1,
    timeoutMs: 1_234,
  });
  const catalog = await listSchema("00000000-0000-4000-8000-000000000001");
  await ensureReadRole();

  assert.deepEqual(result.rows, [{ answer: 42 }]);
  assert.equal(result.truncated, true);
  assert.equal(result.rowCount, 1);
  assert.deepEqual(catalog, [{
    name: "accounts",
    kind: "view",
    columns: [{ name: "id", type: "uuid", nullable: false }],
  }]);
  assert.equal(harness.governedConnects, 3);
  assert.equal(harness.requestConnects, 0);
  assert.equal(harness.releases, 3);

  const statements = harness.queries.map(({ text }) => text.replace(/\s+/g, " ").trim().toLowerCase());
  assert.equal(statements.filter((text) => text === "begin transaction read only").length, 2);
  assert.equal(statements.filter((text) => text === "set local role openbooks_read").length, 2);
  assert.equal(
    statements.filter((text) => text === "set local search_path = openbooks_query, pg_catalog").length,
    2,
  );
  assert.ok(statements.includes("set local statement_timeout = 1234"));
  assert.ok(statements.includes("select * from (select 42 as answer) __q limit 2"));
  assert.equal(statements.filter((text) => text === "rollback").length, 2);
  assert.equal(
    statements.filter((text) => text === "truncate table pg_temp.openbooks_query_context").length,
    4,
  );
  assert.equal(
    harness.queries.filter(({ text, params }) =>
      text.includes("set_config('app.current_org'")
      && params?.[0] === "00000000-0000-4000-8000-000000000001").length,
    2,
  );
});
