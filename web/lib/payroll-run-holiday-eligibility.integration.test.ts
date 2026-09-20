import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { Authz } from "./authz";

const state: { gate: Authz | null } = { gate: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.payroll-run-holiday-eligibility")] = state;
// The route imports the JSON boundary through the web `@/` alias, which tsx
// resolves only under the web tsconfig. Map it to the real module so the
// route under test runs its production body parsing.
const apiJsonUrl = new URL("./api/json.ts", import.meta.url).href;
// Fleet worktrees carry a real (copied) root node_modules, so engine imports
// resolve inside this worktree already; only web-only shims need rewriting.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  if (specifier === "@/lib/api/json") return { shortCircuit: true, url: apiJsonUrl };
  const parent = decodeURIComponent(context.parentURL ?? "");
  if ((specifier === "../../../../../lib/feature-gates" && parent.endsWith("/api/payroll/runs/[id]/route.ts"))
    || (specifier === "../../../../../../lib/feature-gates" && parent.endsWith("/api/payroll/runs/[id]/holiday-assertions/route.ts"))
    || (specifier === "../../../../lib/feature-gates" && parent.endsWith("/api/payroll/profiles/route.ts"))) {
    return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
      "export async function guardFeaturePermission(){return globalThis[Symbol.for('openbooks.payroll-run-holiday-eligibility')].gate}") };
  }
  return next(specifier, context);
} });
const { sql } = await import("drizzle-orm");
const { randomUUID } = await import("node:crypto");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { seedAdoption } = await import("@openbooks/engine/src/payroll/filing-test-fixtures.ts");
const { createPayRun } = await import("@openbooks/engine/src/payroll/run-lifecycle.ts");
const { demandingHolidays, recordHolidayAssertion } = await import("@openbooks/engine/src/payroll/holiday-attestations.ts");
const { payRunStaleness } = await import("@openbooks/engine/src/payroll/readiness.ts");
const { dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { POST } = await import("../app/api/payroll/runs/[id]/route");
const assertionsRoute = await import("../app/api/payroll/runs/[id]/holiday-assertions/route");
const profilesRoute = await import("../app/api/payroll/profiles/route");

/**
 * A web-driven pay run spanning a paid statutory holiday must be calculable:
 * the engine demands explicit employer attestations (commission status /
 * last-and-first-shift absence) wherever a declaring rule reads them, so the
 * calculate/dry-run actions must accept that fact map and pass it through.
 * Without it, every December run in a declaring jurisdiction fails closed
 * with no remedy the UI or API can offer.
 */

function runGate(fx: { orgId: string; actorId: string }): Authz {
  return {
    user: { orgId: fx.orgId, id: fx.actorId },
    permissions: new Set(["payroll.run"]),
    allowedSubsidiaryIds: null,
  } as Authz;
}

async function christmasRun(fx: Awaited<ReturnType<typeof seedAdoption>>) {
  return withBypassContext(async () => {
    // Mirror a pack-installed tenant: the first install-pack enables statutory
    // holiday pay, without which the engine skips the holiday path entirely
    // and no attestation is ever demanded (a vacuous pass).
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(settings, '{payroll,statutoryHolidayPay}', 'true')
       where id = ${fx.orgId}`);
    await db.execute(sql`
      insert into time_entries (org_id, employee_party_id, worked_on, hours, status,
        is_billable, billing_status, costing_basis, created_by, updated_by)
      values (${fx.orgId}, ${fx.employeeId}, '2025-12-22', 8, 'approved', false,
        'unbilled', 'actual', ${fx.actorId}, ${fx.actorId})`);
    // Explicit period: Christmas Day 2025 lands inside it, so Ontario's
    // last-and-first-shift rule demands the absence assertion.
    return createPayRun({
      orgId: fx.orgId,
      actorId: fx.actorId,
      payScheduleId: fx.scheduleId,
      periodStart: "2025-12-21",
      periodEnd: "2026-01-03",
    });
  });
}

async function calculate(documentId: string, body: Record<string, unknown>) {
  // The route reads the run through ambient org scope (production supplies
  // it per request). Scope each call to the mocked gate's org: unscoped the
  // run is invisible and every calculate 404s before reaching the holiday
  // engine under test.
  const gate = state.gate;
  assert.ok(gate, "calculate requires an authenticated gate");
  return withOrgContext(gate.user.orgId, () => POST(
    new Request("https://openbooks.test/api/payroll/runs/fixture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: documentId }) },
  ));
}

test("calculate without attestations reports the statutory-holiday demand", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await withBypassContext(() => seedAdoption());
  try {
    state.gate = runGate(fx);
    const { documentId } = await christmasRun(fx);
    const res = await calculate(documentId, { action: "calculate" });
    assert.equal(res.status, 200);
    const body = await res.json() as { errors: { employee: string; message: string }[] };
    assert.ok(
      body.errors.some((e) => e.message.includes("last-and-first-shift")),
      `expected the absence-assertion demand, got ${JSON.stringify(body.errors)}`,
    );
  } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
});

test("calculate accepts holidayEligibility and clears the demand", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await withBypassContext(() => seedAdoption());
  try {
    state.gate = runGate(fx);
    const { documentId } = await christmasRun(fx);
    const res = await calculate(documentId, {
      action: "calculate",
      holidayEligibility: { [fx.employeeId]: { absentWithoutConsent: false } },
    });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()).slice(0, 500));
    const body = await res.json() as { ok: boolean; errors: { message: string }[] };
    assert.equal(body.ok, true);
    assert.deepEqual(body.errors, []);
  } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
});

test("calculate refuses malformed holidayEligibility", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await withBypassContext(() => seedAdoption());
  try {
    state.gate = runGate(fx);
    const { documentId } = await christmasRun(fx);
    for (const bad of [
      { "not-a-uuid": { absentWithoutConsent: false } },
      { [fx.employeeId]: { absentWithoutConsent: "no" } },
      { [fx.employeeId]: { paidOnCommission: 1 } },
      { [fx.employeeId]: { frobnicated: true } },
    ]) {
      const res = await calculate(documentId, { action: "calculate", holidayEligibility: bad });
      assert.equal(res.status, 422, JSON.stringify(await res.clone().json()).slice(0, 300));
    }
  } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
});

/**
 * Migration 0181 proof. The absence assertion is per (run, employee,
 * holiday): filing every demanding occurrence clears the refusal, the answer
 * survives recalculation with NO per-request map, a partial filing still
 * refuses, and an employee with nothing filed still refuses by name with the
 * same message.
 */
async function addEmployee(
  fx: Awaited<ReturnType<typeof seedAdoption>>,
  name: string,
  province: string,
): Promise<string> {
  return withBypassContext(async () => {
    const id = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${id}, ${fx.orgId}, 'person', ${name}, true, '{}'::jsonb)`);
    await db.execute(sql`
      insert into employee_roles (org_id, party_id, hired_on, is_active, created_by, updated_by)
      values (${fx.orgId}, ${id}, '2020-01-06', true, ${fx.actorId}, ${fx.actorId})`);
    await db.execute(sql`
      insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                    is_active, created_by, updated_by)
      values (${fx.orgId}, ${id}, 'CAD', '30', 'hour', '2020-01-01', true,
              ${fx.actorId}, ${fx.actorId})`);
    await db.execute(sql`
      insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                             pay_basis, country, federal_claim_code,
                                             provincial_claim_code, vacation_percent, vacation_method,
                                             is_active, created_by, updated_by)
      values (${fx.orgId}, ${id}, ${fx.scheduleId}, ${province}, 'hourly', 'CA', 1, 1,
              '4', 'accrue', true, ${fx.actorId}, ${fx.actorId})`);
    return id;
  });
}

async function fileAbsence(
  fx: Awaited<ReturnType<typeof seedAdoption>>,
  documentId: string,
  employeeId: string,
  employeeName: string,
  province: string,
  value: boolean,
  onlyFirst = false,
): Promise<void> {
  const demanding = await withBypassContext(() => demandingHolidays(db, {
    orgId: fx.orgId,
    country: "CA", province, labourJurisdiction: null,
    employeeName, periodStart: "2025-12-21", periodEnd: "2026-01-03",
  }));
  assert.ok(demanding.length > 0, "expected demanding holidays in the Christmas period");
  const targets = onlyFirst ? demanding.slice(0, 1) : demanding;
  await withBypassContext(async () => {
    for (const holiday of targets) {
      await recordHolidayAssertion(db, {
        orgId: fx.orgId, documentId, employeePartyId: employeeId,
        holidayKey: holiday.key, holidayDate: holiday.date,
        absentWithoutConsent: value, actorId: fx.actorId,
      });
    }
  });
}

async function absenceRefusals(documentId: string): Promise<{ employee: string; message: string }[]> {
  const res = await calculate(documentId, { action: "calculate" });
  assert.equal(res.status, 200);
  const body = await res.json() as { errors: { employee: string; message: string }[] };
  return body.errors.filter((e) => e.message.includes("last-and-first-shift"));
}

test("filed absence assertions persist across recalculations; the unfiled still refuse by name", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await withBypassContext(() => seedAdoption());
  try {
    state.gate = runGate(fx);
    const secondId = await addEmployee(fx, "Second Worker", "ON");
    const { documentId } = await christmasRun(fx);
    // Refusal before: both employees, by name, with the same message.
    let refusals = await absenceRefusals(documentId);
    assert.ok(refusals.some((e) => e.employee === "Terry Worker"), JSON.stringify(refusals));
    assert.ok(refusals.some((e) => e.employee === "Second Worker"), JSON.stringify(refusals));
    // A partial filing (one of several demanding occurrences) still refuses.
    await fileAbsence(fx, documentId, fx.employeeId, fx.employeeName, "ON", false, true);
    refusals = await absenceRefusals(documentId);
    assert.ok(refusals.some((e) => e.employee === "Terry Worker"), "partial filing must still refuse");
    // Filing every occurrence clears Terry — with NO per-request map — while
    // the unfiled second employee refuses with the identical message.
    await fileAbsence(fx, documentId, fx.employeeId, fx.employeeName, "ON", false);
    refusals = await absenceRefusals(documentId);
    assert.ok(!refusals.some((e) => e.employee === "Terry Worker"), JSON.stringify(refusals));
    assert.ok(refusals.some((e) => e.employee === "Second Worker"), JSON.stringify(refusals));
    void secondId;
    // Recalculate bare a second time: the assertion survived, Terry holds.
    refusals = await absenceRefusals(documentId);
    assert.ok(!refusals.some((e) => e.employee === "Terry Worker"), JSON.stringify(refusals));
    assert.ok(refusals.some((e) => e.employee === "Second Worker"), JSON.stringify(refusals));
    // A newly filed answer after Calculate marks the run stale, so commit
    // refuses until the recalculation that reads it.
    await fileAbsence(fx, documentId, fx.employeeId, fx.employeeName, "ON", true);
    const staleness = await withBypassContext(() => payRunStaleness(fx.orgId, documentId, db));
    assert.equal(staleness.stale, true);
    assert.ok(staleness.reasons.includes("adjustments"), JSON.stringify(staleness.reasons));
  } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
});

test("the per-request map overrides stored absence answers", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await withBypassContext(() => seedAdoption());
  try {
    state.gate = runGate(fx);
    const { documentId } = await christmasRun(fx);
    // Hours worked ON the holiday itself: a QUALIFIED holiday earns the
    // premium for them, a denied one earns nothing. (The lookback reads
    // committed stubs, not time entries, so same-period hours cannot move
    // the day's pay — but the premium for working the day is current-period
    // money and distinguishes the arms.)
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into time_entries (org_id, employee_party_id, worked_on, hours, status,
          is_billable, billing_status, costing_basis, created_by, updated_by)
        values (${fx.orgId}, ${fx.employeeId}, '2025-12-25', 8, 'approved', false,
          'unbilled', 'actual', ${fx.actorId}, ${fx.actorId})`);
    });
    // Stored TRUE disqualifies: no refusal, but no premium either.
    await fileAbsence(fx, documentId, fx.employeeId, fx.employeeName, "ON", true);
    let res = await calculate(documentId, { action: "calculate" });
    assert.equal(res.status, 200);
    let body = await res.json() as { ok: boolean; errors: unknown[] };
    assert.equal(body.ok, true);
    assert.deepEqual(body.errors, []);
    const denied = await withBypassContext(async () => (await db.execute<{ total: string }>(sql`
      select coalesce(sum(l.amount), 0)::text as total
        from pay_stub_lines l
        join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
        join pay_components c on c.id = l.component_id and c.org_id = l.org_id
       where s.org_id = ${fx.orgId} and s.pay_run_document_id = ${documentId}
         and s.employee_party_id = ${fx.employeeId}
         and c.system_key = 'stat_holiday_premium'`)).rows[0]!.total);
    assert.equal(Number(denied), 0);
    // The same request with an explicit per-request FALSE wins: the premium is paid.
    res = await calculate(documentId, {
      action: "calculate",
      holidayEligibility: { [fx.employeeId]: { absentWithoutConsent: false } },
    });
    assert.equal(res.status, 200);
    body = await res.json() as { ok: boolean; errors: unknown[] };
    assert.deepEqual(body.errors, []);
    const paid = await withBypassContext(async () => (await db.execute<{ total: string }>(sql`
      select coalesce(sum(l.amount), 0)::text as total
        from pay_stub_lines l
        join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
        join pay_components c on c.id = l.component_id and c.org_id = l.org_id
       where s.org_id = ${fx.orgId} and s.pay_run_document_id = ${documentId}
         and s.employee_party_id = ${fx.employeeId}
         and c.system_key = 'stat_holiday_premium'`)).rows[0]!.total);
    assert.ok(Number(paid) > 0, `expected the worked-holiday premium, got ${paid}`);
  } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
});

/**
 * The split's whole point: commission status is answered ONCE on the
 * employee. A Quebec employee refused for it in December must not re-refuse
 * for it in June — while the per-run absence assertion correctly re-refuses
 * in the new period.
 */
test("commission status answered once clears later periods without re-answering", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await withBypassContext(() => seedAdoption());
  try {
    state.gate = runGate(fx);
    const quebecId = await addEmployee(fx, "Quinn Quebec", "QC");
    // A QC employer always owes the health services fund, so a live-but-
    // unconfigured ca_hsf slot refuses that employee by name before any
    // commission question is reached. That refusal is correct and belongs to
    // its own suite; configure the rate here so this test observes the thing
    // it is actually about.
    await withBypassContext(() => db.execute(sql`
      insert into payroll_statutory_rates (org_id, country, rate_key, region, tax_year,
                                           rate_values, created_by, updated_by)
      values (${fx.orgId}, 'CA', 'ca_hsf', 'QC', 2026, '{"rate": "1.65"}',
              ${fx.actorId}, ${fx.actorId})`));
    const { documentId } = await christmasRun(fx);
    const commissionRefusals = async (id: string) => {
      const res = await calculate(id, { action: "calculate" });
      assert.equal(res.status, 200);
      const body = await res.json() as { errors: { employee: string; message: string }[] };
      return body.errors;
    };
    let errors = await commissionRefusals(documentId);
    assert.ok(
      errors.some((e) => e.employee === "Quinn Quebec" && e.message.includes("commission-pay status")),
      `expected the commission demand, got ${JSON.stringify(errors)}`,
    );
    // Answer once, on the employee.
    await withBypassContext(() => db.execute(sql`
      update employee_payroll_profiles set paid_on_commission = false
       where org_id = ${fx.orgId} and employee_party_id = ${quebecId}`));
    errors = await commissionRefusals(documentId);
    assert.ok(
      !errors.some((e) => e.employee === "Quinn Quebec" && e.message.includes("commission-pay status")),
      JSON.stringify(errors),
    );
    // A LATER period containing a later holiday: recalculated bare, the
    // commission demand stays answered while the new period's absence
    // assertion correctly refuses again.
    const later = await withBypassContext(() => createPayRun({
      orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
      periodStart: "2026-06-14", periodEnd: "2026-06-27",
    }));
    errors = await commissionRefusals(later.documentId);
    assert.ok(
      errors.some((e) => e.employee === "Quinn Quebec" && e.message.includes("last-and-first-shift")),
      `expected the new period's absence demand, got ${JSON.stringify(errors)}`,
    );
    assert.ok(
      !errors.some((e) => e.employee === "Quinn Quebec" && e.message.includes("commission-pay status")),
      `commission must stay answered, got ${JSON.stringify(errors)}`,
    );
  } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
});

test("the assertions surface files explicitly and refuses to guess", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await withBypassContext(() => seedAdoption());
  try {
    state.gate = runGate(fx);
    const { documentId } = await christmasRun(fx);
    const post = async (body: Record<string, unknown>) => assertionsRoute.POST(
      new Request("https://openbooks.test/api/payroll/runs/fixture/holiday-assertions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: documentId }) },
    );
    const scoped = <T>(fn: () => Promise<T>): Promise<T> => {
      const gate = state.gate;
      assert.ok(gate, "scoped call requires an authenticated gate");
      return withOrgContext(gate.user.orgId, fn);
    };
    // Unknown employees are refused, not unattested.
    let res = await scoped(() => post({ employeePartyId: randomUUID(), absentWithoutConsent: false }));
    assert.equal(res.status, 422);
    // A named holiday that demands nothing here is refused.
    res = await scoped(() => post({
      employeePartyId: fx.employeeId, holidayKey: "nope", holidayDate: "2025-12-25",
      absentWithoutConsent: false,
    }));
    assert.equal(res.status, 422);
    // Several demanding occurrences and no identity: specify, don't guess.
    res = await scoped(() => post({ employeePartyId: fx.employeeId, absentWithoutConsent: false }));
    assert.equal(res.status, 422);
    assert.match((await res.json() as { error: string }).error, /specify which holiday/);
    // Explicit identity files.
    const demanding = await withBypassContext(() => demandingHolidays(db, {
      orgId: fx.orgId, country: "CA", province: "ON", labourJurisdiction: null,
      employeeName: fx.employeeName, periodStart: "2025-12-21", periodEnd: "2026-01-03",
    }));
    for (const holiday of demanding.filter((h) => h.needsAbsenceAssertion)) {
      res = await scoped(() => post({
        employeePartyId: fx.employeeId, holidayKey: holiday.key, holidayDate: holiday.date,
        absentWithoutConsent: false,
      }));
      assert.equal(res.status, 200, JSON.stringify(await res.clone().json()).slice(0, 300));
    }
    // Nothing to file is a request error, not a silent no-op.
    res = await scoped(() => post({ employeePartyId: fx.employeeId }));
    assert.equal(res.status, 422);
    // Filed rows are visible on the surface's GET.
    const gate = state.gate;
    assert.ok(gate);
    const got = await withOrgContext(gate.user.orgId, () => assertionsRoute.GET(
      new Request("https://openbooks.test/api/payroll/runs/fixture/holiday-assertions"),
      { params: Promise.resolve({ id: documentId }) },
    ));
    assert.equal(got.status, 200);
    const surface = await got.json() as {
      employees: { employeePartyId: string; assertions: { holidayKey: string }[] }[];
    };
    const terry = surface.employees.find((e) => e.employeePartyId === fx.employeeId);
    assert.ok(terry && terry.assertions.length > 0, JSON.stringify(surface.employees));
  } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
});

test("commission status round-trips through profiles and omit keeps", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await withBypassContext(() => seedAdoption());
  try {
    state.gate = runGate(fx);
    const gate = state.gate;
    assert.ok(gate);
    const scoped = <T>(fn: () => Promise<T>): Promise<T> => withOrgContext(gate.user.orgId, fn);
    const profileBody = {
      employeePartyId: fx.employeeId, payScheduleId: fx.scheduleId,
      country: "CA", province: "ON", payBasis: "hourly",
    };
    // Answer false.
    let res = await scoped(() => profilesRoute.POST(
      new Request("https://openbooks.test/api/payroll/profiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...profileBody, paidOnCommission: false }),
      }),
    ));
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()).slice(0, 300));
    let got = await scoped(() => profilesRoute.GET(
      new Request(`https://openbooks.test/api/payroll/profiles?employee=${fx.employeeId}`),
    ));
    assert.equal(got.status, 200);
    assert.equal(
      (await got.json() as { profile: { paid_on_commission: boolean | null } }).profile.paid_on_commission,
      false,
    );
    // A save silent on the fact keeps it.
    res = await scoped(() => profilesRoute.POST(
      new Request("https://openbooks.test/api/payroll/profiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(profileBody),
      }),
    ));
    assert.equal(res.status, 200);
    got = await scoped(() => profilesRoute.GET(
      new Request(`https://openbooks.test/api/payroll/profiles?employee=${fx.employeeId}`),
    ));
    assert.equal(
      (await got.json() as { profile: { paid_on_commission: boolean | null } }).profile.paid_on_commission,
      false,
    );
    // Explicit null un-answers.
    res = await scoped(() => profilesRoute.POST(
      new Request("https://openbooks.test/api/payroll/profiles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...profileBody, paidOnCommission: null }),
      }),
    ));
    assert.equal(res.status, 200);
    got = await scoped(() => profilesRoute.GET(
      new Request(`https://openbooks.test/api/payroll/profiles?employee=${fx.employeeId}`),
    ));
    assert.equal(
      (await got.json() as { profile: { paid_on_commission: boolean | null } }).profile.paid_on_commission,
      null,
    );
  } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
});
