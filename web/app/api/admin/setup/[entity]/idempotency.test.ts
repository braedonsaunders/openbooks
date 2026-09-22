import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { registerHooks } from "node:module";
import { NextResponse } from "next/server";

// Idempotent SetupDrawer creates (POST /api/admin/setup/[entity]).
//
// The drawer opens ?row=new with zero writes and POSTs once on Save, but a
// timeout or a double click retries the same payload. Without a key contract
// the retry inserts a second row. These tests pin the contract: one
// crypto.randomUUID key per create session travels as Idempotency-Key, the
// key becomes the row id, an exact retry replays the original 200 with no
// second row/audit/side effect, and a changed payload or a foreign key is
// refused as 409.
//
// Real parse, coercion, and domain validation run unmocked; only auth and the
// database are doubled (a stateful in-memory executor behind the same
// specifier the production modules import, fed by real drizzle SQL objects).
// Nothing here doubles a pure function.

const stateKey = Symbol.for("openbooks.setup-idempotency-test");

interface HarnessState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
  features: Record<string, boolean>;
  tables: Map<string, Map<string, Record<string, unknown>>>;
  audits: Array<{
    org_id: unknown;
    table_name: unknown;
    row_id: unknown;
    action: unknown;
    changes: Record<string, unknown>;
    actor_id: unknown;
    request_id: unknown;
  }>;
  orgSettings: { features: Record<string, boolean>; home: { announcements: Array<Record<string, unknown>> } };
  statements: Array<{ text: string; values: unknown[] }>;
  fakeExecute: (query: unknown) => Promise<{ rows: Array<Record<string, unknown>> }>;
  NextResponse: typeof NextResponse;
}

const harnessState: HarnessState = {
  authz: null,
  features: {},
  tables: new Map(),
  audits: [],
  orgSettings: { features: {}, home: { announcements: [] } },
  statements: [],
  fakeExecute: async () => ({ rows: [] }),
  NextResponse,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = harnessState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.setup-idempotency-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new state.NextResponse(null, { status: 403 })
    return state.authz
  }
`;

const mockDb = `
  const state = globalThis[Symbol.for('openbooks.setup-idempotency-test')]
  async function execute(query) { return state.fakeExecute(query) }
  async function transaction(work) { return work({ execute }) }
  export const db = { execute, transaction }
  // Pass-throughs for engine modules loaded in the graph but never exercised
  // on these paths; anything reaching them throws through the fake instead.
  export async function withBypass(fn) { return fn() }
  export async function withBypassContext(fn) { return fn() }
  export async function withOrg(...args) { const fn = args[args.length - 1]; return fn() }
  export async function withOrgTransaction(...args) { const fn = args[args.length - 1]; return fn({ execute }) }
  export async function withOrgContext(...args) { const fn = args[args.length - 1]; return fn() }
  export async function withMaintenanceTransaction(...args) { const fn = args[args.length - 1]; return fn({ execute }) }
  export async function withTransactionSavepoint(...args) { const fn = args[args.length - 1]; return fn({ execute }) }
  export async function inDbTransaction(fn) { return fn({ execute }) }
  export const env = {}
  export const pool = null
  export const longPool = null
  export const schema = {}
  export const orgContext = { getStore: () => undefined, run: (_store, fn) => fn() }
  export function registerRequestOrgResolver() {}
  export function currentRequestOrgResolver() { return null }
  export function ambientTenantOrgId() { return null }
  export async function assertSafeRuntimeDatabaseRole() {}
  export async function connectGovernedReadClient() { throw new Error('no database in the idempotency test') }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(new URL(`../../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    const parent = context.parentURL ?? "";
    const isEntityRoute = parent.includes("%5Bentity%5D") || parent.includes("[entity]");
    if (specifier === "../../../../../lib/authz" && isEntityRoute) {
      return { url: "mock:authz", shortCircuit: true };
    }
    if (specifier === "@openbooks/engine/src/platform/db.ts" || specifier.endsWith("/platform/db.ts")) {
      return { url: "mock:db", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:authz") return { format: "module", source: mockAuthz, shortCircuit: true };
    if (url === "mock:db") return { format: "module", source: mockDb, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?setup-idempotency-test";
const { PATCH, POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

// ---------------------------------------------------------------------------
// Flatten real drizzle SQL objects into { text, values } for the fake.
// ---------------------------------------------------------------------------

function flattenChunk(chunk: unknown, out: { text: string; values: unknown[] }): void {
  // Bare primitives (including strings) are bound parameter values: static
  // text always arrives inside StringChunk { value: [...] } fragments.
  if (chunk === null || chunk === undefined || typeof chunk !== "object") {
    out.text += "?";
    out.values.push(chunk);
    return;
  }
  const record = chunk as Record<string, unknown>;
  if (Array.isArray(record.queryChunks)) {
    for (const nested of record.queryChunks) flattenChunk(nested, out);
    return;
  }
  if ("value" in record) {
    if (Array.isArray(record.value)) {
      // Param (has an encoder) vs StringChunk fragments (joined text).
      if ("encoder" in record) {
        out.text += "?";
        out.values.push(record.value);
      } else {
        out.text += (record.value as unknown[]).join("");
      }
      return;
    }
    if (typeof record.value === "string") {
      // sql.identifier name: inline, values cannot shape text.
      out.text += record.value;
      return;
    }
    out.text += "?";
    out.values.push(record.value);
    return;
  }
  out.text += "?";
  out.values.push(chunk);
}

function flatten(query: unknown): { text: string; values: unknown[] } {
  const out = { text: "", values: [] as unknown[] };
  flattenChunk(query, out);
  return out;
}

const clone = (value: unknown): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

function minusOneDay(isoDate: string): string {
  const day = new Date(`${isoDate}T00:00:00Z`).getTime() - 86_400_000;
  return new Date(day).toISOString().slice(0, 10);
}

function storeRows(table: string): Array<Record<string, unknown>> {
  return [...(harnessState.tables.get(table)?.values() ?? [])];
}

function putRow(table: string, row: Record<string, unknown>): void {
  let scoped = harnessState.tables.get(table);
  if (!scoped) {
    scoped = new Map();
    harnessState.tables.set(table, scoped);
  }
  scoped.set(String(row.id), row);
}

async function fakeExecute(query: unknown): Promise<{ rows: Array<Record<string, unknown>> }> {
  const { text, values } = flatten(query);
  harnessState.statements.push({ text, values });
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  const str = (value: unknown): string => String(value);

  // Advisory locks (key claim, feature fence, book fence, announcement fence).
  if (t.includes("pg_advisory_xact_lock")) return { rows: [] };

  // Feature state for every gate in the write path.
  if (t.includes("settings->'features'")) return { rows: [{ f: { ...harnessState.features } }] };

  // Home announcements: org settings JSON read and write.
  if (t.includes("select settings from orgs")) {
    return { rows: [{ settings: clone(harnessState.orgSettings) }] };
  }
  if (t.includes("update orgs set settings")) {
    harnessState.orgSettings = {
      features: { ...harnessState.orgSettings.features },
      home: JSON.parse(str(values[0])) as { announcements: Array<Record<string, unknown>> },
    };
    return { rows: [] };
  }

  // Natural-key duplicate preflight: select id ... where <col> = ? ... limit 1.
  if (/^select id from \w+\s+where \w+ = \?/.test(t) && t.includes("limit 1")
    && !t.includes("is_primary") && !t.includes("is_default")) {
    const table = t.match(/^select id from (\w+)/)![1]!;
    const col = t.match(/^select id from \w+\s+where (\w+)/)![1]!;
    const [val, org, extra] = values;
    const rows = storeRows(table).filter((row) =>
      str(row[col]) === str(val)
      && (org === undefined || str(row.org_id) === str(org))
      && (extra === undefined || !t.includes("effective_from") || str(row.effective_from) === str(extra)));
    return { rows: rows.slice(0, 1).map((row) => ({ id: row.id })) };
  }

  // Idempotency claim: which org owns this key, if any.
  const claimMatch = t.match(/^select org_id from (\w+)\s+where id = \?/);
  if (claimMatch) {
    const row = harnessState.tables.get(claimMatch[1]!)?.get(str(values[0]));
    return { rows: row ? [{ org_id: row.org_id }] : [] };
  }

  // Replay resolution: the insert audit's request image.
  if (t.includes("from audit_log") && t.includes("request_id")) {
    const key = t.match(/changes->'(\w+)'/)?.[1] ?? "after";
    const [org, table, rowId, requestId] = values.map(str);
    const found = harnessState.audits.find((audit) =>
      str(audit.org_id) === org && str(audit.table_name) === table
      && str(audit.row_id) === rowId && str(audit.action) === "insert"
      && str(audit.request_id) === requestId);
    return { rows: found ? [{ after: (found.changes as Record<string, unknown>)[key] }] : [] };
  }

  // loadSetupAuditRow: the stored row for the audit snapshot.
  const auditRowMatch = t.match(/^select \* from (\w+)\s+where id = \?/);
  if (auditRowMatch && !t.includes("org_id = ? and is_primary") && !t.includes(" and ")) {
    const row = harnessState.tables.get(auditRowMatch[1]!)?.get(str(values[0]));
    return { rows: row ? [clone(row)] : [] };
  }
  if (auditRowMatch) {
    const row = harnessState.tables.get(auditRowMatch[1]!)?.get(str(values[0]));
    if (!row) return { rows: [] };
    if (values.length > 1 && str(row.org_id) !== str(values[1])) return { rows: [] };
    return { rows: [clone(row)] };
  }

  // Book promotion reads.
  if (t.startsWith("select id from accounting_books") && t.includes("is_primary")) {
    return {
      rows: storeRows("accounting_books")
        .filter((row) => str(row.org_id) === str(values[0]) && row.is_primary)
        .map((row) => ({ id: row.id })),
    };
  }
  if (t.includes(" as selected")) {
    const table = t.match(/from (\w+)/)![1]!;
    const flag = t.includes("is_default") ? "is_default" : "is_primary";
    return {
      rows: [{
        selected: storeRows(table).some((row) =>
          str(row.org_id) === str(values[0]) && Boolean(row[flag])
          && (flag === "is_primary" || row.is_active !== false)),
      }],
    };
  }
  if (t.startsWith("select * from accounting_books")) {
    return {
      rows: storeRows("accounting_books")
        .filter((row) => str(row.org_id) === str(values[0]) && row.is_primary)
        .map(clone),
    };
  }

  // No ledger history in the fake org: promotions always proceed.
  if (t.includes("from journal_entries") && t.includes("from reconciliations")) return { rows: [] };

  // Book demotion on a fresh promotion.
  if (t.startsWith("update accounting_books set")) {
    const [actorId, org, excluded] = values;
    const demoted = storeRows("accounting_books").filter((row) =>
      str(row.org_id) === str(org) && row.is_primary
      && (excluded === undefined || str(row.id) !== str(excluded)));
    for (const row of demoted) {
      row.is_primary = false;
      row.updated_by = actorId;
    }
    return { rows: demoted.map(clone) };
  }

  // Derived-rule timeline: the currently-effective active row, then its close.
  if (t.includes("from pay_derived_rules") && t.includes("effective_from <")) {
    const [org, code, effectiveFrom] = values.map(str) as [string, string, string];
    return {
      rows: storeRows("pay_derived_rules")
        .filter((row) => str(row.org_id) === org && str(row.code) === code && row.is_active
          && str(row.effective_from) < effectiveFrom
          && (row.effective_to == null || str(row.effective_to) >= effectiveFrom))
        .map(clone),
    };
  }
  if (t.startsWith("update pay_derived_rules set")) {
    const [effectiveFrom, actorId, id] = values;
    const row = harnessState.tables.get("pay_derived_rules")?.get(str(id));
    if (!row) return { rows: [] };
    row.effective_to = minusOneDay(str(effectiveFrom));
    row.updated_by = actorId;
    return { rows: [clone(row)] };
  }

  // Generic PATCH update: apply ?-bound assignments positionally.
  if (t.startsWith("update ") && t.includes(" returning ")) {
    const parsed = t.match(/^update (\w+) set ([\s\S]*?) where ([\s\S]*?) returning/);
    if (!parsed) throw new Error(`unexpected query in idempotency test: ${text}`);
    const [, table, setPart] = parsed as [string, string, string];
    const assigned = setPart
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.includes("?"))
      .map((part) => part.split("=")[0]!.trim());
    const id = str(values[values.length - 2]);
    const org = str(values[values.length - 1]);
    const row = harnessState.tables.get(table!)?.get(id);
    if (!row || str(row.org_id) !== org) return { rows: [] };
    assigned.forEach((column, index) => {
      row[column] = values[index];
    });
    return { rows: [{ id }] };
  }

  // Inserts: tables, then the audit log.
  const insertMatch = t.match(/^insert into (\w+) \(([^)]+)\)/);
  if (insertMatch) {
    const [, table, colsRaw] = insertMatch as [string, string, string];
    const columns = colsRaw.split(",").map((column) => column.trim());
    const row: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      row[column] = values[index];
    });
    if (table === "audit_log") {
      harnessState.audits.push({
        org_id: row.org_id,
        table_name: row.table_name,
        row_id: row.row_id,
        action: row.action,
        changes: typeof row.changes === "string" ? JSON.parse(row.changes) : clone(row.changes),
        actor_id: row.actor_id,
        request_id: row.request_id ?? null,
      });
      return { rows: [] };
    }
    if (t.includes("on conflict (id) do nothing") && harnessState.tables.get(table!)?.has(str(row.id))) {
      return { rows: [] };
    }
    putRow(table!, row);
    if (t.includes("returning *")) return { rows: [clone(row)] };
    if (t.includes("returning")) return { rows: [{ id: row.id }] };
    return { rows: [] };
  }

  throw new Error(`unexpected query in idempotency test: ${text} :: ${JSON.stringify(values)}`);
}

harnessState.fakeExecute = fakeExecute;

// ---------------------------------------------------------------------------
// Test scaffolding.
// ---------------------------------------------------------------------------

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const ACTOR_A = randomUUID();

function reset(): void {
  harnessState.authz = {
    user: { orgId: ORG_A, id: ACTOR_A },
    permissions: new Set(["admin.setup.manage"]),
    allowedSubsidiaryIds: null,
  };
  harnessState.features = {
    payroll: true,
    homeAnnouncements: true,
    multiSubsidiary: false,
    multiCurrency: false,
  };
  harnessState.tables = new Map();
  harnessState.audits = [];
  harnessState.orgSettings = {
    features: {},
    home: { announcements: [] },
  };
  harnessState.statements = [];
}

function postRequest(entity: string, body: unknown, key?: string | null): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key !== undefined && key !== null) headers["Idempotency-Key"] = key;
  return new Request(`http://localhost/api/admin/setup/${entity}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const call = (entity: string) => ({ params: Promise.resolve({ entity }) });

function tableRows(table: string): Array<Record<string, unknown>> {
  return [...(harnessState.tables.get(table)?.values() ?? [])];
}

function tableAudits(table: string): HarnessState["audits"] {
  return harnessState.audits.filter((audit) => audit.table_name === table);
}

/** Index of the key's advisory-lock claim, or -1 when the key never locks. */
function keyLockIndex(key: string): number {
  return harnessState.statements.findIndex((statement) =>
    statement.text.includes("pg_advisory_xact_lock")
    && statement.values.some((value) => String(value).includes(key)));
}

function firstInsertIndex(table: string): number {
  return harnessState.statements.findIndex((statement) =>
    statement.text.trim().toLowerCase().startsWith(`insert into ${table}`));
}

test("missing key is refused before any write", async () => {
  reset();
  const before = harnessState.statements.length;
  const res = await POST(postRequest("payment-terms", { name: "Net 30", netDays: 30 }), call("payment-terms"));
  assert.equal(res.status, 400);
  assert.equal((await res.json() as { code?: string }).code, "invalid");
  assert.equal(harnessState.statements.length, before);
  assert.equal(tableRows("payment_terms").length, 0);
});

test("malformed key is refused before any write", async () => {
  reset();
  const res = await POST(
    postRequest("payment-terms", { name: "Net 30", netDays: 30 }, "not-a-uuid"),
    call("payment-terms"),
  );
  assert.equal(res.status, 400);
  assert.equal(harnessState.statements.length, 0);
  assert.equal(tableRows("payment_terms").length, 0);
});

test("authentication precedes key and body handling", async () => {
  reset();
  harnessState.authz = null;
  const res = await POST(
    new Request("http://localhost/api/admin/setup/payment-terms", {
      method: "POST",
      body: "{not-json",
    }),
    call("payment-terms"),
  );
  assert.equal(res.status, 403);
  assert.equal(harnessState.statements.length, 0);
});

test("first create stores the key as the row id with its audit image", async () => {
  reset();
  const key = randomUUID();
  const res = await POST(
    postRequest("payment-terms", { name: "Net 30", netDays: 30, isActive: true }, key),
    call("payment-terms"),
  );
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.equal((await res.json() as { id: string }).id, key);
  const rows = tableRows("payment_terms");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, key);
  assert.equal(rows[0]!.org_id, ORG_A);
  const audits = tableAudits("payment_terms");
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.action, "insert");
  assert.equal(audits[0]!.request_id, key);
  assert.ok(audits[0]!.changes.after && typeof audits[0]!.changes.after === "object");
  assert.ok(audits[0]!.changes.match && typeof audits[0]!.changes.match === "object");
  // The key's advisory lock precedes every create effect.
  const lock = keyLockIndex(key);
  assert.ok(lock >= 0, "the key must be claimed under pg_advisory_xact_lock");
  assert.ok(lock < firstInsertIndex("payment_terms"), "the lock must precede the insert");
  assert.match(harnessState.statements[firstInsertIndex("payment_terms")]!.text, /on conflict \(id\) do nothing/);
});

test("exact replay returns the original result with no second row or audit", async () => {
  reset();
  const key = randomUUID();
  const body = { name: "Net 30", netDays: 30, isActive: true };
  const first = await POST(postRequest("payment-terms", body, key), call("payment-terms"));
  assert.equal(first.status, 200);
  const replay = await POST(postRequest("payment-terms", body, key), call("payment-terms"));
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { id: key });
  assert.equal(tableRows("payment_terms").length, 1);
  assert.equal(tableAudits("payment_terms").length, 1);
});

test("changed payload under the same key is a 409 with no overwrite", async () => {
  reset();
  const key = randomUUID();
  const first = await POST(
    postRequest("payment-terms", { name: "Net 30", netDays: 30 }, key),
    call("payment-terms"),
  );
  assert.equal(first.status, 200);
  const conflict = await POST(
    postRequest("payment-terms", { name: "Net 60", netDays: 60 }, key),
    call("payment-terms"),
  );
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as { code?: string }).code, "idempotency-conflict");
  assert.equal(tableRows("payment_terms").length, 1);
  assert.equal(tableRows("payment_terms")[0]!.name, "Net 30");
  assert.equal(tableAudits("payment_terms").length, 1);
});

test("a key owned by another org is a 409 that writes nothing there", async () => {
  reset();
  const key = randomUUID();
  putRow("payment_terms", { id: key, org_id: ORG_B, name: "Foreign", net_days: 15 });
  const res = await POST(
    postRequest("payment-terms", { name: "Net 30", netDays: 30 }, key),
    call("payment-terms"),
  );
  assert.equal(res.status, 409);
  assert.equal((await res.json() as { code?: string }).code, "idempotency-conflict");
  assert.equal(tableRows("payment_terms").length, 1);
  assert.equal(tableRows("payment_terms")[0]!.org_id, ORG_B);
  assert.equal(harnessState.audits.length, 0);
});

test("a key colliding with an unclaimed row fails closed", async () => {
  reset();
  const key = randomUUID();
  // A row this endpoint did not create carries no insert audit image.
  putRow("payment_terms", { id: key, org_id: ORG_A, name: "Legacy", net_days: 15 });
  const res = await POST(
    postRequest("payment-terms", { name: "Net 30", netDays: 30 }, key),
    call("payment-terms"),
  );
  assert.equal(res.status, 409);
  assert.equal(tableRows("payment_terms").length, 1);
  assert.equal(tableRows("payment_terms")[0]!.name, "Legacy");
});

test("natural-key entity: duplicate key conflicts, same key replays", async () => {
  reset();
  const code = `IDEMP-${randomUUID().slice(0, 8)}`;
  const first = await POST(
    postRequest("tax-codes", { code, name: "Idempotent tax", isActive: true }, randomUUID()),
    call("tax-codes"),
  );
  assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
  // A different key on the occupied natural key stays a duplicate conflict.
  const duplicate = await POST(
    postRequest("tax-codes", { code, name: "Second tax", isActive: true }, randomUUID()),
    call("tax-codes"),
  );
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json() as { code?: string }).code, "duplicate");
  assert.equal(tableRows("tax_codes").length, 1);
});

test("natural-key entity: exact retry of the same key replays, changed retry conflicts", async () => {
  reset();
  const key = randomUUID();
  const code = `IDEMP-${randomUUID().slice(0, 8)}`;
  const body = { code, name: "Idempotent tax", isActive: true };
  const first = await POST(postRequest("tax-codes", body, key), call("tax-codes"));
  assert.equal(first.status, 200);
  const replay = await POST(postRequest("tax-codes", body, key), call("tax-codes"));
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { id: key });
  assert.equal(tableRows("tax_codes").length, 1);
  assert.equal(tableAudits("tax_codes").length, 1);
  const conflict = await POST(
    postRequest("tax-codes", { ...body, name: "Renamed tax" }, key),
    call("tax-codes"),
  );
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as { code?: string }).code, "idempotency-conflict");
  assert.equal(tableRows("tax_codes")[0]!.name, "Idempotent tax");
});

test("pay-derived rules: versioning stays atomic and replays skip the closure", async () => {
  reset();
  const componentId = randomUUID();
  const code = `RULE-${randomUUID().slice(0, 8)}`;
  const v1Key = randomUUID();
  const v1 = await POST(postRequest("pay-derived-rules", {
    code, name: "Derived rule", componentId, trigger: "time_entry",
    effectiveFrom: "2026-01-01", isActive: true,
  }, v1Key), call("pay-derived-rules"));
  assert.equal(v1.status, 200, JSON.stringify(await v1.clone().json()));
  // A later active version closes the prior window in the same transaction.
  const v2Key = randomUUID();
  const v2 = await POST(postRequest("pay-derived-rules", {
    code, name: "Derived rule", componentId, trigger: "time_entry",
    effectiveFrom: "2026-02-01", isActive: true,
  }, v2Key), call("pay-derived-rules"));
  assert.equal(v2.status, 200, JSON.stringify(await v2.clone().json()));
  assert.equal((await v2.json() as { id: string }).id, v2Key);
  const v1Row = tableRows("pay_derived_rules").find((row) => row.id === v1Key);
  assert.equal(v1Row?.effective_to, "2026-01-31");
  const auditsBefore = harnessState.audits.length;
  // Replaying the successor writes nothing and leaves the closure alone.
  const replay = await POST(postRequest("pay-derived-rules", {
    code, name: "Derived rule", componentId, trigger: "time_entry",
    effectiveFrom: "2026-02-01", isActive: true,
  }, v2Key), call("pay-derived-rules"));
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { id: v2Key });
  assert.equal(tableRows("pay_derived_rules").length, 2);
  assert.equal(harnessState.audits.length, auditsBefore);
  assert.equal(
    tableRows("pay_derived_rules").find((row) => row.id === v1Key)?.effective_to,
    "2026-01-31",
  );
});

test("accounting books: first-book promotion replays without re-demoting", async () => {
  reset();
  const firstKey = randomUUID();
  const first = await POST(
    postRequest("accounting-books", { code: "BK1", name: "First book" }, firstKey),
    call("accounting-books"),
  );
  assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
  assert.equal(tableRows("accounting_books")[0]!.is_primary, true);
  // An exact retry of the auto-promoted first book replays: the derived
  // promotion flag is request-controlled-absent on both sides, so the stored
  // derivation never turns the retry into a conflict, and no demotion audit
  // is written.
  const replay = await POST(
    postRequest("accounting-books", { code: "BK1", name: "First book" }, firstKey),
    call("accounting-books"),
  );
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { id: firstKey });
  assert.equal(tableRows("accounting_books").length, 1);
  assert.equal(tableAudits("accounting_books").length, 1);
  // A fresh key promoting a second book still demotes the first, atomically.
  const secondKey = randomUUID();
  const second = await POST(
    postRequest("accounting-books", { code: "BK2", name: "Second book", isPrimary: true }, secondKey),
    call("accounting-books"),
  );
  assert.equal(second.status, 200, JSON.stringify(await second.clone().json()));
  assert.equal(tableRows("accounting_books").find((row) => row.id === firstKey)?.is_primary, false);
  assert.equal(tableRows("accounting_books").find((row) => row.id === secondKey)?.is_primary, true);
  const demotions = harnessState.audits.filter((audit) =>
    audit.table_name === "accounting_books" && audit.action === "update");
  assert.equal(demotions.length, 1);
});

test("home announcements: key becomes the announcement id with replay and refusal", async () => {
  reset();
  const key = randomUUID();
  const body = { title: "Lobby notice", startsOn: "2026-01-01", audience: "all" };
  const first = await POST(postRequest("home-announcements", body, key), call("home-announcements"));
  assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
  assert.equal((await first.json() as { id: string }).id, key);
  assert.equal(harnessState.orgSettings.home.announcements.length, 1);
  const replay = await POST(postRequest("home-announcements", body, key), call("home-announcements"));
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { id: key });
  assert.equal(harnessState.orgSettings.home.announcements.length, 1);
  const conflict = await POST(
    postRequest("home-announcements", { ...body, title: "Edited notice" }, key),
    call("home-announcements"),
  );
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as { code?: string }).code, "idempotency-conflict");
  assert.equal(harnessState.orgSettings.home.announcements.length, 1);
  assert.equal(harnessState.orgSettings.home.announcements[0]!.title, "Lobby notice");
});

test("declared-module and read-only creates stay refused with a valid key", async () => {
  reset();
  const extension = await POST(
    postRequest("extension-settings", { id: "ext:key", value: true }, randomUUID()),
    call("extension-settings"),
  );
  assert.equal(extension.status, 405);
  // Currencies is feature-gated before its read-only refusal: with the gate
  // off it stays 404, with the gate on the create is refused as read-only.
  const gated = await POST(
    postRequest("currencies", { code: "ZZ", name: "Zed", minorUnits: 2 }, randomUUID()),
    call("currencies"),
  );
  assert.equal(gated.status, 404);
  harnessState.features.multiCurrency = true;
  const currencies = await POST(
    postRequest("currencies", { code: "ZZ", name: "Zed", minorUnits: 2 }, randomUUID()),
    call("currencies"),
  );
  assert.equal(currencies.status, 405);
});

test("PATCH never requires the key", async () => {
  reset();
  const key = randomUUID();
  const created = await POST(
    postRequest("payment-terms", { name: "Net 30", netDays: 30 }, key),
    call("payment-terms"),
  );
  assert.equal(created.status, 200);
  const patched = await PATCH(new Request("http://localhost/api/admin/setup/payment-terms", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: key, name: "Net 30 revised", netDays: 30 }),
  }), call("payment-terms"));
  assert.equal(patched.status, 200, JSON.stringify(await patched.clone().json()));
  assert.equal(tableRows("payment_terms")[0]!.name, "Net 30 revised");
  assert.ok(harnessState.audits.some((audit) => audit.action === "update"));
});
