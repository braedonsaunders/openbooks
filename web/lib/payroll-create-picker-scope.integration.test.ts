import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { resolveAppModule } from './test-module-hooks'
import { pathToFileURL } from 'node:url'
import test from "node:test";
import * as React from "react";
import type { Authz } from "./authz";
import type { FinalPayCandidate, RunSchedule } from "../app/(app)/payroll/_ui/NewRunButton";

const root = pathToFileURL(process.cwd() + '/').href;
// The tsx runner compiles these RSC sources with the CLASSIC JSX transform,
// which emits bare `React.createElement`. Next supplies the automatic runtime
// in production; the global is the equivalent here. Needed because importing a
// page now reaches the shared widget registry, and those components are JSX.
Object.assign(globalThis, { React });
const state: { gate: Authz | null } = { gate: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.payroll-create-picker-scope")] = state;
registerHooks({ resolve(specifier, context, next) {
  const parent = decodeURIComponent(context.parentURL ?? "");
  const virtual = (source: string) => ({ shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(source) });
  if (specifier === "server-only") return virtual("export {}");
  if (specifier === "next-intl/server") return virtual("export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}");
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
