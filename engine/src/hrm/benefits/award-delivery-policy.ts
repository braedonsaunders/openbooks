import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../../platform/db.ts";
import { isUuid } from "../../platform/uuid.ts";
import { actorAllowedSubsidiaryIds } from "../../organization/actor-subsidiaries.ts";
import { BenefitsError } from "./errors.ts";

export type AwardDeliveryPolicy = {
  code: string;
  payComponentId: string;
  legalEntityId: string;
  paymentDelayDays: number;
  deliveryMethod: "payroll" | "external";
};

/** Delivery follows the issuance's retained terms, including its original payroll source component. */
export function awardDeliveryPolicy(program: unknown, source: unknown): AwardDeliveryPolicy {
  if (
    !program ||
    typeof program !== "object" ||
    Array.isArray(program) ||
    !source ||
    typeof source !== "object" ||
    Array.isArray(source)
  )
    throw new BenefitsError(
      "REFUSED",
      "This award has no complete retained delivery policy — preserve its issuance and qualify the original policy before delivery",
    );
  const p = program as Record<string, unknown>,
    s = source as Record<string, unknown>;
  if (
    typeof p.code !== "string" ||
    !p.code.trim() ||
    !isUuid(p.legalEntityId) ||
    !isUuid(s.payComponentId) ||
    typeof p.paymentDelayDays !== "number" ||
    !Number.isSafeInteger(p.paymentDelayDays) ||
    p.paymentDelayDays < 0 ||
    (p.deliveryMethod !== "payroll" && p.deliveryMethod !== "external")
  )
    throw new BenefitsError(
      "REFUSED",
      "This award is missing original delivery terms — preserve its issuance and qualify the original component, entity, method and payment delay",
    );
  return {
    code: p.code,
    payComponentId: s.payComponentId,
    legalEntityId: p.legalEntityId,
    paymentDelayDays: p.paymentDelayDays,
    deliveryMethod: p.deliveryMethod,
  };
}

/** Callers hold the award/run locks; authorization applies to the retained issuance entity. */
export async function readAwardDeliveryPolicy(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  awardId: string,
): Promise<AwardDeliveryPolicy> {
  const rows = await exec.execute<{ program: unknown; source: unknown }>(
    sql`select program_snapshot as program,source_snapshot as source
    from hrm_benefit_awards where org_id=${orgId} and id=${awardId}`,
    "objects",
  );
  if (rows.length !== 1)
    throw new BenefitsError("NOT_FOUND", "Benefit award is unavailable in this organization");
  const policy = awardDeliveryPolicy(rows[0]!.program, rows[0]!.source);
  const scope = await actorAllowedSubsidiaryIds(exec, orgId, actorId);
  if (scope !== null && !scope.has(policy.legalEntityId))
    throw new BenefitsError("NOT_FOUND", "Benefit award is unavailable in your legal-entity scope");
  return policy;
}
