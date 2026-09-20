import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// PATCH /api/admin/setup/project-types shape-checks billingMethod, name, and
// the invoicing profile, but financialEffectiveFrom rode
// String(b.financialEffectiveFrom ?? today) straight into
// publishProjectFinancialProfileInTransaction, whose DATE check is a bare
// YYYY-MM-DD regex: an impossible date ('2026-02-30') reaches the version
// queries, whose ::date casts throw a raw driver error surfaced as a 422
// with a Postgres message instead of a 400 field error — the same boundary
// already enforced on overhead publish/apply and labor-costing wage dates.

const stateKey = Symbol.for("openbooks.project-types-patch-date-test");
interface RouteState {
  publishInputs: { effectiveFrom: string }[];
}
const state: RouteState = { publishInputs: [] };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

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
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksSqlTextProjectDate = sqlText;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      export async function guardPermission() {
        return {
          user: { orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
          permissions: new Set(['admin.setup.manage']),
          allowedSubsidiaryIds: null,
        };
      }
    `,
  ],
  [
    "mock:db",
    `
      const sqlText = globalThis.openbooksSqlTextProjectDate
      const before = {
        key: 'custom', name: 'Custom', description: null, is_active: true,
        sort_order: 50, billing_method: 'fixed_price',
        invoicing_profile: { billingProcedure: 'standard', allowedBases: ['date_range'] },
        backup_profile: {}, financial_profile: { marker: 'old' },
      }
      export const db = {
        async execute() { return { rows: [] } },
        async transaction(work) {
          return work({
            async execute(query) {
              const text = sqlText(query)
              if (text.includes('from project_types')) return { rows: [structuredClone(before)] }
              if (text.includes('is distinct from')) return { rows: [{ changed: true }] }
              if (text.includes('returning key')) return { rows: [{ key: 'custom' }] }
              return { rows: [] }
            },
          })
        },
      }
    `,
  ],
  [
    "mock:profile",
    `
      const state = globalThis[Symbol.for('openbooks.project-types-patch-date-test')]
      export function canonicalizeProjectFinancialProfile(profile) { return structuredClone(profile) }
      export async function publishProjectFinancialProfileInTransaction(_tx, input) {
        state.publishInputs.push({ effectiveFrom: input.effectiveFrom })
        return { id: 'version-1', effectiveFrom: input.effectiveFrom, effectiveTo: null }
      }
    `,
  ],
  ["mock:date", "export async function businessToday() { return '2026-08-31' }"],
  ["mock:gate", "export async function guardProjectsFeature() { return null }"],
  ["mock:features", "export async function isFeatureEnabled() { return true }"],
  ["mock:params", "export function isUuid(v) { return /^[0-9a-f-]{36}$/.test(String(v)) }"],
]);

const mockUrls = new Map<string, string>([
  ["@/lib/api/json", "mock:json"],
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
  ["@openbooks/engine/src/projects/financial-profile-versions.ts", "mock:profile"],
  ["@openbooks/engine/src/platform/business-date.ts", "mock:date"],
  ["../../../../../lib/authz", "mock:authz"],
  ["../../../../../lib/projects-gate", "mock:gate"],
  ["../../../../../lib/features", "mock:features"],
  ["../../../../../lib/list-params", "mock:params"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    const forwarded = specifier.startsWith("@/")
      ? new URL(`../../../../../${specifier.slice(2)}.ts`, context.parentURL!).href
      : mockUrls.get(specifier);
    if (forwarded) return { url: forwarded, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:json") {
      return {
        format: "module",
        source: `export const jsonObject = {}; export async function parseJsonBody(r) { return { ok: true, data: await r.json() } }`,
        shortCircuit: true,
      };
    }
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?project-types-patch-date-test";
const { PATCH } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const TYPE_ID = "11111111-1111-4111-8111-111111111111";

function patch(body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new Request("http://openbooks.test/api/admin/setup/project-types", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function financialBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TYPE_ID,
    billingMethod: "fixed_price",
    financialProfile: { marker: "new" },
    financialChangeReason: "adopt revised overhead policy",
    ...overrides,
  };
}

test("PATCH refuses an impossible financialEffectiveFrom before publishing", async () => {
  state.publishInputs = [];
  const response = await patch(financialBody({ financialEffectiveFrom: "2026-02-30" }));
  assert.equal(response.status, 422);
  assert.match(String((await response.json()).error), /financialEffectiveFrom/);
  assert.deepEqual(state.publishInputs, [], "no version publish may run for an impossible date");
});

test("PATCH still publishes for a real financialEffectiveFrom", async () => {
  state.publishInputs = [];
  const response = await patch(financialBody({ financialEffectiveFrom: "2026-09-01" }));
  assert.equal(response.status, 200);
  assert.deepEqual(state.publishInputs, [{ effectiveFrom: "2026-09-01" }]);
});
