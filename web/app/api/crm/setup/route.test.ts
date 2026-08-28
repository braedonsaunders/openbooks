import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// CRM setup is a collection of small mutations, but each one must commit its
// audit evidence atomically. This scripted database keeps the transaction
// ledger separate from committed writes so an audit failure proves rollback,
// rather than merely proving that the route attempted the insert.
const stateKey = Symbol.for("openbooks.crm-setup-route-test");
interface RouteState {
  executed: string[];
  committed: string[];
  pending: string[];
  outsideWrites: string[];
  inTx: boolean;
  failAudit: boolean;
  auditSeenInTx: boolean;
}
const state: RouteState = {
  executed: [],
  committed: [],
  pending: [],
  outsideWrites: [],
  inTx: false,
  failAudit: false,
  auditSeenInTx: false,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

/** Flatten a drizzle SQL chunk into raw text for scripted replies. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((chunk) => {
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
).openbooksSqlTextCrmSetup = sqlText;

const ORG_ID = "00000000-0000-4000-8000-00000000a001";
const USER_ID = "00000000-0000-4000-8000-00000000a002";
const ROW_ID = "00000000-0000-4000-8000-00000000a003";

const mockSources = new Map<string, string>([
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.crm-setup-route-test')]
      const sqlText = globalThis.openbooksSqlTextCrmSetup
      const isMutation = (text) =>
        text.includes('insert into crm_') ||
        text.includes('update crm_') ||
        text.includes('delete from crm_') ||
        text.includes('insert into audit_log')
      export const db = {
        async execute(query) {
          const text = sqlText(query)
          state.executed.push(text)
          if (state.failAudit && text.includes('insert into audit_log')) {
            state.auditSeenInTx = state.inTx
            throw new Error('forced audit storage failure')
          }
          if (text.includes('insert into audit_log')) state.auditSeenInTx = state.inTx
          if (text.includes('select 1 from users')) return { rows: [{ one: 1 }] }
          if (text.includes('select 1 from currencies')) return { rows: [{ one: 1 }] }
          if (text.includes('select 1 from crm_sales_teams')) return { rows: [{ one: 1 }] }
          if (text.includes('select base_currency from orgs')) return { rows: [{ base_currency: 'CAD' }] }
          if (isMutation(text)) {
            const ledger = state.inTx ? state.pending : state.outsideWrites
            ledger.push(text)
            if (text.includes('returning *')) return { rows: [{ id: '${ROW_ID}', name: 'saved' }] }
          }
          return { rows: [] }
        },
        transaction: async (work) => work({}),
      }
      export async function withOrgTransaction(_orgId, work) {
        if (state.inTx) return work()
        state.inTx = true
        state.pending = []
        try {
          const result = await work()
          state.committed.push(...state.pending)
          return result
        } catch (error) {
          state.pending = []
          throw error
        } finally {
          state.inTx = false
        }
      }
      export async function withOrg(_orgId, work) { return work() }
      export async function withOrgContext(_orgId, work) { return work() }
      export async function withBypass(work) { return work() }
      export async function withBypassContext(_opts, work) { return work() }
      export const pool = {}
      export const env = {}
      export const schema = {}
      export function registerRequestOrgResolver() {}
    `,
  ],
  ["mock:crm", `export async function ensureCrmDefaults() {}`],
  [
    "mock:feature-gates",
    `
      export async function guardFeaturePermission() {
        return { user: { orgId: '${ORG_ID}', id: '${USER_ID}' } }
      }
    `,
  ],
  ["mock:features", `export async function isFeatureEnabled() { return true }`],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/src/db.ts", "mock:db"],
  ["@openbooks/engine/src/crm.ts", "mock:crm"],
  ["../../../../lib/feature-gates", "mock:feature-gates"],
  ["../../../../lib/features", "mock:features"],
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
    if (specifier.startsWith("@/lib/") && context.parentURL) {
      return nextResolve(
        new URL(`../../../../${specifier.slice(2)}.ts`, context.parentURL).href,
        context,
      );
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined)
      return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?crm-setup-route-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

function reset(): void {
  state.executed = [];
  state.committed = [];
  state.pending = [];
  state.outsideWrites = [];
  state.inTx = false;
  state.failAudit = false;
  state.auditSeenInTx = false;
}

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("http://openbooks.test/api/crm/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as unknown as Parameters<typeof POST>[0],
  );
}

const actions: Array<[string, Record<string, unknown>, string]> = [
  [
    "account status",
    {
      action: "save-account-status",
      key: "custom",
      name: "Custom lead",
      lifecycleStage: "lead",
    },
    "crm_account_statuses",
  ],
  [
    "opportunity status",
    {
      action: "save-opportunity-status",
      key: "custom",
      name: "Custom opportunity",
      probability: 40,
      defaultForecastCategory: "upside",
    },
    "crm_opportunity_statuses",
  ],
  [
    "lead source",
    { action: "save-lead-source", key: "web", name: "Website" },
    "crm_lead_sources",
  ],
  [
    "territory",
    {
      action: "save-territory",
      key: "east",
      name: "East",
      rules: [],
      matchMode: "all",
    },
    "crm_sales_territories",
  ],
  [
    "team",
    {
      action: "save-team",
      key: "sales",
      name: "Sales",
      members: [{ userId: USER_ID, role: "member" }],
    },
    "crm_sales_teams",
  ],
  [
    "quota",
    {
      action: "save-quota",
      ownerUserId: USER_ID,
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
      amount: "1000.25",
    },
    "crm_sales_quotas",
  ],
];

for (const [label, body, table] of actions) {
  test(`${label} commits with audit evidence in one transaction`, async () => {
    reset();

    const response = await post(body);

    assert.equal(response.status, 200);
    assert.ok(
      state.committed.some((text) => text.includes(`insert into ${table}`)),
    );
    assert.ok(
      state.committed.some((text) => text.includes("insert into audit_log")),
    );
    assert.equal(state.outsideWrites.length, 0);
    assert.equal(state.auditSeenInTx, true);
  });

  test(`${label} rolls back its mutation when audit storage fails`, async () => {
    reset();
    state.failAudit = true;

    await assert.rejects(() => post(body), /forced audit storage failure/);

    assert.equal(
      state.committed.length,
      0,
      "the setup write did not commit without evidence",
    );
    assert.equal(
      state.outsideWrites.length,
      0,
      "no setup write escaped the transaction",
    );
    assert.ok(
      state.executed.some((text) => text.includes(`insert into ${table}`)),
    );
    assert.equal(state.auditSeenInTx, true);
    assert.equal(state.inTx, false);
  });
}
