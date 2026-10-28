import { before as initializeNativeComposition } from "node:test";

initializeNativeComposition(async () => {
  if (!process.env.OPENBOOKS_DB_URL) return;
  const { installEngineSeams } = await import("@openbooks/engine/composition/install");
  installEngineSeams();
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg, seedFlowActors, seedPayrollTime } =
  await import("@openbooks/engine/testing/fixtures");
const { seedAdoption } = await import("@openbooks/engine/testing/payroll/filing-test-fixtures");
const { executeAssistantTool } = await import("../assistant/registry");
const { applicationTool, executeApplicationTool } = await import("./tool-catalog.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;

const DB = !!process.env.OPENBOOKS_DB_URL;

function contextFor(orgId: string, userId: string, permissions: string[]): ApplicationContext {
  return {
    authz: {
      user: {
        id: userId,
        email: `${userId}@test`,
        name: "Payroll test user",
        orgId,
        roles: [{ key: "payroll-role", name: "Payroll role" }],
        envKind: "sandbox",
        productionOrgId: orgId,
        isSuperAdmin: false,
        homeUserId: userId,
        homeOrgId: orgId,
      },
      permissions: new Set(permissions),
      allowedSubsidiaryIds: null,
    },
    source: "api",
    requestId: randomUUID(),
    apiKeyId: null,
  };
}

test(
  "payroll profile and pay-run commands save, calculate, replay, and verify through payroll reads",
  { skip: !DB },
  async () => {
    const fixture = await withBypassContext(() => seedAdoption());
    try {
      const context = contextFor(fixture.orgId, fixture.actorId, [
        "assistant.use",
        "payroll.manage",
        "payroll.run",
        "payroll.read",
      ]);
      const run = (name: string, input: Record<string, unknown>) =>
        executeApplicationTool(applicationTool(name)!, context, input);

      const profileInput = {
        employeePartyId: fixture.employeeId,
        payScheduleId: fixture.scheduleId,
        country: "CA",
        province: "ON",
        payBasis: "hourly",
        federalClaimCode: 1,
        provincialClaimCode: 1,
        wcbExempt: true,
        wcbExemptReason: "Payroll command integration fixture coverage exemption",
        idempotencyKey: "payroll-profile-0001",
      };
      const profile = await run("save_employee_payroll_profile", profileInput);
      assert.equal(profile.replayed, false);
      assert.equal(profile.employeePartyId, fixture.employeeId);
      assert.equal(Object.hasOwn(profile, "sin"), false);
      const profileReplay = await run("save_employee_payroll_profile", profileInput);
      assert.equal(profileReplay.replayed, true);
      const employees = await withOrgContext(fixture.orgId, () =>
        executeAssistantTool(context.authz, "list_payroll_employees", {
          query: fixture.employeeName,
        }),
      );
      assert.equal(employees.ok, true, JSON.stringify(employees));
      assert.equal(employees.data.employees[0]?.employeePartyId, fixture.employeeId);
      assert.equal(Object.hasOwn(employees.data.employees[0]!, "sin"), false);

      await withBypassContext(() =>
        seedPayrollTime(fixture.orgId, fixture.employeeId, fixture.actorId, {
          workedOn: "2026-07-14",
          hours: "8",
          status: "approved",
          isBillable: false,
          billingStatus: "unbilled",
          costingBasis: "actual",
        }),
      );
      const createInput = {
        payScheduleId: fixture.scheduleId,
        periodStart: "2026-07-05",
        periodEnd: "2026-07-18",
        idempotencyKey: "payroll-run-create-0001",
      };
      const created = await run("create_pay_run", createInput);
      assert.equal(created.replayed, false);
      const documentId = String(created.documentId);
      const replay = await run("create_pay_run", createInput);
      assert.equal(replay.replayed, true);
      assert.equal(replay.documentId, documentId);

      await run("calculate_pay_run", { documentId, idempotencyKey: "payroll-run-calc-0001" });
      const detail = await withOrgContext(fixture.orgId, () =>
        executeAssistantTool(context.authz, "get_pay_run", { documentId }),
      );
      assert.equal(detail.ok, true);
      assert.equal(detail.data.run.documentId, documentId);
      assert.equal(detail.data.run.runStatus, "calculated");
    } finally {
      await withBypassContext(() => dropScratchOrg(fixture.orgId));
    }
  },
);

test(
  "payroll commands enforce permission and the organization feature gate",
  { skip: !DB },
  async () => {
    const fixture = await withBypassContext(() => seedAdoption());
    try {
      const denied = contextFor(fixture.orgId, fixture.actorId, []);
      await assert.rejects(
        executeApplicationTool(applicationTool("save_employee_payroll_profile")!, denied, {
          employeePartyId: fixture.employeeId,
          payScheduleId: fixture.scheduleId,
          country: "CA",
          province: "ON",
          payBasis: "hourly",
          idempotencyKey: "payroll-profile-denied",
        }),
        (error: unknown) => error instanceof Error && error.message === "forbidden",
      );

      await withBypassContext(() =>
        db.execute(sql`
          update orgs set settings = jsonb_set(settings, '{features,payroll}', 'false'::jsonb, true)
           where id = ${fixture.orgId}`),
      );
      const featureOff = contextFor(fixture.orgId, fixture.actorId, ["payroll.manage"]);
      await assert.rejects(
        executeApplicationTool(applicationTool("save_employee_payroll_profile")!, featureOff, {
          employeePartyId: fixture.employeeId,
          payScheduleId: fixture.scheduleId,
          country: "CA",
          province: "ON",
          payBasis: "hourly",
          idempotencyKey: "payroll-profile-feature-off",
        }),
        (error: unknown) => error instanceof Error && "status" in error && error.status === 404,
      );
    } finally {
      await withBypassContext(() => dropScratchOrg(fixture.orgId));
    }
  },
);

test("payroll profile writes cannot cross organization boundaries", { skip: !DB }, async () => {
  const fixture = await withBypassContext(() => seedAdoption());
  const otherOrg = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(otherOrg.orgId));
    const context = contextFor(otherOrg.orgId, actors.adminId, ["payroll.manage"]);
    await assert.rejects(
      executeApplicationTool(applicationTool("save_employee_payroll_profile")!, context, {
        employeePartyId: fixture.employeeId,
        payScheduleId: fixture.scheduleId,
        country: "CA",
        province: "ON",
        payBasis: "hourly",
        idempotencyKey: "payroll-profile-cross-org",
      }),
      (error: unknown) =>
        error instanceof Error &&
        "status" in error &&
        error.status === 422 &&
        error.message === "employee is not available",
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(otherOrg.orgId));
    await withBypassContext(() => dropScratchOrg(fixture.orgId));
  }
});
