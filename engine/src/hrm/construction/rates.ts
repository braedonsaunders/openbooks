import { sql } from "drizzle-orm";
import { HrmConstructionError } from "./errors.ts";
import {
  requireConstructionScope,
  requireUnrestrictedHrmScope,
} from "../authorization.ts";
import { classificationAsOf } from "./classifications.ts";
import { recordFinding } from "./findings.ts";
import { actorAllowedSubsidiaryIds } from "../../organization/actor-subsidiaries.ts";
import { applyReciprocity, scopeScore, type AppliesTo, type Reciprocity } from "./pure.ts";
import {
  HRM_PREVAILING_WAGE_FEATURE,
  assertConstructionFeature,
  assertEmploymentInScope,
  assertProjectInScope,
  requireDate,
  requireId,
  requireText,
  withOrgTransaction,
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

export interface ScheduleScopeTarget {
  readonly employerSubsidiaryId: string | null;
  readonly projectIds: readonly string[];
}

function scheduleScopeTarget(appliesTo: AppliesTo): ScheduleScopeTarget {
  return {
    employerSubsidiaryId: appliesTo.employer_subsidiary_id ?? null,
    projectIds: appliesTo.project_ids ?? [],
  };
}

/** Stored applies_to jsonb back into the scope target (untrusted shape — strings only). */
function parseStoredScheduleScope(value: unknown): ScheduleScopeTarget {
  const raw = (value ?? {}) as {
    employer_subsidiary_id?: unknown;
    project_ids?: unknown;
  };
  return {
    employerSubsidiaryId:
      typeof raw.employer_subsidiary_id === "string" ? raw.employer_subsidiary_id : null,
    projectIds: Array.isArray(raw.project_ids)
      ? raw.project_ids.filter((id): id is string => typeof id === "string")
      : [],
  };
}

/**
 * Declared schedule target (creation, scope updates, ratio rules on a
 * schedule): every named anchor must exist inside the actor's lens — a B
 * subsidiary or B project reads exactly like a fabricated id — and a
 * fully org-wide target (no employer, no projects) prices every entity
 * at once, so it needs unrestricted scope, named with the remedy.
 */
export async function assertDeclaredScheduleScope(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  target: ScheduleScopeTarget,
  allowed: ReadonlySet<string> | null,
): Promise<void> {
  if (target.employerSubsidiaryId === null && target.projectIds.length === 0) {
    await requireUnrestrictedHrmScope(exec, orgId, actorId);
    return;
  }
  if (target.employerSubsidiaryId !== null) {
    const found = (
      await exec.execute(sql`
        select 1 as one from subsidiaries
         where org_id = ${orgId}::uuid and id = ${target.employerSubsidiaryId}::uuid
           ${allowed === null ? sql`` : sql`and id = any (${`{${[...allowed].join(",")}}`}::uuid[])`}
      `)
    ).rows[0];
    if (!found) {
      throw new HrmConstructionError(
        "The schedule's employer subsidiary does not exist in this organization — declare the schedule for a subsidiary of this organization, or leave it org-wide.",
      );
    }
  }
  for (const projectId of target.projectIds) {
    const found = (
      await exec.execute(sql`
        select 1 as one from projects
         where org_id = ${orgId}::uuid and id = ${projectId}::uuid
           ${allowed === null ? sql`` : sql`and subsidiary_id = any (${`{${[...allowed].join(",")}}`}::uuid[])`}
      `)
    ).rows[0];
    if (!found) {
      throw new HrmConstructionError(
        "One of the schedule's projects does not exist in this organization — declare the schedule for projects of this organization.",
      );
    }
  }
}

/**
 * Locked schedule anchor for step and scope writes: the schedule row is
 * locked FOR UPDATE and its CURRENT target must already sit inside the
 * lens — editing B's schedule refuses uniformly as not-found, and an
 * org-wide schedule needs unrestricted scope to change. Returns the
 * current target for callers that validate a new one next.
 */
export async function lockScheduleScopeForWrite(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  scheduleId: string,
  allowed: ReadonlySet<string> | null,
): Promise<ScheduleScopeTarget> {
  const row = (
    await exec.execute<{ appliesTo: unknown }>(sql`
      select applies_to as "appliesTo" from hrm_rate_schedules
       where org_id = ${orgId}::uuid and id = ${scheduleId}::uuid for update
    `)
  ).rows[0];
  const missing = (): HrmConstructionError =>
    new HrmConstructionError(
      `Rate schedule ${scheduleId} does not exist in this organization — use one of its schedules.`,
    );
  if (!row) throw missing();
  const target = parseStoredScheduleScope(row.appliesTo);
  if (target.employerSubsidiaryId === null && target.projectIds.length === 0) {
    await requireUnrestrictedHrmScope(exec, orgId, actorId);
    return target;
  }
  if (
    target.employerSubsidiaryId !== null &&
    allowed !== null &&
    !allowed.has(target.employerSubsidiaryId)
  ) {
    throw missing();
  }
  for (const projectId of target.projectIds) {
    const found = (
      await exec.execute(sql`
        select 1 as one from projects
         where org_id = ${orgId}::uuid and id = ${projectId}::uuid
           ${allowed === null ? sql`` : sql`and subsidiary_id = any (${`{${[...allowed].join(",")}}`}::uuid[])`}
      `)
    ).rows[0];
    if (!found) throw missing();
  }
  return target;
}

export async function listSchedules(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<readonly RateSchedule[]> {
  await assertConstructionFeature(exec, orgId, HRM_PREVAILING_WAGE_FEATURE, "Rate schedules");
  requireId(actorId, "actorId");
  // Schedule rates ARE pay data: a B-targeted schedule's lines never
  // reach an A-scoped reader. Org-wide (unanchored) schedules are shared
  // reference like the trade taxonomy, so they stay readable.
  const allowed = await requireConstructionScope(exec, orgId, actorId, "hrm.construction.read");
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
  if (allowed === null) return rows;
  const projectIds = [...new Set(rows.flatMap((row) => row.appliesTo?.project_ids ?? []))];
  const subsidiaries = new Map<string, string | null>();
  if (projectIds.length > 0) {
    const projectRows = (
      await exec.execute<{ id: string; subsidiaryId: string | null }>(sql`
        select id::text as id, subsidiary_id::text as "subsidiaryId" from projects
         where org_id = ${orgId}::uuid and id = any (${`{${projectIds.join(",")}}`}::uuid[])
      `)
    ).rows;
    for (const project of projectRows) subsidiaries.set(project.id, project.subsidiaryId);
  }
  return rows.filter((row) => {
    const target = scheduleScopeTarget(row.appliesTo ?? {});
    if (target.employerSubsidiaryId !== null && !allowed.has(target.employerSubsidiaryId)) return false;
    for (const projectId of target.projectIds) {
      const subsidiary = subsidiaries.get(projectId);
      if (!subsidiary || !allowed.has(subsidiary)) return false;
    }
    return true;
  });
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
}): Promise<RateSchedule> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
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
  // The write owns its transaction (the transaction runner is
  // authoritative — the shared claim is one transaction per action), so
  // the target check and the insert below are atomic.
  return withOrgTransaction(orgId, async () => {
    await assertConstructionFeature(exec, orgId, HRM_PREVAILING_WAGE_FEATURE, "Rate schedules");
    // The declared target is the creation's legal-entity claim: a B
    // subsidiary or B project reads exactly like a fabricated id, and an
    // org-wide target needs unrestricted scope.
    const allowed = await requireConstructionScope(exec, orgId, actorId, "hrm.construction.manage");
    await assertDeclaredScheduleScope(exec, orgId, actorId, scheduleScopeTarget(appliesTo), allowed);
    const created = (
      await exec.execute<{ id: string }>(sql`
        insert into hrm_rate_schedules
          (org_id, kind, name, source_ref, jurisdiction_code, applies_to,
           reciprocity, effective_from, effective_to, created_by, updated_by)
        values (${orgId}::uuid, ${input.kind}, ${name},
                ${input.sourceRef ?? null}, ${input.jurisdictionCode ?? null},
                ${JSON.stringify(appliesTo)}::jsonb, ${input.reciprocity},
                ${effectiveFrom}::date, ${effectiveTo}::date,
                ${actorId}::uuid, ${actorId}::uuid)
        returning id::text as id
      `)
    ).rows[0];
    if (!created) throw new HrmConstructionError(`Schedule ${name} was not created — no row was written.`);
    const rows = await listSchedules(exec, orgId, actorId);
    const found = rows.find((row) => row.id === created.id);
    if (!found) throw new HrmConstructionError(`Schedule ${name} was not created — it cannot be read back.`);
    return found;
  });
}

/**
 * Update a schedule's scope. Every referenced target is proven against
 * the org — an unknown subsidiary, department, project or location is
 * refused at save, because a schedule that can never apply must not be
 * saved as applicable.
 */
export async function updateScheduleScope(
  exec: SqlExecutor,
  input: {
  orgId: string;
  actorId: string;
  scheduleId: string;
  appliesTo: AppliesTo;
}): Promise<RateSchedule> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  const scheduleId = requireId(input.scheduleId, "scheduleId");
  const appliesTo = input.appliesTo ?? {};
  assertAppliesTo(appliesTo);
  return withOrgTransaction(orgId, async () => {
    await assertConstructionFeature(exec, orgId, HRM_PREVAILING_WAGE_FEATURE, "Rate schedules");
    const allowed = await requireConstructionScope(exec, orgId, actorId, "hrm.construction.manage");
    // The locked row's CURRENT target is rechecked first (a B schedule
    // refuses as not-found), then the NEW target validates like a
    // creation — retargeting onto B or org-wide needs the scope for it.
    await lockScheduleScopeForWrite(exec, orgId, actorId, scheduleId, allowed);
    await proveScopeTarget(exec, orgId, "department", "departments", appliesTo.department_id ?? null);
    for (const locationId of appliesTo.location_ids ?? []) {
      await proveScopeTarget(exec, orgId, "location", "locations", locationId);
    }
    await assertDeclaredScheduleScope(exec, orgId, actorId, scheduleScopeTarget(appliesTo), allowed);
    await exec.execute(sql`
      update hrm_rate_schedules
         set applies_to = ${JSON.stringify(appliesTo)}::jsonb,
             updated_by = ${actorId}::uuid, updated_at = now()
       where org_id = ${orgId}::uuid and id = ${scheduleId}::uuid
    `);
    const rows = await listSchedules(exec, orgId, actorId);
    const found = rows.find((row) => row.id === scheduleId);
    if (!found) throw new HrmConstructionError(`Rate schedule ${scheduleId} cannot be read back after scoping.`);
    return found;
  });
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
}): Promise<string> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  const scheduleId = requireId(input.scheduleId, "scheduleId");
  const classificationId = requireId(input.classificationId, "classificationId");
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
  return withOrgTransaction(orgId, async () => {
    await assertConstructionFeature(exec, orgId, HRM_PREVAILING_WAGE_FEATURE, "Rate schedules");
    // The parent schedule's CURRENT target governs the line: lines price
    // the schedule's employees, so a B-targeted (or org-wide) schedule
    // refuses a restricted actor before the line is even validated.
    const allowed = await requireConstructionScope(exec, orgId, actorId, "hrm.construction.manage");
    await lockScheduleScopeForWrite(exec, orgId, actorId, scheduleId, allowed);
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
                  ${actorId}::uuid, ${actorId}::uuid)
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
  });
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
  // No grant gate: the approval-time hook resolves through here with an
  // approver who may hold no construction grant. The subsidiary lens
  // still fences unconditionally — B's priced wage never resolves for an
  // A-scoped caller, hook or direct — with missing and out-of-scope
  // refusing identically.
  const lens = await actorAllowedSubsidiaryIds(exec, orgId, actorId);
  await assertEmploymentInScope(exec, orgId, employmentId, lens);
  const employmentSubsidiary = (
    await exec.execute<{ subsidiaryId: string | null }>(sql`
      select employer_subsidiary_id::text as "subsidiaryId"
        from worker_employments where org_id = ${orgId}::uuid and id = ${employmentId}::uuid
    `)
  ).rows[0]?.subsidiaryId ?? null;
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
    // The project's own subsidiary fences the priced read: an A-scoped
    // caller pricing B's project refuses exactly like a fabricated id.
    await assertProjectInScope(exec, orgId, input.projectId, lens);
    const project = (
      await exec.execute<{ subsidiaryId: string | null; custom: Record<string, unknown> }>(sql`
        select subsidiary_id::text as "subsidiaryId", custom
          from projects where org_id = ${orgId}::uuid and id = ${input.projectId}::uuid
      `)
    ).rows[0];
    projectSubsidiary = project?.subsidiaryId ?? null;
    const customLocation = (project?.custom as Record<string, unknown> | null)?.location_id;
    projectLocation = typeof customLocation === "string" ? customLocation : null;
  }
  const target = {
    projectId: input.projectId,
    locationId: projectLocation,
    subsidiaryId: employmentSubsidiary ?? projectSubsidiary,
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
