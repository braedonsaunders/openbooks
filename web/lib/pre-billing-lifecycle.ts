import { routeSubjectSubmission } from "@openbooks/engine/flows/submission-policy";
import { completedGateDecisionPolicy } from "@openbooks/engine/flows/approval-decision-policy";
import { lockActorCommandAuthority } from "@openbooks/engine/organization/actor-command-authority";
import { lockApprovalSubject } from "@openbooks/engine/platform/approval-routing";
import "server-only";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { PREBILL_SUBJECT_KIND } from "@openbooks/engine/flows";
import { cmp } from "@openbooks/engine/money/money";
import { lockProjectForScope, ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { subsidiaryVisibleFilter } from "./subsidiaries";
import {
  PreBillingError,
  type PrebillStatus,
  type SubsidiaryScope,
  type Tx,
  appendEvent,
  assertPreBillingEnabledTx,
  audit,
  currentPolicyIsNte,
  loadProjectPolicy,
  remainingContractCapacity,
} from "./pre-billing-core";

type LockedPrebillHeader = {
  status: PrebillStatus;
  submitted_by: string | null;
  created_by: string | null;
  project_id: string;
  period_end: string;
  custom: { policy?: { totalPriceMethod?: string; customerReview?: string } };
};

/**
 * Lock a worksheet and its project for a lifecycle change, rechecking the
 * caller's subsidiary scope under the project lock: the worksheet lock alone
 * does not stop a concurrent A→B rehome from moving the change onto B.
 */
export async function lockPrebillForLifecycle(
  tx: Tx,
  orgId: string,
  id: string,
  scope: SubsidiaryScope,
): Promise<LockedPrebillHeader> {
  const header = (
    await tx.execute<LockedPrebillHeader>(
      sql`
    select worksheet.status, worksheet.submitted_by, worksheet.created_by, worksheet.project_id,
           worksheet.period_end::text as period_end, worksheet.custom
      from prebills worksheet
      join projects project on project.org_id = worksheet.org_id and project.id = worksheet.project_id
     where worksheet.org_id = ${orgId} and worksheet.id = ${id}
       ${subsidiaryVisibleFilter(sql`project.subsidiary_id`, scope)}
     for update of worksheet
  `,
      "objects",
    )
  )[0];
  if (!header) throw new PreBillingError("Prebill not found", 404);
  try {
    await lockProjectForScope(tx, orgId, header.project_id, scope);
  } catch (error) {
    if (error instanceof ScopeNotFoundError) throw new PreBillingError("Prebill not found", 404);
    throw error;
  }
  return header;
}

/**
 * The commercial invariants a worksheet must hold to be submitted or
 * approved: at least one line to bill, every write-up and write-down
 * supported by a reason and evidence, and — under a not-to-exceed policy —
 * a total inside the remaining contract capacity.
 */
async function assertPrebillApprovable(
  tx: Tx,
  orgId: string,
  id: string,
  header: LockedPrebillHeader,
  scope: SubsidiaryScope,
): Promise<void> {
  const current = (
    await tx.execute<{
      bill_lines: number;
      proposed_total: string;
      unsupported_adjustments: number;
    }>(
      sql`
    select count(*) filter (where disposition = 'bill')::int as bill_lines,
           coalesce(sum(proposed_bill_amount) filter (where disposition = 'bill'), 0)::text as proposed_total,
           count(*) filter (
             where disposition = 'bill'
               and proposed_bill_amount <> original_bill_amount
               and (nullif(trim(adjustment_reason), '') is null
                 or jsonb_array_length(adjustment_evidence) = 0)
           )::int as unsupported_adjustments
      from prebill_lines
     where org_id = ${orgId} and prebill_id = ${id}
  `,
      "objects",
    )
  )[0]!;
  if (current.bill_lines === 0)
    throw new PreBillingError("A prebill must contain at least one billable line");
  if (current.unsupported_adjustments > 0) {
    throw new PreBillingError("Every write-up and write-down requires a reason and evidence");
  }
  if (
    header.custom?.policy?.totalPriceMethod === "not_to_exceed" ||
    (await currentPolicyIsNte(tx, orgId, header.project_id, header.period_end))
  ) {
    const policy = await loadProjectPolicy(tx, orgId, header.project_id, true, scope);
    const capacity = await remainingContractCapacity(tx, orgId, policy, header.period_end, id);
    if (capacity != null && cmp(current.proposed_total, capacity) > 0) {
      throw new PreBillingError(
        `Prebill exceeds the remaining not-to-exceed capacity of ${capacity}`,
      );
    }
  }
}

async function openApprovalGateCount(tx: Tx, orgId: string, id: string): Promise<number> {
  return (
    (
      await tx.execute<{ n: number }>(
        sql`
    select count(*)::int as n from flow_gates
     where org_id = ${orgId} and subject_kind = ${PREBILL_SUBJECT_KIND}
       and subject_id = ${id} and status in ('pending', 'escalated')
  `,
        "objects",
      )
    )[0]?.n ?? 0
  );
}

/** Clear any earlier customer decision so a new review starts clean. */
const CLEAR_CUSTOMER_DECISION = sql`
  customer_review_sent_at = null, customer_review_sent_by = null, customer_review_digest = null,
  customer_decision = null, customer_decided_at = null, customer_signer_name = null,
  customer_decision_note = null`;

/**
 * Submit a draft through Flows. An enabled tenant-authored on_submit flow may
 * raise approval gates, which park the worksheet in review until they
 * resolve; when none does, the worksheet approves immediately. There is no
 * default approver and no approval path outside Flows.
 */
async function submitPrebill(orgId: string, actorId: string, id: string, scope: SubsidiaryScope) {
  const outcome = await withOrgTransaction(orgId, async () =>
    db.transaction(async (tx) => {
      await assertPreBillingEnabledTx(tx, orgId);
      const header = await lockPrebillForLifecycle(tx, orgId, id, scope);
      if (header.status !== "draft")
        throw new PreBillingError(`Cannot submit a ${header.status} prebill`);
      await assertPrebillApprovable(tx, orgId, id, header, scope);
      await tx.execute(sql`
      update prebills
         set status = 'review', submitted_at = now(), submitted_by = ${actorId},
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${id}
    `);
      await appendEvent(tx, orgId, id, actorId, "submitted");
      await audit(tx, orgId, "prebills", id, actorId, {
        before: { status: "draft" },
        after: { status: "review" },
      });

      const routed = (
        await routeSubjectSubmission({
          orgId,
          actorId,
          subjectKind: PREBILL_SUBJECT_KIND,
          subjectId: id,
          source: "ui",
        })
      ).dispatch;
      if (routed.failed) {
        // Keep the failed run (retryable once its flow is fixed) and the
        // worksheet in draft: a submission whose approval routing failed must
        // never be treated as "no approval required".
        await tx.execute(sql`
        update prebills set status = 'draft', updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and id = ${id}
      `);
        await appendEvent(tx, orgId, id, actorId, "submit_failed", {
          reason: routed.error,
        });
        return {
          status: "draft" as PrebillStatus,
          flowError: routed.error ?? "The approval workflow could not run",
        };
      }
      if (routed.gatesCreated > 0) return { status: "review" as PrebillStatus, flowError: null };
      await approvePrebillInTx(tx, orgId, actorId, id, "submit_without_approval_flow", scope);
      return { status: "approved" as PrebillStatus, flowError: null };
    }),
  );
  if (outcome.flowError) {
    throw new PreBillingError(
      `${outcome.flowError} — fix or disable the approval flow in Flows, then submit again`,
    );
  }
  return { id, status: outcome.status };
}

async function approvePrebillInTx(
  tx: Tx,
  orgId: string,
  actorId: string,
  id: string,
  source: "flows" | "submit_without_approval_flow",
  scope: SubsidiaryScope,
) {
  const header = await lockPrebillForLifecycle(tx, orgId, id, scope);
  if (header.status === "approved") return;
  if (header.status !== "review")
    throw new PreBillingError(`Cannot approve a ${header.status} prebill`);
  await assertPrebillApprovable(tx, orgId, id, header, scope);
  const updated = await tx.execute<never>(sql`
    update prebills
       set status = 'approved', approved_at = now(), approved_by = ${actorId},
           updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and id = ${id} and status = 'review'
  `);
  if ((updated.rowCount ?? 0) !== 1)
    throw new PreBillingError("The prebill changed while approving; reload and try again", 409);
  await appendEvent(tx, orgId, id, actorId, "approved", { source });
  await audit(tx, orgId, "prebills", id, actorId, {
    before: { status: "review" },
    after: { status: "approved" },
    source,
  });
}

/**
 * Deterministic approval release, called by Flows when every gate on the
 * worksheet has resolved. Runs inside the gate decision's transaction, so the
 * worksheet's status and the gate decision commit or roll back together.
 * Approval rechecks the worksheet's commercial invariants; rejection returns
 * it to draft with the approver's reason.
 */
export async function releasePrebillApproval(
  orgId: string,
  actorId: string,
  id: string,
  outcome: "approved" | "rejected",
  comment?: string | null,
  approvalRunId?: string,
) {
  return withOrgTransaction(orgId, () =>
    db.transaction(async (tx) => {
      await lockApprovalSubject(orgId, PREBILL_SUBJECT_KIND, id);
      await assertPreBillingEnabledTx(tx, orgId);
      const scope = await lockActorCommandAuthority(tx, orgId, actorId, null, "ar.approve");
      await lockPrebillForLifecycle(tx, orgId, id, scope);
      if (
        !(await completedGateDecisionPolicy(tx, {
          orgId,
          actorId,
          subjectKind: PREBILL_SUBJECT_KIND,
          subjectId: id,
          outcome,
          approvalRunId,
        }))
      )
        throw new PreBillingError(
          "Complete the current worksheet’s configured native Flow gates before release",
          409,
        );
      if (outcome === "approved") {
        await approvePrebillInTx(tx, orgId, actorId, id, "flows", scope);
        return;
      }
      const header = await lockPrebillForLifecycle(tx, orgId, id, scope);
      if (header.status !== "review")
        throw new PreBillingError(`Cannot return a ${header.status} prebill`);
      const reason = comment?.trim() || "Returned in approval flow";
      const returned = await tx.execute<Record<string, unknown>>(sql`
      update prebills set status = 'draft', updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${id} and status='review' returning id
    `);
      if (returned.rowCount !== 1)
        throw new PreBillingError(
          "The worksheet changed during its Flow decision. Reload it before retrying.",
          409,
        );
      await appendEvent(tx, orgId, id, actorId, "returned", {
        source: "flows",
        reason,
      });
      await audit(tx, orgId, "prebills", id, actorId, {
        before: { status: "review" },
        after: { status: "draft" },
        reason,
      });
    }),
  );
}

export async function transitionPrebill(
  orgId: string,
  actorId: string,
  id: string,
  action: "submit" | "reopen" | "void",
  reason?: string,
  scope: SubsidiaryScope = null,
) {
  if (action === "submit") return submitPrebill(orgId, actorId, id, scope);
  if (!reason?.trim()) throw new PreBillingError("A reason is required");
  const cleanReason = reason.trim();
  return db.transaction(async (tx) => {
    await assertPreBillingEnabledTx(tx, orgId);
    const header = await lockPrebillForLifecycle(tx, orgId, id, scope);
    if (header.status === "review" && (await openApprovalGateCount(tx, orgId, id)) > 0) {
      throw new PreBillingError(
        "This prebill is awaiting approval in Inbox — reject it there to return it to draft",
      );
    }
    if (action === "reopen") {
      // Reopening discards approval and any customer decision: the edited
      // worksheet goes through approval (and review, if used) again.
      if (!["review", "approved", "customer_review"].includes(header.status)) {
        throw new PreBillingError(`Cannot reopen a ${header.status} prebill`);
      }
      await tx.execute(sql`
        update prebills
           set status = 'draft', approved_at = null, approved_by = null, ${CLEAR_CUSTOMER_DECISION},
               updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and id = ${id}
      `);
      await appendEvent(tx, orgId, id, actorId, "reopened", {
        reason: cleanReason,
        from: header.status,
      });
      await audit(tx, orgId, "prebills", id, actorId, {
        before: { status: header.status },
        after: { status: "draft" },
        reason: cleanReason,
      });
      return { id, status: "draft" as PrebillStatus };
    }
    if (!["draft", "review", "approved", "customer_review"].includes(header.status)) {
      throw new PreBillingError(`Cannot void a ${header.status} prebill`);
    }
    await tx.execute(sql`
      update prebills
         set status = 'void', voided_at = now(), voided_by = ${actorId}, void_reason = ${cleanReason},
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${id}
    `);
    await appendEvent(tx, orgId, id, actorId, "voided", { reason: cleanReason });
    await audit(tx, orgId, "prebills", id, actorId, {
      before: { status: header.status },
      after: { status: "void" },
      reason: cleanReason,
    });
    return { id, status: "void" as PrebillStatus };
  });
}
