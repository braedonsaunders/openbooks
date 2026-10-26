import { withPlatformDbTestSurface } from "../testing/stub-modules";
import assert from "node:assert/strict";
import { canonicalEngineSpecifier, isEngineModuleImport } from "../testing/engine-resolve-hooks.ts";
import { registerHooks } from "node:module";
import test from "node:test";

// Route-boundary regression coverage: PostgreSQL timestamptz keeps six
// fractional digits while node-postgres Date values keep only milliseconds.
// The scripted database fake makes the exact revision projection and CAS
// parameter visible without needing a second database session.
const stateKey = Symbol.for("openbooks.party-bank-accounts-route-test");
interface DbCall {
  kind: "execute" | "tx-execute";
  text: string;
}
interface RouteState {
  calls: DbCall[];
}
const routeState: RouteState = { calls: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

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
(
  globalThis as typeof globalThis & Record<string, unknown> & { openbooksSqlText?: unknown }
).openbooksSqlText = sqlText;

const ORG_ID = "00000000-0000-4000-8000-00000000b001";
const PARTY_ID = "00000000-0000-4000-8000-00000000c001";
const ACCOUNT_ID = "00000000-0000-4000-8000-00000000d001";
const EXACT_REVISION = "2026-08-28T12:34:56.123456Z";
const MILLISECOND_REVISION = "2026-08-28T12:34:56.123Z";

const mockSources = new Map<string, string>([
  [
    "mock:db",
    `
      import {AsyncLocalStorage} from 'node:async_hooks';
      const transactionScope=new AsyncLocalStorage();
      export const orgContext={getStore:()=>transactionScope.getStore()};
      export const pinnedTransactionExecutor=()=>transactionScope.getStore()?.executor;
      const state = globalThis[Symbol.for('openbooks.party-bank-accounts-route-test')]
      const sqlText = globalThis.openbooksSqlText
      function respond(kind, query) {
        const text = sqlText(query)
        state.calls.push({ kind, text })
        if(text.includes('from users'))return {rows:[{id:'00000000-0000-4000-8000-00000000b002',orgId:'00000000-0000-4000-8000-00000000b001',isActive:true,isSuperAdmin:false}]};
        if(text.includes('bank_approval_fingerprint'))return {rows:[{value:'bank-fingerprint'}]};
        if(text.includes('insert into flow_submissions'))return {rows:[{id:'submission-1'}]};
        if(text.includes('lock table flows')||text.includes('from flows')||text.includes('pg_advisory_xact_lock'))return {rows:[]};

        if (text.includes('from parties')) return { rows: [{ subsidiaryId: null }] }
        if (text.includes('select approval_status')) {
          return { rows: [{ approvalStatus: 'approved', updatedAt: '${EXACT_REVISION}' }] }
        }
        if (text.includes('from party_bank_accounts') && !text.includes('update party_bank_accounts')) {
          return { rows: [{ updatedAt: '${EXACT_REVISION}' }] }
        }
        if (text.includes('update party_bank_accounts')) return { rows: [{ id: '${ACCOUNT_ID}' }] }
        return { rows: [] }
      }
      export const db = {
        select(){const result=[{id:'${ACCOUNT_ID}',orgId:'00000000-0000-4000-8000-00000000b001',partyId:'${PARTY_ID}',approvalStatus:'pending',isActive:false,createdBy:'00000000-0000-4000-8000-00000000b002',routing:{}}];let selected;const query={from(table){selected=table;return query},where(){return Promise.resolve(selected===schema.partyBankAccounts?result:[])}};return query},
        execute: (query, mode) => Promise.resolve(respond('execute', query)).then((result) => (mode === 'objects' ? result.rows : result)),
        transaction: async (work) => work({ execute: (query, mode) => Promise.resolve(respond('tx-execute', query)).then((result) => (mode === 'objects' ? result.rows : result)) }),
      }
      import * as schema from '${import.meta.resolve("@openbooks/schema")}';export {schema}
      export function withOrgTransaction(orgId, work) { return transactionScope.run({orgId,executor:db},work) }
      export async function withOrg(_orgId, work) { return work() }
      export async function withOrgContext(_orgId, work) { return work() }
      export async function withBypass(work) { return work() }
      export async function withBypassContext(_opts, work) { return work() }
      export function registerRequestOrgResolver() {}
      export const pool = {}
      export const env = {}
    `,
  ],
  [
    "mock:authz",
    `
      export async function guardPermission() {
        return { user: { id: '00000000-0000-4000-8000-00000000b002', orgId: '${ORG_ID}' }, permissions: new Set(['*']), allowedSubsidiaryIds: null }
      }
      export async function getAuthz() {
        return { user: { id: '00000000-0000-4000-8000-00000000b002', orgId: '${ORG_ID}' }, permissions: new Set(['*']), allowedSubsidiaryIds: null }
      }
      export function can(gate, perm) { return gate.permissions.has('*') || gate.permissions.has(perm) }
      export function guardSubsidiaryScope() { return null }
    `,
  ],
  [
    "mock:payments",
    `export class PaymentError extends Error {}
    export function encryptAccountNumber(value) { return 'encrypted:' + value }`,
  ],
  ["mock:bank-adapter", `export const BANK_ACCOUNT_SUBJECT_KIND = 'party_bank_account'`],
  [
    "mock:business-date",
    `export async function businessToday() { return '2026-10-09' }
    export async function businessTodayInTx() { return '2026-10-09' }`,
  ],
]);

mockSources.set("mock:db", withPlatformDbTestSurface(mockSources.get("mock:db")!));

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/platform/db", "mock:db"],
  ["@openbooks/engine/payments/payment-accounts", "mock:payments"],
  ["@openbooks/engine/payments/payment-contracts", "mock:payments"],
  ["@openbooks/engine/payments/payment-documents", "mock:payments"],
  ["@openbooks/engine/payments-core/payment-errors", "mock:payments"],
  ["@openbooks/engine/payments/payment-posting", "mock:payments"],
  ["@openbooks/engine/payments/payment-queries", "mock:payments"],
  ["@openbooks/engine/testing/payments/payment-return", "mock:payments"],
  ["@openbooks/engine/testing/payments-core/rail-cpa005", "mock:payments"],
  ["@openbooks/engine/testing/payments-core/rail-nacha", "mock:payments"],
  ["@openbooks/engine/testing/payments-core/rail-sepa", "mock:payments"],
  ["@openbooks/engine/testing/payments-core/rail-cemtex", "mock:payments"],
  ["@openbooks/engine/payments-core/rail-settings", "mock:payments"],
  ["@openbooks/engine/payments/run-cancellation", "mock:payments"],
  ["@openbooks/engine/payments/run-creation", "mock:payments"],
  ["@openbooks/engine/testing/payments/run-files", "mock:payments"],
  ["@openbooks/engine/payments/run-posting", "mock:payments"],
  ["@openbooks/engine/payments/run-readiness", "mock:payments"],
  ["@openbooks/engine/payments/settlement-policy", "mock:payments"],
  ["@openbooks/engine/platform/business-date/module", "mock:business-date"],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (isEngineModuleImport(specifier, context.parentURL, "@openbooks/engine/platform/db"))
      return { url: "mock:db", shortCircuit: true };
    if (specifier.endsWith("/lib/authz")) return { url: "mock:authz", shortCircuit: true };
    const mocked =
      mockUrls.get(specifier) ?? mockUrls.get(canonicalEngineSpecifier(specifier) ?? "");
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const routeUrl = "../app/api/parties/[id]/bank-accounts/route.ts?party-bank-accounts-occ-test";
const { PATCH, DELETE } = (await import(
  routeUrl
)) as typeof import("../app/api/parties/[id]/bank-accounts/route.ts");

function reset(): void {
  routeState.calls.length = 0;
}

function patch(expectedUpdatedAt: string): Promise<Response> {
  return PATCH(
    new Request(
      `http://openbooks.test/api/parties/${PARTY_ID}/bank-accounts?accountId=${ACCOUNT_ID}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bankName: "Updated bank",
          expectedUpdatedAt,
          changeReason: "corrected account detail",
        }),
      },
    ),
    { params: Promise.resolve({ id: PARTY_ID }) },
  );
}

function retire(expectedUpdatedAt: string): Promise<Response> {
  return DELETE(
    new Request(
      `http://openbooks.test/api/parties/${PARTY_ID}/bank-accounts?accountId=${ACCOUNT_ID}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedUpdatedAt, retirementReason: "account no longer used" }),
      },
    ),
    { params: Promise.resolve({ id: PARTY_ID }) },
  );
}

test("PATCH accepts the exact six-digit revision and binds it as timestamptz", async () => {
  reset();
  const response = await patch(EXACT_REVISION);

  assert.equal(response.status, 200);
  const select = routeState.calls.find((call) => call.text.includes("select approval_status"));
  assert.ok(select);
  assert.match(select.text, /to_char\([\s\S]*HH24:MI:SS\.US/);
  const update = routeState.calls.find((call) => call.text.includes("update party_bank_accounts"));
  assert.ok(update);
  assert.match(update.text, /updated_at = [\s\S]*::timestamptz/);
});

test("PATCH rejects a millisecond-truncated revision before any write", async () => {
  reset();
  const response = await patch(MILLISECOND_REVISION);

  assert.equal(response.status, 409);
  assert.ok(!routeState.calls.some((call) => call.text.includes("update party_bank_accounts")));
});

test("DELETE binds the exact retirement revision as timestamptz", async () => {
  reset();
  const response = await retire(EXACT_REVISION);

  assert.equal(response.status, 200);
  const update = routeState.calls.find((call) => call.text.includes("update party_bank_accounts"));
  assert.ok(update);
  assert.match(update.text, /updated_at = [\s\S]*::timestamptz/);
});
