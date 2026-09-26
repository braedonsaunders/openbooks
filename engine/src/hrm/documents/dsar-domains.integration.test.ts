import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../../testing/fixtures.ts";
import { encryptRespondentLink } from "../surveys/responses.ts";
import { storeCabinetFile } from "./cabinet.ts";
import { buildExport, downloadExport, listExports, requestExport } from "./dsar.ts";

/**
 * C-79 behavioural coverage (integration partition): an export for a
 * subject with data in every new domain carries them all — recruiting
 * (candidate through panel), qualifications, compensation statements,
 * attributable survey responses, raw clock events with geo and photo —
 * and the manifest lists every gathered domain plus the reviewed
 * exclusions. The zip is read back with the platform unzipper, the same
 * independent oracle as the zip-store suite.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

type Harness = {
  org: ScratchOrg;
  adminId: string;
  partyId: string;
  employmentId: string;
  otherPartyId: string;
};

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  for (const feature of ["hrm", "hrmDocuments", "hrmDataSubjectExport"]) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), ${`{features,${feature}}`}::text[], 'true'::jsonb, true)
       where id = ${org.orgId}
    `);
  }
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, email, is_active, custom)
    values (${partyId}, ${org.orgId}, 'person', 'Sam Subject', 'sam@scratch.test', true, '{}'::jsonb)
  `);
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${org.orgId}, ${partyId}, ${org.subsidiaryId}, 1)
  `);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
    values (${org.orgId}, ${employmentId}, 1, 'active', '2020-01-01'::date, null, now())
  `);
  const otherPartyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${otherPartyId}, ${org.orgId}, 'person', 'Ivy Interviewer', true, '{}'::jsonb)
  `);
  const adminId = await createScratchUser(org.orgId, "Ada Admin", "dsar_dom_admin");
  await db.execute(sql`
    update app_roles
       set permissions = '["hrm.documents.read", "hrm.documents.manage"]'::jsonb,
           subsidiary_restriction = '{"mode": "all"}'::jsonb
     where org_id = ${org.orgId} and key = 'dsar_dom_admin'`);
  return { org, adminId, partyId, employmentId, otherPartyId };
}

async function seedRecruiting(h: Harness): Promise<void> {
  const { org } = h;
  const requisitionId = randomUUID();
  await db.execute(sql`
    insert into hrm_requisitions (id, org_id, requisition_number, title, employer_subsidiary_id, headcount)
    values (${requisitionId}, ${org.orgId}, 'REQ-1', 'Engineer', ${org.subsidiaryId}, 1)
  `);
  const templateId = randomUUID();
  await db.execute(sql`
    insert into hrm_pipeline_templates (id, org_id, name) values (${templateId}, ${org.orgId}, 'Standard')
  `);
  const stageId = randomUUID();
  await db.execute(sql`
    insert into hrm_pipeline_stages (id, org_id, template_id, position, key, name, kind)
    values (${stageId}, ${org.orgId}, ${templateId}, 0, 'screen', 'Screen', 'screening')
  `);
  const candidateId = randomUUID();
  await db.execute(sql`
    insert into hrm_candidates (id, org_id, party_id, display_name, email)
    values (${candidateId}, ${org.orgId}, ${h.partyId}, 'Sam Subject', 'sam@scratch.test')
  `);
  await db.execute(sql`
    insert into hrm_candidate_consents (org_id, candidate_id, purpose, source)
    values (${org.orgId}, ${candidateId}, 'this_application', 'form')
  `);
  const applicationId = randomUUID();
  await db.execute(sql`
    insert into hrm_applications (id, org_id, requisition_id, candidate_id, stage_id, applied_on)
    values (${applicationId}, ${org.orgId}, ${requisitionId}, ${candidateId}, ${stageId}, '2026-01-05'::date)
  `);
  await db.execute(sql`
    insert into hrm_application_events (org_id, application_id, kind) values (${org.orgId}, ${applicationId}, 'applied')
  `);
  const interviewId = randomUUID();
  await db.execute(sql`
    insert into hrm_interviews (id, org_id, application_id, kind, scheduled_at)
    values (${interviewId}, ${org.orgId}, ${applicationId}, 'phone', now())
  `);
  const scorecardId = randomUUID();
  await db.execute(sql`
    insert into hrm_scorecards (id, org_id, interview_id, interviewer_party_id, overall, submitted_at)
    values (${scorecardId}, ${org.orgId}, ${interviewId}, ${h.otherPartyId}, 'yes', now())
  `);
  const kitId = randomUUID();
  await db.execute(sql`
    insert into hrm_interview_kits (id, org_id, name) values (${kitId}, ${org.orgId}, 'Phone screen')
  `);
  const attributeId = randomUUID();
  await db.execute(sql`
    insert into hrm_scorecard_attributes (id, org_id, kit_id, category, attribute, position)
    values (${attributeId}, ${org.orgId}, ${kitId}, 'skill', 'communication', 0)
  `);
  await db.execute(sql`
    insert into hrm_scorecard_ratings (org_id, scorecard_id, attribute_id, rating_key)
    values (${org.orgId}, ${scorecardId}, ${attributeId}, 'yes')
  `);
  const offerId = randomUUID();
  await db.execute(sql`
    insert into hrm_offers (id, org_id, application_id, employer_subsidiary_id, job_title,
                            proposed_start_on, compensation_amount, compensation_currency, compensation_basis)
    values (${offerId}, ${org.orgId}, ${applicationId}, ${org.subsidiaryId}, 'Engineer',
            '2026-03-01'::date, 100000, 'USD', 'annual')
  `);
  await db.execute(sql`
    insert into hrm_offer_versions (org_id, offer_id, version, payload)
    values (${org.orgId}, ${offerId}, 1, '{}'::jsonb)
  `);
  const poolId = randomUUID();
  await db.execute(sql`
    insert into hrm_talent_pools (id, org_id, name) values (${poolId}, ${org.orgId}, 'Engineering')
  `);
  await db.execute(sql`
    insert into hrm_talent_pool_members (org_id, pool_id, candidate_id, note)
    values (${org.orgId}, ${poolId}, ${candidateId}, 'strong phone screen')
  `);
  await db.execute(sql`
    insert into hrm_interview_panel (org_id, interview_id, party_id)
    values (${org.orgId}, ${interviewId}, ${h.otherPartyId})
  `);
}

async function seedQualifications(h: Harness): Promise<void> {
  const typeId = randomUUID();
  await db.execute(sql`insert into hrm_qualification_types (id, org_id, code, name, category) values (${typeId}, ${h.org.orgId}, 'LIC', 'License', 'license')`);
  const qualificationId = randomUUID();
  await db.execute(sql`insert into hrm_worker_qualifications (id, org_id, employment_id, type_id, issued_on) values (${qualificationId}, ${h.org.orgId}, ${h.employmentId}, ${typeId}, '2025-06-01'::date)`);
  await db.execute(sql`insert into hrm_qualification_events (org_id, qualification_id, kind) values (${h.org.orgId}, ${qualificationId}, 'recorded')`);
}

async function seedPartyExtras(h: Harness): Promise<void> {
  await db.execute(sql`insert into addresses (org_id, party_id, label, line1, city, country) values (${h.org.orgId}, ${h.partyId}, 'home', '1 Main St', 'Toronto', 'CA')`);
  await db.execute(sql`insert into contacts (org_id, party_id, name, email) values (${h.org.orgId}, ${h.partyId}, 'Sam Subject', 'sam@scratch.test')`);
}

async function seedStatement(h: Harness): Promise<string> {
  const { org } = h;
  const statementId = randomUUID();
  await db.execute(sql`
    insert into hrm_comp_statements (id, org_id, employment_id, period_from, period_to, payload)
    values (${statementId}, ${org.orgId}, ${h.employmentId}, '2026-01-01'::date, '2026-12-31'::date, '{}'::jsonb)
  `);
  const { fileId } = await storeCabinetFile(db, {
    orgId: org.orgId,
    recordTable: "hrm_comp_statements",
    recordId: statementId,
    groupLabel: "HR Statements",
    filename: "statement.pdf",
    contentType: "application/pdf",
    bytes: Buffer.from("%PDF-1.4 statement"),
    createdBy: null,
    viewerUserIds: [h.adminId],
  });
  await db.execute(sql`
    update hrm_comp_statements set file_id = ${fileId} where org_id = ${org.orgId} and id = ${statementId}
  `);
  return statementId;
}

async function seedSurvey(h: Harness): Promise<void> {
  const surveyId = randomUUID();
  await db.execute(sql`insert into hrm_surveys (id, org_id, name, kind, anonymity, status) values (${surveyId}, ${h.org.orgId}, 'Engagement', 'engagement', 'confidential', 'open')`);
  await db.execute(sql`insert into hrm_survey_invitations (org_id, survey_id, party_id, token_hash) values (${h.org.orgId}, ${surveyId}, ${h.partyId}, ${randomUUID()})`);
  // 0363 requires one answer per question id: the seeded answer names its
  // question instead of the bare legacy shape.
  await db.execute(sql`insert into hrm_survey_responses (org_id, survey_id, respondent_link_enc, answers) values (${h.org.orgId}, ${surveyId}, ${encryptRespondentLink(h.org.orgId, h.partyId)}, '[{"questionId": "engagement-1", "a": 1}]'::jsonb)`);
}

async function seedClock(h: Harness): Promise<void> {
  const eventId = randomUUID();
  await db.execute(sql`insert into time_clock_events (id, org_id, employee_party_id, kind, occurred_at, client_event_id, geo) values (${eventId}, ${h.org.orgId}, ${h.partyId}, 'clock_in', now(), ${randomUUID()}, '{"lat": 1}'::jsonb)`);
  const { fileId } = await storeCabinetFile(db, {
    orgId: h.org.orgId, recordTable: "time_clock_events", recordId: eventId, groupLabel: "HR Clock",
    filename: "photo.jpg", contentType: "image/jpeg", bytes: Buffer.from("fake-photo-bytes"),
    createdBy: null, viewerUserIds: [h.adminId],
  });
  await db.execute(sql`update time_clock_events set photo_file_id = ${fileId} where org_id = ${h.org.orgId} and id = ${eventId}`);
}

async function seedPayrollIdentity(h: Harness): Promise<void> {
  const { org } = h;
  const scheduleId = randomUUID();
  await db.execute(sql`insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end) values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-01-09'::date)`);
  await db.execute(sql`insert into employee_payroll_profiles (org_id, employee_party_id, employment_id, pay_schedule_id, country, province, sin_encrypted, sin_last3, es_contrato_temporal, br_salario_familia_filhos) values (${org.orgId}, ${h.partyId}, ${h.employmentId}, ${scheduleId}, 'CA', 'ON', 'sealed-envelope-bytes', '123', 'false', 2)`);
  await db.execute(sql`insert into payroll_work_location_allocations (org_id, employment_id, period_start, period_end, region, subregion, service_days, source, change_reason) values (${org.orgId}, ${h.employmentId}, '2026-01-01'::date, '2026-01-31'::date, 'ON', 'Toronto', 20, 'hr_records', 'seed')`);
  await db.execute(sql`insert into payroll_roe_separation_events (org_id, employee_party_id, interruption_on, last_insurable_earnings_on, status, change_reason) values (${org.orgId}, ${h.partyId}, '2026-03-31'::date, '2026-03-28'::date, 'confirmed', 'layoff')`);
  await db.execute(sql`insert into pay_components (org_id, code, name, kind, basis, value, taxable, pensionable, insurable, vacationable, non_periodic, tax_treatment, sequence, protection_base, protection_priority, include_in_disposable_earnings, program_exclusions, is_active) values (${org.orgId}, 'ROE_SEV', 'Severance', 'earning', 'fixed_amount', 1000, true, true, true, false, false, 'none', 1, 'none', 0, true, '{}'::text[], true)`);
  await db.execute(sql`insert into payroll_roe_separation_payments (org_id, separation_event_id, pay_component_id, amount, payment_status, expected_payment_on, change_reason) values (${org.orgId}, (select id from payroll_roe_separation_events where org_id = ${org.orgId} and employee_party_id = ${h.partyId}), (select id from pay_components where org_id = ${org.orgId} and code = 'ROE_SEV'), 2500, 'will_pay', '2026-04-15'::date, 'severance')`);
  await db.execute(sql`insert into it_addizionali_opening_balances (org_id, employee_party_id, tax_year, regionale_saldo, comunale_saldo) values (${org.orgId}, ${h.partyId}, 2025, 100.50, 25.25)`);
  await db.execute(sql`insert into employee_tax_certificates (org_id, employee_party_id, employment_id, country, certificate_key, answers, effective_from) values (${org.orgId}, ${h.partyId}, ${h.employmentId}, 'CA', 'ca_td1_ON', '{"total_claim_amount": "15000.0000"}'::jsonb, '2026-01-01'::date)`);
}

async function seedPerformance(h: Harness): Promise<void> {
  const templateId = randomUUID();
  await db.execute(sql`insert into hrm_review_templates (id, org_id, name) values (${templateId}, ${h.org.orgId}, 'Annual')`);
  const cycleId = randomUUID();
  await db.execute(sql`insert into hrm_review_cycles (id, org_id, template_id, name, period_start_on, period_end_on) values (${cycleId}, ${h.org.orgId}, ${templateId}, '2026', '2026-01-01'::date, '2026-12-31'::date)`);
  const reviewId = randomUUID();
  await db.execute(sql`insert into hrm_reviews (id, org_id, cycle_id, employment_id, subject_party_id, reviewer_party_id, kind, status, shared_at, submitted_at) values (${reviewId}, ${h.org.orgId}, ${cycleId}, ${h.employmentId}, ${h.partyId}, ${h.partyId}, 'self', 'shared', now(), now())`);
  await db.execute(sql`insert into hrm_review_answers (org_id, review_id, section_title, question_prompt, position, answer_kind, text) values (${h.org.orgId}, ${reviewId}, 'Impact', 'What shipped?', 0, 'text', 'Everything')`);
  const goalId = randomUUID();
  await db.execute(sql`insert into hrm_goals (id, org_id, employment_id, title) values (${goalId}, ${h.org.orgId}, ${h.employmentId}, 'Ship')`);
  await db.execute(sql`insert into hrm_goal_updates (org_id, goal_id, progress_percent, note) values (${h.org.orgId}, ${goalId}, 50, 'halfway')`);
}

async function seedEmploymentExtras(h: Harness): Promise<void> {
  const templateId = randomUUID();
  await db.execute(sql`insert into hrm_process_templates (id, org_id, kind, name) values (${templateId}, ${h.org.orgId}, 'onboarding', 'Onboarding')`);
  const processId = randomUUID();
  await db.execute(sql`insert into hrm_processes (id, org_id, template_id, employment_id, kind, effective_date) values (${processId}, ${h.org.orgId}, ${templateId}, ${h.employmentId}, 'onboarding', '2026-01-05'::date)`);
  await db.execute(sql`insert into hrm_process_steps (org_id, process_id, position, title, owner_kind, due_on) values (${h.org.orgId}, ${processId}, 0, 'Read the handbook', 'employee', '2026-01-12'::date)`);
  await db.execute(sql`insert into employee_roles (org_id, party_id, birth_date, job_title) values (${h.org.orgId}, ${h.partyId}, '1990-05-01'::date, 'Engineer')`);
  const managerEmploymentId = randomUUID();
  await db.execute(sql`insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision) values (${managerEmploymentId}, ${h.org.orgId}, ${h.otherPartyId}, ${h.org.subsidiaryId}, 1)`);
  await db.execute(sql`insert into reporting_relationships (org_id, employment_id, manager_employment_id, relationship_id, effective_from) values (${h.org.orgId}, ${h.employmentId}, ${managerEmploymentId}, ${randomUUID()}, '2026-01-01'::date)`);
}

test("an export carries every new domain and the manifest names them all", { skip: !DB }, async () => {
  if (!DB) return;
  const h = await setupHarness();
  try {
    await seedRecruiting(h);
    await seedQualifications(h);
    await seedStatement(h);
    await seedSurvey(h);
    await seedClock(h);
    await seedPartyExtras(h);
    await seedEmploymentExtras(h);
    await seedPayrollIdentity(h);
    await seedPerformance(h);
    const prior = await requestExport({ orgId: h.org.orgId, actorId: h.adminId, partyId: h.partyId });
    const requested = await requestExport({ orgId: h.org.orgId, actorId: h.adminId, partyId: h.partyId });
    await buildExport(h.org.orgId, requested.id);
    const listed = await listExports({ orgId: h.org.orgId, actorId: h.adminId, partyId: h.partyId });
    const built = listed.find((e) => e.id === requested.id);
    assert.equal(built?.status, "ready", `export failed, error: ${built?.error}, scope: ${JSON.stringify(built?.scope)}`);
    const { bytes } = await downloadExport({ orgId: h.org.orgId, actorId: h.adminId, exportId: requested.id });
    const dir = mkdtempSync(join(tmpdir(), "dsar-dom-"));
    const path = join(dir, "export.zip");
    writeFileSync(path, bytes);
    const manifest = JSON.parse(execFileSync("unzip", ["-p", path, "export.json"], { encoding: "utf8" })) as {
      candidates: unknown[];
      applications: unknown[];
      interviews: unknown[];
      scorecards: unknown[];
      scorecardRatings: unknown[];
      offers: unknown[];
      qualifications: unknown[];
      compStatements: unknown[];
      surveyInvitations: unknown[];
      surveyResponses: unknown[];
      clockEvents: unknown[];
      addresses: unknown[];
      contacts: unknown[];
      processSteps: unknown[];
      employeeRoles: unknown[];
      reportingRelationships: unknown[];
      taxCertificates: { certificate_key: string }[];
      payrollProfiles: Record<string, unknown>[];
      workLocationAllocations: Record<string, unknown>[];
      roeSeparationEvents: Record<string, unknown>[];
      roeSeparationPayments: Record<string, unknown>[];
      itAddizionaliOpeningBalances: Record<string, unknown>[];
      goals: unknown[];
      reviews: unknown[];
      reviewAnswers: unknown[];
      priorExports: { id: string }[];
      manifest: { gathered: { module: string; status: string }[]; excluded: { table: string; reason: string }[] };
    };
    for (const [key, want] of [
      ["candidates", 1],
      ["applications", 1],
      ["interviews", 1],
      ["scorecards", 1],
      ["scorecardRatings", 1],
      ["offers", 1],
      ["qualifications", 1],
      ["compStatements", 1],
      ["surveyInvitations", 1],
      ["surveyResponses", 1],
      ["clockEvents", 1],
      ["addresses", 1],
      ["contacts", 1],
      ["processSteps", 1],
      ["employeeRoles", 1],
      ["reportingRelationships", 1],
      ["goals", 1],
      ["reviews", 1],
      ["reviewAnswers", 1],
    ] as const) {
      assert.equal(
        (manifest[key] as unknown[]).length,
        want,
        `${key} must carry the seeded row`,
      );
    }
    const priorIds = manifest.priorExports.map((e) => e.id);
    assert.ok(priorIds.includes(prior.id), "the ledger carries the earlier export, never its bytes");
    assert.deepEqual(manifest.taxCertificates.map((c) => c.certificate_key), ["ca_td1_ON"]);
    const profile = manifest.payrollProfiles[0] ?? {};
    assert.equal(profile.sin_last3, "123");
    assert.ok(!("sin_encrypted" in profile), "the sealed SIN envelope is never exported");
    assert.equal(profile.es_contrato_temporal, "false");
    assert.equal(profile.br_salario_familia_filhos, 2);
    assert.deepEqual(manifest.workLocationAllocations.map((r) => r.region), ["ON"]);
    assert.deepEqual(manifest.roeSeparationEvents.map((r) => r.status), ["confirmed"]);
    assert.deepEqual(manifest.roeSeparationPayments.map((r) => r.amount), ["2500.0000"]);
    assert.deepEqual(manifest.itAddizionaliOpeningBalances.map((r) => r.tax_year), [2025]);
    const gathered = new Map(manifest.manifest.gathered.map((g) => [g.module, g.status]));
    for (const module of ["recruiting", "qualifications", "statements", "surveys", "clock_events", "exports"]) {
      assert.equal(gathered.get(module), "included", `${module} must be gathered`);
    }
    assert.ok(
      manifest.manifest.excluded.some((e) => e.table === "worker_clock_pins" && e.reason.length > 0),
      "the manifest names the reviewed exclusions",
    );
    const listing = execFileSync("unzip", ["-l", path], { encoding: "utf8" });
    assert.match(listing, /statements\//);
    assert.match(listing, /clock-photos\//);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});
