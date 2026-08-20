import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { isZero, neg, normalizeMoney } from "./money.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MEASURES = new Set([
  "actual_cost",
  "invoiced_to_date",
  "billable_value",
  "total_price",
  "could_be_invoiced",
  "gross_profit",
]);

export type AdjustableProjectFinancialMeasure =
  | "actual_cost"
  | "invoiced_to_date"
  | "billable_value"
  | "total_price"
  | "could_be_invoiced"
  | "gross_profit";

export interface RecordProjectFinancialAdjustmentInput {
  orgId: string;
  projectId: string;
  adjustmentDate: string;
  measure: AdjustableProjectFinancialMeasure;
  amount: string;
  reason: string;
  sourceSystem?: string | null;
  sourceRef?: string | null;
  evidence?: Record<string, unknown>;
  actorId?: string | null;
  reversesAdjustmentId?: string | null;
}

export interface ProjectFinancialAdjustmentRecord {
  id: string;
  measure: AdjustableProjectFinancialMeasure;
  amount: string;
  existing: boolean;
}

/**
 * Append controller-evidenced statistical project-financial evidence.
 *
 * Stable source identity makes cutover/import operators idempotent. Conflicting
 * reuse fails closed; corrections are exact, separately audited reversal rows.
 */
export async function recordProjectFinancialAdjustment(
  input: RecordProjectFinancialAdjustmentInput,
): Promise<ProjectFinancialAdjustmentRecord> {
  if (!DATE.test(input.adjustmentDate)) {
    throw new Error("adjustmentDate must be YYYY-MM-DD");
  }
  if (!MEASURES.has(input.measure)) {
    throw new Error("unsupported project financial adjustment measure");
  }
  const amount = normalizeMoney(input.amount);
  if (isZero(amount)) {
    throw new Error("project financial adjustment cannot be zero");
  }
  const reason = input.reason.trim();
  if (reason.length < 8 || reason.length > 500) {
    throw new Error(
      "project financial adjustment reason must be 8-500 characters",
    );
  }
  const sourceSystem = input.sourceSystem?.trim() || null;
  const sourceRef = input.sourceRef?.trim() || null;
  if ((sourceSystem === null) !== (sourceRef === null)) {
    throw new Error(
      "sourceSystem and sourceRef must either both be provided or both be absent",
    );
  }
  const evidence = input.evidence ?? {};
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error("project financial adjustment evidence must be an object");
  }

  return db.transaction(async (tx) => {
    if (sourceSystem && sourceRef) {
      const prior = (await tx.execute<{
          id: string;
          project_id: string;
          adjustment_date: string;
          measure: AdjustableProjectFinancialMeasure;
          amount: string;
          reason: string;
          reverses_adjustment_id: string | null;
          evidence_matches: boolean;
        }>(sql`
        select id, project_id, adjustment_date::text as adjustment_date,
               measure, amount::text, reason, reverses_adjustment_id,
               evidence = ${JSON.stringify(evidence)}::jsonb as evidence_matches
          from project_financial_adjustments
         where org_id = ${input.orgId}
           and source_system = ${sourceSystem}
           and source_ref = ${sourceRef}
         for update
      `));
      const existing = prior.rows[0];
      if (existing) {
        const equivalent =
          existing.project_id === input.projectId &&
          existing.adjustment_date === input.adjustmentDate &&
          existing.measure === input.measure &&
          normalizeMoney(existing.amount) === amount &&
          existing.reason === reason &&
          existing.reverses_adjustment_id ===
            (input.reversesAdjustmentId ?? null) &&
          existing.evidence_matches;
        if (!equivalent) {
          throw new Error(
            `project financial adjustment source identity ${sourceSystem}/${sourceRef} already has different evidence`,
          );
        }
        return {
          id: existing.id,
          measure: existing.measure,
          amount,
          existing: true,
        };
      }
    }

    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into project_financial_adjustments (
        org_id, project_id, adjustment_date, measure, amount, reason,
        source_system, source_ref, reverses_adjustment_id, evidence,
        created_by, updated_by
      )
      values (
        ${input.orgId}, ${input.projectId}, ${input.adjustmentDate},
        ${input.measure}, ${amount}, ${reason}, ${sourceSystem}, ${sourceRef},
        ${input.reversesAdjustmentId ?? null}, ${JSON.stringify(evidence)}::jsonb,
        ${input.actorId ?? null}, ${input.actorId ?? null}
      )
      returning id
    `));
    const id = inserted.rows[0]!.id;
    await tx.execute(sql`
      insert into audit_log (
        org_id, table_name, row_id, action, changes, actor_id
      )
      values (
        ${input.orgId}, 'project_financial_adjustments', ${id}, 'insert',
        ${JSON.stringify({
          after: {
            projectId: input.projectId,
            adjustmentDate: input.adjustmentDate,
            measure: input.measure,
            amount,
            reason,
            sourceSystem,
            sourceRef,
            reversesAdjustmentId: input.reversesAdjustmentId ?? null,
            evidence,
          },
        })}::jsonb,
        ${input.actorId ?? null}
      )
    `);
    return { id, measure: input.measure, amount, existing: false };
  });
}

export async function reverseProjectFinancialAdjustment(input: {
  orgId: string;
  adjustmentId: string;
  adjustmentDate: string;
  reason: string;
  actorId?: string | null;
  sourceSystem?: string | null;
  sourceRef?: string | null;
}): Promise<ProjectFinancialAdjustmentRecord> {
  const original = (await db.execute<{
      project_id: string;
      measure: AdjustableProjectFinancialMeasure;
      amount: string;
      evidence: Record<string, unknown>;
    }>(sql`
    select project_id, measure, amount::text, evidence
      from project_financial_adjustments
     where org_id = ${input.orgId} and id = ${input.adjustmentId}
  `));
  const row = original.rows[0];
  if (!row) throw new Error("project financial adjustment not found");
  return recordProjectFinancialAdjustment({
    orgId: input.orgId,
    projectId: row.project_id,
    adjustmentDate: input.adjustmentDate,
    measure: row.measure,
    amount: neg(row.amount),
    reason: input.reason,
    actorId: input.actorId,
    sourceSystem: input.sourceSystem,
    sourceRef: input.sourceRef,
    reversesAdjustmentId: input.adjustmentId,
    evidence: {
      reversalOf: input.adjustmentId,
      originalEvidence: row.evidence,
    },
  });
}
