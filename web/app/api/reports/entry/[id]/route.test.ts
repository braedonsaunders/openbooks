import assert from "node:assert/strict";
import { stubModules } from "../../../../../testing/stub-modules";
import test from "node:test";
import { NextResponse } from "next/server";

// An intercompany journal entry whose header is visible may still carry lines for subsidiaries outside
// the caller's scope. The line query must enforce the same scope as the header.

interface RouteState {
  allowedSubsidiaryIds: Set<string> | null;
  /** Null = legacy unrestricted caller (the pre-existing tests). */
  permissions: string[] | null;
  queries: string[];
  /** When true the lines query returns payroll-origin party-tagged lines. */
  payrollLines: boolean;
  journalDocument: boolean;
}

const stateKey = Symbol.for("openbooks.reports-entry-route-test");
const routeState: RouteState = {
  allowedSubsidiaryIds: null,
  permissions: null,
  queries: [],
  payrollLines: false,
  journalDocument: false,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;
(
  globalThis as typeof globalThis & Record<string, unknown>
).openbooksReportsEntryNextResponse = NextResponse;

const reportsEntryAuthzStub = `
  const state = globalThis[Symbol.for('openbooks.reports-entry-route-test')]
  const NextResponse = globalThis.openbooksReportsEntryNextResponse
  function grants(permission) {
    if (state.permissions === null) return true
    const held = new Set(state.permissions)
    return held.has('*') || held.has(permission) || held.has(permission.split('.')[0] + '.*')
  }
  function authz() {
    return { user: { orgId: 'org-1', id: 'user-1', roles: [] }, permissions: new Set(state.permissions ?? ['*']), allowedSubsidiaryIds: state.allowedSubsidiaryIds }
  }
  export async function guardPermission(permission) {
    return grants(permission) ? authz() : NextResponse.json({ error: 'missing permission: ' + permission }, { status: 403 })
  }
  export async function getAuthz() { return authz() }
  export function can(gate, permission) {
    return gate.permissions.has('*') || gate.permissions.has(permission) || gate.permissions.has(permission.split('.')[0] + '.*')
  }
  export function unauthorized() { return NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }
  export function guardUnrestrictedScope() { return null }
  export async function guardRootSubsidiaryScope() { return null }
  export function guardSubsidiaryScope() { return null }
  export function subsidiariesInScope() { return [] }
`;

/** Flatten a drizzle SQL chunk into its template text for scripted DB replies. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      const value = (chunk as { value?: unknown[] })?.value;
      if (Array.isArray(value)) return value.map(String).join("");
      if ((chunk as { queryChunks?: unknown[] })?.queryChunks)
        return sqlText(chunk);
      return "";
    })
    .join("");
}
(
  globalThis as typeof globalThis & Record<string, unknown>
).openbooksReportsEntrySqlText = sqlText;

stubModules({
  navigation: false,
  intl: false,
  authz: reportsEntryAuthzStub,
  features: false,
  extra: {
    "./authz": reportsEntryAuthzStub,
    "@/lib/feature-gates": `
      const state = globalThis[Symbol.for('openbooks.reports-entry-route-test')]
      const NextResponse = globalThis.openbooksReportsEntryNextResponse
      export async function guardFeaturePermission(permission) {
        if (state.permissions === null || state.permissions.includes('*') || state.permissions.includes(permission) || state.permissions.includes(permission.split('.')[0] + '.*')) {
          return { user: { orgId: 'org-1', id: 'user-1' }, permissions: new Set(state.permissions ?? ['*']), allowedSubsidiaryIds: state.allowedSubsidiaryIds }
        }
        return NextResponse.json({ error: 'missing permission: ' + permission }, { status: 403 })
      }
    `,
    "@openbooks/engine/src/platform/db.ts": `
      export * as schema from '${import.meta.resolve('@openbooks/schema')}'
      export function currentRequestOrgResolver() { return undefined }
      export function registerRequestOrgResolver() {}
      export function ambientTenantOrgId() { return 'org-1' }
      export async function withOrgTransaction(orgId, work) { return work(db) }
      export async function withBypass(work) { return work(db) }
      const state = globalThis[Symbol.for('openbooks.reports-entry-route-test')]
      const sqlText = globalThis.openbooksReportsEntrySqlText
      const visibleLine = {
        line_number: 1,
        amount: '10.0000',
        memo: 'visible line',
        is_open_item: false,
        account_id: 'account-visible',
        account_number: '1000',
        account_name: 'Visible account',
        party: null,
        department: null,
        project: null,
      }
      const restrictedLine = {
        line_number: 2,
        amount: '-10.0000',
        memo: 'restricted line',
        is_open_item: false,
        account_id: 'account-restricted',
        account_number: '2000',
        account_name: 'Restricted account',
        party: null,
        department: null,
        project: null,
      }
      // Two per-employee net-pay legs of a payroll settlement plus its bank
      // leg, as the real line query returns them (party ids, source-document
      // kind, and entry origin included).
      const payrollRows = [
        {
          line_number: 1,
          amount: '1500.0000',
          memo: 'Net pay PAY-001 · cheque 101',
          is_open_item: true,
          account_id: 'account-netpay',
          account_number: '2000',
          account_name: 'Net pay payable',
          party: 'Alice Anderson',
          party_id: 'employee-alice',
          custom: { employee_note: 'Alice Anderson payroll detail' },
          department: null,
          project: null,
          doc_kind: 'pay_run',
          entry_origin: 'payroll',
        },
        {
          line_number: 2,
          amount: '2500.0000',
          memo: 'Net pay PAY-001 · cheque 102',
          is_open_item: true,
          account_id: 'account-netpay',
          account_number: '2000',
          account_name: 'Net pay payable',
          party: 'Bob Brown',
          party_id: 'employee-bob',
          custom: { employee_note: 'Bob Brown payroll detail' },
          department: null,
          project: null,
          doc_kind: 'pay_run',
          entry_origin: 'payroll',
        },
        {
          line_number: 3,
          amount: '-4000.0000',
          memo: 'Net pay PAY-001',
          is_open_item: false,
          account_id: 'account-bank',
          account_number: '1000',
          account_name: 'Cash',
          party: null,
          party_id: null,
          department: null,
          project: null,
          doc_kind: 'pay_run',
          entry_origin: 'payroll',
        },
      ]
      export const db = {
        async execute(query) {
          const text = sqlText(query)
          state.queries.push(text)
          if (text.includes('from journal_entries e')) {
            return { rows: [{ id: '00000000-0000-4000-8000-000000000001', subsidiary_id: 'sub-visible',
              ...(state.payrollLines ? { origin: 'payroll', custom: { employee_note: 'Alice Anderson' } } : {}),
              ...(state.journalDocument ? { doc_id: '00000000-0000-4000-8000-000000000002', doc_kind: 'journal', source_document_id: null } : {}) }] }
          }
          if (text.includes('from documents d')) return { rows: [{
            id: '00000000-0000-4000-8000-000000000002', entry_id: '00000000-0000-4000-8000-000000000001',
            kind: 'journal', status: 'posted', updated_at: '42', custom: { native_note: 'Reviewed journal' },
          }] }
          if (text.includes('from document_lines l')) return { rows: [] }
          if (text.includes('from custom_field_defs')) return { rows: [{
            id: 'field-1', key: 'native_note', label: 'Native note', fieldType: 'text', config: {}, isRequired: false, sortOrder: 0,
          }] }
          if (text.includes('from segment_definitions') || text.includes('from form_layouts') ||
              text.includes('from role_assignments') || text.includes('from user_form_preferences')) return { rows: [] }
          if (text.includes('from orgs')) return { rows: [{ f: { multiSubsidiary: false, multiCurrency: false }, complexity: 'standard' }] }
          if (text.includes('from journal_lines l')) {
            if (state.payrollLines) return { rows: payrollRows }
            // Model PostgreSQL applying the query predicate: without the
            // predicate both intercompany lines would be returned.
            return text.includes('l.subsidiary_id in')
              ? { rows: [visibleLine] }
              : { rows: [visibleLine, restrictedLine] }
          }
          throw new Error('unexpected database query: ' + text)
        },
      }
      export async function withBypassContext(work) { return work() }
    `,
  },
});

const routeUrl = "./route.ts?reports-entry-subsidiary-scope-test";
const { GET } = (await import(routeUrl)) as typeof import("./route.ts");

function reset(allowedSubsidiaryIds: Set<string> | null, permissions: string[] | null = null, payrollLines = false): void {
  routeState.allowedSubsidiaryIds = allowedSubsidiaryIds;
  routeState.permissions = permissions;
  routeState.queries.length = 0;
  routeState.payrollLines = payrollLines;
  routeState.journalDocument = false;
}

function get(journal = false): Promise<Response> {
  return GET(new Request(`http://openbooks.test/api/reports/entry/entry-1${journal ? '?journal=1' : ''}`), {
    params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000001" }),
  });
}

test("restricted callers receive only lines from allowed subsidiaries", async () => {
  reset(new Set(["sub-visible"]));

  const response = await get();

  assert.equal(response.status, 200);
  const body = (await response.json()) as { lines: Array<{ memo: string }> };
  assert.deepEqual(
    body.lines.map((line) => line.memo),
    ["visible line"],
  );
  assert.ok(
    routeState.queries.some(
      (query) =>
        query.includes("from journal_lines l") &&
        query.includes("l.subsidiary_id in"),
    ),
    "the journal-line query must constrain each line to the caller subsidiary scope",
  );
});

test("reports.read-only roles can open the entry flyout data", async () => {
  // Sales roles hold reports.read without gl.read and can already read every
  // line of this entry on the journal page; the flyout must not 403 them.
  reset(null, ["reports.read"]);

  const response = await get();

  assert.equal(response.status, 200);
  const body = (await response.json()) as { lines: Array<{ memo: string }> };
  assert.deepEqual(
    body.lines.map((line) => line.memo),
    ["visible line", "restricted line"],
  );
});

test("reports.read roles keep line-level subsidiary scope", async () => {
  reset(new Set(["sub-visible"]), ["reports.read"]);

  const response = await get();

  assert.equal(response.status, 200);
  const body = (await response.json()) as { lines: Array<{ memo: string }> };
  assert.deepEqual(
    body.lines.map((line) => line.memo),
    ["visible line"],
  );
});

test("gl.read-only roles keep access", async () => {
  reset(null, ["gl.read"]);

  const response = await get();

  assert.equal(response.status, 200);
  routeState.journalDocument = true;
  const native = await get(true);
  assert.equal(native.status, 200);
  const body = await native.json();
  assert.equal(body.sourceJournal.doc.updated_at, '42');
  assert.deepEqual(body.sourceJournal.lines, [], 'native detail never substitutes editable source lines for posted GL evidence');
  assert.equal(body.canPost, false, 'read-only access does not expose lifecycle mutations');
  assert.equal(body.headerDefs[0].key, 'native_note');
  assert.equal(body.lineDefs[0].key, 'native_note');
  assert.match(JSON.stringify(body.layout), /cf_native_note/, 'the standard form resolver includes native custom fields');
  assert.ok(routeState.queries.some((query) => query.includes('source.posted_entry_id = e.id')), 'legacy journal documents are resolved through their current posted entry');
});

test("callers with neither gl.read nor reports.read are refused", async () => {
  reset(null, ["ap.read"]);

  const response = await get();

  assert.equal(response.status, 403);
});

test("unrestricted callers retain every journal line", async () => {
  reset(null);

  const response = await get();

  assert.equal(response.status, 200);
  const body = (await response.json()) as { lines: Array<{ memo: string }> };
  assert.deepEqual(
    body.lines.map((line) => line.memo),
    ["visible line", "restricted line"],
  );
  assert.ok(
    !routeState.queries.some(
      (query) =>
        query.includes("from journal_lines l") &&
        query.includes("l.subsidiary_id in"),
    ),
    "unrestricted callers must not receive a narrowed query",
  );
});

test("reports.read-only roles see one restricted payroll line per account, never employee detail", async () => {
  reset(null, ["reports.read", "gl.read"], true);

  const response = await get();

  assert.equal(response.status, 200);
  const body = (await response.json()) as { lines: Array<Record<string, unknown>> };
  const text = JSON.stringify(body);
  assert.ok(!text.includes("Alice Anderson") && !text.includes("Bob Brown"), "no employee names");
  assert.ok(!text.includes("cheque"), "no per-employee cheque memos");
  assert.ok(!text.includes("employee-alice") && !text.includes("employee-bob"), "no employee ids");
  assert.equal(body.lines.length, 2);
  const pay = body.lines.find((line) => line.account_number === "2000") as Record<string, unknown>;
  assert.equal(pay.party, "Payroll (restricted)");
  assert.equal(pay.memo, null);
  assert.equal(pay.amount, "4000.0000");
  const bank = body.lines.find((line) => line.account_number === "1000") as Record<string, unknown>;
  assert.equal(bank.amount, "-4000.0000");
  assert.equal(bank.party, null);
});

test("payroll.read roles keep full per-employee entry detail", async () => {
  reset(null, ["reports.read", "gl.read", "payroll.read"], true);

  const response = await get();

  assert.equal(response.status, 200);
  const body = (await response.json()) as { lines: Array<Record<string, unknown>> };
  assert.equal(body.lines.length, 3);
  const text = JSON.stringify(body.lines);
  assert.ok(text.includes("Alice Anderson") && text.includes("cheque 102"));
});

test("malformed entry ids refuse before PostgreSQL UUID casts", async () => {
  reset(null, ["reports.read"]);
  const response = await GET(new Request("http://openbooks.test/api/reports/entry/bad"), {
    params: Promise.resolve({ id: "bad" }),
  });
  assert.equal(response.status, 404);
  assert.equal(routeState.queries.length, 0);
});
