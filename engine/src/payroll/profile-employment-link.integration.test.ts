import { installEngineSeams } from "../composition/install.ts";
installEngineSeams();
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { describe } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../testing/fixtures.ts";
import { payRunReadiness } from "./readiness.ts";
import { createPayRun } from "./run-lifecycle.ts";
import {
  linkPayrollProfileEmployment,
  payrollProfileEmployment,
  resolvePayrollProfileEmploymentLinks,
  resolveProfileLegalEmployer,
} from "./profile-employment.ts";
import { acceptOfferAsHire } from "../hrm/recruiting/hire.ts";
import { createApplication, moveApplicationStage } from "../hrm/recruiting/applications.ts";
import { getRequisitionDetail } from "../hrm/recruiting/recruiting-read.ts";
import { createCandidate, linkCandidateParty } from "../hrm/recruiting/candidates.ts";
import { createOffer, sendOffer } from "../hrm/recruiting/offers.ts";
import { createPosition } from "../hrm/positions.ts";
import { createRequisition, openRequisition } from "../hrm/recruiting/requisitions.ts";

/**
 * Employments created by the native Hire action never linked to payroll
 * profiles: Hire minted the party without a subsidiary and left any
 * pre-existing profile unlinked, while every payroll link check compared
 * the employment's subsidiary against the NULL party subsidiary — so the
 * pair never validated, readiness blocked on "no payroll link", and the
 * import refused the correct pair. These tests pin the repair: Hire links,
 * a NULL legal employer resolves from the employment, and the readiness
 * Resolve action fills unambiguous links (audited) while naming the rest.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  orgId: string;
  actorId: string;
  rootSubsidiaryId: string;
}

async function org(): Promise<Fixture> {
  const created = await createScratchOrg();
  const actorId = (await seedFlowActors(created.orgId)).adminId;
  await db.execute(sql`
    update orgs set settings = settings || '{"features":{"payroll":true,"hrm":true,"hrmRecruiting":true}}'::jsonb
     where id = ${created.orgId}`);
  await db.execute(sql`
    update app_roles set permissions = '["payroll.manage","hrm.recruiting.manage","hrm.recruiting.read","hrm.position.manage","hrm.position.read","hrm.employment.manage","hrm.employment.read"]'::jsonb
     where org_id = ${created.orgId} and key = 'admin'`);
  return { orgId: created.orgId, actorId, rootSubsidiaryId: created.subsidiaryId };
}

async function party(fx: Fixture, name: string, subsidiaryId: string | null): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${id}, ${fx.orgId}, 'person', ${name}, ${subsidiaryId}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${fx.orgId}, ${id})`);
  return id;
}

async function employment(
  fx: Fixture,
  partyId: string,
  subsidiaryId: string,
  status = "active",
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${id}, ${fx.orgId}, ${partyId}, ${subsidiaryId}, 1)`);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from)
    values (${fx.orgId}, ${id}, 1, ${status}, '2026-10-01')`);
  return id;
}

async function profile(
  fx: Fixture,
  tag: string,
  partyId: string,
  employmentId: string | null,
): Promise<string> {
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, subsidiary_id, is_active, created_by, updated_by)
    values (${scheduleId}, ${fx.orgId}, ${`Biweekly ${tag}`}, 'biweekly', 26, '2026-07-18', 3,
            ${fx.rootSubsidiaryId}, true, ${fx.actorId}, ${fx.actorId})`);
  const id = randomUUID();
  await db.execute(sql`
    insert into employee_payroll_profiles (id, org_id, employee_party_id, employment_id,
                                           pay_schedule_id, country, province, is_active,
                                           created_by, updated_by)
    values (${id}, ${fx.orgId}, ${partyId}, ${employmentId}, ${scheduleId}, 'US', 'CA', true,
            ${fx.actorId}, ${fx.actorId})`);
  return scheduleId;
}

async function employmentOf(fx: Fixture, partyId: string): Promise<string | null> {
  const row = (
    await db.execute<{ employment_id: string | null }>(
      sql`
    select employment_id from employee_payroll_profiles
     where org_id = ${fx.orgId} and employee_party_id = ${partyId}`,
      "objects",
    )
  )[0];
  return row?.employment_id ?? null;
}

describe("hire-links-payroll-profile", { skip: !DB }, () => {
  test("a NULL legal employer resolves from the single employment", async () => {
    const fx = await org();
    try {
      const partyId = await party(fx, "Nully Ned", null);
      assert.equal(await resolveProfileLegalEmployer(db, fx.orgId, partyId, null), null);
      const employmentId = await employment(fx, partyId, fx.rootSubsidiaryId);
      assert.equal(
        await resolveProfileLegalEmployer(db, fx.orgId, partyId, null),
        fx.rootSubsidiaryId,
      );
      assert.equal(
        await resolveProfileLegalEmployer(db, fx.orgId, partyId, fx.rootSubsidiaryId),
        fx.rootSubsidiaryId,
      );
      void employmentId;
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  });

  test("employments under two legal employers refuse by name", async () => {
    const fx = await org();
    try {
      const partyId = await party(fx, "Twofer Tilda", null);
      await employment(fx, partyId, fx.rootSubsidiaryId);
      const other = randomUUID();
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids,
                                  is_elimination, is_active, custom)
        values (${other}, ${fx.orgId}, ${fx.rootSubsidiaryId}, 'Second Entity', 'USD', 'US',
                '{}'::jsonb, false, true, '{}'::jsonb)`);
      await employment(fx, partyId, other);
      await assert.rejects(
        resolveProfileLegalEmployer(db, fx.orgId, partyId, null),
        /more than one legal employer/,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  });

  test("the import accepts the correct pair for a NULL-subsidiary party", async () => {
    const fx = await org();
    try {
      const partyId = await party(fx, "Hired Holly", null);
      const employmentId = await employment(fx, partyId, fx.rootSubsidiaryId);
      await profile(fx, "p1", partyId, null);
      // The pair the workaround refused: the employment IS hers and the
      // employer resolves from it.
      assert.equal(
        await payrollProfileEmployment(db, fx.orgId, partyId, null, employmentId),
        employmentId,
      );
      const result = await linkPayrollProfileEmployment({
        orgId: fx.orgId,
        actorId: fx.actorId,
        employeePartyId: partyId,
        employmentId,
        reason: "hire backfill",
        dryRun: false,
        allowedSubsidiaryIds: undefined,
      });
      assert.equal(result.changed, true);
      assert.equal(await employmentOf(fx, partyId), employmentId);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  });

  test("the resolve action links the unambiguous and names the rest", async () => {
    const fx = await org();
    try {
      const solo = await party(fx, "Solo Sam", null);
      await employment(fx, solo, fx.rootSubsidiaryId);
      await profile(fx, "solo", solo, null);
      const none = await party(fx, "Nojob Nora", null);
      await profile(fx, "none", none, null);
      const first = await resolvePayrollProfileEmploymentLinks({
        orgId: fx.orgId,
        actorId: fx.actorId,
        reason: "readiness resolve",
        dryRun: true,
        allowedSubsidiaryIds: undefined,
      });
      assert.equal(first.linked.length, 1);
      assert.equal(first.linked[0]!.employeePartyId, solo);
      assert.equal(first.unresolved.length, 1);
      assert.equal(first.unresolved[0]!.employeePartyId, none);
      assert.match(first.unresolved[0]!.reason ?? "", /no employment on file/);
      // A preview writes nothing.
      assert.equal(await employmentOf(fx, solo), null);
      const applied = await resolvePayrollProfileEmploymentLinks({
        orgId: fx.orgId,
        actorId: fx.actorId,
        reason: "readiness resolve",
        dryRun: false,
        allowedSubsidiaryIds: undefined,
      });
      assert.equal(applied.linked.length, 1);
      const stored = (
        await db.execute<{ employment_id: string | null }>(
          sql`
        select employment_id from employee_payroll_profiles
         where org_id = ${fx.orgId} and employee_party_id = ${solo}`,
          "objects",
        )
      )[0]!.employment_id;
      assert.ok(stored);
      const audit = (
        await db.execute<{ n: number }>(
          sql`
        select count(*)::int as n from audit_log
         where org_id = ${fx.orgId} and table_name = 'employee_payroll_profiles'
           and action = 'update'`,
          "objects",
        )
      )[0]!.n;
      assert.equal(audit, 1);
      // Second run finds nothing left to link.
      const again = await resolvePayrollProfileEmploymentLinks({
        orgId: fx.orgId,
        actorId: fx.actorId,
        reason: "readiness resolve",
        dryRun: false,
        allowedSubsidiaryIds: undefined,
      });
      assert.deepEqual([again.linked.length, again.unresolved.length], [0, 1]);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  });

  test("native Hire links a pre-existing unlinked profile to the new employment", async () => {
    const fx = await org();
    try {
      // An existing employee (party without a subsidiary, profile without an
      // employment) reapplies: the hire must link the profile, not strand it.
      const partyId = await party(fx, "Rehire Ruby", null);
      await profile(fx, "p1", partyId, null);
      const position = await createPosition({
        orgId: fx.orgId,
        actorId: fx.actorId,
        positionCode: "ENG-2048",
        title: "Engineer",
        employerSubsidiaryId: fx.rootSubsidiaryId,
        plannedFte: "1.0000",
        status: "open",
        effectiveFrom: "2026-07-01",
        reason: "open the establishment",
      });
      const requisition = await createRequisition({
        orgId: fx.orgId,
        actorId: fx.actorId,
        title: "Backend engineer",
        positionId: position.id,
        employerSubsidiaryId: fx.rootSubsidiaryId,
        hiringManagerPartyId: partyId,
        headcount: 1,
        targetStartOn: "2026-10-01",
      });
      const opened = await openRequisition({
        orgId: fx.orgId,
        actorId: fx.actorId,
        requisitionId: requisition.id,
      });
      const { candidate } = await createCandidate({
        orgId: fx.orgId,
        actorId: fx.actorId,
        displayName: "Rehire Ruby",
        email: "ruby@example.test",
        phone: "+1-555-0100",
        source: "direct",
      });
      await linkCandidateParty(db, {
        orgId: fx.orgId,
        actorId: fx.actorId,
        candidateId: candidate.id,
        partyId,
      });
      const application = await createApplication({
        orgId: fx.orgId,
        actorId: fx.actorId,
        requisitionId: opened.id,
        candidateId: candidate.id,
      });
      const funnel = await getRequisitionDetail({
        orgId: fx.orgId,
        actorId: fx.actorId,
        requisitionId: opened.id,
      });
      for (const key of ["screening", "interview", "offer"]) {
        const stage = funnel.stages.find((entry) => entry.key === key)!;
        await moveApplicationStage({
          orgId: fx.orgId,
          actorId: fx.actorId,
          applicationId: application.id,
          toStageId: stage.id,
        });
      }
      const offer = await createOffer({
        orgId: fx.orgId,
        actorId: fx.actorId,
        applicationId: application.id,
        employerSubsidiaryId: fx.rootSubsidiaryId,
        jobTitle: "Backend engineer",
        proposedStartOn: "2026-10-01",
        compensationAmount: "120000",
        compensationCurrency: "USD",
        compensationBasis: "annual",
        expiresOn: "2026-12-31",
      });
      await sendOffer({ orgId: fx.orgId, actorId: fx.actorId, offerId: offer.id });
      const hire = await acceptOfferAsHire({
        orgId: fx.orgId,
        actorId: fx.actorId,
        offerId: offer.id,
      });
      assert.equal(await employmentOf(fx, partyId), hire.employmentId);
      const audit = (
        await db.execute<{ n: number }>(
          sql`
        select count(*)::int as n from audit_log
         where org_id = ${fx.orgId} and table_name = 'employee_payroll_profiles'
           and action = 'update'`,
          "objects",
        )
      )[0]!.n;
      assert.equal(audit, 1);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  });

  test("readiness clears once the NULL-subsidiary profile is linked", async () => {
    const fx = await org();
    try {
      const partyId = await party(fx, "Ready Rita", null);
      const employmentId = await employment(fx, partyId, fx.rootSubsidiaryId);
      const scheduleId = await profile(fx, "sched", partyId, employmentId);
      const run = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: scheduleId,
        periodStart: "2026-07-05",
        periodEnd: "2026-07-18",
        payDate: "2026-07-21",
      });
      const readiness = await payRunReadiness(fx.orgId, run.documentId);
      const blockers = readiness.items.filter((item) => item.code === "employee.noEmployment");
      assert.deepEqual(blockers, []);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  });
});
