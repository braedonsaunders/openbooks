import assert from "node:assert/strict";
import { stubModules } from "../../../../../testing/stub-modules";
import test from "node:test";

// Project-type publication rejects impossible effective dates at the request
// boundary so PostgreSQL never receives an invalid DATE and no version or
// audit history is written.

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

// '@/lib/api/json' is not mocked here: never double the validation boundary.
// The resolve hook's @/ forwarder already maps it to the real module.

stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "@openbooks/engine/src/platform/db.ts": `
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
    "@openbooks/engine/src/projects/financial-profile-versions.ts": `
      const state = globalThis[Symbol.for('openbooks.project-types-patch-date-test')]
      export function canonicalizeProjectFinancialProfile(profile) { return structuredClone(profile) }
      export function assertValidProjectFinancialProfile(_profile) {}
      export async function publishProjectFinancialProfileInTransaction(_tx, input) {
        state.publishInputs.push({ effectiveFrom: input.effectiveFrom })
        return { id: 'version-1', effectiveFrom: input.effectiveFrom, effectiveTo: null }
      }
    `,
    "@openbooks/engine/src/platform/business-date.ts": "export async function businessToday() { return '2026-08-31' }",
    "../../../../../lib/authz": `
      export async function guardPermission() {
        return {
          user: { orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
          permissions: new Set(['admin.setup.manage']),
          allowedSubsidiaryIds: null,
        };
      }
      export function guardUnrestrictedScope() { return null; }
    `,
    "@/lib/authz": `
      export async function guardPermission() {
        return {
          user: { orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
          permissions: new Set(['admin.setup.manage']),
          allowedSubsidiaryIds: null,
        };
      }
      export function guardUnrestrictedScope() { return null; }
    `,
    "../../../../../lib/projects-gate": "export async function guardProjectsFeature() { return null }",
    "../../../../../lib/features": "export async function isFeatureEnabled() { return true }",
  },
});

const routeUrl = "./route.ts?project-types-patch-date-test";
const { PATCH } = (await import(routeUrl)) as typeof import("./route.ts");

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
