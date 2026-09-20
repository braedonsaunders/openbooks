import { sql } from "drizzle-orm";
import { normalizeMoney } from "../../money/money.ts";
import type { SqlExecutor } from "./shared.ts";
import { BenefitsError } from "./errors.ts";

/**
 * HRM benefit plan reads and plan-save validation (HR-8).
 *
 * Plans themselves are authored through the Setup registry (generic CRUD);
 * this module holds what the Setup write path and the election service both
 * need: loading the plan with its tiers, resolving an election's
 * per-period costs from the plan basis, and the pay-component validation
 * the payroll coordinator ruled binding (validate on plan save AND on input
 * generation, so employer money can never reach net pay).
 */

export type BenefitCostBasis = "per_period" | "per_month" | "per_year" | "percent_of_pay";
export type BenefitProrationBasis = "full_month" | "daily";

export interface BenefitPlanRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly providerPartyId: string | null;
  readonly employerSubsidiaryId: string | null;
  readonly currency: string;
  readonly employeeCostBasis: BenefitCostBasis;
  readonly employeeCost: string | null;
  readonly employerCostBasis: BenefitCostBasis;
  readonly employerCost: string | null;
  readonly employeePayComponentId: string | null;
  readonly employerPayComponentId: string | null;
  readonly pretax: boolean;
  readonly prorationBasis: BenefitProrationBasis;
  readonly waitingPeriodDays: number;
  readonly requiresApproval: boolean;
  readonly isActive: boolean;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export interface BenefitPlanLevelRow {
  readonly id: string;
  readonly levelKey: string;
  readonly label: string;
  readonly employeeCost: string;
  readonly employerCost: string;
  readonly position: number;
}

const PLAN_COLUMNS = sql`id, code, name, kind,
  provider_party_id as "providerPartyId",
  employer_subsidiary_id as "employerSubsidiaryId",
  currency, employee_cost_basis as "employeeCostBasis",
  employee_cost::text as "employeeCost",
  employer_cost_basis as "employerCostBasis",
  employer_cost::text as "employerCost",
  employee_pay_component_id as "employeePayComponentId",
  employer_pay_component_id as "employerPayComponentId",
  pretax, proration_basis as "prorationBasis",
  waiting_period_days as "waitingPeriodDays",
  requires_approval as "requiresApproval",
  is_active as "isActive",
  effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo"`;

function toPlanRow(row: Record<string, unknown>): BenefitPlanRow {
  const basis = (value: unknown, side: string): BenefitCostBasis => {
    if (
      value === "per_period" ||
      value === "per_month" ||
      value === "per_year" ||
      value === "percent_of_pay"
    ) {
      return value;
    }
    throw new BenefitsError(
      "REFUSED",
      `benefit plan carries an unknown ${side} cost basis — re-save the plan through Company setup with per_period, per_month, per_year, or percent_of_pay`,
    );
  };
  const proration = row.prorationBasis;
  if (proration !== "full_month" && proration !== "daily") {
    throw new BenefitsError(
      "REFUSED",
      "benefit plan carries no usable proration basis — re-save the plan through Company setup declaring full_month or daily; a partial month is never guessed",
    );
  }
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    kind: String(row.kind),
    providerPartyId: row.providerPartyId != null ? String(row.providerPartyId) : null,
    employerSubsidiaryId: row.employerSubsidiaryId != null ? String(row.employerSubsidiaryId) : null,
    currency: String(row.currency),
    employeeCostBasis: basis(row.employeeCostBasis, "employee"),
    employeeCost: row.employeeCost != null ? String(row.employeeCost) : null,
    employerCostBasis: basis(row.employerCostBasis, "employer"),
    employerCost: row.employerCost != null ? String(row.employerCost) : null,
    employeePayComponentId:
      row.employeePayComponentId != null ? String(row.employeePayComponentId) : null,
    employerPayComponentId:
      row.employerPayComponentId != null ? String(row.employerPayComponentId) : null,
    pretax: row.pretax === true,
    prorationBasis: proration,
    waitingPeriodDays: Number(row.waitingPeriodDays ?? 0),
    requiresApproval: row.requiresApproval === true,
    isActive: row.isActive === true,
    effectiveFrom: String(row.effectiveFrom).slice(0, 10),
    effectiveTo: row.effectiveTo != null ? String(row.effectiveTo).slice(0, 10) : null,
  };
}

/** Load a plan by id. Unknown ids refuse uniformly — never null. */
export async function loadBenefitPlan(
  exec: SqlExecutor,
  orgId: string,
  planId: string,
): Promise<BenefitPlanRow> {
  const row = (
    await exec.execute<Record<string, unknown>>(sql`
      select ${PLAN_COLUMNS} from hrm_benefit_plans
       where org_id = ${orgId} and id = ${planId}
    `)
  ).rows[0];
  if (!row) {
    throw new BenefitsError(
      "NOT_FOUND",
      "benefit plan not found in this organization — reload the plan list and retry",
    );
  }
  return toPlanRow(row);
}

/** Tiers in drawer order. Empty = the plan prices its base costs. */
export async function loadBenefitPlanLevels(
  exec: SqlExecutor,
  orgId: string,
  planId: string,
): Promise<BenefitPlanLevelRow[]> {
  const rows = (
    await exec.execute<Record<string, unknown>>(sql`
      select id, level_key as "levelKey", label,
             employee_cost::text as "employeeCost",
             employer_cost::text as "employerCost", position
        from hrm_benefit_plan_levels
       where org_id = ${orgId} and plan_id = ${planId}
       order by position
    `)
  ).rows;
  return rows.map((row) => ({
    id: String(row.id),
    levelKey: String(row.levelKey),
    label: String(row.label),
    employeeCost: String(row.employeeCost),
    employerCost: String(row.employerCost),
    position: Number(row.position),
  }));
}

export interface ResolvedElectionCosts {
  readonly employeeAmountPerPeriod: string | null;
  readonly employerAmountPerPeriod: string | null;
}

/**
 * Resolve an election's stored per-period figures from the plan basis and
 * tier. Tier amounts are COPIED here at elect time — a later repricing
 * never rewrites the election. Canonical 4dp strings, never floats.
 */
export function resolveElectionCosts(
  plan: BenefitPlanRow,
  levels: readonly BenefitPlanLevelRow[],
  coverageLevelKey: string | null,
): ResolvedElectionCosts {
  const canonical = (value: string | null, label: string): string | null => {
    if (value === null) return null;
    try {
      return normalizeMoney(value);
    } catch {
      throw new BenefitsError(
        "REFUSED",
        `${label} ${JSON.stringify(value)} is not an exact decimal amount — re-save the plan through Company setup with plain digits`,
      );
    }
  };
  if (levels.length === 0) {
    if (coverageLevelKey !== null) {
      throw new BenefitsError(
        "REFUSED",
        `plan ${plan.code} prices no coverage tiers — elect without a coverage level instead of naming ${JSON.stringify(coverageLevelKey)}`,
      );
    }
    return {
      employeeAmountPerPeriod: canonical(plan.employeeCost, `plan ${plan.code} employee cost`),
      employerAmountPerPeriod: canonical(plan.employerCost, `plan ${plan.code} employer cost`),
    };
  }
  if (coverageLevelKey === null) {
    const keys = levels.map((level) => level.levelKey).join(", ");
    throw new BenefitsError(
      "REFUSED",
      `plan ${plan.code} prices tiers (${keys}) — name the coverage level instead of electing the base costs`,
    );
  }
  const tier = levels.find((level) => level.levelKey === coverageLevelKey);
  if (!tier) {
    throw new BenefitsError(
      "REFUSED",
      `coverage level ${JSON.stringify(coverageLevelKey)} is not a tier of plan ${plan.code} — elect one of ${levels.map((level) => level.levelKey).join(", ")}`,
    );
  }
  return {
    employeeAmountPerPeriod: canonical(tier.employeeCost, `tier ${tier.levelKey} employee cost`),
    employerAmountPerPeriod: canonical(tier.employerCost, `tier ${tier.levelKey} employer cost`),
  };
}

function hasPositive(value: string | null): boolean {
  if (value === null) return false;
  try {
    return normalizeMoney(value) !== normalizeMoney("0");
  } catch {
    return true;
  }
}

export interface PlanComponentNeed {
  readonly needsEmployeeComponent: boolean;
  readonly needsEmployerComponent: boolean;
}

/** Which sides of a plan can produce a payroll input row. */
export function planComponentNeed(
  plan: BenefitPlanRow,
  levels: readonly BenefitPlanLevelRow[],
): PlanComponentNeed {
  const employeeCosts = [plan.employeeCost, ...levels.map((level) => level.employeeCost)];
  const employerCosts = [plan.employerCost, ...levels.map((level) => level.employerCost)];
  return {
    needsEmployeeComponent: employeeCosts.some(hasPositive),
    needsEmployerComponent: employerCosts.some(hasPositive),
  };
}

/**
 * The coordinator-ruled component validation, run on plan save AND on input
 * generation. A side with a positive cost and no component is refused by
 * name; the employer component must be declared kind employer_contribution
 * (so employer money can never reach net pay); the employee component must
 * be kind deduction (so an earning component can never inflate net pay).
 * Components must be active and in the same org — the tenant FK proves the
 * org, this proves the kind and the active flag.
 */
export async function validateBenefitPlanComponents(
  exec: SqlExecutor,
  orgId: string,
  plan: BenefitPlanRow,
  levels: readonly BenefitPlanLevelRow[],
): Promise<void> {
  const need = planComponentNeed(plan, levels);
  const checked = async (
    componentId: string | null,
    needed: boolean,
    side: "employee" | "employer",
    requiredKind: "deduction" | "employer_contribution",
  ): Promise<void> => {
    if (!needed) return;
    if (componentId === null) {
      throw new BenefitsError(
        "REFUSED",
        `plan ${plan.code} prices a ${side} cost but names no ${side} pay component — link the component in Company setup before electing; an amount without its component cannot tell the run its tax treatment`,
      );
    }
    const row = (
      await exec.execute<{ kind: string; isActive: boolean }>(sql`
        select kind, is_active as "isActive" from pay_components
         where org_id = ${orgId} and id = ${componentId}
      `)
    ).rows[0];
    if (!row) {
      throw new BenefitsError(
        "REFUSED",
        `plan ${plan.code} names a ${side} pay component outside this organization — link a component of this org in Company setup`,
      );
    }
    if (!row.isActive) {
      throw new BenefitsError(
        "REFUSED",
        `plan ${plan.code} names an inactive ${side} pay component — reactivate the component or link its replacement in Company setup`,
      );
    }
    if (row.kind !== requiredKind) {
      throw new BenefitsError(
        "REFUSED",
        side === "employer"
          ? `plan ${plan.code} names an employer component of kind ${row.kind} — the employer component must be kind employer_contribution so employer money can never reach net pay; relink it in Company setup`
          : `plan ${plan.code} names an employee component of kind ${row.kind} — the employee component must be kind deduction so a contribution can never inflate net pay; relink it in Company setup`,
      );
    }
  };
  await checked(plan.employeePayComponentId, need.needsEmployeeComponent, "employee", "deduction");
  await checked(
    plan.employerPayComponentId,
    need.needsEmployerComponent,
    "employer",
    "employer_contribution",
  );
}

