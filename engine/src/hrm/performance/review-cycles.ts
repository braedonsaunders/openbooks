import { validateReviewTemplateDocument, type ReviewTemplateDocument } from './template-document.ts';
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { HrmAuthorizationError, requireAggregatePerformanceManage } from "../authorization.ts";
import { HEADCOUNT_STATUSES, HRM_FEATURE_KEY } from "../employment-read.ts";
import { HrmPerformanceError, mathRefusal } from "./errors.ts";
import { inputGuards } from "../input-guards.ts";
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

const { requireUuid } = inputGuards((message) => new HrmPerformanceError("INVALID_INPUT", message));

function requireText(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HrmPerformanceError("INVALID_INPUT", `${field} must be a non-blank string`);
  }
  return value.trim();
}

async function assertPerformanceFeature(exec: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_FEATURE_KEY)) || !(await lockAndCheckOrgFeature(exec,orgId,'hrmPerformance'))) {
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
  readonly requireManagerReviews?: boolean;
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
  revision: number;
  requireManagerReviews: boolean;
  reviewerAssignments: Record<string,string>;
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

/**
 * Cycle transitions act through the aggregate manage grant, so the cycle's
 * declared scope must sit inside the actor's allowed subsidiary set — a
 * legal-entity-restricted HR moves only the cycles they cover. An
 * org-wide cycle (no subsidiary scope) needs an unrestricted HR: moving it
 * touches every legal entity, including ones the actor cannot see.
 */
async function assertCycleInScope(exec: SqlExecutor, orgId: string, allowed: Set<string> | null, cycle: StoredCycle): Promise<void> {
  const scope = mathRefusal("REFUSED", () => parseAppliesScope(cycle.appliesTo));
  const department = scope.departmentId === null
    ? null
    : (await exec.execute<{ subsidiaryId: string | null }>(sql`
        select subsidiary_id as "subsidiaryId" from departments
         where org_id = ${orgId} and id = ${scope.departmentId}
      `)).rows[0] ?? null;
  if (scope.departmentId !== null && department === null) {
    throw new HrmPerformanceError("REFUSED", `review cycle ${cycle.id} names a department outside this organization — choose a department in this organization`);
  }
  if (scope.employerSubsidiaryId !== null && department?.subsidiaryId != null &&
      scope.employerSubsidiaryId !== department.subsidiaryId) {
    throw new HrmPerformanceError("REFUSED", `review cycle ${cycle.id} names a department in another subsidiary — choose a department in the cycle subsidiary`);
  }
  const effectiveSubsidiary = scope.employerSubsidiaryId ?? department?.subsidiaryId ?? null;
  if (allowed === null) return;
  if (effectiveSubsidiary === null || !allowed.has(effectiveSubsidiary)) {
    throw new HrmAuthorizationError(
      `review cycle ${cycle.id} is not visible in this organization and legal-entity scope — ask an HR administrator covering its legal entity to move it`,
    );
  }
}

async function loadCycle(exec: SqlExecutor, orgId: string, cycleId: string, forUpdate = false): Promise<StoredCycle> {
  const row = (await exec.execute<StoredCycle>(sql`
    select id, revision, require_manager_reviews as "requireManagerReviews", reviewer_assignments as "reviewerAssignments",
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
     where org_id = ${orgId} and id = ${cycleId} ${forUpdate ? sql`for update` : sql``}
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
  const orgId = requireUuid(input.orgId, "orgId");
  const actorId = requireUuid(input.actorId, "actorId");
  const templateId = requireUuid(input.templateId, "templateId");
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
  if(input.requireManagerReviews!==undefined&&typeof input.requireManagerReviews!=='boolean')throw new HrmPerformanceError('INVALID_INPUT','Choose whether every participant requires a manager review.');
  if(selfDueOn&&managerDueOn&&selfDueOn>managerDueOn)throw new HrmPerformanceError('REFUSED','Manager reviews must be due on or after self-reviews. Adjust the due dates.');
  const scope = mathRefusal("INVALID_INPUT", () => parseAppliesScope(input.appliesTo ?? {}));
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    const allowed = await requireAggregatePerformanceManage(db, orgId, actorId);
    // The scope must name entities that exist here: a cycle that can never
    // apply is refused by field name instead of saved as applicable.
    const refs = (await db.execute<{
      subsidiaryOk: boolean;
      departmentOk: boolean;
      departmentSubsidiaryId: string | null;
    }>(sql`
      select
        ${scope.employerSubsidiaryId ? sql`exists(select 1 from subsidiaries where id = ${scope.employerSubsidiaryId} and org_id = ${orgId})` : sql`true`} as "subsidiaryOk",
        ${scope.departmentId ? sql`exists(select 1 from departments where id = ${scope.departmentId} and org_id = ${orgId})` : sql`true`} as "departmentOk",
        ${scope.departmentId ? sql`(select subsidiary_id from departments where id = ${scope.departmentId} and org_id = ${orgId})` : sql`null::uuid`} as "departmentSubsidiaryId"
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
    if (scope.employerSubsidiaryId !== null && refs.departmentSubsidiaryId !== null &&
        scope.employerSubsidiaryId !== refs.departmentSubsidiaryId) {
      throw new HrmPerformanceError("REFUSED", "the cycle department belongs to another subsidiary — choose a department in the selected subsidiary");
    }
    const effectiveSubsidiary = scope.employerSubsidiaryId ?? refs.departmentSubsidiaryId;
    if (allowed !== null && (effectiveSubsidiary === null || !allowed.has(effectiveSubsidiary))) {
      throw new HrmAuthorizationError(
        "a restricted HR review cycle must name a department or employer subsidiary in their scope — choose an allowed scope or ask unrestricted HR to create an org-wide cycle",
      );
    }
    const template = (await db.execute<{ id: string; isActive: boolean }>(sql`
      select id, is_active as "isActive" from hrm_review_templates
       where org_id = ${orgId} and id = ${templateId}
    `)).rows[0];
    if (!template) {
      throw new HrmPerformanceError(
        "TEMPLATE_NOT_FOUND",
        `review template ${templateId} is not visible in this organization — create it under Performance → Templates first`,
      );
    }
    if (!template.isActive) {
      throw new HrmPerformanceError(
        "REFUSED",
        `review template ${templateId} is deactivated — reactivate it under Performance → Templates before opening a cycle on it`,
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
    if(input.requireManagerReviews!==undefined) {
      const changed=await db.execute(sql`update hrm_review_cycles set require_manager_reviews=${input.requireManagerReviews} where org_id=${orgId} and id=${row.id}`);
      if(changed.rowCount!==1) throw new HrmPerformanceError('REFUSED','The review policy was not saved. Retry creating the cycle.');
    }
    await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${orgId},'hrm_review_cycles',${row.id},'insert',${JSON.stringify({event:'cycle_created',before:null,after:{...toCycleDTO(row),requireManagerReviews:input.requireManagerReviews??false}})}::jsonb,${actorId})`);
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
  instructions?:string;
  scale: { min: string; max: string; labels?: readonly string[] };
  version?: number;
  sections: {
    id: string;
    title: string;
    kind: string;
    weight: string | null;
    competencyId: string | null;
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
  const template = (await exec.execute<{ ratingScale: unknown; isActive: boolean; draft: unknown; published: ReviewTemplateDocument | null; version: number }>(sql`
    select rating_scale as "ratingScale", is_active as "isActive", draft_document as draft, published_document as published, published_version as version
      from hrm_review_templates where org_id = ${orgId} and id = ${templateId} for share
  `)).rows[0];
  if (!template) {
    throw new HrmPerformanceError(
      "TEMPLATE_NOT_FOUND",
      `review template ${templateId} is not visible in this organization — create it under Performance → Templates first`,
    );
  }
  if (!template.isActive) {
    throw new HrmPerformanceError(
      "REFUSED",
      `review template ${templateId} is deactivated — reactivate it under Performance → Templates before opening the cycle`,
    );
  }
  if (template.published) {
    const document = validateReviewTemplateDocument(template.published, true);
    return {instructions:document.instructions,scale:document.ratingScale,version:template.version,
      sections:document.sections.map((s,i)=>({id:s.id,title:s.title,kind:s.kind,weight:s.weight??null,competencyId:s.competencyId??null,position:i,
        questions:s.questions.map((q,j)=>({...q,position:j}))}))};
  }
  if (template.draft) throw new HrmPerformanceError("REFUSED","This review template has not been published. Publish it in Performance → Templates before launching the cycle.");
  // The scale must parse before anything instantiates: answers submitted
  // against an unreadable scale would validate against nothing.
  const scale = mathRefusal("REFUSED", () => parseRatingScale(template.ratingScale));
  const sections = (await exec.execute<{ id: string; title: string; kind: string; weight: string|null; competencyId:string|null; position: number }>(sql`
    select id, title, kind, weight::text as weight, competency_id as "competencyId", position from hrm_review_template_sections
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
      ...section,
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
  const orgId = requireUuid(args.orgId, "orgId");
  const actorId = requireUuid(args.actorId, "actorId");
  const cycleId = requireUuid(args.cycleId, "cycleId");
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    const allowed = await requireAggregatePerformanceManage(db, orgId, actorId);
    const cycle = await loadCycle(db, orgId, cycleId, true);
    await assertCycleInScope(db, orgId, allowed, cycle);
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
        `review template ${dto.templateId} carries no required question — add a required question to the template under Performance → Templates before opening the cycle`,
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
         set status = 'open', opened_at = now(), rating_scale_snapshot = ${JSON.stringify(snapshot.scale)}::jsonb, template_document_snapshot = ${JSON.stringify(snapshot)}::jsonb, template_version = ${snapshot.version ?? 0}, revision = revision + 1,
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
      const override=cycle.reviewerAssignments[employment.employmentId];
      const manager = override ? {managerEmploymentId:'',managerPartyId:override} : await resolveLineManager(db, orgId, employment.employmentId, dto.periodEndOn);
      if(override) await assertReviewer(orgId,allowed,override,employment.workerPartyId,dto.periodEndOn);
      if(!manager && cycle.requireManagerReviews) {
        const name=(await db.execute<{name:string}>(sql`select display_name as name from parties where org_id=${orgId} and id=${employment.workerPartyId}`)).rows[0]?.name??employment.employmentId;
        throw new HrmPerformanceError('REFUSED',`Assign a manager reviewer for ${name} in Participants before launching, or change the cycle policy to permit self-reviews for employees without a manager.`);
      }
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
    const after=toCycleDTO(await loadCycle(db,orgId,cycleId));
    await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${orgId},'hrm_review_cycles',${cycleId},'update',${JSON.stringify({event:'cycle_launched',before:cycle,after:{...after,templateVersion:snapshot.version??0,ratingScale:snapshot.scale,instantiated,managerReviews,gaps}})}::jsonb,${actorId})`);
    return {cycle:after,instantiated,managerReviews,gaps};
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
  const orgId = requireUuid(args.orgId, "orgId");
  const actorId = requireUuid(args.actorId, "actorId");
  const cycleId = requireUuid(args.cycleId, "cycleId");
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    const allowed = await requireAggregatePerformanceManage(db, orgId, actorId);
    const cycle = await loadCycle(db, orgId, cycleId, true);
    await assertCycleInScope(db, orgId, allowed, cycle);
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
         set status = 'calibrating', revision=revision+1, updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${cycleId} and status = 'open'
    `)).rowCount ?? 0;
    if (moved !== 1) {
      throw new HrmPerformanceError(
        "BAD_STATE",
        `review cycle ${cycleId} left open while moving to calibrating — re-read the cycle and retry`,
      );
    }
    const after=toCycleDTO(await loadCycle(db,orgId,cycleId));
    await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${orgId},'hrm_review_cycles',${cycleId},'update',${JSON.stringify({event:after.status==='closed'?'cycle_closed':'calibration_started',before:cycle,after})}::jsonb,${actorId})`);
    return after;
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
  const orgId = requireUuid(args.orgId, "orgId");
  const actorId = requireUuid(args.actorId, "actorId");
  const cycleId = requireUuid(args.cycleId, "cycleId");
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    const allowed = await requireAggregatePerformanceManage(db, orgId, actorId);
    const cycle = await loadCycle(db, orgId, cycleId,true);
    await assertCycleInScope(db, orgId, allowed, cycle);
    if (cycle.status !== "open" && cycle.status !== "calibrating") {
      throw new HrmPerformanceError(
        "BAD_STATE",
        `review cycle ${cycleId} is ${cycle.status} — only an open or calibrating cycle closes`,
      );
    }
    const moved = (await db.execute(sql`
      update hrm_review_cycles
         set status = 'closed', revision=revision+1, closed_at = now(), updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${cycleId} and status = ${cycle.status}
    `)).rowCount ?? 0;
    if (moved !== 1) {
      throw new HrmPerformanceError(
        "BAD_STATE",
        `review cycle ${cycleId} moved while closing — re-read the cycle and retry`,
      );
    }
    const after=toCycleDTO(await loadCycle(db,orgId,cycleId));
    await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${orgId},'hrm_review_cycles',${cycleId},'update',${JSON.stringify({event:after.status==='closed'?'cycle_closed':'calibration_started',before:cycle,after})}::jsonb,${actorId})`);
    return after;
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
  const orgId = requireUuid(args.orgId, "orgId");
  const actorId = requireUuid(args.actorId, "actorId");
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    await requireAggregatePerformanceManage(db, orgId, actorId);
    const rows = (await db.execute<ReviewTemplateOption>(sql`
      select id, name, is_active as "isActive"
        from hrm_review_templates
       where org_id = ${orgId} and (draft_document is null or published_document is not null)
       order by is_active desc, name
    `)).rows;
    return rows;
  });
}

async function assertReviewer(orgId:string,allowed:Set<string>|null,partyId:string,subjectPartyId:string,asOf:string) {
  requireUuid(partyId,'reviewerPartyId');
  const eligible=(await loadInServiceEmployments(db,orgId,asOf)).some(e=>e.workerPartyId===partyId && (allowed===null||allowed.has(e.employerSubsidiaryId)));
  if(!eligible || partyId===subjectPartyId) throw new HrmPerformanceError('REFUSED','Choose another in-service employee in your legal-entity scope as the manager reviewer.');
}

export async function getCycleManagement(args:{orgId:string;actorId:string;cycleId:string}) {
  const orgId=requireUuid(args.orgId,'orgId'),actorId=requireUuid(args.actorId,'actorId'),cycleId=requireUuid(args.cycleId,'cycleId');
  return withOrgTransaction(orgId,async()=>{
    await assertPerformanceFeature(db,orgId);
    const allowed=await requireAggregatePerformanceManage(db,orgId,actorId);
    const cycle=await loadCycle(db,orgId,cycleId);await assertCycleInScope(db,orgId,allowed,cycle);
    const all=cycle.status==='draft'?await loadInServiceEmployments(db,orgId,cycle.periodEndOn):
      (await db.execute<InServiceEmployment>(sql`select distinct r.employment_id as "employmentId",r.subject_party_id as "workerPartyId",e.employer_subsidiary_id as "employerSubsidiaryId",null::uuid as "departmentId"
        from hrm_reviews r join worker_employments e on e.org_id=r.org_id and e.id=r.employment_id
        where r.org_id=${orgId} and r.cycle_id=${cycleId}`)).rows;
    const eligible=all.filter(e=>allowed===null||allowed.has(e.employerSubsidiaryId));
    const names=(await db.execute<{id:string;name:string}>(sql`select id,display_name as name from parties where org_id=${orgId} and id in (select worker_party_id from worker_employments where org_id=${orgId})`)).rows;
    const nameMap=new Map(names.map(p=>[p.id,p.name]));
    const participants=[];
    for(const e of eligible.filter(e=>cycle.status!=='draft'||scopeMatchesEmployment(toCycleDTO(cycle).appliesTo,e))){
      const manager=cycle.status==='draft'?cycle.reviewerAssignments[e.employmentId]??(await resolveLineManager(db,orgId,e.employmentId,cycle.periodEndOn))?.managerPartyId??null:
        (await db.execute<{partyId:string}>(sql`select reviewer_party_id as "partyId" from hrm_reviews where org_id=${orgId} and cycle_id=${cycleId} and employment_id=${e.employmentId} and kind='manager'`)).rows[0]?.partyId??null;
      participants.push({id:e.employmentId,name:nameMap.get(e.workerPartyId)??e.employmentId,subjectPartyId:e.workerPartyId,reviewerPartyId:manager,reviewerName:manager?nameMap.get(manager)??manager:null});
    }
    const history=(await db.execute<{at:string;event:string;actor:string|null}>(sql`
      select a.at::text as at, a.changes->>'event' as event,u.name as actor from audit_log a
      left join users u on u.org_id=a.org_id and u.id=a.actor_id where a.org_id=${orgId} and a.table_name='hrm_review_cycles' and a.row_id=${cycleId} order by a.at desc limit 100
    `)).rows;
    return {revision:cycle.revision,requireManagerReviews:cycle.requireManagerReviews,
      selfDueOn:cycle.selfDueOn,managerDueOn:cycle.managerDueOn,
      participants,reviewers:eligible.map(e=>({value:e.workerPartyId,label:nameMap.get(e.workerPartyId)??e.workerPartyId})),history};
  });
}
export async function updateCycleManagement(args:{orgId:string;actorId:string;cycleId:string;revision:number;name?:string;selfDueOn?:string|null;managerDueOn?:string|null;requireManagerReviews?:boolean;employmentId?:string;reviewerPartyId?:string}) {
  const orgId=requireUuid(args.orgId,'orgId'),actorId=requireUuid(args.actorId,'actorId'),cycleId=requireUuid(args.cycleId,'cycleId');
  return withOrgTransaction(orgId,async()=>{
    await assertPerformanceFeature(db,orgId);
    const allowed=await requireAggregatePerformanceManage(db,orgId,actorId);
    const cycle=await loadCycle(db,orgId,cycleId,true);await assertCycleInScope(db,orgId,allowed,cycle);
    if(cycle.status==='closed'||cycle.status==='calibrating') throw new HrmPerformanceError('BAD_STATE','Only draft or open cycles can change settings or reviewer assignments.');
    if(cycle.revision!==args.revision) throw new HrmPerformanceError('STALE_REVISION','This cycle changed in another session. Reload its participants and settings before saving.');
    if(args.requireManagerReviews!==undefined&&typeof args.requireManagerReviews!=='boolean')throw new HrmPerformanceError('INVALID_INPUT','Choose whether every participant requires a manager review.');
    if(cycle.status!=='draft'&&args.requireManagerReviews!==undefined&&args.requireManagerReviews!==cycle.requireManagerReviews)throw new HrmPerformanceError('REFUSED','The participant policy is captured at launch. Create a new cycle to change that policy.');
    const self=args.selfDueOn===undefined?cycle.selfDueOn:args.selfDueOn===null?null:mathRefusal('INVALID_INPUT',()=>parseCivilDay(args.selfDueOn,'Self-review due date'));
    const manager=args.managerDueOn===undefined?cycle.managerDueOn:args.managerDueOn===null?null:mathRefusal('INVALID_INPUT',()=>parseCivilDay(args.managerDueOn,'Manager review due date'));
    if(self && manager && self>manager) throw new HrmPerformanceError('REFUSED','Manager reviews must be due on or after self-reviews. Adjust the due dates.');
    const assignments={...cycle.reviewerAssignments};
    if(args.employmentId){
      const employmentId=requireUuid(args.employmentId,'employmentId');
      const employment=(await loadInServiceEmployments(db,orgId,cycle.periodEndOn)).find(e=>e.employmentId===employmentId && scopeMatchesEmployment(toCycleDTO(cycle).appliesTo,e) && (allowed===null||allowed.has(e.employerSubsidiaryId)));
      if(!employment) throw new HrmPerformanceError('NOT_FOUND','This employee is not in the cycle audience. Reload the participant list.');
      const reviewer=requireUuid(args.reviewerPartyId,'reviewerPartyId');
      await assertReviewer(orgId,allowed,reviewer,employment.workerPartyId,cycle.periodEndOn);
      if(cycle.status!=='draft') throw new HrmPerformanceError('REFUSED','Launched reviewers are captured assignments. Create a new cycle to change reviewer ownership; saved or submitted reviews must retain their author.');
      assignments[employmentId]=reviewer;
    }
    const changed=await db.execute(sql`update hrm_review_cycles set name=${args.name===undefined?cycle.name:requireText('Cycle name',args.name)},
      self_due_on=${self}::date,manager_due_on=${manager}::date,require_manager_reviews=${args.requireManagerReviews??cycle.requireManagerReviews},
      reviewer_assignments=${JSON.stringify(assignments)}::jsonb,revision=revision+1,updated_at=now(),updated_by=${actorId}
      where org_id=${orgId} and id=${cycleId} and revision=${args.revision}`);
    if(changed.rowCount!==1) throw new HrmPerformanceError('STALE_REVISION','This cycle changed while saving. Reload it and retry.');
    const after=await loadCycle(db,orgId,cycleId);
    await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
      values(${orgId},'hrm_review_cycles',${cycleId},'update',${JSON.stringify({event:args.employmentId?'reviewer_assigned':'cycle_settings_updated',before:cycle,after})}::jsonb,${actorId})`);
    return getCycleManagement(args);
  });
}

export async function listCycleScopeOptions(args:{orgId:string;actorId:string}) {
  const orgId=requireUuid(args.orgId,'orgId'),actorId=requireUuid(args.actorId,'actorId');
  return withOrgTransaction(orgId,async()=>{
    await assertPerformanceFeature(db,orgId);
    const allowed=await requireAggregatePerformanceManage(db,orgId,actorId);
    const subsidiaries=(await db.execute<{value:string;label:string}>(sql`select id as value,name as label from subsidiaries where org_id=${orgId} order by name`)).rows.filter(r=>allowed===null||allowed.has(r.value));
    const departments=(await db.execute<{value:string;label:string;subsidiaryId:string|null}>(sql`select id as value,name as label,subsidiary_id as "subsidiaryId" from departments where org_id=${orgId} order by name`)).rows.filter(r=>allowed===null||r.subsidiaryId!==null&&allowed.has(r.subsidiaryId));
    return {subsidiaries,departments,unrestricted:allowed===null};
  });
}
