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
  lineRows: Array<Record<string, unknown>>;
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
  lineRows: [],
  subsidiaryRows: [],
  multiSubsidiary: true,
  permissionChecks: [],
  domainCalls: [],
};
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;

const mockSources = new Map<string, string>([
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
          if (text.includes('from psp_settlement_lines')) {
            return { rows: state.lineRows }
          }
          if (text.includes('reconciliation_matches') || text.includes('psp_payout_accruals')) {
            return { rows: [] }
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
        return Response.json({ error: 'not_found' }, { status: 404 })
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
      export class PspSettlementConflictError extends PspSettlementError {
        constructor(message, persistedBatch) { super(message); this.persistedBatch = persistedBatch }
      }
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

      export function parseShopifyPaymentsPayout(payout, transactions, settlementDate) {
        return {
          provider: 'shopify_payments',
          externalRef: payout.id,
          settlementDate,
          currency: 'USD',
          lines: [{ kind: 'charge', amount: '1.0000' }],
          raw: { receivedTransactions: transactions.length },
        }
      }

      export function parsePaypalTransactions(input, settlementDate) {
        return {
          provider: 'paypal',
          externalRef: input.reference,
          settlementDate,
          currency: 'USD',
          lines: [{ kind: 'charge', amount: '1.0000' }],
          raw: { receivedTransactions: input.transactions.length },
        }
      }

      export function parsePaypalSettlementCsv(csv, reference, settlementDate) {
        return {
          provider: 'paypal',
          externalRef: reference,
          settlementDate,
          currency: 'USD',
          lines: [{ kind: 'charge', amount: '1.0000' }],
          raw: { receivedCsvLength: csv.length },
        }
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

      export async function importSettlementBatch(orgId, userId, parsed, accounts, allowedSubsidiaryIds) {
        state.domainCalls.push({ action: 'import', orgId, userId, input: { parsed, accounts, allowedSubsidiaryIds } })
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

      export async function batchDepositTieout(orgId, batchId) {
        return {
          status: 'untied', batchId, provider: 'stripe', externalRef: 'payout-1',
          netAmount: '1.0000', currency: 'USD', settlementDate: '2026-08-24',
          depositLines: [], gapAmount: '1.0000',
        }
      }

      export async function setSettlementLineDocument(orgId, batchId, lineId, documentId, userId) {
        state.domainCalls.push({ action: 'link', orgId, userId, input: { batchId, lineId, documentId } })
        return { lineId, documentId }
      }

      export async function clearSettlementLineDocument(orgId, batchId, lineId, userId) {
        state.domainCalls.push({ action: 'unlink', orgId, userId, input: { batchId, lineId } })
        return { lineId }
      }

      export async function markSettlementLineAdjustment(orgId, batchId, lineId, userId) {
        state.domainCalls.push({ action: 'markAdjustment', orgId, userId, input: { batchId, lineId } })
        return { lineId, kind: 'adjustment' }
      }

      export async function accruePayoutsInTransit(orgId, accrualDate, userId) {
        state.domainCalls.push({ action: 'accrue', orgId, userId, input: { accrualDate } })
        return { accrualDate, reversalDate: accrualDate, accrued: [], reversed: [], skipped: [] }
      }
    `,
  ],
  [
    "mock:commerce",
    `
      const state = globalThis[Symbol.for('openbooks.psp-settlement-route-test')]

      export class CommerceError extends Error {
        constructor(code, message, remedy, options) {
          super(message)
          this.code = code
          this.remedy = remedy
          this.status = options?.status ?? 422
        }
      }

      export async function matchPayoutLines(orgId, batchId, userId) {
        state.domainCalls.push({ action: 'match', orgId, userId, input: { batchId } })
        return { batchId, matched: 1, unmatched: 0, notApplicable: 0, lines: [] }
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
  ["@openbooks/engine/src/payments/psp-settlement.ts", "mock:psp-settlement"],
  ["@openbooks/engine/payments/settlement", "mock:psp-settlement"],
  ["@openbooks/engine/commerce", "mock:commerce"],
  ["@openbooks/engine/src/organization/subsidiary-scope.ts", "mock:psp-settlement"],
  ["@openbooks/engine/src/platform/business-date.ts", "mock:business-date"],
  ["../../../../lib/authz", "mock:authz"],
  ["@/lib/authz", "mock:authz"],
  ["../../../../lib/feature-gates", "mock:feature-gates"],
  ["@/lib/feature-gates", "mock:feature-gates"],
  ["../../../../lib/features", "mock:features"],
]);

const _hooks = registerHooks({
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

function reset(permissions: string[]): void {
  routeState.permissions = new Set(permissions);
  routeState.allowedSubsidiaryIds = null;
  routeState.batchSubsidiaryId = undefined;
  routeState.batchRows = [];
  routeState.lineRows = [];
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
  routeState.allowedSubsidiaryIds = new Set(["00000000-0000-4000-8000-0000000000a1"]);
  routeState.batchRows = [
    { id: "batch-a", subsidiaryId: "00000000-0000-4000-8000-0000000000a1", netAmount: "10.0000" },
    { id: "batch-b", subsidiaryId: "00000000-0000-4000-8000-0000000000b1", netAmount: "20.0000" },
  ];

  const response = await GET(new Request("http://openbooks.test/api/psp/settlements"));

  assert.equal(response.status, 200);
  const payload = await response.json() as { batches: Array<{ id: string }>; configs: unknown[] };
  assert.deepEqual(payload.batches.map((batch) => batch.id), ["batch-a"]);
  assert.deepEqual(payload.configs, []);
});

// The import form asks for the posting subsidiary up front, so
// GET carries the picker's options under the same scope as the batches.
test("GET lists in-scope subsidiaries for the import picker", async () => {
  routeState.allowedSubsidiaryIds = new Set(["00000000-0000-4000-8000-0000000000a1"]);
  routeState.batchRows = [];
  routeState.subsidiaryRows = [
    { id: "00000000-0000-4000-8000-0000000000a1", name: "Main Co", baseCurrency: "USD" },
    { id: "00000000-0000-4000-8000-0000000000b1", name: "Second Co", baseCurrency: "USD" },
  ];

  const response = await GET(new Request("http://openbooks.test/api/psp/settlements"));

  assert.equal(response.status, 200);
  const payload = await response.json() as { subsidiaries: Array<{ id: string }> };
  assert.deepEqual(payload.subsidiaries.map((sub) => sub.id), ["00000000-0000-4000-8000-0000000000a1"]);
});

test("GET omits subsidiary options for single-entity orgs", async () => {
  routeState.allowedSubsidiaryIds = null;
  routeState.batchRows = [];
  routeState.subsidiaryRows = [{ id: "00000000-0000-4000-8000-0000000000a1", name: "Main Co", baseCurrency: "USD" }];
  routeState.multiSubsidiary = false;

  const response = await GET(new Request("http://openbooks.test/api/psp/settlements"));

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
      defaultDisputedFundsAccountId: null,
      defaultChargebackLossAccountId: null,
      defaultDisputeFeeAccountId: null,
      refundPolicy: undefined,
      pullEnabled: undefined,
      apiKey: null,
    },
  });
});

test("saveConfig stores the refund policy and dispute accounts for PayPal", async () => {
  reset(["admin.setup.manage"]);

  const response = await post({
    action: "saveConfig",
    provider: "paypal",
    displayName: "PayPal",
    isEnabled: true,
    refundPolicy: "review",
    defaultDisputedFundsAccountId: "00000000-0000-4000-8000-0000000000c1",
    defaultChargebackLossAccountId: "00000000-0000-4000-8000-0000000000c2",
    defaultDisputeFeeAccountId: "00000000-0000-4000-8000-0000000000c3",
  });

  assert.equal(response.status, 200);
  assert.equal((routeState.domainCalls[0]?.input as { provider?: string }).provider, "paypal");
  assert.deepEqual(
    (routeState.domainCalls[0]?.input as Record<string, unknown>),
    {
      provider: "paypal",
      displayName: "PayPal",
      isEnabled: true,
      defaultBankAccountId: null,
      defaultFeeAccountId: null,
      defaultDisputeAccountId: null,
      defaultFxAccountId: null,
      defaultClearingAccountId: null,
      defaultDisputedFundsAccountId: "00000000-0000-4000-8000-0000000000c1",
      defaultChargebackLossAccountId: "00000000-0000-4000-8000-0000000000c2",
      defaultDisputeFeeAccountId: "00000000-0000-4000-8000-0000000000c3",
      refundPolicy: "review",
      pullEnabled: undefined,
      apiKey: null,
    },
  );
});

test("saveConfig rejects truthy text instead of enabling the provider", async () => {
  reset(["admin.setup.manage"]);

  const response = await post({
    action: "saveConfig",
    provider: "stripe",
    isEnabled: "false",
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json() as { error: string }).error, "isEnabled must be a boolean");
  assert.deepEqual(routeState.domainCalls, []);
});

test("saveConfig preserves a JSON false value", async () => {
  reset(["admin.setup.manage"]);

  const response = await post({
    action: "saveConfig",
    provider: "stripe",
    isEnabled: false,
  });

  assert.equal(response.status, 200);
  assert.equal((routeState.domainCalls[0]?.input as { isEnabled?: boolean }).isEnabled, false);
});

test("saveConfig refuses restricted setup authority before saving org-wide provider policy", async () => {
  reset(["admin.setup.manage"]);
  routeState.allowedSubsidiaryIds = new Set(["00000000-0000-4000-8000-0000000000a1"]);

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
      transactions: [{ id: "transaction-1", type: "charge", amount: 100, currency: "USD" }],
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
  routeState.allowedSubsidiaryIds = new Set(["00000000-0000-4000-8000-0000000000a1"]);

  const response = await post({
    action: "import",
    provider: "stripe",
    externalRef: "payout-other",
    settlementDate: "2026-08-24",
    transactions: [{ id: "transaction-1", type: "charge", amount: 100, currency: "USD" }],
    subsidiaryId: "00000000-0000-4000-8000-0000000000b1",
  });

  assert.equal(response.status, 404);
  assert.deepEqual(routeState.domainCalls, []);
});

test("restricted import dispatches an in-scope subsidiary", async () => {
  reset(["banking.reconcile"]);
  routeState.allowedSubsidiaryIds = new Set(["00000000-0000-4000-8000-0000000000a1"]);

  const response = await post({
    action: "import",
    provider: "stripe",
    externalRef: "payout-own",
    settlementDate: "2026-08-24",
    transactions: [{ id: "transaction-1", type: "charge", amount: 100, currency: "USD" }],
    subsidiaryId: "00000000-0000-4000-8000-0000000000a1",
  });

  assert.equal(response.status, 200);
  assert.deepEqual((routeState.domainCalls[0]?.input as { accounts: { subsidiaryId: string } }).accounts.subsidiaryId, "00000000-0000-4000-8000-0000000000a1");
  assert.deepEqual((routeState.domainCalls[0]?.input as { allowedSubsidiaryIds: Set<string> }).allowedSubsidiaryIds, new Set(["00000000-0000-4000-8000-0000000000a1"]));
});

for (const action of ["post", "reverse"] as const) {
  test(`restricted ${action} cannot reach another subsidiary's batch`, async () => {
    reset(["banking.reconcile"]);
    routeState.allowedSubsidiaryIds = new Set(["00000000-0000-4000-8000-0000000000a1"]);
    routeState.batchSubsidiaryId = "00000000-0000-4000-8000-0000000000b1";

    const response = await post(
      action === "post"
        ? { action, batchId: "00000000-0000-4000-8000-0000000000b2" }
        : {
            action,
            batchId: "00000000-0000-4000-8000-0000000000b2",
            reversalDate: "2026-08-24",
            reason: "Provider recalled the payout",
          },
    );

    assert.equal(response.status, 404);
    assert.deepEqual(routeState.domainCalls, []);
  });
}

test("shopify_payments import dispatches the payout and its balance transactions", async () => {
  reset(["banking.reconcile"]);

  const response = await post({
    action: "import",
    provider: "shopify_payments",
    settlementDate: "2026-08-24",
    payout: { id: "payout-9", currency: "USD", issuedAt: "2026-08-24" },
    transactions: [
      { id: "txn-1", type: "charge", amount: "104.50", fee: "3.10", net: "101.40", currency: "USD", sourceOrderId: "1001" },
    ],
  });

  assert.equal(response.status, 200);
  const parsed = (routeState.domainCalls[0]?.input as { parsed: { provider: string; externalRef: string; raw: { receivedTransactions: number } } }).parsed;
  assert.equal(parsed.provider, "shopify_payments");
  assert.equal(parsed.externalRef, "payout-9");
  assert.equal(parsed.raw.receivedTransactions, 1);
});

test("paypal import dispatches the Transaction Search export under the operator's reference", async () => {
  reset(["banking.reconcile"]);

  const response = await post({
    action: "import",
    provider: "paypal",
    externalRef: "week-34",
    settlementDate: "2026-08-24",
    payload: {
      transactions: [
        {
          transaction_info: {
            transaction_id: "txn-1",
            transaction_event_code: "T0000",
            transaction_amount: { currency_code: "USD", value: "50.00" },
            fee_amount: { currency_code: "USD", value: "1.75" },
          },
        },
      ],
    },
  });

  assert.equal(response.status, 200);
  const parsed = (routeState.domainCalls[0]?.input as { parsed: { provider: string; externalRef: string; raw: { receivedTransactions: number } } }).parsed;
  assert.equal(parsed.provider, "paypal");
  assert.equal(parsed.externalRef, "week-34");
  assert.equal(parsed.raw.receivedTransactions, 1);
});

test("paypal import accepts the settlement report CSV instead of JSON", async () => {
  reset(["banking.reconcile"]);

  const response = await post({
    action: "import",
    provider: "paypal",
    externalRef: "stl-august",
    settlementDate: "2026-08-24",
    csv: "Transaction ID,Event Code\ntxn-1,T0000\n",
  });

  assert.equal(response.status, 200);
  const parsed = (routeState.domainCalls[0]?.input as { parsed: { provider: string; raw: { receivedCsvLength: number } } }).parsed;
  assert.equal(parsed.provider, "paypal");
  assert.ok(parsed.raw.receivedCsvLength > 0);
});

test("paypal import without evidence names the missing half", async () => {
  reset(["banking.reconcile"]);

  const response = await post({
    action: "import",
    provider: "paypal",
    externalRef: "week-34",
    settlementDate: "2026-08-24",
  });

  assert.equal(response.status, 400);
  assert.match((await response.json() as { error: string }).error, /payload or csv is required/);
  assert.deepEqual(routeState.domainCalls, []);
});

test("import attaches cross-currency evidence instead of assuming a rate", async () => {
  reset(["banking.reconcile"]);

  const response = await post({
    action: "import",
    provider: "stripe",
    externalRef: "payout-fx",
    settlementDate: "2026-08-24",
    transactions: [{ id: "transaction-1", type: "charge", amount: 100, currency: "EUR" }],
    fx: { sourceCurrency: "EUR", rate: "1.0842", rateSource: "Stripe balance transaction exchange_rate" },
  });

  assert.equal(response.status, 200);
  const parsed = (routeState.domainCalls[0]?.input as { parsed: { fx: { sourceCurrency: string; rate: string } } }).parsed;
  assert.deepEqual(parsed.fx, {
    sourceCurrency: "EUR",
    rate: "1.0842",
    rateSource: "Stripe balance transaction exchange_rate",
    payoutRate: null,
    payoutRateSource: null,
  });
});

test("settlement detail refuses a malformed batch id without reaching storage", async () => {
  reset(["banking.read"]);

  const response = await GET(new Request("http://openbooks.test/api/psp/settlements?batchId=not-a-uuid"));

  assert.equal(response.status, 404);
});

test("settlement detail returns the batch with its evidence lines", async () => {
  reset(["banking.read"]);
  routeState.batchRows = [{ id: "00000000-0000-4000-8000-0000000000b1", externalRef: "payout-1" }];
  routeState.lineRows = [
    { lineNumber: 1, kind: "charge", externalRef: "txn-1", description: "Visa", amount: "100.0000", currency: "USD", documentId: null, documentKind: null, documentNumber: null },
  ];

  const response = await GET(
    new Request("http://openbooks.test/api/psp/settlements?batchId=00000000-0000-4000-8000-0000000000b1"),
  );

  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    batch: { id: string };
    lines: Array<{ lineNumber: number }>;
  };
  assert.equal(payload.batch.id, "00000000-0000-4000-8000-0000000000b1");
  assert.deepEqual(payload.lines.map((line) => line.lineNumber), [1]);
});

test("settlement detail of another tenant's batch is a 404", async () => {
  reset(["banking.read"]);
  routeState.batchRows = [];

  const response = await GET(
    new Request("http://openbooks.test/api/psp/settlements?batchId=00000000-0000-4000-8000-0000000000b1"),
  );

  assert.equal(response.status, 404);
});

test("match runs line matching on a payout batch", async () => {
  reset(["banking.reconcile"]);

  const response = await post({
    action: "match",
    batchId: "00000000-0000-4000-8000-0000000000b1",
  });

  assert.equal(response.status, 200);
  assert.equal((await response.json() as { matched: number }).matched, 1);
  assert.equal(routeState.domainCalls[0]?.action, "match");
});

test("link stores a manual document link on an unmatched line", async () => {
  reset(["banking.reconcile"]);

  const response = await post({
    action: "link",
    batchId: "00000000-0000-4000-8000-0000000000b1",
    lineId: "00000000-0000-4000-8000-0000000000c1",
    documentId: "00000000-0000-4000-8000-0000000000d1",
  });

  assert.equal(response.status, 200);
  assert.equal(routeState.domainCalls[0]?.action, "link");
});

test("link refuses a malformed line id without reaching storage", async () => {
  reset(["banking.reconcile"]);

  const response = await post({
    action: "link",
    batchId: "00000000-0000-4000-8000-0000000000b1",
    lineId: "not-a-uuid",
    documentId: "00000000-0000-4000-8000-0000000000d1",
  });

  assert.equal(response.status, 404);
  assert.deepEqual(routeState.domainCalls, []);
});

test("accrue books the month-end in-transit position", async () => {
  reset(["banking.reconcile"]);

  const response = await post({ action: "accrue", accrualDate: "2026-08-31" });

  assert.equal(response.status, 200);
  assert.equal(routeState.domainCalls[0]?.action, "accrue");
});

test("resolveDoc lists posted documents for manual links", async () => {
  reset(["banking.read"]);

  const response = await GET(
    new Request("http://openbooks.test/api/psp/settlements?resolveDoc=INV"),
  );

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json() as { documents: unknown[] }).documents, []);
});
