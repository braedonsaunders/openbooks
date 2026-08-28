import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Route-boundary regression for fnd_mtcb44tn_fbugz4: an account idempotency
// key identifies one exact create request. A replay of the same request is a
// success, while reusing that key for a changed chart-of-accounts request is
// a conflict and must never return the older account as though it matched.
const stateKey = Symbol.for("openbooks.accounts-route-test");
const ORG_ID = "00000000-0000-4000-8000-00000000a001";
const USER_ID = "00000000-0000-4000-8000-00000000a002";

interface AccountRow {
  id: string;
  org_id: string;
  number: string | null;
  name: string;
  type: string;
  description: string | null;
  parent_id: string | null;
  is_summary: boolean;
  is_active: boolean;
  currency_restriction: string | null;
  eliminate: boolean;
  subsidiary_id: string | null;
  subsidiary_include_children: boolean;
  reconcilable: boolean;
  monetary: boolean | null;
  required_dimensions: string[];
  custom: Record<string, unknown>;
}

interface RouteState {
  requestKey: string | null;
  requestBody: Record<string, unknown> | null;
  account: AccountRow | null;
  auditAfter: AccountRow | null;
  loadAccountCalls: number;
  transactionQueries: string[];
  queries: string[];
}

const state: RouteState = {
  requestKey: null,
  requestBody: null,
  account: null,
  auditAfter: null,
  loadAccountCalls: 0,
  transactionQueries: [],
  queries: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      const value = (chunk as { value?: unknown[] })?.value;
      if (Array.isArray(value)) return value.map(String).join("");
      return (chunk as { queryChunks?: unknown[] })?.queryChunks
        ? sqlText(chunk)
        : "";
    })
    .join("");
}

(
  globalThis as typeof globalThis & Record<string, unknown>
).openbooksAccountsSqlText = sqlText;

const mockSources = new Map<string, string>([
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.accounts-route-test')]
      const sqlText = globalThis.openbooksAccountsSqlText
      function respond(query) {
        const text = sqlText(query)
        if (text.includes('insert into accounts')) {
          if (state.account) return { rows: [] }
          state.account = {
            id: state.requestKey,
            org_id: '${ORG_ID}',
            number: null,
            name: state.requestBody.name.trim(),
            type: state.requestBody.type,
            description: null,
            parent_id: null,
            is_summary: false,
            is_active: true,
            currency_restriction: null,
            eliminate: false,
            subsidiary_id: null,
            subsidiary_include_children: true,
            reconcilable: false,
            monetary: null,
            required_dimensions: [],
            custom: {},
          }
          state.auditAfter = { ...state.account }
          return { rows: [{ id: state.requestKey }] }
        }
        if (text.includes('from audit_log')) return { rows: state.auditAfter ? [{ after: state.auditAfter }] : [] }
        if (text.includes('from accounts')) return { rows: state.account ? [state.account] : [] }
        return { rows: [] }
      }
      export const db = {
        execute: async (query) => {
          state.queries.push(sqlText(query))
          return respond(query)
        },
        transaction: async (work) => work({
          execute: async (query) => {
            state.transactionQueries.push(sqlText(query))
            return respond(query)
          },
        }),
      }
    `,
  ],
  [
    "mock:authz",
    `export async function guardPermission() {
       return { user: { orgId: '${ORG_ID}', id: '${USER_ID}' } }
     }`,
  ],
  [
    "mock:features",
    "export async function isFeatureEnabled() { return true }\nexport async function subsidiaryFeatureEnabled() { return true }",
  ],
  [
    "mock:custom-fields",
    `export async function loadFieldDefs() { return [] }
     export function validateCustomValues(_defs, values) { return { ok: true, cleaned: values } }`,
  ],
  [
    "mock:list-params",
    "export function isUuid(value) { return /^[0-9a-f-]{36}$/i.test(value) }",
  ],
  [
    "mock:json",
    `export const jsonObject = {}
     export async function parseJsonBody(request) { return { ok: true, data: await request.json() } }`,
  ],
  [
    "mock:accounts-lib",
    `export async function loadAccount(id, orgId) {
       const state = globalThis[Symbol.for('openbooks.accounts-route-test')]
       state.loadAccountCalls += 1
       if (!state.account || state.account.id !== id || state.account.org_id !== orgId) return null
       return { id: state.account.id, name: state.account.name, type: state.account.type }
     }`,
  ],
  [
    "mock:schema",
    "export const ACCOUNT_TYPES = ['asset_other', 'income', 'expense']",
  ],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/src/db.ts", "mock:db"],
  ["@openbooks/schema", "mock:schema"],
  ["@/lib/api/json", "mock:json"],
  ["../../../lib/authz", "mock:authz"],
  ["../../../lib/features", "mock:features"],
  ["../../../lib/custom-fields", "mock:custom-fields"],
  ["../../../lib/list-params", "mock:list-params"],
  ["./_lib", "mock:accounts-lib"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@openbooks/engine/src/canonical-json.ts") {
      return {
        url: new URL(
          "../../../../engine/src/canonical-json.ts",
          import.meta.url,
        ).href,
        shortCircuit: true,
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

const routeUrl = "./route.ts?accounts-idempotency-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

function reset(): void {
  state.requestKey = null;
  state.requestBody = null;
  state.account = null;
  state.auditAfter = null;
  state.loadAccountCalls = 0;
  state.transactionQueries.length = 0;
  state.queries.length = 0;
}

function post(key: string, body: Record<string, unknown>): Promise<Response> {
  state.requestKey = key;
  state.requestBody = body;
  return POST(
    new Request("http://openbooks.test/api/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body),
    }),
  );
}

test("account creation replays only the exact request for an idempotency key", async () => {
  reset();
  const key = "00000000-0000-4000-8000-00000000a004";
  const original = { name: "Operating cash", type: "asset_other" };

  const created = await post(key, original);
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), {
    id: key,
    name: "Operating cash",
    type: "asset_other",
  });

  const replay = await post(key, original);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), {
    id: key,
    name: "Operating cash",
    type: "asset_other",
  });

  const changed = await post(key, {
    name: "Operating revenue",
    type: "income",
  });
  assert.equal(changed.status, 409);
  assert.deepEqual(await changed.json(), { error: "invalid_idempotency_key" });
  assert.equal(
    state.loadAccountCalls,
    2,
    "a changed replay must not load and return the stale account",
  );
});
