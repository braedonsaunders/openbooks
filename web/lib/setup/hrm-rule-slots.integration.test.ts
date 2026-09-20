import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

/**
 * The rule-slot half of the Setup writer, proved against the real writer
 * and a real database: hrm-process-templates and leave-policies edit their
 * jsonb rules through structured slot fields projected by STORED GENERATED
 * columns. Before hrm-rule-slots.ts the folded objects never reached the
 * row on create (the database default stood in: applies to all) and an
 * edit tried to write null into a generated slot column, which Postgres
 * refuses — every process-template edit through Setup failed.
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { createSetupRecord, updateSetupRecord } = await import("./write.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedOrg() {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`
    update orgs set settings = settings || '{"features": {"hrm": true}}'::jsonb
     where id = ${org.orgId}`);
  const departmentId = randomUUID();
  await db.execute(sql`
    insert into departments (id, org_id, name, is_active) values (${departmentId}, ${org.orgId}, 'Field', true)`);
  const actor = { orgId: org.orgId, id: actorId, permissions: [] as string[] };
  return { orgId: org.orgId, subsidiaryId: org.subsidiaryId, departmentId, actor };
}

function created(res: { status: number; body: unknown }): string {
  assert.equal(res.status, 200, `create refused: ${JSON.stringify(res.body)}`);
  return String((res.body as { id?: string }).id ?? (res.body as { row?: { id?: string } }).row?.id);
}

test("a leave policy's scope, accrual and carryover slots persist as its rules and edit without touching the generated columns", { skip: !DB }, async () => {
  const org = await seedOrg();
  try {
    const type = created(await createSetupRecord(org.actor, "leave-types", {
      code: "VAC", name: "Vacation", paid: true, valueCrossing: "payout", isActive: true,
    }));
    const policyId = created(await createSetupRecord(org.actor, "leave-policies", {
      leaveTypeId: type,
      appliesEmployerSubsidiaryId: org.subsidiaryId,
      appliesDepartmentId: org.departmentId,
      accrualKind: "per_year",
      accrualHours: "120",
      carryoverKind: "carry_up_to",
      carryoverHours: "40",
      carryoverExpiresAfterDays: 90,
      minimumNoticeDays: 2,
      effectiveFrom: "2026-01-01",
      isActive: true,
    }));
    const stored = (await db.execute<{
      applies_to: { employer_subsidiary_id: string | null; department_id: string | null };
      accrual_rule: Record<string, unknown>;
      carryover_rule: Record<string, unknown>;
      applies_department_id: string | null;
      accrual_kind: string | null;
      carryover_hours: string | null;
    }>(sql`
      select applies_to, accrual_rule, carryover_rule, applies_department_id, accrual_kind, carryover_hours
        from hrm_leave_policies where id = ${policyId} and org_id = ${org.orgId}`)).rows[0]!;
    assert.deepEqual(stored.applies_to, { employer_subsidiary_id: org.subsidiaryId, department_id: org.departmentId });
    assert.deepEqual(stored.accrual_rule, { kind: "per_year", hours: "120" });
    assert.deepEqual(stored.carryover_rule, { kind: "carry_up_to", hours: "40", expires_after_days: 90 });
    // The generated slots read the folded rules back for prefill.
    assert.equal(stored.applies_department_id, org.departmentId);
    assert.equal(stored.accrual_kind, "per_year");
    assert.equal(stored.carryover_hours, "40");

    // An edit re-sends the drawer's full slot set; the generated columns are
    // never written, the folded rules are.
    const edited = await updateSetupRecord(org.actor, "leave-policies", {
      id: policyId,
      leaveTypeId: type,
      appliesEmployerSubsidiaryId: "",
      appliesDepartmentId: org.departmentId,
      accrualKind: "per_period",
      accrualHours: "8",
      accrualPeriodsPerYear: 26,
      carryoverKind: "none",
      carryoverHours: "",
      carryoverExpiresAfterDays: "",
      minimumNoticeDays: 3,
      effectiveFrom: "2026-01-01",
      isActive: true,
    });
    assert.equal(edited.status, 200, `edit refused: ${JSON.stringify(edited.body)}`);
    const after = (await db.execute<{ applies_to: unknown; accrual_rule: unknown; carryover_rule: unknown; minimum_notice_days: number }>(sql`
      select applies_to, accrual_rule, carryover_rule, minimum_notice_days
        from hrm_leave_policies where id = ${policyId} and org_id = ${org.orgId}`)).rows[0]!;
    assert.deepEqual(after.applies_to, { employer_subsidiary_id: null, department_id: org.departmentId });
    assert.deepEqual(after.accrual_rule, { kind: "per_period", hours: "8", periods_per_year: 26 });
    assert.deepEqual(after.carryover_rule, { kind: "none" });
    assert.equal(after.minimum_notice_days, 3);

    // A malformed rule is refused with the engine's words, and nothing moves.
    const refused = await updateSetupRecord(org.actor, "leave-policies", {
      id: policyId, leaveTypeId: type, accrualKind: "per_year", accrualHours: "", carryoverKind: "none",
      effectiveFrom: "2026-01-01", isActive: true,
    });
    assert.equal(refused.status, 400, `a per_year rule without hours must be refused: ${JSON.stringify(refused.body)}`);
    assert.match(JSON.stringify(refused.body), /per_year accrual rule must carry hours/);
    const untouched = (await db.execute<{ accrual_rule: unknown }>(sql`
      select accrual_rule from hrm_leave_policies where id = ${policyId}`)).rows[0]!;
    assert.deepEqual(untouched.accrual_rule, { kind: "per_period", hours: "8", periods_per_year: 26 });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a process template's applies-to slots persist and an edit no longer writes the generated columns", { skip: !DB }, async () => {
  const org = await seedOrg();
  try {
    const templateId = created(await createSetupRecord(org.actor, "hrm-process-templates", {
      kind: "onboarding", name: "Field onboarding", appliesEmployerSubsidiaryId: "", appliesDepartmentId: org.departmentId, isActive: true,
    }));
    const stored = (await db.execute<{ applies_to: unknown }>(sql`
      select applies_to from hrm_process_templates where id = ${templateId} and org_id = ${org.orgId}`)).rows[0]!;
    assert.deepEqual(stored.applies_to, { employer_subsidiary_id: null, department_id: org.departmentId }, "the folded filter reaches the row on create");
    const edited = await updateSetupRecord(org.actor, "hrm-process-templates", {
      id: templateId, kind: "onboarding", name: "Field onboarding v2", appliesEmployerSubsidiaryId: "", appliesDepartmentId: org.departmentId, isActive: true,
    });
    assert.equal(edited.status, 200, `edit refused: ${JSON.stringify(edited.body)}`);
    const after = (await db.execute<{ name: string; applies_to: unknown }>(sql`
      select name, applies_to from hrm_process_templates where id = ${templateId}`)).rows[0]!;
    assert.equal(after.name, "Field onboarding v2");
    assert.deepEqual(after.applies_to, { employer_subsidiary_id: null, department_id: org.departmentId }, "the filter survives an edit");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
