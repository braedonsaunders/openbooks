import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

/**
 * View routes: a malformed view id must be a clean 404 (never a Postgres uuid
 * cast error surfacing as a 500) on every verb — the same boundary the
 * dunning, journal, project, and record-type routes keep.
 *
 * Saved views store the same ReportCustomQuery shape as report definitions.
 * Listing or reading a payroll plan, or persisting one, must consult the
 * same entity gate those definition routes already apply.
 */
import { pathToFileURL } from "node:url";

const stateKey = Symbol.for("openbooks.view-route-entity-gate-test");
type ViewRow = {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  description: string | null;
  query: { entity: string; mode: string; columns: string[] };
  layout: Record<string, unknown> | null;
  scope: "private" | "shared";
  owner_id: string;
  allowed_roles: string[] | null;
  created_at: string;
  updated_at: string;
};
interface ViewRouteState {
  permissions: string[];
  views: ViewRow[];
  updates: Array<{ id: string; patch: { query?: unknown; name?: string } }>;
}

const PAY_STUBS_ID = "00000000-0000-4000-8000-0000000000aa";
const LEDGER_ID = "00000000-0000-4000-8000-0000000000bb";

function viewRow(
  id: string,
  entity: string,
  columns: string[],
  name: string,
): ViewRow {
  return {
    id,
    org_id: "org-1",
    slug: name.toLowerCase().replace(/\s+/g, "-"),
    name,
    description: null,
    query: { entity, mode: "rows", columns },
    layout: null,
    scope: "shared",
    owner_id: "owner-1",
    allowed_roles: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function payStubsView(): ViewRow {
  return viewRow(PAY_STUBS_ID, "pay_stubs", ["employee"], "Pay stubs");
}

function ledgerView(): ViewRow {
  return viewRow(LEDGER_ID, "ledger_lines", ["account_name"], "Ledger lines");
}

const state: ViewRouteState = {
  permissions: ["reports.read", "reports.create"],
  views: [payStubsView(), ledgerView()],
  updates: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

function reset(permissions: string[] = ["reports.read", "reports.create"]): void {
  state.permissions = permissions;
  state.views = [payStubsView(), ledgerView()];
  state.updates = [];
}

const root = pathToFileURL(process.cwd() + "/").href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "@/lib/api/json") {
      return next(root + "web/lib/api/json.ts", context);
    }
    if (specifier === "./features" && context.parentURL?.includes("report-authz")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`
            export async function isFeatureEnabled() { return true }
          `),
      };
    }
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/views/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`
            const state = globalThis[Symbol.for('openbooks.view-route-entity-gate-test')]
            export async function guardPermission(){
              return {
                user: { orgId: 'org-1', id: 'user-1' },
                permissions: new Set(state.permissions),
              };
            }
          `),
      };
    }
    if (specifier.endsWith("/lib/views") && context.parentURL?.includes("/api/views/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`
            const state = globalThis[Symbol.for('openbooks.view-route-entity-gate-test')]
            export async function loadViews() { return state.views }
            export async function loadView(_org, id) {
              return state.views.find((row) => row.id === id) ?? null
            }
            export async function updateView(_org, id, _user, _admin, patch) {
              state.updates.push({ id, patch })
              const row = state.views.find((view) => view.id === id)
              if (!row) return { ok: false, error: 'not found' }
              if (patch.query !== undefined) row.query = patch.query
              if (patch.name !== undefined) row.name = patch.name
              return { ok: true }
            }
            export async function deleteView() { return true }
            export async function runView() { throw new Error('runView is not used by these tests') }
            export async function createView() {
              return { id: '00000000-0000-4000-8000-0000000000cc', slug: 'untitled' }
            }
            export function slugifyViewName(name) {
              return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-')
            }
            export async function uniqueViewSlug(_org, slug) { return slug }
          `),
      };
    }
    return next(specifier, context);
  },
});
const { GET, PATCH, DELETE } = await import("./[id]/route.ts");
const { POST: run } = await import("./[id]/run/route.ts");
const { GET: exportView } = await import("./[id]/export/route.ts");
const { GET: listViews } = await import("./route.ts");

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (method: string, body?: unknown) =>
  new Request("http://audit.local/api/views", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("every view verb answers a malformed id with 404", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  reset();
  for (const id of ["not-a-uuid", "new"]) {
    const got = await GET(json("GET"), params(id));
    assert.equal(got.status, 404, `GET ${id}`);
    assert.deepEqual(await got.json(), { error: "not found" });

    const patched = await PATCH(json("PATCH", { name: "Renamed" }), params(id));
    assert.equal(patched.status, 404, `PATCH ${id}`);
    assert.deepEqual(await patched.json(), { error: "not found" });

    const deleted = await DELETE(json("DELETE"), params(id));
    assert.equal(deleted.status, 404, `DELETE ${id}`);
    assert.deepEqual(await deleted.json(), { error: "not found" });

    const ran = await run(json("POST"), params(id));
    assert.equal(ran.status, 404, `run ${id}`);
    assert.deepEqual(await ran.json(), { error: "not found" });

    const exported = await exportView(
      new Request(`http://audit.local/api/views/${id}/export?format=csv`),
      params(id),
    );
    assert.equal(exported.status, 404, `export ${id}`);
    assert.deepEqual(await exported.json(), { error: "not found" });
  }
});

test("view list and detail reuse the report-definition entity gate", () => {
  const list = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  const detail = readFileSync(new URL("./[id]/route.ts", import.meta.url), "utf8");
  assert.match(
    list,
    /\bcanRunReportEntity\b/,
    "GET /api/views must filter through canRunReportEntity",
  );
  assert.match(
    list,
    /from ['"].*report-authz['"]/,
    "GET /api/views must import the shared gate rather than re-implement it",
  );
  assert.match(
    detail,
    /\bcanRunReportEntity\b/,
    "GET /api/views/[id] must consult canRunReportEntity",
  );
  assert.match(
    detail,
    /\bguardReportEntity\b/,
    "PATCH /api/views/[id] must refuse writes through guardReportEntity",
  );
  assert.match(
    detail,
    /\bvalidateOrgReportQuery\b/,
    "PATCH /api/views/[id] must validate the plan through validateOrgReportQuery",
  );
  assert.match(
    detail,
    /from ['"].*report-authz['"]/,
    "view detail must import the shared gate rather than re-implement it",
  );
});

test("GET /api/views omits a pay_stubs plan when the caller lacks payroll.read", async () => {
  reset(["reports.read"]);
  const res = await listViews();
  assert.equal(res.status, 200);
  const body = (await res.json()) as { views: Array<{ id: string; query: { entity: string } }> };
  assert.equal(
    body.views.some((row) => row.query.entity === "pay_stubs"),
    false,
    "a reports.read reader must not receive the pay_stubs plan",
  );
  assert.equal(
    body.views.some((row) => row.id === PAY_STUBS_ID),
    false,
    "a reports.read reader must not receive the pay_stubs view id",
  );
  assert.equal(
    body.views.some((row) => row.id === LEDGER_ID && row.query.entity === "ledger_lines"),
    true,
    "an ungated ledger view must remain listed",
  );
});

test("GET /api/views/[id] 404s a pay_stubs plan when the caller lacks payroll.read", async () => {
  reset(["reports.read"]);
  const denied = await GET(json("GET"), params(PAY_STUBS_ID));
  assert.equal(denied.status, 404);
  const body = (await denied.json()) as { error?: string; view?: { query?: unknown } };
  assert.equal(body.view, undefined);
  assert.deepEqual(body, { error: "not found" });

  const allowed = await GET(json("GET"), params(LEDGER_ID));
  assert.equal(allowed.status, 200);
  const listed = (await allowed.json()) as { view: { query: { entity: string } } };
  assert.equal(listed.view.query.entity, "ledger_lines");
});

test("GET /api/views/[id] returns a pay_stubs plan when the caller holds payroll.read", async () => {
  reset(["reports.read", "payroll.read"]);
  const res = await GET(json("GET"), params(PAY_STUBS_ID));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { view: { query: { entity: string } } };
  assert.equal(body.view.query.entity, "pay_stubs");
});

test("PATCH refuses to persist a pay_stubs plan without payroll.read", async () => {
  reset(["reports.read", "reports.create"]);
  const res = await PATCH(
    json("PATCH", {
      query: { entity: "pay_stubs", mode: "rows", columns: ["employee"] },
    }),
    params(LEDGER_ID),
  );
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: string; view?: unknown };
  assert.match(body.error, /do not have access to this data/i);
  assert.equal(state.updates.length, 0, "the gated plan must not reach updateView");
  assert.equal(state.views.find((row) => row.id === LEDGER_ID)?.query.entity, "ledger_lines");
});

test("PATCH persists a pay_stubs plan when the caller holds payroll.read", async () => {
  reset(["reports.read", "reports.create", "payroll.read"]);
  const res = await PATCH(
    json("PATCH", {
      query: { entity: "pay_stubs", mode: "rows", columns: ["employee"] },
    }),
    params(LEDGER_ID),
  );
  assert.equal(res.status, 200);
  assert.equal(state.updates.length, 1);
  assert.equal((state.updates[0]?.patch.query as { entity?: string } | undefined)?.entity, "pay_stubs");
});
