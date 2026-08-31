import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Route-boundary regressions for project-type financial policy publication.
// The scripted transaction fake keeps the test deterministic without requiring
// a shared PostgreSQL instance, while still making rollback, effective-dated
// history, and audit evidence observable.
const stateKey = Symbol.for("openbooks.project-types-route-test");

interface Version {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  financialProfile: Record<string, unknown>;
  reason: string;
}

interface Audit {
  action: string;
  changes: Record<string, unknown>;
}

interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
  today: string;
  projectTypeId: string;
  currentProfile: Record<string, unknown>;
  versions: Version[];
  audits: Audit[];
  stagedVersions: Version[] | null;
  stagedAudits: Audit[];
  publishInputs: { effectiveFrom: string; reason: string }[];
  nextVersion: number;
  txCalls: number;
}

const routeState: RouteState = {
  authz: null,
  today: "2026-08-31",
  projectTypeId: "11111111-1111-4111-8111-111111111111",
  currentProfile: { marker: "old" },
  versions: [],
  audits: [],
  stagedVersions: null,
  stagedAudits: [],
  publishInputs: [],
  nextVersion: 1,
  txCalls: 0,
};
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

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

function sqlParams(query: unknown): string[] {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return [];
  const out: string[] = [];
  for (const chunk of chunks) {
    if (typeof chunk === "string") {
      out.push(chunk);
      continue;
    }
    if ((chunk as { queryChunks?: unknown[] })?.queryChunks) {
      out.push(...sqlParams(chunk));
      continue;
    }
    const value = (chunk as { value?: unknown })?.value;
    if (!Array.isArray(value)) out.push(String(value));
  }
  return out;
}

;(globalThis as typeof globalThis & Record<string, unknown>).openbooksSqlText = sqlText;
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksSqlParams = sqlParams;

const mockSources = new Map<string, string>([
  [
    "mock:project-types-authz",
    `
      const state = globalThis[Symbol.for('openbooks.project-types-route-test')]
      export async function guardPermission(_permission) {
        if (!state.authz) return new Response(null, { status: 403 })
        return state.authz
      }
    `,
  ],
  [
    "mock:project-types-db",
    `
      const state = globalThis[Symbol.for('openbooks.project-types-route-test')]
      const sqlText = globalThis.openbooksSqlText
      const sqlParams = globalThis.openbooksSqlParams
      const clone = (value) => structuredClone(value)

      function txExecute(query) {
        state.txCalls += 1
        const text = sqlText(query)
        if (state.txCalls === 1) {
          return { rows: [{
            key: 'custom', name: 'Custom', description: null, is_active: true,
            sort_order: 50, billing_method: 'time_and_materials',
            invoicing_profile: { billingProcedure: 'standard', allowedBases: ['date_range'] },
            backup_profile: {}, financial_profile: clone(state.currentProfile),
          }] }
        }
        if (text.includes('is distinct from')) return { rows: [{ changed: true }] }
        if (text.includes('returning key')) {
          return { rows: [{ key: 'custom', name: 'Custom', description: null, is_active: true,
            sort_order: 50, billing_method: 'time_and_materials',
            invoicing_profile: { billingProcedure: 'standard', allowedBases: ['date_range'] },
            backup_profile: {} }] }
        }
        if (text.includes('insert into audit_log')) {
          const params = sqlParams(query)
          const json = params.find((value) => value.startsWith('{'))
          state.stagedAudits.push({
            action: 'update',
            changes: json ? JSON.parse(json) : {},
          })
        }
        return { rows: [] }
      }

      export const db = {
        execute: async (_query) => ({ rows: [] }),
        transaction: async (work) => {
          state.txCalls = 0
          state.stagedVersions = clone(state.versions)
          state.stagedAudits = []
          try {
            const result = await work({ execute: async (query) => txExecute(query) })
            state.versions = state.stagedVersions
            state.audits.push(...state.stagedAudits)
            return result
          } finally {
            state.stagedVersions = null
            state.stagedAudits = []
          }
        },
      }
    `,
  ],
  [
    "mock:project-types-financial-profile",
    `
      const state = globalThis[Symbol.for('openbooks.project-types-route-test')]
      function previousDay(iso) {
        const date = new Date(iso + 'T00:00:00.000Z')
        date.setUTCDate(date.getUTCDate() - 1)
        return date.toISOString().slice(0, 10)
      }
      export function canonicalizeProjectFinancialProfile(profile) {
        return structuredClone(profile)
      }
      export async function publishProjectFinancialProfileInTransaction(_tx, input) {
        state.publishInputs.push({ effectiveFrom: input.effectiveFrom, reason: input.reason })
        const parsedDate = new Date(input.effectiveFrom + 'T00:00:00.000Z')
        if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(input.effectiveFrom)
          || Number.isNaN(parsedDate.getTime())
          || parsedDate.toISOString().slice(0, 10) !== input.effectiveFrom) {
          throw new Error('effectiveFrom must be YYYY-MM-DD')
        }
        const versions = state.stagedVersions
        const prior = versions.find((version) => version.effectiveTo === null)
        if (prior) prior.effectiveTo = previousDay(input.effectiveFrom)
        const version = {
          id: 'version-' + state.nextVersion++,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: null,
          financialProfile: structuredClone(input.financialProfile),
          reason: input.reason,
        }
        versions.push(version)
        state.stagedAudits.push({
          action: 'insert',
          changes: { after: { effectiveFrom: version.effectiveFrom, effectiveTo: version.effectiveTo } },
        })
        return { id: version.id, effectiveFrom: version.effectiveFrom, effectiveTo: version.effectiveTo }
      }
    `,
  ],
  [
    "mock:project-types-business-date",
    `
      const state = globalThis[Symbol.for('openbooks.project-types-route-test')]
      export async function businessToday(_orgId) { return state.today }
    `,
  ],
  [
    "mock:project-types-gate",
    "export async function guardProjectsFeature(_orgId) { return null }",
  ],
  [
    "mock:project-types-features",
    "export async function isFeatureEnabled(_orgId, _key) { return true }",
  ],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(new URL(`../../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    if (context.parentURL?.includes("setup/project-types")) {
      const modules: Record<string, string> = {
        "@openbooks/engine/src/db.ts": "mock:project-types-db",
        "@openbooks/engine/src/project-financial-profile-versions.ts": "mock:project-types-financial-profile",
        "@openbooks/engine/src/business-date.ts": "mock:project-types-business-date",
        "../../../../../lib/authz": "mock:project-types-authz",
        "../../../../../lib/projects-gate": "mock:project-types-gate",
        "../../../../../lib/features": "mock:project-types-features",
      };
      const url = modules[specifier];
      if (url) return { url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?project-types-boundary-test";
const { PATCH } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

function resetState(): void {
  routeState.authz = {
    user: { orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    permissions: new Set(["admin.setup.manage"]),
    allowedSubsidiaryIds: null,
  };
  routeState.currentProfile = { marker: "old" };
  routeState.versions = [{
    id: "initial",
    effectiveFrom: "2026-08-01",
    effectiveTo: null,
    financialProfile: { marker: "old" },
    reason: "Initial project policy",
  }];
  routeState.audits = [{ action: "insert", changes: { after: { effectiveFrom: "2026-08-01" } } }];
  routeState.stagedVersions = null;
  routeState.stagedAudits = [];
  routeState.publishInputs = [];
  routeState.nextVersion = 1;
  routeState.txCalls = 0;
}

function patchRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/admin/setup/project-types", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patchBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: routeState.projectTypeId,
    billingMethod: "time_and_materials",
    financialProfile: { marker: "new" },
    financialChangeReason: "Update project policy",
    ...overrides,
  };
}

test("PATCH defaults an omitted financial date to businessToday and records history/audit evidence", async () => {
  resetState();
  const response = await PATCH(patchRequest(patchBody()));

  assert.equal(response.status, 200);
  assert.deepEqual(routeState.publishInputs[0], {
    effectiveFrom: routeState.today,
    reason: "Update project policy",
  });
  assert.deepEqual(routeState.versions.map(({ id, effectiveFrom, effectiveTo }) => ({ id, effectiveFrom, effectiveTo })), [
    { id: "initial", effectiveFrom: "2026-08-01", effectiveTo: "2026-08-30" },
    { id: "version-1", effectiveFrom: "2026-08-31", effectiveTo: null },
  ]);
  const projectAudit = routeState.audits.at(-1)!;
  assert.equal(projectAudit.action, "update");
  assert.equal((projectAudit.changes.financialProfileVersion as { effectiveFrom: string }).effectiveFrom, routeState.today);
});

test("PATCH preserves an explicit future financial date and append-only history", async () => {
  resetState();
  const response = await PATCH(patchRequest(patchBody({ financialEffectiveFrom: "2026-09-15" })));

  assert.equal(response.status, 200);
  assert.equal(routeState.publishInputs[0]!.effectiveFrom, "2026-09-15");
  assert.equal(routeState.versions[0]!.effectiveTo, "2026-09-14");
  assert.equal(routeState.versions[1]!.effectiveFrom, "2026-09-15");
  assert.equal(routeState.audits.length, 3);
  assert.equal(
    (routeState.audits.at(-1)!.changes.financialProfileVersion as { effectiveFrom: string }).effectiveFrom,
    "2026-09-15",
  );
});

test("PATCH rejects an invalid financial date without publishing or auditing partial history", async () => {
  for (const invalidDate of ["", "2026-02-30"]) {
    resetState();
    const versionsBefore = structuredClone(routeState.versions);
    const auditsBefore = structuredClone(routeState.audits);
    const response = await PATCH(patchRequest(patchBody({ financialEffectiveFrom: invalidDate })));

    assert.equal(response.status, 422, `expected invalid date ${JSON.stringify(invalidDate)} to fail`);
    assert.deepEqual(routeState.versions, versionsBefore);
    assert.deepEqual(routeState.audits, auditsBefore);
    assert.equal(routeState.txCalls, 2);
  }
});
