import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { NextResponse } from "next/server";

interface ProvisionCall {
  orgId: string;
  runId: string;
  allowedSubsidiaryIds: Set<string> | null | undefined;
}

interface RouteState {
  scope: Set<string> | null | undefined;
  calls: ProvisionCall[];
}

const stateKey = Symbol.for("openbooks.tax-provision-route-test");
const routeState: RouteState = { scope: null, calls: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;
(
  globalThis as typeof globalThis & Record<string, unknown>
).openbooksTaxProvisionNextResponse = NextResponse;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.tax-provision-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'reports.read') {
          return globalThis.openbooksTaxProvisionNextResponse.json({ error: 'forbidden' }, { status: 403 })
        }
        return {
          user: { orgId: 'org-1', id: 'user-1' },
          allowedSubsidiaryIds: state.scope,
        }
      }
    `,
  ],
  [
    "mock:income-tax-provision",
    `
      const state = globalThis[Symbol.for('openbooks.tax-provision-route-test')]
      export async function getProvisionRun(orgId, runId, allowedSubsidiaryIds) {
        state.calls.push({ orgId, runId, allowedSubsidiaryIds })
        const allEntities = [
          { subsidiaryId: '00000000-0000-4000-8000-00000000b001', detail: 'visible' },
          { subsidiaryId: '00000000-0000-4000-8000-00000000c001', detail: 'hidden' },
        ]
        const entities = allowedSubsidiaryIds == null
          ? allEntities
          : allEntities.filter((entity) => allowedSubsidiaryIds.has(entity.subsidiaryId))
        return {
          id: runId,
          fiscalYear: 2026,
          periodFrom: '2026-01-01',
          periodTo: '2026-12-31',
          status: 'draft',
          version: 1,
          totalExpense: '0.0000',
          effectiveRatePercent: null,
          journalEntryId: null,
          createdAt: '2026-08-28T00:00:00.000Z',
          snapshotHash: 'hash',
          payload: { entities },
          differences: [],
        }
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../../lib/authz", "mock:authz"],
  [
    "@openbooks/engine/src/income-tax-provision.ts",
    "mock:income-tax-provision",
  ],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
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

const { GET } = (await import("./route.ts")) as typeof import("./route.ts");
hooks.deregister();

const RUN_ID = "00000000-0000-4000-8000-00000000a001";

function reset(scope: Set<string> | null | undefined): void {
  routeState.scope = scope;
  routeState.calls.length = 0;
}

function get(): Promise<Response> {
  return GET(
    new Request(`http://openbooks.test/api/tax/provisions/${RUN_ID}`),
    { params: Promise.resolve({ id: RUN_ID }) },
  );
}

test("GET forwards the caller's subsidiary scope to the provision detail service", async () => {
  const allowed = new Set(["00000000-0000-4000-8000-00000000b001"]);
  reset(allowed);

  const response = await get();

  assert.equal(response.status, 200);
  assert.equal(routeState.calls.length, 1);
  assert.equal(routeState.calls[0]!.orgId, "org-1");
  assert.equal(routeState.calls[0]!.runId, RUN_ID);
  assert.equal(routeState.calls[0]!.allowedSubsidiaryIds, allowed);
  const body = (await response.json()) as { payload: { entities: { subsidiaryId: string }[] } };
  assert.deepEqual(body.payload.entities.map((entity) => entity.subsidiaryId), [...allowed]);
});

test("GET keeps an unrestricted scope explicit for organization-wide readers", async () => {
  reset(null);

  const response = await get();

  assert.equal(response.status, 200);
  assert.equal(routeState.calls[0]!.allowedSubsidiaryIds, null);
  const body = (await response.json()) as { payload: { entities: { subsidiaryId: string }[] } };
  assert.deepEqual(body.payload.entities.map((entity) => entity.subsidiaryId), [
    "00000000-0000-4000-8000-00000000b001",
    "00000000-0000-4000-8000-00000000c001",
  ]);
});
