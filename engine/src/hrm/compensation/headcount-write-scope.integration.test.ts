import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../../testing/fixtures.ts";
import { createJobFamily, createJobLevel } from "./architecture.ts";
import { createPayBand } from "./bands.ts";
import {
  approvePlan,
  approvePlanLine,
  closePlan,
  createPlan,
  createPlanLine,
  submitPlan,
} from "./headcount-plans.ts";

/**
 * H-HEADCOUNT regression: headcount-plan writes checked
 * hrm.compensation.manage only, selecting and updating by org/id. An
 * A-scoped manager added B-employer lines, approved B lines (which OPENS
 * A REQUISITION into B), and approved or closed B-scoped plans, while
 * the read service hid B.
 *
 * Writes now recheck the plan's scope plus every affected line's
 * employer under the plan/line lock before acting, refusing uniformly
 * as not-visible. Proofs run the service: out-of-scope writes refuse
 * identically to fabricated ids (and open no requisition), while
 * in-scope writes proceed to their stored outcome.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function grantPermissions(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

async function scopeRole(orgId: string, roleKey: string, permissions: string[], subsidiaryIds: string[]): Promise<void> {
  await db.execute(sql`
    update app_roles
       set permissions = ${JSON.stringify(permissions)}::jsonb,
           subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds })}::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
}

async function setZeroBurden(orgId: string): Promise<void> {
  const current = (await db.execute<{ settings: Record<string, unknown> }>(sql`
    select settings from orgs where id = ${orgId}`)).rows[0]?.settings ?? {};
  const next = {
    ...(current as Record<string, unknown>),
    compensation: { ...((current as Record<string, unknown>).compensation as Record<string, unknown> ?? {}), burdenRate: "0" },
  };
  await db.execute(sql`update orgs set settings = ${JSON.stringify(next)}::jsonb where id = ${orgId}`);
}

async function requisitionCount(orgId: string): Promise<number> {
  const rows = (await db.execute<{ n: string }>(sql`
    select count(*)::text as n from hrm_requisitions where org_id = ${orgId}`)).rows;
  return Number(rows[0]?.n ?? 0);
}

async function refusalOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return { code: typeof code === "string" ? code : (e as Error).name, message: (e as Error).message };
  }
  throw new Error("expected a refusal, the call succeeded");
}

const LINE_BASE = {
  kind: "create" as const,
  plannedFte: "1",
  startOn: "2026-03-01",
  currency: "CAD",
};

test("H-HEADCOUNT: lines and transitions stay inside the actor's lens", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const adminId = await createScratchUser(org.orgId, "Headcount Admin", "hcw_admin");
    await grantPermissions(org.orgId, adminId, ["hrm.compensation.read", "hrm.compensation.manage", "hrm.recruiting.manage"]);
    const subB = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
        from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
    const family = await createJobFamily({ orgId: org.orgId, actorId: adminId, code: "ENG", name: "Engineering" });
    const level = await createJobLevel({
      orgId: org.orgId, actorId: adminId, familyId: family.id, code: "IC3", name: "Engineer III", rank: 3,
      equalValueCriteria: [{ criterion: "skills", weight: "3" }],
    });
    await createPayBand({
      orgId: org.orgId, actorId: adminId,
      scope: { familyId: family.id, levelId: level.id, employerSubsidiaryId: null, locationId: null },
      currency: "CAD", basis: "annual", min: "80000", target: "100000", max: "120000",
      effectiveFrom: "2020-01-01", reason: "H-HEADCOUNT seed",
    });
    await setZeroBurden(org.orgId);
    const managerA = await createScratchUser(org.orgId, "Headcount Manager A", "hcw_mgr_a");
    await scopeRole(
      org.orgId, "hcw_mgr_a",
      ["hrm.compensation.manage", "hrm.recruiting.manage"], [org.subsidiaryId],
    );

    const plan = await createPlan({
      orgId: org.orgId, actorId: adminId, name: "FY26 plan",
      fiscalPeriodFrom: "2026-01-01", fiscalPeriodTo: "2026-12-31",
    });
    const addLine = (actorId: string, employerSubsidiaryId: string, title: string, planId: string = plan.id) =>
      createPlanLine({
        orgId: org.orgId, actorId, planId, ...LINE_BASE,
        title, employerSubsidiaryId, jobLevelId: level.id, reason: "growth",
      });

    // A B-employer line refuses exactly like a fabricated employer — no
    // B headcount is planted.
    const foreign = await refusalOf(addLine(managerA, subB, "Engineer III B"));
    const fabricated = await refusalOf(addLine(managerA, randomUUID(), "Engineer III X"));
    assert.deepEqual(foreign, fabricated);
    assert.equal(foreign.code, "NOT_FOUND");

    // The in-scope line stores; the admin's B line stores for the
    // approval probes below.
    const lineA = await addLine(managerA, org.subsidiaryId, "Engineer III A");
    assert.ok(lineA.id);
    const lineB = await addLine(adminId, subB, "Engineer III B");

    // Approving B's line refuses as a missing line — and opens no
    // requisition into B.
    const before = await requisitionCount(org.orgId);
    const approveHidden = await refusalOf(
      approvePlanLine({ orgId: org.orgId, actorId: managerA, lineId: lineB.id }),
    );
    const approveMissing = await refusalOf(
      approvePlanLine({ orgId: org.orgId, actorId: managerA, lineId: randomUUID() }),
    );
    assert.deepEqual(approveHidden, approveMissing);
    assert.equal(approveHidden.code, "NOT_FOUND");
    assert.equal(await requisitionCount(org.orgId), before, "no B requisition opened");

    // The same approval by the unrestricted admin opens the requisition —
    // the path works when scoped.
    const approvedB = await approvePlanLine({ orgId: org.orgId, actorId: adminId, lineId: lineB.id });
    assert.equal(approvedB.status, "opened");
    assert.ok(approvedB.requisitionId);
    assert.equal(await requisitionCount(org.orgId), before + 1);

    // The in-scope line approves for the restricted actor too.
    const approvedA = await approvePlanLine({ orgId: org.orgId, actorId: managerA, lineId: lineA.id });
    assert.equal(approvedA.status, "opened");

    // Transitions: a B-scoped plan neither submits nor approves for the
    // A-scoped actor; the mixed plan (null scope, B line aboard) neither
    // submits — while an A-only plan moves draft → submitted → approved
    // → closed end to end.
    const planB = await createPlan({
      orgId: org.orgId, actorId: adminId, name: "B-only plan",
      fiscalPeriodFrom: "2026-01-01", fiscalPeriodTo: "2026-12-31",
    });
    await db.execute(sql`
      update hrm_headcount_plans
         set scope = ${JSON.stringify({ employer_subsidiary_id: subB })}::jsonb
       where org_id = ${org.orgId} and id = ${planB.id}`);
    const submitB = await refusalOf(submitPlan({ orgId: org.orgId, actorId: managerA, planId: planB.id }));
    assert.equal(submitB.code, "NOT_FOUND");
    assert.match(submitB.message, /not visible in this organization/);
    assert.equal((await submitPlan({ orgId: org.orgId, actorId: adminId, planId: planB.id })).status, "submitted");

    const submitMixed = await refusalOf(submitPlan({ orgId: org.orgId, actorId: managerA, planId: plan.id }));
    assert.equal(submitMixed.code, "NOT_FOUND");

    const planA = await createPlan({
      orgId: org.orgId, actorId: adminId, name: "A-only plan",
      fiscalPeriodFrom: "2026-01-01", fiscalPeriodTo: "2026-12-31",
    });
    await addLine(managerA, org.subsidiaryId, "Engineer III A2", planA.id);
    assert.equal((await submitPlan({ orgId: org.orgId, actorId: managerA, planId: planA.id })).status, "submitted");
    assert.equal((await approvePlan({ orgId: org.orgId, actorId: managerA, planId: planA.id })).status, "approved");
    assert.equal((await closePlan({ orgId: org.orgId, actorId: managerA, planId: planA.id })).status, "closed");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
