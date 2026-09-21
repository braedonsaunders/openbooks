import { sql } from "drizzle-orm";
import { HrmConstructionError } from "./errors.ts";
import { requireHrmConstructionManage, requireHrmConstructionRead } from "../authorization.ts";
import { classificationAsOf } from "./classifications.ts";
import { recordFinding } from "./findings.ts";
import { applyReciprocity, scopeScore, type AppliesTo, type Reciprocity } from "./pure.ts";
import {
  HRM_PREVAILING_WAGE_FEATURE,
  assertConstructionFeature,
  requireDate,
  requireId,
  requireText,
  type SqlExecutor,
} from "./shared.ts";

/**
 * Prevailing-wage and union rate tables (HR-13, migration 0223) plus the
 * wage resolver. resolveWage prices one employment on one project on one
 * day by schedule scope (project > location > subsidiary > org), the
 * employment's classification as of the date, and the schedule's
 * reciprocity against the worker's home schedule — and writes a
 * missing_rate finding every time it refuses for no covering line. It
 * NEVER falls back to the wage rate on the employment silently: no line
 * is a refusal, not a number.
 */

export type ScheduleKind = "prevailing_wage" | "union_agreement" | "org_declared";

export interface RateSchedule {
  readonly id: string;
  readonly kind: ScheduleKind;
  readonly name: string;
  readonly sourceRef: string | null;
  readonly jurisdictionCode: string | null;
  readonly appliesTo: AppliesTo;
  readonly reciprocity: Reciprocity;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly isActive: boolean;
}

export interface ResolvedWage {
  readonly scheduleId: string;
  readonly scheduleName: string;
  readonly kind: ScheduleKind;
  readonly base: string;
  readonly fringeCash: string;
  readonly fringeCredit: string;
  readonly currency: string;
  readonly overtimeMultiplier: string;
  readonly source: "prevailing" | "union" | "org" | "home_local" | "jobsite_local" | "higher_of";
  /** True when a ratio breach repriced apprentice hours at the journey line — visible, never silent. */
  readonly rateAtJourney: boolean;
}

export async function listSchedules(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<readonly RateSchedule[]> {
  await assertConstructionFeature(exec, orgId, HRM_PREVAILING_WAGE_FEATURE, "Rate schedules");
  requireId(actorId, "actorId");
  await requireHrmConstructionRead(exec, orgId, actorId);
  const rows = (
    await exec.execute<{
      id: string;
      kind: ScheduleKind;
      name: string;
      sourceRef: string | null;
      jurisdictionCode: string | null;
      appliesTo: AppliesTo;
      reciprocity: Reciprocity;
      effectiveFrom: string;
      effectiveTo: string | null;
      isActive: boolean;
    }>(sql`
      select id::text as id, kind, name,
             source_ref as "sourceRef", jurisdiction_code as "jurisdictionCode",
             applies_to as "appliesTo", reciprocity,
             effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
             is_active as "isActive"
        from hrm_rate_schedules
       where org_id = ${orgId}::uuid
       order by name
    `)
  ).rows;
  return rows;
}

export async function createSchedule(
  exec: SqlExecutor,
  input: {
    orgId: string;
    actorId: string;
    kind: ScheduleKind;
    name: string;
    sourceRef?: string | null;
    jurisdictionCode?: string | null;
    appliesTo?: AppliesTo;
    reciprocity: Reciprocity;
    effectiveFrom: string;
    effectiveTo?: string | null;
  },
): Promise<RateSchedule> {
  const orgId = requireId(input.orgId, "orgId");
  requireId(input.actorId, "actorId");
  await assertConstructionFeature(exec, orgId, HRM_PREVAILING_WAGE_FEATURE, "Rate schedules");
  await requireHrmConstructionManage(exec, orgId, input.actorId);
  if (!["prevailing_wage", "union_agreement", "org_declared"].includes(input.kind)) {
    throw new HrmConstructionError(
      `Unknown schedule kind ${input.kind} — use prevailing_wage, union_agreement, or org_declared.`,
    );
  }
  if (!["home_local", "jobsite_local", "higher_of"].includes(input.reciprocity)) {
    throw new HrmConstructionError(
      `Unknown reciprocity ${input.reciprocity} — use home_local, jobsite_local, or higher_of.`,
    );
  }
  const name = requireText(input.name, "name");
  const effectiveFrom = requireDate(input.effectiveFrom, "effectiveFrom");
  const effectiveTo = input.effectiveTo ? requireDate(input.effectiveTo, "effectiveTo") : null;
  if (effectiveTo && effectiveTo < effectiveFrom) {
    throw new HrmConstructionError(
      `Schedule ${name} ends ${effectiveTo} before it starts ${effectiveFrom} — fix the window.`,
    );
  }
  const appliesTo = input.appliesTo ?? {};
  assertAppliesTo(appliesTo);
  const created = (
    await exec.execute<{ id: string }>(sql`
      insert into hrm_rate_schedules
        (org_id, kind, name, source_ref, jurisdiction_code, applies_to,
         reciprocity, effective_from, effective_to, created_by, updated_by)
      values (${orgId}::uuid, ${input.kind}, ${name},
              ${input.sourceRef ?? null}, ${input.jurisdictionCode ?? null},
              ${JSON.stringify(appliesTo)}::jsonb, ${input.reciprocity},
              ${effectiveFrom}::date, ${effectiveTo}::date,
              ${input.actorId}::uuid, ${input.actorId}::uuid)
      returning id::text as id
    `)
  ).rows[0];
  if (!created) throw new HrmConstructionError(`Schedule ${name} was not created — no row was written.`);
  const rows = await listSchedules(exec, orgId, input.actorId);
  const found = rows.find((row) => row.id === created.id);
  if (!found) throw new HrmConstructionError(`Schedule ${name} was not created — it cannot be read back.`);
  return found;
}

/**
 * Update a schedule's scope. Every referenced target is proven against
 * the org — an unknown subsidiary, department, project or location is
 * refused at save, because a schedule that can never apply must not be
 * saved as applicable.
 */
export async function updateScheduleScope(
  exec: SqlExecutor,
  input: { orgId: string; actorId: string; scheduleId: string; appliesTo: AppliesTo },
): Promise<RateSchedule> {
  const orgId = requireId(input.orgId, "orgId");
  requireId(input.actorId, "actorId");
  const scheduleId = requireId(input.scheduleId, "scheduleId");
  await assertConstructionFeature(exec, orgId, HRM_PREVAILING_WAGE_FEATURE, "Rate schedules");
  await requireHrmConstructionManage(exec, orgId, input.actorId);
  const schedule = (
    await exec.execute<{ id: string }>(sql`
      select id from hrm_rate_schedules where org_id = ${orgId}::uuid and id = ${scheduleId}::uuid
    `)
  ).rows[0];
  if (!schedule) {
    throw new HrmConstructionError(
      `Rate schedule ${scheduleId} does not exist in this organization — scope one of its schedules.`,
    );
  }
  const appliesTo = input.appliesTo ?? {};
  assertAppliesTo(appliesTo);
  await proveScopeTarget(exec, orgId, "subsidiary", "subsidiaries", appliesTo.employer_subsidiary_id ?? null);
  await proveScopeTarget(exec, orgId, "department", "departments", appliesTo.department_id ?? null);
  for (const projectId of appliesTo.project_ids ?? []) {
    await proveScopeTarget(exec, orgId, "project", "projects", projectId);
  }
  for (const locationId of appliesTo.location_ids ?? []) {
    await proveScopeTarget(exec, orgId, "location", "locations", locationId);
  }
  await exec.execute(sql`
    update hrm_rate_schedules
       set applies_to = ${JSON.stringify(appliesTo)}::jsonb,
           updated_by = ${input.actorId}::uuid, updated_at = now()
     where org_id = ${orgId}::uuid and id = ${scheduleId}::uuid
  `);
  const rows = await listSchedules(exec, orgId, input.actorId);
  const found = rows.find((row) => row.id === scheduleId);
  if (!found) throw new HrmConstructionError(`Rate schedule ${scheduleId} cannot be read back after scoping.`);
  return found;
}

async function proveScopeTarget(
  exec: SqlExecutor,
  orgId: string,
  kind: string,
  table: string,
  id: string | null,
): Promise<void> {
  if (!id) return;
  const row = (
    await exec.execute<{ id: string }>(sql`
      select id from ${sql.raw(table)} where org_id = ${orgId}::uuid and id = ${id}::uuid
    `)
  ).rows[0];
  if (!row) {
    throw new HrmConstructionError(
      `Scope ${kind} ${id} does not exist in this organization — scope the schedule to one of its ${kind}s.`,
    );
  }
}

function assertAppliesTo(appliesTo: AppliesTo): void {
  if (typeof appliesTo !== "object" || appliesTo === null || Array.isArray(appliesTo)) {
    throw new HrmConstructionError("Schedule scope must be a JSON object.");
  }
  const allowed = ["employer_subsidiary_id", "department_id", "project_ids", "location_ids"];
  for (const key of Object.keys(appliesTo)) {
    if (!allowed.includes(key)) {
      throw new HrmConstructionError(
        `Schedule scope key ${key} is not one of ${allowed.join(", ")} — the scope shape is closed.`,
      );
    }
  }
  for (const listKey of ["project_ids", "location_ids"] as const) {
    const list = appliesTo[listKey];
    if (list !== undefined && list !== null && (!Array.isArray(list) || list.some((id) => typeof id !== "string"))) {
      throw new HrmConstructionError(`Schedule scope ${listKey} must be an array of id strings.`);
    }
  }
}

export async function addScheduleLine(
  exec: SqlExecutor,
  input: {
    orgId: string;
    actorId: string;
    scheduleId: string;
    classificationId: string;
    baseRate: string;
    fringeRate?: string;
    fringeCreditRate?: string;
    overtimeMultiplier?: string;
    currency: string;
    effectiveFrom: string;
    effectiveTo?: string | null;
  },
): Promise<string> {
  const orgId = requireId(input.orgId, "orgId");
  requireId(input.actorId, "actorId");
  const scheduleId = requireId(input.scheduleId, "scheduleId");
  const classificationId = requireId(input.classificationId, "classificationId");
  await assertConstructionFeature(exec, orgId, HRM_PREVAILING_WAGE_FEATURE, "Rate schedules");
  await requireHrmConstructionManage(exec, orgId, input.actorId);
  const schedule = (
    await exec.execute<{ id: string }>(sql`
      select id from hrm_rate_schedules where org_id = ${orgId}::uuid and id = ${scheduleId}::uuid
    `)
  ).rows[0];
  if (!schedule) {
    throw new HrmConstructionError(
      `Rate schedule ${scheduleId} does not exist in this organization — add the line to a declared schedule.`,
    );
  }
  const classification = (
    await exec.execute<{ id: string }>(sql`
      select id from hrm_work_classifications where org_id = ${orgId}::uuid and id = ${classificationId}::uuid
    `)
  ).rows[0];
  if (!classification) {
    throw new HrmConstructionError(
      `Classification ${classificationId} does not exist in this organization — declare it before pricing it.`,
    );
  }
  for (const [field, value] of [
    ["baseRate", input.baseRate],
    ["fringeRate", input.fringeRate ?? "0"],
    ["fringeCreditRate", input.fringeCreditRate ?? "0"],
    ["overtimeMultiplier", input.overtimeMultiplier ?? "1.5"],
  ] as const) {
    if (!/^\d+(\.\d{1,4})?$/.test(value)) {
      throw new HrmConstructionError(`${field} must be a non-negative decimal with at most 4 places — got ${value}.`);
    }
  }
  const currency = requireText(input.currency, "currency");
  if (currency.length !== 3) throw new HrmConstructionError("Currency must be a 3-letter ISO code.");
  const effectiveFrom = requireDate(input.effectiveFrom, "effectiveFrom");
  try {
    const created = (
      await exec.execute<{ id: string }>(sql`
        insert into hrm_rate_schedule_lines
          (org_id, schedule_id, classification_id, base_rate, fringe_rate, fringe_credit_rate,
           overtime_multiplier, currency, effective_from, effective_to, created_by, updated_by)
        values (${orgId}::uuid, ${scheduleId}::uuid, ${classificationId}::uuid,
                ${input.baseRate}, ${input.fringeRate ?? "0"}, ${input.fringeCreditRate ?? "0"},
                ${input.overtimeMultiplier ?? "1.5"}, ${currency.toUpperCase()},
                ${effectiveFrom}::date, ${input.effectiveTo ?? null}::date,
                ${input.actorId}::uuid, ${input.actorId}::uuid)
        returning id::text as id
      `)
    ).rows[0];
    if (!created) throw new HrmConstructionError("The rate line was not written — no row was created.");
    return String(created.id);
  } catch (error) {
    if (error instanceof HrmConstructionError) throw error;
    throw new HrmConstructionError(
      "The rate line cannot be saved — a line for this schedule, classification and effective date already exists. Version it with a new effective date instead.",
    );
  }
}

/**
 * Resolve one employment's wage on one project on one day. Scope
 * precedence, as-of classification, reciprocity against the home local —
 * and a missing_rate finding plus a named refusal whenever no line
 * covers. Never the employment's wage rate by fallback.
 */
export async function resolveWage(
  exec: SqlExecutor,
  input: { orgId: string; actorId: string; employmentId: string; projectId: string | null; workedOn: string },
): Promise<ResolvedWage> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  const employmentId = requireId(input.employmentId, "employmentId");
  const workedOn = requireDate(input.workedOn, "workedOn");
  await assertConstructionFeature(exec, orgId, HRM_PREVAILING_WAGE_FEATURE, "Prevailing-wage resolution");
  const employment = (
    await exec.execute<{ id: string; subsidiaryId: string | null }>(sql`
      select id::text as id, employer_subsidiary_id::text as "subsidiaryId"
        from worker_employments where org_id = ${orgId}::uuid and id = ${employmentId}::uuid
    `)
  ).rows[0];
  if (!employment) {
    throw new HrmConstructionError(
      `Employment ${employmentId} does not exist in this organization — resolve the wage for one of its employments.`,
    );
  }
  const assignment = await classificationAsOf(exec, orgId, employmentId, workedOn);
  if (!assignment) {
    await recordFinding(exec, {
      orgId,
      actorId,
      kind: "missing_rate",
      projectId: input.projectId,
      workedOn,
      employmentId,
      detail: { reason: "assignment_missing", employmentId, workedOn },
    });
    throw new HrmConstructionError(
      `Employment ${employmentId} has no work classification effective ${workedOn} — assign one before pricing the day.`,
    );
  }
  let projectSubsidiary: string | null = null;
  let projectLocation: string | null = null;
  if (input.projectId) {
    const project = (
      await exec.execute<{ subsidiaryId: string | null; custom: Record<string, unknown> }>(sql`
        select subsidiary_id::text as "subsidiaryId", custom
          from projects where org_id = ${orgId}::uuid and id = ${input.projectId}::uuid
      `)
    ).rows[0];
    if (!project) {
      throw new HrmConstructionError(
        `Project ${input.projectId} does not exist in this organization — price the day against one of its projects.`,
      );
    }
    projectSubsidiary = project.subsidiaryId;
    const customLocation = (project.custom as Record<string, unknown> | null)?.location_id;
    projectLocation = typeof customLocation === "string" ? customLocation : null;
  }
  const target = {
    projectId: input.projectId,
    locationId: projectLocation,
    subsidiaryId: employment.subsidiaryId ?? projectSubsidiary,
  };
  const schedules = (
    await exec.execute<{
      id: string;
      kind: ScheduleKind;
      name: string;
      appliesTo: AppliesTo;
      reciprocity: Reciprocity;
    }>(sql`
      select id::text as id, kind, name, applies_to as "appliesTo", reciprocity
        from hrm_rate_schedules
       where org_id = ${orgId}::uuid and is_active
         and effective_from <= ${workedOn}::date
         and (effective_to is null or effective_to >= ${workedOn}::date)
    `)
  ).rows;
  const scored = schedules
    .map((schedule) => ({ schedule, score: scopeScore(schedule.appliesTo ?? {}, target) }))
    .filter((candidate) => candidate.score >= 0)
    .sort((a, b) => b.score - a.score || (a.schedule.id < b.schedule.id ? -1 : 1));
  // A ratio breach reprices apprentice hours at the journey line: the
  // open finding IS the mark — visible on the Compliance page, consulted
  // here, never a silent repricing.
  let priceClassificationId = assignment.classificationId;
  let rateAtJourney = false;
  if (assignment.isApprentice && assignment.journeyClassificationId && input.projectId) {
    const breach = (
      await exec.execute<{ detail: Record<string, unknown> }>(sql`
        select detail from hrm_compliance_findings
         where org_id = ${orgId}::uuid and kind = 'ratio_breach' and status = 'open'
           and project_id is not distinct from ${input.projectId}::uuid
           and worked_on is not distinct from ${workedOn}::date
           and employment_id is not distinct from ${employmentId}::uuid
         order by recorded_at desc limit 1
      `)
    ).rows[0];
    if (breach) {
      priceClassificationId = assignment.journeyClassificationId;
      rateAtJourney = true;
    }
  }
  for (const { schedule } of scored) {
    const line = await lineAsOf(exec, orgId, schedule.id, priceClassificationId, workedOn);
    if (!line) continue;
    const homeLine = assignment.homeScheduleId
      ? await lineAsOf(exec, orgId, assignment.homeScheduleId, priceClassificationId, workedOn)
      : null;
    const { line: priced, source: reciprocitySource } = applyReciprocity(
      schedule.reciprocity,
      { base: line.baseRate, fringeCash: line.fringeRate, fringeCredit: line.fringeCreditRate },
      homeLine
        ? { base: homeLine.baseRate, fringeCash: homeLine.fringeRate, fringeCredit: homeLine.fringeCreditRate }
        : null,
    );
    const kindSource = schedule.kind === "prevailing_wage" ? "prevailing" : schedule.kind === "union_agreement" ? "union" : "org";
    return {
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      kind: schedule.kind,
      base: priced.base,
      fringeCash: priced.fringeCash,
      fringeCredit: priced.fringeCredit,
      currency: line.currency,
      overtimeMultiplier: line.overtimeMultiplier,
      // A jobsite-priced line reports the schedule KIND (the rate's
      // authority); a home-local or higher-of decision reports HOW the
      // line was chosen. All six sources stay meaningful.
      source: reciprocitySource === "jobsite_local" ? kindSource : reciprocitySource,
      rateAtJourney,
    };
  }
  await recordFinding(exec, {
    orgId,
    actorId,
    kind: "missing_rate",
    projectId: input.projectId,
    workedOn,
    employmentId,
    detail: {
      reason: "no_covering_line",
      classificationId: priceClassificationId,
      workedOn,
      candidates: scored.length,
    },
  });
  throw new HrmConstructionError(
    `No rate line covers classification ${priceClassificationId} on ${workedOn} for this project — add a line to a schedule in scope before pricing the day. The missing rate was flagged on the Compliance page.`,
  );
}

async function lineAsOf(
  exec: SqlExecutor,
  orgId: string,
  scheduleId: string,
  classificationId: string,
  workedOn: string,
): Promise<{
  baseRate: string;
  fringeRate: string;
  fringeCreditRate: string;
  currency: string;
  overtimeMultiplier: string;
} | null> {
  const row = (
    await exec.execute<{
      baseRate: string;
      fringeRate: string;
      fringeCreditRate: string;
      currency: string;
      overtimeMultiplier: string;
    }>(sql`
      select base_rate::text as "baseRate", fringe_rate::text as "fringeRate",
             fringe_credit_rate::text as "fringeCreditRate",
             currency, overtime_multiplier::text as "overtimeMultiplier"
        from hrm_rate_schedule_lines
       where org_id = ${orgId}::uuid and schedule_id = ${scheduleId}::uuid
         and classification_id = ${classificationId}::uuid
         and effective_from <= ${workedOn}::date
         and (effective_to is null or effective_to >= ${workedOn}::date)
       order by effective_from desc limit 1
    `)
  ).rows[0];
  return row ?? null;
}
