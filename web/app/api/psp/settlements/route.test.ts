import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

interface DomainCall {
  action: "saveConfig" | "import" | "post" | "reverse";
  orgId: string;
  userId: string;
  input: unknown;
}

interface PspRouteState {
  permissions: Set<string>;
  allowedSubsidiaryIds: Set<string> | null;
  batchSubsidiaryId: string | null | undefined;
  batchRows: Array<Record<string, unknown>>;
  permissionChecks: string[];
  domainCalls: DomainCall[];
}

const stateKey = Symbol.for("openbooks.psp-settlement-route-test");
const routeState: PspRouteState = {
  permissions: new Set(),
  allowedSubsidiaryIds: null,
  batchSubsidiaryId: undefined,
  batchRows: [],
  permissionChecks: [],
  domainCalls: [],
};
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;

const mockSources = new Map<string, string>([
  [
    "mock:json",
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        return { ok: true, data: await request.json() }
      }
    `,
  ],
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.psp-settlement-route-test')]
      export const db = {
        execute(query) {
          const staticText = (chunk) => {
            if (typeof chunk !== 'object' || chunk === null) return ''
            if (Array.isArray(chunk.value)) return chunk.value.join('')
            if (Array.isArray(chunk.queryChunks)) return chunk.queryChunks.map(staticText).join('')
            return ''
          }
          const text = (query?.queryChunks ?? []).map(staticText).join('')
          if (text.includes('select subsidiary_id as "subsidiaryId"')) {
            return { rows: state.batchSubsidiaryId === undefined ? [] : [{ subsidiaryId: state.batchSubsidiaryId }] }
          }
          if (text.includes('from psp_settlement_batches')) {
            if (state.allowedSubsidiaryIds && !text.includes('subsidiary_id = any')) return { rows: state.batchRows }
            if (state.allowedSubsidiaryIds) {
              return { rows: state.batchRows.filter((row) => state.allowedSubsidiaryIds.has(row.subsidiaryId)) }
            }
            return { rows: state.batchRows }
          }
          return { rows: state.batchSubsidiaryId === undefined ? [] : [{ subsidiaryId: state.batchSubsidiaryId }] }
        }
      }
    `,
  ],
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.psp-settlement-route-test')]

      export async function getAuthz() {
        return {
          user: { orgId: 'org-1', id: 'user-1' },
          permissions: new Set(state.permissions),
          allowedSubsidiaryIds: state.allowedSubsidiaryIds,
        }
      }

      export function can(authz, permission) {
        state.permissionChecks.push(permission)
        return authz.permissions.has(permission)
      }

      export function guardSubsidiaryScope(authz, subsidiaryId) {
        if (authz.allowedSubsidiaryIds === null || authz.allowedSubsidiaryIds.has(subsidiaryId)) return null
        return Response.json({ error: 'not found' }, { status: 404 })
      }
    `,
  ],
  [
    "mock:feature-gates",
    `
      const state = globalThis[Symbol.for('openbooks.psp-settlement-route-test')]
      export async function guardFeaturePermission() {
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: state.allowedSubsidiaryIds }
      }
    `,
  ],
  [
    "mock:features",
    `export async function isFeatureEnabled() { return true }`,
  ],
  [
    "mock:business-date",
    `export async function businessToday() { return '2026-08-24' }`,
  ],
  [
    "mock:psp-settlement",
    `
      const state = globalThis[Symbol.for('openbooks.psp-settlement-route-test')]

      export class PspSettlementError extends Error {}

      export function parseStripeBalanceTransactions(_rows, externalRef, settlementDate) {
        return {
          provider: 'stripe',
          externalRef,
          settlementDate,
          currency: 'USD',
          lines: [{ kind: 'charge', amount: '1.0000' }],
        }
      }

      export function parseRecurlySettlement() {
        throw new Error('unexpected Recurly parse')
      }

      export function parseChargebeeSettlement() {
        throw new Error('unexpected Chargebee parse')
      }

      export function summarizeSettlement() {
        return {
          grossAmount: '1.0000',
          feeAmount: '0.0000',
          refundAmount: '0.0000',
          disputeAmount: '0.0000',
          fxAmount: '0.0000',
          netAmount: '1.0000',
        }
      }

      export async function savePspProviderConfig(orgId, input, userId) {
        state.domainCalls.push({ action: 'saveConfig', orgId, userId, input })
      }

      export async function importSettlementBatch(orgId, userId, parsed, accounts) {
        state.domainCalls.push({ action: 'import', orgId, userId, input: { parsed, accounts } })
        return { batchId: 'batch-1', created: true }
      }

      export async function postSettlementBatch(orgId, batchId, userId) {
        state.domainCalls.push({ action: 'post', orgId, userId, input: { batchId } })
        return { entryId: 'entry-post' }
      }

      export async function reverseSettlementBatch(orgId, batchId, userId, input) {
        state.domainCalls.push({ action: 'reverse', orgId, userId, input: { batchId, ...input } })
        return { entryId: 'entry-reverse' }
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@/lib/api/json", "mock:json"],
  ["@openbooks/engine/src/db.ts", "mock:db"],
  ["@openbooks/engine/src/psp-settlement.ts", "mock:psp-settlement"],
  ["@openbooks/engine/src/business-date.ts", "mock:business-date"],
  ["../../../../lib/authz", "mock:authz"],
  ["../../../../lib/feature-gates", "mock:feature-gates"],
  ["../../../../lib/features", "mock:features"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) {
      return { format: "module", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?psp-permission-test";
const { GET, POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

function reset(permissions: string[]): void {
  routeState.permissions = new Set(permissions);
  routeState.allowedSubsidiaryIds = null;
  routeState.batchSubsidiaryId = undefined;
  routeState.batchRows = [];
  routeState.permissionChecks.length = 0;
  routeState.domainCalls.length = 0;
}

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("http://openbooks.test/api/psp/settlements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

test("GET hides batches and provider configs from other subsidiaries", async () => {
  routeState.allowedSubsidiaryIds = new Set(["sub-a"]);
  routeState.batchRows = [
    { id: "batch-a", subsidiaryId: "sub-a", netAmount: "10.0000" },
    { id: "batch-b", subsidiaryId: "sub-b", netAmount: "20.0000" },
  ];

  const response = await GET();

  assert.equal(response.status, 200);
  const payload = await response.json() as { batches: Array<{ id: string }>; configs: unknown[] };
  assert.deepEqual(payload.batches.map((batch) => batch.id), ["batch-a"]);
  assert.deepEqual(payload.configs, []);
});

test("saveConfig rejects reconciliation authority without setup authority", async () => {
  reset(["banking.reconcile"]);

  const response = await post({
    action: "saveConfig",
    provider: "stripe",
    isEnabled: true,
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "missing permission: admin.setup.manage",
  });
  assert.deepEqual(routeState.permissionChecks, ["admin.setup.manage"]);
  assert.deepEqual(routeState.domainCalls, []);
});

test("saveConfig accepts setup authority without reconciliation authority", async () => {
  reset(["admin.setup.manage"]);

  const response = await post({
    action: "saveConfig",
    provider: "stripe",
    displayName: "Settlement provider",
    isEnabled: true,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(routeState.permissionChecks, ["admin.setup.manage"]);
  assert.equal(routeState.domainCalls.length, 1);
  assert.deepEqual(routeState.domainCalls[0], {
    action: "saveConfig",
    orgId: "org-1",
    userId: "user-1",
    input: {
      provider: "stripe",
      displayName: "Settlement provider",
      isEnabled: true,
      defaultBankAccountId: null,
      defaultFeeAccountId: null,
      defaultDisputeAccountId: null,
      defaultFxAccountId: null,
      defaultClearingAccountId: null,
      apiKey: null,
    },
  });
});

const reconciliationActions: Array<{
  action: "import" | "post" | "reverse";
  body: Record<string, unknown>;
}> = [
  {
    action: "import",
    body: {
      action: "import",
      provider: "stripe",
      externalRef: "payout-1",
      settlementDate: "2026-08-24",
      transactions: [],
    },
  },
  { action: "post", body: { action: "post", batchId: "batch-1" } },
  {
    action: "reverse",
    body: {
      action: "reverse",
      batchId: "batch-1",
      reversalDate: "2026-08-24",
      reason: "Provider recalled the payout",
    },
  },
];

for (const scenario of reconciliationActions) {
  test(`${scenario.action} retains banking reconciliation authority`, async () => {
    reset(["banking.reconcile"]);

    const response = await post(scenario.body);

    assert.equal(response.status, 200);
    assert.deepEqual(routeState.permissionChecks, ["banking.reconcile"]);
    assert.deepEqual(
      routeState.domainCalls.map((call) => call.action),
      [scenario.action],
    );
  });
}

test("restricted import requires an in-scope subsidiary", async () => {
  reset(["banking.reconcile"]);
  routeState.allowedSubsidiaryIds = new Set(["sub-a"]);

  const response = await post({
    action: "import",
    provider: "stripe",
    externalRef: "payout-other",
    settlementDate: "2026-08-24",
    transactions: [],
    subsidiaryId: "sub-b",
  });

  assert.equal(response.status, 404);
  assert.deepEqual(routeState.domainCalls, []);
});

test("restricted import dispatches an in-scope subsidiary", async () => {
  reset(["banking.reconcile"]);
  routeState.allowedSubsidiaryIds = new Set(["sub-a"]);

  const response = await post({
    action: "import",
    provider: "stripe",
    externalRef: "payout-own",
    settlementDate: "2026-08-24",
    transactions: [],
    subsidiaryId: "sub-a",
  });

  assert.equal(response.status, 200);
  assert.deepEqual((routeState.domainCalls[0]?.input as { accounts: { subsidiaryId: string } }).accounts.subsidiaryId, "sub-a");
});

for (const action of ["post", "reverse"] as const) {
  test(`restricted ${action} cannot reach another subsidiary's batch`, async () => {
    reset(["banking.reconcile"]);
    routeState.allowedSubsidiaryIds = new Set(["sub-a"]);
    routeState.batchSubsidiaryId = "sub-b";

    const response = await post(
      action === "post"
        ? { action, batchId: "batch-other" }
        : {
            action,
            batchId: "batch-other",
            reversalDate: "2026-08-24",
            reason: "Provider recalled the payout",
          },
    );

    assert.equal(response.status, 404);
    assert.deepEqual(routeState.domainCalls, []);
  });
}
