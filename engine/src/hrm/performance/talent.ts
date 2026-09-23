import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { requireAggregatePerformanceManage } from "../authorization.ts";
import { HRM_FEATURE_KEY } from "../employment-read.ts";
import { HrmPerformanceError, isUniqueViolationOn } from "./errors.ts";
import { HRM_PERFORMANCE_CONTINUOUS_KEY } from "./one-on-ones.ts";

/**
 * Governed HRM talent reviews and succession plans (0228, HR-17).
 *
 * Talent reviews are the manager questionnaire per report per cycle;
 * succession plans are ranked readiness pipelines per position. Both are
 * HR-only reads (hrm.performance.manage) — the subject never sees their
 * own talent review and a candidate has no self view. Every read and
 * every write enforces that here, never in the UI alone: a subject
 * asking for their row gets NOT_FOUND uniformly, so the row's existence
 * cannot be probed.
 *
 * The 9-box read is performance × potential over the ORG-DECLARED
 * scales — never a hardcoded 3x3. Scales resolve from the review
 * template of the queried cycle (its rating_scale labels); without
 * labels the grid is refused by name. The grid is therefore
 * scales.length × scales.length whatever the org declares.
 *
 * Do not touch packages/payroll. Existing refusal classes are untouched.
 */

export const HRM_TALENT_KEY = "hrmSuccession" as const;
export const HRM_CALIBRATION_READ_KEY = "hrmCalibration" as const;

export type LossLevel = "low" | "medium" | "high";
export type CandidateReadiness = "ready_now" | "one_to_two_years" | "three_plus";
export type SuccessionPlanStatus = "draft" | "active" | "archived";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function requireId(field: string, value: unknown): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new HrmPerformanceError("INVALID_INPUT", `${field} must be a uuid`);
  }
  return value;
}

/**
 * SQL predicate restricting employment-anchored rows to the actor's allowed
 * employer set (null = unrestricted). The set comes from
 * requireAggregatePerformanceManage / HR read grants — never caller input —
 * and every read and mutation below threads it through, so scoped HR revises
 * only their own subsidiaries.
 */
function employmentScopeFilter(allowed: Set<string> | null, alias: string): ReturnType<typeof sql> {
  if (allowed === null) return sql``;
  const ids = [...allowed].map((id) => sql`${id}::uuid`);
  // One parameter per id: bare JS arrays must never be interpolated into
  // ANY() (they bind as row constructors, not PostgreSQL arrays).
  return sql`and ${sql.raw(alias)}.employer_subsidiary_id in (${sql.join(ids, sql`, `)})`;
}

/** The latest live version's employer: positions carry subsidiary on their versions, not the header. */
async function loadPositionSubsidiary(
  exec: SqlExecutor,
  orgId: string,
  positionId: string,
): Promise<string | null> {
  const row = (await exec.execute<{ employerSubsidiaryId: string }>(sql`
    select employer_subsidiary_id as "employerSubsidiaryId"
      from position_versions
     where org_id = ${orgId} and position_id = ${positionId} and recorded_until is null
     order by version_no desc limit 1
  `)).rows[0];
  return row?.employerSubsidiaryId ?? null;
}

/** Uniform NOT_FOUND for an out-of-scope position: existence must not be probeable across the fence. */
function assertPositionInScope(subsidiaryId: string | null, allowed: Set<string> | null): void {
  if (allowed !== null && (subsidiaryId === null || !allowed.has(subsidiaryId))) {
    throw new HrmPerformanceError("NOT_FOUND", "position was not found — plan succession for a directory position");
  }
}

/** A cycle's declared subsidiary, read leniently: extra envelope keys (potential_labels) never fail the scope read. */
function cycleScopeSubsidiary(appliesTo: unknown): string | null {
  if (!appliesTo || typeof appliesTo !== "object" || Array.isArray(appliesTo)) return null;
  const raw = (appliesTo as Record<string, unknown>).employer_subsidiary_id;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/** Uniform NOT_FOUND for an out-of-scope cycle. */
function assertCycleInScope(appliesTo: unknown, allowed: Set<string> | null): void {
  const subsidiaryId = cycleScopeSubsidiary(appliesTo);
  if (allowed !== null && subsidiaryId !== null && !allowed.has(subsidiaryId)) {
    throw new HrmPerformanceError("NOT_FOUND", "review cycle was not found — open the grid over an existing cycle");
  }
}

async function assertTalentFeature(db: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(db, orgId, HRM_FEATURE_KEY))) {
    throw new HrmPerformanceError(
      "FEATURE_OFF",
      "hrm feature is disabled: enable it on Company Settings → Features before opening talent reviews",
    );
  }
  if (!(await lockAndCheckOrgFeature(db, orgId, HRM_PERFORMANCE_CONTINUOUS_KEY))) {
    throw new HrmPerformanceError(
      "FEATURE_OFF",
      "hrmPerformance feature is disabled: enable it on Company Settings → Features before opening talent reviews",
    );
  }
  if (!(await lockAndCheckOrgFeature(db, orgId, HRM_TALENT_KEY))) {
    throw new HrmPerformanceError(
      "FEATURE_OFF",
      "hrmSuccession feature is disabled: enable it on Company Settings → Features before opening talent reviews",
    );
  }
}

export interface TalentReviewDTO {
  readonly id: string;
  readonly employmentId: string;
  readonly employeeName: string;
  readonly cycleId: string | null;
  readonly performanceKey: string;
  readonly potentialKey: string;
  readonly impactOfLoss: LossLevel;
  readonly riskOfLoss: LossLevel;
  readonly promotionReady: boolean;
  readonly notes: string | null;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
}

export async function recordTalentReview(args: {
  orgId: string;
  actorId: string;
  employmentId: string;
  cycleId?: string | null;
  performanceKey: string;
  potentialKey: string;
  impactOfLoss: LossLevel;
  riskOfLoss: LossLevel;
  promotionReady?: boolean;
  notes?: string | null;
}): Promise<TalentReviewDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const employmentId = requireId("employmentId", args.employmentId);
  const cycleId = args.cycleId ? requireId("cycleId", args.cycleId) : null;
  if (typeof args.performanceKey !== "string" || args.performanceKey.trim().length === 0) {
    throw new HrmPerformanceError("INVALID_INPUT", "a talent review needs a performance key from the org-declared scale");
  }
  if (typeof args.potentialKey !== "string" || args.potentialKey.trim().length === 0) {
    throw new HrmPerformanceError("INVALID_INPUT", "a talent review needs a potential key from the org-declared scale");
  }
  if (!["low", "medium", "high"].includes(args.impactOfLoss) || !["low", "medium", "high"].includes(args.riskOfLoss)) {
    throw new HrmPerformanceError("INVALID_INPUT", "impact and risk of loss must be low, medium, or high");
  }
  return withOrgTransaction(orgId, async () => {
    await assertTalentFeature(db, orgId);
    const allowed = await requireAggregatePerformanceManage(db, orgId, actorId);
    const employment = (await db.execute<{ id: string; employerSubsidiaryId: string }>(sql`
      select id, employer_subsidiary_id as "employerSubsidiaryId"
        from worker_employments where org_id = ${orgId} and id = ${employmentId}
    `)).rows[0];
    // Uniform NOT_FOUND across missing and out-of-scope: a scoped HR actor
    // must not probe employments of subsidiaries they cannot see.
    if (!employment || (allowed !== null && !allowed.has(employment.employerSubsidiaryId))) {
      throw new HrmPerformanceError("NOT_FOUND", "employment was not found — record the talent review against a directory employment");
    }
    if (cycleId) {
      const cycle = (await db.execute<{ id: string; appliesTo: unknown }>(sql`
        select id, applies_to as "appliesTo" from hrm_review_cycles where org_id = ${orgId} and id = ${cycleId}
      `)).rows[0];
      if (!cycle) {
        throw new HrmPerformanceError("NOT_FOUND", "review cycle was not found — attach the talent review to an existing cycle");
      }
      assertCycleInScope(cycle.appliesTo, allowed);
    }
    try {
      const inserted = (await db.execute<{ id: string }>(sql`
        insert into hrm_talent_reviews (org_id, employment_id, cycle_id, performance_key, potential_key,
          impact_of_loss, risk_of_loss, promotion_ready, notes, reviewed_by, reviewed_at, created_by, updated_by)
        values (${orgId}, ${employmentId}, ${cycleId}, ${args.performanceKey.trim()}, ${args.potentialKey.trim()},
                ${args.impactOfLoss}, ${args.riskOfLoss}, ${args.promotionReady ?? false},
                ${args.notes ?? null}, ${actorId}, now(), ${actorId}, ${actorId})
        returning id
      `)).rows[0];
      if (!inserted) throw new HrmPerformanceError("REFUSED", "the talent review was not stored — no row was written; retry the action");
      const dto = await readTalentReview(db, orgId, inserted.id);
      if (!dto) throw new HrmPerformanceError("REFUSED", "the talent review was not stored — no row can be read back; retry the action");
      return dto;
    } catch (e) {
      // The (org, employment, cycle) unique is the authority: only its
      // violation maps to DUPLICATE — any other driver error propagates
      // untouched, never mislabelled.
      if (isUniqueViolationOn(e, "hrm_talent_reviews_unique")) {
        throw new HrmPerformanceError(
          "DUPLICATE",
          "this employment already has a talent review for this cycle — edit that row instead of recording a second",
        );
      }
      throw e;
    }
  });
}

async function readTalentReview(db: SqlExecutor, orgId: string, id: string): Promise<TalentReviewDTO | null> {
  const rows = (await db.execute<{
    id: string; employment_id: string; employee_name: string; cycle_id: string | null; performance_key: string;
    potential_key: string; impact_of_loss: LossLevel; risk_of_loss: LossLevel;
    promotion_ready: boolean; notes: string | null; reviewed_by: string | null; reviewed_at: string | null;
  }>(sql`
    select t.id, t.employment_id, coalesce(p.display_name, '—') as employee_name,
           t.cycle_id::text as cycle_id, t.performance_key, t.potential_key,
           t.impact_of_loss, t.risk_of_loss, t.promotion_ready, t.notes,
           t.reviewed_by::text as reviewed_by, t.reviewed_at::text as reviewed_at
      from hrm_talent_reviews t
      join worker_employments e on e.org_id = t.org_id and e.id = t.employment_id
      left join parties p on p.org_id = t.org_id and p.id = e.worker_party_id
     where t.org_id = ${orgId} and t.id = ${id}
  `)).rows;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id, employmentId: row.employment_id, employeeName: row.employee_name, cycleId: row.cycle_id,
    performanceKey: row.performance_key, potentialKey: row.potential_key,
    impactOfLoss: row.impact_of_loss, riskOfLoss: row.risk_of_loss,
    promotionReady: row.promotion_ready, notes: row.notes,
    reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at,
  };
}

export async function listTalentReviews(args: {
  orgId: string;
  actorId: string;
  cycleId?: string;
}): Promise<readonly TalentReviewDTO[]> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertTalentFeature(db, orgId);
    // HR-only: the subject never sees these rows. A non-HR actor gets
    // the uniform refusal, never a filtered list that leaks existence.
    let allowed: Set<string> | null;
    try {
      allowed = await requireAggregatePerformanceManage(db, orgId, actorId);
    } catch {
      throw new HrmPerformanceError(
        "FORBIDDEN",
        "talent reviews are HR-only — ask an administrator to grant hrm.performance.manage in /admin/roles",
      );
    }
    const cycleFilter = args.cycleId ? sql` and t.cycle_id = ${args.cycleId}` : sql``;
    const rows = (await db.execute<{ id: string }>(sql`
      select t.id from hrm_talent_reviews t
      join worker_employments e on e.org_id = t.org_id and e.id = t.employment_id
       where t.org_id = ${orgId}${cycleFilter} ${employmentScopeFilter(allowed, "e")} order by t.created_at
    `)).rows;
    const out: TalentReviewDTO[] = [];
    for (const row of rows) {
      const dto = await readTalentReview(db, orgId, row.id);
      if (dto) out.push(dto);
    }
    return out;
  });
}

/**
 * Resolve the org-declared 9-box scales for a cycle from its review
 * template's rating_scale labels. Both axes share the template scale
 * unless potential labels are declared separately in the cycle scope;
 * either way the dimension comes from the declaration, never a
 * hardcoded 3x3.
 */
export async function resolveTalentScales(args: {
  orgId: string;
  actorId: string;
  cycleId: string;
}): Promise<{ readonly performance: readonly string[]; readonly potential: readonly string[] }> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const cycleId = requireId("cycleId", args.cycleId);
  return withOrgTransaction(orgId, async () => {
    await assertTalentFeature(db, orgId);
    let allowed: Set<string> | null;
    try {
      allowed = await requireAggregatePerformanceManage(db, orgId, actorId);
    } catch {
      throw new HrmPerformanceError(
        "FORBIDDEN",
        "talent reviews are HR-only — ask an administrator to grant hrm.performance.manage in /admin/roles",
      );
    }
    const cycle = (await db.execute<{ template_id: string | null; applies_to: unknown }>(sql`
      select template_id::text as template_id, applies_to from hrm_review_cycles where org_id = ${orgId} and id = ${cycleId}
    `)).rows[0];
    if (!cycle) throw new HrmPerformanceError("NOT_FOUND", "review cycle was not found — open the grid over an existing cycle");
    assertCycleInScope(cycle.applies_to, allowed);
    // A cycle may declare a separate potential axis in its applies_to
    // envelope (potential_labels); otherwise potential shares the
    // template performance scale. Either way the dimension is declared.
    const scope = (cycle.applies_to ?? {}) as { potential_labels?: unknown };
    const potential =
      Array.isArray(scope.potential_labels) && scope.potential_labels.length > 0
        ? scope.potential_labels.filter((label): label is string => typeof label === "string" && label.length > 0)
        : null;
    let performance: string[] | null = null;
    if (cycle.template_id) {
      const template = (await db.execute<{ rating_scale: unknown }>(sql`
        select rating_scale from hrm_review_templates where org_id = ${orgId} and id = ${cycle.template_id}
      `)).rows[0];
      const scale = (template?.rating_scale ?? {}) as { labels?: unknown };
      if (Array.isArray(scale.labels) && scale.labels.length > 0) {
        performance = scale.labels.filter((label): label is string => typeof label === "string" && label.length > 0);
      }
    }
    if (!performance) {
      throw new HrmPerformanceError(
        "REFUSED",
        "the cycle's review template declares no rating labels — declare the scale labels on the template before opening the talent grid",
      );
    }
    return { performance, potential: potential ?? performance };
  });
}

/**
 * HR directory options for the talent and succession dialogs: every
 * employment with its person name, and every position with its code and
 * latest title. HR-only (the dialogs are HR-only).
 */
export async function listTalentDirectory(args: {
  orgId: string;
  actorId: string;
}): Promise<{ employments: readonly { id: string; name: string }[]; positions: readonly { id: string; code: string; title: string }[] }> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertTalentFeature(db, orgId);
    const allowed = await requireAggregatePerformanceManage(db, orgId, actorId);
    const employments = (await db.execute<{ id: string; name: string }>(sql`
      select e.id, coalesce(p.display_name, '—') as name
        from worker_employments e
        left join parties p on p.org_id = e.org_id and p.id = e.worker_party_id
       where e.org_id = ${orgId} ${employmentScopeFilter(allowed, "e")}
       order by name
    `)).rows;
    // Positions are scoped by their latest live version's employer: a
    // versionless position is undiscoverable to scoped HR (fail closed),
    // while unrestricted HR sees every position as before.
    const positionScope = allowed === null
      ? sql``
      : sql`and exists (select 1 from position_versions v
                         where v.org_id = pos.org_id and v.position_id = pos.id
                           and v.recorded_until is null
                           and v.employer_subsidiary_id in (${sql.join(
                             [...allowed].map((id) => sql`${id}::uuid`),
                             sql`, `,
                           )}))`;
    const positions = (await db.execute<{ id: string; code: string; title: string }>(sql`
      select pos.id, pos.position_code as code,
             coalesce((select v.title from position_versions v
                        where v.org_id = pos.org_id and v.position_id = pos.id
                        order by v.created_at desc limit 1), '—') as title
        from positions pos where pos.org_id = ${orgId} ${positionScope} order by pos.position_code
    `)).rows;
    return { employments, positions };
  });
}

export interface NineBoxDTO {
  readonly performance: readonly string[];
  readonly potential: readonly string[];
  /** cells[performanceKey][potentialKey] = placement count. */
  readonly cells: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly unplaced: number;
}

/**
 * The 9-box read: placements over the org-declared scales. Reviews
 * whose keys fall outside the declared scales count as unplaced (named
 * in the read, never silently dropped or coerced into a cell).
 */
export function buildNineBox(args: {
  performance: readonly string[];
  potential: readonly string[];
  placements: readonly { performanceKey: string; potentialKey: string }[];
}): NineBoxDTO {
  const cells: Record<string, Record<string, number>> = {};
  for (const perf of args.performance) {
    cells[perf] = {};
    for (const pot of args.potential) cells[perf][pot] = 0;
  }
  let unplaced = 0;
  for (const placement of args.placements) {
    const row = cells[placement.performanceKey];
    if (!row || row[placement.potentialKey] === undefined) {
      unplaced += 1;
      continue;
    }
    row[placement.potentialKey] = (row[placement.potentialKey] ?? 0) + 1;
  }
  return { performance: args.performance, potential: args.potential, cells, unplaced };
}

export async function nineBoxForCycle(args: {
  orgId: string;
  actorId: string;
  cycleId: string;
}): Promise<NineBoxDTO> {
  const scales = await resolveTalentScales(args);
  const reviews = await listTalentReviews({ orgId: args.orgId, actorId: args.actorId, cycleId: args.cycleId });
  return buildNineBox({
    performance: scales.performance,
    potential: scales.potential,
    placements: reviews.map((review) => ({ performanceKey: review.performanceKey, potentialKey: review.potentialKey })),
  });
}

export interface SuccessionCandidateDTO {
  readonly id: string;
  readonly employmentId: string;
  readonly employeeName: string;
  readonly readiness: CandidateReadiness;
  readonly order: number;
  readonly notes: string | null;
}

export interface SuccessionPlanDTO {
  readonly id: string;
  readonly positionId: string;
  readonly positionCode: string;
  readonly positionTitle: string;
  readonly incumbentEmploymentId: string | null;
  readonly incumbentName: string | null;
  readonly status: SuccessionPlanStatus;
  readonly candidates: readonly SuccessionCandidateDTO[];
}

/**
 * A succession plan's position and status, with the plan's subsidiary fence
 * enforced: a scoped HR actor reaches only plans whose position sits in an
 * allowed subsidiary. Uniform NOT_FOUND — plan existence must not be
 * probeable across the fence.
 */
async function loadScopedPlan(
  exec: SqlExecutor,
  orgId: string,
  planId: string,
  allowed: Set<string> | null,
): Promise<{ id: string; positionId: string; status: SuccessionPlanStatus }> {
  const plan = (await exec.execute<{ id: string; positionId: string; status: SuccessionPlanStatus }>(sql`
    select id, position_id as "positionId", status
      from hrm_succession_plans where org_id = ${orgId} and id = ${planId}
  `)).rows[0];
  if (!plan) {
    throw new HrmPerformanceError("NOT_FOUND", "succession plan was not found — it may belong to another organization");
  }
  assertPositionInScope(await loadPositionSubsidiary(exec, orgId, plan.positionId), allowed);
  return plan;
}

/** Uniform NOT_FOUND for an out-of-scope employment. */
function assertEmploymentInScope(subsidiaryId: string, allowed: Set<string> | null, message: string): void {
  if (allowed !== null && !allowed.has(subsidiaryId)) {
    throw new HrmPerformanceError("NOT_FOUND", message);
  }
}

export async function createSuccessionPlan(args: {
  orgId: string;
  actorId: string;
  positionId: string;
  incumbentEmploymentId?: string | null;
}): Promise<SuccessionPlanDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const positionId = requireId("positionId", args.positionId);
  if (args.incumbentEmploymentId !== undefined && args.incumbentEmploymentId !== null) {
    requireId("incumbentEmploymentId", args.incumbentEmploymentId);
  }
  return withOrgTransaction(orgId, async () => {
    await assertTalentFeature(db, orgId);
    const allowed = await requireAggregatePerformanceManage(db, orgId, actorId);
    const position = (await db.execute<{ id: string }>(sql`
      select id from positions where org_id = ${orgId} and id = ${positionId}
    `)).rows[0];
    if (!position) {
      throw new HrmPerformanceError("NOT_FOUND", "position was not found — plan succession for a directory position");
    }
    assertPositionInScope(await loadPositionSubsidiary(db, orgId, positionId), allowed);
    if (args.incumbentEmploymentId !== undefined && args.incumbentEmploymentId !== null) {
      const incumbent = (await db.execute<{ employerSubsidiaryId: string }>(sql`
        select employer_subsidiary_id as "employerSubsidiaryId" from worker_employments
         where org_id = ${orgId} and id = ${args.incumbentEmploymentId}
      `)).rows[0];
      if (!incumbent) {
        throw new HrmPerformanceError("NOT_FOUND", "incumbent employment was not found — name a directory employment");
      }
      assertEmploymentInScope(
        incumbent.employerSubsidiaryId,
        allowed,
        "incumbent employment was not found — name a directory employment",
      );
    }
    try {
      const inserted = (await db.execute<{ id: string }>(sql`
        insert into hrm_succession_plans (org_id, position_id, incumbent_employment_id, status, created_by, updated_by)
        values (${orgId}, ${positionId}, ${args.incumbentEmploymentId ?? null}, 'draft', ${actorId}, ${actorId})
        returning id
      `)).rows[0];
      if (!inserted) throw new HrmPerformanceError("REFUSED", "the succession plan was not stored — no row was written; retry the action");
      const plan = await readSuccessionPlan(db, orgId, inserted.id);
      if (!plan) throw new HrmPerformanceError("REFUSED", "the succession plan was not stored — no row can be read back; retry the action");
      return plan;
    } catch (e) {
      if (isUniqueViolationOn(e, "hrm_succession_plans_unique")) {
        throw new HrmPerformanceError(
          "DUPLICATE",
          "this position already has a succession plan — add candidates to it instead of planning twice",
        );
      }
      throw e;
    }
  });
}

export async function setSuccessionPlanStatus(args: {
  orgId: string;
  actorId: string;
  id: string;
  status: SuccessionPlanStatus;
}): Promise<void> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const id = requireId("id", args.id);
  if (!["draft", "active", "archived"].includes(args.status)) {
    throw new HrmPerformanceError("INVALID_INPUT", "succession plan status must be draft, active, or archived");
  }
  await withOrgTransaction(orgId, async () => {
    await assertTalentFeature(db, orgId);
    const allowed = await requireAggregatePerformanceManage(db, orgId, actorId);
    // The fence first: a scoped actor never moves a plan they cannot see,
    // and the NOT_FOUND below stays uniform either way.
    await loadScopedPlan(db, orgId, id, allowed);
    const updated = (await db.execute<{ id: string }>(sql`
      update hrm_succession_plans set status = ${args.status}, updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${id}
      returning id
    `)).rows;
    if (updated.length !== 1) {
      throw new HrmPerformanceError("NOT_FOUND", "succession plan was not found — it may belong to another organization");
    }
  });
}

async function readSuccessionPlan(db: SqlExecutor, orgId: string, id: string): Promise<SuccessionPlanDTO | null> {
  const plans = (await db.execute<{
    id: string; position_id: string; incumbent_employment_id: string | null; status: SuccessionPlanStatus;
  }>(sql`
    select id, position_id, incumbent_employment_id::text as incumbent_employment_id, status
      from hrm_succession_plans where org_id = ${orgId} and id = ${id}
  `)).rows;
  const plan = plans[0];
  if (!plan) return null;
  const candidates = (await db.execute<{
    id: string; employment_id: string; employee_name: string; readiness: CandidateReadiness; candidate_order: number; notes: string | null;
  }>(sql`
    select c.id, c.employment_id, coalesce(p.display_name, '—') as employee_name,
           c.readiness, c.candidate_order, c.notes
      from hrm_succession_candidates c
      join worker_employments e on e.org_id = c.org_id and e.id = c.employment_id
      left join parties p on p.org_id = c.org_id and p.id = e.worker_party_id
     where c.org_id = ${orgId} and c.plan_id = ${id}
     order by c.candidate_order, c.created_at
  `)).rows;
  const position = (await db.execute<{ position_code: string; title: string | null }>(sql`
    select pos.position_code,
           (select v.title from position_versions v
             where v.org_id = pos.org_id and v.position_id = pos.id
             order by v.created_at desc limit 1) as title
      from positions pos where pos.org_id = ${orgId} and pos.id = ${plan.position_id}
  `)).rows[0];
  const incumbent = plan.incumbent_employment_id
    ? (await db.execute<{ name: string }>(sql`
        select coalesce(p.display_name, '—') as name
          from worker_employments e
          left join parties p on p.org_id = e.org_id and p.id = e.worker_party_id
         where e.org_id = ${orgId} and e.id = ${plan.incumbent_employment_id}
      `)).rows[0] ?? null
    : null;
  return {
    id: plan.id, positionId: plan.position_id,
    positionCode: position?.position_code ?? '—', positionTitle: position?.title ?? '—',
    incumbentEmploymentId: plan.incumbent_employment_id, incumbentName: incumbent?.name ?? null,
    status: plan.status,
    candidates: candidates.map((c) => ({ id: c.id, employmentId: c.employment_id, employeeName: c.employee_name, readiness: c.readiness, order: c.candidate_order, notes: c.notes })),
  };
}

export async function listSuccessionPlans(args: { orgId: string; actorId: string }): Promise<readonly SuccessionPlanDTO[]> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertTalentFeature(db, orgId);
    // HR-only: a candidate's own view never exists. Non-HR actors get
    // the uniform refusal, never a filtered list.
    let allowed: Set<string> | null;
    try {
      allowed = await requireAggregatePerformanceManage(db, orgId, actorId);
    } catch {
      throw new HrmPerformanceError(
        "FORBIDDEN",
        "succession plans are HR-only — ask an administrator to grant hrm.performance.manage in /admin/roles",
      );
    }
    const planScope = allowed === null
      ? sql``
      : sql`and exists (select 1 from position_versions v
                         where v.org_id = hrm_succession_plans.org_id
                           and v.position_id = hrm_succession_plans.position_id
                           and v.recorded_until is null
                           and v.employer_subsidiary_id in (${sql.join(
                             [...allowed].map((id) => sql`${id}::uuid`),
                             sql`, `,
                           )}))`;
    const rows = (await db.execute<{ id: string }>(sql`
      select id from hrm_succession_plans where org_id = ${orgId} ${planScope} order by created_at
    `)).rows;
    const out: SuccessionPlanDTO[] = [];
    for (const row of rows) {
      const plan = await readSuccessionPlan(db, orgId, row.id);
      if (plan) out.push(plan);
    }
    return out;
  });
}

export async function addSuccessionCandidate(args: {
  orgId: string;
  actorId: string;
  planId: string;
  employmentId: string;
  readiness: CandidateReadiness;
  notes?: string | null;
}): Promise<SuccessionCandidateDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const planId = requireId("planId", args.planId);
  const employmentId = requireId("employmentId", args.employmentId);
  if (!["ready_now", "one_to_two_years", "three_plus"].includes(args.readiness)) {
    throw new HrmPerformanceError("INVALID_INPUT", "candidate readiness must be ready_now, one_to_two_years, or three_plus");
  }
  return withOrgTransaction(orgId, async () => {
    await assertTalentFeature(db, orgId);
    const allowed = await requireAggregatePerformanceManage(db, orgId, actorId);
    try {
      await loadScopedPlan(db, orgId, planId, allowed);
    } catch (e) {
      if (e instanceof HrmPerformanceError && e.code === "NOT_FOUND") {
        throw new HrmPerformanceError("NOT_FOUND", "succession plan was not found — add the candidate to an existing plan");
      }
      throw e;
    }
    const employment = (await db.execute<{ id: string; employerSubsidiaryId: string }>(sql`
      select id, employer_subsidiary_id as "employerSubsidiaryId"
        from worker_employments where org_id = ${orgId} and id = ${employmentId}
    `)).rows[0];
    if (!employment) {
      throw new HrmPerformanceError("NOT_FOUND", "employment was not found — name a directory employment as the candidate");
    }
    assertEmploymentInScope(
      employment.employerSubsidiaryId,
      allowed,
      "employment was not found — name a directory employment as the candidate",
    );
    const maxOrder = (await db.execute<{ max: number }>(sql`
      select coalesce(max(candidate_order), -1) as max from hrm_succession_candidates where org_id = ${orgId} and plan_id = ${planId}
    `)).rows[0]?.max ?? -1;
    try {
      const inserted = (await db.execute<{ id: string }>(sql`
        insert into hrm_succession_candidates (org_id, plan_id, employment_id, readiness, candidate_order, notes, created_by, updated_by)
        values (${orgId}, ${planId}, ${employmentId}, ${args.readiness}, ${maxOrder + 1}, ${args.notes ?? null}, ${actorId}, ${actorId})
        returning id
      `)).rows[0];
      if (!inserted) throw new HrmPerformanceError("REFUSED", "the candidate was not stored — no row was written; retry the action");
      const named = (await db.execute<{ name: string }>(sql`
        select coalesce(p.display_name, '—') as name
          from worker_employments e
          left join parties p on p.org_id = e.org_id and p.id = e.worker_party_id
         where e.org_id = ${orgId} and e.id = ${employmentId}
      `)).rows[0];
      return {
        id: inserted.id, employmentId, employeeName: named?.name ?? '—',
        readiness: args.readiness, order: maxOrder + 1, notes: args.notes ?? null,
      };
    } catch (e) {
      if (isUniqueViolationOn(e, "hrm_succession_candidates_unique")) {
        throw new HrmPerformanceError(
          "DUPLICATE",
          "this employment is already a candidate on this plan — update their readiness instead of adding them twice",
        );
      }
      throw e;
    }
  });
}

export async function removeSuccessionCandidate(args: {
  orgId: string;
  actorId: string;
  planId: string;
  candidateId: string;
}): Promise<void> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const planId = requireId("planId", args.planId);
  const candidateId = requireId("candidateId", args.candidateId);
  await withOrgTransaction(orgId, async () => {
    await assertTalentFeature(db, orgId);
    const allowed = await requireAggregatePerformanceManage(db, orgId, actorId);
    // The fence first: a scoped actor never touches a plan they cannot see.
    await loadScopedPlan(db, orgId, planId, allowed);
    // Draft candidates may be removed; the plan itself is retained
    // history. A delete that matches zero rows is a failure.
    const deleted = (await db.execute<{ id: string }>(sql`
      delete from hrm_succession_candidates where org_id = ${orgId} and id = ${candidateId} and plan_id = ${planId}
      returning id
    `)).rows;
    if (deleted.length !== 1) {
      throw new HrmPerformanceError("NOT_FOUND", "succession candidate was not found on this plan — it may belong to another organization");
    }
  });
}
