import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { NextResponse } from "next/server";

// Route boundary regression for fnd_mtcb4ic6_5yh8jo: an intercompany journal
// entry whose header is visible may still carry lines for subsidiaries outside
// the caller's scope. The line query must enforce the same scope as the header.

interface RouteState {
  allowedSubsidiaryIds: Set<string> | null;
  /** Null = legacy unrestricted caller (the pre-existing tests). */
  permissions: string[] | null;
  queries: string[];
  /** When true the lines query returns payroll-origin party-tagged lines. */
  payrollLines: boolean;
}

const stateKey = Symbol.for("openbooks.reports-entry-route-test");
const routeState: RouteState = {
  allowedSubsidiaryIds: null,
  permissions: null,
  queries: [],
  payrollLines: false,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;
(
  globalThis as typeof globalThis & Record<string, unknown>
).openbooksReportsEntryNextResponse = NextResponse;

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

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.reports-entry-route-test')]
      const NextResponse = globalThis.openbooksReportsEntryNextResponse
      function grants(permission) {
        // Null permissions = legacy unrestricted caller. Otherwise the role
        // holds exactly the listed grants (plus '*' wildcard holders).
        if (state.permissions === null) return true
        const held = new Set(state.permissions)
        if (held.has('*')) return true
        if (held.has(permission)) return true
        const [scope] = permission.split('.')
        return held.has(scope + '.*')
      }
      function authz() {
        return {
          user: { orgId: 'org-1', id: 'user-1' },
          permissions: new Set(state.permissions ?? ['*']),
          allowedSubsidiaryIds: state.allowedSubsidiaryIds,
        }
      }
      export async function guardPermission(permission) {
        if (!grants(permission)) {
          return NextResponse.json({ error: 'missing permission: ' + permission }, { status: 403 })
        }
        return authz()
      }
      export async function getAuthz() {
        return authz()
      }
      export function can(gate, permission) {
        const held = gate.permissions
        if (held.has('*')) return true
        if (held.has(permission)) return true
        const [scope] = permission.split('.')
        return held.has(scope + '.*')
      }
      export function unauthorized() {
        return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
      }
    `,
  ],
  [
    "mock:db",
    `
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
            return { rows: [{ id: 'entry-1', subsidiary_id: 'sub-visible' }] }
          }
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
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../../lib/authz", "mock:authz"],
  // lib/payroll-confidentiality.ts reaches the same gate through a
  // lib-relative specifier; it must resolve to the same mock.
  ["./authz", "mock:authz"],
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        format: "module",
        shortCircuit: true,
        url: "data:text/javascript,export {}",
      };
    }
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined)
      return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?reports-entry-subsidiary-scope-test";
const { GET } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

function reset(allowedSubsidiaryIds: Set<string> | null, permissions: string[] | null = null, payrollLines = false): void {
  routeState.allowedSubsidiaryIds = allowedSubsidiaryIds;
  routeState.permissions = permissions;
  routeState.queries.length = 0;
  routeState.payrollLines = payrollLines;
}

function get(): Promise<Response> {
  return GET(new Request("http://openbooks.test/api/reports/entry/entry-1"), {
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
  const text = JSON.stringify(body.lines);
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
