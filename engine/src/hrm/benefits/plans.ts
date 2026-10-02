import { sql } from "drizzle-orm";
import type { SqlExecutor } from "./shared.ts";
import { BenefitsError } from "./errors.ts";

/** Plan identity and admission dates. Contribution rules own all recurring pricing. */

export interface BenefitPlanRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly providerPartyId: string | null;
  readonly employerSubsidiaryId: string | null;
  readonly currency: string;
  readonly waitingPeriodDays: number;
  readonly waitingPeriodMonths?: number;
  readonly approvalMode: "none" | "flows";
  readonly isActive: boolean;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

const PLAN_COLUMNS = sql`id, code, name, kind,
  provider_party_id as "providerPartyId",
  employer_subsidiary_id as "employerSubsidiaryId",
  currency,
  waiting_period_days as "waitingPeriodDays", waiting_period_months as "waitingPeriodMonths",
  approval_mode as "approvalMode",
  is_active as "isActive",
  effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo"`;

function toPlanRow(row: Record<string, unknown>): BenefitPlanRow {
  if (row.approvalMode !== 'none' && row.approvalMode !== 'flows') throw new BenefitsError('REFUSED','This plan has an unknown approval setting — choose no approvals or native Flows in its setup');
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    kind: String(row.kind),
    providerPartyId: row.providerPartyId != null ? String(row.providerPartyId) : null,
    employerSubsidiaryId: row.employerSubsidiaryId != null ? String(row.employerSubsidiaryId) : null,
    currency: String(row.currency),
    waitingPeriodDays: Number(row.waitingPeriodDays ?? 0),
    waitingPeriodMonths: Number(row.waitingPeriodMonths ?? 0),
    approvalMode: row.approvalMode === "flows" ? "flows" : "none",
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

