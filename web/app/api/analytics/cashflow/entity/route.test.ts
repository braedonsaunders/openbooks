import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.cashflow-entity-route-test");
interface RouteState {
  allowedSubsidiaryIds: Set<string> | null;
  partySubsidiaryId: string | null;
  calls: string[];
}

const routeState: RouteState = {
  allowedSubsidiaryIds: new Set(["sub-allowed"]),
  partySubsidiaryId: null,
  calls: [],
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
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksCashflowEntitySqlText = sqlText;

const mockSources = new Map<string, string>([
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.cashflow-entity-route-test')]
      const sqlText = globalThis.openbooksCashflowEntitySqlText
      export const db = {
        execute(query) {
          const text = sqlText(query)
          state.calls.push(text)
          if (text.includes('from parties')) return Promise.resolve({ rows: [{ subsidiaryId: state.partySubsidiaryId }] })
          // The shared open-items reader projects through the document's
          // current posting entry; its rows carry the party for the drill's
          // filter. Dispatched before 'from applications'/'from documents d',
          // which both appear inside the reader query as well.
          if (text.includes('d.posted_entry_id')) return Promise.resolve({ rows: [{
            id: 'line-open', entry_id: 'entry-open', doc_id: 'doc-open', doc_kind: 'customer_invoice',
            doc_number: 'INV-1', party_id: '00000000-0000-4000-8000-000000000001', party_name: 'Customer One',
            tran_date: '2026-08-01', due_date: '2026-08-10', remaining: '999999999999998.9999', func: null,
          }, {
            id: 'line-open-2', entry_id: 'entry-open-2', doc_id: 'doc-open-2', doc_kind: 'customer_invoice',
            doc_number: 'INV-2', party_id: '00000000-0000-4000-8000-000000000001', party_name: 'Customer One',
            tran_date: '2026-08-02', due_date: '2026-08-20', remaining: '0.1250', func: null,
          }] })
          if (text.includes('from orgs')) return Promise.resolve({ rows: [{ baseCurrency: 'USD' }] })
          if (text.includes('from applications')) return Promise.resolve({ rows: [{ avg_days: '12.5', total_paid: '999999999999999.9999', payment_count: '1' }] })
          if (text.includes('from documents d')) return Promise.resolve({ rows: [{
            doc_id: 'doc-payment', doc_kind: 'customer_payment', entry_id: 'entry-payment', document_number: 'PAY-1',
            date: '2026-08-12', amount: '999999999999999.9999',
          }] })
          throw new Error('unexpected database query: ' + text)
        },
      }
      export async function withBypassContext(work) { return work() }
      export function ambientTenantOrgId() { return null }
      // The route reads the shared open-items reader, which pulls the cash
      // core's import chain (org-scope -> auth -> request-org). Nothing on
      // that chain runs — the route's own authz boundary stays mocked — but
      // request-org registers its resolver at import time.
      export function registerRequestOrgResolver() {}
      export function currentRequestOrgResolver() { return null }
      export const env = {}
      export async function withBypass(work) { return work() }
      export async function withOrgContext(orgId, work) { return work() }
    `,
  ],
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.cashflow-entity-route-test')]
      export async function guardPermission() {
        return {
          user: { orgId: 'org-1', id: 'user-1' },
          permissions: new Set(['reports.read']),
          allowedSubsidiaryIds: state.allowedSubsidiaryIds,
        }
      }
      export function guardSubsidiaryScope(authz, subsidiaryId, options = {}) {
        if (authz.allowedSubsidiaryIds === null) return null
        if (subsidiaryId === null && options.orgWideNull === true) return null
        if (subsidiaryId !== null && authz.allowedSubsidiaryIds.has(subsidiaryId)) return null
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
      }
    `,
  ],
  [
    "mock:business-date",
    `export async function businessToday() { return '2026-08-28' }`,
  ],
  ["mock:features", `export async function subsidiaryFeatureEnabled() { return true }`],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
  ["@openbooks/engine/src/platform/business-date.ts", "mock:business-date"],
  ["../../../../../lib/authz", "mock:authz"],
  ["./features", "mock:features"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?cashflow-entity-boundary-test";
const { GET } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

function reset(): void {
  routeState.allowedSubsidiaryIds = new Set(["sub-allowed"]);
  routeState.partySubsidiaryId = null;
  routeState.calls.length = 0;
}

function request(): Request {
  return new Request("http://openbooks.test/api/analytics/cashflow/entity?party=00000000-0000-4000-8000-000000000001&side=ar");
}

test("entity drills reject a malformed party selector before querying", async () => {
  reset();

  const response = await GET(new Request("http://openbooks.test/api/analytics/cashflow/entity?party=not-a-uuid&side=ar"));

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not found" });
  assert.equal(routeState.calls.length, 0, "malformed party must stop before the party lookup");
});

test("restricted entity drills gate the party before disclosure", async () => {
  reset();
  routeState.partySubsidiaryId = "sub-denied";

  const response = await GET(request());

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not found" });
  assert.equal(routeState.calls.length, 1, "out-of-scope party must stop before transaction queries");
});

test("entity drills scope every transaction leg and preserve exact money", async () => {
  reset();

  const response = await GET(request());
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.totalPaid, "999999999999999.9999");
  assert.equal(body.openBalance, "999999999999999.1249");
  assert.equal(body.openItems[0].remaining, "999999999999998.9999");
  assert.equal(body.openItems[1].remaining, "0.1250");
  assert.equal(body.recentPayments[0].amount, "999999999999999.9999");

  const transactionQueries = routeState.calls.slice(1);
  assert.equal(transactionQueries.length, 4);
  assert.match(transactionQueries[0]!, /bl\.subsidiary_id = any/);
  assert.match(transactionQueries[0]!, /be\.subsidiary_id = any/);
  assert.match(transactionQueries[0]!, /pl\.subsidiary_id = any/);
  assert.match(transactionQueries[0]!, /pe\.subsidiary_id = any/);
  // The open leg reads the shared reader's current-posting projection.
  assert.match(transactionQueries[1]!, /d\.posted_entry_id/);
  assert.match(transactionQueries[1]!, /jl\.subsidiary_id = any/);
  assert.match(transactionQueries[2]!, /d\.subsidiary_id = any/);
  assert.match(transactionQueries[2]!, /je\.subsidiary_id = any/);
  assert.match(transactionQueries[3]!, /from orgs/);
});

// F-t03-010: the drill's own live aggregate joined reversed entries without
// the current posting projection, so an append-only correction (reversed
// original + re-post of the same bill) listed the same bill twice and inflated
// the dialog total past the dashboard. The drill reads the shared reader's
// lateral, which names both live statuses yet admits exactly one entry per
// document: reversal entries themselves are excluded
// (reverses_entry_id is null) and a reversed original loses to the not-exists
// reversal filter — so reversed history is never collected as a second item.
test("vendor drills read open items off the shared reader, never reversed entries", async () => {
  reset();

  const response = await GET(request());
  assert.equal(response.status, 200);
  const body = await response.json();

  const reader = routeState.calls.find((text) => text.includes("d.posted_entry_id"));
  assert.ok(
    reader,
    "the drill must project open items through the document's current posting entry",
  );
  assert.match(reader!, /reverses_entry_id is null/, "reversal entries themselves are never collected");
  assert.match(reader!, /not exists/, "a reversed original loses to the reversal filter");
  assert.match(reader!, /limit 1/, "the lateral admits exactly one entry per document");

  const docIds = (body.openItems as Array<{ docId: string }>).map((item) => item.docId);
  assert.deepEqual(
    [...new Set(docIds)].sort(),
    [...docIds].sort(),
    "no bill is collected twice in the drill",
  );
});
