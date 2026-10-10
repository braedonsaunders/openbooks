import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../../testing/fixtures.ts";
import { cancelRequisition, createRequisition, openRequisition, reviseRequisition } from "./requisitions.ts";
import { jobDescriptionDeleteRefusal, listActiveJobDescriptions } from "./job-descriptions.ts";

/**
 * Job description library: a requisition copies its content at creation
 * and owns it from then on; retired and foreign entries are refused;
 * posting edits are revision-guarded, audited, and closed to history.
 */

async function grant(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

async function enableRecruiting(orgId: string): Promise<void> {
  for (const key of ["hrm", "hrmRecruiting"] as const) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), string_to_array(${`features,${key}`}, ','), 'true'::jsonb, true)
       where id = ${orgId}`);
  }
}

async function insertJobDescription(orgId: string, values: { name: string; isActive?: boolean }): Promise<string> {
  const row = (await db.execute<{ id: string }>(sql`
    insert into hrm_job_descriptions
      (org_id, name, title, employment_kind, compensation_min, compensation_max,
       compensation_currency, compensation_basis, description, is_active)
    values (${orgId}, ${values.name}, 'Site Superintendent', 'Full-time', '38.50', '46.00',
            'CAD', 'hourly', ${"Lead daily site operations.\n\n- Coordinate trades\n- Own safety"},
            ${values.isActive ?? true})
    returning id
  `)).rows[0];
  assert.ok(row, "job description stored");
  return row.id;
}

test("a requisition copies its job description and keeps the copy when the library changes", async () => {
  const org = await createScratchOrg();
  const other = await createScratchOrg();
  try {
    await enableRecruiting(org.orgId);
    const recruiterId = await createScratchUser(org.orgId, "Library Recruiter", "library_recruiter");
    await grant(org.orgId, recruiterId, ["hrm.recruiting.read", "hrm.recruiting.manage"]);
    const jobDescriptionId = await insertJobDescription(org.orgId, { name: "Superintendent" });
    const retiredId = await insertJobDescription(org.orgId, { name: "Retired role", isActive: false });
    const foreignId = await insertJobDescription(other.orgId, { name: "Superintendent" });

    const offered = await listActiveJobDescriptions({ orgId: org.orgId, actorId: recruiterId });
    assert.deepEqual(offered.map((entry) => entry.id), [jobDescriptionId], "only this org's active entries are offered");

    const requisition = await createRequisition({
      orgId: org.orgId,
      actorId: recruiterId,
      employerSubsidiaryId: org.subsidiaryId,
      headcount: 1,
      jobDescriptionId,
    });
    assert.equal(requisition.title, "Site Superintendent");
    assert.equal(requisition.employmentKind, "Full-time");
    assert.deepEqual(requisition.compensation, { min: "38.50", max: "46.00", currency: "CAD", basis: "hourly" });
    assert.equal(requisition.description, "Lead daily site operations.\n\n- Coordinate trades\n- Own safety");
    assert.equal(requisition.jobDescriptionId, jobDescriptionId);

    const overridden = await createRequisition({
      orgId: org.orgId,
      actorId: recruiterId,
      employerSubsidiaryId: org.subsidiaryId,
      headcount: 1,
      jobDescriptionId,
      title: "Senior Site Superintendent",
      description: "Custom text for this opening.",
    });
    assert.equal(overridden.title, "Senior Site Superintendent", "sent fields win over the library");
    assert.equal(overridden.description, "Custom text for this opening.");
    assert.equal(overridden.employmentKind, "Full-time", "unsent fields still come from the library");

    await db.execute(sql`
      update hrm_job_descriptions set title = 'Renamed', description = 'Rewritten'
       where org_id = ${org.orgId} and id = ${jobDescriptionId}`);
    const stored = (await db.execute<{ title: string; description: string }>(sql`
      select title, description from hrm_requisitions where org_id = ${org.orgId} and id = ${requisition.id}`)).rows[0];
    assert.deepEqual(stored, { title: "Site Superintendent", description: requisition.description });

    await assert.rejects(
      createRequisition({ orgId: org.orgId, actorId: recruiterId, employerSubsidiaryId: org.subsidiaryId, headcount: 1, jobDescriptionId: retiredId }),
      /inactive/,
    );
    await assert.rejects(
      createRequisition({ orgId: org.orgId, actorId: recruiterId, employerSubsidiaryId: org.subsidiaryId, headcount: 1, jobDescriptionId: foreignId }),
      /not visible in this organization/,
    );
    await assert.rejects(
      createRequisition({ orgId: org.orgId, actorId: recruiterId, employerSubsidiaryId: org.subsidiaryId, headcount: 1 }),
      /title must be non-blank/,
    );

    const refusal = await jobDescriptionDeleteRefusal(db, org.orgId, jobDescriptionId);
    assert.match(refusal ?? "", /Job description Superintendent was used by 2 requisitions/, "a referenced entry is refused by name");
    assert.match(refusal ?? "", /deactivate it instead/, "the refusal names the remedy");
    assert.equal(await jobDescriptionDeleteRefusal(db, org.orgId, retiredId), null, "an unused entry may be deleted");
    // Storage stays the backstop for a reference created between the check and the DELETE.
    await assert.rejects(
      db.execute(sql`delete from hrm_job_descriptions where org_id = ${org.orgId} and id = ${jobDescriptionId}`),
      (error: { cause?: { constraint?: string } }) => error.cause?.constraint === "hrm_requisitions_job_description_tenant_fkey",
    );
  } finally {
    await dropScratchOrg(org.orgId);
    await dropScratchOrg(other.orgId);
  }
});

test("posting edits are revision-guarded, audited, and refused once the opening is history", async () => {
  const org = await createScratchOrg();
  try {
    await enableRecruiting(org.orgId);
    const recruiterId = await createScratchUser(org.orgId, "Posting Editor", "posting_editor");
    await grant(org.orgId, recruiterId, ["hrm.recruiting.read", "hrm.recruiting.manage"]);
    const requisition = await createRequisition({
      orgId: org.orgId,
      actorId: recruiterId,
      title: "Estimator",
      employerSubsidiaryId: org.subsidiaryId,
      headcount: 1,
      employmentKind: "Full-time",
      description: "Original text.",
    });

    const revised = await reviseRequisition({
      orgId: org.orgId,
      actorId: recruiterId,
      requisitionId: requisition.id,
      expectedRevision: requisition.revision,
      description: "Revised text.",
      employmentKind: null,
    });
    assert.equal(revised.description, "Revised text.");
    assert.equal(revised.employmentKind, null, "null clears an optional field");
    assert.equal(revised.title, "Estimator", "omitted fields are unchanged");
    assert.equal(revised.revision, requisition.revision + 1);

    const audit = (await db.execute<{ changes: { before: { description: string }; after: { description: string } } }>(sql`
      select changes from audit_log
       where org_id = ${org.orgId} and table_name = 'hrm_requisitions' and row_id = ${requisition.id}
         and action = 'requisition_posting_revised'`)).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.changes.before.description, "Original text.");
    assert.equal(audit[0]!.changes.after.description, "Revised text.");

    await assert.rejects(
      reviseRequisition({
        orgId: org.orgId,
        actorId: recruiterId,
        requisitionId: requisition.id,
        expectedRevision: requisition.revision,
        description: "Edited from a stale drawer.",
      }),
      /changed since it was read/,
    );

    await openRequisition({ orgId: org.orgId, actorId: recruiterId, requisitionId: requisition.id });
    await cancelRequisition({ orgId: org.orgId, actorId: recruiterId, requisitionId: requisition.id, reason: "Role withdrawn" });
    await assert.rejects(
      reviseRequisition({
        orgId: org.orgId,
        actorId: recruiterId,
        requisitionId: requisition.id,
        expectedRevision: revised.revision,
        description: "Edited after cancellation.",
      }),
      /only draft, open and on-hold openings/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

