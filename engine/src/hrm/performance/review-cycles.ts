import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { HrmAuthorizationError, requireAggregatePerformanceManage } from "../authorization.ts";
import { HEADCOUNT_STATUSES, HRM_FEATURE_KEY } from "../employment-read.ts";
import { HrmPerformanceError, mathRefusal } from "./errors.ts";
import {
  parseAppliesScope,
  parseCivilDay,
  parseRatingScale,
  scopeMatchesEmployment,
} from "./performance-math.ts";

/**
 * Governed HRM review cycles (0196, HR-7).
 *
 * A cycle is the org's review run over a period: draft → open →
 * calibrating → closed. Opening instantiates, in ONE transaction, a self
 * review for every in-service employment in scope as of period_end_on plus
 * a manager review for each whose line manager resolves as of that date;
 * employments with no manager get the self review only and the cycle
 * records the gap count. Every conditional write asserts its affected row
 * count — a zero-row write is a refusal, never a success — and every
 * refusal names its remedy.
 *
 * In-service enumeration mirrors the canonical employment read predicates
 * (currently-asserted versions whose effective window contains the as-of
 * date, counted statuses from HEADCOUNT_STATUSES) because the read service
 * resolves one employment per call and a cycle must open the whole in-scope
 * set atomically. More than one applicable live version for an employment
 * refuses the open — never a silent choice — even though the storage
 * no-overlap exclusion should make it impossible.
 *
 * Authorization is hardwired to engine/src/hrm/authorization.ts. Writes run
 * on the transaction runner so each check and its write are atomic. Do not
 * touch packages/payroll. Existing refusal classes are untouched.
 */

export type CycleStatus = "draft" | "open" | "calibrating" | "closed";

const CYCLE_STATUSES = ["draft", "open", "calibrating", "closed"] as const;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function requireId(field: string, value: unknown): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new HrmPerformanceError("INVALID_INPUT", `${field} must be a uuid`);
  }
  return value;
}

function requireText(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HrmPerformanceError("INVALID_INPUT", `${field} must be a non-blank string`);
  }
  return value.trim();
}

async function assertPerformanceFeature(exec: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_FEATURE_KEY))) {
    throw new HrmPerformanceError(
      "FEATURE_OFF",
      "hrm feature is disabled: enable it on Company Settings → Features before running review cycles",
    );
  }
}

export interface CreateCycleInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly templateId: string;
  readonly name: string;
  readonly periodStartOn: string;
  readonly periodEndOn: string;
  readonly selfDueOn?: string | null;
  readonly managerDueOn?: string | null;
  readonly appliesTo?: unknown;
}

export interface CycleDTO {
  readonly id: string;
  readonly templateId: string;
  readonly name: string;
  readonly periodStartOn: string;
  readonly periodEndOn: string;
  readonly selfDueOn: string | null;
  readonly managerDueOn: string | null;
  readonly status: CycleStatus;
  readonly appliesTo: { employerSubsidiaryId: string | null; departmentId: string | null };
  readonly managerGapCount: number;
  readonly openedAt: string | null;
  readonly closedAt: string | null;
}

type StoredCycle = {
  id: string;
  templateId: string;
  name: string;
  periodStartOn: string;
  periodEndOn: string;
  selfDueOn: string | null;
  managerDueOn: string | null;
  status: string;
  appliesTo: unknown;
  managerGapCount: number;
  openedAt: string | null;
  closedAt: string | null;
};

function toCycleDTO(row: StoredCycle): CycleDTO {
  if (!(CYCLE_STATUSES as readonly string[]).includes(row.status)) {
    throw new HrmPerformanceError("BAD_STATE", `review cycle ${row.id} carries an unknown status`);
  }
  return {
    id: row.id,
    templateId: row.templateId,
    name: row.name,
    periodStartOn: row.periodStartOn,
    periodEndOn: row.periodEndOn,
    selfDueOn: row.selfDueOn,
    managerDueOn: row.managerDueOn,
    status: row.status as CycleStatus,
    appliesTo: mathRefusal("REFUSED", () => parseAppliesScope(row.appliesTo)),
    managerGapCount: row.managerGapCount,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
  };
}

async function loadCycle(exec: SqlExecutor, orgId: string, cycleId: string): Promise<StoredCycle> {
  const row = (await exec.execute<StoredCycle>(sql`
    select id,
           template_id as "templateId",
           name,
           period_start_on::text as "periodStartOn",
           period_end_on::text as "periodEndOn",
           self_due_on::text as "selfDueOn",
           manager_due_on::text as "managerDueOn",
           status,
           applies_to as "appliesTo",
           manager_gap_count as "managerGapCount",
           opened_at as "openedAt",
           closed_at as "closedAt"
      from hrm_review_cycles
     where org_id = ${orgId} and id = ${cycleId}
  `)).rows[0];
  // Zero rows is a failure: unknown id, or an id from another organization
  // (the org_id predicate is the org-isolation enforcement).
  if (!row) {
    throw new HrmPerformanceError(
      "NOT_FOUND",
      `review cycle ${cycleId} is not visible in this organization — check the id or the organization`,
    );
  }
  return row;
}

/** A draft cycle: the run is declared but instantiates nothing yet. */
export async function createCycle(input: CreateCycleInput): Promise<CycleDTO> {
  const orgId = requireId("orgId", input.orgId);
  const actorId = requireId("actorId", input.actorId);
  const templateId = requireId("templateId", input.templateId);
  const name = requireText("name", input.name);
  const periodStartOn = mathRefusal("INVALID_INPUT", () => parseCivilDay(input.periodStartOn, "period start"));
  const periodEndOn = mathRefusal("INVALID_INPUT", () => parseCivilDay(input.periodEndOn, "period end"));
  if (periodEndOn < periodStartOn) {
    throw new HrmPerformanceError(
      "REFUSED",
      `review period ends ${periodEndOn} before it starts ${periodStartOn} — set an end on or after the start`,
    );
  }
  const selfDueOn = input.selfDueOn == null ? null : mathRefusal("INVALID_INPUT", () => parseCivilDay(input.selfDueOn as string, "self due date"));
  const managerDueOn = input.managerDueOn == null ? null : mathRefusal("INVALID_INPUT", () => parseCivilDay(input.managerDueOn as string, "manager due date"));
  const scope = mathRefusal("INVALID_INPUT", () => parseAppliesScope(input.appliesTo ?? {}));
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    const allowed = await requireAggregatePerformanceManage(db, orgId, actorId);
    // Creation validates against the DECLARED scope — a caller cannot plant
    // a cycle over a legal entity they cannot see.
    if (scope.employerSubsidiaryId !== null && allowed !== null && !allowed.has(scope.employerSubsidiaryId)) {
      throw new HrmAuthorizationError(
        "Review cycle is not visible in this organization and legal-entity scope.",
      );
    }
    // The scope must name entities that exist here: a cycle that can never
    // apply is refused by field name instead of saved as applicable.
    const refs = (await db.execute<{ subsidiaryOk: boolean; departmentOk: boolean }>(sql`
      select
        ${scope.employerSubsidiaryId ? sql`exists(select 1 from subsidiaries where id = ${scope.employerSubsidiaryId} and org_id = ${orgId})` : sql`true`} as "subsidiaryOk",
        ${scope.departmentId ? sql`exists(select 1 from departments where id = ${scope.departmentId} and org_id = ${orgId})` : sql`true`} as "departmentOk"
    `)).rows[0]!;
    if (!refs.subsidiaryOk) {
      throw new HrmPerformanceError(
        "REFUSED",
        "the cycle subsidiary is not visible in this organization — pick a subsidiary of this org, or null for all",
      );
    }
    if (!refs.departmentOk) {
      throw new HrmPerformanceError(
        "REFUSED",
        "the cycle department is not visible in this organization — pick a department of this org, or null for all",
      );
    }
    const template = (await db.execute<{ id: string; isActive: boolean }>(sql`
      select id, is_active as "isActive" from hrm_review_templates
       where org_id = ${orgId} and id = ${templateId}
    `)).rows[0];
    if (!template) {
      throw new HrmPerformanceError(
        "TEMPLATE_NOT_FOUND",
        `review template ${templateId} is not visible in this organization — create it under /admin/setup first`,
      );
    }
    if (!template.isActive) {
      throw new HrmPerformanceError(
        "REFUSED",
        `review template ${templateId} is deactivated — reactivate it under /admin/setup before opening a cycle on it`,
      );
    }
    const row = (await db.execute<StoredCycle>(sql`
      insert into hrm_review_cycles
        (org_id, template_id, name, period_start_on, period_end_on,
         self_due_on, manager_due_on, status, applies_to, created_by, updated_by)
      values (${orgId}, ${templateId}, ${name}, ${periodStartOn}::date, ${periodEndOn}::date,
        ${selfDueOn}::date, ${managerDueOn}::date, 'draft', ${JSON.stringify({
          employer_subsidiary_id: scope.employerSubsidiaryId,
          department_id: scope.departmentId,
        })}::jsonb, ${actorId}, ${actorId})
      returning id,
        template_id as "templateId", name,
        period_start_on::text as "periodStartOn", period_end_on::text as "periodEndOn",
        self_due_on::text as "selfDueOn", manager_due_on::text as "managerDueOn",
        status, applies_to as "appliesTo",
        manager_gap_count as "managerGapCount",
        opened_at as "openedAt", closed_at as "closedAt"
    `)).rows[0]!;
    return toCycleDTO(row);
  });
}

type InServiceEmployment = {
  employmentId: string;
  workerPartyId: string;
  employerSubsidiaryId: string;
  departmentId: string | null;
};

/**
 * Every in-service employment in scope as of the date: currently-asserted
 * versions whose effective window contains it, in a counted status, with
 * the live primary assignment's department. More than one applicable live
 * version refuses — never a silent choice.
 */
async function loadInServiceEmployments(
  exec: SqlExecutor,
  orgId: string,
  asOf: string,
): Promise<InServiceEmployment[]> {
  const rows = (await exec.execute<{
    employmentId: string;
    workerPartyId: string;
    employerSubsidiaryId: string;
    statuses: string[];
  }>(sql`
    select e.id as "employmentId",
           e.worker_party_id as "workerPartyId",
           e.employer_subsidiary_id as "employerSubsidiaryId",
           array_agg(v.status) as statuses
      from worker_employments e
      join worker_employment_versions v
        on v.org_id = e.org_id and v.employment_id = e.id
       and v.recorded_until is null
       and v.effective_from <= ${asOf}::date
       and (v.effective_to is null or v.effective_to > ${asOf}::date)
     where e.org_id = ${orgId}
     group by e.id, e.worker_party_id, e.employer_subsidiary_id
  `)).rows;
  const inService: InServiceEmployment[] = [];
  for (const row of rows) {
    if (row.statuses.length !== 1) {
      throw new HrmPerformanceError(
        "REFUSED",
        `employment ${row.employmentId} has ${row.statuses.length} applicable versions as of ${asOf} — correct the overlapping versions with an HRM employment change request and re-open the cycle`,
      );
    }
    if (!(HEADCOUNT_STATUSES as readonly string[]).includes(row.statuses[0]!)) continue;
    const dept = (await exec.execute<{ departmentId: string | null }>(sql`
      select av.department_id as "departmentId"
        from employment_assignment_versions av
       where av.org_id = ${orgId}
         and av.employment_id = ${row.employmentId}
         and av.is_primary
         and av.recorded_until is null
         and av.effective_from <= ${asOf}::date
         and (av.effective_to is null or av.effective_to > ${asOf}::date)
       order by av.version_no desc
       limit 1
    `)).rows[0];
    inService.push({
      employmentId: row.employmentId,
      workerPartyId: row.workerPartyId,
      employerSubsidiaryId: row.employerSubsidiaryId,
      departmentId: dept?.departmentId ?? null,
    });
  }
  return inService;
}

type ManagerResolution = { managerEmploymentId: string; managerPartyId: string } | null;

/** The line manager's employment and party as of the date, or null (the gap). */
async function resolveLineManager(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
  asOf: string,
): Promise<ManagerResolution> {
  const active = (await exec.execute<{
    managerEmploymentId: string;
    managerPartyId: string;
  }>(sql`
    select distinct r.manager_employment_id as "managerEmploymentId",
           m.worker_party_id as "managerPartyId"
      from reporting_relationships r
      join worker_employments m
        on m.org_id = r.org_id and m.id = r.manager_employment_id
     where r.org_id = ${orgId}
       and r.employment_id = ${employmentId}
       and r.kind = 'line'
       and r.recorded_until is null
       and r.effective_from <= ${asOf}::date
       and (r.effective_to is null or r.effective_to > ${asOf}::date)
  `)).rows;
  if (active.length === 0) return null;
  if (active.length > 1) {
    throw new HrmPerformanceError(
      "REFUSED",
      `employment ${employmentId} reports to ${active.length} managers as of ${asOf} — correct reporting_relationships with an HRM employment change request and re-open the cycle; refusing to pick one`,
    );
  }
  return active[0]!;
}

type TemplateSnapshot = {
  scale: { min: string; max: string };
  sections: {
    title: string;
    position: number;
    questions: { prompt: string; position: number; answerKind: string; required: boolean }[];
  }[];
};

/** The template form as answer rows: sections with their questions, ordered. */
async function loadTemplateSnapshot(
  exec: SqlExecutor,
  orgId: string,
  templateId: string,
): Promise<TemplateSnapshot> {
  const template = (await exec.execute<{ ratingScale: unknown; isActive: boolean }>(sql`
    select rating_scale as "ratingScale", is_active as "isActive"
      from hrm_review_templates where org_id = ${orgId} and id = ${templateId}
  `)).rows[0];
  if (!template) {
    throw new HrmPerformanceError(
      "TEMPLATE_NOT_FOUND",
      `review template ${templateId} is not visible in this organization — create it under /admin/setup first`,
    );
  }
  if (!template.isActive) {
    throw new HrmPerformanceError(
      "REFUSED",
      `review template ${templateId} is deactivated — reactivate it under /admin/setup before opening the cycle`,
    );
  }
  // The scale must parse before anything instantiates: answers submitted
  // against an unreadable scale would validate against nothing.
  const scale = mathRefusal("REFUSED", () => parseRatingScale(template.ratingScale));
  const sections = (await exec.execute<{ id: string; title: string; position: number }>(sql`
    select id, title, position from hrm_review_template_sections
     where org_id = ${orgId} and template_id = ${templateId}
     order by position
  `)).rows;
  const snapshot: TemplateSnapshot = { scale, sections: [] };
  for (const section of sections) {
    const questions = (await exec.execute<{
      prompt: string;
      position: number;
      answerKind: string;
      required: boolean;
    }>(sql`
      select prompt, position, answer_kind as "answerKind", required
        from hrm_review_template_questions
       where org_id = ${orgId} and section_id = ${section.id}
       order by position
    `)).rows;
    snapshot.sections.push({
      title: section.title,
      position: section.position,
      questions,
    });
  }
  return snapshot;
}

/**
 * Open a draft cycle: instantiate self + manager reviews with snapshotted
 * answers in ONE transaction. An employment with no manager gets the self
 * review only and the cycle records the gap count. Refused when the
 * template carries no required question, or when the period is inverted.
 */
export async function openCycle(args: {
  orgId: string;
  actorId: string;
  cycleId: string;
}): Promise<{ cycle: CycleDTO; instantiated: number; managerReviews: number; gaps: number }> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const cycleId = requireId("cycleId", args.cycleId);
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    const allowed = await requireAggregatePerformanceManage(db, orgId, actorId);
    const cycle = await loadCycle(db, orgId, cycleId);
    if (cycle.status !== "draft") {
      throw new HrmPerformanceError(
        "BAD_STATE",
        `review cycle ${cycleId} is ${cycle.status} — only a draft cycle opens`,
      );
    }
    const dto = toCycleDTO(cycle);
    if (dto.periodEndOn < dto.periodStartOn) {
      throw new HrmPerformanceError(
        "REFUSED",
        `review cycle ${cycleId} ends ${dto.periodEndOn} before it starts ${dto.periodStartOn} — fix the period before opening`,
      );
    }
    const snapshot = await loadTemplateSnapshot(db, orgId, dto.templateId);
    const requiredCount = snapshot.sections.flatMap((s) => s.questions).filter((q) => q.required).length;
    if (requiredCount === 0) {
      throw new HrmPerformanceError(
        "NO_REQUIRED_QUESTION",
        `review template ${dto.templateId} carries no required question — add a required question to the template under /admin/setup before opening the cycle`,
      );
    }
    const inService = await loadInServiceEmployments(db, orgId, dto.periodEndOn);
    const scoped = inService.filter(
      (e) =>
        (allowed === null || allowed.has(e.employerSubsidiaryId)) &&
        scopeMatchesEmployment(dto.appliesTo, {
          employerSubsidiaryId: e.employerSubsidiaryId,
          departmentId: e.departmentId,
        }),
    );
    let instantiated = 0;
    let managerReviews = 0;
    let gaps = 0;
    // Claim the transition FIRST: exactly one row leaves draft, so two
    // concurrent openers serialize here — the loser is refused before
    // writing a single review, and any later failure rolls the claim back
    // with the transaction, so a partial instantiation cannot exist.
    const moved = (await db.execute(sql`
      update hrm_review_cycles
         set status = 'open', opened_at = now(),
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${cycleId} and status = 'draft'
    `)).rowCount ?? 0;
    if (moved !== 1) {
      throw new HrmPerformanceError(
        "BAD_STATE",
        `review cycle ${cycleId} left draft while opening — re-read the cycle and retry`,
      );
    }
    // Position counter restarts per review: answer rows are unique on
    // (org, review, position) within one review.
    const answerPositions = (sectionIdx: number, questionIdx: number): number =>
      sectionIdx * 10000 + questionIdx;
    for (const employment of scoped) {
      const manager = await resolveLineManager(db, orgId, employment.employmentId, dto.periodEndOn);
      const selfId = (await db.execute<{ id: string }>(sql`
        insert into hrm_reviews
          (org_id, cycle_id, employment_id, subject_party_id, reviewer_party_id,
           kind, status, created_by, updated_by)
        values (${orgId}, ${cycleId}, ${employment.employmentId}, ${employment.workerPartyId},
          ${employment.workerPartyId}, 'self', 'pending', ${actorId}, ${actorId})
        returning id
      `)).rows[0]!.id;
      instantiated += 1;
      await insertAnswers(db, orgId, actorId, selfId, snapshot, answerPositions);
      await db.execute(sql`
        insert into hrm_review_events (org_id, review_id, kind, actor_user_id, reason)
        values (${orgId}, ${selfId}, 'instantiated', ${actorId}, 'cycle opened')
      `);
      if (manager) {
        const managerId = (await db.execute<{ id: string }>(sql`
          insert into hrm_reviews
            (org_id, cycle_id, employment_id, subject_party_id, reviewer_party_id,
             kind, status, created_by, updated_by)
          values (${orgId}, ${cycleId}, ${employment.employmentId}, ${employment.workerPartyId},
            ${manager.managerPartyId}, 'manager', 'pending', ${actorId}, ${actorId})
          returning id
        `)).rows[0]!.id;
        managerReviews += 1;
        await insertAnswers(db, orgId, actorId, managerId, snapshot, answerPositions);
        await db.execute(sql`
          insert into hrm_review_events (org_id, review_id, kind, actor_user_id, reason)
          values (${orgId}, ${managerId}, 'instantiated', ${actorId}, 'cycle opened')
        `);
      } else {
        gaps += 1;
      }
    }
    // The gap count lands last, on the already-open cycle: the reviews
    // above are committed with it or rolled back together.
    const gaped = (await db.execute(sql`
      update hrm_review_cycles
         set manager_gap_count = ${gaps}, updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${cycleId} and status = 'open'
    `)).rowCount ?? 0;
    if (gaped !== 1) {
      throw new HrmPerformanceError(
        "BAD_STATE",
        `review cycle ${cycleId} left open while opening — re-read the cycle and retry`,
      );
    }
    return { cycle: toCycleDTO(await loadCycle(db, orgId, cycleId)), instantiated, managerReviews, gaps };
  });
}

async function insertAnswers(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  reviewId: string,
  snapshot: TemplateSnapshot,
  answerPositions: (sectionIdx: number, questionIdx: number) => number,
): Promise<void> {
  for (const [sectionIdx, section] of snapshot.sections.entries()) {
    // A section with no questions still snapshots nothing: the goals
    // section renders the cycle-period goals even when it asks nothing,
    // so an empty section needs no answer rows.
    if (section.questions.length === 0) continue;
    for (const [questionIdx, question] of section.questions.entries()) {
      await exec.execute(sql`
        insert into hrm_review_answers
          (org_id, review_id, section_title, question_prompt, position,
           answer_kind, required, created_by, updated_by)
        values (${orgId}, ${reviewId}, ${section.title}, ${question.prompt},
          ${answerPositions(sectionIdx, questionIdx)}, ${question.answerKind},
          ${question.required}, ${actorId}, ${actorId})
      `);
    }
  }
}

/**
 * Move an open cycle into calibration. Refused while a required manager
 * review is pending, unless the actor forces with a reason — the reason is
 * recorded as a calibration event on every still-pending manager review so
 * the evidence shows why calibration started without it.
 */
export async function moveToCalibrating(args: {
  orgId: string;
  actorId: string;
  cycleId: string;
  force?: boolean;
  forceReason?: string;
}): Promise<CycleDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const cycleId = requireId("cycleId", args.cycleId);
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    await requireAggregatePerformanceManage(db, orgId, actorId);
    const cycle = await loadCycle(db, orgId, cycleId);
    if (cycle.status !== "open") {
      throw new HrmPerformanceError(
        "BAD_STATE",
        `review cycle ${cycleId} is ${cycle.status} — only an open cycle moves to calibrating`,
      );
    }
    const pending = (await db.execute<{ id: string }>(sql`
      select r.id from hrm_reviews r
      join hrm_review_answers a
        on a.org_id = r.org_id and a.review_id = r.id and a.required
     where r.org_id = ${orgId} and r.cycle_id = ${cycleId}
       and r.kind = 'manager' and r.status = 'pending'
     group by r.id
    `)).rows;
    if (pending.length > 0 && !args.force) {
      throw new HrmPerformanceError(
        "REFUSED",
        `review cycle ${cycleId} has ${pending.length} pending manager reviews with required answers — wait for them, or force calibration with a reason recorded on each pending review`,
      );
    }
    if (pending.length > 0) {
      const reason = args.forceReason?.trim() ?? "";
      if (reason.length === 0) {
        throw new HrmPerformanceError(
          "REFUSED",
          `forcing calibration of cycle ${cycleId} needs a reason — it is recorded on each of the ${pending.length} pending manager reviews`,
        );
      }
      for (const row of pending) {
        await db.execute(sql`
          insert into hrm_review_events (org_id, review_id, kind, actor_user_id, reason)
          values (${orgId}, ${row.id}, 'calibrated', ${actorId},
            ${`calibration started while this review was pending: ${reason}`})
        `);
      }
    }
    const moved = (await db.execute(sql`
      update hrm_review_cycles
         set status = 'calibrating', updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${cycleId} and status = 'open'
    `)).rowCount ?? 0;
    if (moved !== 1) {
      throw new HrmPerformanceError(
        "BAD_STATE",
        `review cycle ${cycleId} left open while moving to calibrating — re-read the cycle and retry`,
      );
    }
    return toCycleDTO(await loadCycle(db, orgId, cycleId));
  });
}

/**
 * Close a cycle from open or calibrating. Closing shares nothing by
 * itself — shared reviews stay shared, unshared reviews stay private.
 */
export async function closeCycle(args: {
  orgId: string;
  actorId: string;
  cycleId: string;
}): Promise<CycleDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const cycleId = requireId("cycleId", args.cycleId);
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    await requireAggregatePerformanceManage(db, orgId, actorId);
    const cycle = await loadCycle(db, orgId, cycleId);
    if (cycle.status !== "open" && cycle.status !== "calibrating") {
      throw new HrmPerformanceError(
        "BAD_STATE",
        `review cycle ${cycleId} is ${cycle.status} — only an open or calibrating cycle closes`,
      );
    }
    const moved = (await db.execute(sql`
      update hrm_review_cycles
         set status = 'closed', closed_at = now(), updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${cycleId} and status = ${cycle.status}
    `)).rowCount ?? 0;
    if (moved !== 1) {
      throw new HrmPerformanceError(
        "BAD_STATE",
        `review cycle ${cycleId} moved while closing — re-read the cycle and retry`,
      );
    }
    return toCycleDTO(await loadCycle(db, orgId, cycleId));
  });
}

export type ReviewTemplateOption = {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
};

/**
 * Review templates for the cycle create dialog: loader-resolved options,
 * active first. HR only (performance read grant) — the dialog renders
 * behind the manage gate, so readers never fetch this.
 */
export async function listReviewTemplates(args: {
  orgId: string;
  actorId: string;
}): Promise<ReviewTemplateOption[]> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    await requireAggregatePerformanceManage(db, orgId, actorId);
    const rows = (await db.execute<ReviewTemplateOption>(sql`
      select id, name, is_active as "isActive"
        from hrm_review_templates
       where org_id = ${orgId}
       order by is_active desc, name
    `)).rows;
    return rows;
  });
}
