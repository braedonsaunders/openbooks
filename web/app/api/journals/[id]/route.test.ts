import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Route boundary suite: the real documents OCC primitives run against a
// scripted database fake, pinning the exact-revision fence end to end.
const stateKey = Symbol.for("openbooks.journal-route-test");
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
  globalThis as typeof globalThis & Record<string, unknown> & { openbooksSqlTextJournal?: unknown }
).openbooksSqlTextJournal = sqlText;

const mockSources = new Map<string, string>([
  [
    "mock:db",
    `
      export function pinnedTransactionExecutor() { throw new Error('unexpected pinned transaction in boundary test') }
      export function inExecutorTransaction() { throw new Error('unexpected inExecutorTransaction in route boundary test') }
      export function orgContext() { throw new Error('unexpected orgContext in route boundary test') }

      const state = globalThis[Symbol.for('openbooks.journal-route-test')]
      const sqlText = globalThis.openbooksSqlTextJournal
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
      export function registerRequestOrgResolver() {}
      export function currentRequestOrgResolver() { return null }
      export function ambientTenantOrgId() { return null }
      export async function withTransactionSavepoint(_tx, work) { return work() }
      export const pool = {}
      export const env = {}
    `,
  ],
  [
    "mock:authz",
    `
      export async function guardPermission(permission) {
        if (permission === 'gl.read' || permission === 'gl.post') {
          return {
            user: { orgId: 'org-1', id: 'user-1', roles: [] },
            permissions: new Set(['gl.read', 'gl.post']),
            allowedSubsidiaryIds: null,
          }
        }
        return new Response(null, { status: 403 })
      }
      // Org-wide scope (null): every subsidiary is visible.
      export function guardSubsidiaryScope(authz, _subsidiaryId) { return null }
      export function subsidiariesInScope(_authz, _ids) { return true }
    `,
  ],
  [
    "mock:transaction-audit",
    `
      const state = globalThis[Symbol.for('openbooks.journal-route-test')]
      export async function captureTransactionAuditSnapshot() {
        return { snapshot: true }
      }
      export async function recordTransactionAudit(_tx, input) {
        state.auditCalls.push({ action: input.action, documentId: input.documentId })
      }
    `,
  ],
  [
    "mock:journals-loader",
    `
      const state = globalThis[Symbol.for('openbooks.journal-route-test')]
      export async function loadJournalDoc(id, orgId) {
        return state.report
      }
      export async function redactJournalHeaderCustom(loaded) {
        return loaded
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/platform/db", "mock:db"],
  ["@openbooks/engine/records/transaction-audit", "mock:transaction-audit"],
  ["@/lib/authz", "mock:authz"],
  ["../../../../lib/authz", "mock:authz"],
  ["../../../../lib/journals", "mock:journals-loader"],
  ["@/lib/journals", "mock:journals-loader"],
]);

const ENGINE_READERS =
  /\/engine\/src\/(records\/custom-fields|organization\/(segments|feature-state))\.ts$/;
registerHooks({
  resolve(specifier, context, nextResolve) {
    // load under the plain runner (same seam as documents.test.ts).
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    // Engine custom-field, segment and feature-state readers import the transport relatively.
    if (specifier === "../platform/db.ts" && ENGINE_READERS.test(context.parentURL ?? ""))
      return { url: "mock:db", shortCircuit: true };
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

const routeUrl = "./route.ts?journal-occ-test";
const { GET, PATCH, DELETE } = (await import(routeUrl)) as typeof import("./route.ts");
const STORED_REVISION = "2026-08-24T12:00:00.200001Z";
const NEXT_REVISION = "2026-08-24T12:00:00.200002Z";
const JOURNAL_ID = "00000000-0000-4000-8000-00000000j001".replace("j", "a");
const ACCOUNT_ID = "00000000-0000-4000-8000-00000000a001";
// Edited legs resolve a subsidiary via line, else header — the locked row carries the header one.
const SUBSIDIARY_ID = "00000000-0000-4000-8000-00000000b001";

function reset(): void {
  routeState.calls.length = 0;
  routeState.auditCalls.length = 0;
  routeState.report = null;
  routeState.respondExecute = (text) =>
    // The org-wide subsidiary scope probe every handler runs before loading.
    text.includes("subsidiaryId") ? { rows: [{ subsidiaryId: null }] } : { rows: [] };
  routeState.respondTxExecute = () => ({ rows: [] });
}

function patch(body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new Request(`http://openbooks.test/api/journals/${JOURNAL_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: JOURNAL_ID }) },
  );
}

function remove(body?: Record<string, unknown>): Promise<Response> {
  return DELETE(
    new Request(`http://openbooks.test/api/journals/${JOURNAL_ID}`, {
      method: "DELETE",
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ id: JOURNAL_ID }) },
  );
}

test("PATCH rejects a missing revision token before any write", async () => {
  reset();
  routeState.respondExecute = (text) =>
    text.includes("status") ? { rows: [{ status: "draft", subsidiaryId: null }] } : { rows: [] };

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
    text.includes("from documents") && text.includes("status") && !text.includes("updatedAt")
      ? { rows: [{ status: "draft", subsidiaryId: null }] }
      : { rows: [{ updatedAt: STORED_REVISION }] };
  routeState.respondTxExecute = (text) =>
    text.includes("for update")
      ? { rows: [{ status: "draft", updatedAt: NEXT_REVISION }] }
      : { rows: [] };

  const response = await patch({
    memo: "stale save",
    expectedUpdatedAt: STORED_REVISION,
    lines: [{ accountId: ACCOUNT_ID, amount: "10.00" }],
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "this document changed after you opened it; reload and review the latest revision",
  });
  assert.equal(routeState.auditCalls.length, 0, "the fenced write never reached the audit trail");
});

test("PATCH saves lines and header atomically under an exact matching revision", async () => {
  reset();
  let storedRevision = STORED_REVISION;
  routeState.report = { doc: { id: JOURNAL_ID }, lines: [] };
  routeState.respondExecute = (text) =>
    text.includes("from documents") && text.includes("status") && !text.includes("updatedAt")
      ? { rows: [{ status: "draft", subsidiaryId: null }] }
      : { rows: [{ updatedAt: storedRevision }] };
  // Persisted journal validation reads back the balanced draft it wrote.
  const savedLines = ["10.0000", "-10.0000"];
  routeState.respondTxExecute = (text) => {
    if (text.includes("for update")) {
      return {
        rows: [{ status: "draft", updatedAt: storedRevision, subsidiaryId: SUBSIDIARY_ID }],
      };
    }
    if (text.includes("insert into document_lines")) return { rows: [{ id: "journal-line" }] };
    if (text.includes("update documents")) {
      if (text.includes("greatest(")) storedRevision = NEXT_REVISION;
      else
        assert.match(
          text,
          /set subtotal=/,
          "only the measured total is written outside the revision advance",
        );
      return { rows: [{ id: JOURNAL_ID }] };
    }
    if (text.includes('select kind, document_date::text as "transactionDate" from documents')) {
      return { rows: [{ kind: "journal", transactionDate: "2026-09-22" }] };
    }
    if (text.includes("from documents d join subsidiaries s")) {
      return {
        rows: [
          {
            subsidiary_id: SUBSIDIARY_ID,
            document_date: "2026-09-22",
            posting_date: "2026-09-22",
            currency: "USD",
            fx_rate: "1",
            journal_mode: "monetary",
            journal_reverse_on: null,
            accounting_book_id: null,
            base_currency: "USD",
          },
        ],
      };
    }
    if (text.includes("from document_lines l join documents d")) {
      return {
        rows: savedLines.map((amount, index) => ({
          line_number: index + 1,
          account_id: ACCOUNT_ID,
          type: "expense",
          amount,
          quantity: "1",
          unit: null,
          subsidiary_id: SUBSIDIARY_ID,
          journal_currency: null,
          journal_fx_rate: null,
          journal_eliminate: false,
          template: null,
          has_party: false,
        })),
      };
    }
    if (text.includes("select count(*)::int as count from document_lines"))
      return { rows: [{ count: savedLines.length }] };
    if (text.includes("select code from currencies")) return { rows: [{ code: "USD" }] };
    if (text.includes("from accounting_books") && text.includes("is_primary"))
      return { rows: [{ id: "primary-book" }] };
    if (text.includes("public.accounting_book_currency(") && text.includes("from subsidiaries"))
      return { rows: [{ id: SUBSIDIARY_ID, currency: "USD" }] };
    if (text.includes("from subsidiaries"))
      return { rows: [{ id: SUBSIDIARY_ID, base_currency: "USD", baseCurrency: "USD" }] };
    return { rows: [] };
  };

  const response = await patch({
    memo: "concurrent-safe save",
    expectedUpdatedAt: STORED_REVISION,
    lines: [
      { accountId: ACCOUNT_ID, amount: "10.00" },
      { accountId: ACCOUNT_ID, amount: "-10.00" },
    ],
  });

  assert.equal(response.status, 200);
  const payload = (await response.json()) as { doc: { updated_at: string } };
  assert.equal(payload.doc.updated_at, NEXT_REVISION, "the caller can chain the next exact save");
  assert.deepEqual(routeState.auditCalls, [{ action: "update", documentId: JOURNAL_ID }]);
  const lock = routeState.calls.find(
    (call) => call.kind === "tx-execute" && call.text.includes("for update"),
  );
  assert.ok(lock, "the write transaction locks the row first");
  // Journal totals are the summed debits; the credit leg rides as negative.
  const inserted = routeState.calls.filter((call) =>
    call.text.includes("insert into document_lines"),
  );
  assert.equal(inserted.length, 2);
});

test("DELETE with an empty body reaches the named revision refusal, never a raw body error", async () => {
  reset();

  const response = await remove();

  assert.equal(response.status, 409);
  const payload = (await response.json()) as { error?: unknown };
  assert.equal(
    payload.error,
    "the document revision is required; reload and review the latest revision",
  );
  assert.ok(
    !routeState.calls.some((call) => call.kind === "tx-execute"),
    "no transactional write ran",
  );
});

test("DELETE for an unknown journal answers not-found before fencing", async () => {
  reset();
  routeState.respondExecute = () => ({ rows: [] });

  const response = await remove({ expectedUpdatedAt: STORED_REVISION });

  assert.equal(response.status, 404);
  assert.ok(
    !routeState.calls.some((call) => call.kind === "tx-execute"),
    "no transactional write ran",
  );
});

test("GET exposes the exact persisted revision so callers can fence their next save", async () => {
  reset();
  routeState.report = { doc: { id: JOURNAL_ID }, lines: [] };
  routeState.respondExecute = (text) => {
    // The org-wide subsidiary scope probe runs before the payload loads.
    if (text.includes("subsidiaryId")) return { rows: [{ subsidiaryId: null }] };
    if (text.includes("updatedAt")) return { rows: [{ updatedAt: STORED_REVISION }] };
    return { rows: [] };
  };

  const response = await GET(new Request(`http://openbooks.test/api/journals/${JOURNAL_ID}`), {
    params: Promise.resolve({ id: JOURNAL_ID }),
  });

  assert.equal(response.status, 200);
  const payload = (await response.json()) as { doc: { updated_at: string } };
  assert.equal(payload.doc.updated_at, STORED_REVISION);
});
