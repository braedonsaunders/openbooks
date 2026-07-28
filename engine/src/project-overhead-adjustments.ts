import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { isZero, neg, normalizeMoney } from "./money.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface RecordProjectOverheadAdjustmentInput {
  orgId: string;
  projectId: string;
  adjustmentDate: string;
  amount: string;
  reason: string;
  sourceSystem?: string | null;
  sourceRef?: string | null;
  evidence?: Record<string, unknown>;
  actorId?: string | null;
  reversesAdjustmentId?: string | null;
}

export interface ProjectOverheadAdjustmentRecord {
  id: string;
  amount: string;
  existing: boolean;
}

/**
 * Append one controller-evidenced statistical-overhead adjustment.
 *
 * A stable source identity makes import/cutover operators idempotent. A
 * repeated source identity must be byte-for-byte financially equivalent or it
 * fails closed; corrections are separate reversing rows.
 */
export async function recordProjectOverheadAdjustment(
  input: RecordProjectOverheadAdjustmentInput,
): Promise<ProjectOverheadAdjustmentRecord> {
  if (!DATE.test(input.adjustmentDate)) {
    throw new Error("adjustmentDate must be YYYY-MM-DD");
  }
  const amount = normalizeMoney(input.amount);
  if (isZero(amount)) throw new Error("overhead adjustment cannot be zero");
  const reason = input.reason.trim();
  if (reason.length < 8 || reason.length > 500) {
    throw new Error("overhead adjustment reason must be 8-500 characters");
  }
  const sourceSystem = input.sourceSystem?.trim() || null;
  const sourceRef = input.sourceRef?.trim() || null;
  if ((sourceSystem === null) !== (sourceRef === null)) {
    throw new Error(
      "sourceSystem and sourceRef must either both be provided or both be absent",
    );
  }
  const evidence = input.evidence ?? {};
  if (
    !evidence ||
    typeof evidence !== "object" ||
    Array.isArray(evidence)
  ) {
    throw new Error("overhead adjustment evidence must be an object");
  }

  return db.transaction(async (tx) => {
    if (sourceSystem && sourceRef) {
      const prior = (await tx.execute(sql`
        select id, project_id, adjustment_date::text as adjustment_date,
               amount::text, reason, reverses_adjustment_id,
               evidence = ${JSON.stringify(evidence)}::jsonb as evidence_matches
          from project_overhead_adjustments
         where org_id = ${input.orgId}
           and source_system = ${sourceSystem}
           and source_ref = ${sourceRef}
         for update
      `)) as unknown as {
        rows: {
          id: string;
          project_id: string;
          adjustment_date: string;
          amount: string;
          reason: string;
          reverses_adjustment_id: string | null;
          evidence_matches: boolean;
        }[];
      };
      const existing = prior.rows[0];
      if (existing) {
        const equivalent =
          existing.project_id === input.projectId &&
          existing.adjustment_date === input.adjustmentDate &&
          normalizeMoney(existing.amount) === amount &&
          existing.reason === reason &&
          existing.reverses_adjustment_id ===
            (input.reversesAdjustmentId ?? null) &&
          existing.evidence_matches;
        if (!equivalent) {
          throw new Error(
            `overhead adjustment source identity ${sourceSystem}/${sourceRef} already has different evidence`,
          );
        }
        return { id: existing.id, amount, existing: true };
      }
    }

    const inserted = (await tx.execute(sql`
      insert into project_overhead_adjustments (
        org_id, project_id, adjustment_date, amount, reason,
        source_system, source_ref, reverses_adjustment_id, evidence,
        created_by, updated_by
      )
      values (
        ${input.orgId}, ${input.projectId}, ${input.adjustmentDate}, ${amount},
        ${reason}, ${sourceSystem}, ${sourceRef},
        ${input.reversesAdjustmentId ?? null}, ${JSON.stringify(evidence)}::jsonb,
        ${input.actorId ?? null}, ${input.actorId ?? null}
      )
      returning id
    `)) as unknown as { rows: { id: string }[] };
    const id = inserted.rows[0]!.id;
    await tx.execute(sql`
      insert into audit_log (
        org_id, table_name, row_id, action, changes, actor_id
      )
      values (
        ${input.orgId}, 'project_overhead_adjustments', ${id}, 'insert',
        ${JSON.stringify({
          after: {
            projectId: input.projectId,
            adjustmentDate: input.adjustmentDate,
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
    return { id, amount, existing: false };
  });
}

export async function reverseProjectOverheadAdjustment(input: {
  orgId: string;
  adjustmentId: string;
  adjustmentDate: string;
  reason: string;
  actorId?: string | null;
  sourceSystem?: string | null;
  sourceRef?: string | null;
}): Promise<ProjectOverheadAdjustmentRecord> {
  const original = (await db.execute(sql`
    select project_id, amount::text, evidence
      from project_overhead_adjustments
     where org_id = ${input.orgId} and id = ${input.adjustmentId}
  `)) as unknown as {
    rows: {
      project_id: string;
      amount: string;
      evidence: Record<string, unknown>;
    }[];
  };
  const row = original.rows[0];
  if (!row) throw new Error("overhead adjustment not found");
  return recordProjectOverheadAdjustment({
    orgId: input.orgId,
    projectId: row.project_id,
    adjustmentDate: input.adjustmentDate,
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
