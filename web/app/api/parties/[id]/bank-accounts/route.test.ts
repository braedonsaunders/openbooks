import { withPlatformDbTestSurface } from "../../../../../testing/stub-modules";
import assert from "node:assert/strict";
import {
  canonicalEngineSpecifier,
  isEngineModuleImport,
} from "../../../../../testing/engine-resolve-hooks.ts";
import { registerHooks } from "node:module";
import test, { after } from "node:test";
import { NextResponse } from "next/server";

const PARTY_ID = "00000000-0000-4000-8000-000000000001";
const TRUNCATED_REVISION = "2026-08-31T12:34:56.789Z";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000002";
const ACTUAL_UPDATED_AT = "2026-08-31T12:34:56.789123Z";

interface RouteState {
  insertedBankId: string | null;
  operation: "patch" | "delete";
  allowedSubsidiaryIds: Set<string> | null;
  partySubsidiary: string | null;
  rehomeAfterPreflight: boolean;
  inFlightPayment: boolean;
  liveMandate: boolean;
  updatedAt: string;
  queries: string[];
  updateParams: unknown[][];
  auditCalls: number;
  auditParams: unknown[][];
}

const stateKey = Symbol.for("openbooks.bank-accounts-route-test");
const state: RouteState = {
  insertedBankId: null,
  operation: "patch",
  allowedSubsidiaryIds: null,
  partySubsidiary: null,
  rehomeAfterPreflight: false,
  inFlightPayment: false,
  liveMandate: false,
  updatedAt: ACTUAL_UPDATED_AT,
  queries: [],
  updateParams: [],
  auditCalls: 0,
  auditParams: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;
(globalThis as typeof globalThis & Record<string, unknown>).openbooksBankAccountsNextResponse =
  NextResponse;

const mockSources = new Map<string, string>([
  [
    "authz",
    `
      const NextResponse = globalThis.openbooksBankAccountsNextResponse
      export async function guardPermission() {
        const state = globalThis[Symbol.for('openbooks.bank-accounts-route-test')]
        return { user: { orgId: '00000000-0000-4000-8000-00000000b001', id: '00000000-0000-4000-8000-00000000b002' }, allowedSubsidiaryIds: state.allowedSubsidiaryIds }
      }
      export async function getAuthz() {
        const state = globalThis[Symbol.for('openbooks.bank-accounts-route-test')]
        return { user: { orgId: '00000000-0000-4000-8000-00000000b001', id: '00000000-0000-4000-8000-00000000b002' }, allowedSubsidiaryIds: state.allowedSubsidiaryIds }
      }
      export function can() { return true }
      export function guardRootSubsidiaryScope() { return null }
      export function guardUnrestrictedScope() { return null }
      export function guardSubsidiaryScope(gate, subsidiaryId, options = {}) {
        if (gate.allowedSubsidiaryIds === null) return null
        if (subsidiaryId === null && options.orgWideNull) return null
        return subsidiaryId && gate.allowedSubsidiaryIds.has(subsidiaryId)
          ? null
          : NextResponse.json({ error: 'party not found' }, { status: 404 })
      }
    `,
  ],
  [
    "features",
    `
      export async function isFeatureEnabled() { return true }
    `,
  ],
  [
    "countries",
    `
      export function normalizeCountryCode(value) {
        if (typeof value !== 'string') return null
        const normalized = value.trim().toUpperCase()
        return normalized.length === 2 ? normalized : null
      }
    `,
  ],
  [
    "payments",
    `
      export class PaymentError extends Error {}
      export function encryptAccountNumber(value) { return 'encrypted:' + value }
    `,
  ],
  ["bank-account-adapter", `export const BANK_ACCOUNT_SUBJECT_KIND = 'party_bank_account'`],
  [
    "business-date",
    `
      export async function businessToday() { return '2026-10-09' }
      export async function businessTodayInTx() { return '2026-10-09' }
    `,
  ],
  [
    "db",
    `
      import {AsyncLocalStorage} from 'node:async_hooks';
      const transactionScope=new AsyncLocalStorage();
      export const orgContext={getStore:()=>transactionScope.getStore()};
      export const pinnedTransactionExecutor=()=>transactionScope.getStore()?.executor;
      const state = globalThis[Symbol.for('openbooks.bank-accounts-route-test')]
      function queryText(query) {
        const chunks = query?.queryChunks
        if (!Array.isArray(chunks)) return ''
        return chunks.map((chunk) => {
          if (typeof chunk === 'string') return ''
          const value = chunk?.value
          if (Array.isArray(value)) return value.map(String).join('')
          if (chunk?.queryChunks) return queryText(chunk)
          return ''
        }).join('')
      }
      function queryParams(query) {
        const chunks = query?.queryChunks
        if (!Array.isArray(chunks)) return []
        return chunks.filter((chunk) => {
          if (!chunk || typeof chunk !== 'object') return true
          return !('value' in chunk || 'queryChunks' in chunk)
        })
      }
      export async function withOrgTransaction(orgId, work) { return transactionScope.run({orgId,executor:db},work) }
      import * as schema from '${import.meta.resolve("@openbooks/schema")}';export {schema}
      export async function withOrg(_orgId, work) { return work() }
      export async function withOrgContext(_orgId, work) { return work() }
      export async function withBypass(work) { return work() }
      export async function withBypassContext(work) { return work() }
      export function registerRequestOrgResolver() {}
      export const pool = {}
      export const env = {}
      export const db = {
        select(){const result=[{id:state.insertedBankId??'00000000-0000-4000-8000-000000000002',orgId:'00000000-0000-4000-8000-00000000b001',partyId:'00000000-0000-4000-8000-000000000001',approvalStatus:'pending',isActive:false,createdBy:'00000000-0000-4000-8000-00000000b002',routing:{}}];let selected;const query={from(table){selected=table;return query},where(){return Promise.resolve(selected===schema.partyBankAccounts?result:[])}};return query},
        async execute(query, mode) {
          const inMode = (result) => (mode === 'objects' ? result.rows : result);
          const text = queryText(query)
          state.queries.push(text)
        if(text.includes('from users'))return inMode({rows:[{id:'00000000-0000-4000-8000-00000000b002',orgId:'00000000-0000-4000-8000-00000000b001',isActive:true,isSuperAdmin:false}]});
        if(text.includes('bank_approval_fingerprint'))return inMode({rows:[{value:'bank-fingerprint'}]});
        if(text.includes('insert into flow_submissions'))return inMode({rows:[{id:'submission-1'}]});
        if(text.includes('lock table flows')||text.includes('from flows')||text.includes('pg_advisory_xact_lock'))return inMode({rows:[]});

          if (text.includes('from parties')) {
            const locked = /for update/i.test(text)
            const subsidiaryId = state.partySubsidiary
            if (!locked && state.rehomeAfterPreflight) state.partySubsidiary = 'sub-B'
            if (locked && state.allowedSubsidiaryIds && subsidiaryId && !state.allowedSubsidiaryIds.has(subsidiaryId)) {
              return inMode({ rows: [] })
            }
            return inMode({ rows: [{ id: 'party-1', subsidiaryId }] })
          }
          if (text.includes('select approval_status') && text.includes('from party_bank_accounts')) {
            return inMode({ rows: [{ approvalStatus: 'approved', updatedAt: state.updatedAt }] })
          }
          if (text.includes('from party_bank_accounts') && !text.includes('update party_bank_accounts')) {
            return inMode({ rows: [{ updatedAt: state.updatedAt }] })
          }
          if (text.includes('from payment_instructions') && text.includes('payment_mandates')) {
            return inMode({ rows: [{ in_flight_payment: state.inFlightPayment, live_mandate: state.liveMandate }] })
          }
          if (text.includes('from payment_instructions')) return inMode({ rows: [{ inFlightPayment: state.inFlightPayment }] })
          if (text.includes('insert into party_bank_accounts')) {
            state.insertedBankId='00000000-0000-4000-8000-000000000003';
            return inMode({ rows: [{ id: '00000000-0000-4000-8000-000000000003' }] })
          }
          if (text.includes('update party_bank_accounts')) {
            state.updateParams.push(queryParams(query))
            if (state.operation === 'delete') {
              const timestamp = queryParams(query).find((value) => value === state.updatedAt)
              if (timestamp === state.updatedAt) {
                return inMode({ rows: [{ id: 'account-1' }] })
              }
              return inMode({ rows: [] })
            }
            return inMode({ rows: [{ id: 'account-1' }] })
          }
          if (text.includes('insert into audit_log')) {
            state.auditCalls += 1
            state.auditParams.push(queryParams(query))
            return inMode({ rows: [] })
          }
          if (text.includes('update flow_gates') || text.includes('update flow_runs')) return inMode({ rows: [] })
          throw new Error('unexpected database query: ' + text)
        },
      }
    `,
  ],
]);

mockSources.set("db", withPlatformDbTestSurface(mockSources.get("db")!));

const selfUrl = new URL(import.meta.url).href;
const mockUrl = (name: string) => `${selfUrl}?bank-accounts-mock=${name}`;
const mockUrls = new Map<string, string>([
  ["@/lib/authz", mockUrl("authz")],
  ["../../../../../lib/authz", mockUrl("authz")],
  ["../../../../../lib/features", mockUrl("features")],
  ["../../../../../lib/countries", mockUrl("countries")],
  ["@openbooks/engine/platform/db", mockUrl("db")],
  ["@openbooks/engine/payments/payment-accounts", mockUrl("payments")],
  ["@openbooks/engine/payments/payment-contracts", mockUrl("payments")],
  ["@openbooks/engine/payments/payment-documents", mockUrl("payments")],
  ["@openbooks/engine/payments-core/payment-errors", mockUrl("payments")],
  ["@openbooks/engine/payments/payment-posting", mockUrl("payments")],
  ["@openbooks/engine/payments/payment-queries", mockUrl("payments")],
  ["@openbooks/engine/testing/payments/payment-return", mockUrl("payments")],
  ["@openbooks/engine/testing/payments-core/rail-cpa005", mockUrl("payments")],
  ["@openbooks/engine/testing/payments-core/rail-nacha", mockUrl("payments")],
  ["@openbooks/engine/testing/payments-core/rail-sepa", mockUrl("payments")],
  ["@openbooks/engine/testing/payments-core/rail-cemtex", mockUrl("payments")],
  ["@openbooks/engine/payments-core/rail-settings", mockUrl("payments")],
  ["@openbooks/engine/payments/run-cancellation", mockUrl("payments")],
  ["@openbooks/engine/payments/run-creation", mockUrl("payments")],
  ["@openbooks/engine/testing/payments/run-files", mockUrl("payments")],
  ["@openbooks/engine/payments/run-posting", mockUrl("payments")],
  ["@openbooks/engine/payments/run-readiness", mockUrl("payments")],
  ["@openbooks/engine/payments/settlement-policy", mockUrl("payments")],
  ["@openbooks/engine/platform/business-date/module", mockUrl("business-date")],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (isEngineModuleImport(specifier, context.parentURL, "@openbooks/engine/platform/db"))
      return { url: mockUrl("db"), shortCircuit: true };
    const mocked =
      mockUrls.get(specifier) ?? mockUrls.get(canonicalEngineSpecifier(specifier) ?? "");
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const parsed = new URL(url);
    if (parsed.searchParams.has("bank-accounts-mock")) {
      const source = mockSources.get(parsed.searchParams.get("bank-accounts-mock") ?? "");
      if (source !== undefined) return { format: "module", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?bank-accounts-route-test";
const { POST, PATCH, DELETE } = (await import(routeUrl)) as typeof import("./route.ts");
after(() => hooks.deregister());

function reset(operation: RouteState["operation"]): void {
  state.insertedBankId = null;
  state.operation = operation;
  state.allowedSubsidiaryIds = null;
  state.partySubsidiary = null;
  state.rehomeAfterPreflight = false;
  state.inFlightPayment = false;
  state.liveMandate = false;
  state.updatedAt = ACTUAL_UPDATED_AT;
  state.queries = [];
  state.updateParams = [];
  state.auditCalls = 0;
  state.auditParams = [];
}

function request(method: "PATCH" | "DELETE", body: Record<string, unknown>): Promise<Response> {
  return (method === "PATCH" ? PATCH : DELETE)(
    new Request(
      `http://openbooks.test/api/parties/${PARTY_ID}/bank-accounts?accountId=${ACCOUNT_ID}`,
      {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ id: PARTY_ID }) },
  );
}

test("PATCH rejects account numbers shorter than four characters", async () => {
  reset("patch");
  const response = await request("PATCH", {
    accountNumber: "12",
    changeReason: "replace account",
    expectedUpdatedAt: ACTUAL_UPDATED_AT,
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "accountNumber required",
    issues: [{ path: "accountNumber", message: "accountNumber required" }],
  });
  assert.equal(state.updateParams.length, 0);
});

test("PATCH applies an edit directly when no approval flow listens", async () => {
  reset("patch");
  const response = await request("PATCH", {
    accountNumber: "987654321",
    changeReason: "replace account",
    expectedUpdatedAt: ACTUAL_UPDATED_AT,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    id: ACCOUNT_ID,
    approvalStatus: "approved",
    changedFields: ["accountNumber"],
  });
  assert.equal(state.updateParams.length, 2);
  assert.ok(state.updateParams[0]?.includes("4321"));
  assert.equal(state.auditCalls, 2);
  assert.equal(
    state.queries.filter((query) => query.includes("insert into flow_submissions")).length,
    1,
  );
});

test("POST applies new bank details directly when no approval flow listens", async () => {
  reset("patch");
  const response = await POST(
    new Request(`http://openbooks.test/api/parties/${PARTY_ID}/bank-accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bankName: "Meridian Bank", accountNumber: "987654321" }),
    }),
    { params: Promise.resolve({ id: PARTY_ID }) },
  );

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    id: "00000000-0000-4000-8000-000000000003",
    approvalStatus: "approved",
  });
  assert.equal(
    state.queries.filter((query) => query.includes("insert into flow_submissions")).length,
    1,
  );
  assert.equal(state.auditCalls, 1);
});

test("DELETE accepts the exact six-digit revision and attributes the retirement", async () => {
  reset("delete");
  const response = await request("DELETE", {
    retirementReason: "account retired",
    expectedUpdatedAt: ACTUAL_UPDATED_AT,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(state.updateParams.length, 1);
  assert.ok(state.updateParams[0]?.includes(ACTUAL_UPDATED_AT));
  assert.equal(state.auditCalls, 1);
  assert.ok(state.auditParams[0]?.includes("00000000-0000-4000-8000-00000000b002"));
});

test("DELETE refuses a stale revision before touching the row", async () => {
  reset("delete");
  const response = await request("DELETE", {
    retirementReason: "account retired",
    expectedUpdatedAt: "2026-08-31T12:34:55.789Z",
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error:
      "these bank details changed or were already retired; reload and review the latest revision",
  });
  assert.equal(state.updateParams.length, 0);
  assert.equal(state.auditCalls, 0);
});

test("PATCH rejects a millisecond-truncated revision before touching the row", async () => {
  reset("patch");
  const response = await request("PATCH", {
    bankName: "Updated bank",
    changeReason: "replace account",
    expectedUpdatedAt: TRUNCATED_REVISION,
  });

  assert.equal(response.status, 409);
  assert.equal(state.updateParams.length, 0);
});

test("DELETE requires the same canonical revision format as PATCH", async () => {
  reset("delete");
  const response = await request("DELETE", {
    retirementReason: "account retired",
    expectedUpdatedAt: "2026-08-31T08:34:56.789123-04:00",
  });

  assert.equal(response.status, 409);
  assert.equal(state.updateParams.length, 0);
});

// This table is the complete set of bank-account mutations that refuse on
// payment dependencies. Exercising every row keeps a new PATCH/DELETE refusal
// from reintroducing the scope-check-before-lock ordering bug.
const dependencyRefusalPaths = [
  {
    method: "PATCH" as const,
    operation: "patch" as const,
    requestBody: {
      bankName: "Updated bank",
      changeReason: "replace account",
      expectedUpdatedAt: ACTUAL_UPDATED_AT,
    },
    dependencyQuery: "from payment_instructions",
    refusalBody: {
      error:
        "cancel in-flight payment instructions referencing these bank details before editing them",
    },
    blockDependency() {
      state.inFlightPayment = true;
    },
  },
  {
    method: "DELETE" as const,
    operation: "delete" as const,
    requestBody: {
      retirementReason: "account retired",
      expectedUpdatedAt: ACTUAL_UPDATED_AT,
    },
    dependencyQuery: "from payment_mandates",
    refusalBody: {
      error:
        "cancel in-flight payment instructions and revoke live mandates before retiring these bank details",
    },
    blockDependency() {
      state.liveMandate = true;
    },
  },
];

for (const path of dependencyRefusalPaths) {
  test(`${path.method} hides dependency refusal after the party is rehomed out of scope`, async () => {
    reset(path.operation);
    state.allowedSubsidiaryIds = new Set(["sub-A"]);
    state.partySubsidiary = "sub-A";
    state.rehomeAfterPreflight = true;
    path.blockDependency();

    const response = await request(path.method, path.requestBody);

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "party not found" });
    assert.equal(
      state.queries.some((query) => query.includes(path.dependencyQuery)),
      false,
    );
    assert.equal(state.updateParams.length, 0);
  });

  test(`${path.method} returns its dependency remedy after locking the in-scope party`, async () => {
    reset(path.operation);
    state.allowedSubsidiaryIds = new Set(["sub-A"]);
    state.partySubsidiary = "sub-A";
    path.blockDependency();

    const response = await request(path.method, path.requestBody);

    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), path.refusalBody);
    const lockIndex = state.queries.findIndex(
      (query) => /from parties/i.test(query) && /for update/i.test(query),
    );
    const dependencyIndex = state.queries.findIndex((query) =>
      query.includes(path.dependencyQuery),
    );
    assert.ok(lockIndex >= 0 && dependencyIndex > lockIndex);
    assert.equal(state.updateParams.length, 0);
  });
}
