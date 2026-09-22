import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../../platform/db.ts";
import { businessToday } from "../../platform/business-date.ts";
import { resolveWage, laborCostingSettings } from "../../projects/labor-costing.ts";
import { add, cmp, isZero, mul, mulDecimal, normalizeDecimal, normalizeMoney } from "../../money/money.ts";
import {
  requireHrmCompensationManage,
  requireHrmCompensationRead,
} from "../authorization.ts";
import { CompensationError } from "./errors.ts";
import { compensationSettings, type FteRounding } from "./architecture.ts";
import { resolveBandForScope } from "./bands.ts";
import { requireActorId, requireId, requireOrgId } from "../recruiting/input.ts";

/**
 * Headcount plans (HR-12, 0222): workforce scenarios costed before they
 * are approved.
 *
 * Every line is costed at save from the band target (or the incumbent
 * rate for backfill/change lines naming a positioned employment) plus
 * the org's burden rate — stored beside its inputs in cost_basis so the
 * figure is explainable, never a typed number. The burden rate resolves
 * from the compensation settings document, falling back to the sum of
 * the labor-costing percent_of_wage and worker_comp components.
 * Approving a create/backfill line opens a requisition through the
 * existing recruiting requisition service (headcount = planned_fte
 * rounded per the org's FTE rounding); a hire against that requisition
 * marks the line filled (called from the hire completion path).
 * Terminate lines are INFORMATIONAL and never end an employment —
 * storage and service both have no path that does.
 */

export type PlanStatus = "draft" | "submitted" | "approved" | "closed";
export type PlanLineKind = "create" | "backfill" | "change" | "terminate";
export type PlanLineStatus = "proposed" | "approved" | "rejected" | "opened" | "filled" | "cancelled";

export interface HeadcountPlanDTO {
  readonly id: string;
  readonly name: string;
  readonly fiscalPeriodFrom: string;
  readonly fiscalPeriodTo: string;
  readonly status: PlanStatus;
  readonly revision: number;
}

export interface PlanLineDTO {
  readonly id: string;
  readonly planId: string;
  readonly kind: PlanLineKind;
  readonly positionId: string | null;
  readonly title: string;
  readonly departmentId: string | null;
  readonly employerSubsidiaryId: string;
  readonly jobLevelId: string | null;
  readonly plannedFte: string;
  readonly startOn: string;
  readonly endOn: string | null;
  readonly estAnnualCost: string;
  readonly currency: string;
  readonly costBasis: Record<string, unknown>;
  readonly status: PlanLineStatus;
  readonly requisitionId: string | null;
  readonly revision: number;
}

type PlanRow = {
  id: string;
  name: string;
  fiscal_period_from: string;
  fiscal_period_to: string;
  status: string;
  revision: number;
};

function toPlanDTO(row: PlanRow): HeadcountPlanDTO {
  return {
    id: row.id,
    name: row.name,
    fiscalPeriodFrom: String(row.fiscal_period_from).slice(0, 10),
    fiscalPeriodTo: String(row.fiscal_period_to).slice(0, 10),
    status: row.status as PlanStatus,
    revision: row.revision,
  };
}

type PlanLineRow = {
  id: string;
  plan_id: string;
  kind: string;
  position_id: string | null;
  title: string;
  department_id: string | null;
  employer_subsidiary_id: string;
  job_level_id: string | null;
  planned_fte: string;
  start_on: string;
  end_on: string | null;
  est_annual_cost: string;
  currency: string;
  cost_basis: Record<string, unknown>;
  status: string;
  requisition_id: string | null;
  revision: number;
};

const LINE_COLUMNS = sql`id, plan_id, kind, position_id, title, department_id, employer_subsidiary_id,
  job_level_id, planned_fte::text as planned_fte, start_on::text as start_on, end_on::text as end_on,
  est_annual_cost::text as est_annual_cost, currency, cost_basis, status, requisition_id, revision`;

function toLineDTO(row: PlanLineRow): PlanLineDTO {
  return {
    id: row.id,
    planId: row.plan_id,
    kind: row.kind as PlanLineKind,
    positionId: row.position_id,
    title: row.title,
    departmentId: row.department_id,
    employerSubsidiaryId: row.employer_subsidiary_id,
    jobLevelId: row.job_level_id,
    plannedFte: String(row.planned_fte),
    startOn: String(row.start_on).slice(0, 10),
    endOn: row.end_on === null ? null : String(row.end_on).slice(0, 10),
    estAnnualCost: String(row.est_annual_cost),
    currency: row.currency,
    costBasis: row.cost_basis,
    status: row.status as PlanLineStatus,
    requisitionId: row.requisition_id,
    revision: row.revision,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Planned FTE rounded per the org's declared rounding. Requisition headcount is whole people (ceil of the rounded FTE); the line keeps the precise FTE for costing. */
export function roundFteForHeadcount(plannedFte: string, rounding: FteRounding): number {
  const fte = Number(plannedFte);
  if (!Number.isFinite(fte) || !(fte > 0)) {
    throw new CompensationError(
      "INVALID_INPUT",
      `planned FTE ${JSON.stringify(plannedFte)} is not positive — a plan line staffs people, never zero or less`,
    );
  }
  if (rounding === "up_to_whole") return Math.ceil(fte);
  if (rounding === "nearest_tenth") return Math.round(fte * 10) / 10;
  return Math.round(fte * 100) / 100;
}

/** Whole-person requisition headcount for a rounded FTE: at least one hire. */
export function requisitionHeadcountFor(roundedFte: number): number {
  return Math.max(1, Math.ceil(roundedFte));
}

/**
 * Validate a declared burden fraction (e.g. "0.14" = 14%). The setting is
 * an exact decimal fraction, never a float: fractions up to 10 decimals
 * are applied exactly by {@link applyBurden}, anything beyond that is
 * refused by name instead of rounded silently.
 */
export function requireBurdenRate(raw: unknown): string {
  const rate = typeof raw === "string" ? raw.trim() : "";
  if (!/^\d+(\.\d+)?$/.test(rate)) {
    throw new CompensationError(
      "REFUSED",
      `the declared burden rate ${JSON.stringify(raw)} is not a decimal fraction — fix it in compensation settings before costing plan lines`,
    );
  }
  try {
    normalizeDecimal(rate, 10);
  } catch {
    throw new CompensationError(
      "REFUSED",
      `the declared burden rate ${JSON.stringify(rate)} carries more than 10 decimal places — round it to at most 10 decimals in compensation settings before costing plan lines`,
    );
  }
  return rate;
}

/**
 * Compose the fallback burden fraction from labor-costing wage-percentage
 * components. Each component value is a PERCENT (8.5 = 8.5%, the same
 * semantics `computeCostRate` prices), so the fraction is their exact sum
 * over 100 — never a float accumulation. Non-money, zero, and negative
 * values add no burden, matching the previous leniency and the labor-costing
 * engine's skip of unusable components.
 */
export function composeFallbackBurdenRate(values: readonly (number | string)[]): string {
  let total = "0.0000";
  for (const value of values) {
    let percent: string;
    try {
      percent = normalizeMoney(value);
    } catch {
      continue;
    }
    if (cmp(percent, "0") <= 0) continue;
    total = add(total, percent);
  }
  if (isZero(total)) return "0";
  // Percent to fraction is an exact two-place shift, not money division:
  // `div` would round the fraction to 4 money decimals (0.005% -> 0.0001,
  // doubling a 60000-base charge from 3.0000 to 6.0000). `normalizeDecimal`
  // accepts exponent notation exactly, so e-2 at scale 6 preserves all 4
  // percent decimals. `mulPercent` is not a fraction converter either —
  // it also returns 4 money decimals.
  return normalizeDecimal(`${total}e-2`, 6);
}

/**
 * Load a costed base with an exact burden fraction: base + base×rate.
 * The fraction applies via `mulDecimal` (exact to 10 decimals), so a
 * configured "0.1400" prices exactly — the old `String(1 + Number(rate))`
 * float multiplier produced "1.1400000000000001" and threw.
 */
export function applyBurden(base: string, burdenRate: string): string {
  return add(base, mulDecimal(base, burdenRate));
}

/** The burden fraction: declared setting first, else the labor-costing wage-percentage components. */
async function burdenRateFor(orgId: string): Promise<{ rate: string; source: string }> {
  const settings = await compensationSettings(orgId);
  if (settings.burdenRate !== null) {
    return { rate: requireBurdenRate(settings.burdenRate), source: "compensation_settings" };
  }
  const costing = await laborCostingSettings(orgId);
  const percents: (number | string)[] = [];
  for (const component of costing.components) {
    if (component.kind === "percent_of_wage" || component.kind === "worker_comp") {
      percents.push(component.value);
    }
  }
  return { rate: composeFallbackBurdenRate(percents), source: "labor_costing_components" };
}

interface CostedLine {
  estAnnualCost: string;
  costBasis: Record<string, unknown>;
}

/**
 * Cost one line: the band target for the line's level scope (or the
 * incumbent payroll-side rate when no band covers it), scaled by
 * planned FTE, loaded with burden. Every input lands in cost_basis.
 */
async function costLine(
  orgId: string,
  args: {
    jobLevelId: string | null;
    employerSubsidiaryId: string;
    departmentId: string | null;
    locationId: string | null;
    plannedFte: string;
    currency: string;
    asOf: string;
    incumbentPartyId?: string | null;
  },
): Promise<CostedLine> {
  const burden = await burdenRateFor(orgId);
  let basis: string;
  let annualTarget: string;
  if (args.jobLevelId !== null) {
    const level = (await db.execute<{ family_id: string | null }>(sql`
      select family_id from hrm_job_levels where org_id = ${orgId} and id = ${args.jobLevelId}`)).rows[0];
    if (!level) {
      throw new CompensationError("NOT_FOUND", "job level is not visible in this organization");
    }
    const band = await resolveBandForScope(
      orgId,
      {
        familyId: level.family_id,
        levelId: args.jobLevelId,
        employerSubsidiaryId: args.employerSubsidiaryId,
        locationId: args.locationId,
        currency: args.currency,
        basis: "annual",
      },
      args.asOf,
    );
    if (band) {
      basis = "band_target";
      annualTarget = band.target;
    } else if (args.incumbentPartyId) {
      const settings = await laborCostingSettings(orgId);
      const wage = await resolveWage(orgId, args.incumbentPartyId, args.asOf, {
        departmentId: args.departmentId,
        subsidiaryId: args.employerSubsidiaryId,
      });
      if (!wage) {
        throw new CompensationError(
          "REFUSED",
          "no band covers this line's level and no payroll-side wage covers the incumbent — price the line from a band or a wage, never a guess",
        );
      }
      basis = "incumbent_rate";
      annualTarget = mul(wage.wage, String(settings.annualHours));
    } else {
      throw new CompensationError(
        "REFUSED",
        "no band covers this line's level scope — declare a band for the level before costing the line",
      );
    }
  } else if (args.incumbentPartyId) {
    const settings = await laborCostingSettings(orgId);
    const wage = await resolveWage(orgId, args.incumbentPartyId, args.asOf, {
      departmentId: args.departmentId,
      subsidiaryId: args.employerSubsidiaryId,
    });
    if (!wage) {
      throw new CompensationError(
        "REFUSED",
        "no payroll-side wage covers the incumbent at this date — set the wage in Labor Costing before costing the line",
      );
    }
    basis = "incumbent_rate";
    annualTarget = mul(wage.wage, String(settings.annualHours));
  } else {
    throw new CompensationError(
      "REFUSED",
      "a plan line needs a job level or an incumbent to cost — name the level the hire will sit on",
    );
  }
  const base = mul(annualTarget, args.plannedFte);
  const loaded = applyBurden(base, burden.rate);
  // Stored snake_case (the 0222 cost_basis shape CHECK pins basis and
  // burden_rate); the DTO surfaces the same document.
  const costBasis = {
    basis,
    annual_target: annualTarget,
    planned_fte: args.plannedFte,
    burden_rate: burden.rate,
    burden_source: burden.source,
  };
  return { estAnnualCost: loaded, costBasis };
}

export async function createPlan(query: {
  orgId: string;
  actorId: string;
  name: string;
  fiscalPeriodFrom: string;
  fiscalPeriodTo: string;
}): Promise<HeadcountPlanDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  if (typeof query.name !== "string" || query.name.trim().length === 0) {
    throw new CompensationError("INVALID_INPUT", "a plan name is required");
  }
  if (!DATE_RE.test(query.fiscalPeriodFrom) || !DATE_RE.test(query.fiscalPeriodTo) || query.fiscalPeriodTo < query.fiscalPeriodFrom) {
    throw new CompensationError("INVALID_INPUT", "fiscalPeriodFrom/To (YYYY-MM-DD) required with To on or after From");
  }
  return withOrgTransaction(orgId, async () => {
    await requireHrmCompensationManage(db, orgId, actorId);
    const row = (await db.execute<PlanRow>(sql`
      insert into hrm_headcount_plans (org_id, name, fiscal_period_from, fiscal_period_to, created_by, updated_by)
      values (${orgId}, ${query.name.trim().slice(0, 160)}, ${query.fiscalPeriodFrom}, ${query.fiscalPeriodTo}, ${actorId}, ${actorId})
      returning id, name, fiscal_period_from::text as fiscal_period_from,
                fiscal_period_to::text as fiscal_period_to, status, revision`)).rows[0];
    if (!row) throw new CompensationError("REFUSED", "the plan insert matched no row — the save is refused, never a silent success");
    return toPlanDTO(row);
  });
}

export interface CreatePlanLineQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly planId: string;
  readonly kind: PlanLineKind;
  readonly positionId?: string | null;
  readonly title: string;
  readonly departmentId?: string | null;
  readonly employerSubsidiaryId: string;
  readonly jobLevelId?: string | null;
  readonly plannedFte: string;
  readonly startOn: string;
  readonly endOn?: string | null;
  readonly currency: string;
  readonly reason?: string | null;
}

export async function createPlanLine(query: CreatePlanLineQuery): Promise<PlanLineDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const planId = requireId(query.planId, "planId");
  if (query.kind !== "create" && query.kind !== "backfill" && query.kind !== "change" && query.kind !== "terminate") {
    throw new CompensationError("INVALID_INPUT", "line kind is create, backfill, change or terminate");
  }
  if (typeof query.title !== "string" || query.title.trim().length === 0) {
    throw new CompensationError("INVALID_INPUT", "a line title is required");
  }
  if (!/^\d+(\.\d{1,4})?$/.test(query.plannedFte) || !(Number(query.plannedFte) > 0)) {
    throw new CompensationError("INVALID_INPUT", "plannedFte must be a positive FTE figure with at most 4 decimals");
  }
  if (!DATE_RE.test(query.startOn)) {
    throw new CompensationError("INVALID_INPUT", "startOn (YYYY-MM-DD) required");
  }
  if (query.endOn !== undefined && query.endOn !== null && (!DATE_RE.test(query.endOn) || query.endOn < query.startOn)) {
    throw new CompensationError("INVALID_INPUT", "endOn (YYYY-MM-DD) must be on or after startOn");
  }
  if (!/^[A-Z]{3}$/.test(query.currency)) {
    throw new CompensationError("INVALID_INPUT", "line currency must be an ISO 4217 code");
  }
  // A create line names no position until approval opens the
  // establishment; every other kind names its position from the start.
  if (query.kind === "create" && query.positionId !== undefined && query.positionId !== null) {
    throw new CompensationError(
      "REFUSED",
      "a create line names no position until approval — the establishment opens with the requisition, not before",
    );
  }
  if (query.kind !== "create" && (query.positionId === undefined || query.positionId === null)) {
    throw new CompensationError(
      "REFUSED",
      `a ${query.kind} line names its position from the start — only create lines arrive position-less`,
    );
  }
  return withOrgTransaction(orgId, async () => {
    await requireHrmCompensationManage(db, orgId, actorId);
    const plan = (await db.execute<PlanRow>(sql`
      select id, name, fiscal_period_from::text as fiscal_period_from,
             fiscal_period_to::text as fiscal_period_to, status, revision
        from hrm_headcount_plans where org_id = ${orgId} and id = ${planId} for update`)).rows[0];
    if (!plan) throw new CompensationError("NOT_FOUND", "headcount plan is not visible in this organization");
    if (plan.status !== "draft") {
      throw new CompensationError(
        "BAD_STATE",
        `a ${plan.status} plan takes no new lines — lines are drafted with the plan`,
      );
    }
    const today = await businessToday(orgId);
    const costed = await costLine(orgId, {
      jobLevelId: query.jobLevelId ?? null,
      employerSubsidiaryId: query.employerSubsidiaryId,
      departmentId: query.departmentId ?? null,
      locationId: null,
      plannedFte: query.plannedFte,
      currency: query.currency,
      asOf: today,
    });
    const row = (await db.execute<PlanLineRow>(sql`
      insert into hrm_headcount_plan_lines
        (org_id, plan_id, kind, position_id, title, department_id, employer_subsidiary_id, job_level_id,
         planned_fte, start_on, end_on, est_annual_cost, currency, cost_basis, reason, created_by, updated_by)
      values (${orgId}, ${planId}, ${query.kind}, ${query.positionId ?? null}, ${query.title.trim().slice(0, 200)},
              ${query.departmentId ?? null}, ${query.employerSubsidiaryId}, ${query.jobLevelId ?? null},
              ${query.plannedFte}, ${query.startOn}, ${query.endOn ?? null}, ${costed.estAnnualCost},
              ${query.currency}, ${JSON.stringify(costed.costBasis)}::jsonb,
              ${query.reason?.trim().slice(0, 2000) ?? null}, ${actorId}, ${actorId})
      returning ${LINE_COLUMNS}`)).rows[0];
    if (!row) throw new CompensationError("REFUSED", "the plan line insert matched no row — the save is refused, never a silent success");
    return toLineDTO(row);
  });
}

/** Approve a line: create/backfill lines open a requisition through the recruiting service. */
export async function approvePlanLine(query: {
  orgId: string;
  actorId: string;
  lineId: string;
  reason?: string | null;
}): Promise<PlanLineDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const lineId = requireId(query.lineId, "lineId");
  return withOrgTransaction(orgId, async () => {
    await requireHrmCompensationManage(db, orgId, actorId);
    const line = (await db.execute<PlanLineRow>(sql`
      select ${LINE_COLUMNS} from hrm_headcount_plan_lines
       where org_id = ${orgId} and id = ${lineId} for update`)).rows[0];
    if (!line) throw new CompensationError("NOT_FOUND", "plan line is not visible in this organization");
    if (line.status !== "proposed") {
      throw new CompensationError(
        "BAD_STATE",
        `a ${line.status} line cannot be approved — only proposed lines approve`,
      );
    }
    const settings = await compensationSettings(orgId);
    let requisitionId: string | null = null;
    if (line.kind === "create" || line.kind === "backfill") {
      // The requisition opens through the existing recruiting service —
      // compensation never invents a second vacancy path.
      const { createRequisition, openRequisition } = await import("../recruiting/requisitions.ts");
      const roundedFte = roundFteForHeadcount(String(line.planned_fte), settings.fteRounding);
      const headcount = requisitionHeadcountFor(roundedFte);
      const requisition = await createRequisition({
        orgId,
        actorId,
        title: line.title,
        employerSubsidiaryId: line.employer_subsidiary_id,
        departmentId: line.department_id,
        positionId: line.position_id,
        headcount,
        targetStartOn: String(line.start_on).slice(0, 10),
      });
      const opened = await openRequisition({ orgId, actorId, requisitionId: requisition.id });
      requisitionId = opened.id;
    }
    const updated = (await db.execute<PlanLineRow>(sql`
      update hrm_headcount_plan_lines
         set status = ${requisitionId !== null ? "opened" : "approved"},
             requisition_id = ${requisitionId},
             reason = coalesce(${query.reason?.trim().slice(0, 2000) ?? null}, reason),
             revision = revision + 1, updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${lineId} and status = 'proposed' and revision = ${line.revision}
       returning ${LINE_COLUMNS}`)).rows[0];
    if (!updated) {
      throw new CompensationError("STALE_REVISION", "the line moved while it was approved — reload it and approve again");
    }
    return toLineDTO(updated);
  });
}

/**
 * Mark the plan line filled when a hire lands on its requisition. Called
 * from the recruiting hire completion path — never directly by a route.
 */
export async function markPlanLineFilledForRequisition(
  orgId: string,
  requisitionId: string,
): Promise<void> {
  const rows = (await db.execute<{ id: string }>(sql`
    update hrm_headcount_plan_lines
       set status = 'filled', revision = revision + 1, updated_at = now()
     where org_id = ${orgId} and requisition_id = ${requisitionId} and status = 'opened'
     returning id`)).rows;
  void rows;
}

export async function listPlans(query: { orgId: string; actorId: string }): Promise<readonly HeadcountPlanDTO[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  await requireHrmCompensationRead(db, orgId, actorId);
  const rows = (await db.execute<PlanRow>(sql`
    select id, name, fiscal_period_from::text as fiscal_period_from,
           fiscal_period_to::text as fiscal_period_to, status, revision
      from hrm_headcount_plans where org_id = ${orgId} order by fiscal_period_from desc`)).rows;
  return rows.map(toPlanDTO);
}

export async function listPlanLines(query: {
  orgId: string;
  actorId: string;
  planId: string;
}): Promise<readonly PlanLineDTO[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const planId = requireId(query.planId, "planId");
  await requireHrmCompensationRead(db, orgId, actorId);
  const rows = (await db.execute<PlanLineRow>(sql`
    select ${LINE_COLUMNS} from hrm_headcount_plan_lines
     where org_id = ${orgId} and plan_id = ${planId} order by start_on`)).rows;
  return rows.map(toLineDTO);
}

export async function submitPlan(query: { orgId: string; actorId: string; planId: string }): Promise<HeadcountPlanDTO> {
  return transitionPlan(query.orgId, query.actorId, query.planId, "draft", "submitted", "submitted_at");
}

export async function approvePlan(query: { orgId: string; actorId: string; planId: string }): Promise<HeadcountPlanDTO> {
  return transitionPlan(query.orgId, query.actorId, query.planId, "submitted", "approved", "approved_at");
}

export async function closePlan(query: { orgId: string; actorId: string; planId: string }): Promise<HeadcountPlanDTO> {
  return transitionPlan(query.orgId, query.actorId, query.planId, "approved", "closed", "closed_at");
}

async function transitionPlan(
  rawOrgId: string,
  rawActorId: string,
  rawPlanId: string,
  from: PlanStatus,
  to: PlanStatus,
  stamp: "submitted_at" | "approved_at" | "closed_at",
): Promise<HeadcountPlanDTO> {
  const orgId = requireOrgId(rawOrgId);
  const actorId = requireActorId(rawActorId);
  const planId = requireId(rawPlanId, "planId");
  return withOrgTransaction(orgId, async () => {
    await requireHrmCompensationManage(db, orgId, actorId);
    const updated = (await db.execute<PlanRow>(sql`
      update hrm_headcount_plans
         set status = ${to}, ${sql.raw(stamp)} = now(), revision = revision + 1,
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${planId} and status = ${from}
       returning id, name, fiscal_period_from::text as fiscal_period_from,
                 fiscal_period_to::text as fiscal_period_to, status, revision`)).rows[0];
    if (!updated) {
      throw new CompensationError(
        "BAD_STATE",
        `the plan is not ${from} — only a ${from} plan moves to ${to}`,
      );
    }
    return toPlanDTO(updated);
  });
}
