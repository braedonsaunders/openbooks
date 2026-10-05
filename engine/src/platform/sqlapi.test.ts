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
  discarded = 0;
  queries: LoggedQuery[] = [];
  /** Catalog functions the read role can still execute, as has_function_privilege reports them. */
  executableTextFunctions: string[] = [];
  sessionIntact = true;
  /** Base relations the EXPLAIN plan reports. */
  planRelations: string[] = ["accounts"];

  reset(): void {
    this.governedConnects = 0;
    this.requestConnects = 0;
    this.releases = 0;
    this.discarded = 0;
    this.queries = [];
    this.executableTextFunctions = [];
    this.sessionIntact = true;
    this.planRelations = ["accounts"];
  }

  async connectGovernedReadClient() {
    this.governedConnects += 1;
    return {
      query: async (textOrConfig: string | { text: string; values?: unknown[] }, params?: unknown[]) => {
        const text = typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text;
        const values = typeof textOrConfig === "string" ? params : textOrConfig.values;
        this.queries.push({ text, params: values });
        const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
        if (normalized.startsWith("explain")) {
          const plan = [{ Plan: { "Node Type": "Nested Loop", Plans: this.planRelations.map((name) => ({ "Node Type": "Seq Scan", "Relation Name": name })) } }];
          return { rows: [{ "QUERY PLAN": plan }], fields: [], rowCount: 1 };
        }
        if (normalized.includes("from (select 42 as answer) __q") && normalized.includes("__ob_row_bytes")) {
          return {
            rows: [
              { __ob_row_bytes: 13, __ob_row: { answer: 42 } },
              { __ob_row_bytes: 13, __ob_row: { answer: 43 } },
            ],
            fields: [{ name: "__ob_row_bytes" }, { name: "__ob_row" }],
            rowCount: 2,
          };
        }
        if (normalized.includes("from (select 'wide' as payload) __q") && normalized.includes("__ob_row_bytes")) {
          const maxBytes = Number(values?.[1] ?? 0);
          const payload = { payload: "x".repeat(200) };
          const size = Buffer.byteLength(JSON.stringify(payload), "utf8");
          return {
            rows: [{
              __ob_row_bytes: size,
              __ob_row: size > maxBytes ? null : payload,
            }],
            fields: [{ name: "__ob_row_bytes" }, { name: "__ob_row" }],
            rowCount: 1,
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
              is_key: false,
            }],
            fields: [],
            rowCount: 1,
          };
        }
        if (normalized.includes("has_function_privilege(p.oid, 'execute')")) {
          const rows = this.executableTextFunctions.map((fn) => ({ fn }));
          return { rows, fields: [], rowCount: rows.length };
        }
        if (normalized.includes(" as intact")) {
          return { rows: [{ intact: this.sessionIntact }], fields: [], rowCount: 1 };
        }
        if (normalized.includes("from pg_roles r")) {
          return { rows: [{ exists: 1 }], fields: [], rowCount: 1 };
        }
        return { rows: [], fields: [], rowCount: 0 };
      },
      release: (error?: Error) => {
        this.releases += 1;
        if (error) this.discarded += 1;
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
  USER_SQL_MAX_RESULT_BYTES,
  UserSqlRefusal,
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

test("query validation refuses SET, CALL, and DO even after a leading comment", () => {
  assert.throws(() => validateUserSql("set search_path to public"), /read-only/);
  assert.throws(() => validateUserSql("call foo()"), /read-only/);
  assert.throws(() => validateUserSql("do $$ begin null; end $$"), /read-only/);
  assert.throws(() => validateUserSql("/* select 1 */ set search_path to public"), /read-only/);
  assert.throws(() => validateUserSql("-- select 1\ncall foo()"), /read-only/);
});

test("query validation refuses unquoted set_config and keeps dollar-quoted literals", () => {
  assert.throws(
    () => validateUserSql("select set_config('app.current_org', 'x', true)"),
    /set_config/,
  );
  assert.throws(
    () => validateUserSql("select pg_catalog.set_config('app.current_org', 'x', true)"),
    /set_config/,
  );
  const dollarQuoted = "select $foo$set_config('app.current_org', 'x', true)$foo$ as payload";
  assert.equal(validateUserSql(dollarQuoted), dollarQuoted);
});

test("query validation refuses set_config when the name is a quoted identifier", () => {
  assert.throws(
    () => validateUserSql(`select pg_catalog."set_config"('app.current_org', 'x', true)`),
    /set_config/,
  );
  assert.throws(
    () => validateUserSql(`select pg_catalog."SET_CONFIG"('app.bypass_rls', 'on', true)`),
    /set_config/,
  );
});

test("query validation refuses set_config hidden in a Unicode-escaped identifier", () => {
  assert.throws(
    () => validateUserSql(`select U&"set_config"('app.current_org', 'x', true)`),
    /set_config/,
  );
  assert.throws(
    () => validateUserSql(`select pg_catalog.U&"\\0073et_config"('app.current_org', 'x', true)`),
    /set_config/,
  );
  assert.throws(
    () => validateUserSql(`select U&"!0073et_config" UESCAPE '!'('app.bypass_rls', 'on', true)`),
    /set_config/,
  );
  const unicodeString = `select U&'set_config(' as payload`;
  assert.equal(validateUserSql(unicodeString), unicodeString);
});

test("query validation refuses every function that executes SQL held in a string", () => {
  const attempts: Array<[string, RegExp]> = [
    ["select query_to_xml('select set_config(''role'',''none'',true)', false, false, '')", /query_to_xml\(\) is not allowed/],
    [`select PG_CATALOG . "query_to_xml"('select 1', false, false, '')`, /query_to_xml\(\) is not allowed/],
    [`select U&"\\0071uery_to_xml"('select 1', false, false, '')`, /query_to_xml\(\) is not allowed/],
    ["select Query_To_Xml_And_XmlSchema('select 1', false, false, '')", /query_to_xml_and_xmlschema\(\) is not allowed/],
    ["select * from ts_stat('select ''a''::tsvector')", /ts_stat\(\) is not allowed/],
    ["select ts_rewrite('a'::tsquery, 'select ''a''::tsquery, ''b''::tsquery')", /ts_rewrite\(\) is not allowed/],
    ["select s.ts_stat from (select 1) s", /ts_stat\(\) is not allowed/],
    ["select database_to_xml(true, true, '')", /database_to_xml\(\) is not allowed/],
  ];
  for (const [sqlText, refusal] of attempts) assert.throws(() => validateUserSql(sqlText), refusal, sqlText);
  // The names inside literals are data, and longer identifiers are not the functions.
  assert.doesNotThrow(() => validateUserSql("select 'query_to_xml' as label, 1 as ts_stats"));
});

test("runUserSql stays closed while the read role can still execute SQL text, and runs no user SQL", async () => {
  harness.reset();
  harness.executableTextFunctions = ["query_to_xml(text,boolean,boolean,text)"];
  await assert.rejects(
    runUserSql("select 42 as answer", { orgId: "00000000-0000-4000-8000-000000000001" }),
    (error: unknown) => error instanceof UserSqlRefusal && error.status === 409
      && /pg_catalog\.query_to_xml\(text,boolean,boolean,text\)/.test(error.message)
      && /revoke execute on function pg_catalog\.query_to_xml\(text,boolean,boolean,text\) from public/.test(error.message),
  );
  assert.equal(harness.queries.some(({ text }) => text.includes("__ob_row_bytes")), false);
});

test("runUserSql withholds the result and discards the connection when the statement left the governed session", async () => {
  harness.reset();
  harness.sessionIntact = false;
  await assert.rejects(
    runUserSql("select 42 as answer", { orgId: "00000000-0000-4000-8000-000000000001" }),
    (error: unknown) => error instanceof UserSqlRefusal && /changed the session role or organization scope/.test(error.message),
  );
  assert.equal(harness.discarded, 1);
});

test("payroll relations need payroll.read, however the query reaches them", async () => {
  harness.reset();
  harness.planRelations = ["accounts", "pay_stubs", "employee_pay_components", "pay_applications"];
  await assert.rejects(
    runUserSql("select * from v", { orgId: "00000000-0000-4000-8000-000000000001" }),
    (error: unknown) => error instanceof UserSqlRefusal && error.status === 403
      && /requires the payroll\.read permission: this query reads employee_pay_components, pay_stubs\./.test(error.message),
  );
  assert.equal(harness.queries.some(({ text }) => text.includes("__ob_row_bytes") && !text.startsWith("explain")), false);

  harness.reset();
  harness.planRelations = ["pay_stubs"];
  const granted = await runUserSql("select 42 as answer", { orgId: "00000000-0000-4000-8000-000000000001", payrollRead: true });
  assert.equal(granted.rowCount, 2);
  assert.equal(harness.queries.some(({ text }) => text.startsWith("explain")), false);
});

test("query validation still sees statements after a dollar-quote closer hidden in a comment", () => {
  assert.throws(
    () => validateUserSql("select $x$ /* $x$ ) __q; set search_path to public; select 1 */"),
    /one statement|read-only/,
  );
  assert.throws(
    () => validateUserSql("select $x$ /* $x$ ) __q; call foo(); select 1 */"),
    /one statement|read-only/,
  );
  assert.throws(
    () => validateUserSql("select $x$ /* $x$ ) __q; do $$ begin null; end $$; select 1 */"),
    /one statement|read-only/,
  );
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
    columns: [{ name: "id", type: "uuid", nullable: false, isKey: false }],
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
  const userQuery = harness.queries.find(({ text }) => text.includes("__ob_row_bytes") && !text.startsWith("explain"));
  assert.ok(userQuery, "governed user SQL must go through the measured wrapper");
  assert.match(userQuery!.text, /row_to_json/);
  assert.match(userQuery!.text, /limit \$1::pg_catalog\.int4/);
  assert.match(userQuery!.text, /\$2::pg_catalog\.int8/);
  assert.match(userQuery!.text, /then null/);
  assert.deepEqual(userQuery!.params, [2, USER_SQL_MAX_RESULT_BYTES]);
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

test("runUserSql refuses a result that exceeds the caller byte budget", async () => {
  harness.reset();
  await assert.rejects(
    runUserSql("select 'wide' as payload", {
      orgId: "00000000-0000-4000-8000-000000000001",
      maxBytes: 40,
    }),
    /query result exceeds 40 bytes/,
  );
  const allowed = await runUserSql("select 'wide' as payload", {
    orgId: "00000000-0000-4000-8000-000000000001",
    maxBytes: 4_096,
  });
  assert.equal(allowed.rowCount, 1);
  assert.equal(typeof allowed.rows[0]?.payload, "string");
});
