import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Unsaved-create contract for POST /api/projects: opening the drawer writes
// nothing, Cancel writes nothing, and the drawer's explicit Save lands here
// exactly once — one idempotent, audited insert under the projects
// feature-gate fence. A replay of the same request is a success, while
// reusing the key for a changed project (or a key minted in another org) is
// a conflict and must never return the older project as though it matched.
const stateKey = Symbol.for("openbooks.projects-route-test");
const ORG_ID = "00000000-0000-4000-8000-00000000c001";
const USER_ID = "00000000-0000-4000-8000-00000000c002";

interface RouteState {
  requestKey: string | null;
  requestBody: Record<string, unknown> | null;
  inserted: boolean;
  orgMatch: boolean;
  projectGate: boolean;
  auditAfter: unknown;
  transactionQueries: string[];
  queries: string[];
}

const state: RouteState = {
  requestKey: null,
  requestBody: null,
  inserted: false,
  orgMatch: true,
  projectGate: true,
  auditAfter: null,
  transactionQueries: [],
  queries: [],
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
      return (chunk as { queryChunks?: unknown[] })?.queryChunks
        ? sqlText(chunk)
        : "";
    })
    .join("");
}

(
  globalThis as typeof globalThis & Record<string, unknown>
).openbooksProjectsSqlText = sqlText;

const mockSources = new Map<string, string>([
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.projects-route-test')]
      const sqlText = globalThis.openbooksProjectsSqlText
      function respond(query) {
        const text = sqlText(query)
        if (text.includes('insert into projects')) {
          if (state.inserted) return { rows: [] }
          state.inserted = true
          return { rows: [{ id: state.requestKey }] }
        }
        if (text.includes('select id from projects')) {
          return { rows: state.inserted && state.orgMatch ? [{ id: state.requestKey }] : [] }
        }
        if (text.includes('from audit_log')) return { rows: state.auditAfter ? [{ after: state.auditAfter }] : [] }
        if (text.includes('from parties')) return { rows: [] }
        if (text.includes('from subsidiaries')) return { rows: [] }
        if (text.includes('from project_types')) return { rows: [] }
        return { rows: [] }
      }
      const txClient = {
        execute: async (query) => {
          state.transactionQueries.push(sqlText(query))
          return respond(query)
        },
      }
      export const db = {
        execute: async (query) => {
          state.queries.push(sqlText(query))
          return respond(query)
        },
        transaction: async (work) => work(txClient),
      }
      export async function withOrgTransaction(_orgId, work) { return work() }
    `,
  ],
  [
    "mock:authz",
    `export async function guardPermission() {
       return { user: { orgId: '${ORG_ID}', id: '${USER_ID}' }, allowedSubsidiaryIds: null }
     }
     export function guardSubsidiaryScope() { return undefined }
     export function subsidiariesInScope() { return true }`,
  ],
  [
    "mock:gate",
    `const state = globalThis[Symbol.for('openbooks.projects-route-test')]
     export async function guardProjectsFeature() {
       if (state.projectGate) return null
       return new Response(JSON.stringify({ error: 'projects feature is disabled' }), {
         status: 404,
         headers: { 'content-type': 'application/json' },
       })
     }`,
  ],
  [
    "mock:features",
    `export async function isFeatureEnabled() { return true }
     export async function acquireFeatureGateLock() {}`,
  ],
  [
    // Empty defs: validation passes anything through cleaned, so the double
    // is exact for the exercised inputs; the integration suite covers the
    // real defs path against a live catalog.
    "mock:custom-fields",
    `export async function loadFieldDefs() { return [] }
     export function validateCustomValues(_defs, values) { return { ok: true, cleaned: values ?? {} } }
     export async function findUnownedCustomReferences() { return [] }`,
  ],
  [
    "mock:projects-lib",
    `export async function loadProject(id, orgId) {
       const state = globalThis[Symbol.for('openbooks.projects-route-test')]
       if (!state.inserted || id !== state.requestKey) return null
       return { project: { id, org_id: orgId, name: state.requestBody?.name ?? '', subsidiary_id: null } }
     }`,
  ],
]);

// '@/lib/api/json' is not mocked: never double the validation boundary.
const mockUrls = new Map<string, string>([
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
  ["../../../lib/authz", "mock:authz"],
  ["../../../lib/projects-gate", "mock:gate"],
  ["../../../lib/features", "mock:features"],
  ["../../../lib/custom-fields", "mock:custom-fields"],
  ["./_lib", "mock:projects-lib"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // The real '@/lib/api/json' imports 'server-only', which is inert here.
    if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
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

const routeUrl = "./route.ts?projects-create-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

function reset(): void {
  state.requestKey = null;
  state.requestBody = null;
  state.inserted = false;
  state.orgMatch = true;
  state.projectGate = true;
  state.auditAfter = null;
  state.transactionQueries.length = 0;
  state.queries.length = 0;
}

function post(key: string, body: Record<string, unknown>): Promise<Response> {
  state.requestKey = key;
  state.requestBody = body;
  return POST(
    new Request("http://openbooks.test/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body),
    }),
  );
}

function allQueries(): string[] {
  // The route writes through db.execute inside the feature-gate fence (the
  // real withOrgTransaction binds the transaction ambiently, as the PATCH
  // route does), so writes land in both buckets depending on the seam.
  return [...state.queries, ...state.transactionQueries];
}

function noInsertRecorded(): boolean {
  return !allQueries().some((q) => q.includes("insert into projects"));
}

/** The audit INSERT carries the immutable create snapshot; capture it so a
 *  replay can be compared against exactly what the route wrote. */
function captureAuditAfter(): void {
  const insert = allQueries().find((q) => q.includes("insert into audit_log"));
  assert.ok(insert, "the create must write one audit row");
  const start = insert.indexOf('{"before":null,"after":');
  assert.ok(start >= 0, "the audit row must carry the before/after image");
  const raw = insert.slice(start);
  let depth = 0;
  let end = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > 0, "the audit image must be balanced JSON");
  state.auditAfter = JSON.parse(raw.slice(0, end)).after;
}

test("project creation replays only the exact request for an idempotency key", async () => {
  reset();
  const key = "00000000-0000-4000-8000-00000000c004";
  const original = { name: "Harbourview Tower" };

  const created = await post(key, original);
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), {
    project: { id: key, org_id: ORG_ID, name: "Harbourview Tower", subsidiary_id: null },
  });
  captureAuditAfter();

  const replay = await post(key, original);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), {
    project: { id: key, org_id: ORG_ID, name: "Harbourview Tower", subsidiary_id: null },
  });

  const changed = await post(key, { name: "Harbourview Renamed" });
  assert.equal(changed.status, 409);
  assert.deepEqual(await changed.json(), { error: "invalid_idempotency_key" });
});

test("a key minted in another org cannot claim the row", async () => {
  reset();
  const key = "00000000-0000-4000-8000-00000000c005";
  state.inserted = true;
  state.orgMatch = false;
  state.auditAfter = null;
  const claimed = await post(key, { name: "Harbourview Tower" });
  // No same-org row behind the key: the route treats the key as foreign.
  assert.ok([404, 409].includes(claimed.status), `expected 404 or 409, got ${claimed.status}`);
});

test("creation without an idempotency key is refused before any write", async () => {
  reset();
  const response = await POST(
    new Request("http://openbooks.test/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Harbourview Tower" }),
    }),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_idempotency_key" });
  assert.ok(
    noInsertRecorded(),
    "no project row may be written without a key",
  );
});

test("a nameless project and the draft sentinel are refused before any write", async () => {
  for (const name of ["", "   ", "New project"]) {
    reset();
    const response = await post("00000000-0000-4000-8000-00000000c006", { name });
    assert.equal(response.status, 422, JSON.stringify(name));
    assert.deepEqual(await response.json(), { error: "name_required", field: "name" });
    assert.ok(
      noInsertRecorded(),
      `no project row may be written for ${JSON.stringify(name)}`,
    );
  }
});

test("task payloads are refused: WBS tasks keep their own endpoint", async () => {
  reset();
  const response = await post("00000000-0000-4000-8000-00000000c007", {
    name: "Harbourview Tower",
    tasks: [{ name: "Excavation" }],
  });
  assert.equal(response.status, 422);
  assert.ok(
    noInsertRecorded(),
    "no project row may be written with an embedded task payload",
  );
});

test("a disabled projects feature refuses the create", async () => {
  reset();
  state.projectGate = false;
  const response = await post("00000000-0000-4000-8000-00000000c008", { name: "Harbourview Tower" });
  assert.equal(response.status, 404);
  assert.ok(
    noInsertRecorded(),
    "no project row may be written while the feature is off",
  );
});

test("the create writes one audited insert carrying actor and request", async () => {
  reset();
  const key = "00000000-0000-4000-8000-00000000c009";
  const created = await post(key, { name: "Harbourview Tower" });
  assert.equal(created.status, 201);
  const audits = allQueries().filter((q) => q.includes("insert into audit_log"));
  assert.equal(audits.length, 1, "exactly one audit row per create");
  assert.ok(audits[0]!.includes("'projects'"), "the audit row names the projects table");
  assert.ok(audits[0]!.includes(key), "the audit row carries the idempotency key as request_id");
  assert.ok(audits[0]!.includes(USER_ID), "the audit row carries the actor");
});
