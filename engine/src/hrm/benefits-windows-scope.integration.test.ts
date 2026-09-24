import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import { electEnrollment } from "./benefits/enrollments.ts";
import { listEnrollmentWindows } from "./benefits/benefits-read.ts";
import {
  closeEnrollmentWindow,
  createEnrollmentWindow,
  getEnrollmentWindow,
  openEnrollmentWindow,
} from "./benefits/windows.ts";

/**
 * H-BENEFITS regression: enrollment-window reads and writes ignored the
 * actor's subsidiary lens. open/close/create checked hrm.benefits.manage
 * only, so an A-scoped manager opened or closed B's windows; an org-wide
 * window (no employer) was changeable by any restricted actor.
 * listEnrollmentWindows resolved the aggregate scope and DISCARDED it,
 * returning every window with org-wide election and pending counts.
 *
 * Targeted windows now carry their employer's scope on every read and
 * write (B-targeted refuses uniformly as not-visible); org-wide windows
 * need unrestricted scope to change (named 403 remedy) while staying
 * discoverable with fenced counts. Proofs are read back through the
 * service, never from its internals.
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

async function enableHrm(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true)
     where id = ${orgId}`);
}

async function seedEmployment(orgId: string, subsidiaryId: string): Promise<string> {
  const party = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${party}, ${orgId}, 'person', 'Benefits Worker', true, '{}'::jsonb)`);
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${party}, ${subsidiaryId}, 1)`);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
    values (${orgId}, ${employmentId}, 1, 'active', '2020-01-01'::date, null, now())`);
  return employmentId;
}

async function seedComponent(orgId: string, code: string, kind: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into pay_components (id, org_id, code, name, kind, is_active)
    values (${id}, ${orgId}, ${code}, ${code}, ${kind}, true)`);
  return id;
}

async function seedPlan(orgId: string, requiresApproval: boolean): Promise<string> {
  const employeeComponentId = await seedComponent(orgId, `DED_${randomUUID().slice(0, 6)}`, "deduction");
  const employerComponentId = await seedComponent(orgId, `ER_${randomUUID().slice(0, 6)}`, "employer_contribution");
  const planId = randomUUID();
  const code = `MED_${randomUUID().slice(0, 6)}`;
  await db.execute(sql`
    insert into hrm_benefit_plans
      (id, org_id, code, name, kind, currency, employee_cost_basis, employee_cost,
       employer_cost_basis, employer_cost, employee_pay_component_id,
       employer_pay_component_id, proration_basis, waiting_period_days,
       requires_approval, is_active, effective_from)
    values (${planId}, ${orgId}, ${code}, ${code}, 'health', 'USD',
            'per_month', '250.0000', 'per_month', '500.0000',
            ${employeeComponentId}, ${employerComponentId},
            'full_month', 0, ${requiresApproval}, true, '2020-01-01')`);
  return planId;
}

const WINDOW_DATES = {
  opensOn: "2026-01-01",
  closesOn: "2026-12-31",
  planYearStartOn: "2026-01-01",
};

async function refusalOf(promise: Promise<unknown>): Promise<{ name: string; code: string; message: string }> {
  try {
    await promise;
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return { name: (e as Error).name, code: typeof code === "string" ? code : "", message: (e as Error).message };
  }
  throw new Error("expected a refusal, the call succeeded");
}

test("H-BENEFITS: window reads fence B's windows and counts to the lens", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableHrm(org.orgId);
    const adminId = await createScratchUser(org.orgId, "Benefits Admin", "win_admin");
    await grantPermissions(org.orgId, adminId, ["hrm.benefits.read", "hrm.benefits.manage"]);
    const subB = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
        from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
    const empA = await seedEmployment(org.orgId, org.subsidiaryId);
    const empB = await seedEmployment(org.orgId, subB);
    const windowA = await createEnrollmentWindow({
      orgId: org.orgId, actorId: adminId, name: "A window", kind: "open_enrollment",
      ...WINDOW_DATES, employerSubsidiaryId: org.subsidiaryId,
    });
    const windowB = await createEnrollmentWindow({
      orgId: org.orgId, actorId: adminId, name: "B window", kind: "open_enrollment",
      ...WINDOW_DATES, employerSubsidiaryId: subB,
    });
    const planApproving = await seedPlan(org.orgId, true);
    await openEnrollmentWindow({ orgId: org.orgId, actorId: adminId, windowId: windowA.id });
    await openEnrollmentWindow({ orgId: org.orgId, actorId: adminId, windowId: windowB.id });
    await electEnrollment({
      orgId: org.orgId, actorId: adminId, employmentId: empA,
      planId: planApproving, windowId: windowA.id, effectiveFrom: "2026-02-01",
    });
    await electEnrollment({
      orgId: org.orgId, actorId: adminId, employmentId: empB,
      planId: planApproving, windowId: windowB.id, effectiveFrom: "2026-02-01",
    });

    const managerA = await createScratchUser(org.orgId, "Benefits Manager A", "win_mgr_a");
    await scopeRole(
      org.orgId, "win_mgr_a",
      ["hrm.benefits.read", "hrm.benefits.manage"], [org.subsidiaryId],
    );

    // Unrestricted: both windows with their own pending counts.
    const full = await listEnrollmentWindows(db, org.orgId, adminId);
    assert.equal(full.find((w) => w.id === windowA.id)?.pendingApprovals, 1);
    assert.equal(full.find((w) => w.id === windowB.id)?.pendingApprovals, 1);

    // A-scoped: A's window with A's pending count only; B's window —
    // and its pending election — are not observable.
    const scoped = await listEnrollmentWindows(db, org.orgId, managerA);
    const seenA = scoped.find((w) => w.id === windowA.id);
    assert.ok(seenA, "A-targeted window stays visible");
    assert.equal(seenA.pendingApprovals, 1);
    assert.equal(seenA.elections, 1);
    assert.ok(!scoped.some((w) => w.id === windowB.id), "B-targeted window is hidden");
    assert.ok(!scoped.some((w) => w.name === "B window"), "B's window leaks through no row");

    // Direct reads agree: B's window refuses exactly like a fabricated id.
    const hidden = await refusalOf(
      getEnrollmentWindow({ orgId: org.orgId, actorId: managerA, windowId: windowB.id }),
    );
    const fabricated = await refusalOf(
      getEnrollmentWindow({ orgId: org.orgId, actorId: managerA, windowId: randomUUID() }),
    );
    assert.deepEqual(hidden, fabricated);
    assert.equal(hidden.code, "NOT_FOUND");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("H-BENEFITS: window writes validate the employer's scope", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableHrm(org.orgId);
    const adminId = await createScratchUser(org.orgId, "Benefits Admin", "winw_admin");
    await grantPermissions(org.orgId, adminId, ["hrm.benefits.read", "hrm.benefits.manage"]);
    const subB = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
        from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
    const windowB = await createEnrollmentWindow({
      orgId: org.orgId, actorId: adminId, name: "B window", kind: "open_enrollment",
      ...WINDOW_DATES, employerSubsidiaryId: subB,
    });
    const windowOrg = await createEnrollmentWindow({
      orgId: org.orgId, actorId: adminId, name: "Org window", kind: "open_enrollment",
      ...WINDOW_DATES, employerSubsidiaryId: null,
    });
    const managerA = await createScratchUser(org.orgId, "Benefits Manager A", "winw_mgr_a");
    await scopeRole(org.orgId, "winw_mgr_a", ["hrm.benefits.manage"], [org.subsidiaryId]);
    const createAs = (employerSubsidiaryId: string | null, name: string) =>
      createEnrollmentWindow({
        orgId: org.orgId, actorId: managerA, name, kind: "open_enrollment",
        ...WINDOW_DATES, employerSubsidiaryId,
      });

    // In-scope creation still stores and opens.
    const own = await createAs(org.subsidiaryId, "A window");
    assert.equal((await openEnrollmentWindow({ orgId: org.orgId, actorId: managerA, windowId: own.id })).status, "open");

    // B-targeted creation refuses exactly like a fabricated subsidiary.
    const foreign = await refusalOf(createAs(subB, "B clone"));
    const fabricated = await refusalOf(createAs(randomUUID(), "Fabricated clone"));
    assert.deepEqual(foreign, fabricated);
    assert.equal(foreign.code, "NOT_FOUND");

    // Org-wide creation needs unrestricted scope (a named 403 at the route).
    const orgWide = await refusalOf(createAs(null, "Org clone"));
    assert.equal(orgWide.name, "UnrestrictedScopeError");
    assert.match(orgWide.message, /requires unrestricted subsidiary access/);

    // B's window neither opens nor closes for the A-scoped actor — and
    // the refusal reads exactly like a missing window.
    const openHidden = await refusalOf(
      openEnrollmentWindow({ orgId: org.orgId, actorId: managerA, windowId: windowB.id }),
    );
    const openMissing = await refusalOf(
      openEnrollmentWindow({ orgId: org.orgId, actorId: managerA, windowId: randomUUID() }),
    );
    assert.deepEqual(openHidden, openMissing);
    assert.equal(openHidden.code, "NOT_FOUND");

    // Org-wide open/close need unrestricted scope too.
    await openEnrollmentWindow({ orgId: org.orgId, actorId: adminId, windowId: windowOrg.id });
    const closeOrgWide = await refusalOf(
      closeEnrollmentWindow({ orgId: org.orgId, actorId: managerA, windowId: windowOrg.id, reason: "probe" }),
    );
    assert.equal(closeOrgWide.name, "UnrestrictedScopeError");
    assert.match(closeOrgWide.message, /requires unrestricted subsidiary access/);
    // The refused close changed nothing: the window is still open.
    assert.equal(
      (await getEnrollmentWindow({ orgId: org.orgId, actorId: adminId, windowId: windowOrg.id })).status, "open",
    );

    // The in-scope close lands.
    const closed = await closeEnrollmentWindow({
      orgId: org.orgId, actorId: managerA, windowId: own.id, reason: "round over",
    });
    assert.equal(closed.status, "closed");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
