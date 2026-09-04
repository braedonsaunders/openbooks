import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.report-definition-route-test");
interface RouteState {
  calls: string[];
  updateResults: { rows: unknown[] }[];
  revision: string;
  definition: Record<string, unknown>;
}
const state: RouteState = {
  calls: [],
  updateResults: [],
  revision: "2026-08-24T12:00:00.300001Z",
  definition: {
    id: "definition-1",
    org_id: "org-1",
    kind: "custom",
    report_type: "query",
    slug: "cash-flow",
    name: "Cash flow",
    description: null,
    query: { entity: "ledger_lines", mode: "rows", columns: ["account"] },
    statement: null,
    system: false,
    layout: null,
    created_at: "2026-08-24T12:00:00.000000Z",
    updated_at: "2026-08-24T12:00:00.300001Z",
  },
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

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
).openbooksReportDefinitionSqlText = sqlText;

const mockSources = new Map<string, string>([
  [
    "mock:json",
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        return { ok: true, data: await request.json() }
      }
    `,
  ],
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.report-definition-route-test')]
      const sqlText = globalThis.openbooksReportDefinitionSqlText
      export const db = {
        async execute(query) {
          const text = sqlText(query)
          state.calls.push(text)
          if (text.includes('update report_definitions')) {
            return state.updateResults.shift() || { rows: [{ id: state.definition.id }] }
          }
          if (text.includes('select') && text.includes('from report_definitions')) {
            return { rows: [{ updated_at: state.revision }] }
          }
          return { rows: [] }
        },
      }
      export const schema = {}
      export const pool = {}
      export const env = {}
    `,
  ],
  [
    "mock:authz",
    `
      export async function guardPermission() {
        return { user: { orgId: 'org-1', id: 'user-1' } }
      }
    `,
  ],
  [
    "mock:reports-authz",
    `
      export async function canAccessReportDefinition() { return true }
      export async function canRunReportEntity() { return true }
      export async function canRunReportStatement() { return true }
      export async function guardReportEntity() { return null }
    `,
  ],
  [
    "mock:custom-reports",
    `
      const state = globalThis[Symbol.for('openbooks.report-definition-route-test')]
      export async function loadReportDefinition() { return state.definition }
      export function slugifyReportName(name) { return name.toLowerCase().replaceAll(' ', '-') }
      export async function uniqueReportSlug(_orgId, slug) { return slug }
    `,
  ],
  ["mock:server-only", ""],
]);

const selfUrl = new URL(import.meta.url).href;
const mockUrl = (name: string) => `${selfUrl}?report-definition-mock=${name}`;
const mockUrls = new Map<string, string>([
  ["@/lib/api/json", mockUrl("json")],
  ["@openbooks/engine/src/db.ts", mockUrl("db")],
  ["../../../../../lib/authz", mockUrl("authz")],
  ["../../../../../lib/report-authz", mockUrl("reports-authz")],
  ["../../../../../lib/report-execution-context", mockUrl("reports-authz")],
  ["../../../../../lib/custom-reports", mockUrl("custom-reports")],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only")
      return { format: "module", shortCircuit: true, url: "mock:server-only" };
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source =
      url === "mock:server-only"
        ? ""
        : mockSources.get(
            `mock:${new URL(url).searchParams.get("report-definition-mock")}`,
          );
    if (source !== undefined)
      return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const routeUrl = new URL("./route.ts?report-definition-occ-test", import.meta.url).href;
const { GET, PATCH } =
  (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const DEFINITION_ID = "definition-1";
const REVISION = "2026-08-24T12:00:00.300001Z";

function reset(): void {
  state.calls.length = 0;
  state.updateResults = [];
  state.revision = REVISION;
  state.definition.updated_at = REVISION;
}

function patch(body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new Request(
      `http://openbooks.test/api/reports/definitions/${DEFINITION_ID}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ id: DEFINITION_ID }) },
  );
}

function get(): Promise<Response> {
  return GET(
    new Request(
      `http://openbooks.test/api/reports/definitions/${DEFINITION_ID}`,
    ),
    { params: Promise.resolve({ id: DEFINITION_ID }) },
  );
}

test("GET exposes the lossless revision token consumed by autosave", async () => {
  reset();

  const response = await get();

  assert.equal(response.status, 200);
  assert.equal((await response.json()).definition.updated_at, REVISION);
});

test("PATCH refuses an autosave without an exact revision token", async () => {
  reset();

  const response = await patch({ name: "No token" });

  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /revision is required/);
  assert.equal(
    state.calls.filter((text) => text.includes("update report_definitions"))
      .length,
    0,
  );
});

test("concurrent autosaves with one opened revision commit at most one definition", async () => {
  reset();
  state.updateResults = [{ rows: [{ id: DEFINITION_ID }] }, { rows: [] }];

  const [first, second] = await Promise.all([
    patch({ name: "First writer", expectedUpdatedAt: REVISION }),
    patch({ name: "Second writer", expectedUpdatedAt: REVISION }),
  ]);
  const statuses = [first.status, second.status].sort();

  assert.deepEqual(statuses, [200, 409]);
  assert.equal(
    state.calls.filter(
      (text) => text.includes("and to_char(") && text.includes("updated_at"),
    ).length,
    2,
    "both writes carry the atomic revision predicate",
  );
  const conflict = first.status === 409 ? first : second;
  assert.match((await conflict.json()).error, /changed after you opened it/);
});

test("PATCH returns the fresh exact revision for the next queued autosave", async () => {
  reset();
  state.updateResults = [{ rows: [{ id: DEFINITION_ID }] }];
  state.revision = "2026-08-24T12:00:00.300002Z";

  const response = await patch({ name: "Saved", expectedUpdatedAt: REVISION });

  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).definition.updated_at,
    "2026-08-24T12:00:00.300002Z",
  );
});
