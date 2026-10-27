import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
const realRunLifecycleUrl = new URL(
  "../../../../../../engine/src/payroll/run-lifecycle.ts",
  import.meta.url,
).href;
const realAuthzUrl = new URL("../../../../../lib/authz.ts", import.meta.url).href;
import { canonicalDecimal } from "../../../../../lib/exact-decimal";
import { isUuid } from "../../../../../lib/list-params";

/**
 * POST runs/[id] — every remaining collapsed refusal names its cause (422).
 *
 * Covers the six sites the bulk-adjustment batch left behind: the
 * single-adjustment and hours paths of 'invalid adjustment' (2 sites),
 * delete-adjustment's 'invalid adjustment', 'invalid scope', 'invalid
 * and invalid employee identifiers. Each refusal names
 * the field, the value received (capped via suppliedValue), and a remedy that
 * exists; amounts reuse the shared decimal classifier. The engine boundary
 * (`mutatePayRunAdjustment`) is mocked; this file proves the adapter around
 * it plus a PARITY table per site showing the old collapsed guard and the new
 * per-cause path agree on accept/refuse for every input.
 *
 * Unit partition: all dependencies mocked or pure; no database.
 */

const stateKey = Symbol.for("openbooks.payroll-run-id-refusals-test");
interface RouteState {
  ownedSubsidiaryId: string | null;
  adjustmentCalls: unknown[];
  excludedIds: string[];
}
const routeState: RouteState = { ownedSubsidiaryId: "sub-1", adjustmentCalls: [], excludedIds: [] };
(globalThis as Record<symbol, unknown>)[stateKey] = routeState;

// The route canonicalizes hours through the engine's real pure helper.
// Only the mutation boundary is doubled; bank ownership belongs to its native
// database properties, rather than a permissive copy of the validator.

const mockSources = new Map<string, string>([
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.payroll-run-id-refusals-test')]
      export const db = {
        // set-scope diffs the requested scope against the CURRENT exclusions:
        // answer that read from state, and the owning-document read as before.
        execute(query, mode) {
          const inMode = (result) => (mode === 'objects' ? result.rows : result)
          let text = ''
          try { text = JSON.stringify(query) } catch { text = '' }
          if (text.includes('pay_run_adjustments')) {
            return Promise.resolve({ rows: state.excludedIds.map((id) => ({ employee_party_id: id })) }).then(inMode)
          }
          return Promise.resolve({ rows: state.ownedSubsidiaryId ? [{ subsidiaryId: state.ownedSubsidiaryId }] : [] }).then(inMode)
        },
      }
      export async function withOrgTransaction(_orgId, fn) { return fn() }
      export function ambientTenantOrgId() { return null }
      export function currentRequestOrgResolver() { return null }
      export function registerRequestOrgResolver() {}
      export async function withBypass(work) { return work() }
      export async function withBypassContext(_opts, work) { return work() }
    `,
  ],
  [
    "mock:feature-gates",
    `
      export async function guardFeaturePermission() {
        return { user: { orgId: 'org-1', id: 'actor-1' }, permissions: new Set(['payroll.run']), allowedSubsidiaryIds: null }
      }
    `,
  ],
  [
    // The route factory re-checks the payroll feature after authorization.
    "mock:features",
    `export async function isFeatureEnabled(_orgId, key) { return key === 'payroll' }`,
  ],
  [
    "mock:authz",
    `
      export { guardUnrestrictedScope, subsidiaryScopeAllows, subsidiariesInScope, can } from '${realAuthzUrl}'
      export function guardSubsidiaryScope() { return undefined }
    `,
  ],
  [
    "mock:payroll-run",
    `
      export { attributePayRunEntity, discardPayRun } from '${realRunLifecycleUrl}'
      export async function acknowledgePayRunRefusals() { throw new Error('not under test') }
      export async function calculatePayRun() { throw new Error('not under test') }
      export async function commitPayRun() { throw new Error('not under test') }
      export async function previewPayRunGl() { throw new Error('not under test') }
    `,
  ],
  [
    "mock:payroll-payment",
    `export async function recordPayRunPayment() { throw new Error('not under test') }`,
  ],
  ["mock:payroll-readiness", `export async function assertPayRunNotStale() {}`],
  [
    "mock:payroll-approval",
    `
      export async function assertPayRunApprovalReleased() { throw new Error('not under test') }
      export async function payRunApprovalState() { throw new Error('not under test') }
      export async function recalculateStaleApprovedPayRun() { throw new Error('not under test') }
    `,
  ],
  [
    "mock:flows",
    `export async function submitAndReleaseIfUngated() { throw new Error('not under test') }`,
  ],
  [
    "mock:payroll-outputs",
    `export async function emailRunStubs() { throw new Error('not under test') }`,
  ],
  [
    "mock:payroll-evidence",
    `export async function assemblePayRunEvidence() { throw new Error('not under test') }`,
  ],
  [
    "mock:payroll-scope",
    `export async function lockAndCheckPayrollRunPopulation() { throw new Error('not under test') }`,
  ],
  [
    "mock:payroll-run-adjustments",
    `
      export async function recordPayRunHolidayHours() { throw new Error('not under test') }
      export { canonicalAdjustmentHours } from ${JSON.stringify(import.meta.resolve("@openbooks/engine/payroll/run-adjustments"))}
      const state = globalThis[Symbol.for('openbooks.payroll-run-id-refusals-test')]
      export async function mutatePayRunAdjustment(input) { state.adjustmentCalls.push(input); return { changed: true } }
      export class PayRunAdjustmentIdempotencyConflict extends Error {}
      export function payRunBulkAdjustmentId(batchKey, employeePartyId) { return batchKey + ':' + employeePartyId }
    `,
  ],
  [
    "mock:payroll-holiday-attestations",
    `export async function storedHolidayEligibilityForRun() { return {} }`,
  ],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@openbooks/engine/platform/db")
      return { url: "mock:db", shortCircuit: true };
    if (
      [
        "@openbooks/engine/payroll/run-calculation",
        "@openbooks/engine/payroll/run-commit",
        "@openbooks/engine/payroll/run-lifecycle",
      ].includes(specifier)
    )
      return { url: "mock:payroll-run", shortCircuit: true };
    if (specifier === "@openbooks/engine/payroll/payment")
      return { url: "mock:payroll-payment", shortCircuit: true };
    if (specifier === "@openbooks/engine/payroll/readiness")
      return { url: "mock:payroll-readiness", shortCircuit: true };
    if (specifier === "@openbooks/engine/payroll/approval")
      return { url: "mock:payroll-approval", shortCircuit: true };
    if (specifier === "@openbooks/engine/flows/module")
      return { url: "mock:flows", shortCircuit: true };
    if (specifier === "@openbooks/engine/payroll/run-adjustments") {
      return { url: "mock:payroll-run-adjustments", shortCircuit: true };
    }
    if (specifier === "@openbooks/engine/payroll/holiday-attestations") {
      return { url: "mock:payroll-holiday-attestations", shortCircuit: true };
    }
    if (specifier === "@openbooks/engine/payroll/scope")
      return { url: "mock:payroll-scope", shortCircuit: true };
    if (specifier.endsWith("/lib/payroll-outputs"))
      return { url: "mock:payroll-outputs", shortCircuit: true };
    if (specifier.endsWith("/lib/payroll-evidence"))
      return { url: "mock:payroll-evidence", shortCircuit: true };
    if (specifier.endsWith("/lib/feature-gates"))
      return { url: "mock:feature-gates", shortCircuit: true };
    if (specifier === "@/lib/features" && context.parentURL?.endsWith("/web/lib/api/route.ts"))
      return { url: "mock:features", shortCircuit: true };
    if (specifier.endsWith("/lib/authz")) return { url: "mock:authz", shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?payroll-run-id-refusals-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");

const RUN_ID = "00000000-0000-4000-8000-000000000001";
const COMPONENT_ID = "00000000-0000-4000-8000-000000000002";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function reset() {
  routeState.ownedSubsidiaryId = "sub-1";
  routeState.adjustmentCalls = [];
  routeState.excludedIds = [];
}

function validAdd(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "add-adjustment",
    employeePartyId: uuid(1),
    componentId: COMPONENT_ID,
    amount: "100.00",
    ...overrides,
  };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request(`http://openbooks.test/api/payroll/runs/${RUN_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: RUN_ID }) },
  );
}

async function errorOf(body: unknown): Promise<{ status: number; error: string }> {
  const res = await post(body);
  const parsed = (await res.json()) as { error?: string };
  return { status: res.status, error: parsed.error ?? "" };
}

test("single adjustment preserves native rebased employee and component identities", async () => {
  reset();
  const employeePartyId = "db76ccd6-d8a3-ead7-42d2-6279dd4ea029";
  const componentId = "17ead58a-01df-a411-0031-43714689801a";
  const response = await post(validAdd({ employeePartyId, componentId }));
  assert.equal(response.status, 200);
  assert.equal(routeState.adjustmentCalls.length, 1);
  const call = routeState.adjustmentCalls[0] as {
    mutation: { employeePartyId: string; componentId: string };
  };
  assert.equal(call.mutation.employeePartyId, employeePartyId);
  assert.equal(call.mutation.componentId, componentId);
});

test("income-tax override requires an idempotency key and crosses the native command with explicit evidence", async () => {
  reset();
  const body = {
    action: "override-income-tax",
    employeePartyId: uuid(1),
    amount: "120.15",
    reason: "Operator-entered cheque withholding",
    sourceReference: "payroll-card:fixture-1",
  };
  const missingKey = await post(body);
  assert.equal(missingKey.status, 400);
  assert.match((await missingKey.json()).error, /UUID Idempotency-Key/);
  assert.equal(routeState.adjustmentCalls.length, 0);

  const tooPrecise = await post({ ...body, amount: "120.155" }, { "Idempotency-Key": uuid(24) });
  assert.equal(tooPrecise.status, 422);
  assert.match((await tooPrecise.json()).error, /amount/);
  assert.equal(routeState.adjustmentCalls.length, 0);

  const requestKey = uuid(25);
  const response = await post(body, { "Idempotency-Key": requestKey });
  assert.equal(response.status, 200);
  assert.equal(routeState.adjustmentCalls.length, 1);
  const call = routeState.adjustmentCalls[0] as {
    mutation: Record<string, unknown>;
    reason: string;
  };
  assert.deepEqual(call.mutation, {
    action: "override_income_tax",
    employeePartyId: uuid(1),
    amount: "120.15",
    reason: body.reason,
    sourceReference: body.sourceReference,
    idempotencyKey: requestKey,
  });
  assert.equal(call.reason, body.reason);
  assert.equal(
    canonicalDecimal(call.mutation.amount, 2),
    "120.15",
    "the native cents guard accepts the adapter amount",
  );

  reset();
  const zero = await post({ ...body, amount: "0" }, { "Idempotency-Key": uuid(26) });
  assert.equal(zero.status, 200);
  assert.equal(
    (routeState.adjustmentCalls[0] as { mutation: { amount: string } }).mutation.amount,
    "0",
  );
});

test("calculation facts must be filed through their native durable records", async () => {
  for (const holidayEligibility of [
    null,
    {},
    { [uuid(1)]: { paidOnCommission: true, absentWithoutConsent: false } },
  ]) {
    reset();
    const { status, error } = await errorOf(validAdd({ holidayEligibility }));
    assert.equal(status, 422);
    assert.match(error, /holidayEligibility is not a calculation input/);
    assert.match(error, /file holiday assertions on the pay run/);
    assert.equal(routeState.adjustmentCalls.length, 0);
  }
  reset();
  assert.equal((await post(validAdd())).status, 200);
});

// ---------------------------------------------------------------------------
// add-adjustment hours: a scale-2 amount into numeric(12,2)
// ---------------------------------------------------------------------------

test("hours refusals name the cause and write nothing", async () => {
  const cases: Array<{ name: string; hours: unknown; patterns: RegExp[] }> = [
    {
      name: "unreadable",
      hours: "abc",
      patterns: [/hours must be a number of hours — "abc" is not a number/],
    },
    {
      name: "third decimal",
      hours: "1.234",
      patterns: [/hours allows at most 2 decimal places — got 3/],
    },
    {
      name: "decimal comma",
      hours: "12,34",
      patterns: [/hours must use "\." as the decimal point — write "12,34" as "12\.34"/],
    },
    {
      name: "thousands separator",
      hours: "1,234.56",
      patterns: [/hours must not contain a thousands separator/],
    },
    {
      name: "negative",
      hours: "-3",
      patterns: [/hours must not be negative — got "-3"/, /pass zero or more hours, or omit hours/],
    },
  ];
  for (const { name, hours, patterns } of cases) {
    reset();
    const { status, error } = await errorOf(validAdd({ hours }));
    assert.equal(status, 422, `${name} should refuse`);
    for (const pattern of patterns) assert.match(error, pattern, name);
    assert.equal(routeState.adjustmentCalls.length, 0, `${name} should write nothing`);
  }
});

test("hours refuses eleven whole digits naming the limit, accepts ten", async () => {
  reset();
  const refused = await errorOf(validAdd({ hours: "12345678901" }));
  assert.equal(refused.status, 422);
  assert.match(refused.error, /hours is out of range — at most 10 whole digits fit/);
  assert.match(refused.error, /got "12345678901"/);
  assert.equal(routeState.adjustmentCalls.length, 0);

  reset();
  const res = await post(validAdd({ hours: "1234567890.12" }));
  assert.equal(res.status, 200);
  assert.equal(routeState.adjustmentCalls.length, 1);
});

test("hours accepts absence, blank, zero, and two-decimal values", async () => {
  for (const hours of [undefined, null, "", "0", "0.00", "7.5", "37.25"]) {
    reset();
    const res = await post(validAdd({ hours }));
    assert.equal(res.status, 200, `hours ${JSON.stringify(hours)} should be accepted`);
    assert.equal(routeState.adjustmentCalls.length, 1);
  }
});

test("add-adjustment passes canonical hours to the engine", async () => {
  reset();
  const res = await post(validAdd({ hours: "7.50" }));
  assert.equal(res.status, 200);
  const calls = routeState.adjustmentCalls as Array<{ mutation: { hours: unknown } }>;
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.mutation.hours, "7.5");
  reset();
  const deposit = await post(
    validAdd({ amount: "-240", hours: "-8.00", note: "Overtime bank deposit" }),
  );
  assert.equal(deposit.status, 200);
  const deposits = routeState.adjustmentCalls as Array<{
    mutation: { hours: unknown; amount: unknown };
  }>;
  assert.equal(deposits.length, 1);
  assert.equal(deposits[0]?.mutation.hours, "-8");
  assert.equal(deposits[0]?.mutation.amount, "-240.0000");
  reset();
  const tooWide = await errorOf(validAdd({ amount: "-240", hours: "-12345678901" }));
  assert.equal(tooWide.status, 422);
  assert.match(tooWide.error, /hours is out of range/);
  assert.equal(routeState.adjustmentCalls.length, 0);
});

// ---------------------------------------------------------------------------
// add-adjustment: the collapsed guard over employee, component, amount, note
// ---------------------------------------------------------------------------

test("add-adjustment id, amount, note, and flag refusals name the value", async () => {
  const cases: Array<{ name: string; overrides: Record<string, unknown>; patterns: RegExp[] }> = [
    {
      name: "non-string employeePartyId",
      overrides: { employeePartyId: 42 },
      patterns: [
        /employeePartyId must be an employee id — got "42"/,
        /pass the employee as an employee id/,
      ],
    },
    {
      name: "malformed employeePartyId",
      overrides: { employeePartyId: "nope" },
      patterns: [/employeePartyId "nope" is not an employee id/, /fix the id and try again/],
    },
    {
      name: "non-string componentId",
      overrides: { componentId: 42 },
      patterns: [/componentId must be a pay component id — got "42"/, /adjustableComponents/],
    },
    {
      name: "malformed componentId",
      overrides: { componentId: "nope" },
      patterns: [/componentId "nope" is not a pay component id/, /adjustableComponents/],
    },
    {
      name: "unreadable amount",
      overrides: { amount: "abc" },
      patterns: [/amount must be an amount — "abc" is not a number/],
    },
    {
      name: "five-decimal amount",
      overrides: { amount: "1.23456" },
      patterns: [/amount allows at most 4 decimal places — got 5/],
    },
    {
      name: "non-text note",
      overrides: { note: 42 },
      patterns: [/note must be text — got "42"/, /pass the note as text or omit it/],
    },
    {
      name: "non-boolean replaceComponent",
      overrides: { replaceComponent: "yes" },
      patterns: [/replaceComponent must be true or false — got "yes"/, /pass a boolean or omit it/],
    },
  ];
  for (const { name, overrides, patterns } of cases) {
    reset();
    const { status, error } = await errorOf(validAdd(overrides));
    assert.equal(status, 422, `${name} should refuse`);
    for (const pattern of patterns) assert.match(error, pattern, name);
    assert.equal(routeState.adjustmentCalls.length, 0, `${name} should write nothing`);
  }
});

test("add-adjustment refuses a 501-character note naming the limit, accepts 500", async () => {
  reset();
  const refused = await errorOf(validAdd({ note: "x".repeat(501) }));
  assert.equal(refused.status, 422);
  assert.match(refused.error, /note is limited to 500 characters — got 501/);
  assert.equal(routeState.adjustmentCalls.length, 0);

  reset();
  const res = await post(validAdd({ note: "x".repeat(500) }));
  assert.equal(res.status, 200);
  assert.equal(routeState.adjustmentCalls.length, 1);
});

// ---------------------------------------------------------------------------
// delete-adjustment: type vs shape, not one 'invalid adjustment'
// ---------------------------------------------------------------------------

test("delete-adjustment id refusals name the value", async () => {
  const cases: Array<{ name: string; body: Record<string, unknown>; patterns: RegExp[] }> = [
    {
      name: "missing adjustmentId",
      body: { action: "delete-adjustment" },
      patterns: [
        /adjustmentId must be a pay adjustment id — got "a undefined"/,
        /pass the adjustment to delete as an id/,
      ],
    },
    {
      name: "malformed adjustmentId",
      body: { action: "delete-adjustment", adjustmentId: "nope" },
      patterns: [/adjustmentId "nope" is not a pay adjustment id/, /fix the id and try again/],
    },
  ];
  for (const { name, body, patterns } of cases) {
    reset();
    const { status, error } = await errorOf(body);
    assert.equal(status, 422, `${name} should refuse`);
    for (const pattern of patterns) assert.match(error, pattern, name);
    assert.equal(routeState.adjustmentCalls.length, 0, `${name} should write nothing`);
  }
});

test("delete-adjustment accepts a well-formed id", async () => {
  reset();
  const res = await post({ action: "delete-adjustment", adjustmentId: uuid(9) });
  assert.equal(res.status, 200);
  assert.equal(routeState.adjustmentCalls.length, 1);
});

// ---------------------------------------------------------------------------
// set-scope: two lists, a limit, and two indexed entries
// ---------------------------------------------------------------------------

function validScope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "set-scope",
    employeePartyIds: [uuid(1)],
    rosterPartyIds: [uuid(1), uuid(2)],
    ...overrides,
  };
}

test("set-scope list refusals name the value", async () => {
  const cases: Array<{ name: string; overrides: Record<string, unknown>; patterns: RegExp[] }> = [
    {
      name: "non-list employeePartyIds",
      overrides: { employeePartyIds: "nope" },
      patterns: [
        /employeePartyIds must be a list of employee ids — got "nope"/,
        /pass the employees to include as a list/,
      ],
    },
    {
      name: "non-list rosterPartyIds",
      overrides: { rosterPartyIds: null },
      patterns: [
        /rosterPartyIds must be a list of employee ids — got "a null"/,
        /pass the run roster as a list/,
      ],
    },
  ];
  for (const { name, overrides, patterns } of cases) {
    reset();
    const { status, error } = await errorOf(validScope(overrides));
    assert.equal(status, 422, `${name} should refuse`);
    for (const pattern of patterns) assert.match(error, pattern, name);
    assert.equal(routeState.adjustmentCalls.length, 0, `${name} should write nothing`);
  }
});

test("set-scope refuses 2001 roster employees naming the limit, accepts 2000", async () => {
  reset();
  const ids = Array.from({ length: 2001 }, (_, i) => uuid(i + 1));
  const refused = await errorOf(validScope({ employeePartyIds: [ids[0]], rosterPartyIds: ids }));
  assert.equal(refused.status, 422);
  assert.match(refused.error, /set-scope accepts at most 2000 roster employees at once — got 2001/);
  assert.equal(routeState.adjustmentCalls.length, 0);

  reset();
  const twoThousand = Array.from({ length: 2000 }, (_, i) => uuid(i + 1));
  const res = await post(
    validScope({ employeePartyIds: [twoThousand[0]], rosterPartyIds: twoThousand }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, included: 0, excluded: 1999 });
  // The kept member is already in scope and staying: diffed, not replayed.
  assert.equal(routeState.adjustmentCalls.length, 1999);
});

test("set-scope names a bad id AND its index", async () => {
  const cases: Array<{ name: string; overrides: Record<string, unknown>; patterns: RegExp[] }> = [
    {
      name: "bad included id",
      overrides: { employeePartyIds: [uuid(1), "nope"] },
      patterns: [
        /employeePartyIds\[1\] "nope" is not an employee id/,
        /fix that entry and try again/,
      ],
    },
    {
      name: "bad roster id",
      overrides: { rosterPartyIds: [uuid(1), "nope"] },
      patterns: [
        /rosterPartyIds\[1\] "nope" is not an employee id/,
        /fix that entry and try again/,
      ],
    },
  ];
  for (const { name, overrides, patterns } of cases) {
    reset();
    const { status, error } = await errorOf(validScope(overrides));
    assert.equal(status, 422, `${name} should refuse`);
    for (const pattern of patterns) assert.match(error, pattern, name);
    assert.equal(routeState.adjustmentCalls.length, 0, `${name} should write nothing`);
  }
});

test("set-scope accepts an empty included list and an empty roster", async () => {
  reset();
  const excludeAll = await post(validScope({ employeePartyIds: [], rosterPartyIds: [uuid(1)] }));
  assert.equal(excludeAll.status, 200);
  assert.deepEqual(await excludeAll.json(), { ok: true, included: 0, excluded: 1 });

  reset();
  const emptyRoster = await post(validScope({ employeePartyIds: [], rosterPartyIds: [] }));
  assert.equal(emptyRoster.status, 200);
  assert.deepEqual(await emptyRoster.json(), { ok: true, included: 0, excluded: 0 });
});

test("set-scope mutates only what changes: members staying in or out are skipped", async () => {
  reset();
  routeState.excludedIds = [uuid(2)];
  const res = await post(
    validScope({ employeePartyIds: [uuid(1)], rosterPartyIds: [uuid(1), uuid(2)] }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, included: 0, excluded: 0 });
  // uuid(1) is in scope and staying; uuid(2) is out and staying out.
  assert.equal(routeState.adjustmentCalls.length, 0);
});

test("set-scope mutates only what changes: one removal and one re-add", async () => {
  reset();
  routeState.excludedIds = [uuid(2)];
  const res = await post(
    validScope({
      employeePartyIds: [uuid(1), uuid(2)],
      rosterPartyIds: [uuid(1), uuid(2), uuid(3)],
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, included: 1, excluded: 1 });
  // uuid(1) stays in (skipped); uuid(2) is re-added; uuid(3) is removed.
  assert.equal(routeState.adjustmentCalls.length, 2);
  const actions = (
    routeState.adjustmentCalls as { mutation: { action: string; employeePartyId: string } }[]
  )
    .map((call) => `${call.mutation.action}:${call.mutation.employeePartyId}`)
    .sort();
  assert.deepEqual(actions, [`exclude:${uuid(3)}`, `include:${uuid(2)}`]);
});

// ---------------------------------------------------------------------------
// exclude/include-employee: this file's 'invalid employee'
// ---------------------------------------------------------------------------

test("exclude/include-employee id refusals name the value", async () => {
  const cases: Array<{ name: string; body: Record<string, unknown>; patterns: RegExp[] }> = [
    {
      name: "non-string exclude id",
      body: { action: "exclude-employee", employeePartyId: 42 },
      patterns: [/employeePartyId must be an employee id — got "42"/],
    },
    {
      name: "malformed include id",
      body: { action: "include-employee", employeePartyId: "nope" },
      patterns: [/employeePartyId "nope" is not an employee id/, /fix the id and try again/],
    },
  ];
  for (const { name, body, patterns } of cases) {
    reset();
    const { status, error } = await errorOf(body);
    assert.equal(status, 422, `${name} should refuse`);
    for (const pattern of patterns) assert.match(error, pattern, name);
    assert.equal(routeState.adjustmentCalls.length, 0, `${name} should write nothing`);
  }
});

test("exclude-employee and include-employee accept a well-formed id", async () => {
  for (const action of ["exclude-employee", "include-employee"]) {
    reset();
    const res = await post({ action, employeePartyId: uuid(1) });
    assert.equal(res.status, 200, `${action} should be accepted`);
    assert.equal(routeState.adjustmentCalls.length, 1);
  }
});

// ---------------------------------------------------------------------------
// PARITY: the old collapsed guard and the new per-cause path must agree on
// accept/refuse for every input. The oracles below are verbatim copies of the
// pre-fix predicates in route.ts at 2acbee344 (and of
// canonicalAdjustmentHours in engine/src/payroll/run-adjustments.ts); the
// "new" verdict is the live route's HTTP status. Agreement proves the change
// split causes without moving the boundary. Every refusal must also differ
// from the old collapsed literal — otherwise the literal survived.
// ---------------------------------------------------------------------------

function oldCanonicalAdjustmentHours(value: unknown): string | null {
  if (value == null || value === "") return null;
  const exact = canonicalDecimal(value, 2);
  if (exact === null || exact.startsWith("-")) return null;
  if (exact.replace(/^[+]/, "").split(".")[0]!.replace(/^0+/, "").length > 10) return null;
  return exact;
}

function oldAddRefuses(body: Record<string, unknown>): boolean {
  const { employeePartyId, componentId, amount, hours, note, replaceComponent } = body;
  let hoursRaw: string | null = null;
  if (hours != null && hours !== "") {
    hoursRaw = oldCanonicalAdjustmentHours(hours);
    if (hoursRaw === null) return true;
  }
  return (
    typeof employeePartyId !== "string" ||
    !isUuid(employeePartyId) ||
    typeof componentId !== "string" ||
    !isUuid(componentId) ||
    canonicalDecimal(amount, 4) === null ||
    (note != null && (typeof note !== "string" || (note as string).length > 500)) ||
    (replaceComponent != null && typeof replaceComponent !== "boolean")
  );
}

function oldDeleteRefuses(body: Record<string, unknown>): boolean {
  return typeof body.adjustmentId !== "string" || !isUuid(body.adjustmentId as string);
}

function oldScopeRefuses(body: Record<string, unknown>): boolean {
  const included = Array.isArray(body.employeePartyIds) ? body.employeePartyIds : null;
  const roster = Array.isArray(body.rosterPartyIds) ? body.rosterPartyIds : null;
  const uuidish = (v: unknown) => typeof v === "string" && isUuid(v);
  return (
    !included ||
    !roster ||
    (roster as unknown[]).length > 2000 ||
    !(included as unknown[]).every(uuidish) ||
    !(roster as unknown[]).every(uuidish) ||
    (included as string[]).some((id) => !(roster as string[]).includes(id))
  );
}

function oldEmployeeRefuses(body: Record<string, unknown>): boolean {
  return typeof body.employeePartyId !== "string" || !isUuid(body.employeePartyId as string);
}

async function refused(body: unknown): Promise<{ refused: boolean; error: string }> {
  reset();
  const { status, error } = await errorOf(body);
  assert.ok(
    status === 200 || status === 422,
    `unexpected status ${status} for ${JSON.stringify(body)}`,
  );
  return { refused: status === 422, error };
}

test("PARITY add-adjustment: old guard and new causes agree on every input", async () => {
  const base = validAdd();
  const bodies: Record<string, unknown>[] = [];
  for (const employeePartyId of [undefined, null, 42, true, "nope", "", "   ", uuid(1)]) {
    bodies.push({ ...base, employeePartyId });
  }
  for (const componentId of [undefined, null, 42, "nope", uuid(7)]) {
    bodies.push({ ...base, componentId });
  }
  for (const amount of [
    undefined,
    null,
    42,
    "",
    " ",
    "abc",
    "1.23456",
    "1,234.56",
    "12,34",
    "$5",
    "1.5E+05",
    "100.00",
    100,
  ]) {
    bodies.push({ ...base, amount });
  }
  for (const hours of [
    undefined,
    null,
    "",
    " ",
    "abc",
    "1.234",
    "-3",
    "-0",
    "12345678901",
    "1234567890",
    "7.5",
    7.5,
    0,
    false,
  ]) {
    bodies.push({ ...base, hours });
  }
  for (const note of [undefined, null, 42, "", "x".repeat(500), "x".repeat(501)]) {
    bodies.push({ ...base, note });
  }
  for (const replaceComponent of [undefined, null, true, false, "yes", 1, 0]) {
    bodies.push({ ...base, replaceComponent });
  }
  // Two faults at once: still refused (the old disjunction refused too).
  bodies.push({ ...base, employeePartyId: "nope", amount: "abc" });
  for (const body of bodies) {
    const expected = oldAddRefuses(body);
    const { refused: actual, error } = await refused(body);
    assert.equal(
      actual,
      expected,
      `add-adjustment ${JSON.stringify(body)}: old=${expected} new=${actual}`,
    );
    if (actual)
      assert.notEqual(error, "invalid adjustment", `literal survived for ${JSON.stringify(body)}`);
  }
});

test("PARITY delete-adjustment: old guard and new causes agree on every input", async () => {
  for (const adjustmentId of [undefined, null, 42, "nope", "", uuid(9)]) {
    const body = { action: "delete-adjustment", adjustmentId };
    const expected = oldDeleteRefuses(body);
    const { refused: actual, error } = await refused(body);
    assert.equal(
      actual,
      expected,
      `delete-adjustment ${JSON.stringify(body)}: old=${expected} new=${actual}`,
    );
    if (actual)
      assert.notEqual(error, "invalid adjustment", `literal survived for ${JSON.stringify(body)}`);
  }
});

test("PARITY set-scope: old guard and new causes agree on every input", async () => {
  const twoThousand = Array.from({ length: 2000 }, (_, i) => uuid(i + 1));
  const overLimit = [...twoThousand, uuid(2001)];
  const bodies: Record<string, unknown>[] = [
    validScope(),
    validScope({ employeePartyIds: undefined }),
    validScope({ employeePartyIds: null }),
    validScope({ employeePartyIds: "nope" }),
    validScope({ employeePartyIds: [] }),
    validScope({ employeePartyIds: [uuid(1), "nope"] }),
    validScope({ employeePartyIds: [42] }),
    validScope({ rosterPartyIds: undefined }),
    validScope({ rosterPartyIds: null }),
    validScope({ rosterPartyIds: "x" }),
    validScope({ rosterPartyIds: [] }),
    validScope({ rosterPartyIds: [uuid(1), "nope"] }),
    validScope({ employeePartyIds: [], rosterPartyIds: [] }),
    validScope({ employeePartyIds: twoThousand.slice(0, 1), rosterPartyIds: twoThousand }),
    validScope({ employeePartyIds: [twoThousand[0]], rosterPartyIds: overLimit }),
    validScope({ employeePartyIds: ["nope"], rosterPartyIds: ["also-bad"] }),
  ];
  for (const body of bodies) {
    const expected = oldScopeRefuses(body);
    const { refused: actual, error } = await refused(body);
    assert.equal(
      actual,
      expected,
      `set-scope ${JSON.stringify(body).slice(0, 120)}: old=${expected} new=${actual}`,
    );
    if (actual) assert.notEqual(error, "invalid scope", "literal survived");
  }
});

test("PARITY exclude/include-employee: old guard and new causes agree on every input", async () => {
  for (const action of ["exclude-employee", "include-employee"]) {
    for (const employeePartyId of [undefined, null, 42, "nope", "", uuid(1)]) {
      const body = { action, employeePartyId };
      const expected = oldEmployeeRefuses(body);
      const { refused: actual, error } = await refused(body);
      assert.equal(
        actual,
        expected,
        `${action} ${JSON.stringify(body)}: old=${expected} new=${actual}`,
      );
      if (actual)
        assert.notEqual(error, "invalid employee", `literal survived for ${JSON.stringify(body)}`);
    }
  }
});
