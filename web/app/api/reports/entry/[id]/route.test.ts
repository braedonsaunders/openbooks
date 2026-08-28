import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { NextResponse } from "next/server";

// Route boundary regression for fnd_mtcb4ic6_5yh8jo: an intercompany journal
// entry whose header is visible may still carry lines for subsidiaries outside
// the caller's scope. The line query must enforce the same scope as the header.

interface RouteState {
  allowedSubsidiaryIds: Set<string> | null;
  queries: string[];
}

const stateKey = Symbol.for("openbooks.reports-entry-route-test");
const routeState: RouteState = {
  allowedSubsidiaryIds: null,
  queries: [],
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
      export async function guardPermission() {
        return {
          user: { orgId: 'org-1', id: 'user-1' },
          allowedSubsidiaryIds: state.allowedSubsidiaryIds,
        }
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
      export const db = {
        async execute(query) {
          const text = sqlText(query)
          state.queries.push(text)
          if (text.includes('from journal_entries e')) {
            return { rows: [{ id: 'entry-1', subsidiary_id: 'sub-visible' }] }
          }
          if (text.includes('from journal_lines l')) {
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
  ["@openbooks/engine/src/db.ts", "mock:db"],
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

function reset(allowedSubsidiaryIds: Set<string> | null): void {
  routeState.allowedSubsidiaryIds = allowedSubsidiaryIds;
  routeState.queries.length = 0;
}

function get(): Promise<Response> {
  return GET(new Request("http://openbooks.test/api/reports/entry/entry-1"), {
    params: Promise.resolve({ id: "entry-1" }),
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
