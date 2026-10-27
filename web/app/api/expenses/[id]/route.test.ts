import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { stubModules, withPlatformDbTestSurface } from "../../../../testing/stub-modules";
stubModules({ authz: true });

// Route boundary suite: the real documents OCC primitives run against a
// scripted database fake, pinning the exact-revision fence end to end.
const stateKey = Symbol.for("openbooks.expense-route-test");
interface DbCall {
  kind: "execute" | "tx-execute";
  text: string;
}
interface AuditCall {
  action: string;
  documentId: string;
}
interface RouteState {
  calls: DbCall[];
  auditCalls: AuditCall[];
  report: { doc: Record<string, unknown>; lines: unknown[] } | null;
  respondExecute: (text: string) => { rows: unknown[] };
  respondTxExecute: (text: string) => { rows: unknown[] };
}
const routeState: RouteState = {
  calls: [],
  auditCalls: [],
  report: null,
  respondExecute: () => ({ rows: [] }),
  respondTxExecute: () => ({ rows: [] }),
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

/** Flatten a drizzle SQL chunk into its raw text for keyword assertions. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((c) => {
      if (typeof c === "string") return c;
      const value = (c as { value?: unknown })?.value;
      if (typeof value === "string") return value;
      if (Array.isArray(value)) return value.map(String).join("");
      if ((c as { queryChunks?: unknown[] })?.queryChunks) return sqlText(c);
      return "";
    })
    .join("");
}
(
  globalThis as typeof globalThis & Record<string, unknown> & { openbooksSqlText?: unknown }
).openbooksSqlText = sqlText;

const mockSources = new Map<string, string>([
  [
    "mock:db",
    withPlatformDbTestSurface(`
      const state = globalThis[Symbol.for('openbooks.expense-route-test')]
      const sqlText = globalThis.openbooksSqlText
      const record = (kind, query) => {
        state.calls.push({ kind, text: sqlText(query) })
        const respond = kind === 'tx-execute' ? state.respondTxExecute : state.respondExecute
        return Promise.resolve(respond(sqlText(query)))
      }
      export const db = {
        execute: (query, mode) => Promise.resolve(record('execute', query)).then((result) => (mode === 'objects' ? result.rows : result)),
        transaction: async (work) => {
          const tx = { execute: (query, mode) => Promise.resolve(record('tx-execute', query)).then((result) => (mode === 'objects' ? result.rows : result)) }
          return work(tx)
        },
      }
      export const schema = {}
      export function withOrgTransaction(_orgId, work) { return work() }
      export async function withOrg(_orgId, work) { return work() }
      export async function withOrgContext(_orgId, work) { return work() }
      export async function withBypass(work) { return work() }
      export async function withBypassContext(_opts, work) { return work() }
      export function inDbTransaction(_work) { throw new Error('unexpected inDbTransaction') }
      export function withMaintenanceTransaction() { throw new Error('unexpected maintenance authority in expense route') }
      export function registerRequestOrgResolver() {}
      export function currentRequestOrgResolver() { return null }
      export function ambientTenantOrgId() { return null }
      export const pool = {}
      export const env = {}
      export const connectGovernedReadClient = async () => { throw new Error('no governed read client in this test') }
    `),
  ],
  [
    "mock:feature-gates",
    `
      export async function guardFeaturePermission(permission) {
        if (permission === 'expenses.read' || permission === 'expenses.create') {
          return {
            user: { orgId: 'org-1', id: 'user-1' },
            allowedSubsidiaryIds: null,
          }
        }
        return new Response(null, { status: 403 })
      }
    `,
  ],
  [
    // Expense routes authorize through the expense-access gate, which reads
    // the org-wide expense grants from authz; this caller holds them.
    "mock:expense-authz",
    `
      const caller = () => ({
        user: { orgId: 'org-1', id: 'user-1' },
        permissions: new Set(['expenses.read', 'expenses.create']),
        allowedSubsidiaryIds: null,
      })
      export function can(authz, permission) { return Boolean(authz?.permissions?.has(permission)) }
      export async function getAuthz() { return caller() }
      export async function guardPermission(permission) {
        return caller().permissions.has(permission) ? caller() : new Response(null, { status: 403 })
      }
      export async function requirePermission(permission) {
        if (!caller().permissions.has(permission)) throw new Error('forbidden')
        return caller()
      }
    `,
  ],
  [
    "mock:transaction-audit",
    `
      const state = globalThis[Symbol.for('openbooks.expense-route-test')]
      export async function captureTransactionAuditSnapshot() {
        return { snapshot: true }
      }
      export async function recordTransactionAudit(_tx, input) {
        state.auditCalls.push({ action: input.action, documentId: input.documentId })
      }
    `,
  ],
  [
    "mock:expenses-loader",
    `
      const state = globalThis[Symbol.for('openbooks.expense-route-test')]
      export async function loadExpenseReport(id, orgId) {
        return state.report
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/platform/db", "mock:db"],
  ["@openbooks/engine/records/transaction-audit", "mock:transaction-audit"],
  ["../../../../lib/feature-gates", "mock:feature-gates"],
  ["@/lib/feature-gates", "mock:feature-gates"],
  ["../../../../lib/expenses", "mock:expenses-loader"],
]);

// Engine modules reach the database through relative imports as well; those
// must hit the same double, or a shared read (segment definitions) runs
// against the real pool.
const DATABASE_MODULE_URL = new URL("../../../../../engine/src/platform/db.ts", import.meta.url)
  .href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    // load under the plain runner (same seam as documents.test.ts).
    // Forward Next.js-style aliases to the real modules they point at.
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    if (specifier === "./authz" && context.parentURL?.endsWith("/web/lib/expense-access.ts")) {
      return { url: "mock:expense-authz", shortCircuit: true };
    }
    const resolved = nextResolve(specifier, context);
    if (resolved.url === DATABASE_MODULE_URL) return { url: "mock:db", shortCircuit: true };
    return resolved;
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) {
      return { format: "module", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?expense-occ-test";
const { GET, PATCH } = (await import(routeUrl)) as typeof import("./route.ts");

const STORED_REVISION = "42";
const NEXT_REVISION = "43";
const EXPENSE_ID = "00000000-0000-4000-8000-00000000e001";

function reset(): void {
  routeState.calls.length = 0;
  routeState.auditCalls.length = 0;
  routeState.respondExecute = (text) =>
    // The org-wide subsidiary scope probe every handler runs before loading.
    text.includes("subsidiaryId") ? { rows: [{ subsidiaryId: null }] } : { rows: [] };
  routeState.respondTxExecute = () => ({ rows: [] });
}

function patch(body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new Request(`http://openbooks.test/api/expenses/${EXPENSE_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: EXPENSE_ID }) },
  );
}

function get(): Promise<Response> {
  return GET(new Request(`http://openbooks.test/api/expenses/${EXPENSE_ID}`), {
    params: Promise.resolve({ id: EXPENSE_ID }),
  });
}

test("PATCH rejects a missing revision token before any write", async () => {
  reset();
  routeState.respondExecute = (text) =>
    text.includes("status") && text.includes("document_date")
      ? { rows: [{ status: "draft", document_date: "2026-08-24", subsidiaryId: null }] }
      : { rows: [] };

  const response = await patch({ memo: "no token" });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "the document revision is required; reload and review the latest revision",
  });
  assert.ok(
    !routeState.calls.some((call) => call.kind === "tx-execute"),
    "no transactional write ran",
  );
});

test("PATCH rejects a stale revision with a conflict and no partial write", async () => {
  reset();
  routeState.respondExecute = (text) =>
    text.includes("from documents") && text.includes("status")
      ? { rows: [{ status: "draft", document_date: "2026-08-24", subsidiaryId: null }] }
      : { rows: [] };
  routeState.respondTxExecute = (text) =>
    text.includes("for update")
      ? { rows: [{ status: "draft", updatedAt: NEXT_REVISION }] }
      : { rows: [] };

  const response = await patch({ memo: "stale save", expectedUpdatedAt: STORED_REVISION });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "this document changed after you opened it; reload and review the latest revision",
  });
  assert.equal(routeState.auditCalls.length, 0, "the fenced write never reached the audit trail");
  assert.ok(
    !routeState.calls.some((call) => call.text.includes("update documents")),
    "no header overwrite ran",
  );
});

test("a non-draft expense report still refuses edits outright", async () => {
  reset();
  routeState.respondExecute = (text) =>
    text.includes("status")
      ? { rows: [{ status: "posted", document_date: "2026-08-24", subsidiaryId: null }] }
      : { rows: [] };

  const response = await patch({ memo: "x", expectedUpdatedAt: STORED_REVISION });

  assert.equal(response.status, 422);
  assert.match(
    ((await response.json()) as { error: string }).error,
    /posted expense report cannot be edited/,
  );
});

test("PATCH saves only under an exact matching revision and returns the fresh token", async () => {
  reset();
  let storedRevision = STORED_REVISION;
  routeState.report = {
    doc: { id: EXPENSE_ID, subtotal: "10.00", updated_at: NEXT_REVISION },
    lines: [],
  };
  routeState.respondExecute = (text) => {
    if (text.includes("status") && text.includes("document_date")) {
      return { rows: [{ status: "draft", document_date: "2026-08-24", subsidiaryId: null }] };
    }
    return { rows: [] };
  };
  routeState.respondTxExecute = (text) => {
    if (text.includes("for update")) {
      return { rows: [{ status: "draft", updatedAt: storedRevision }] };
    }
    if (text.includes("select kind, document_date")) {
      return { rows: [{ kind: "expense_report", transactionDate: "2026-08-24" }] };
    }
    if (text.includes("update documents")) {
      assert.match(
        text,
        /returning id/,
        "the required header write must return its persisted identity",
      );
      storedRevision = NEXT_REVISION;
      return { rows: [{ id: EXPENSE_ID }] };
    }
    return { rows: [] };
  };

  const response = await patch({
    memo: "concurrent-safe save",
    expectedUpdatedAt: STORED_REVISION,
  });

  assert.equal(
    response.status,
    200,
    JSON.stringify({ response: await response.clone().json(), calls: routeState.calls }),
  );
  const payload = (await response.json()) as { doc: { updated_at: string } };
  assert.equal(payload.doc.updated_at, NEXT_REVISION, "the caller can chain the next exact save");
  assert.deepEqual(routeState.auditCalls, [{ action: "update", documentId: EXPENSE_ID }]);
  const lock = routeState.calls.find(
    (call) => call.kind === "tx-execute" && call.text.includes("for update"),
  );
  assert.ok(lock, "the write transaction locks the row first");
  assert.match(lock.text, /revision_seq/, "the lock reads the native counter revision");
});

test("GET exposes the exact persisted revision so callers can fence their next save", async () => {
  reset();
  routeState.report = { doc: { id: EXPENSE_ID, updated_at: STORED_REVISION }, lines: [] };
  routeState.respondExecute = (text) => {
    // Any direct query is recorded; the loader now owns the coherent snapshot.
    if (text.includes("subsidiaryId")) return { rows: [{ subsidiaryId: null }] };
    return { rows: [] };
  };

  const response = await get();

  assert.equal(response.status, 200);
  const payload = (await response.json()) as { doc: { updated_at: string } };
  assert.equal(payload.doc.updated_at, STORED_REVISION);
  // The route's native feature gate reads the organization's feature switches
  // before authorizing; no direct query may read the report or its revision.
  assert.deepEqual(
    routeState.calls.filter(
      (call) => !/^select settings->'features' as f from orgs where id = /.test(call.text.trim()),
    ),
    [],
    "the coherent loader token is never replaced by a later query",
  );
});
