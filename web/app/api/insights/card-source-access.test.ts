import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import type { Authz } from "@/lib/authz";

interface AccessState {
  authz: {
    user: { id: string; orgId: string; isSuperAdmin: boolean };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  };
  disabledFeatures: Set<string>;
  card: Record<string, unknown> | null;
}

const state: AccessState = {
  authz: {
    user: { id: "user-1", orgId: "org-1", isSuperAdmin: false },
    permissions: new Set(["insights.read"]),
    allowedSubsidiaryIds: null,
  },
  disabledFeatures: new Set(),
  card: {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Payroll summary",
    description: null,
    query: { source: "pay_stubs" },
    viz_type: "table",
    viz_settings: {},
    status: "published",
    allowed_roles: null,
    updated_at: "2026-01-01T00:00:00Z",
  },
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[
  Symbol.for("openbooks.insight-source-access-test")
] = state;
(globalThis as typeof globalThis & Record<string, unknown>).openbooksInsightSourceAccessSql = sql;

const modules = new Map<string, string>([
  [
    "mock:authz",
    `
    const state = globalThis[Symbol.for('openbooks.insight-source-access-test')]
    export async function getAuthz() { return state.authz }
    export function can(authz, permission) {
      return authz.permissions.has('*') || authz.permissions.has(permission) || authz.permissions.has(permission.split('.')[0] + '.*')
    }
  `,
  ],
  [
    "mock:features",
    `
    const state = globalThis[Symbol.for('openbooks.insight-source-access-test')]
    export async function isFeatureEnabled(_orgId, key) { return !state.disabledFeatures.has(key) }
    export async function orgFeatureState() { return {} }
    export function featureEnabled(_features, key) { return !state.disabledFeatures.has(key) }
  `,
  ],
  [
    "mock:insight-access",
    `
    const sql = globalThis.openbooksInsightSourceAccessSql
    export function insightVisibilitySql() { return sql\`true\` }
  `,
  ],
  [
    "mock:db",
    `
    const state = globalThis[Symbol.for('openbooks.insight-source-access-test')]
    export const db = { async execute(_query, mode) { const inMode = (result) => (mode === 'objects' ? result.rows : result); return inMode({ rows: state.card ? [state.card] : [] }) } }
  `,
  ],
]);

const urls = new Map<string, string>([
  ["@/lib/authz", "mock:authz"],
  ["@/lib/features", "mock:features"],
  ["@/lib/insight-access", "mock:insight-access"],
  ["@openbooks/engine/platform/db", "mock:db"],
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = urls.get(specifier);
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = modules.get(url);
    return source === undefined
      ? nextLoad(url, context)
      : { format: "module", source, shortCircuit: true };
  },
});
const insightModuleUrl: string = "./_lib.ts?source-access-test";
type InsightModule = typeof import("./_lib.ts");
const { guardInsightCardQuery, loadCard, visibleInsightSourceKeys } = (await import(
  insightModuleUrl
)) as InsightModule;
hooks.deregister();

function setPermissions(...permissions: string[]) {
  state.authz = { ...state.authz, permissions: new Set(["insights.read", ...permissions]) };
}

test("direct card loads hide source permission requirements", async () => {
  setPermissions();
  assert.equal(await loadCard(String(state.card?.id), "org-1"), null);
  const denied = await guardInsightCardQuery(state.authz as unknown as Authz, state.card?.query);
  assert.equal(denied?.status, 403);
  assert.match(await denied!.text(), /payroll\.read/);
});

test("direct card loads hide source features that are switched off", async () => {
  setPermissions("payroll.read");
  state.disabledFeatures = new Set(["payroll"]);
  assert.equal(await loadCard(String(state.card?.id), "org-1"), null);
  const denied = await guardInsightCardQuery(state.authz as unknown as Authz, state.card?.query);
  assert.equal(denied?.status, 403);
  assert.match(await denied!.text(), /payroll feature is disabled/);
});

test("permitted sources remain visible to card loaders and source pickers", async () => {
  setPermissions("payroll.read");
  state.disabledFeatures.clear();
  assert.ok(await loadCard(String(state.card?.id), "org-1"));
  assert.equal(
    await guardInsightCardQuery(state.authz as unknown as Authz, state.card?.query),
    null,
  );
  assert.ok(
    (await visibleInsightSourceKeys(state.authz as unknown as Authz)).includes("pay_stubs"),
  );

  state.disabledFeatures = new Set(["payroll"]);
  assert.ok(
    !(await visibleInsightSourceKeys(state.authz as unknown as Authz)).includes("pay_stubs"),
  );
});
