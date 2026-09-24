import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.cashflow-entity-route-test");
interface RouteState {
  allowedSubsidiaryIds: Set<string> | null;
  partySubsidiaryId: string | null;
  calls: string[];
  payLegs: Array<{ pid: string; days: string | null; paid: string; func: string | null; date: string }>;
  fxRows: Array<{ as_of: string; rate: string }>;
}

const routeState: RouteState = {
  allowedSubsidiaryIds: new Set(["sub-allowed"]),
  partySubsidiaryId: null,
  calls: [],
  payLegs: [{ pid: "pay-1", days: "12.5", paid: "999999999999999.9999", func: null, date: "2026-08-12" }],
  fxRows: [],
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
          if (text.includes('from fx_rates')) return Promise.resolve({ rows: state.fxRows })
          if (text.includes('from applications')) return Promise.resolve({ rows: state.payLegs })
          if (text.includes('from documents d')) return Promise.resolve({ rows: [{
            doc_id: 'doc-payment', doc_kind: 'customer_payment', entry_id: 'entry-payment', document_number: 'PAY-1',
            date: '2026-08-12', func_amount: '999999999999999.9999', func: 'USD',
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
    // Star re-export of the real pure date helpers (civilDateFromParts,
    // daysInCivilMonth, utcDateFromParts): they are pure date math with
    // nothing to isolate, so a hand copy could only drift. businessToday
    // stays pinned — the explicit export shadows the re-exported one.
    "mock:business-date",
    `export * from "@openbooks/engine/src/platform/business-date.ts"
      export async function businessToday() { return '2026-08-28' }`,
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
    // The business-date double re-exports the real module, so its own star
    // import must resolve past this hook to the real file instead of looping
    // back into the mock. Re-based to this file so the workspace alias
    // resolves through node_modules like any other real import.
    if (context.parentURL?.startsWith("mock:")) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url });
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
  routeState.payLegs = [{ pid: "pay-1", days: "12.5", paid: "999999999999999.9999", func: null, date: "2026-08-12" }];
  routeState.fxRows = [];
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
  // pay + shared-reader leg + recents + the reader's org base + the
  // presentation currency lookup for translated recent amounts.
  assert.equal(transactionQueries.length, 5);
  const payQuery = transactionQueries.find((text) => text.includes("from applications"))!;
  const readerQuery = transactionQueries.find((text) => text.includes("d.posted_entry_id"))!;
  const recentQuery = transactionQueries.find((text) => text.includes("round(abs(d.total)"))!;
  assert.equal(transactionQueries.filter((text) => text.includes("from orgs")).length, 2);
  // Payment stats count distinct cash settlement documents, scoped on every
  // leg including the newly joined source document.
  assert.match(payQuery, /bl\.subsidiary_id = any/);
  assert.match(payQuery, /be\.subsidiary_id = any/);
  assert.match(payQuery, /pl\.subsidiary_id = any/);
  assert.match(payQuery, /pe\.subsidiary_id = any/);
  assert.match(payQuery, /sp\.subsidiary_id = any/);
  assert.match(payQuery, /sp\.kind in/);
  assert.match(payQuery, /group by pe\.source_document_id/);
  // The open leg reads the shared reader's current-posting projection.
  assert.match(readerQuery, /jl\.subsidiary_id = any/);
  // Recents list posted sources joined one-to-one to their statement-book
  // posting — no drafts, no second-book duplicates, translated amounts.
  assert.match(recentQuery, /d\.subsidiary_id = any/);
  assert.match(recentQuery, /je\.subsidiary_id = any/);
  assert.match(recentQuery, /d\.status = 'posted'/);
  assert.match(recentQuery, /je\.status in \('posted', 'reversed'\)/);
  assert.match(recentQuery, /je\.book_id =/);
  assert.ok(!recentQuery.includes("left join journal_entries"));
  assert.equal(body.currency, "USD");
});

test("entity totalPaid translates each payment leg to presentation currency", async () => {
  // A two-frame party (USD base + CAD leg): 100 USD + 100 CAD at 0.74 reads
  // 174 USD, never 200. Driven through the route with an independent
  // expected value — no source or SQL text is asserted.
  reset();
  routeState.payLegs = [
    { pid: "pay-usd", days: "9", paid: "100", func: "USD", date: "2026-08-10" },
    { pid: "pay-cad", days: "7", paid: "100", func: "CAD", date: "2026-08-12" },
  ];
  routeState.fxRows = [{ as_of: "2026-08-01", rate: "0.7400" }];

  const response = await GET(request());
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.currency, "USD");
  assert.equal(body.paymentCount, 2);
  assert.equal(body.avgDays, 8);
  assert.equal(body.totalPaid, "174.0000");
});

test("entity totalPaid refuses when a payment leg has no exchange rate", async () => {
  reset();
  routeState.payLegs = [
    { pid: "pay-cad", days: "7", paid: "100", func: "CAD", date: "2026-08-12" },
  ];
  routeState.fxRows = [];

  const response = await GET(request());
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.error, "missing exchange rate");
  assert.match(body.message, /no spot rate for CAD→USD/);
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
