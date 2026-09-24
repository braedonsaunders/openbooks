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
  subsidiaryRows: Array<Record<string, unknown>>;
  multiSubsidiary: boolean;
  permissionChecks: string[];
  domainCalls: DomainCall[];
}

const stateKey = Symbol.for("openbooks.psp-settlement-route-test");
const routeState: PspRouteState = {
  permissions: new Set(),
  allowedSubsidiaryIds: null,
  batchSubsidiaryId: undefined,
  batchRows: [],
  subsidiaryRows: [],
  multiSubsidiary: true,
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
          if (text.includes('from subsidiaries')) {
            if (state.allowedSubsidiaryIds) {
              return { rows: state.subsidiaryRows.filter((row) => state.allowedSubsidiaryIds.has(row.id)) }
            }
            return { rows: state.subsidiaryRows }
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

      export function guardUnrestrictedScope(authz) {
        if (authz.allowedSubsidiaryIds === null) return null
        return Response.json({ error: 'requires unrestricted subsidiary access' }, { status: 403 })
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
    `
      export async function isFeatureEnabled() { return true }
      export async function subsidiaryFeatureEnabled() {
        return globalThis[Symbol.for('openbooks.psp-settlement-route-test')].multiSubsidiary !== false
      }
    `,
  ],
  [
    "mock:business-date",
    `
      export async function businessToday() { return '2026-08-24' }
      export function isIsoCalendarDate(value) {
        if (typeof value !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) return false
        const [y, m, d] = value.split('-').map(Number)
        const probe = new Date(Date.UTC(y, m - 1, d))
        return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
      }
    `,
  ],
  [
    "mock:psp-settlement",
    `
      const state = globalThis[Symbol.for('openbooks.psp-settlement-route-test')]

      export class PspSettlementError extends Error {}
      export class ScopeNotFoundError extends Error {}
      export class UnrestrictedScopeError extends Error {}

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
        return { batchId: '00000000-0000-4000-8000-0000000000b1', created: true }
      }

      export async function postSettlementBatch(orgId, batchId, userId, allowedSubsidiaryIds) {
        if (allowedSubsidiaryIds !== null && !allowedSubsidiaryIds.has(state.batchSubsidiaryId)) throw new ScopeNotFoundError()
        state.domainCalls.push({ action: 'post', orgId, userId, input: { batchId, allowedSubsidiaryIds } })
        return { entryId: 'entry-post' }
      }

      export async function reverseSettlementBatch(orgId, batchId, userId, input, allowedSubsidiaryIds) {
        if (allowedSubsidiaryIds !== null && !allowedSubsidiaryIds.has(state.batchSubsidiaryId)) throw new ScopeNotFoundError()
        state.domainCalls.push({ action: 'reverse', orgId, userId, input: { batchId, ...input, allowedSubsidiaryIds } })
        return { entryId: 'entry-reverse' }
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@/lib/api/json", "mock:json"],
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
  ["@openbooks/engine/src/payments/psp-settlement.ts", "mock:psp-settlement"],
  ["@openbooks/engine/src/organization/subsidiary-scope.ts", "mock:psp-settlement"],
  ["@openbooks/engine/src/platform/business-date.ts", "mock:business-date"],
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
  routeState.subsidiaryRows = [];
  routeState.multiSubsidiary = true;
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

// F-t06-004: the import form asks for the posting subsidiary up front, so
// GET carries the picker's options under the same scope as the batches.
test("GET lists in-scope subsidiaries for the import picker", async () => {
  routeState.allowedSubsidiaryIds = new Set(["sub-a"]);
  routeState.batchRows = [];
  routeState.subsidiaryRows = [
    { id: "sub-a", name: "Main Co", baseCurrency: "USD" },
    { id: "sub-b", name: "Second Co", baseCurrency: "USD" },
  ];

  const response = await GET();

  assert.equal(response.status, 200);
  const payload = await response.json() as { subsidiaries: Array<{ id: string }> };
  assert.deepEqual(payload.subsidiaries.map((sub) => sub.id), ["sub-a"]);
});

test("GET omits subsidiary options for single-entity orgs", async () => {
  routeState.allowedSubsidiaryIds = null;
  routeState.batchRows = [];
  routeState.subsidiaryRows = [{ id: "sub-a", name: "Main Co", baseCurrency: "USD" }];
  routeState.multiSubsidiary = false;

  const response = await GET();

  assert.equal(response.status, 200);
  const payload = await response.json() as { subsidiaries: unknown[] };
  assert.deepEqual(payload.subsidiaries, []);
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

test("saveConfig refuses restricted setup authority before saving org-wide provider policy", async () => {
  reset(["admin.setup.manage"]);
  routeState.allowedSubsidiaryIds = new Set(["sub-a"]);

  const response = await post({
    action: "saveConfig",
    provider: "stripe",
    displayName: "Restricted attempt",
    isEnabled: true,
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "requires unrestricted subsidiary access" });
  assert.deepEqual(routeState.domainCalls, []);
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
  { action: "post", body: { action: "post", batchId: "00000000-0000-4000-8000-0000000000b1" } },
  {
    action: "reverse",
    body: {
      action: "reverse",
      batchId: "00000000-0000-4000-8000-0000000000b1",
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
