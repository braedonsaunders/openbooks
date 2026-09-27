/**
 * Shared integration-test harness for the HRM domain and its neighbors
 * (inbox, automations, close). Dozens of suites redefined the same
 * scratch-org/user/grant/seeding helpers; this module is their single home.
 *
 * Every helper below preserves the majority copy's exact storage behavior;
 * where copies differed, the difference is a parameter whose default is the
 * majority shape. Helpers that only look alike but seed different domains
 * stay separate functions so no call site changes meaning by importing this.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { HRM_CHANGE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-change-requests.ts";
import { HRM_LEAVE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-leave.ts";
import { db, withBypassContext, withOrgTransaction } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedApprovalFlow,
  seedFlowActors,
  type ScratchOrg,
} from "./fixtures.ts";
import { ensureCloseDefaults } from "../close/defaults.ts";
import { createJobFamily, createJobLevel } from "../hrm/compensation/architecture.ts";
import { supersedeLaborCostRate } from "../projects/labor-cost-rates.ts";
import { RecruitingError } from "../hrm/recruiting/errors.ts";
import { HrmPerformanceError } from "../hrm/performance/errors.ts";
import { FieldTimeError } from "../hrm/field-time/errors.ts";
import { createRequisition, openRequisition } from "../hrm/recruiting/requisitions.ts";
import { createCandidate } from "../hrm/recruiting/candidates.ts";
import { createApplication } from "../hrm/recruiting/applications.ts";
import { createOffer, sendOffer } from "../hrm/recruiting/offers.ts";
import { createOfferTemplate, renderOfferVersion, sendOfferLink } from "../hrm/recruiting/offers-signing.ts";

/** True when the integration partition has a database to run against. */
export const DB = !!process.env.OPENBOOKS_DB_URL;

/** ISO timestamp for seeded rows that need one. */
export const nowIso = (): string => new Date().toISOString();

/**
 * Direct permission grants. The single-permission form is the minority
 * spelling; the majority takes an array, which stays the default shape.
 */
export async function grantPermissions(
  orgId: string,
  userId: string,
  permissions: readonly string[],
): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

/** Same grant as {@link grantPermissions}; accepts one permission or many. */
export async function grant(
  orgId: string,
  userId: string,
  permissions: string | readonly string[],
): Promise<void> {
  await grantPermissions(orgId, userId, Array.isArray(permissions) ? permissions : [permissions]);
}

/**
 * Link a user to a freshly minted person party. The minority copies pass an
 * explicit display name; the majority mints `Person <id prefix>`.
 */
export async function linkPerson(orgId: string, userId: string, name?: string): Promise<string> {
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${partyId}, ${orgId}, 'person', ${name ?? `Person ${partyId.slice(0, 8)}`}, true, '{}'::jsonb)
  `);
  await db.execute(sql`update users set party_id = ${partyId} where id = ${userId} and org_id = ${orgId}`);
  return partyId;
}

/**
 * Open the HRM feature flag, plus any extra feature keys the suite needs
 * (documents, retention, performance, and calibration suites pass theirs).
 */
export async function enableHrm(orgId: string, ...extraFeatures: string[]): Promise<void> {
  for (const feature of ["hrm", ...extraFeatures]) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), ${`{features,${feature}}`}::text[], 'true'::jsonb, true)
       where id = ${orgId}`);
  }
}

/** Open an explicit feature list; defaults to just HRM. */
export async function enableFeatures(orgId: string, keys: readonly string[] = ["hrm"]): Promise<void> {
  for (const feature of keys) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), ${`{features,${feature}}`}::text[], 'true'::jsonb, true)
       where id = ${orgId}
    `);
  }
}

/**
 * Merge a feature map into org settings in one statement (the automations
 * spelling; equivalent in effect to enabling each key in a loop).
 */
export async function setFeatures(orgId: string, features: Record<string, boolean>): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(
         coalesce(settings, '{}'::jsonb), '{features}',
         coalesce(settings -> 'features', '{}'::jsonb) || ${JSON.stringify(features)}::jsonb
       )
     where id = ${orgId}
  `);
}

/** Construction suites: shared feature list plus the US home country. */
export async function enableConstruction(orgId: string): Promise<void> {
  await enableFeatures(orgId, [
    "hrm",
    "payroll",
    "projects",
    "timeTracking",
    "hrmConstructionCompliance",
  ]);
  await db.execute(sql`update orgs set country = 'US' where id = ${orgId}`);
}

/** Merge a patch into the org's compensation settings subtree. */
export async function setCompensationSettings(
  orgId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const current = (await db.execute<{ settings: Record<string, unknown> }>(sql`
    select settings from orgs where id = ${orgId}`)).rows[0]?.settings ?? {};
  const next = {
    ...(current as Record<string, unknown>),
    compensation: { ...((current as Record<string, unknown>).compensation as Record<string, unknown> ?? {}), ...patch },
  };
  await db.execute(sql`update orgs set settings = ${JSON.stringify(next)}::jsonb where id = ${orgId}`);
}

/**
 * Narrow a role to subsidiaries, optionally replacing its permission set.
 * A null permission set keeps the minority leave-on-behalf spelling, which
 * restricts scope without touching permissions. The documents subsidiary
 * copy opens one role to every subsidiary, which travels as `"all"`.
 */
export async function scopeRole(
  orgId: string,
  roleKey: string,
  permissions: string[] | null,
  subsidiaryIds: string[] | "all",
): Promise<void> {
  const restriction = subsidiaryIds === "all" ? { mode: "all" } : { mode: "list", subsidiaryIds };
  if (permissions === null) {
    await db.execute(sql`
      update app_roles
         set subsidiary_restriction = ${JSON.stringify(restriction)}::jsonb
       where org_id = ${orgId} and key = ${roleKey}`);
    return;
  }
  await db.execute(sql`
    update app_roles
       set permissions = ${JSON.stringify(permissions)}::jsonb,
           subsidiary_restriction = ${JSON.stringify(restriction)}::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
}

/**
 * Restrict a role to subsidiaries. Accepts either the subsidiary list (the
 * majority spelling, which leaves permissions alone) or a full restriction
 * object with an explicit permission set (the scoped performance and
 * compensation suites).
 */
export async function restrictRole(
  orgId: string,
  roleKey: string,
  subsidiaryIds: string[] | Record<string, unknown>,
  permissions?: string[],
): Promise<void> {
  const restriction = Array.isArray(subsidiaryIds)
    ? { mode: "list", subsidiaryIds }
    : subsidiaryIds;
  if (permissions === undefined) {
    await db.execute(sql`
      update app_roles
         set subsidiary_restriction = ${JSON.stringify(restriction)}::jsonb
       where org_id = ${orgId} and key = ${roleKey}`);
    return;
  }
  await db.execute(sql`
    update app_roles
       set permissions = ${JSON.stringify(permissions)}::jsonb,
           subsidiary_restriction = ${JSON.stringify(restriction)}::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
}

/** Project row. */
export async function seedProject(orgId: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into projects (id, org_id, name, status) values (${id}, ${orgId}, ${name}, 'active')
  `);
  return id;
}

/** FX spot rate. */
export async function seedFx(
  orgId: string,
  from: string,
  to: string,
  asOf: string,
  rate: string,
  source = "manual",
): Promise<void> {
  await db.execute(sql`
    insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
    values (${orgId}, ${from}, ${to}, ${asOf}::date, 'spot', ${rate}, ${source})
  `);
}

/** Department row. */
export async function mkDepartment(orgId: string, name: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into departments (org_id, name) values (${orgId}, ${name}) returning id`)).rows[0]!.id;
}

/** Grant a role exactly the employment-read permission. */
export async function grantRead(orgId: string, roleKey: string): Promise<void> {
  await db.execute(sql`
    update app_roles set permissions = '["hrm.employment.read"]'::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
}

/**
 * Add a second legal entity under the scratch root. The majority seeds
 * CAD/CA; the documents suites need USD/US, so currency travels as a
 * parameter with the majority as default.
 */
export async function mkSecondSubsidiary(
  orgId: string,
  parentId: string,
  opts: { currency?: string; country?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${id}, ${orgId}, ${parentId}, 'Second Co', ${opts.currency ?? "CAD"}, ${opts.country ?? "CA"}, '{}'::jsonb, false, true, '{}'::jsonb)`);
  return id;
}

export type EmploymentVersionSeed = {
  status?: string;
  from?: string;
  to?: string | null;
  versionNo?: number;
  recordedAt?: string | null;
};

/**
 * Bare employment row. The majority inserts no version; the performance
 * minority needs one, so it travels as an option with the majority default
 * (no version row). Only the requested version columns are written, so each
 * call site stores exactly the row shape its copy stored.
 */
export async function mkEmployment(
  orgId: string,
  workerPartyId: string,
  subsidiaryId: string,
  version: EmploymentVersionSeed | null = null,
): Promise<string> {
  const employmentId = (await db.execute<{ id: string }>(sql`
    insert into worker_employments (org_id, worker_party_id, employer_subsidiary_id)
    values (${orgId}, ${workerPartyId}, ${subsidiaryId}) returning id`)).rows[0]!.id;
  if (version) {
    await mkVersion(orgId, employmentId, version);
  }
  return employmentId;
}

export type EmploymentSeedOptions = {
  workerPartyId?: string;
  displayName?: string;
  status?: string;
  from?: string;
  to?: string | null;
  withVersion?: boolean;
};

/**
 * Employment with a fresh person party. The richest copy (benefits/leave)
 * takes worker/status/window options and always writes a version row; the
 * simpler copies skip the version or the window, so those travel as options.
 * Returns both ids; call sites that only need the employment take
 * `.employmentId`.
 */
export async function seedEmployment(
  orgId: string,
  subsidiaryId: string,
  opts: EmploymentSeedOptions = {},
): Promise<{ employmentId: string; workerPartyId: string }> {
  const workerPartyId = opts.workerPartyId ?? randomUUID();
  if (!opts.workerPartyId) {
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${workerPartyId}, ${orgId}, 'person', ${opts.displayName ?? "Seed Worker"}, true, '{}'::jsonb)
    `);
  }
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${workerPartyId}, ${subsidiaryId}, 1)
  `);
  if (opts.withVersion !== false) {
    await db.execute(sql`
      insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
      values (${orgId}, ${employmentId}, 1, ${opts.status ?? "active"}, ${opts.from ?? "2020-01-01"}::date, ${opts.to ?? null}::date, now())
    `);
  }
  return { employmentId, workerPartyId };
}

/** Minimal person party; the RLS-scoped migration copy stays local there. */
export async function mkParty(orgId: string, name: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into parties (org_id, kind, display_name)
    values (${orgId}, 'person', ${name}) returning id`)).rows[0]!.id;
}

/**
 * One employment version row. Copies disagreed on arity (version number,
 * window end, recorded-at); every column is optional with the majority
 * default, and only the requested columns are written.
 */
export async function mkVersion(
  orgId: string,
  employmentId: string,
  opts: EmploymentVersionSeed = {},
): Promise<void> {
  const status = opts.status ?? "active";
  const from = opts.from ?? "2020-01-01";
  const versionNo = opts.versionNo ?? 1;
  const recordedAt = opts.recordedAt === undefined
    ? undefined
    : opts.recordedAt === null ? sql`now()` : sql`${opts.recordedAt}::timestamptz`;
  if (recordedAt !== undefined && opts.to !== undefined) {
    await db.execute(sql`
      insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
      values (${orgId}, ${employmentId}, ${versionNo}, ${status}, ${from}::date, ${opts.to}::date, ${recordedAt})`);
    return;
  }
  if (recordedAt !== undefined) {
    await db.execute(sql`
      insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, recorded_at)
      values (${orgId}, ${employmentId}, ${versionNo}, ${status}, ${from}::date, ${recordedAt})`);
    return;
  }
  if (opts.to !== undefined) {
    await db.execute(sql`
      insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to)
      values (${orgId}, ${employmentId}, ${versionNo}, ${status}, ${from}::date, ${opts.to}::date)`);
    return;
  }
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from)
    values (${orgId}, ${employmentId}, ${versionNo}, ${status}, ${from}::date)`);
}

/** Line reporting relationship; the window start is almost always 2020. */
export async function mkReporting(
  orgId: string,
  employmentId: string,
  managerEmploymentId: string,
  from = "2020-01-01",
): Promise<void> {
  await db.execute(sql`
    insert into reporting_relationships
      (org_id, employment_id, manager_employment_id, kind, relationship_id, version_no, effective_from)
    values (${orgId}, ${employmentId}, ${managerEmploymentId}, 'line', ${randomUUID()}, 1, ${from}::date)
  `);
}

/**
 * HR user with a linked party and a scoped manage role. The permission set
 * differs per suite (performance vs retention), so it is a parameter.
 */
export async function mkHr(
  orgId: string,
  name: string,
  roleKey: string,
  subsidiaryIds: string[] | null,
  permissions: string[],
): Promise<string> {
  const userId = await createScratchUser(orgId, name, roleKey);
  await linkPerson(orgId, userId);
  await db.execute(sql`
    update app_roles
       set permissions = ${JSON.stringify(permissions)}::jsonb,
           subsidiary_restriction = ${subsidiaryIds === null ? JSON.stringify({ mode: "all" }) : JSON.stringify({ mode: "list", subsidiaryIds })}::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
  return userId;
}

/**
 * Person with an active employment (documents shape). The party email
 * derives from the display name exactly like the copies did. The migration
 * seeder of the same name works a different table set and stays local to
 * its file.
 */
export async function seedPerson(
  orgId: string,
  subsidiaryId: string,
  name: string,
): Promise<{ partyId: string; employmentId: string }> {
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, email, is_active, custom)
    values (${partyId}, ${orgId}, 'person', ${name}, ${`${name.replaceAll(" ", ".").toLowerCase()}@scratch.test`}, true, '{}'::jsonb)
  `);
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${partyId}, ${subsidiaryId}, 1)
  `);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
    values (${orgId}, ${employmentId}, 1, 'active', '2020-01-01'::date, null, now())
  `);
  return { partyId, employmentId };
}

/**
 * Named worker with an active employment (construction shape, also used by
 * qualifications). Returns the party under `partyId`, matching those suites'
 * destructuring.
 */
export async function seedNamedWorker(
  orgId: string,
  subsidiaryId: string,
  name: string,
): Promise<{ employmentId: string; partyId: string }> {
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${partyId}, ${orgId}, 'person', ${name}, true, '{}'::jsonb)
  `);
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${partyId}, ${subsidiaryId}, 1)
  `);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
    values (${orgId}, ${employmentId}, 1, 'active', '2020-01-01'::date, null, now())
  `);
  return { employmentId, partyId };
}

export type ReviewTemplateSeed = {
  name?: string;
  /** Rating-scale labels; null omits the labels key, as one suite's scale does. */
  scaleLabels?: string[] | null;
  /** Append the free-text second question one suite's template carries. */
  extraTextQuestion?: boolean;
};

/**
 * Annual review template with one competency section and one rating
 * question. Name, scale labels, and the extra question differ per suite and
 * travel as options with the majority as default.
 */
export async function mkReviewTemplate(
  orgId: string,
  actorId: string,
  opts: ReviewTemplateSeed = {},
): Promise<string> {
  const scale = opts.scaleLabels === null
    ? '{"min": 1, "max": 5}'
    : JSON.stringify({ min: 1, max: 5, labels: opts.scaleLabels ?? ["low", "high"] });
  const templateId = (await db.execute<{ id: string }>(sql`
    insert into hrm_review_templates (org_id, name, rating_scale, created_by, updated_by)
    values (${orgId}, ${opts.name ?? "Annual"}, ${scale}::jsonb, ${actorId}, ${actorId})
    returning id`)).rows[0]!.id;
  const sectionId = (await db.execute<{ id: string }>(sql`
    insert into hrm_review_template_sections (org_id, template_id, position, title, kind, created_by, updated_by)
    values (${orgId}, ${templateId}, 0, 'Impact', 'competency', ${actorId}, ${actorId})
    returning id`)).rows[0]!.id;
  await db.execute(sql`
    insert into hrm_review_template_questions
      (org_id, section_id, position, prompt, answer_kind, required, created_by, updated_by)
    values (${orgId}, ${sectionId}, 0, 'Customer impact', 'rating_and_text', true, ${actorId}, ${actorId})
  `);
  if (opts.extraTextQuestion) {
    await db.execute(sql`
      insert into hrm_review_template_questions
        (org_id, section_id, position, prompt, answer_kind, required, created_by, updated_by)
      values (${orgId}, ${sectionId}, 1, 'Notes', 'text', false, ${actorId}, ${actorId})
    `);
  }
  return templateId;
}

/** A seeded job level under a fresh Engineering family. */
export async function seedLevel(orgId: string, hrId: string): Promise<string> {
  const family = await createJobFamily({ orgId, actorId: hrId, code: "ENG", name: "Engineering" });
  const level = await createJobLevel({
    orgId,
    actorId: hrId,
    familyId: family.id,
    code: "IC3",
    name: "Engineer III",
    rank: 3,
    equalValueCriteria: [
      { criterion: "skills", weight: "3" },
      { criterion: "effort", weight: "2" },
      { criterion: "responsibility", weight: "3" },
      { criterion: "working_conditions", weight: "1" },
    ],
  });
  return level.id;
}

export type WageSeedOptions = {
  currency?: string;
  basis?: "hour" | "year";
  annualHours?: string;
  from?: string;
  reason?: string;
};

/**
 * Labor-cost rate through the canonical writer. The richest copy takes
 * currency/basis/hours/window options; the simpler copies are that call
 * with defaults.
 */
export async function seedWage(
  orgId: string,
  actorId: string,
  workerPartyId: string,
  rate: string,
  opts: WageSeedOptions = {},
): Promise<void> {
  await withOrgTransaction(orgId, async () => {
    await supersedeLaborCostRate({
      orgId,
      actorId,
      scope: { employeePartyId: workerPartyId, jobTitle: null, tradeId: null, departmentId: null, subsidiaryId: null },
      effectiveFrom: opts.from ?? "2020-01-01",
      rate,
      currency: opts.currency ?? "CAD",
      basis: opts.basis ?? "year",
      annualHours: opts.annualHours ?? "2080",
      notes: null,
      reason: opts.reason ?? "test wage",
    });
  });
}

async function insertPositioning(
  orgId: string,
  subsidiaryId: string,
  employmentId: string,
  levelId: string,
  opts: { positionCode?: string; departmentId?: string | null } = {},
): Promise<string> {
  const positionId = randomUUID();
  await db.execute(sql`
    insert into positions (id, org_id, position_code, revision)
    values (${positionId}, ${orgId}, ${opts.positionCode ?? `POS-${positionId.slice(0, 6)}`}, 1)
  `);
  await db.execute(sql`
    insert into position_versions (org_id, position_id, version_no, title, department_id, location_id,
      employer_subsidiary_id, planned_fte, status, effective_from, job_level_id)
    values (${orgId}, ${positionId}, 1, 'Engineer', ${opts.departmentId ?? null}, null,
      ${subsidiaryId}, 1, 'filled', '2020-01-01', ${levelId})
  `);
  const assignmentId = randomUUID();
  await db.execute(sql`
    insert into employment_assignments (id, org_id, employment_id, assignment_key)
    values (${assignmentId}, ${orgId}, ${employmentId}, 'primary')
  `);
  await db.execute(sql`
    insert into employment_assignment_versions (org_id, assignment_id, employment_id, version_no,
      job_title, department_id, fte, is_primary, effective_from, position_id)
    values (${orgId}, ${assignmentId}, ${employmentId}, 1,
      'Engineer', ${opts.departmentId ?? null}, 1, true, '2020-01-01', ${positionId})
  `);
  return positionId;
}

async function insertWage(
  orgId: string,
  actorId: string,
  workerPartyId: string,
  rate: string,
  opts: WageSeedOptions = {},
): Promise<void> {
  await withOrgTransaction(orgId, async () => {
    await supersedeLaborCostRate({
      orgId,
      actorId,
      scope: { employeePartyId: workerPartyId, jobTitle: null, tradeId: null, departmentId: null, subsidiaryId: null },
      effectiveFrom: opts.from ?? "2020-01-01",
      rate,
      currency: opts.currency ?? "CAD",
      basis: opts.basis ?? "year",
      annualHours: opts.annualHours ?? "2080",
      notes: null,
      reason: opts.reason ?? "test wage",
    });
  });
}

export type PositionedEmploymentSeed = {
  workerPartyId?: string;
  displayName?: string;
  status?: string;
  from?: string;
  positionCode?: string;
  levelId?: string | null;
  departmentId?: string | null;
  wage?: { actorId: string; rate: string } & WageSeedOptions;
};

/**
 * Employment with an optional leveled position and primary assignment. The
 * compensation copy is the superset (worker/status/window/position/department
 * options, position id in the result); the budget and headcount copies are
 * that call with fewer options. A null level id means no position, matching
 * the headcount copy's explicit-null call.
 */
export async function seedPositionedEmployment(
  orgId: string,
  subsidiaryId: string,
  opts: PositionedEmploymentSeed = {},
): Promise<{ employmentId: string; workerPartyId: string; positionId: string | null }> {
  const workerPartyId = opts.workerPartyId ?? randomUUID();
  if (!opts.workerPartyId) {
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${workerPartyId}, ${orgId}, 'person', ${opts.displayName ?? "Comp Worker"}, true, '{}'::jsonb)
    `);
  }
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${workerPartyId}, ${subsidiaryId}, 1)
  `);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
    values (${orgId}, ${employmentId}, 1, ${opts.status ?? "active"}, ${opts.from ?? "2020-01-01"}::date, null, now())
  `);
  let positionId: string | null = null;
  if (opts.levelId !== undefined && opts.levelId !== null) {
    positionId = await insertPositioning(orgId, subsidiaryId, employmentId, opts.levelId, {
      positionCode: opts.positionCode,
      departmentId: opts.departmentId,
    });
  }
  if (opts.wage) {
    const { actorId, rate, ...wageOpts } = opts.wage;
    await insertWage(orgId, actorId, workerPartyId, rate, wageOpts);
  }
  return { employmentId, workerPartyId, positionId };
}

export type PayGapWorkerSeed = {
  workerPartyId?: string;
  wage?: { rate: string; currency: string; basis: "hour" | "year"; annualHours: string };
  assignmentTo?: string;
};

/**
 * Positioned worker in a comparison group (pay-gap shape): the party carries
 * the group marker, the assignment window can be pre-bounded, and the wage
 * defaults to the group rate. The explicit-wage copy passes `wage`; the
 * group-rate copies omit it.
 */
export async function seedPayGapWorker(
  orgId: string,
  actorId: string,
  subsidiaryId: string,
  levelId: string,
  group: string,
  opts: PayGapWorkerSeed = {},
): Promise<{ employmentId: string; workerPartyId: string }> {
  const partyId = opts.workerPartyId ?? randomUUID();
  if (!opts.workerPartyId) {
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, custom)
      values (${partyId}, ${orgId}, 'person', ${`W ${partyId.slice(0, 6)}`}, true,
              ${JSON.stringify({ eeo_group: group })}::jsonb)
    `);
  } else {
    await db.execute(sql`
      update parties set custom = ${JSON.stringify({ eeo_group: group })}::jsonb
       where id = ${partyId} and org_id = ${orgId}`);
  }
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${partyId}, ${subsidiaryId}, 1)
  `);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
    values (${orgId}, ${employmentId}, 1, 'active', '2020-01-01'::date, null, now())
  `);
  const positionId = randomUUID();
  await db.execute(sql`
    insert into positions (id, org_id, position_code, revision)
    values (${positionId}, ${orgId}, ${`POS-${positionId.slice(0, 6)}`}, 1)
  `);
  await db.execute(sql`
    insert into position_versions (org_id, position_id, version_no, title, department_id, location_id,
      employer_subsidiary_id, planned_fte, status, effective_from, job_level_id)
    values (${orgId}, ${positionId}, 1, 'Engineer', null, null,
      ${subsidiaryId}, 1, 'filled', '2020-01-01', ${levelId})
  `);
  const assignmentId = randomUUID();
  await db.execute(sql`
    insert into employment_assignments (id, org_id, employment_id, assignment_key)
    values (${assignmentId}, ${orgId}, ${employmentId}, 'primary')
  `);
  await db.execute(sql`
    insert into employment_assignment_versions (org_id, assignment_id, employment_id, version_no,
      job_title, department_id, fte, is_primary, effective_from, effective_to, position_id)
    values (${orgId}, ${assignmentId}, ${employmentId}, 1,
      'Engineer', null, 1, true, '2020-01-01', ${opts.assignmentTo ?? null}::date, ${positionId})
  `);
  const wage = opts.wage ?? {
    rate: group === "G1" ? "100000" : "80000",
    currency: "CAD",
    basis: "year" as const,
    annualHours: "2080",
  };
  await insertWage(orgId, actorId, partyId, wage.rate, wage);
  return { employmentId, workerPartyId: partyId };
}

/** Pay component; code and name default like the construction copies. */
export async function seedComponent(
  orgId: string,
  opts: { code?: string; kind?: string; name?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const code = opts.code ?? `PD_${id.slice(0, 6)}`;
  await db.execute(sql`
    insert into pay_components (id, org_id, code, name, kind, is_active)
    values (${id}, ${orgId}, ${code}, ${opts.name ?? code}, ${opts.kind ?? "earning"}, true)
  `);
  return id;
}

export type PlanSeed = { planId: string; employeeComponentId: string; employerComponentId: string };

/**
 * Health benefit plan with deduction and employer-contribution components.
 * The benefits copy is the superset: `levels: true` adds the single/family
 * tiers and any other key is applied as a column update.
 */
export async function seedPlan(
  orgId: string,
  overrides: Record<string, unknown> = {},
): Promise<PlanSeed> {
  const employeeComponentId = await seedComponent(orgId, { code: `DED_${randomUUID().slice(0, 6)}`, kind: "deduction" });
  const employerComponentId = await seedComponent(orgId, { code: `ER_${randomUUID().slice(0, 6)}`, kind: "employer_contribution" });
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
            'full_month', 0, false, true, '2020-01-01')
  `);
  if (overrides.levels === true) {
    await db.execute(sql`
      insert into hrm_benefit_plan_levels (org_id, plan_id, level_key, label, employee_cost, employer_cost, position)
      values (${orgId}, ${planId}, 'single', 'Employee only', '250.0000', '500.0000', 0),
             (${orgId}, ${planId}, 'family', 'Family', '600.0000', '900.0000', 1)
    `);
  }
  for (const [column, value] of Object.entries(overrides)) {
    if (column === "levels") continue;
    await db.execute(sql`
      update hrm_benefit_plans set ${sql.identifier(column)} = ${value as string}
       where org_id = ${orgId} and id = ${planId}
    `);
  }
  return { planId, employeeComponentId, employerComponentId };
}

export type EnrollmentWindowSeed = {
  status?: string;
  kind?: string;
  opensOn?: string;
  closesOn?: string;
  appliesTo?: unknown;
};

/**
 * Enrollment window. The benefits copy is the superset (status/kind/window
 * options); the payroll-scope copy is that call with defaults, and the
 * workspace copy passes its wider window and scope through the same options.
 */
export async function seedWindow(orgId: string, overrides: EnrollmentWindowSeed = {}): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into hrm_enrollment_windows
      (id, org_id, name, kind, opens_on, closes_on, plan_year_start_on, applies_to, status)
    values (${id}, ${orgId}, ${`Window ${id.slice(0, 6)}`},
            ${overrides.kind ?? "open_enrollment"}, ${overrides.opensOn ?? "2026-01-01"}::date,
            ${overrides.closesOn ?? "2026-12-31"}::date, '2026-01-01'::date,
            ${JSON.stringify(overrides.appliesTo ?? {})}::jsonb, ${overrides.status ?? "open"})
  `);
  return id;
}

export type LiveVersionSeed = {
  status: string;
  from: string;
  to?: string | null;
  recordedAt?: string | null;
  changeKind?: string;
  reason?: string;
  /** Recorded-source reference naming the seeding suite (each copy differs). */
  sourceRef: string;
};

/**
 * Append one live version through the test-only canonical writer: close the
 * open versions, record the change, insert the successor, bump the revision.
 * Copies disagreed on the change identity (kind/reason/source ref) and the
 * recorded stamp; those travel as options, and the result carries every
 * field any copy returned.
 */
export async function addLiveVersion(
  orgId: string,
  employmentId: string,
  args: LiveVersionSeed,
): Promise<{ id: string; versionNo: number; changeId: string; revision: number }> {
  const maxRow = (await db.execute<{ n: number }>(sql`
    select coalesce(max(version_no), 0)::int as n from worker_employment_versions
     where org_id = ${orgId} and employment_id = ${employmentId}
  `)).rows[0];
  const versionNo = (maxRow?.n ?? 0) + 1;
  // One transaction like the service: the deferred evidence guards prove at
  // commit, so the close, the successor, and the event must commit together
  // (a per-statement commit would fire the reverse proof before the close).
  const { id, changeId, revision } = await db.transaction(async (tx) => {
    await tx.execute(sql`set constraints worker_employment_versions_change_tenant_fkey deferred`);
    // A fixture-recorded stamp instead of test-time now when the suite says
    // so: turnover legs read as known at their own date, so a now-stamped
    // closure would hide the leaver from the start leg.
    const now = args.recordedAt ?? (await tx.execute<{ now: Date }>(sql`select now() as now`)).rows[0]!.now;
    const prior = (await tx.execute<{ id: string; version_no: number; before: unknown }>(sql`
      select id, version_no, to_jsonb(worker_employment_versions) as before
        from worker_employment_versions
       where org_id = ${orgId} and employment_id = ${employmentId} and recorded_until is null
       order by version_no
    `)).rows;
    const newRevision = (await tx.execute<{ revision: number }>(sql`
      select revision from worker_employments where org_id = ${orgId} and id = ${employmentId}
    `)).rows[0]!.revision + 1;
    const newChangeId = (await tx.execute<{ id: string }>(sql`
      insert into employment_changes
        (org_id, employment_id, revision, change_kind, prior_snapshot, reason,
         recorded_source, recorded_source_ref, closed_versions)
      values (${orgId}, ${employmentId}, ${newRevision},
              ${args.changeKind ?? "corrected"}, '{}'::jsonb, ${args.reason ?? "test seed"},
              'system', ${args.sourceRef},
              ${JSON.stringify(prior.map((row) => ({
                table: "worker_employment_versions",
                identity: employmentId,
                version_no: row.version_no,
                row_id: row.id,
                before: row.before,
              })))}::jsonb)
      returning id
    `)).rows[0]!.id;
    for (const row of prior) {
      await tx.execute(sql`
        update worker_employment_versions
           set recorded_until = ${now}, superseded_by = ${versionNo}, closed_by_change_id = ${newChangeId}
         where id = ${row.id}
      `);
    }
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into worker_employment_versions
        (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
      values (${orgId}, ${employmentId}, ${versionNo}, ${args.status},
              ${args.from}::date, ${args.to ?? null}::date, ${now})
      returning id
    `)).rows[0]!.id;
    await tx.execute(sql`
      update worker_employments set revision = ${newRevision}, updated_at = now()
       where org_id = ${orgId} and id = ${employmentId}
    `);
    return { id: inserted, changeId: newChangeId, revision: newRevision };
  });
  return { id, versionNo, changeId, revision };
}

/**
 * Approval flow for change requests, or for leave requests with the leave
 * subject kind. The leave copy is that call with its kind; every other copy
 * is the default.
 */
export async function seedFlow(
  orgId: string,
  approverIds: string | readonly string[],
  subjectKind: string = HRM_CHANGE_REQUEST_SUBJECT_KIND,
): Promise<void> {
  const ids: readonly string[] = typeof approverIds === "string" ? [approverIds] : approverIds;
  await seedApprovalFlow(orgId, {
    subjectKind,
    assignees: ids.map((userId) => ({ type: "user" as const, userId })),
    mode: "any",
  });
}

/** Leave-request approval flow. */
export async function seedLeaveFlow(orgId: string, approverId: string): Promise<void> {
  await seedFlow(orgId, approverId, HRM_LEAVE_REQUEST_SUBJECT_KIND);
}

export type Refusal = { name: string; code: string; message: string };

/**
 * Capture a refusal's identity. Copies disagreed on the name source
 * (`.name` vs the constructor) and the codeless fallback; every suite that
 * asserts `name` expects the constructor name (plain `Error` subclasses do
 * not set `.name`), so the constructor wins with the majority's empty-string
 * fallback. The result stays plain data: one suite compares two refusals
 * with deepEqual, so no error instance travels along. Suites that need the
 * class asserted pass it as `expected`.
 */
export async function refusalOf<E extends abstract new (...args: never[]) => Error>(
  promise: Promise<unknown>,
  expected?: E,
): Promise<Refusal> {
  try {
    await promise;
  } catch (e) {
    if (expected) {
      assert.ok(e instanceof expected, `expected ${expected.name}, got ${String(e)}`);
    }
    const code = (e as { code?: unknown }).code;
    return {
      name: (e as Error).constructor.name,
      code: typeof code === "string" ? code : "",
      message: (e as Error).message,
    };
  }
  throw new Error("expected a refusal, the call succeeded");
}

/**
 * Cause-chain message predicate for assert.rejects. Two compensation
 * suites carried byte-identical copies under different names; kept
 * under the cycle-budget name. Trigger refusals
 * arrive wrapped (Drizzle carries the pg message on the cause chain),
 * so the predicate walks five levels of .message like the copies did.
 */
export function refusalMatches(pattern: RegExp): (e: unknown) => boolean {
  return (e: unknown) => {
    let current: unknown = e;
    for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
      const message = (current as { message?: unknown }).message;
      if (typeof message === "string" && pattern.test(message)) return true;
      current = (current as { cause?: unknown }).cause ?? null;
    }
    return false;
  };
}

/** Field-time refusal code; asserts the domain error class first. */
export function refusesCode(fn: () => Promise<unknown>): Promise<string> {
  return fn().then(
    () => { throw new Error("expected a refusal"); },
    (error) => {
      assert.ok(error instanceof FieldTimeError, `refusal is a FieldTimeError, got ${String(error)}`);
      return (error as FieldTimeError).code;
    },
  );
}

/** Assert a thrown value is a RecruitingError and return it typed. */
export function recruitingError(error: unknown): RecruitingError {
  assert.ok(error instanceof RecruitingError, `expected RecruitingError, got ${String(error)}`);
  return error;
}

/**
 * Requisition through sent offer (signing-suite shape). The main recruiting
 * suite's builder of the same name seeds a different shape and stays local
 * there.
 */
export async function seedSigningOffer(
  org: ScratchOrg,
  recruiterId: string,
): Promise<{ applicationId: string; offerId: string }> {
  const orgId = org.orgId;
  const requisition = await createRequisition({
    orgId,
    actorId: recruiterId,
    title: "Backend engineer",
    employerSubsidiaryId: org.subsidiaryId,
    headcount: 1,
  });
  const opened = await openRequisition({ orgId, actorId: recruiterId, requisitionId: requisition.id });
  const { candidate } = await createCandidate({
    orgId,
    actorId: recruiterId,
    displayName: "Offer Candidate",
    email: `offer-${randomUUID()}@example.test`,
    source: "direct",
  });
  const application = await createApplication({
    orgId,
    actorId: recruiterId,
    requisitionId: opened.id,
    candidateId: candidate.id,
  });
  const offer = await createOffer({
    orgId,
    actorId: recruiterId,
    applicationId: application.id,
    employerSubsidiaryId: org.subsidiaryId,
    jobTitle: "Backend engineer",
    proposedStartOn: "2026-10-01",
    compensationAmount: "120000",
    compensationCurrency: "USD",
    compensationBasis: "annual",
    expiresOn: "2027-12-31",
  });
  const sent = await sendOffer({ orgId, actorId: recruiterId, offerId: offer.id });
  assert.equal(sent.status, "sent");
  return { applicationId: application.id, offerId: offer.id };
}

/** Sent offer with a rendered letter and signing link. */
export async function seedSigningRenderedOffer(
  org: ScratchOrg,
  recruiterId: string,
): Promise<{ offerId: string; token: string }> {
  const { offerId } = await seedSigningOffer(org, recruiterId);
  const orgId = org.orgId;
  const template = await createOfferTemplate({
    orgId,
    actorId: recruiterId,
    name: "Standard letter",
    bodyTemplate: "Dear {{candidate_name}}, we offer you {{job_title}} at {{compensation_amount}} {{compensation_currency}} starting {{start_date}}.",
    clauses: [{ key: "at_will", label: "At will", body: "Employment is at will.", default_on: true }],
  });
  await renderOfferVersion({
    orgId,
    actorId: recruiterId,
    offerId,
    templateId: template.id,
    selectedClauseKeys: ["at_will"],
  });
  const link = await sendOfferLink({
    orgId,
    actorId: recruiterId,
    offerId,
    candidateEmail: "candidate@example.test",
    candidateName: "Offer Candidate",
    enqueueEmail: async () => {},
  });
  return { offerId, token: link.signingToken };
}

/** Assert a thrown value is a performance error and return it typed. */
export function perfError(error: unknown): HrmPerformanceError {
  assert.ok(error instanceof HrmPerformanceError, `expected HrmPerformanceError, got ${String(error)}`);
  return error;
}

/**
 * The single gate deciding a request. The widest copy selects the run id
 * too; narrower call sites ignore the extra field.
 */
export async function gateOf(requestId: string): Promise<{ id: string; status: string; runId: string }> {
  const rows = (await db.execute<{ id: string; status: string; runId: string }>(sql`
    select id, status, run_id as "runId" from flow_gates
     where subject_id = ${requestId} order by created_at
  `)).rows;
  assert.equal(rows.length, 1, "exactly one gate decides the request");
  return rows[0]!;
}

export type CloseAutomationHarness = {
  orgId: string;
  runId: string;
  blueprintId: string;
  reportingPackageId: string;
  submitterId: string;
  approver1Id: string;
  adminId: string;
};

/**
 * Close-automation run with flow actors and governed defaults. The two
 * close suites differ only in the data fingerprint (and one ignores the
 * blueprint/package ids), so the fingerprint is the parameter.
 */
export async function setupCloseAutomationHarness(
  fingerprint: string,
): Promise<CloseAutomationHarness> {
  const fixture = await createScratchOrg();
  const actors = await seedFlowActors(fixture.orgId);
  await db.execute(sql`
    update orgs set settings = jsonb_set(
      settings, '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"advancedClose":true}'::jsonb, true)
    where id = ${fixture.orgId}`);
  const defaults = await ensureCloseDefaults(fixture.orgId, actors.adminId);
  const runId = (await db.execute<{ id: string }>(sql`
    insert into close_runs
      (org_id, period_id, book_id, blueprint_id, reporting_package_id, status,
       current_stage, target_close_date, scope, data_fingerprint, started_at, started_by, created_by, updated_by)
    values (${fixture.orgId}, ${fixture.periodId}, ${fixture.bookId}, ${defaults.blueprintId},
            ${defaults.reportingPackageId}, 'in_progress', 'execute', current_date + 30,
            '{}'::jsonb, ${fingerprint}, now(), ${actors.submitterId}, ${actors.submitterId}, ${actors.submitterId})
    returning id`)).rows[0]!.id;
  return {
    orgId: fixture.orgId,
    runId,
    blueprintId: defaults.blueprintId,
    reportingPackageId: defaults.reportingPackageId,
    submitterId: actors.submitterId,
    approver1Id: actors.approver1Id,
    adminId: actors.adminId,
  };
}

export type HarnessUserSpec = {
  /** Result key for the user id. */
  key: string;
  /** Display name for the scratch user. */
  name: string;
  /** Login handle for the scratch user. */
  handle: string;
  /** Grants; the minority single-permission spelling is accepted too. */
  permissions?: string | readonly string[];
  /**
   * Link a person party: true mints the default display name, a string uses
   * it as the display name.
   */
  link?: boolean | string;
  /** Result key for the linked party id (only meaningful with `link`). */
  partyKey?: string;
};

export type HarnessSpec = {
  features?: readonly string[];
  country?: string;
  compensation?: Record<string, unknown>;
  users?: readonly HarnessUserSpec[];
};

type UserKeys<S> = S extends { users?: readonly (infer U)[] }
  ? U extends { key: infer K } ? K & string : never
  : never;
type PartyKeys<S> = S extends { users?: readonly (infer U)[] }
  ? U extends { partyKey?: infer P } ? Exclude<P & string, undefined> : never
  : never;

export type HarnessResult<S extends HarnessSpec> = { org: ScratchOrg } & Record<UserKeys<S> | PartyKeys<S>, string>;

/**
 * The common scratch-org setup: features, users with grants and person
 * links. Differences between suites (user names, handles, permission sets,
 * linked parties) are the spec; the majority shape (HRM on, no
 * compensation patch) is the default. Suites with heavier seeding pass
 * `extend` to add their domain rows to the base result instead of keeping a
 * local setup function.
 */
export async function setupHarness<const S extends HarnessSpec>(
  spec: S,
): Promise<HarnessResult<S>>;
export async function setupHarness<const S extends HarnessSpec, X extends object>(
  spec: S,
  extend: (base: HarnessResult<S>) => Promise<X>,
): Promise<HarnessResult<S> & X>;
export async function setupHarness<S extends HarnessSpec, X extends object>(
  spec: S,
  extend?: (base: HarnessResult<S>) => Promise<X>,
): Promise<HarnessResult<S> & Partial<X>> {
  const org = await createScratchOrg();
  await enableFeatures(org.orgId, spec.features ?? ["hrm"]);
  if (spec.country !== undefined) {
    await db.execute(sql`update orgs set country = ${spec.country} where id = ${org.orgId}`);
  }
  if (spec.compensation !== undefined) {
    await setCompensationSettings(org.orgId, spec.compensation);
  }
  const ids: Record<string, string> = {};
  for (const user of spec.users ?? []) {
    const userId = await createScratchUser(org.orgId, user.name, user.handle);
    ids[user.key] = userId;
    if (user.permissions !== undefined) {
      await grant(org.orgId, userId, user.permissions);
    }
    if (user.link !== undefined && user.link !== false) {
      const partyId = await linkPerson(org.orgId, userId, typeof user.link === "string" ? user.link : undefined);
      if (user.partyKey !== undefined) {
        ids[user.partyKey] = partyId;
      }
    }
  }
  const base = { org, ...ids } as HarnessResult<S>;
  if (!extend) return base as HarnessResult<S> & Partial<X>;
  return { ...base, ...(await extend(base)) } as HarnessResult<S> & Partial<X>;
}

/**
 * Run a test against a fresh harness and drop the org afterwards. The
 * minority copies return early without a database; every in-partition caller
 * is DB-gated anyway, so the guard is unconditional here. The automations
 * copies wrapped setup and teardown in a bypass scope; that travels as an
 * option with the majority (no wrapping) as default.
 */
export async function withHarness<T extends { org: ScratchOrg }>(
  setup: () => Promise<T>,
  fn: (h: T) => Promise<void>,
  opts: { bypass?: boolean } = {},
): Promise<void> {
  if (!DB) return;
  const runSetup = opts.bypass ? () => withBypassContext(setup) : setup;
  const h = await runSetup();
  try {
    await fn(h);
  } finally {
    if (opts.bypass) {
      await withBypassContext(() => dropScratchOrg(h.org.orgId));
    } else {
      await dropScratchOrg(h.org.orgId);
    }
  }
}
