import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test, { after } from "node:test";
import { NextResponse } from "next/server";

// Route boundary suite for the tax filing surface (no test file existed for
// this module). The Prepare (POST) and Mark Filed (PATCH) routes require
// the filing permission rather than report-creation permission,
// so any report creator could certify a statutory return as filed. The
// certification authority is compliance.file; these tests pin the exact
// permission string both entry points demand and prove a reports.create
// holder is refused.

interface EngineCall {
  op: "compute" | "prepare" | "markFiled";
  orgId: string;
  userId: string;
}

interface RouteState {
  permissions: Set<string>;
  allowedSubsidiaryIds: Set<string> | null;
  permissionChecks: string[];
  scopeChecks: (string | null)[];
  engineCalls: EngineCall[];
  computeOpts: unknown[];
  computeAdjustments: unknown[];
  markFiledError: unknown;
  /** Arguments of each prepareTaxFiling call: the computed return and its entries. */
  filingInserts: { result: Record<string, unknown>; entries: unknown[] }[];
}

const stateKey = Symbol.for("openbooks.tax-filing-route-test");
const routeState: RouteState = {
  permissions: new Set(),
  allowedSubsidiaryIds: null,
  permissionChecks: [],
  scopeChecks: [],
  engineCalls: [],
  computeOpts: [],
  computeAdjustments: [],
  markFiledError: null,
  filingInserts: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;
(globalThis as typeof globalThis & Record<string, unknown>).openbooksTaxFilingNextResponse =
  NextResponse;

/** Flatten a drizzle SQL chunk into its raw text for keyword scripting. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((c) => {
      if (typeof c === "string") return c;
      const value = (c as { value?: unknown[] })?.value;
      if (Array.isArray(value)) return value.map(String).join("");
      if ((c as { queryChunks?: unknown[] })?.queryChunks) return sqlText(c);
      return "";
    })
    .join("");
}
(globalThis as typeof globalThis & Record<string, unknown>).openbooksSqlTextTaxFiling = sqlText;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.tax-filing-route-test')]
      const NextResponse = globalThis.openbooksTaxFilingNextResponse
      export function guardSubsidiaryScope(authz, subsidiaryId) {
        state.scopeChecks.push(subsidiaryId ?? null)
        const allowed = authz.allowedSubsidiaryIds
        if (allowed === null) return null
        if (subsidiaryId !== null && subsidiaryId !== undefined && allowed.has(subsidiaryId)) return null
        return NextResponse.json({ error: 'not_found' }, { status: 404 })
      }
      export function guardUnrestrictedScope(authz) {
        if (authz.allowedSubsidiaryIds === null) return null
        return NextResponse.json({ error: 'requires unrestricted subsidiary access' }, { status: 403 })
      }
      export async function guardPermission(permission) {
        state.permissionChecks.push(permission)
        if (!state.permissions.has(permission)) {
          return NextResponse.json({ error: 'missing permission: ' + permission }, { status: 403 })
        }
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: state.allowedSubsidiaryIds }
      }
      export async function getAuthz() { return null }
      export async function guardRootSubsidiaryScope() { return null }
    `,
  ],
  [
    "mock:db",
    `
      export const ambientTenantOrgId = () => null
      export const currentRequestOrgResolver = () => null
      export const registerRequestOrgResolver = () => {}
      export const withBypass = (fn) => fn()
      export const withBypassContext = (fn) => fn()
      const state = globalThis[Symbol.for('openbooks.tax-filing-route-test')]
      const sqlText = globalThis.openbooksSqlTextTaxFiling
      export const db = {
        execute() { throw new Error('unexpected database query') },
        async transaction(work) {
          return work({
            execute(query, mode) {
              const inMode = (result) => (mode === 'objects' ? result.rows : result)
              const text = sqlText(query)
              if (text.includes('insert into tax_filings')) {
                state.filingInserts.push(text)
                return Promise.resolve({ rows: [{ id: 'filing-1', version: 2 }] }).then(inMode)
              }
              if (text.includes('from tax_filings')) return Promise.resolve({ rows: [{ version: 2 }] }).then(inMode)
              if (text.includes('from tax_return_forms')) return Promise.resolve({ rows: [{ country: 'US' }] }).then(inMode)
              return Promise.resolve({ rows: [] }).then(inMode)
            },
          })
        },
      }
    `,
  ],
  [
    "mock:tax-filing",
    `
      const state = globalThis[Symbol.for('openbooks.tax-filing-route-test')]
      export * from ${JSON.stringify(new URL("../../../../../engine/src/tax-returns/adjustments.ts", import.meta.url).href)}
      export const TAX_FILING_SNAPSHOT_VERSION = 3
      export class TaxFilingError extends Error {
        constructor(code, message) { super(message ?? code); this.code = code }
      }
      globalThis.openbooksTaxFilingError = (code, message) => new TaxFilingError(code, message)
      export async function prepareTaxFiling(orgId, userId, result, entries) {
        state.engineCalls.push({ op: 'prepare', orgId, userId })
        state.filingInserts.push({ result, entries })
        return { id: 'filing-1', version: 2 }
      }
      export async function markTaxFilingFiled(orgId, id, userId) {
        state.engineCalls.push({ op: 'markFiled', orgId, userId })
        if (state.markFiledError) throw state.markFiledError
        return { id, filedAt: '2026-08-24T00:00:00.000Z' }
      }
      export function buildTaxFilingSnapshot() {
        return { snapshot: { boxes: [] }, snapshotHash: 'hash-1' }
      }
    `,
  ],
  [
    "mock:tax-return",
    `
      const state = globalThis[Symbol.for('openbooks.tax-filing-route-test')]
      export async function computeTaxReturn(orgId, code, from, to, adjustments, opts) {
        state.engineCalls.push({ op: 'compute', orgId, userId: 'user-1' })
        state.computeOpts.push(opts ?? null)
        state.computeAdjustments.push(adjustments)
        // The double must produce the full return identity the prepare path
        // freezes: a double that cannot produce it would let the insert
        // silently persist NULL posture without any test noticing. It echoes
        // the requested scope so pass-through is observable.
        const filingEntity = opts?.filingEntity
        return {
          formCode: code, formName: 'Form ' + code, from, to, submissionChannel: 'paper', boxes: [],
          registrationNumber: '123456789RT0001',
          registrationId: filingEntity?.registrationId ?? '33333333-3333-4333-8333-333333333333',
          functionalCurrency: opts?.translation?.presentationCurrency ?? 'CAD',
          subsidiaryIds: filingEntity ? [...filingEntity.subsidiaryIds] : [],
          translation: opts?.translation ? {
            presentationCurrency: opts.translation.presentationCurrency,
            rateType: opts.translation.rateType ?? 'spot',
            rateDate: opts.translation.rateDate ?? to,
            entities: [],
          } : null,
        }
      }
    `,
  ],
  [
    "mock:tax-nexus-ledger",
    `
      export async function loadOrgFilingCalendar() { return [] }
    `,
  ],
  [
    "mock:business-date",
    `
      export async function businessToday() { return '2026-08-24' }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@/lib/authz", "mock:authz"],
  ["../../../../lib/authz", "mock:authz"],
  ["../../../../../lib/authz", "mock:authz"],
  ["@openbooks/engine/platform/db", "mock:db"],
  ["@openbooks/engine/tax-returns/filing", "mock:tax-filing"],
  ["@openbooks/engine/tax-returns/return", "mock:tax-return"],
  ["@openbooks/engine/tax/nexus-ledger", "mock:tax-nexus-ledger"],
  ["@openbooks/engine/platform/business-date/module", "mock:business-date"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const postRouteUrl = "./route.ts?tax-filing-permission-test";
const { POST, GET } = (await import(postRouteUrl)) as typeof import("./route.ts");
const patchRouteUrl = "./[id]/route.ts?tax-filing-permission-test";
const { PATCH } = (await import(patchRouteUrl)) as typeof import("./[id]/route.ts");
after(() => hooks.deregister());

function taxFilingError(code: string, message: string): unknown {
  const factory = (
    globalThis as { openbooksTaxFilingError?: (code: string, message: string) => unknown }
  ).openbooksTaxFilingError;
  return factory ? factory(code, message) : Object.assign(new Error(message), { code });
}

function reset(permissions: string[], allowedSubsidiaryIds: string[] | null = null): void {
  routeState.permissions = new Set(permissions);
  routeState.allowedSubsidiaryIds =
    allowedSubsidiaryIds === null ? null : new Set(allowedSubsidiaryIds);
  routeState.permissionChecks.length = 0;
  routeState.scopeChecks.length = 0;
  routeState.engineCalls.length = 0;
  routeState.computeOpts.length = 0;
  routeState.computeAdjustments.length = 0;
  routeState.markFiledError = null;
  routeState.filingInserts.length = 0;
}

function post(
  body: unknown = { code: "GST-Q", from: "2026-01-01", to: "2026-03-31" },
): Promise<Response> {
  return POST(
    new Request("http://openbooks.test/api/tax/filings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function patch(filingId: string): Promise<Response> {
  return PATCH(
    new Request(`http://openbooks.test/api/tax/filings/${filingId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filingReference: "REF-2026-042" }),
    }),
    { params: Promise.resolve({ id: filingId }) },
  );
}

test("POST prepare demands compliance.file and freezes the snapshot under it", async () => {
  reset(["compliance.file"]);

  const response = await post();

  assert.equal(response.status, 201);
  // The creation response echoes the filing's persisted (engine-clamped)
  // window alongside the version, so a narrowed multi-period request is
  // visible to the operator instead of hidden behind {id, version}.
  assert.deepEqual(await response.json(), {
    id: "filing-1",
    version: 2,
    formCode: "GST-Q",
    from: "2026-01-01",
    to: "2026-03-31",
  });
  assert.deepEqual(routeState.permissionChecks, ["compliance.file"]);
  assert.deepEqual(routeState.engineCalls, [
    { op: "compute", orgId: "org-1", userId: "user-1" },
    { op: "prepare", orgId: "org-1", userId: "user-1" },
  ]);
});

// The prepared filing freezes the computed return itself — its identity and
// currency posture travel with the boxes into the engine, which persists them.
// A reprint or staleness check that reads live configuration instead is the
// D2/D3 defect, so the hand-off is asserted here.
test("POST prepare hands the computed return identity to the engine to freeze", async () => {
  reset(["compliance.file"]);

  const response = await post();

  assert.equal(response.status, 201);
  assert.equal(routeState.filingInserts.length, 1);
  const { result } = routeState.filingInserts[0]!;
  for (const field of [
    "functionalCurrency",
    "translation",
    "subsidiaryIds",
    "registrationId",
    "registrationNumber",
  ]) {
    assert.ok(field in result, `prepare must receive ${field}`);
  }
});

test("POST prepare records each adjustment entry with its reason and sums the amounts for the computation", async () => {
  reset(["compliance.file"]);

  const response = await post({
    code: "GST-Q",
    from: "2026-01-01",
    to: "2026-03-31",
    adjustments: [
      { lineCode: "104", amount: "1000.00", reason: "January to June 2025 per prior system" },
      { lineCode: "104", amount: "2018.84", reason: "July and August 2025 per prior system" },
    ],
  });

  assert.equal(response.status, 201);
  assert.deepEqual(routeState.computeAdjustments, [{ "104": "3018.8400" }]);
  assert.equal(routeState.filingInserts[0]!.entries.length, 2);
  assert.deepEqual(routeState.filingInserts[0]!.entries[1], {
    lineCode: "104",
    amount: "2018.8400",
    reason: "July and August 2025 per prior system",
  });
});

test("POST prepare refuses an adjustment without a reason before reaching the engine", async () => {
  reset(["compliance.file"]);

  const response = await post({
    code: "GST-Q",
    from: "2026-01-01",
    to: "2026-03-31",
    adjustments: [{ lineCode: "104", amount: "3018.84", reason: "   " }],
  });

  assert.equal(response.status, 422);
  assert.match(JSON.stringify(await response.json()), /line 104 needs a reason/);
  assert.deepEqual(
    routeState.engineCalls,
    [],
    "an unexplained adjustment never reaches the engine",
  );
});

// TR2: prepare accepts the same filing scope the preview GET does and hands
// it to the engine verbatim, so an entity-scoped or translated preview can
// be frozen as prepared.
test("POST prepare passes the filing scope and translation to the engine", async () => {
  reset(["compliance.file"]);

  const response = await post({
    code: "GST-Q",
    from: "2026-01-01",
    to: "2026-03-31",
    filingEntity: { subsidiaryIds: ["sub-a"], registrationId: "reg-1" },
    translation: { presentationCurrency: "CAD", rateType: "spot", rateDate: "2026-03-31" },
  });

  assert.equal(response.status, 201);
  assert.deepEqual(routeState.scopeChecks, ["sub-a"]);
  assert.deepEqual(routeState.computeOpts, [
    {
      filingEntity: { subsidiaryIds: ["sub-a"], registrationId: "reg-1" },
      translation: { presentationCurrency: "CAD", rateType: "spot", rateDate: "2026-03-31" },
    },
  ]);
});

test("POST prepare refuses a malformed filing scope without reaching the engine", async () => {
  reset(["compliance.file"]);

  for (const [body, expectedStatus] of [
    [
      {
        code: "GST-Q",
        from: "2026-01-01",
        to: "2026-03-31",
        filingEntity: { subsidiaryIds: "sub-a" },
      },
      400,
    ],
    [
      { code: "GST-Q", from: "2026-01-01", to: "2026-03-31", filingEntity: { subsidiaryIds: [] } },
      422,
    ],
    [
      {
        code: "GST-Q",
        from: "2026-01-01",
        to: "2026-03-31",
        translation: { presentationCurrency: 7 },
      },
      400,
    ],
  ]) {
    const response = await post(body as Record<string, unknown>);
    assert.equal(response.status, expectedStatus);
  }
  assert.deepEqual(routeState.engineCalls, [], "refused scopes never reach the engine");
});

test("POST prepare keeps restricted callers inside their allowed subsidiaries", async () => {
  reset(["compliance.file"], ["sub-a"]);

  const scoped = await post({
    code: "GST-Q",
    from: "2026-01-01",
    to: "2026-03-31",
    filingEntity: { subsidiaryIds: ["sub-a"] },
  });
  assert.equal(scoped.status, 201);

  const foreign = await post({
    code: "GST-Q",
    from: "2026-01-01",
    to: "2026-03-31",
    filingEntity: { subsidiaryIds: ["sub-nope"] },
  });
  assert.equal(foreign.status, 404);

  const orgWide = await post();
  assert.equal(
    orgWide.status,
    403,
    "freezing the org-wide return is an org-wide write: restricted callers get the named remedy",
  );
  assert.deepEqual(await orgWide.json(), { error: "requires unrestricted subsidiary access" });
  assert.equal(
    routeState.engineCalls.length,
    2,
    "only the in-scope prepare reached the engine (compute, then prepare)",
  );
});

test("PATCH mark-filed demands compliance.file, not the report authority", async () => {
  reset(["compliance.file"]);
  const filingId = randomUUID();

  const response = await patch(filingId);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: filingId, filed_at: "2026-08-24T00:00:00.000Z" });
  assert.deepEqual(routeState.permissionChecks, ["compliance.file"]);
  assert.deepEqual(routeState.engineCalls, [{ op: "markFiled", orgId: "org-1", userId: "user-1" }]);
});

// A 409 whose reason stays server-side is UI-silent — the
// drawer can only toast a generic save failure. Every mark-filed 409 must
// carry its machine-readable code so the drawer localizes the remedy.
test("PATCH mark-filed 409s carry the typed refusal code", async () => {
  reset(["compliance.file"]);
  const filingId = randomUUID();

  routeState.markFiledError = taxFilingError(
    "period-not-closed",
    "period 2026-08 must be closed for gl across every covered subsidiary before the filing can be marked filed",
  );
  const closed = await patch(filingId);
  assert.equal(closed.status, 409);
  assert.deepEqual(await closed.json(), {
    code: "period-not-closed",
    error:
      "period 2026-08 must be closed for gl across every covered subsidiary before the filing can be marked filed",
  });

  routeState.markFiledError = taxFilingError("already-filed", "filing is already filed");
  const duplicate = await patch(filingId);
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), {
    code: "already-filed",
    error: "filing is already filed",
  });
});

function get(query: string): Promise<Response> {
  return GET(new Request(`http://openbooks.test/api/tax/filings${query}`));
}

// Impossible calendar dates must refuse by name: the calendar builder
// normalizes 2026-02-30 into March and would otherwise answer 200 with empty
// obligations instead of a 422.
test("GET refuses impossible calendar dates by name", async () => {
  reset(["reports.read"]);

  for (const [query, bad] of [
    ["?from=2026-02-30&to=2026-03-01", "2026-02-30"],
    ["?from=2026-01-01&to=2026-13-01", "2026-13-01"],
    ["?from=2025-02-29&to=2025-03-01", "2025-02-29"],
  ] as const) {
    const response = await get(query);
    assert.equal(response.status, 422);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, new RegExp(`invalid (from|to) date "${bad}"`));
  }
});

test("GET accepts a real leap day and keeps absent-param defaults", async () => {
  reset(["reports.read"]);

  const leap = await get("?from=2024-02-29&to=2024-03-01");
  assert.equal(leap.status, 200);
  assert.deepEqual(await leap.json(), { from: "2024-02-29", to: "2024-03-01", obligations: [] });

  const defaults = await get("");
  assert.equal(defaults.status, 200);
  assert.deepEqual(await defaults.json(), {
    from: "2026-01-01",
    to: "2026-08-24",
    obligations: [],
  });
});

test("a reports.create holder cannot certify a statutory filing", async () => {
  reset(["reports.create"]);

  const response = await post();

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "missing permission: compliance.file" });
  assert.deepEqual(routeState.permissionChecks, ["compliance.file"]);
  assert.deepEqual(
    routeState.engineCalls,
    [],
    "the refused certification never reached the engine",
  );
});
