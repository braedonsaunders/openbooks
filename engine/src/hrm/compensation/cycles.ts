import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../../platform/db.ts";
import { businessToday } from "../../platform/business-date.ts";
import { actorHasPermission } from "../../organization/actor-permissions.ts";
import { resolveWage, laborCostingSettings, laborFxQuote } from "../../projects/labor-costing.ts";
import { supersedeLaborCostRate } from "../../projects/labor-cost-rates.ts";
import { add, cmp, fromUnits, mul, mulDecimal, mulRate, normalizeDecimal, roundDiv, toUnits } from "../../money/money.ts";
import {
  HrmAuthorizationError,
  loadCompensationLens,
  loadOwnEmploymentIds,
  loadTeamEmploymentIdsForManager,
  requireAggregateCompensationRead,
  lockEmploymentsForScope,
  requireCompensationManageForEmployer,
  requireHrmCompensationApprove,
  requireHrmCompensationManage,
} from "../authorization.ts";
import { CompensationError } from "./errors.ts";
import {
  compaRatio,
  evaluateFormula,
  resolveMatrixGuideline,
  type MatrixGuideline,
} from "./compensation-math.ts";
import { resolveBandForScope, type BandBasis } from "./bands.ts";
import { requireActorId, requireId, requireOrgId, requireReason } from "../recruiting/input.ts";

/**
 * Merit cycles (HR-12, 0221): open → propose → approve (Flows) → push →
 * close.
 *
 * Open snapshots one line per in-service employment in scope: the
 * payroll-side wage read through the labor-costing wage rate service
 * (never typed), the band covering the position's level at the date, the
 * stored compa-ratio and the resolved guideline range — so a later band
 * or payroll change cannot reinterpret a decided line. Proposals come
 * from the employment's structural manager or hrm.compensation.manage;
 * outside-guideline proposals are allowed but flagged (reason required),
 * never silently accepted; over-budget pacing WARNS and requires a
 * reason, never blocks. The cycle's approval is a Flows run (submit →
 * release stamps the cycle); per-line approve/reject additionally needs
 * hrm.compensation.approve with the decider distinct from the proposer.
 * Push writes each approved line once through the canonical wage writer
 * (effective on the cycle's effective_on) with the line→rate link making
 * re-push a skip, never a double. A push whose effective_on falls in a
 * period payroll already ran surfaces as a retro candidate through the
 * existing retro-store detection (wage rows touched after the stub was
 * calculated) — the push response flags retroReviewDue so the operator
 * looks there instead of backdating silently.
 */

export type CycleKind = "merit" | "promotion" | "adjustment" | "cola";
export type CycleStatus = "draft" | "open" | "in_review" | "approved" | "pushed" | "closed" | "cancelled";
export type LineStatus = "pending" | "proposed" | "approved" | "rejected" | "pushed";

export interface CycleScope {
  readonly employerSubsidiaryId?: string | null;
  readonly departmentId?: string | null;
}

export interface CompCycleDTO {
  readonly id: string;
  readonly name: string;
  readonly kind: CycleKind;
  readonly status: CycleStatus;
  readonly effectiveOn: string;
  readonly budgetBasis: string;
  readonly budgetTotal: string | null;
  readonly currency: string;
  readonly guidelineKind: "matrix" | "formula";
  readonly guideline: Record<string, unknown>;
  readonly scope: CycleScope;
  readonly flowRunId: string | null;
  readonly revision: number;
}

export interface CompCycleLineDTO {
  readonly id: string;
  readonly cycleId: string;
  readonly employmentId: string;
  readonly workerPartyId: string;
  readonly currentRate: string;
  readonly currency: string;
  readonly basis: BandBasis;
  readonly bandId: string | null;
  readonly compaRatio: string | null;
  readonly ratingKey: string | null;
  readonly guidelineMinPct: string | null;
  readonly guidelineMaxPct: string | null;
  readonly proposedPct: string | null;
  readonly proposedRate: string | null;
  readonly status: LineStatus;
  readonly reason: string | null;
  readonly revision: number;
}

type CycleRow = {
  id: string;
  name: string;
  kind: string;
  status: string;
  effective_on: string;
  budget_basis: string;
  budget_total: string | null;
  currency: string;
  guideline_kind: string;
  guideline: Record<string, unknown>;
  scope: CycleScope;
  flow_run_id: string | null;
  revision: number;
};

const CYCLE_COLUMNS = sql`id, name, kind, status, effective_on::text as effective_on,
  budget_basis, budget_total::text as budget_total, currency, guideline_kind, guideline,
  scope, flow_run_id, revision`;

function toCycleDTO(row: CycleRow): CompCycleDTO {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as CycleKind,
    status: row.status as CycleStatus,
    effectiveOn: String(row.effective_on).slice(0, 10),
    budgetBasis: row.budget_basis,
    budgetTotal: row.budget_total === null ? null : String(row.budget_total),
    currency: row.currency,
    guidelineKind: row.guideline_kind as "matrix" | "formula",
    guideline: row.guideline,
    scope: {
      employerSubsidiaryId: (row.scope as Record<string, string | null>)?.employer_subsidiary_id ?? null,
      departmentId: (row.scope as Record<string, string | null>)?.department_id ?? null,
    },
    flowRunId: row.flow_run_id,
    revision: row.revision,
  };
}

type LineRow = {
  id: string;
  cycle_id: string;
  employment_id: string;
  current_rate: string;
  currency: string;
  basis: string;
  band_id: string | null;
  compa_ratio: string | null;
  rating_key: string | null;
  guideline_min_pct: string | null;
  guideline_max_pct: string | null;
  proposed_pct: string | null;
  proposed_rate: string | null;
  proposed_by: string | null;
  status: string;
  reason: string | null;
  revision: number;
  pushed_rate_id: string | null;
};

const LINE_COLUMNS = sql`l.id, l.cycle_id, l.employment_id, l.current_rate::text as current_rate,
  l.currency, l.basis, l.band_id, l.compa_ratio::text as compa_ratio, l.rating_key,
  l.guideline_min_pct::text as guideline_min_pct, l.guideline_max_pct::text as guideline_max_pct,
  l.proposed_pct::text as proposed_pct, l.proposed_rate::text as proposed_rate,
  l.proposed_by,
  l.status, l.reason, l.revision, l.pushed_rate_id`;

function toLineDTO(row: LineRow, workerPartyId: string): CompCycleLineDTO {
  return {
    id: row.id,
    cycleId: row.cycle_id,
    employmentId: row.employment_id,
    workerPartyId,
    currentRate: String(row.current_rate),
    currency: row.currency,
    basis: (row.basis === "hourly" ? "hourly" : "annual") as BandBasis,
    bandId: row.band_id,
    compaRatio: row.compa_ratio === null ? null : String(row.compa_ratio),
    ratingKey: row.rating_key,
    guidelineMinPct: row.guideline_min_pct === null ? null : String(row.guideline_min_pct),
    guidelineMaxPct: row.guideline_max_pct === null ? null : String(row.guideline_max_pct),
    proposedPct: row.proposed_pct === null ? null : String(row.proposed_pct),
    proposedRate: row.proposed_rate === null ? null : String(row.proposed_rate),
    status: row.status as LineStatus,
    reason: row.reason,
    revision: row.revision,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function requireCycleKind(kind: unknown): CycleKind {
  if (kind !== "merit" && kind !== "promotion" && kind !== "adjustment" && kind !== "cola") {
    throw new CompensationError("INVALID_INPUT", "cycle kind is merit, promotion, adjustment or cola");
  }
  return kind;
}

export interface CreateCycleQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly name: string;
  readonly kind: CycleKind;
  readonly effectiveOn: string;
  readonly budgetBasis?: string;
  readonly budgetTotal?: string | null;
  readonly currency: string;
  readonly guidelineKind: "matrix" | "formula";
  readonly guideline: Record<string, unknown>;
  readonly scope?: CycleScope;
}

export async function createCycle(query: CreateCycleQuery): Promise<CompCycleDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const kind = requireCycleKind(query.kind);
  if (typeof query.name !== "string" || query.name.trim().length === 0) {
    throw new CompensationError("INVALID_INPUT", "a cycle name is required");
  }
  if (!DATE_RE.test(query.effectiveOn)) {
    throw new CompensationError("INVALID_INPUT", "effectiveOn (YYYY-MM-DD) required — the date the new rates take effect");
  }
  if (typeof query.currency !== "string" || !/^[A-Z]{3}$/.test(query.currency)) {
    throw new CompensationError("INVALID_INPUT", "cycle currency must be an ISO 4217 code (e.g. USD)");
  }
  if (query.guidelineKind !== "matrix" && query.guidelineKind !== "formula") {
    throw new CompensationError("INVALID_INPUT", "guidelineKind is matrix or formula");
  }
  if (!query.guideline || typeof query.guideline !== "object" || Array.isArray(query.guideline)) {
    throw new CompensationError("INVALID_INPUT", "a guideline document is required — the matrix or formula the lines are priced against");
  }
  const budgetBasis = query.budgetBasis ?? "combined";
  if (budgetBasis !== "top_down" && budgetBasis !== "bottom_up" && budgetBasis !== "combined") {
    throw new CompensationError("INVALID_INPUT", "budgetBasis is top_down, bottom_up or combined");
  }
  return withOrgTransaction(orgId, async () => {
    // The declared employer anchor is the creation's legal-entity claim:
    // a B-anchored round by an A-scoped actor refuses uniformly
    // not-visible, and an org-wide (null) round needs unrestricted scope.
    await requireCompensationManageForEmployer(
      db,
      orgId,
      actorId,
      query.scope?.employerSubsidiaryId ?? null,
      "Compensation cycle",
    );
    const row = (await db.execute<CycleRow>(sql`
      insert into hrm_comp_cycles
        (org_id, name, kind, effective_on, budget_basis, budget_total, currency,
         guideline_kind, guideline, scope, created_by, updated_by)
      values (${orgId}, ${query.name.trim().slice(0, 160)}, ${kind}, ${query.effectiveOn}, ${budgetBasis},
              ${query.budgetTotal ?? null}, ${query.currency}, ${query.guidelineKind},
              ${JSON.stringify(query.guideline)}::jsonb,
              ${JSON.stringify({
                employer_subsidiary_id: query.scope?.employerSubsidiaryId ?? null,
                department_id: query.scope?.departmentId ?? null,
              })}::jsonb, ${actorId}, ${actorId})
      returning ${CYCLE_COLUMNS}`)).rows[0];
    if (!row) throw new CompensationError("REFUSED", "the cycle insert matched no row — the save is refused, never a silent success");
    await recordEvent(db, orgId, row.id, null, "opened", actorId, "cycle created");
    return toCycleDTO(row);
  });
}

async function recordEvent(
  exec: typeof db,
  orgId: string,
  cycleId: string,
  lineId: string | null,
  kind: string,
  actor: string | null,
  reason: string | null,
): Promise<void> {
  await exec.execute(sql`
    insert into hrm_comp_events (org_id, cycle_id, line_id, kind, actor, reason)
    values (${orgId}, ${cycleId}, ${lineId}, ${kind}, ${actor}, ${reason})`);
}

async function loadCycleForUpdate(orgId: string, cycleId: string): Promise<CycleRow> {
  const row = (await db.execute<CycleRow>(sql`
    select ${CYCLE_COLUMNS} from hrm_comp_cycles
     where org_id = ${orgId} and id = ${cycleId} for update`)).rows[0];
  if (!row) throw new CompensationError("NOT_FOUND", "compensation cycle is not visible in this organization");
  return row;
}

/**
 * Subsidiary lens for cycle reads: the actor's allowed employer set,
 * resolved inside the domain boundary through requireAggregateCompensationRead
 * (null = unrestricted) — never a caller-forged set. Cycle headers carry no
 * pay, so discovery stays useful on mixed-subsidiary rounds: a round scoped
 * to a subsidiary the actor cannot see is NOT_FOUND (the same message as a
 * missing round, never an existence oracle), while an unscoped round stays
 * readable and its salaries are fenced per line. An empty allowed set sees
 * headers only — every line and every paced amount filters to nothing.
 */
function cycleScopeSubsidiary(row: CycleRow): string | null {
  const scope = row.scope as Record<string, string | null> | null;
  return scope?.employer_subsidiary_id ?? null;
}

function assertCycleVisible(row: CycleRow, allowed: Set<string> | null): void {
  if (allowed === null) return;
  const subsidiary = cycleScopeSubsidiary(row);
  if (subsidiary !== null && !allowed.has(subsidiary)) {
    throw new CompensationError("NOT_FOUND", "compensation cycle is not visible in this organization");
  }
}

function cycleNotVisible(): CompensationError {
  return new CompensationError("NOT_FOUND", "compensation cycle is not visible in this organization");
}

/**
 * Write scope rechecked under the cycle's row lock: the cycle's employer
 * subsidiary and every line's employer must sit inside the lens. An
 * unscoped (null) round constrains nothing by header — its lines govern
 * instead — so a restricted actor moves only rounds with no out-of-scope
 * line. Refuses uniformly not-visible, exactly like the read gate. Cycle
 * actions lock cycle → lines in id order → employments in id order before
 * checking the employers, matching the per-line action lock order.
 */
async function assertCycleWriteScope(
  orgId: string,
  actorId: string,
  cycle: CycleRow,
  employmentIds: readonly string[],
): Promise<void> {
  const allowed = await loadCompensationLens(db, orgId, actorId);
  const subsidiary = cycleScopeSubsidiary(cycle);
  if (allowed !== null && subsidiary !== null && !allowed.has(subsidiary)) throw cycleNotVisible();
  if (allowed === null) {
    if (employmentIds.length > 0) {
      const rows = (await db.execute<{ id: string }>(sql`
        select id from worker_employments
         where org_id = ${orgId}::uuid
           and id in (select jsonb_array_elements_text(${JSON.stringify([...new Set(employmentIds)].sort())}::jsonb)::uuid)
         order by id
         for update`)).rows;
      if (rows.length !== new Set(employmentIds).size) throw cycleNotVisible();
    }
    return;
  }
  let subjects: Awaited<ReturnType<typeof lockEmploymentsForScope>>;
  try {
    subjects = await lockEmploymentsForScope(db, employmentIds, { orgId, actorId });
  } catch (error) {
    if (error instanceof HrmAuthorizationError) throw cycleNotVisible();
    throw error;
  }
  if (subjects.some((subject) => !allowed.has(subject.employerSubsidiaryId))) {
    throw cycleNotVisible();
  }
}

/** Lines are locked before their employment rows to keep one cycle-wide order. */
async function lineEmploymentIds(orgId: string, cycleId: string): Promise<string[]> {
  const rows = (await db.execute<{ employment_id: string }>(sql`
    select employment_id
      from hrm_comp_cycle_lines
     where org_id = ${orgId} and cycle_id = ${cycleId}
     order by id
     for update`)).rows;
  return rows.map((row) => row.employment_id);
}

/**
 * Single-line employment scope for propose/reopen/decide: the line's
 * employment must sit inside the lens even when the grant path is
 * structural (a manager's team) rather than hrm.compensation.* — team
 * membership never substitutes for entity scope. Refuses uniformly
 * not-visible, like a missing line.
 */
async function assertLineEmploymentScope(orgId: string, actorId: string, employmentId: string): Promise<void> {
  const allowed = await loadCompensationLens(db, orgId, actorId);
  if (allowed === null) {
    const rows = (await db.execute<{ id: string }>(sql`
      select id from worker_employments
       where org_id = ${orgId}::uuid and id = ${employmentId}::uuid
       for update`)).rows;
    if (!rows[0]) throw new CompensationError("NOT_FOUND", "cycle line is not visible in this organization");
    return;
  }
  let subjects: Awaited<ReturnType<typeof lockEmploymentsForScope>>;
  try {
    subjects = await lockEmploymentsForScope(db, [employmentId], { orgId, actorId });
  } catch (error) {
    if (error instanceof HrmAuthorizationError) {
      throw new CompensationError("NOT_FOUND", "cycle line is not visible in this organization");
    }
    throw error;
  }
  if (!subjects[0] || !allowed.has(subjects[0].employerSubsidiaryId)) {
    throw new CompensationError("NOT_FOUND", "cycle line is not visible in this organization");
  }
}

export async function getCycle(query: { orgId: string; actorId: string; cycleId: string }): Promise<CompCycleDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const cycleId = requireId(query.cycleId, "cycleId");
  const allowed = await requireAggregateCompensationRead(db, orgId, actorId);
  const row = (await db.execute<CycleRow>(sql`
    select ${CYCLE_COLUMNS} from hrm_comp_cycles where org_id = ${orgId} and id = ${cycleId}`)).rows[0];
  if (!row) throw new CompensationError("NOT_FOUND", "compensation cycle is not visible in this organization");
  assertCycleVisible(row, allowed);
  return toCycleDTO(row);
}

export async function listCycles(query: { orgId: string; actorId: string }): Promise<readonly CompCycleDTO[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const allowed = await requireAggregateCompensationRead(db, orgId, actorId);
  const rows = (await db.execute<CycleRow>(sql`
    select ${CYCLE_COLUMNS} from hrm_comp_cycles where org_id = ${orgId} order by effective_on desc`)).rows;
  return rows
    .filter((row) => {
      if (allowed === null) return true;
      const subsidiary = cycleScopeSubsidiary(row);
      return subsidiary === null || allowed.has(subsidiary);
    })
    .map(toCycleDTO);
}

export async function listCycleLines(query: {
  orgId: string;
  actorId: string;
  cycleId: string;
}): Promise<readonly CompCycleLineDTO[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const cycleId = requireId(query.cycleId, "cycleId");
  const allowed = await requireAggregateCompensationRead(db, orgId, actorId);
  // An empty line list must mean "no lines", never "no such round": verify
  // the round is visible first, with the same message as a missing round
  // (never an existence oracle), mirroring getCycle.
  const cycle = (await db.execute<CycleRow>(sql`
    select ${CYCLE_COLUMNS} from hrm_comp_cycles where org_id = ${orgId} and id = ${cycleId}`)).rows[0];
  if (!cycle) throw new CompensationError("NOT_FOUND", "compensation cycle is not visible in this organization");
  assertCycleVisible(cycle, allowed);
  // The line predicate joins the trusted employment row on this runner, so
  // the employer subsidiary is loaded from storage, never caller input. The
  // allowlist crosses as JSON (bare JS arrays interpolate as row
  // constructors, never PostgreSQL arrays); an empty set matches nothing.
  const rows = (await db.execute<LineRow & { worker_party_id: string }>(sql`
    select ${LINE_COLUMNS}, e.worker_party_id
      from hrm_comp_cycle_lines l
      join worker_employments e on e.org_id = l.org_id and e.id = l.employment_id
     where l.org_id = ${orgId} and l.cycle_id = ${cycleId}
       and (${allowed === null}::boolean
            or e.employer_subsidiary_id in (
              select jsonb_array_elements_text(${JSON.stringify([...(allowed ?? [])])}::jsonb)::uuid
            ))
     order by e.worker_party_id`)).rows;
  return rows.map((row) => toLineDTO(row, String((row as { worker_party_id: string }).worker_party_id)));
}

// ---------------------------------------------------------------------------
// Open: snapshot one line per in-service employment in scope.
// ---------------------------------------------------------------------------

interface ScopeEmployment {
  employmentId: string;
  workerPartyId: string;
  employerSubsidiaryId: string;
  departmentId: string | null;
  locationId: string | null;
  positionId: string | null;
  tenureYears: number;
}

async function inServiceEmployments(orgId: string, scope: CycleScope, asOf: string): Promise<ScopeEmployment[]> {
  const rows = (await db.execute<{
    employment_id: string;
    worker_party_id: string;
    employer_subsidiary_id: string;
    department_id: string | null;
    location_id: string | null;
    position_id: string | null;
    started_on: string | null;
  }>(sql`
    select e.id as employment_id, e.worker_party_id, e.employer_subsidiary_id,
           aav.department_id, aav.location_id, aav.position_id,
           (select min(effective_from)::text from worker_employment_versions
             where org_id = e.org_id and employment_id = e.id) as started_on
      from worker_employments e
      join worker_employment_versions ev
        on ev.org_id = e.org_id and ev.employment_id = e.id
       and ev.effective_from <= ${asOf}::date
       and (ev.effective_to is null or ev.effective_to >= ${asOf}::date)
       and ev.recorded_until is null
      left join employment_assignment_versions aav
        on aav.org_id = e.org_id and aav.employment_id = e.id
       and aav.is_primary
       and aav.effective_from <= ${asOf}::date
       and (aav.effective_to is null or aav.effective_to >= ${asOf}::date)
       and aav.recorded_until is null
     where e.org_id = ${orgId}
       and ev.status in ('active', 'on_leave')
       and (${scope.employerSubsidiaryId ?? null}::uuid is null
            or e.employer_subsidiary_id is not distinct from ${scope.employerSubsidiaryId ?? null}::uuid)
       and (${scope.departmentId ?? null}::uuid is null
            or aav.department_id is not distinct from ${scope.departmentId ?? null}::uuid)`)).rows;
  return rows.map((row) => {
    const started = row.started_on === null ? asOf : String(row.started_on).slice(0, 10);
    const tenureYears =
      Math.max(0, (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${started}T00:00:00Z`)) / 365.25 / 86400000);
    return {
      employmentId: row.employment_id,
      workerPartyId: row.worker_party_id,
      employerSubsidiaryId: row.employer_subsidiary_id,
      departmentId: row.department_id,
      locationId: row.location_id,
      positionId: row.position_id,
      tenureYears,
    };
  });
}

interface ReviewRating {
  rating: number;
  bucket: string | null;
}

/** Latest shared/acknowledged review before the date, bucketed on its own template's scale. Null = no shared review. */
async function latestSharedRating(orgId: string, employmentId: string, before: string): Promise<ReviewRating | null> {
  const row = (await db.execute<{
    overall_rating: string | null;
    calibrated_rating: string | null;
    rating_scale: { min: number; max: number; labels: string[] } | null;
  }>(sql`
    select r.overall_rating::text as overall_rating, r.calibrated_rating::text as calibrated_rating,
           t.rating_scale as rating_scale
      from hrm_reviews r
      join hrm_review_cycles c on c.org_id = r.org_id and c.id = r.cycle_id
      join hrm_review_templates t on t.org_id = r.org_id and t.id = c.template_id
     where r.org_id = ${orgId} and r.employment_id = ${employmentId}
       and r.status in ('shared', 'acknowledged')
       and (r.shared_at is null or r.shared_at::date <= ${before}::date)
     order by r.shared_at desc nulls last
     limit 1`)).rows[0];
  if (!row) return null;
  const raw = row.calibrated_rating ?? row.overall_rating;
  if (raw === null) return { rating: 0, bucket: null };
  const rating = Number(raw);
  if (!Number.isFinite(rating)) return { rating: 0, bucket: null };
  const scale = row.rating_scale;
  const labels = Array.isArray(scale?.labels) ? scale.labels.filter((l) => typeof l === "string") : [];
  if (labels.length === 0 || typeof scale?.min !== "number" || typeof scale?.max !== "number" || !(scale.max > scale.min)) {
    return { rating, bucket: String(raw) };
  }
  const width = (scale.max - scale.min) / labels.length;
  const idx = Math.min(labels.length - 1, Math.max(0, Math.floor((rating - scale.min) / width)));
  return { rating, bucket: labels[idx] ?? null };
}

interface ResolvedLineGuideline {
  bandId: string | null;
  compaRatio: string | null;
  guidelineMinPct: number | null;
  guidelineMaxPct: number | null;
}

async function resolveLineGuideline(
  orgId: string,
  cycle: CycleRow,
  employment: ScopeEmployment,
  asOf: string,
  review: ReviewRating | null,
): Promise<ResolvedLineGuideline & { currentRate: string; currency: string; basis: BandBasis; annualHours: string | null }> {
  // The payroll-side effective wage, through the wage rate service.
  const wage = await resolveWage(orgId, employment.workerPartyId, asOf, {
    departmentId: employment.departmentId,
    subsidiaryId: employment.employerSubsidiaryId,
  });
  if (!wage) {
    throw new CompensationError(
      "REFUSED",
      "a line has no current rate — every in-service employment in scope needs a payroll-side wage before the cycle can open; set the missing wages in Labor Costing first",
    );
  }
  const settings = await laborCostingSettings(orgId);
  // Native basis when the employee-scope row carries it, otherwise
  // annualised (resolveWage always returns hourly).
  const native = (await db.execute<{ rate: string; basis: string; currency: string; annual_hours: string }>(sql`
    select rate::text as rate, basis, currency, annual_hours::text as annual_hours
      from labor_cost_rates
     where org_id = ${orgId} and employee_party_id = ${employment.workerPartyId} and is_active
       and effective_from <= ${asOf}::date
       and (effective_to is null or effective_to >= ${asOf}::date)
     order by effective_from desc
     limit 1`)).rows[0];
  const basis: BandBasis = native ? (native.basis === "hour" ? "hourly" : "annual") : "annual";
  const currentRate = native ? String(native.rate) : mul(wage.wage, String(settings.annualHours));
  const currency = native?.currency ?? wage.currency;
  // The annual-hours of the same wage row that priced the line — the
  // frozen annualization input for hourly lines (null when no native
  // row priced them, which only happens for annual lines).
  const annualHours = native ? String(native.annual_hours) : null;
  // The band through the position's level at the date (null = no band;
  // the line opens anyway — the UI shows "no band", never zero).
  let bandId: string | null = null;
  let ratio: string | null = null;
  if (employment.positionId !== null) {
    const position = (await db.execute<{
      level_id: string | null;
      location_id: string | null;
    }>(sql`
      select job_level_id as level_id, location_id
        from position_versions
       where org_id = ${orgId} and position_id = ${employment.positionId}
         and effective_from <= ${asOf}::date
         and (effective_to is null or effective_to >= ${asOf}::date)
         and recorded_until is null
       order by effective_from desc
       limit 1`)).rows[0];
    if (position?.level_id) {
      const level = (await db.execute<{ family_id: string | null }>(sql`
        select family_id from hrm_job_levels where org_id = ${orgId} and id = ${position.level_id}`)).rows[0];
      const band = await resolveBandForScope(
        orgId,
        {
          familyId: level?.family_id ?? null,
          levelId: position.level_id,
          employerSubsidiaryId: employment.employerSubsidiaryId,
          locationId: position.location_id ?? employment.locationId,
          currency,
          basis,
        },
        asOf,
      );
      if (band) {
        bandId = band.id;
        ratio = compaRatio(currentRate, band.target);
      }
    }
  }
  // The guideline range at open. A line with no band has no guideline:
  // the UI shows "no band", and proposals on it always carry a reason.
  let guidelineMinPct: number | null = null;
  let guidelineMaxPct: number | null = null;
  const guideline = cycle.guideline as Record<string, unknown>;
  if (ratio !== null && cycle.guideline_kind === "matrix") {
    const matrix = guideline as unknown as MatrixGuideline;
    const cell = resolveMatrixGuideline(matrix, review?.bucket ?? null, ratio);
    guidelineMinPct = cell.min;
    guidelineMaxPct = cell.max;
  } else if (ratio !== null) {
    const expr = (guideline as { expr?: unknown }).expr;
    if (typeof expr !== "string") {
      throw new CompensationError(
        "REFUSED",
        "a formula cycle needs guideline.expr — declare the expression before opening the cycle",
      );
    }
    const pct = evaluateFormula(expr, {
      rating: review?.rating ?? null,
      compaRatio: Number(ratio),
      tenureYears: employment.tenureYears,
    });
    guidelineMinPct = pct;
    guidelineMaxPct = pct;
  }
  return { bandId, compaRatio: ratio, guidelineMinPct, guidelineMaxPct, currentRate, currency, basis, annualHours };
}

/** Open a draft cycle: snapshot one line per in-service employment in scope, in one transaction. */
export async function openCycle(query: {
  orgId: string;
  actorId: string;
  cycleId: string;
}): Promise<{ cycle: CompCycleDTO; lines: number }> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const cycleId = requireId(query.cycleId, "cycleId");
  return withOrgTransaction(orgId, async () => {
    await requireHrmCompensationManage(db, orgId, actorId);
    const cycle = await loadCycleForUpdate(orgId, cycleId);
    if (cycle.status !== "draft") {
      throw new CompensationError(
        "BAD_STATE",
        `a ${cycle.status} cycle cannot open — only drafts open; the snapshot is taken once, at open`,
      );
    }
    const today = await businessToday(orgId);
    const employments = await inServiceEmployments(orgId, toCycleDTO(cycle).scope, String(cycle.effective_on).slice(0, 10));
    // Opening snapshots a wage line per employment: the cycle's anchor
    // and every employment about to be snapshotted must sit inside the
    // lens, or an A-scoped actor opens B's wages into the round.
    await assertCycleWriteScope(
      orgId,
      actorId,
      cycle,
      employments.map((e) => e.employmentId),
    );
    if (employments.length === 0) {
      throw new CompensationError(
        "REFUSED",
        "no in-service employment falls in this cycle's scope — widen the scope before opening an empty round",
      );
    }
    // Frozen budget evidence (0243) is written once, here, beside the
    // rate snapshot: the pricing-date/envelope/currency copies plus, for
    // enveloped cycles, the hourly annual-hours and the oriented
    // laborFxQuote factor. A missing required input fails the whole
    // open atomically — the draft survives for retry once configured —
    // so a new cycle never opens knowingly unpriceable. Null-envelope
    // cycles acquire no unused inputs. Once open, nothing refills or
    // reprices these copies on any path.
    const cycleCurrency = String(cycle.currency);
    const pricingDate = String(cycle.effective_on).slice(0, 10);
    const enveloped = cycle.budget_total !== null;
    for (const employment of employments) {
      const review = await latestSharedRating(orgId, employment.employmentId, String(cycle.effective_on).slice(0, 10));
      const resolved = await resolveLineGuideline(orgId, cycle, employment, today, review);
      const frozen: FrozenBudget = {
        annualHours: null,
        fxRate: null,
        fxAsof: null,
        fxSource: null,
        fxInverse: null,
      };
      if (enveloped) {
        if (resolved.basis === "hourly") {
          if (resolved.annualHours === null) {
            throw new CompensationError(
              "REFUSED",
              `cannot open: the hourly line for employment ${employment.employmentId} has no wage annual-hours to annualise with — set the employee wage annual-hours in Labor Costing, then open the same draft again; the cycle stays a draft`,
            );
          }
          frozen.annualHours = resolved.annualHours;
        }
        if (resolved.currency !== cycleCurrency) {
          const quote = await laborFxQuote(orgId, resolved.currency, cycleCurrency, pricingDate);
          if (!quote) {
            throw new CompensationError(
              "REFUSED",
              `cannot open: no spot rate for ${resolved.currency}→${cycleCurrency} on or before ${pricingDate} — add an FX spot rate covering the cycle's effective date, then open the same draft again; unconfigured currencies never convert at 1:1`,
            );
          }
          frozen.fxRate = quote.rate;
          frozen.fxAsof = quote.asOf;
          frozen.fxSource = quote.source;
          frozen.fxInverse = quote.inverse;
        }
      }
      await db.execute(sql`
        insert into hrm_comp_cycle_lines
          (org_id, cycle_id, employment_id, current_rate, currency, basis, band_id, compa_ratio,
           rating_key, guideline_min_pct, guideline_max_pct,
           budget_pricing_date, budget_cycle_currency, budget_envelope,
           budget_annual_hours, budget_fx_rate, budget_fx_asof, budget_fx_source, budget_fx_inverse,
           created_by, updated_by)
        values (${orgId}, ${cycleId}, ${employment.employmentId}, ${resolved.currentRate},
                ${resolved.currency}, ${resolved.basis}, ${resolved.bandId}, ${resolved.compaRatio},
                ${review?.bucket ?? null}, ${resolved.guidelineMinPct}, ${resolved.guidelineMaxPct},
                ${pricingDate}, ${cycleCurrency}, ${cycle.budget_total},
                ${frozen.annualHours}, ${frozen.fxRate}, ${frozen.fxAsof}, ${frozen.fxSource}, ${frozen.fxInverse},
                ${actorId}, ${actorId})`);
    }
    const updated = (await db.execute<CycleRow>(sql`
      update hrm_comp_cycles
         set status = 'open', opened_at = now(), revision = revision + 1,
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${cycleId} and status = 'draft' and revision = ${cycle.revision}
       returning ${CYCLE_COLUMNS}`)).rows[0];
    if (!updated) {
      throw new CompensationError("STALE_REVISION", "the cycle moved while it was opening — reload it and open again");
    }
    await recordEvent(db, orgId, cycleId, null, "opened", actorId, `${employments.length} lines snapshotted`);
    return { cycle: toCycleDTO(updated), lines: employments.length };
  });
}

// ---------------------------------------------------------------------------
// Propose / reopen (structural manager scope or manage grant).
// ---------------------------------------------------------------------------

async function canProposeForEmployment(
  orgId: string,
  actorId: string,
  employmentId: string,
  today: string,
): Promise<boolean> {
  if (await actorHasPermission(db, orgId, actorId, "hrm.compensation.manage")) return true;
  if (!(await actorHasPermission(db, orgId, actorId, "hrm.self.read"))) return false;
  const own = await loadOwnEmploymentIds(db, orgId, actorId);
  if (own.length === 0) return false;
  const team = await loadTeamEmploymentIdsForManager(db, orgId, own, today);
  return team.includes(employmentId);
}

async function loadLineForUpdate(orgId: string, lineId: string): Promise<LineRow> {
  const row = (await db.execute<LineRow>(sql`
    select ${LINE_COLUMNS} from hrm_comp_cycle_lines l
     where l.org_id = ${orgId} and l.id = ${lineId} for update`)).rows[0];
  if (!row) throw new CompensationError("NOT_FOUND", "cycle line is not visible in this organization");
  return row;
}

/**
 * Every operation that locks both records takes the cycle before its line.
 * Resolve the immutable parent without a lock, then lock and re-read both
 * records in that order so a stale parent cannot authorize a line action.
 */
async function loadCycleAndLineForUpdate(
  orgId: string,
  lineId: string,
): Promise<{ cycle: CycleRow; line: LineRow }> {
  const parent = (await db.execute<{ cycle_id: string }>(sql`
    select cycle_id from hrm_comp_cycle_lines where org_id = ${orgId} and id = ${lineId}`)).rows[0];
  if (!parent) throw new CompensationError("NOT_FOUND", "cycle line is not visible in this organization");
  const cycle = await loadCycleForUpdate(orgId, parent.cycle_id);
  const line = await loadLineForUpdate(orgId, lineId);
  if (line.cycle_id !== cycle.id) {
    throw new CompensationError("STALE_REVISION", "the line moved to another cycle while it was loaded — reload it and retry");
  }
  return { cycle, line };
}

export interface PacingRead {
  /**
   * Proposed + approved increase vs the cycle envelope, percent.
   * Null = no envelope (budget_total is null), or a zero envelope whose
   * ratio is undefined. Zero is a real envelope, not absence: a zero
   * increase against it is not over, any positive increase is over even
   * though no percentage can name it.
   */
  readonly totalPct: number | null;
  readonly overBudget: boolean;
}

/** Final display ratio only: the exact comparison in computePacing decides over-budget. */
function displayPct(increase: string, envelope: string): number | null {
  const pct = (Number(increase) / Number(envelope)) * 100;
  return Number.isFinite(pct) ? pct : null;
}

/**
 * Frozen budget evidence written once at open (0243). Annual
 * same-currency lines carry NULL inputs — the identity factor is
 * complete evidence, not a gap. Hourly lines carry the wage row's own
 * annual-hours; cross-currency lines carry the oriented laborFxQuote
 * factor with its as-of/source provenance. Pacing reads these copies
 * only: later FX re-imports, late-arriving rows, wage supersessions and
 * settings edits cannot reprice a decided line, and a reopen carries
 * them forward untouched.
 */
interface FrozenBudget {
  annualHours: string | null;
  fxRate: string | null;
  fxAsof: string | null;
  fxSource: string | null;
  fxInverse: boolean | null;
}

/**
 * Refusal for a decided legacy line without trustworthy frozen
 * evidence. It names the gap as missing historical budget evidence and
 * directs future adjustments through a new cycle: restoring a current
 * wage row or rate cannot recreate the old evidence, and history is
 * preserved, never deleted or rewritten.
 */
function missingFrozen(lineId: string, basis: string, currency: string): never {
  throw legacyEvidenceRefusal(lineId, basis, currency);
}

function legacyEvidenceRefusal(lineId: string, basis: string, currency: string): CompensationError {
  return new CompensationError(
    "REFUSED",
    `cycle line ${lineId} (${basis} ${currency}) has no frozen budget evidence — it was decided before evidence freeze, so its historical annual-hours/FX inputs cannot be reconstructed from current wages or rates; pacing refuses rather than repricing it. Carry future adjustments into a new cycle instead of rewriting this history`,
  );
}

/**
 * Budget pacing is computed, never stored: the decided increase against the
 * envelope. The public read carries the actor's subsidiary lens, so
 * aggregate amounts from hidden subsidiaries cannot leak through the
 * percentage; the monetary math is unchanged, only the input rows fence
 * (unrestricted readers resolve the identical row set as before). The
 * propose path runs the same math whole-cycle through computePacing
 * directly — structural managers propose without hrm.compensation.read,
 * so the write control demands no read grant.
 */
export async function cyclePacing(orgId: string, actorId: string, cycleId: string): Promise<PacingRead> {
  const allowed = await requireAggregateCompensationRead(db, orgId, actorId);
  return computePacing(orgId, cycleId, allowed);
}

/**
 * Pacing math over decided lines with no permission gate: the private
 * control behind proposeLine's over-budget refusal (whole cycle, never
 * lens-scoped, so a restricted proposer cannot shrink the envelope by
 * hiding subsidiaries) and behind the public cyclePacing read above.
 */
async function computePacing(orgId: string, cycleId: string, allowed: Set<string> | null): Promise<PacingRead> {
  const cycle = (await db.execute<CycleRow>(sql`
    select ${CYCLE_COLUMNS} from hrm_comp_cycles where org_id = ${orgId} and id = ${cycleId}`)).rows[0];
  // A deleted or other-org cycle is not an empty envelope: without this,
  // pacing a missing round returned the exact shape of a real round with
  // no envelope. Refuse by name (404 at the route) like every other read.
  if (!cycle) throw new CompensationError("NOT_FOUND", "compensation cycle is not visible in this organization");
  // budget_total null is absence (no envelope, never over). Zero is a
  // real envelope and stays in the comparison below. The cycle header
  // is read only to discriminate legacy rows (which predate frozen
  // evidence) and legacy identity cases — every new row's pacing math
  // runs exclusively off its own frozen copies, so a later header,
  // wage, FX or settings change cannot reinterpret a decided line.
  // The lens predicate below is unchanged — only the input rows fence,
  // never the math.
  if (cycle.budget_total === null) return { totalPct: null, overBudget: false };
  const cycleCurrency = String(cycle.currency);
  const rows = (await db.execute<{
    line_id: string;
    current_rate: string;
    proposed_rate: string | null;
    status: string;
    currency: string;
    basis: string;
    budget_pricing_date: string | null;
    budget_cycle_currency: string | null;
    budget_envelope: string | null;
    budget_annual_hours: string | null;
    budget_fx_rate: string | null;
  }>(sql`
    select l.id as line_id, l.current_rate::text as current_rate, l.proposed_rate::text as proposed_rate, l.status,
           l.currency, l.basis,
           l.budget_pricing_date::text as budget_pricing_date, l.budget_cycle_currency,
           l.budget_envelope::text as budget_envelope,
           l.budget_annual_hours::text as budget_annual_hours,
           l.budget_fx_rate::text as budget_fx_rate
      from hrm_comp_cycle_lines l
      left join worker_employments e on e.org_id = l.org_id and e.id = l.employment_id
     where l.org_id = ${orgId} and l.cycle_id = ${cycleId}
       and l.status in ('proposed', 'approved', 'pushed')
       and l.proposed_rate is not null
       and (${allowed === null}::boolean
            or e.employer_subsidiary_id in (
              select jsonb_array_elements_text(${JSON.stringify([...(allowed ?? [])])}::jsonb)::uuid
            ))`)).rows;
  let increase = "0.0000";
  let envelope: string | null = null;
  for (const row of rows) {
    const lineId = String(row.line_id);
    const basis = String(row.basis);
    const currency = String(row.currency);
    const delta = fromUnits(toUnits(String(row.proposed_rate)) - toUnits(String(row.current_rate)));
    if (cmp(delta, "0") <= 0) continue;
    if (row.budget_pricing_date === null) {
      // Legacy (pre-0243) row: annual same-currency resolves its
      // identity factor directly; anything needing historical inputs
      // refuses rather than repricing from live data.
      if (basis !== "hourly" && currency === cycleCurrency) {
        increase = add(increase, delta);
        envelope = String(cycle.budget_total);
        continue;
      }
      throw legacyEvidenceRefusal(lineId, basis, currency);
    }
    // Frozen row: a null envelope copy means a null-envelope cycle,
    // which never paces over regardless of decisions.
    if (row.budget_envelope === null) continue;
    const annual =
      basis === "hourly"
        ? row.budget_annual_hours === null
          ? missingFrozen(lineId, basis, currency)
          : mul(delta, String(row.budget_annual_hours))
        : delta;
    const inEnvelope =
      currency === String(row.budget_cycle_currency)
        ? annual
        : row.budget_fx_rate === null
          ? missingFrozen(lineId, basis, currency)
          : mulRate(annual, String(row.budget_fx_rate));
    increase = add(increase, inEnvelope);
    envelope = String(row.budget_envelope);
  }
  // No positive decided increase in view: a positive envelope reads
  // 0% (never null — scoped readers see their slice's zero), a zero or
  // null envelope has no defined ratio.
  if (envelope === null) {
    if (cycle.budget_total !== null && cmp(String(cycle.budget_total), "0") > 0) {
      return { totalPct: 0, overBudget: false };
    }
    return { totalPct: null, overBudget: false };
  }
  // The exact comparison decides over-budget; the float ratio is display
  // only. A zero envelope has no defined ratio: a zero increase is not
  // over, any positive increase is over with no percentage to name.
  if (cmp(increase, envelope) <= 0) {
    if (cmp(envelope, "0") === 0) return { totalPct: null, overBudget: false };
    return { totalPct: displayPct(increase, envelope), overBudget: false };
  }
  return { totalPct: cmp(envelope, "0") === 0 ? null : displayPct(increase, envelope), overBudget: true };
}

export interface ProposeLineQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly lineId: string;
  /** Proposed raise percent as exact decimal text (e.g. "3.5"). Exactly one of pct/rate. */
  readonly proposedPct?: string | number | null;
  readonly proposedRate?: string | null;
  readonly reason?: string | null;
}

/**
 * Canonical 6dp percent text for a typed pct input (proposed_pct is
 * numeric(19,6)). More than 6 meaningful places refuses with a usable
 * remedy instead of computing a wage from full precision while storing
 * a rounded percent — the two evidences must agree.
 */
function pctInput6(pct: string | number): string {
  const text = String(pct);
  let canonical: string;
  try {
    canonical = normalizeDecimal(text, 6);
  } catch {
    throw new CompensationError(
      "INVALID_INPUT",
      `proposedPct ${JSON.stringify(text)} carries more than 6 meaningful decimal places — propose at most 6 decimal places instead of guessing it`,
    );
  }
  if (canonical.startsWith("-")) {
    throw new CompensationError("INVALID_INPUT", "proposedPct must be a non-negative percent");
  }
  return canonical;
}

/**
 * Exact raise off a stored rate: current × (1 + pct/100) through the
 * shared mulDecimal (one half-away rounding, never floats). The factor
 * is built by exact decimal shifting — a 6dp percent needs 8dp, inside
 * mulDecimal's 10dp contract. 100.0050 + 1% stores 101.0051, and the
 * stored percent (the input itself) always recomputes the stored rate.
 */
function raiseExact6(currentRate: string, pct6: string): string {
  const digits = pct6.replace("-", "").replace(".", "");
  const den = 100_000_000n;
  const num = den + BigInt(digits);
  return mulDecimal(currentRate, `${num / den}.${String(num % den).padStart(8, "0")}`);
}

/**
 * A ≤6dp decimal as integer millionths for exact guideline comparison,
 * converted from the canonical normalizeDecimal form — no second
 * decimal grammar. Anything deeper or malformed refuses by name.
 */
function pct6Parts(value: string, what: string): bigint {
  let canon: string;
  try {
    canon = normalizeDecimal(value, 6);
  } catch {
    throw new CompensationError(
      "INVALID_INPUT",
      `${what} ${JSON.stringify(value)} is not a plain decimal with at most 6 places — declare it within 6 places instead of guessing it`,
    );
  }
  const neg = canon.startsWith("-");
  const digits = canon.replace("-", "").replace(".", "");
  const v = BigInt(digits);
  return neg ? -v : v;
}

/**
 * Exact 6dp percent text for a decided delta off a positive current
 * rate (shared roundDiv). proposed_rate stays the authoritative money
 * value: an approximate ratio cannot round-trip every large-base rate,
 * so tests assert consistency only where the grid is exact.
 */
function pct6String(deltaUnits: bigint, currentUnits: bigint): string {
  const scaled = roundDiv(deltaUnits * 100_000_000n, currentUnits);
  const neg = scaled < 0n;
  const abs = neg ? -scaled : scaled;
  return `${neg ? "-" : ""}${abs / 1_000_000n}.${String(abs % 1_000_000n).padStart(6, "0")}`;
}

/** Display form of a 6dp percent ("3.000000" → "3"); string surgery only. */
function dispPct6(pct6: string): string {
  return pct6.includes(".") ? pct6.replace(/0+$/, "").replace(/\.$/, "") : pct6;
}

export async function proposeLine(query: ProposeLineQuery): Promise<CompCycleLineDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const lineId = requireId(query.lineId, "lineId");
  const hasPct = query.proposedPct !== undefined && query.proposedPct !== null;
  const hasRate = query.proposedRate !== undefined && query.proposedRate !== null;
  if (hasPct === hasRate) {
    throw new CompensationError("INVALID_INPUT", "propose exactly one of proposedPct or proposedRate — the other derives, never both typed");
  }
  const pct6: string | null = hasPct ? pctInput6(query.proposedPct as string | number) : null;
  if (hasRate && !/^\d+(\.\d{1,4})?$/.test(query.proposedRate as string)) {
    throw new CompensationError("INVALID_INPUT", "proposedRate must be a positive amount with at most 4 decimals");
  }
  return withOrgTransaction(orgId, async () => {
    const { cycle, line } = await loadCycleAndLineForUpdate(orgId, lineId);
    if (cycle.status !== "open" && cycle.status !== "in_review") {
      throw new CompensationError(
        "BAD_STATE",
        `a ${cycle.status} cycle takes no proposals — proposals land while the round is open or in review`,
      );
    }
    if (line.status !== "pending" && line.status !== "proposed") {
      throw new CompensationError(
        "BAD_STATE",
        `a ${line.status} line cannot be proposed — reopen it with a reason first`,
      );
    }
    const today = await businessToday(orgId);
    if (!(await canProposeForEmployment(orgId, actorId, line.employment_id, today))) {
      throw new CompensationError(
        "REFUSED",
        "proposals come from the employment's manager or hrm.compensation.manage — ask the direct manager to propose, or an HR administrator",
      );
    }
    // The grant (or team) above never decides the entity: the line's
    // employment must sit inside the lens, or a manage holder proposes
    // B's wages and a B-team manager proposes through structure alone.
    await assertLineEmploymentScope(orgId, actorId, line.employment_id);
    // Both directions derive exactly at 6dp through shared
    // primitives: a pct raises the stored rate through raiseExact6
    // (mulDecimal, one rounding), a typed rate derives its percent
    // through pct6String (roundDiv). A percent off a zero current rate
    // is undefined — it stores null and always needs its reason named,
    // never a fabricated zero. Guideline limits are assessed on the
    // exact ratio (cross-multiplied), so display rounding cannot hide
    // a just-outside-guideline rate.
    const currentUnits = toUnits(String(line.current_rate));
    const proposedRate = hasRate
      ? normalizeDecimal(query.proposedRate as string, 4)
      : raiseExact6(String(line.current_rate), pct6 as string);
    const proposedUnits = toUnits(proposedRate);
    const derivedPct6: string | null =
      currentUnits === 0n
        ? (proposedUnits === 0n ? "0.000000" : null)
        : pct6String(proposedUnits - currentUnits, currentUnits);
    const storedPct6: string | null = hasPct ? pct6 : derivedPct6;
    // Outside-guideline is allowed but flagged: without a reason it refuses.
    // A line with no guideline (no band) always needs its reason named.
    const lo6 = line.guideline_min_pct === null ? null : pct6Parts(String(line.guideline_min_pct), "guideline minimum");
    const hi6 = line.guideline_max_pct === null ? null : pct6Parts(String(line.guideline_max_pct), "guideline maximum");
    let outside: boolean;
    if (lo6 === null || hi6 === null || storedPct6 === null) {
      outside = true;
    } else if (hasPct) {
      const p6 = pct6Parts(storedPct6, "proposed percent");
      outside = p6 < lo6 || p6 > hi6;
    } else {
      const ratioScaled = (proposedUnits - currentUnits) * 100_000_000n;
      outside = ratioScaled < lo6 * currentUnits || ratioScaled > hi6 * currentUnits;
    }
    const reason = query.reason?.trim() ? query.reason.trim().slice(0, 2000) : null;
    if (outside && reason === null) {
      const shown = storedPct6 === null ? null : dispPct6(storedPct6);
      throw new CompensationError(
        "REFUSED",
        lo6 === null || hi6 === null
          ? "this line has no guideline range (no band covers it) — proposals on unbanded lines need a reason; add one instead of pricing silently"
          : shown === null
            ? "this raise starts from a zero current rate, so its percent is undefined — proposals off zero need a reason; add one instead of pricing silently"
            : `proposed ${shown}% sits outside the guideline ${dispPct6(String(line.guideline_min_pct))}%–${dispPct6(String(line.guideline_max_pct))}% — outside-guideline proposals need a reason; add one instead of pricing silently`,
      );
    }
    const updated = (await db.execute<LineRow>(sql`
      update hrm_comp_cycle_lines as l
         set proposed_pct = ${storedPct6}, proposed_rate = ${proposedRate},
             proposed_by = ${actorId}, proposed_at = now(), status = 'proposed',
             reason = ${reason}, revision = revision + 1,
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${lineId} and revision = ${line.revision}
       returning ${LINE_COLUMNS}`)).rows[0];
    if (!updated) {
      throw new CompensationError("STALE_REVISION", "the line moved while it was proposed — reload it and propose again");
    }
    // Over-budget pacing WARNS and requires a reason, never blocks. The
    // control runs whole-cycle with no read grant (structural managers
    // propose without hrm.compensation.read). The percentage names the
    // whole-cycle total, so only a proposer who could read it through
    // cyclePacing anyway — hrm.compensation.read with an unrestricted
    // lens — sees the number; every other valid proposer gets the same
    // usable numberless remedy.
    const pacing = await computePacing(orgId, line.cycle_id, null);
    if (pacing.overBudget && reason === null) {
      const lens = await loadCompensationLens(db, orgId, actorId);
      const maySeeTotals =
        lens === null && (await actorHasPermission(db, orgId, actorId, "hrm.compensation.read"));
      // A zero envelope is over with no defined ratio: every refused
      // proposer gets the usable numberless remedy, never 'undefined%'.
      const pct = pacing.totalPct;
      throw new CompensationError(
        "REFUSED",
        maySeeTotals && pct !== null && Number.isFinite(pct)
          ? `this proposal takes the cycle to ${pct.toFixed(1)}% of its budget envelope — over-budget pacing needs a reason; add one instead of spending silently`
          : "this proposal takes the cycle over its budget envelope — over-budget pacing needs a reason; add one instead of spending silently",
      );
    }
    await recordEvent(db, orgId, line.cycle_id, lineId, "proposed", actorId, reason);
    const worker = (await db.execute<{ worker_party_id: string }>(sql`
      select worker_party_id from worker_employments where org_id = ${orgId} and id = ${line.employment_id}`)).rows[0];
    return toLineDTO(updated, worker?.worker_party_id ?? "");
  });
}

/** Reopen a decided (approved/rejected) line to proposed, with a reason. Pushed lines never reopen. */
export async function reopenLine(query: {
  orgId: string;
  actorId: string;
  lineId: string;
  reason: string;
}): Promise<CompCycleLineDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const lineId = requireId(query.lineId, "lineId");
  const reason = requireReason(query.reason);
  return withOrgTransaction(orgId, async () => {
    const { cycle, line } = await loadCycleAndLineForUpdate(orgId, lineId);
    if (line.status === "pushed") {
      throw new CompensationError(
        "BAD_STATE",
        "a pushed line already moved payroll — reverse through a new cycle, never by reopening",
      );
    }
    if (line.status !== "approved" && line.status !== "rejected") {
      throw new CompensationError(
        "BAD_STATE",
        `a ${line.status} line needs no reopening — only decided lines reopen`,
      );
    }
    if (cycle.status !== "open" && cycle.status !== "in_review") {
      throw new CompensationError(
        "BAD_STATE",
        `a ${cycle.status} cycle reopens no lines — reopening belongs to the open round`,
      );
    }
    const today = await businessToday(orgId);
    if (!(await canProposeForEmployment(orgId, actorId, line.employment_id, today))) {
      throw new CompensationError(
        "REFUSED",
        "reopening comes from the employment's manager or hrm.compensation.manage — ask the direct manager, or an HR administrator",
      );
    }
    // Same entity check as proposing: the grant or team never opens
    // another entity's decided line.
    await assertLineEmploymentScope(orgId, actorId, line.employment_id);
    const updated = (await db.execute<LineRow>(sql`
      update hrm_comp_cycle_lines as l
         set status = 'proposed', approver_party_id = null, decided_at = null,
             reason = ${reason}, revision = revision + 1,
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${lineId} and revision = ${line.revision}
       returning ${LINE_COLUMNS}`)).rows[0];
    if (!updated) {
      throw new CompensationError("STALE_REVISION", "the line moved while it was reopened — reload it and reopen again");
    }
    await recordEvent(db, orgId, line.cycle_id, lineId, "reopened", actorId, reason);
    const worker = (await db.execute<{ worker_party_id: string }>(sql`
      select worker_party_id from worker_employments where org_id = ${orgId} and id = ${line.employment_id}`)).rows[0];
    return toLineDTO(updated, worker?.worker_party_id ?? "");
  });
}

// ---------------------------------------------------------------------------
// Line decisions (approve/reject): the Flows gate key plus identity
// separation. The decider is never the proposer.
// ---------------------------------------------------------------------------

/**
 * Pure separation-of-duties invariant for line decisions. Both identity
 * legs must hold: the decider is neither the proposing user nor a second
 * login for the proposer's person. An unresolvable proposer — a legacy
 * line with no proposed_by, a deleted proposing user, or a null party on
 * either side — is a named refusal (re-propose the line), never a pass:
 * an identity that cannot be checked cannot be cleared.
 */
export function assertLineDeciderSeparation(args: {
  proposedBy: string | null;
  proposerPartyId: string | null;
  deciderUserId: string;
  deciderPartyId: string | null;
}): void {
  if (args.proposedBy === null) {
    throw new CompensationError(
      "REFUSED",
      "this line names no proposer — separation of duties cannot be verified; re-propose the line before deciding",
    );
  }
  if (args.proposedBy === args.deciderUserId) {
    throw new CompensationError(
      "REFUSED",
      "the proposer cannot decide their own line — separation of duties; a second approver decides",
    );
  }
  if (args.proposerPartyId === null || args.deciderPartyId === null) {
    throw new CompensationError(
      "REFUSED",
      "the line proposer can't be verified — re-propose the line so separation of duties can be checked",
    );
  }
  if (args.proposerPartyId === args.deciderPartyId) {
    throw new CompensationError(
      "REFUSED",
      "the proposer cannot decide their own line — separation of duties; a second approver decides",
    );
  }
}

async function decideLine(
  orgId: string,
  actorId: string,
  lineId: string,
  decision: "approved" | "rejected",
  reason: string | null,
): Promise<CompCycleLineDTO> {
  return withOrgTransaction(orgId, async () => {
    await requireHrmCompensationApprove(db, orgId, actorId);
    const { cycle, line } = await loadCycleAndLineForUpdate(orgId, lineId);
    // Deciding moves another entity's wage: the Flows approve grant never
    // substitutes for entity scope — the cycle anchor and the line's
    // employer are rechecked under the locks first.
    await assertCycleWriteScope(orgId, actorId, cycle, []);
    await assertLineEmploymentScope(orgId, actorId, line.employment_id);
    if (cycle.status !== "open" && cycle.status !== "in_review" && cycle.status !== "approved") {
      throw new CompensationError(
        "BAD_STATE",
        `a ${cycle.status} cycle decides no lines — line decisions land while the round is open, in review, or approved`,
      );
    }
    if (line.status !== "proposed") {
      throw new CompensationError(
        "BAD_STATE",
        `a ${line.status} line cannot be decided — only proposed lines decide`,
      );
    }
    assertLineDeciderSeparation({
      proposedBy: line.proposed_by,
      proposerPartyId: (await db.execute<{ party_id: string | null }>(sql`
        select party_id from users where id = ${line.proposed_by}`)).rows[0]?.party_id ?? null,
      deciderUserId: actorId,
      deciderPartyId: (await db.execute<{ party_id: string | null }>(sql`
        select party_id from users where id = ${actorId}`)).rows[0]?.party_id ?? null,
    });
    if (decision === "rejected" && (reason === null || reason.trim().length === 0)) {
      throw new CompensationError("INVALID_INPUT", "a rejection needs its reason — the manager reads it");
    }
    const approverParty = (await db.execute<{ party_id: string | null }>(sql`
      select party_id from users where id = ${actorId}`)).rows[0]?.party_id ?? null;
    const updated = (await db.execute<LineRow>(sql`
      update hrm_comp_cycle_lines as l
         set status = ${decision}, approver_party_id = ${approverParty}, decided_at = now(),
             reason = coalesce(${reason}, reason), revision = revision + 1,
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${lineId} and revision = ${line.revision}
       returning ${LINE_COLUMNS}`)).rows[0];
    if (!updated) {
      throw new CompensationError("STALE_REVISION", "the line moved while it was decided — reload it and decide again");
    }
    await recordEvent(db, orgId, line.cycle_id, lineId, decision, actorId, reason);
    const worker = (await db.execute<{ worker_party_id: string }>(sql`
      select worker_party_id from worker_employments where org_id = ${orgId} and id = ${line.employment_id}`)).rows[0];
    return toLineDTO(updated, worker?.worker_party_id ?? "");
  });
}

export async function approveLine(query: {
  orgId: string;
  actorId: string;
  lineId: string;
  reason?: string | null;
}): Promise<CompCycleLineDTO> {
  return decideLine(requireOrgId(query.orgId), requireActorId(query.actorId), requireId(query.lineId, "lineId"), "approved", query.reason ?? null);
}

export async function rejectLine(query: {
  orgId: string;
  actorId: string;
  lineId: string;
  reason: string;
}): Promise<CompCycleLineDTO> {
  return decideLine(requireOrgId(query.orgId), requireActorId(query.actorId), requireId(query.lineId, "lineId"), "rejected", requireReason(query.reason));
}

// ---------------------------------------------------------------------------
// Submit for approval (the Flows run), release, push, close, cancel.
// ---------------------------------------------------------------------------

/** Submit an open cycle: the approval is a Flows run over the cycle. */
export async function submitCycleForApproval(query: {
  orgId: string;
  actorId: string;
  cycleId: string;
}): Promise<CompCycleDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const cycleId = requireId(query.cycleId, "cycleId");
  return withOrgTransaction(orgId, async () => {
    await requireHrmCompensationManage(db, orgId, actorId);
    const cycle = await loadCycleForUpdate(orgId, cycleId);
    // Submitting moves the whole round into approval: the anchor and
    // every line's employer are rechecked under the cycle lock first, or
    // an A-scoped actor submits B's wages for decision.
    await assertCycleWriteScope(orgId, actorId, cycle, await lineEmploymentIds(orgId, cycleId));
    if (cycle.status !== "open") {
      throw new CompensationError(
        "BAD_STATE",
        `a ${cycle.status} cycle cannot be submitted — only open rounds submit`,
      );
    }
    const undecided = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from hrm_comp_cycle_lines
       where org_id = ${orgId} and cycle_id = ${cycleId} and status = 'pending'`)).rows[0];
    if (undecided && Number(undecided.n) > 0) {
      throw new CompensationError(
        "REFUSED",
        `${undecided.n} lines were never proposed — every line needs a proposal (or an explicit rejection of the round) before review`,
      );
    }
    const { HRM_COMP_CYCLE_SUBJECT_KIND } = await import("@openbooks/schema/src/hrm-compensation.ts");
    const { runRecordFlows } = await import("../../flows/run.ts");
    const flowResult = await runRecordFlows(
      { kind: "on_submit", source: "api" },
      HRM_COMP_CYCLE_SUBJECT_KIND,
      cycleId,
      { orgId, userId: actorId },
    );
    const gatedRun = flowResult.runs.find((run) => run.gatesCreated > 0);
    if (flowResult.failed || !gatedRun) {
      throw new CompensationError(
        "REFUSED",
        "no enabled approval flow produced an approval gate for compensation cycles — configure a flow for compensation cycles before submitting",
      );
    }
    const updated = (await db.execute<CycleRow>(sql`
      update hrm_comp_cycles
         set status = 'in_review', flow_run_id = ${gatedRun.runId}, revision = revision + 1,
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${cycleId} and status = 'open' and revision = ${cycle.revision}
       returning ${CYCLE_COLUMNS}`)).rows[0];
    if (!updated) {
      throw new CompensationError("STALE_REVISION", "the cycle moved while it was submitted — reload it and submit again");
    }
    await recordEvent(db, orgId, cycleId, null, "proposed", actorId, "submitted for approval");
    return toCycleDTO(updated);
  });
}

/**
 * Release the Flows decision onto the cycle (called from the
 * comp-cycle subject adapter inside decideGate's savepoint — a throw
 * rolls the whole decision back and the gate stays pending).
 */
export async function releaseCompCycleDecision(
  orgId: string,
  cycleId: string,
  decision: "approved" | "rejected",
  deciderId: string,
): Promise<void> {
  const cycle = (await db.execute<CycleRow>(sql`
    select ${CYCLE_COLUMNS} from hrm_comp_cycles where org_id = ${orgId} and id = ${cycleId}`)).rows[0];
  if (!cycle) throw new CompensationError("NOT_FOUND", "compensation cycle is not visible in this organization");
  if (cycle.status !== "in_review") {
    throw new CompensationError(
      "BAD_STATE",
      `a ${cycle.status} cycle cannot be released — only a cycle in review releases`,
    );
  }
  if (decision === "approved") {
    const updated = (await db.execute<CycleRow>(sql`
      update hrm_comp_cycles
         set status = 'approved', approved_at = now(), revision = revision + 1, updated_at = now()
       where org_id = ${orgId} and id = ${cycleId} and status = 'in_review'
       returning ${CYCLE_COLUMNS}`)).rows[0];
    if (!updated) throw new CompensationError("STALE_REVISION", "the cycle moved while it was released — the gate stays pending");
    await recordEvent(db, orgId, cycleId, null, "approved", deciderId, "flows approval released");
  } else {
    const updated = (await db.execute<CycleRow>(sql`
      update hrm_comp_cycles
         set status = 'open', revision = revision + 1, updated_at = now()
       where org_id = ${orgId} and id = ${cycleId} and status = 'in_review'
       returning ${CYCLE_COLUMNS}`)).rows[0];
    if (!updated) throw new CompensationError("STALE_REVISION", "the cycle moved while it was released — the gate stays pending");
    await recordEvent(db, orgId, cycleId, null, "rejected", deciderId, "flows approval rejected — rework and resubmit");
  }
}

export interface PushResult {
  readonly pushed: number;
  readonly skipped: number;
  /** True when a committed run covers effective_on: the wage change lands in a paid period, so review the retro candidates — never backdate silently. */
  readonly retroReviewDue: boolean;
}

/**
 * Push an approved cycle: one canonical wage write per approved line,
 * effective on the cycle's effective_on, in one transaction with the
 * cycle status. Idempotent: a line with pushed_rate_id set is verified
 * org-scoped and skipped, never written twice.
 */
export async function pushCycle(query: {
  orgId: string;
  actorId: string;
  cycleId: string;
}): Promise<PushResult> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const cycleId = requireId(query.cycleId, "cycleId");
  return withOrgTransaction(orgId, async () => {
    await requireHrmCompensationManage(db, orgId, actorId);
    const cycle = await loadCycleForUpdate(orgId, cycleId);
    // Pushing writes wages: the anchor and every line's employer are
    // rechecked under the cycle lock before the first wage write, or an
    // A-scoped actor pushes B's wages into payroll.
    await assertCycleWriteScope(orgId, actorId, cycle, await lineEmploymentIds(orgId, cycleId));
    if (cycle.status !== "approved") {
      throw new CompensationError(
        "BAD_STATE",
        `a ${cycle.status} cycle cannot push — only an approved round pushes to payroll`,
      );
    }
    const effectiveOn = String(cycle.effective_on).slice(0, 10);
    const lines = (await db.execute<LineRow & { worker_party_id: string }>(sql`
      select ${LINE_COLUMNS}, e.worker_party_id
        from hrm_comp_cycle_lines l
        join worker_employments e on e.org_id = l.org_id and e.id = l.employment_id
       where l.org_id = ${orgId} and l.cycle_id = ${cycleId} for update of l`)).rows;
    const undecided = lines.filter((l) => l.status === "proposed" || l.status === "pending");
    if (undecided.length > 0) {
      throw new CompensationError(
        "REFUSED",
        `${undecided.length} lines still await decision — every line decides (approve or reject) before the round pushes`,
      );
    }
    const settings = await laborCostingSettings(orgId);
    let pushed = 0;
    let skipped = 0;
    for (const line of lines) {
      // Idempotency starts with verification: any line naming a wage row
      // proves the row is in this org before anything is trusted — a
      // foreign row halts the push, never skips silently.
      if (line.pushed_rate_id !== null) {
        const rate = (await db.execute<{ id: string }>(sql`
          select id from labor_cost_rates where org_id = ${orgId} and id = ${line.pushed_rate_id}`)).rows[0];
        if (!rate) {
          throw new CompensationError(
            "REFUSED",
            "a pushed line names a wage row outside this organization — the push is halted, not skipped; unwind the line before pushing again",
          );
        }
        skipped += 1;
        continue;
      }
      if (line.status !== "approved") continue;
      if (line.proposed_rate === null) {
        throw new CompensationError(
          "REFUSED",
          "an approved line carries no proposed rate — the decision is incomplete; reopen and re-propose before pushing",
        );
      }
      // F3-38: an approved line with no raise pushes a redundant wage row
      // that rewrites history without changing pay. Refuse it by name —
      // reject the line or reopen with a real proposal before pushing.
      if (toUnits(String(line.proposed_rate)) <= toUnits(String(line.current_rate))) {
        throw new CompensationError(
          "REFUSED",
          "an approved line carries no raise — pushing it would write an identical wage row; reject the line or reopen with a real proposal before pushing",
        );
      }
      const outcome = await supersedeLaborCostRate({
        orgId,
        actorId,
        scope: { employeePartyId: String(line.worker_party_id), jobTitle: null, tradeId: null, departmentId: null, subsidiaryId: null },
        effectiveFrom: effectiveOn,
        rate: String(line.proposed_rate),
        currency: line.currency,
        basis: line.basis === "hourly" ? "hour" : "year",
        annualHours: String(settings.annualHours),
        notes: `compensation cycle ${cycle.name}`,
        reason: `compensation cycle ${cycle.name} pushed`,
      });
      const stamped = (await db.execute(sql`
        update hrm_comp_cycle_lines as l
           set status = 'pushed', pushed_rate_id = ${outcome.rateId}, revision = revision + 1,
               updated_by = ${actorId}, updated_at = now()
         where org_id = ${orgId} and id = ${line.id} and status = 'approved' and pushed_rate_id is null
         returning id`)).rows[0];
      if (!stamped) {
        throw new CompensationError("STALE_REVISION", "a line moved while the round pushed — the push halts; re-push resumes from the remaining lines");
      }
      await recordEvent(db, orgId, cycleId, line.id, "pushed", actorId, `wage ${outcome.rateId} effective ${effectiveOn}`);
      pushed += 1;
    }
    // A push effective in a period payroll already ran must be surfaced
    // as a retro candidate through the existing retro-store detection
    // (the new wage rows postdate the stubs), never backdated silently.
    const committed = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n
        from pay_runs r
       where r.org_id = ${orgId} and r.run_status = 'committed' and r.run_type <> 'retro'
         and r.period_end >= ${effectiveOn}::date`)).rows[0];
    const retroReviewDue = committed !== undefined && Number(committed.n) > 0;
    const updated = (await db.execute<CycleRow>(sql`
      update hrm_comp_cycles
         set status = 'pushed', pushed_at = now(), revision = revision + 1,
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${cycleId} and status = 'approved' and revision = ${cycle.revision}
       returning ${CYCLE_COLUMNS}`)).rows[0];
    if (!updated) {
      throw new CompensationError("STALE_REVISION", "the cycle moved while it pushed — reload it before pushing again");
    }
    await recordEvent(
      db,
      orgId,
      cycleId,
      null,
      "pushed",
      actorId,
      retroReviewDue
        ? `${pushed} lines pushed; committed runs cover ${effectiveOn} — review the retro candidates`
        : `${pushed} lines pushed`,
    );
    return { pushed, skipped, retroReviewDue };
  });
}

export async function closeCycle(query: { orgId: string; actorId: string; cycleId: string }): Promise<CompCycleDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const cycleId = requireId(query.cycleId, "cycleId");
  return withOrgTransaction(orgId, async () => {
    await requireHrmCompensationManage(db, orgId, actorId);
    const cycle = await loadCycleForUpdate(orgId, cycleId);
    // Closing seals the round's wages: same anchor-and-lines recheck
    // under the lock, or an A-scoped actor closes B's merit round.
    await assertCycleWriteScope(orgId, actorId, cycle, await lineEmploymentIds(orgId, cycleId));
    if (cycle.status !== "pushed") {
      throw new CompensationError(
        "BAD_STATE",
        `a ${cycle.status} cycle cannot close — only a pushed round closes`,
      );
    }
    const updated = (await db.execute<CycleRow>(sql`
      update hrm_comp_cycles
         set status = 'closed', closed_at = now(), revision = revision + 1,
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${cycleId} and status = 'pushed' and revision = ${cycle.revision}
       returning ${CYCLE_COLUMNS}`)).rows[0];
    if (!updated) throw new CompensationError("STALE_REVISION", "the cycle moved while it closed — reload it and close again");
    await recordEvent(db, orgId, cycleId, null, "closed", actorId, null);
    return toCycleDTO(updated);
  });
}

export async function cancelCycle(query: {
  orgId: string;
  actorId: string;
  cycleId: string;
  reason: string;
}): Promise<CompCycleDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const cycleId = requireId(query.cycleId, "cycleId");
  const reason = requireReason(query.reason);
  return withOrgTransaction(orgId, async () => {
    await requireHrmCompensationManage(db, orgId, actorId);
    const cycle = await loadCycleForUpdate(orgId, cycleId);
    // Cancelling voids the round for every line: same recheck, or an
    // A-scoped actor cancels B's live round.
    await assertCycleWriteScope(orgId, actorId, cycle, await lineEmploymentIds(orgId, cycleId));
    if (cycle.status === "pushed" || cycle.status === "closed" || cycle.status === "cancelled") {
      throw new CompensationError(
        "BAD_STATE",
        `a ${cycle.status} cycle cannot cancel — cancellation belongs to the live round, never to moved payroll`,
      );
    }
    const updated = (await db.execute<CycleRow>(sql`
      update hrm_comp_cycles
         set status = 'cancelled', revision = revision + 1,
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${cycleId} and revision = ${cycle.revision}
       returning ${CYCLE_COLUMNS}`)).rows[0];
    if (!updated) throw new CompensationError("STALE_REVISION", "the cycle moved while it cancelled — reload it and cancel again");
    await recordEvent(db, orgId, cycleId, null, "cancelled", actorId, reason);
    return toCycleDTO(updated);
  });
}

/** Cycle budgets: replace the envelope rows for a draft cycle (amounts only; allocation is computed at read). */
export async function setCycleBudgets(query: {
  orgId: string;
  actorId: string;
  cycleId: string;
  budgets: readonly { departmentId?: string | null; managerPartyId?: string | null; currency: string; amount: string }[];
}): Promise<void> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const cycleId = requireId(query.cycleId, "cycleId");
  return withOrgTransaction(orgId, async () => {
    await requireHrmCompensationManage(db, orgId, actorId);
    const cycle = await loadCycleForUpdate(orgId, cycleId);
    // Budgets price the round's lines: same anchor-and-lines recheck, or
    // an A-scoped actor funds B's round.
    await assertCycleWriteScope(orgId, actorId, cycle, await lineEmploymentIds(orgId, cycleId));
    if (cycle.status !== "draft") {
      throw new CompensationError(
        "BAD_STATE",
        `a ${cycle.status} cycle takes no new budgets — envelopes are set while the round is a draft`,
      );
    }
    for (const budget of query.budgets) {
      const holders = [budget.departmentId ?? null, budget.managerPartyId ?? null].filter((v) => v !== null);
      if (holders.length !== 1) {
        throw new CompensationError("INVALID_INPUT", "each budget names exactly one holder — a department or a manager, never both, never neither");
      }
      if (!/^[A-Z]{3}$/.test(budget.currency)) {
        throw new CompensationError("INVALID_INPUT", "budget currency must be an ISO 4217 code");
      }
      if (!/^\d+(\.\d{1,4})?$/.test(budget.amount)) {
        throw new CompensationError("INVALID_INPUT", "budget amount must be a non-negative amount with at most 4 decimals");
      }
    }
    await db.execute(sql`delete from hrm_comp_cycle_budgets where org_id = ${orgId} and cycle_id = ${cycleId}`);
    for (const budget of query.budgets) {
      await db.execute(sql`
        insert into hrm_comp_cycle_budgets (org_id, cycle_id, department_id, manager_party_id, currency, amount, created_by, updated_by)
        values (${orgId}, ${cycleId}, ${budget.departmentId ?? null}, ${budget.managerPartyId ?? null},
                ${budget.currency}, ${budget.amount}, ${actorId}, ${actorId})`);
    }
    await recordEvent(db, orgId, cycleId, null, "budget_changed", actorId, `${query.budgets.length} envelopes set`);
  });
}
