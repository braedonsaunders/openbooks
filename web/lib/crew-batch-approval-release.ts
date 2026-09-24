import 'server-only'
import { approveBatchStage, rejectBatch } from '@openbooks/engine/src/hrm/field-time/crew.ts'
import { actorAllowedSubsidiaryIds } from '@openbooks/engine/src/organization/actor-subsidiaries.ts'
import { db } from '@openbooks/engine/src/platform/db.ts'

/**
 * Apply a flow gate's decision to a crew time batch.
 *
 * Flows owns the routing — who approves, in what order, with what quorum. This
 * owns what approval MEANS for a batch: advancing the current stage through
 * the crew service (which stamps status, audit events, and the acting user),
 * or bouncing the batch back to the foreman with the approver's comment as
 * the reason they will read.
 *
 * Runs inside decideGate's transaction, so throwing rolls the gate decision
 * back with it.
 */
export async function releaseCrewTimeBatchApproval(
  orgId: string,
  actorId: string,
  subjectId: string,
  outcome: 'approved' | 'rejected',
  comment?: string | null,
): Promise<void> {
  // Flows' release context carries no subsidiary scope, so resolve the
  // approver's scope on the trusted runner (the same helper the HRM gates
  // use) and pass it explicitly — the crew service takes no omitted scope.
  const allowedSubsidiaryIds = await actorAllowedSubsidiaryIds(db, orgId, actorId)
  if (outcome === 'approved') {
    await approveBatchStage({
      orgId,
      actorUserId: actorId,
      batchId: subjectId,
      comment: comment ?? null,
      allowedSubsidiaryIds,
    })
    return
  }

  const reason = (comment ?? '').trim() || 'Rejected by approver'
  await rejectBatch({
    orgId,
    actorUserId: actorId,
    batchId: subjectId,
    reason,
    allowedSubsidiaryIds,
  })
}
