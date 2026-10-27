import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { canonicalJson } from "../platform/canonical-json.ts";
import {
  lockApprovalSubject,
  readNativeApprovalDecision,
  requestNativeCommandApproval,
} from "../platform/approval-routing.ts";
import { db, withOrgTransaction } from "../platform/db.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import {
  PspAutomationError,
  lockReturnReceiptAuthority,
  type AutomationContext,
} from "./psp-automation-context.ts";
import { withdrawReturnReceipts } from "./psp-return-stages.ts";
import {
  asDocIds,
  disputeRow,
  parkDisputeForReview,
  transitionDisputeRow,
  pendingActionOf,
  pendingEventOf,
  type PendingAction,
} from "./psp-automation-disputes.ts";

/** Native review of provider returns: the approval fingerprint, command authorization and reviewer authority shared by automatic delivery and operator resumption. */

const reviewedReturn = new AsyncLocalStorage<{
  orgId: string;
  id: string;
  action: PendingAction;
  fingerprint: string;
}>();

/** Run an approved review's accounting with its approval bound to this exact return state. */
export function withReviewedReturn<T>(
  approval: { orgId: string; id: string; action: PendingAction; fingerprint: string },
  run: () => Promise<T>,
): Promise<T> {
  return reviewedReturn.run(approval, run);
}

export async function reviewFingerprint(orgId: string, id: string): Promise<string> {
  const row = (
    await db.execute<{ fingerprint: string | null }>(
      sql`select public.provider_return_approval_fingerprint(${orgId},${id}) as fingerprint`,
      "objects",
    )
  )[0];
  if (!row?.fingerprint)
    throw new PspAutomationError(
      "The provider return is unavailable. Reload its native review before retrying.",
    );
  return row.fingerprint;
}
export async function approvedReturnCommand(
  orgId: string,
  id: string,
  action: PendingAction,
): Promise<boolean> {
  return (
    (
      await db.execute<{ approved: boolean }>(
        sql`select public.provider_return_command_approved(${orgId},${id},${action}) as approved`,
        "objects",
      )
    )[0]?.approved === true
  );
}

/** Automatic delivery and operator resumption submit the same native command.
 * Completed gates remain usable while subordinate receipt approvals finish. */
export async function reviewProviderReturn(
  orgId: string,
  id: string,
  ctx: AutomationContext,
  action: PendingAction,
  event: Record<string, unknown>,
): Promise<boolean> {
  await lockApprovalSubject(orgId, "payment_dispute_review", id);
  if (!ctx.receipt)
    throw new PspAutomationError(
      "The provider return has no original receipt. Review its payment history before retrying.",
    );
  const { actorId } = await lockReturnReceiptAuthority(orgId, {
    sourceReceiptId: ctx.receipt.id,
    subsidiaryId: ctx.link.subsidiary_id,
    partyId: ctx.link.party_id,
    currency: ctx.receipt.currency,
  });
  const approved = reviewedReturn.getStore();
  if (
    approved?.orgId === orgId &&
    approved.id === id &&
    approved.action === action &&
    approved.fingerprint === (await reviewFingerprint(orgId, id))
  )
    return false;
  const row = await disputeRow(orgId, id);
  if (
    row.status !== "pending_review" ||
    pendingActionOf(row.status_history) !== action ||
    canonicalJson(pendingEventOf(row.status_history)) !== canonicalJson(event)
  ) {
    await parkDisputeForReview(
      orgId,
      id,
      action,
      event,
      "Complete the configured provider return Flow gates before its accounting runs.",
    );
  }
  if (await approvedReturnCommand(orgId, id, action)) return false;
  return requestNativeCommandApproval({
    orgId,
    actorId,
    subjectKind: "payment_dispute_review",
    subjectId: id,
    command: { action },
  });
}

/** Lock in the same attempt → review → document order as provider delivery,
 * then recheck the acting user's live grants and every financial endpoint. */
export async function lockReviewAuthority(
  orgId: string,
  disputeId: string,
  actorId: string,
  requested: ReadonlySet<string> | null,
) {
  if (requested === undefined || !actorId) throw new ScopeNotFoundError();
  const allowed = await lockActorCommandAuthority(db, orgId, actorId, null, "banking.reconcile");
  const candidate = (
    await db.execute<{ attempt_id: string | null }>(
      sql`
    select attempt_id from payment_disputes where org_id = ${orgId} and id = ${disputeId}
  `,
      "objects",
    )
  )[0];
  if (!candidate) throw new ScopeNotFoundError();
  if (candidate.attempt_id)
    await db.execute(
      sql`select id from payment_attempts where org_id = ${orgId} and id = ${candidate.attempt_id} for update`,
    );
  const row = await disputeRow(orgId, disputeId);
  const ids = [
    ...new Set(
      [row.invoice_document_id, row.receipt_document_id].filter((id): id is string => id !== null),
    ),
  ];
  if (!ids.length) throw new ScopeNotFoundError();
  const subjects = await db.execute<{ id: string; subsidiary_id: string | null }>(
    sql`
    select d.id, coalesce(d.subsidiary_id, entry.subsidiary_id) as subsidiary_id from documents d
      left join journal_entries entry on entry.org_id = d.org_id and entry.id = d.posted_entry_id
     where d.org_id = ${orgId} and d.id in (${sql.join(
       ids.map((id) => sql`${id}`),
       sql`, `,
     )}) order by d.id for share of d
  `,
    "objects",
  );
  if (
    subjects.length !== ids.length ||
    subjects.some(
      (subject) =>
        !subject.subsidiary_id ||
        !subsidiaryScopeAllows(allowed, subject.subsidiary_id) ||
        !subsidiaryScopeAllows(requested, subject.subsidiary_id),
    )
  ) {
    throw new ScopeNotFoundError();
  }
  if (!(await orgFeatureEnabled(orgId, "banking"))) throw new ScopeNotFoundError();
  return row;
}

/** Provider redelivery cannot spend an operator command while its tenant gates are unresolved. */
export async function reviewHasPendingGates(orgId: string, id: string): Promise<boolean> {
  return (
    (
      await db.execute<{
        open: boolean;
      }>(
        sql`select exists(select 1 from flow_gates where org_id=${orgId}
  and subject_kind='payment_dispute_review' and subject_id=${id} and status in('pending','escalated')) as open`,
        "objects",
      )
    )[0]?.open === true
  );
}

/**
 * Reject a queued refund or dispute: no money moves. The provider's next
 * event for the same return creates its own record.
 */
export async function rejectDisputeReview(
  orgId: string,
  disputeId: string,
  actorId: string,
  reason: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  approvalRunId?: string,
): Promise<void> {
  const trimmed = reason.trim();
  if (trimmed.length < 5 || trimmed.length > 500) {
    throw new PspAutomationError("rejection reason must be between 5 and 500 characters");
  }
  return withOrgTransaction(orgId, async () => {
    await lockApprovalSubject(orgId, "payment_dispute_review", disputeId);
    const row = await lockReviewAuthority(orgId, disputeId, actorId, allowedSubsidiaryIds);
    if (row.status !== "pending_review") {
      throw new PspAutomationError(`review is ${row.status}; only a queued review can be rejected`);
    }
    const decision = await readNativeApprovalDecision({
      orgId,
      actorId,
      subjectKind: "payment_dispute_review",
      subjectId: disputeId,
      outcome: "rejected",
      approvalRunId,
    });
    const proof = (
      await db.execute<{ valid: boolean }>(
        sql`select public.flow_subject_decision_authorized(d.org_id,'payment_dispute_review',d.id,${actorId},public.provider_return_approval_fingerprint(d.org_id,d.id),'rejected') as valid from payment_disputes d where d.org_id=${orgId} and d.id=${disputeId}`,
        "objects",
      )
    )[0];
    if (!decision || !proof?.valid)
      throw new PspAutomationError(
        "Reject this provider return through its configured native Flow gate.",
      );
    await withdrawReturnReceipts(orgId, disputeId, actorId, trimmed);
    await transitionDisputeRow(
      orgId,
      disputeId,
      "rejected",
      asDocIds(row.documents_posted),
      trimmed,
    );
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'payment_disputes', ${disputeId}, 'reject',
              ${JSON.stringify({ after: { reason: trimmed } })}::jsonb, ${actorId})
    `);
  });
}
