import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// A8 ReportDriverRunner: actor binding, params refusal, and the full
// definition → period → execute → extract path (empty ledger in a scratch
// org yields an empty vector, never an error).

const mockIntl = `
  export async function getTranslations() { return (key) => key }
  export function useTranslations() { return (key) => key }
`;

// The report chain resolves the tenant from the request session; tests pin
// it explicitly. Scoped to the fiscal parent so nothing else is affected.
const mockOrgScope = `
  const state = globalThis[Symbol.for('openbooks.alloc-report-runner-test')]
  export async function resolveOrgId(orgId) {
    if (orgId) return orgId
    if (!state.orgId) throw new Error('active organization is required')
    return state.orgId
  }
`;

const stateKey = Symbol.for("openbooks.alloc-report-runner-test");
const shared: { orgId: string | null } = { orgId: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = shared;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "next-intl/server") {
      return { url: "mock:alloc-intl", shortCircuit: true };
    }
    if (specifier === "./org-scope" && String(context.parentURL ?? "").endsWith("lib/fiscal.ts")) {
      return { url: "mock:alloc-org-scope", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:alloc-intl") {
      return { format: "module", source: mockIntl, shortCircuit: true };
    }
    if (url === "mock:alloc-org-scope") {
      return { format: "module", source: mockOrgScope, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const runnerUrl = "./allocations-report-runner.ts?alloc-report-runner";
const { createReportDriverRunner } = (await import(runnerUrl)) as typeof import("./allocations-report-runner.ts");
hooks.deregister();

const { db } = await import("../../engine/src/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "../../engine/src/test-fixtures.ts"
);

const DB = !!process.env.OPENBOOKS_DB_URL;

function authzFor(orgId: string, actorId: string, permissions: string[]) {
  return {
    user: { orgId, id: actorId },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  } as never;
}

test("runner refuses foreign actors and params", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const runner = createReportDriverRunner(authzFor(org.orgId, actorId, ["reports.read"]));
    const base = {
      orgId: org.orgId,
      reportDefinitionId: randomUUID(),
      dimensionColumn: "account_id",
      valueColumn: "amount",
      from: "2026-01-01",
      to: "2026-12-31",
      params: {},
    };
    await assert.rejects(
      () => runner.runReport({ ...base, actorId: randomUUID() }),
      /different actor/,
    );
    await assert.rejects(
      () => runner.runReport({ ...base, actorId, params: { surprise: 1 } }),
      /params are not supported/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("runner executes the definition over the period", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    shared.orgId = org.orgId;
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const definitionId = randomUUID();
    await db.execute(sql`
      insert into report_definitions (id, org_id, kind, report_type, slug, name, query)
      values (${definitionId}, ${org.orgId}, 'custom', 'query', 'driver-probe', 'Driver probe',
        ${JSON.stringify({
          entity: "ledger_lines",
          mode: "rows",
          columns: ["account_id", "amount"],
          filters: { combinator: "and", rules: [] },
        })}::jsonb)`);
    const runner = createReportDriverRunner(authzFor(org.orgId, actorId, ["reports.read"]));
    const rows = await runner.runReport({
      orgId: org.orgId,
      actorId,
      reportDefinitionId: definitionId,
      dimensionColumn: "account_id",
      valueColumn: "amount",
      from: "2026-01-01",
      to: "2026-12-31",
      params: {},
    });
    // A scratch org posts nothing: the full path runs, the vector is empty.
    assert.deepEqual(rows, []);

    await assert.rejects(
      () => runner.runReport({
        orgId: org.orgId,
        actorId,
        reportDefinitionId: definitionId,
        dimensionColumn: "account_id",
        valueColumn: "memo",
        from: "2026-01-01",
        to: "2026-12-31",
        params: {},
      }),
      /must be numeric/,
    );
  } finally {
    shared.orgId = null;
    await dropScratchOrg(org.orgId);
  }
});
