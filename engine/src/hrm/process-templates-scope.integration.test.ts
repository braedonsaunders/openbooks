import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import {
  createProcessTemplate,
  deleteProcessTemplate,
  deleteProcessTemplateStep,
  updateProcessTemplate,
  upsertProcessTemplateStep,
} from "./processes.ts";

/**
 * H-PROCESSTEMPLATES regression: process-template writes checked
 * hrm.process.manage only. Creation accepted an arbitrary
 * appliesTo.employerSubsidiaryId with only an org existence check, and
 * update plus every step write selected the template by org/id — so an
 * A-scoped manager created or edited B-targeted onboarding/offboarding
 * steps (or org-wide templates) that then execute for B's employees.
 *
 * B-targeted templates now need scope over B on every write (creation
 * validates the declared target uniformly with a fabricated subsidiary;
 * updates and step writes recheck the locked row, refusing as
 * not-found), while org-wide templates need unrestricted scope, named
 * with the remedy. Proofs run the service, including the stored step
 * rows.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function enableHrm(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true)
     where id = ${orgId}`);
}

async function grant(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'`);
  }
}

async function scopeRole(orgId: string, roleKey: string, permissions: string[], subsidiaryIds: string[]): Promise<void> {
  await db.execute(sql`
    update app_roles
       set permissions = ${JSON.stringify(permissions)}::jsonb,
           subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds })}::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
}

async function refusalOf(promise: Promise<unknown>): Promise<{ name: string; code: string; message: string }> {
  try {
    await promise;
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return { name: (e as Error).name, code: typeof code === "string" ? code : "", message: (e as Error).message };
  }
  throw new Error("expected a refusal, the call succeeded");
}

const STEP = { position: 0, title: "Collect documents", ownerKind: "hr" as const };

test("H-PROCESSTEMPLATES: template writes need the targeted entity's scope", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableHrm(org.orgId);
    const adminId = await createScratchUser(org.orgId, "Process Admin", "pt_admin");
    await grant(org.orgId, adminId, ["hrm.process.manage"]);
    const subB = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', base_currency, country
        from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
    const managerA = await createScratchUser(org.orgId, "Process Manager A", "pt_mgr_a");
    await scopeRole(org.orgId, "pt_mgr_a", ["hrm.process.manage"], [org.subsidiaryId]);
    const createAs = (employerSubsidiaryId: string | null, name: string) =>
      createProcessTemplate({
        orgId: org.orgId, actorId: managerA, kind: "onboarding", name,
        appliesTo: { employerSubsidiaryId, departmentId: null },
      });

    // A B-targeted template refuses exactly like a fabricated subsidiary.
    const foreign = await refusalOf(createAs(subB, "B onboarding"));
    const fabricated = await refusalOf(createAs(randomUUID(), "Fabricated onboarding"));
    assert.deepEqual(foreign, fabricated);
    assert.equal(foreign.code, "NOT_FOUND");

    // An org-wide template executes for every entity: needs unrestricted scope.
    const orgWide = await refusalOf(createAs(null, "Org onboarding"));
    assert.equal(orgWide.name, "UnrestrictedScopeError");
    assert.match(orgWide.message, /requires unrestricted subsidiary access/);

    // The in-scope target still stores.
    const templateA = await createAs(org.subsidiaryId, "A onboarding");
    assert.ok(templateA.id);

    // Fixtures for the mutation probes, authored unrestricted.
    const templateB = await createProcessTemplate({
      orgId: org.orgId, actorId: adminId, kind: "offboarding", name: "B offboarding",
      appliesTo: { employerSubsidiaryId: subB, departmentId: null },
    });
    const templateOrg = await createProcessTemplate({
      orgId: org.orgId, actorId: adminId, kind: "transfer", name: "Org transfer",
      appliesTo: { employerSubsidiaryId: null, departmentId: null },
    });

    // Updates: B-targeted refuses as a missing template; org-wide names
    // the remedy; A-targeted renames through.
    const updateHidden = await refusalOf(
      updateProcessTemplate({ orgId: org.orgId, actorId: managerA, templateId: templateB.id, name: "Renamed" }),
    );
    const updateMissing = await refusalOf(
      updateProcessTemplate({ orgId: org.orgId, actorId: managerA, templateId: randomUUID(), name: "Renamed" }),
    );
    assert.deepEqual(updateHidden, updateMissing);
    assert.equal(updateHidden.code, "NOT_FOUND");
    const updateOrg = await refusalOf(
      updateProcessTemplate({ orgId: org.orgId, actorId: managerA, templateId: templateOrg.id, name: "Renamed" }),
    );
    assert.equal(updateOrg.name, "UnrestrictedScopeError");
    assert.match(updateOrg.message, /requires unrestricted subsidiary access/);
    assert.equal(
      (await updateProcessTemplate({ orgId: org.orgId, actorId: managerA, templateId: templateA.id, name: "A renamed" })).name,
      "A renamed",
    );
    // Retargeting the A template onto B refuses like a foreign subsidiary.
    const retarget = await refusalOf(
      updateProcessTemplate({
        orgId: org.orgId, actorId: managerA, templateId: templateA.id,
        appliesTo: { employerSubsidiaryId: subB, departmentId: null },
      }),
    );
    assert.equal(retarget.code, "NOT_FOUND");
    assert.match(retarget.message, /not visible in this organization/);

    // Step writes: B's template refuses as not-found; A's template stores
    // the step row.
    const stepHidden = await refusalOf(
      upsertProcessTemplateStep({ orgId: org.orgId, actorId: managerA, templateId: templateB.id, ...STEP }),
    );
    const stepMissing = await refusalOf(
      upsertProcessTemplateStep({ orgId: org.orgId, actorId: managerA, templateId: randomUUID(), ...STEP }),
    );
    assert.deepEqual(stepHidden, stepMissing);
    assert.equal(stepHidden.code, "NOT_FOUND");
    const step = await upsertProcessTemplateStep({
      orgId: org.orgId, actorId: managerA, templateId: templateA.id, ...STEP,
    });
    assert.ok(step.id);

    // Step deletion follows the template: B's refuses, A's lands.
    const deleteHidden = await refusalOf(
      deleteProcessTemplateStep({ orgId: org.orgId, actorId: managerA, templateId: templateB.id, stepId: step.id }),
    );
    assert.equal(deleteHidden.code, "NOT_FOUND");
    await deleteProcessTemplateStep({ orgId: org.orgId, actorId: managerA, templateId: templateA.id, stepId: step.id });

    // Template deletion follows the same scope: B's refuses as missing.
    const deleteB = await refusalOf(
      deleteProcessTemplate({ orgId: org.orgId, actorId: managerA, templateId: templateB.id }),
    );
    assert.equal(deleteB.code, "NOT_FOUND");
    assert.equal(deleteB.name, "HrmProcessError");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
