import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { Authz } from "./authz";

const state: { gate: Authz | null } = { gate: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.payroll-run-action-scope")] = state;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "../../../../../lib/feature-gates" && decodeURIComponent(context.parentURL ?? "").endsWith("/api/payroll/runs/[id]/route.ts")) {
    return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
      "export async function guardFeaturePermission(){return globalThis[Symbol.for('openbooks.payroll-run-action-scope')].gate}") };
  }
  return next(specifier, context);
} });
const { sql } = await import("drizzle-orm");
const { db, pool, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { seedAdoption, calculatedRun } = await import("@openbooks/engine/src/payroll/filing-test-fixtures.ts");
const { dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { mutatePayRunAdjustment } = await import("@openbooks/engine/src/payroll/run-adjustments.ts");
const { GET, POST } = await import("../app/api/payroll/runs/[id]/route");

for (const action of ["add-adjustment", "delete-adjustment", "exclude-employee", "include-employee", "bulk-adjustment", "set-scope", "preview-gl", "calculate", "dry-run", "commit", "read", "read-adjustments"] as const) {
  test(`payroll ${action} refuses an inaccessible employee in a visible run`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const fx = await withBypassContext(() => seedAdoption());
    try {
      const childId = randomUUID();
      await withBypassContext(async () => {
        await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
          values(${childId},${fx.orgId},${fx.subsidiaryId},'Hidden payroll employer','CAD','CA')`);
        await db.execute(sql`update parties set subsidiary_id=${childId} where org_id=${fx.orgId} and id=${fx.employeeId}`);
      });
      const { input } = await withOrgContext(fx.orgId, () => calculatedRun(fx));
      const componentId = (await withOrgContext(fx.orgId, () => db.execute<{ id: string }>(sql`select id from pay_components where org_id=${fx.orgId} and system_key='base_pay' and kind='earning'`))).rows[0]!.id;
      let adjustmentId: string | undefined;
      if (action === "delete-adjustment" || action === "include-employee" || action === "read-adjustments") {
        await withOrgContext(fx.orgId, () => mutatePayRunAdjustment({ ...input, mutation: { action: "exclude", employeePartyId: fx.employeeId } }));
        adjustmentId = (await withOrgContext(fx.orgId, () => db.execute<{ id: string }>(sql`select id from pay_run_adjustments where org_id=${fx.orgId} and pay_run_document_id=${input.documentId}`))).rows[0]!.id;
      }
      state.gate = { user: { orgId: fx.orgId, id: fx.actorId }, permissions: new Set(["payroll.run"]), allowedSubsidiaryIds: new Set([fx.subsidiaryId]) } as Authz;
      const snapshot = async () => (await withOrgContext(fx.orgId, () => db.execute<{ state: unknown }>(sql`select jsonb_build_object(
        'run',(select to_jsonb(r) from pay_runs r where org_id=${fx.orgId} and document_id=${input.documentId}),
        'stubs',(select jsonb_agg(to_jsonb(s) order by id) from pay_stubs s where org_id=${fx.orgId}),
        'adjustments',(select jsonb_agg(to_jsonb(a) order by id) from pay_run_adjustments a where org_id=${fx.orgId})
        ) as state`))).rows[0]!.state;
      const before = await snapshot();
      const body = { action, employeePartyId: fx.employeeId, componentId, amount: "10", adjustmentId,
        employeePartyIds: action === "set-scope" ? [] : [fx.employeeId], rosterPartyIds: [fx.employeeId] };
      const read = action === "read" || action === "read-adjustments";
      // The mocked gate establishes authz but no connection scope; the route
      // reads through the ambient scope as the middleware provides.
      const send = () => withOrgContext(fx.orgId, () => (read ? GET : POST)(new Request("https://openbooks.test/api/payroll/runs/fixture", {
        method: read ? "GET" : "POST", headers: { "content-type": "application/json" }, ...(read ? {} : { body: JSON.stringify(body) }),
      }), { params: Promise.resolve({ id: input.documentId }) }));
      const response = await send();
      assert.equal(response.status, read ? 404 : 422, JSON.stringify(await response.json()));
      assert.deepEqual(await snapshot(), before, "refusal must preserve the complete run snapshot and adjustments");
      state.gate = { ...state.gate, allowedSubsidiaryIds: null };
      assert.equal((await send()).status, 200, "unrestricted payroll operations remain available");
    } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
  });
}

test("payroll detail rechecks employee ownership after a concurrent transfer", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await withBypassContext(() => seedAdoption());
  const writer = await pool.connect();
  let pending: Promise<Response> | undefined;
  try {
    await withBypassContext(() => db.execute(sql`update parties set subsidiary_id=${fx.subsidiaryId} where org_id=${fx.orgId} and id=${fx.employeeId}`));
    const { input } = await withOrgContext(fx.orgId, () => calculatedRun(fx));
    const childId = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
      values(${childId},${fx.orgId},${fx.subsidiaryId},'Transferred employer','CAD','CA')`));
    state.gate = { user: { orgId: fx.orgId, id: fx.actorId }, permissions: new Set(["payroll.read"]), allowedSubsidiaryIds: new Set([fx.subsidiaryId]) } as Authz;
    const read = () => withOrgContext(fx.orgId, () => GET(new Request("https://openbooks.test/api/payroll/runs/fixture"), { params: Promise.resolve({ id: input.documentId }) }));
    assert.equal((await read()).status, 200, "the scoped owner can read its own complete run");
    await writer.query("begin");
    await writer.query("select set_config('app.bypass_rls','on',true)");
    // Fixture write through the held transaction: it must stay uncommitted to
    // block the concurrent reader, so it cannot go through db.execute. The
    // raw session carries the bypass via set_config above; the scope is
    // declared here.
    const moved = await withBypassContext(() => writer.query("update parties set subsidiary_id=$1 where org_id=$2 and id=$3", [childId, fx.orgId, fx.employeeId]));
    assert.equal(moved.rowCount, 1, "concurrent writer must hold the transferred employee row");
    const pid = (await writer.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    pending = read(); void pending.catch(() => {});
    let blocked = false;
    for (let attempt = 0; attempt < 400; attempt++) {
      const row = (await pool.query<{ blocked: boolean }>("select exists(select 1 from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))) as blocked", [pid])).rows[0]!;
      if (row.blocked) { blocked = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(blocked, "detail must wait for the employee ownership write");
    await writer.query("commit");
    const response = await pending;
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not_found" });
    state.gate = { ...state.gate, allowedSubsidiaryIds: null };
    assert.equal((await read()).status, 200);
  } finally {
    await writer.query("rollback"); writer.release(); await pending?.catch(() => {});
    state.gate = null; await dropScratchOrgReporting(fx.orgId);
  }
});


const consolidatedRows = [
  { label: "payroll run holiday eligibility", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { registerHooks } = await import("node:module");
        const test = (await import("node:test")).default;
        type Authz = import("./authz").Authz;

        (globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.payroll-run-holiday-eligibility")] = state;
        // The route imports the JSON boundary through the web `@/` alias, which tsx
        // resolves only under the web tsconfig. Map it to the real module so the
        // route under test runs its production body parsing.
        const apiJsonUrl = new URL("./api/json.ts", import.meta.url).href;
        // Worktrees carry a real (copied) root node_modules, so engine imports
        // resolve inside this worktree already; only web-only shims need rewriting.
        registerHooks({ resolve(specifier, context, next) {
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
        const { dropScratchOrgReporting, seedWorkerEmployment } = await import("@openbooks/engine/src/testing/fixtures.ts");
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
            const addedEmploymentId = await seedWorkerEmployment(fx.orgId, id, fx.subsidiaryId);
            await db.execute(sql`
              insert into employee_payroll_profiles (org_id, employee_party_id, employment_id, pay_schedule_id,
                                                     province, pay_basis, country, federal_claim_code,
                                                     provincial_claim_code, vacation_percent, vacation_method,
                                                     is_active, created_by, updated_by)
              values (${fx.orgId}, ${id}, ${addedEmploymentId}, ${fx.scheduleId}, ${province}, 'hourly', 'CA', 1, 1,
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
            await addEmployee(fx, "Second Worker", "ON");
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
            // A QC employer always owes the health services fund, so an unclassified
            // ca_hsf slot refuses that employee by name before any
            // commission question is reached. That refusal is correct and belongs to
            // its own suite; classify the sector here so this test observes the thing
            // it is actually about.
            await withBypassContext(() => db.execute(sql`
              insert into payroll_statutory_rates (org_id, country, rate_key, region, tax_year,
                                                   rate_values, created_by, updated_by)
              values (${fx.orgId}, 'CA', 'ca_hsf', 'QC', 2026, '{"sectorOther": "true"}',
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
  } },
  { label: "payroll run set scope diff", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const { registerHooks } = await import("node:module");
        const test = (await import("node:test")).default;
        type Authz = import("./authz").Authz;

        (globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.payroll-run-set-scope-diff")] = state;
        registerHooks({ resolve(specifier, context, next) {
          if (specifier === "../../../../../lib/feature-gates" && decodeURIComponent(context.parentURL ?? "").endsWith("/api/payroll/runs/[id]/route.ts")) {
            return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
              "export async function guardFeaturePermission(){return globalThis[Symbol.for('openbooks.payroll-run-set-scope-diff')].gate}") };
          }
          return next(specifier, context);
        } });
        const { sql } = await import("drizzle-orm");
        const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
        const { createPayRun } = await import("@openbooks/engine/src/payroll/run-lifecycle.ts"), { seedPayrollComponents } = await import("@openbooks/engine/src/payroll/run-setup.ts");
        const { createScratchOrg, dropScratchOrgReporting, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
        const { POST } = await import("../app/api/payroll/runs/[id]/route");

        /**
         * set-scope against a roster holding a deactivated employee — the persona
         * replay for item 43 — plus the diff proof: members whose scope is not
         * changing are never re-validated and never rewritten.
         *
         * Real route, real engine, real database; only the feature gate is stubbed.
         */

        interface ScopeFixture {
          orgId: string;
          actorId: string;
          documentId: string;
          activeId: string;
          deactivatedId: string;
        }

        async function scopeFixture(): Promise<ScopeFixture> {
          const org = await createScratchOrg();
          const actorId = (await seedFlowActors(org.orgId)).adminId;
          await db.execute(sql`
            update orgs set settings = settings || ${JSON.stringify({
              features: { payroll: true },
            })}::jsonb where id = ${org.orgId}`);
          await seedPayrollComponents(org.orgId, actorId, "CA");
          const scheduleId = randomUUID();
          await db.execute(sql`
            insert into pay_schedules
              (id, org_id, name, frequency, periods_per_year, anchor_period_end,
               pay_date_offset_days, is_active, created_by, updated_by)
            values
              (${scheduleId}, ${org.orgId}, 'Scope Schedule', 'biweekly', 26, '2026-07-18',
               3, true, ${actorId}, ${actorId})
          `);
          const activeId = randomUUID();
          const deactivatedId = randomUUID();
          await db.execute(sql`
            insert into parties (id, org_id, kind, display_name, is_active, custom)
            values (${activeId}, ${org.orgId}, 'person', 'Scope Active', true, '{}'::jsonb),
                   (${deactivatedId}, ${org.orgId}, 'person', 'Scope Deactivated', true, '{}'::jsonb)
          `);
          await db.execute(sql`
            insert into employee_payroll_profiles
              (org_id, employee_party_id, pay_schedule_id, country, province, pay_basis,
               federal_claim_code, provincial_claim_code, is_active, created_by, updated_by)
            values
              (${org.orgId}, ${activeId}, ${scheduleId}, 'CA', 'ON', 'salary', 1, 1, true, ${actorId}, ${actorId}),
              (${org.orgId}, ${deactivatedId}, ${scheduleId}, 'CA', 'ON', 'salary', 1, 1, true, ${actorId}, ${actorId})
          `);
          const run = await createPayRun({
            orgId: org.orgId,
            actorId,
            payScheduleId: scheduleId,
            periodStart: "2026-07-05",
            periodEnd: "2026-07-18",
          });
          return { orgId: org.orgId, actorId, documentId: run.documentId, activeId, deactivatedId };
        }

        async function deactivate(orgId: string, employeeId: string): Promise<void> {
          // Actions → Deactivate, the product's own supported remedy.
          await withBypassContext(() => db.execute(sql`
            update parties set is_active = false where org_id = ${orgId} and id = ${employeeId}`));
        }

        async function adjustmentSnapshot(orgId: string, documentId: string): Promise<unknown> {
          return (await withOrgContext(orgId, () => db.execute<{ state: unknown }>(sql`select jsonb_build_object(
            'run',(select to_jsonb(r) from pay_runs r where org_id=${orgId} and document_id=${documentId}),
            'adjustments',(select jsonb_agg(to_jsonb(a) order by employee_party_id, adjustment_type)
                             from pay_run_adjustments a where org_id=${orgId} and pay_run_document_id=${documentId})
            ) as state`))).rows[0]!.state;
        }

        function send(fx: Pick<ScopeFixture, "orgId" | "documentId">, body: Record<string, unknown>): Promise<Response> {
          return withOrgContext(fx.orgId, () => POST(new Request("https://openbooks.test/api/payroll/runs/fixture", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
          }), { params: Promise.resolve({ id: fx.documentId }) }));
        }

        async function setup(): Promise<ScopeFixture> {
          const fx = await withBypassContext(() => scopeFixture());
          state.gate = {
            user: { orgId: fx.orgId, id: fx.actorId },
            permissions: new Set(["payroll.run"]),
            allowedSubsidiaryIds: null,
          } as Authz;
          return fx;
        }

        test("set-scope removes a deactivated roster member instead of rolling back 422", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const fx = await setup();
          try {
            await deactivate(fx.orgId, fx.deactivatedId);
            const response = await send(fx, {
              action: "set-scope",
              employeePartyIds: [fx.activeId],
              rosterPartyIds: [fx.activeId, fx.deactivatedId],
            });
            assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
            // True deltas: the active member stays (no change), the deactivated one
            // is newly excluded — not an echo of the input lists.
            assert.deepEqual(await response.json(), { ok: true, included: 0, excluded: 1 });
            const excluded = await withOrgContext(fx.orgId, () => db.execute<{ employee_party_id: string }>(sql`
              select employee_party_id from pay_run_adjustments
               where org_id = ${fx.orgId} and pay_run_document_id = ${fx.documentId}
                 and adjustment_type = 'exclude'`));
            assert.deepEqual(excluded.rows, [{ employee_party_id: fx.deactivatedId }]);
          } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
        });

        test("set-scope still refuses to re-add a deactivated member, naming them", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const fx = await setup();
          try {
            await deactivate(fx.orgId, fx.deactivatedId);
            // First remove them (the newly permitted direction), so re-adding is an
            // actual change the mutator must validate.
            const removed = await send(fx, {
              action: "set-scope",
              employeePartyIds: [fx.activeId],
              rosterPartyIds: [fx.activeId, fx.deactivatedId],
            });
            assert.equal(removed.status, 200);
            const before = await adjustmentSnapshot(fx.orgId, fx.documentId);
            const response = await send(fx, {
              action: "set-scope",
              employeePartyIds: [fx.activeId, fx.deactivatedId],
              rosterPartyIds: [fx.activeId, fx.deactivatedId],
            });
            assert.equal(response.status, 422);
            const body = (await response.json()) as { error: string };
            assert.match(body.error, /employee "Scope Deactivated" is not an active member/);
            assert.match(body.error, /deactivated/);
            assert.deepEqual(await adjustmentSnapshot(fx.orgId, fx.documentId), before, "refusal must commit nothing");
          } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
        });

        test("set-scope replays nothing when the requested scope already holds", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const fx = await setup();
          try {
            await deactivate(fx.orgId, fx.deactivatedId);
            const first = await send(fx, {
              action: "set-scope",
              employeePartyIds: [fx.activeId],
              rosterPartyIds: [fx.activeId, fx.deactivatedId],
            });
            assert.equal(first.status, 200);
            const before = await adjustmentSnapshot(fx.orgId, fx.documentId);
            // Identical request: both members are staying where they are, so no
            // mutation runs — the deactivated member is never re-validated.
            const second = await send(fx, {
              action: "set-scope",
              employeePartyIds: [fx.activeId],
              rosterPartyIds: [fx.activeId, fx.deactivatedId],
            });
            assert.equal(second.status, 200);
            assert.deepEqual(await second.json(), { ok: true, included: 0, excluded: 0 });
            assert.deepEqual(await adjustmentSnapshot(fx.orgId, fx.documentId), before, "a no-change scope must write nothing");
          } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
        });

        test("set-scope on an empty roster is a no-op", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const fx = await setup();
          try {
            const response = await send(fx, { action: "set-scope", employeePartyIds: [], rosterPartyIds: [] });
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), { ok: true, included: 0, excluded: 0 });
          } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
        });

        test("set-scope reports true deltas, and an off-roster keep id is refused by name", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          // The input-echo defect: the response counted the request lists
          // ({included: keep.size}), so a roster of 10 with 3 already excluded and a
          // keep of 5 reported {included: 5, excluded: 5} while only 2 memberships
          // changed — and keep ids that are not on the roster at all were counted as
          // included although nothing was written for them.
          const org = await withBypassContext(() => createScratchOrg());
          const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
          const fx = await withBypassContext(async () => {
            await db.execute(sql`
              update orgs set settings = settings || ${JSON.stringify({ features: { payroll: true } })}::jsonb
               where id = ${org.orgId}`);
            await seedPayrollComponents(org.orgId, actorId, "CA");
            const scheduleId = randomUUID();
            await db.execute(sql`
              insert into pay_schedules
                (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                 pay_date_offset_days, is_active, created_by, updated_by)
              values
                (${scheduleId}, ${org.orgId}, 'Scope Schedule', 'biweekly', 26, '2026-07-18',
                 3, true, ${actorId}, ${actorId})`);
            const ids: string[] = [];
            for (let n = 0; n < 10; n++) {
              const id = randomUUID();
              ids.push(id);
              await db.execute(sql`
                insert into parties (id, org_id, kind, display_name, is_active, custom)
                values (${id}, ${org.orgId}, 'person', ${`Scope ${n}`}, true, '{}'::jsonb)`);
              await db.execute(sql`
                insert into employee_payroll_profiles
                  (org_id, employee_party_id, pay_schedule_id, country, province, pay_basis,
                   federal_claim_code, provincial_claim_code, is_active, created_by, updated_by)
                values
                  (${org.orgId}, ${id}, ${scheduleId}, 'CA', 'ON', 'salary', 1, 1, true, ${actorId}, ${actorId})`);
            }
            const run = await createPayRun({
              orgId: org.orgId, actorId, payScheduleId: scheduleId,
              periodStart: "2026-07-05", periodEnd: "2026-07-18",
            });
            return { orgId: org.orgId, actorId, documentId: run.documentId, roster: ids };
          });
          state.gate = {
            user: { orgId: fx.orgId, id: fx.actorId },
            permissions: new Set(["payroll.run"]),
            allowedSubsidiaryIds: null,
          } as Authz;
          try {
            // Three already excluded: only memberships that actually change count.
            const seed = await send(fx, {
              action: "set-scope",
              employeePartyIds: fx.roster.slice(3),
              rosterPartyIds: fx.roster,
            });
            assert.equal(seed.status, 200);
            assert.deepEqual(await seed.json(), { ok: true, included: 0, excluded: 3 });
            // Keep 5 of the 7 included: exactly 2 memberships change.
            const response = await send(fx, {
              action: "set-scope",
              employeePartyIds: fx.roster.slice(3, 8),
              rosterPartyIds: fx.roster,
            });
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), { ok: true, included: 0, excluded: 2 });

            // A keep id that is not on the roster is refused naming it — it used to
            // be counted as included while nothing was written for it.
            const stranger = randomUUID();
            const refused = await send(fx, {
              action: "set-scope",
              employeePartyIds: [...fx.roster.slice(3, 8), stranger],
              rosterPartyIds: fx.roster,
            });
            assert.equal(refused.status, 422);
            const body = (await refused.json()) as { error: string };
            assert.ok(body.error.includes(stranger), "the refusal names the off-roster id");
            assert.match(body.error, /not on this run's roster/);
          } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
        });
  } },
] as const;

for (const row of consolidatedRows) await row.register();


const payrollRunRouteCases = [
  { label: "payroll bank file scope", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const { registerHooks } = await import("node:module");
        const test = (await import("node:test")).default;
        type Authz = import("./authz").Authz;
        const state: { gate: Authz | null } = { gate: null };
        (globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.payroll-bank-file-scope")] = state;
        // The route imports the JSON boundary through the web `@/` alias, which tsx
        // resolves only under the web tsconfig. Map it to the real module so the
        // route under test runs its production body parsing.
        const apiJsonUrl = new URL("./api/json.ts", import.meta.url).href;
        // Worktrees symlink node_modules (and web/node_modules) at the main
        // checkout, so a bare `@openbooks/engine/...` import inside web code
        // resolves to the MAIN checkout's engine — the behaviour under test would
        // be main's, not this worktree's, and `instanceof` checks would span two
        // module instances. Rewrite every main-checkout source URL to this
        // worktree so the route and the engine it calls are one codebase.
        // (Symlinked node_modules paths rewrite onto themselves and are harmless.)
        const MAIN_ROOT_URL = "file:///Users/braedonsaunders/Documents/openbooks/";
        const WORKTREE_ROOT_URL = new URL("../../", import.meta.url).href;
        registerHooks({ resolve(specifier, context, next) {
          if (specifier === "@/lib/api/json") return { shortCircuit: true, url: apiJsonUrl };
          if (specifier === "../../../../../../lib/feature-gates" && decodeURIComponent(context.parentURL ?? "").endsWith("/api/payroll/runs/[id]/bank-file/route.ts")) {
            return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
              "export async function guardFeaturePermission(){return globalThis[Symbol.for('openbooks.payroll-bank-file-scope')].gate}") };
          }
          const resolved = next(specifier, context);
          const rewrite = (url: string) =>
            url.startsWith(MAIN_ROOT_URL) ? WORKTREE_ROOT_URL + url.slice(MAIN_ROOT_URL.length) : url;
          if (resolved.url.startsWith(MAIN_ROOT_URL)) {
            return { url: rewrite(resolved.url), shortCircuit: true };
          }
          return resolved;
        } });
        const { sql } = await import("drizzle-orm");
        const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
        const { seedAdoption, calculatedRun } = await import("@openbooks/engine/src/payroll/filing-test-fixtures.ts");
        const { commitPayRun } = await import("@openbooks/engine/src/payroll/run-commit.ts");
        const { dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
        const { GET, POST } = await import("../app/api/payroll/runs/[id]/bank-file/route");

        /**
         * The bank-file panel and generator enforce the run-population scope the
         * run detail and every other run action enforce: a run whose legal entity
         * is visible but which carries an employee outside the caller's subsidiary
         * scope is opaque — its panel is a 404 and generating its file is refused.
         */
        async function opaqueFixture() {
          const fx = await withBypassContext(() => seedAdoption());
          await withBypassContext(() => db.execute(sql`update parties set subsidiary_id = ${fx.subsidiaryId}
            where org_id = ${fx.orgId} and id = ${fx.employeeId}`));
          const { input } = await withBypassContext(() => calculatedRun(fx));
          await withOrgContext(fx.orgId, () => commitPayRun(input));
          const hidden = randomUUID();
          await withBypassContext(() => db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
            values (${hidden}, ${fx.orgId}, ${fx.subsidiaryId}, 'Hidden payroll employer', 'CAD', 'CA')`));
          await withBypassContext(() => db.execute(sql`update parties set subsidiary_id = ${hidden}
            where org_id = ${fx.orgId} and id = ${fx.employeeId}`));
          return { fx, documentId: input.documentId };
        }

        function scopedGate(fx: { orgId: string; actorId: string; subsidiaryId: string }, permission: string): Authz {
          return {
            user: { orgId: fx.orgId, id: fx.actorId },
            permissions: new Set([permission]),
            allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
          } as Authz;
        }

        test("bank-file panel hides a run carrying an out-of-scope employee", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const { fx, documentId } = await opaqueFixture();
          try {
            state.gate = scopedGate(fx, "payroll.read");
            const refused = await withOrgContext(fx.orgId, () => GET(
              new Request("https://openbooks.test/api/payroll/runs/fixture/bank-file"),
              { params: Promise.resolve({ id: documentId }) },
            ));
            assert.equal(refused.status, 404, JSON.stringify(await refused.clone().json()));
            assert.deepEqual(await refused.json(), { error: "not_found" });

            state.gate = { ...scopedGate(fx, "payroll.read"), allowedSubsidiaryIds: null };
            const visible = await withOrgContext(fx.orgId, () => GET(
              new Request("https://openbooks.test/api/payroll/runs/fixture/bank-file"),
              { params: Promise.resolve({ id: documentId }) },
            ));
            assert.equal(visible.status, 200, JSON.stringify(await visible.clone().json()).slice(0, 300));
          } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
        });

        test("bank-file generate refuses a run carrying an out-of-scope employee", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const { fx, documentId } = await opaqueFixture();
          try {
            state.gate = scopedGate(fx, "payroll.run");
            const refused = await withOrgContext(fx.orgId, () => POST(
              new Request("https://openbooks.test/api/payroll/runs/fixture/bank-file", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ paymentBankProfileId: randomUUID() }),
              }),
              { params: Promise.resolve({ id: documentId }) },
            ));
            assert.equal(refused.status, 409, JSON.stringify(await refused.clone().json()));
            assert.match(String((await refused.json() as { error: string }).error), /pay run not found/);
            const artifacts = (await withOrgContext(fx.orgId, () => db.execute<{ count: string }>(sql`
              select count(*) as count from pay_run_bank_files
               where org_id = ${fx.orgId} and pay_run_document_id = ${documentId}`))).rows[0]!.count;
            assert.equal(artifacts, "0", "a refused generate must not leave a bank-file artifact behind");
          } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
        });
  } },
  { label: "payroll create picker scope", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const { registerHooks } = await import("node:module");
        const { resolveAppModule } = await import('./test-module-hooks');
        const { pathToFileURL } = await import('node:url');
        const test = (await import("node:test")).default;
        const React = await import("react");
        type Authz = import("./authz").Authz;
        type FinalPayCandidate = import("../app/(app)/payroll/_ui/NewRunButton").FinalPayCandidate;
        type RunSchedule = import("../app/(app)/payroll/_ui/NewRunButton").RunSchedule;
        const { stubModules } = await import('../testing/stub-modules.ts');
        const root = pathToFileURL(process.cwd() + '/').href;
        // The tsx runner compiles these RSC sources with the CLASSIC JSX transform,
        // which emits bare `React.createElement`. Next supplies the automatic runtime
        // in production; the global is the equivalent here. Needed because importing a
        // page now reaches the shared widget registry, and those components are JSX.
        Object.assign(globalThis, { React });
        const state: { gate: Authz | null } = { gate: null };
        (globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.payroll-create-picker-scope")] = state;
        stubModules({ intl: true, navigation: false, authz: false, features: false });

        registerHooks({ resolve(specifier, context, next) {
          const parent = decodeURIComponent(context.parentURL ?? "");
          const virtual = (source: string) => ({ shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(source) });
          // A page is its `page.tsx` AND its `view.ts`: the loader these stubs were
          // written against now lives in the sibling module.
          if (parent.endsWith("/payroll/runs/page.tsx") || parent.endsWith("/payroll/runs/view.ts")) {
            if (specifier.endsWith("/lib/authz")) return virtual(
              "export async function requirePermission(){return globalThis[Symbol.for('openbooks.payroll-create-picker-scope')].gate};export function can(){return true}");
            if (specifier.endsWith("/module-home/group-tabs")) return virtual("export async function groupTabs(){return []}");
            if (specifier.endsWith("/record-list-view")) return virtual("export function RecordListView(){return null}");
            if (specifier.endsWith("/_ui/NewRunButton")) return virtual("export function NewRunButton(){return null}");
          }
          const app = resolveAppModule(specifier, context, next, root)
          if (app) return app
          return next(specifier, context);
        } });
        const { sql } = await import("drizzle-orm");
        const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
        const { seedAdoption } = await import("@openbooks/engine/src/payroll/filing-test-fixtures.ts");
        const { dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
        const { listApplicationPayrollEmployees } = await import("./application/payroll-read.ts");
        const { ApplicationError } = await import("./application/errors.ts");
        type ApplicationContext = import("./application/context.ts").ApplicationContext;
        // The page LOADER. What this test checks is which schedules and which
        // final-pay candidates the page's queries return for a given subsidiary scope,
        // and that is decided in the loader — the spec only names where the resolved
        // rows are bound. Hunting the rendered tree for NewRunButton's props stopped
        // working when `ModuleView` became the single render path, and was always a
        // detour: `newRun` IS the props object the button receives.
        const { loadPayRuns } = await import("../app/(app)/payroll/runs/view");

        type PickerProps = { schedules: RunSchedule[]; finalPayCandidates: FinalPayCandidate[] };

        for (const surface of ["employee", "schedule"] as const) {
          test(`payroll creation ${surface} picker scopes server-rendered data`, async () => {
            const fx = await withBypassContext(() => seedAdoption());
            try {
              const childId = randomUUID();
              const childScheduleId = randomUUID();
              await withBypassContext(async () => {
                await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
                  values(${childId},${fx.orgId},${fx.subsidiaryId},'Hidden picker owner','CAD','CA')`);
                await db.execute(sql`update parties set subsidiary_id=${childId} where org_id=${fx.orgId} and id=${fx.employeeId}`);
                await db.execute(sql`update employee_roles set terminated_on='2026-07-18' where org_id=${fx.orgId} and party_id=${fx.employeeId}`);
                await db.execute(sql`insert into pay_schedules(id,org_id,name,frequency,periods_per_year,anchor_period_end,pay_date_offset_days,subsidiary_id,is_active)
                  select ${childScheduleId},org_id,'Hidden schedule',frequency,periods_per_year,anchor_period_end,pay_date_offset_days,${childId},true
                  from pay_schedules where org_id=${fx.orgId} and id=${fx.scheduleId}`);
                await db.execute(sql`update employee_payroll_profiles set pay_schedule_id=${childScheduleId} where org_id=${fx.orgId} and employee_party_id=${fx.employeeId}`);
                await db.execute(sql`update employee_payroll_profiles
                  set sin_encrypted='SEALED-PAYROLL-SIN-TEST-SENTINEL', sin_last3='789',
                      federal_claim_amount='123456789012345.6789', additional_tax_per_period='9876.5432'
                  where org_id=${fx.orgId} and employee_party_id=${fx.employeeId}`);
                await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"payroll":true}'::jsonb) where id=${fx.orgId}`);
              });
              const gate = { user: { orgId: fx.orgId, id: fx.actorId }, permissions: new Set(["payroll.read", "payroll.run"]) } as Authz;
              const read = async (scope: Set<string> | null, scheduleIds: string[], employeeVisible: boolean) => {
                state.gate = { ...gate, allowedSubsidiaryIds: scope };
                const props = (await withOrgContext(fx.orgId, () => loadPayRuns({}))).newRun as PickerProps;
                assert.ok(props);
                const appContext: ApplicationContext = {
                  authz: { ...gate, permissions: new Set(["payroll.manage"]), allowedSubsidiaryIds: scope },
                  source: "api",
                  requestId: randomUUID(),
                  apiKeyId: null,
                };
                const payrollEmployees = await withOrgContext(fx.orgId, () =>
                  listApplicationPayrollEmployees(appContext, {}));
                assert.deepEqual(
                  payrollEmployees.employees.map((employee) => employee.employeePartyId),
                  employeeVisible ? [fx.employeeId] : [],
                );
                if (employeeVisible) {
                  const employee = payrollEmployees.employees[0]!;
                  assert.equal(employee.name, fx.employeeName);
                  assert.equal(employee.scheduleName, "Hidden schedule");
                  assert.equal("sinLast3" in employee, false);
                  assert.equal("federalClaimAmount" in employee, false);
                  assert.equal(JSON.stringify(employee).includes("SEALED-PAYROLL-SIN-TEST-SENTINEL"), false);
                }
                if (surface === "schedule") assert.deepEqual(new Set(props.schedules.map((row) => row.id)), new Set(scheduleIds));
                else assert.deepEqual(props.finalPayCandidates, employeeVisible ? [{
                  id: fx.employeeId, name: fx.employeeName, pay_schedule_id: childScheduleId, terminated_on: "2026-07-18",
                }] : []);
              };
              await read(new Set([fx.subsidiaryId]), [fx.scheduleId], false);
              await read(new Set(), [], false);
              await read(new Set([childId]), [childScheduleId], true);
              await read(new Set([fx.subsidiaryId, childId]), [fx.scheduleId, childScheduleId], true);
              await read(null, [fx.scheduleId, childScheduleId], true);
            } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
          });
        }

        test("application payroll employee reads name the Features-page remedy when payroll is off", async () => {
          const fx = await withBypassContext(() => seedAdoption());
          try {
            await withBypassContext(() => db.execute(sql`
              update orgs set settings=jsonb_set(settings,'{features}',
                coalesce(settings->'features','{}'::jsonb)||'{"payroll":false}'::jsonb,true)
               where id=${fx.orgId}`));
            const context: ApplicationContext = {
              authz: {
                user: { orgId: fx.orgId, id: fx.actorId } as ApplicationContext["authz"]["user"],
                permissions: new Set(["payroll.manage"]),
                allowedSubsidiaryIds: null,
              },
              source: "api",
              requestId: randomUUID(),
              apiKeyId: null,
            };
            await withOrgContext(fx.orgId, () => assert.rejects(
              listApplicationPayrollEmployees(context, {}),
              (error: unknown) => error instanceof ApplicationError
                && error.code === "not_found"
                && error.status === 404
                && error.message === "payroll is off; enable it from GET /api/v1/settings/features",
            ));
          } finally {
            state.gate = null;
            await dropScratchOrgReporting(fx.orgId);
          }
        });
  } },
  { label: "payroll retro route", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { registerHooks } = await import("node:module");
        const test = (await import("node:test")).default;
        type Authz = import("./authz").Authz;
        const state: { gate: Authz | null } = { gate: null };
        (globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.payroll-retro-route")] = state;
        // The route imports the JSON boundary through the web `@/` alias, which tsx
        // resolves only under the web tsconfig. Map it to the real module so the
        // route under test runs its production body parsing.
        const apiJsonUrl = new URL("./api/json.ts", import.meta.url).href;
        registerHooks({ resolve(specifier, context, next) {
          if (specifier === "@/lib/api/json") return { shortCircuit: true, url: apiJsonUrl };
          if (specifier === "../../../../lib/feature-gates" && decodeURIComponent(context.parentURL ?? "").endsWith("/api/payroll/retro/route.ts")) {
            return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
              "export async function guardFeaturePermission(){return globalThis[Symbol.for('openbooks.payroll-retro-route')].gate}") };
          }
          return next(specifier, context);
        } });
        const { seedAdoption } = await import("@openbooks/engine/src/payroll/filing-test-fixtures.ts");
        const { dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
        const { withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
        const { POST } = await import("../app/api/payroll/retro/route");

        /**
         * The retro workspace always sends `excludeSourcePayRunDocumentIds: []`
         * (its initial exclusion state), so the route must read an empty list as
         * "nothing excluded" — the same as an absent key. Refusing [] with 422
         * breaks every UI propose that excludes nothing, which is nearly all of
         * them. Same for an explicitly empty employeePartyIds.
         */

        function runGate(fx: { orgId: string; actorId: string }): Authz {
          return {
            user: { orgId: fx.orgId, id: fx.actorId },
            permissions: new Set(["payroll.run"]),
            allowedSubsidiaryIds: null,
          } as Authz;
        }

        async function propose(body: Record<string, unknown>) {
          return POST(
            new Request("https://openbooks.test/api/payroll/retro", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
          );
        }

        test("propose accepts an explicitly empty exclusion list", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const fx = await withBypassContext(() => seedAdoption());
          try {
            state.gate = runGate(fx);
            // The route reads schedules/runs through RLS; the mocked gate only
            // supplies identity, so run the call under the org scope the real
            // middleware would set.
            const res = await withOrgContext(fx.orgId, () => propose({
              action: "propose",
              payScheduleId: fx.scheduleId,
              payDate: "2026-07-21",
              excludeSourcePayRunDocumentIds: [],
            }));
            assert.equal(res.status, 200, JSON.stringify(await res.clone().json()).slice(0, 300));
            const body = await res.json() as { payableTotal: string };
            assert.equal(body.payableTotal, "0.0000");
          } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
        });

        test("propose still refuses malformed lists", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const fx = await withBypassContext(() => seedAdoption());
          try {
            state.gate = runGate(fx);
            for (const body of [
              { action: "propose", payScheduleId: fx.scheduleId, payDate: "2026-07-21", excludeSourcePayRunDocumentIds: ["nope"] },
              { action: "propose", payScheduleId: fx.scheduleId, payDate: "2026-07-21", excludeSourcePayRunDocumentIds: "nope" },
              { action: "propose", payScheduleId: fx.scheduleId, payDate: "2026-07-21", employeePartyIds: ["nope"] },
            ]) {
              const res = await propose(body);
              assert.equal(res.status, 422, JSON.stringify(await res.clone().json()).slice(0, 200));
            }
          } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
        });

        test("propose accepts an explicitly empty employee list", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const fx = await withBypassContext(() => seedAdoption());
          try {
            state.gate = runGate(fx);
            const res = await withOrgContext(fx.orgId, () => propose({
              action: "propose",
              payScheduleId: fx.scheduleId,
              payDate: "2026-07-21",
              employeePartyIds: [],
            }));
            assert.equal(res.status, 200, JSON.stringify(await res.clone().json()).slice(0, 300));
          } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
        });
  } },
] as const;

for (const row of payrollRunRouteCases) await row.register();
