import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

interface BenfordRouteState {
  allowedSubsidiaryIds: Set<string> | null;
  calls: string[];
  filters: Array<{ column: string; allowed: string[] | null }>;
  detailRows: Record<string, unknown>[];
  aggregateRow: Record<string, unknown>;
}

const stateKey = Symbol.for("openbooks.benford-route-test");
const routeState: BenfordRouteState = {
  allowedSubsidiaryIds: null,
  calls: [],
  filters: [],
  detailRows: [],
  aggregateRow: { n: "0", total: "0" },
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;

/** Flatten a drizzle SQL chunk into text for checking the generated predicates. */
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
).openbooksBenfordSqlText = sqlText;
(
  globalThis as typeof globalThis & Record<string, unknown>
).openbooksBenfordSql = sql;

const mockSources = new Map<string, string>([
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.benford-route-test')]
      const sqlText = globalThis.openbooksBenfordSqlText
      export const db = {
        execute(query) {
          const text = sqlText(query)
          state.calls.push(text)
          return Promise.resolve({
            rows: text.includes('select count(*)') ? [state.aggregateRow] : state.detailRows,
          })
        },
      }
    `,
  ],
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.benford-route-test')]
      export async function guardPermission() {
        return {
          user: { orgId: 'org-1', id: 'user-1' },
          allowedSubsidiaryIds: state.allowedSubsidiaryIds,
        }
      }
    `,
  ],
  [
    "mock:subsidiaries",
    `
      const state = globalThis[Symbol.for('openbooks.benford-route-test')]
      const sqlText = globalThis.openbooksBenfordSqlText
      const sql = globalThis.openbooksBenfordSql
      export function subsidiaryVisibleFilter(column, allowed) {
        state.filters.push({
          column: sqlText(column),
          allowed: allowed === null ? null : [...allowed],
        })
        if (allowed === null) return sql\`\`
        const ids = [...allowed]
        return ids.length
          ? sql\` and \${column} = any(\${\`{\${ids.join(',')}}\`}::uuid[])\`
          : sql\` and false\`
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/src/db.ts", "mock:db"],
  ["../../../../../lib/authz", "mock:authz"],
  ["../../../../../lib/subsidiaries", "mock:subsidiaries"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
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

const routeUrl = "./route.ts?benford-subsidiary-scope-test";
const { GET } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

function reset(): void {
  routeState.calls.length = 0;
  routeState.filters.length = 0;
  routeState.detailRows = [];
  routeState.aggregateRow = { n: "0", total: "0" };
}

function request(): Request {
  return new Request(
    "http://openbooks.test/api/analytics/sentinel/benford?digit=4&from=2026-01-01&to=2026-12-31",
  );
}

test("restricted Benford drill applies the subsidiary predicate to detail and totals", async () => {
  reset();
  routeState.allowedSubsidiaryIds = new Set([
    "00000000-0000-4000-8000-000000000001",
  ]);
  routeState.detailRows = [
    {
      doc_id: "doc-1",
      doc_kind: "vendor_bill",
      document_number: "VB-1",
      date: "2026-02-03",
      amount: "42.50",
      party_name: "Allowed Vendor",
      entry_id: "entry-1",
    },
  ];
  routeState.aggregateRow = { n: "1", total: "42.50" };

  const response = await GET(request());

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    digit: 4,
    dim: "1d",
    count: 1,
    total: 42.5,
    documents: [
      {
        docId: "doc-1",
        docKind: "vendor_bill",
        entryId: "entry-1",
        docNumber: "VB-1",
        date: "2026-02-03",
        amount: 42.5,
        partyName: "Allowed Vendor",
      },
    ],
  });
  assert.deepEqual(routeState.filters, [
    {
      column: "d.subsidiary_id",
      allowed: ["00000000-0000-4000-8000-000000000001"],
    },
  ]);
  assert.equal(routeState.calls.length, 2);
  assert.ok(
    routeState.calls.every(
      (text) => text.includes("d.subsidiary_id") && text.includes("::uuid[]"),
    ),
  );
});

test("unrestricted Benford drill keeps the shared filter empty", async () => {
  reset();
  routeState.allowedSubsidiaryIds = null;

  const response = await GET(request());

  assert.equal(response.status, 200);
  assert.deepEqual(routeState.filters, [
    { column: "d.subsidiary_id", allowed: null },
  ]);
  assert.equal(routeState.calls.length, 2);
  assert.ok(
    routeState.calls.every((text) => !text.includes("d.subsidiary_id")),
  );
});
