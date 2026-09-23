import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Unsaved-create contract for POST /api/parties: opening the drawer writes
// nothing, Cancel writes nothing, and the drawer's explicit Save lands here
// exactly once — one idempotent, audited insert. A replay of the same request
// is a success, while reusing the key for a changed party (or a key minted
// in another org) is a conflict and must never return the older party as
// though it matched.
const stateKey = Symbol.for("openbooks.parties-route-test");
const ORG_ID = "00000000-0000-4000-8000-00000000b001";
const USER_ID = "00000000-0000-4000-8000-00000000b002";

interface RouteState {
  requestKey: string | null;
  requestBody: Record<string, unknown> | null;
  inserted: boolean;
  orgMatch: boolean;
  refExists: boolean;
  features: { payroll: boolean; multiCurrency: boolean };
  auditAfter: unknown;
  transactionQueries: string[];
  queries: string[];
}

const state: RouteState = {
  requestKey: null,
  requestBody: null,
  inserted: false,
  orgMatch: true,
  refExists: true,
  features: { payroll: true, multiCurrency: true },
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
).openbooksPartiesSqlText = sqlText;

const mockSources = new Map<string, string>([
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.parties-route-test')]
      const sqlText = globalThis.openbooksPartiesSqlText
      function respond(query) {
        const text = sqlText(query)
        if (text.includes('insert into parties')) {
          if (state.inserted) return { rows: [] }
          state.inserted = true
          return { rows: [{ id: state.requestKey }] }
        }
        if (text.includes('select id from parties')) {
          return { rows: state.inserted && state.orgMatch ? [{ id: state.requestKey }] : [] }
        }
        if (text.includes('from audit_log')) return { rows: state.auditAfter ? [{ after: state.auditAfter }] : [] }
        if (text.includes('from subsidiaries')) return { rows: [] }
        if (text.includes('payment_terms') || text.includes('from accounts') || text.includes('from tax_codes') ||
            text.includes('worker_comp_groups') || text.includes('from departments') ||
            text.includes('from trades') || text.includes('employee_roles r')) {
          return { rows: state.refExists ? [{ '1': 1 }] : [] }
        }
        return { rows: [] }
      }
      export const db = {
        execute: async (query) => {
          state.queries.push(sqlText(query))
          return respond(query)
        },
        transaction: async (work) => work({
          execute: async (query) => {
            state.transactionQueries.push(sqlText(query))
            return respond(query)
          },
        }),
      }
    `,
  ],
  [
    "mock:authz",
    `const state = globalThis[Symbol.for('openbooks.parties-route-test')]
     export async function guardPermission() {
       return { user: { orgId: '${ORG_ID}', id: '${USER_ID}' }, allowedSubsidiaryIds: null }
     }
     export function subsidiariesInScope() { return true }`,
  ],
  [
    "mock:features",
    `const state = globalThis[Symbol.for('openbooks.parties-route-test')]
     export async function isFeatureEnabled(_orgId, key) {
       if (key === 'payroll') return state.features.payroll
       if (key === 'multiCurrency') return state.features.multiCurrency
       return true
     }`,
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
    "mock:json",
    `export const jsonObject = {}
     export async function parseJsonBody(request) { return { ok: true, data: await request.json() } }`,
  ],
  [
    "mock:parties-lib",
    `export async function loadParty(id, orgId) {
       const state = globalThis[Symbol.for('openbooks.parties-route-test')]
       if (!state.inserted || id !== state.requestKey) return null
       return { party: { id, org_id: orgId, display_name: state.requestBody?.displayName ?? '' } }
     }`,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
  // canonical-json.ts is a pure module with no imports of its own: there is
  // nothing to isolate, and a copy could only drift from the hashing the
  // audit evidence is reproduced with. It loads for real.
  ["@/lib/api/json", "mock:json"],
  ["../../../lib/authz", "mock:authz"],
  ["../../../lib/features", "mock:features"],
  ["../../../lib/custom-fields", "mock:custom-fields"],
  ["./_lib", "mock:parties-lib"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@openbooks/engine/src/platform/canonical-json.ts") {
      return {
        url: new URL(
          "../../../../engine/src/platform/canonical-json.ts",
          import.meta.url,
        ).href,
        shortCircuit: true,
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

const routeUrl = "./route.ts?parties-create-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

function reset(): void {
  state.requestKey = null;
  state.requestBody = null;
  state.inserted = false;
  state.orgMatch = true;
  state.refExists = true;
  state.features = { payroll: true, multiCurrency: true };
  state.auditAfter = null;
  state.transactionQueries.length = 0;
  state.queries.length = 0;
}

function post(key: string, body: Record<string, unknown>): Promise<Response> {
  state.requestKey = key;
  state.requestBody = body;
  return POST(
    new Request("http://openbooks.test/api/parties", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(body),
    }),
  );
}

/** The audit INSERT carries the immutable create snapshot; capture it so a
 *  replay can be compared against exactly what the route wrote. */
function captureAuditAfter(): void {
  const insert = state.transactionQueries.find((q) => q.includes("insert into audit_log"));
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

test("party creation replays only the exact request for an idempotency key", async () => {
  reset();
  const key = "00000000-0000-4000-8000-00000000b004";
  const original = { displayName: "Acme Corp", kind: "company" };

  const created = await post(key, original);
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), {
    party: { id: key, org_id: ORG_ID, display_name: "Acme Corp" },
  });
  captureAuditAfter();

  const replay = await post(key, original);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), {
    party: { id: key, org_id: ORG_ID, display_name: "Acme Corp" },
  });

  const changed = await post(key, { displayName: "Acme Renamed", kind: "company" });
  assert.equal(changed.status, 409);
  assert.deepEqual(await changed.json(), { error: "invalid_idempotency_key" });
});

test("a key minted in another org cannot claim the row", async () => {
  reset();
  const key = "00000000-0000-4000-8000-00000000b005";
  state.inserted = true;
  state.orgMatch = false;
  state.auditAfter = null;
  const claimed = await post(key, { displayName: "Acme Corp" });
  assert.equal(claimed.status, 409);
  assert.deepEqual(await claimed.json(), { error: "invalid_idempotency_key" });
});

test("creation without an idempotency key is refused before any write", async () => {
  reset();
  const response = await POST(
    new Request("http://openbooks.test/api/parties", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Acme Corp" }),
    }),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_idempotency_key" });
  assert.ok(
    !state.transactionQueries.some((q) => q.includes("insert into parties")),
    "no party row may be written without a key",
  );
});

test("a nameless party and the draft sentinels are refused before any write", async () => {
  for (const displayName of ["", "   ", "New party", "New lead"]) {
    reset();
    const response = await post("00000000-0000-4000-8000-00000000b006", { displayName });
    assert.equal(response.status, 422, JSON.stringify(displayName));
    assert.deepEqual(await response.json(), { error: "name_required", field: "displayName" });
    assert.ok(
      !state.transactionQueries.some((q) => q.includes("insert into parties")),
      `no party row may be written for ${JSON.stringify(displayName)}`,
    );
  }
});

test("a foreign role reference is refused as unknown, never persisted", async () => {
  reset();
  state.refExists = false;
  const response = await post("00000000-0000-4000-8000-00000000b007", {
    displayName: "Acme Corp",
    roles: { customer: { enabled: true, paymentTermsId: "00000000-0000-4000-8000-00000000b008" } },
  });
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: "Invalid customer payment terms", field: "roles" });
  assert.ok(
    !state.transactionQueries.some((q) => q.includes("insert into parties")),
    "no party row may be written with a cross-tenant reference",
  );
});

test("payroll-gated and currency-gated writes fail closed when the switch is off", async () => {
  reset();
  state.features = { payroll: false, multiCurrency: true };
  const payrollOff = await post("00000000-0000-4000-8000-00000000b009", {
    displayName: "Acme Corp",
    roles: { employee: { enabled: true, workerCompGroupId: "00000000-0000-4000-8000-00000000b010" } },
  });
  assert.equal(payrollOff.status, 404);

  reset();
  state.features = { payroll: true, multiCurrency: false };
  const currencyOff = await post("00000000-0000-4000-8000-00000000b011", {
    displayName: "Acme Corp",
    roles: { customer: { enabled: true, currency: "EUR" } },
  });
  assert.equal(currencyOff.status, 404);
});

test("a role kind without its role is refused by name before any write (OM-16)", async () => {
  // OM-16: kind "vendor" with no vendor role strands a "Kind: Vendor" no
  // read can back — the Compliance tab vanishes while the drawer still
  // claims Vendor. The create must refuse the unbacked kind, naming the
  // remedy, instead of persisting it.
  for (const kind of ["customer", "vendor", "employee"]) {
    reset();
    const response = await post("00000000-0000-4000-8000-00000000b013", {
      displayName: "Acme Corp",
      kind,
    });
    assert.equal(response.status, 422, `kind ${kind} without its role must be refused`);
    const body = (await response.json()) as { error: string; field?: string };
    assert.ok(
      body.error.includes(`kind "${kind}" needs the ${kind} role`),
      `the refusal must name the missing role, got: ${body.error}`,
    );
    assert.equal(body.field, "kind");
    assert.ok(
      !state.transactionQueries.some((q) => q.includes("insert into parties")),
      `no party row may be written for unbacked kind ${kind}`,
    );
  }
});

test("a role kind with its role enabled creates both rows atomically (OM-16)", async () => {
  reset();
  const response = await post("00000000-0000-4000-8000-00000000b014", {
    displayName: "Acme Industrial Supply",
    kind: "vendor",
    roles: { vendor: { enabled: true } },
  });
  assert.equal(response.status, 201);
  assert.ok(
    state.transactionQueries.some((q) => q.includes("insert into parties")),
    "the party row must be written",
  );
  assert.ok(
    state.transactionQueries.some((q) => q.includes("insert into vendor_roles")),
    "the backing vendor role must be written in the same request",
  );
});

test("the create writes one audited insert carrying actor and request", async () => {
  reset();
  const key = "00000000-0000-4000-8000-00000000b012";
  const created = await post(key, { displayName: "Acme Corp" });
  assert.equal(created.status, 201);
  const audits = state.transactionQueries.filter((q) => q.includes("insert into audit_log"));
  assert.equal(audits.length, 1, "exactly one audit row per create");
  assert.ok(audits[0]!.includes("'parties'"), "the audit row names the parties table");
  assert.ok(audits[0]!.includes(key), "the audit row carries the idempotency key as request_id");
  assert.ok(audits[0]!.includes(USER_ID), "the audit row carries the actor");
});
