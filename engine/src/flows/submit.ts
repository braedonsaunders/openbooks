import { and, eq, sql } from "drizzle-orm";
import { db, schema, withOrgTransaction } from "../platform/db.ts";
import { resolveScriptUser, runTriggerScripts, type ScriptContext } from "../scripting/scripting.ts";
import { assertDocumentMutationRefsOwned } from "../records/mutation-refs.ts";
import { consolidationSourceRefusal } from "../records/consolidation-source-policy.ts";
import { assertExpenseEmployee, assertExpenseSettlement } from "../records/expense-validation.ts";
import { documentRevisionCounterSql, isDocumentRevisionToken } from "../records/revision.ts";
import { captureTransactionAuditSnapshot, recordTransactionAudit } from "../records/transaction-audit.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { cancelDispatchRuns, dispatchFailureReason, findGatingRun } from "./dispatch-result.ts";
import { runRecordFlows } from "./run.ts";
import { isVendorBillApprovalRequired, VENDOR_BILL_KIND } from "./vendor-bill-approval.ts";

/**
 * Submit a draft record for approval — the sole approval-routing entry point.
 *
 * Approvals are owned entirely by the Flows engine (engine/src/flows/): the
 * submit fires the `on_submit` event, which plans every enabled flow for the
 * record's kind. A flow that produces approval gates OWNS the submit — the
 * document goes `pending_approval` and its flow run id is returned.
 *
 * When no flow gates the record, `submitForApproval` reports `gated: false`
 * without changing lifecycle status. Standard transaction callers use
 * `submitAndReleaseIfUngated`, which treats that result as "no tenant approval
 * policy applies" and releases the record to approved. There is no fallback
 * approval engine or per-transaction approval policy — Flows is the only path.
 */
/**
 * A submission lifecycle refusal: the target is not in a submittable state
 * (already submitted, approved, or otherwise transitioned). Callers map this
 * to a 4xx — a double-clicked or replayed submit is request state, not a
 * server defect, and must never surface as a 500.
 */
export class SubmitError extends Error {
  readonly name = "SubmitError";
}

export interface SubmitResult {
  /** A flow produced approval gates; the document is now `pending_approval`. */
  gated: boolean;
  /** The gating flow run id (opaque handle for the caller), else null. */
  runId: string | null;
  /**
   * An on_submit flow matched but ERRORED (e.g. resolved to zero approvers).
   * The caller MUST fail closed — never auto-approve — when this is set. The
   * document is left in `draft`; the message names the failure.
   */
  flowError: string | null;
}

export interface SubmissionReleaseResult extends SubmitResult {
  /** No approval gate applied, so the engine released the record to approved. */
  autoApproved: boolean;
  /**
   * The org requires approval before vendor bills release and no flow gated
   * this bill, so the engine refused the release by name. The submit stamps
   * (submitted_by/at) stand — the bill stays submitted, never released — and
   * the caller must surface VENDOR_BILL_APPROVAL_REQUIRED_MESSAGE.
   */
  approvalRequired: boolean;
}

export async function submitForApproval(
  _targetKind: string,
  targetId: string,
  actorId?: string | null,
): Promise<SubmitResult> {
  // Resolve the tenant before opening the transaction. The transaction then
  // locks the document row and keeps that lock through flow planning, gate
  // creation, and the lifecycle update. A concurrent draft deletion therefore
  // either wins before this lock (submission finds no row) or waits until the
  // pending-approval status is committed and refuses the delete.
  const [candidate] = await db.select().from(schema.documents).where(eq(schema.documents.id, targetId));
  if (!candidate) throw new Error("target document not found");
  return withOrgTransaction(candidate.orgId, () => submitForApprovalLocked(targetId, actorId, candidate.orgId));
}

async function submitForApprovalLocked(
  targetId: string,
  actorId: string | null | undefined,
  orgId: string,
): Promise<SubmitResult> {
  const [doc] = await db
    .select()
    .from(schema.documents)
    .where(and(eq(schema.documents.id, targetId), eq(schema.documents.orgId, orgId)))
    .for("update");
  if (!doc) throw new Error("target document not found");
  if (doc.status !== "draft") throw new SubmitError(`document is ${doc.status}, not draft`);
  const consolidationRefusal = await consolidationSourceRefusal(db, orgId, targetId);
  if (consolidationRefusal) throw new SubmitError(consolidationRefusal);
  const blockedCorrection = (await db.execute<{ document_number: string }>(sql`
    select source.document_number
      from document_links link
      join documents source on source.id = link.to_document_id and source.org_id = link.org_id
     where link.from_document_id = ${targetId}
       and link.org_id = ${doc.orgId}
       and link.link_type = 'reverses'
       and source.status <> 'voided'
     limit 1
  `));
  if (blockedCorrection.rows[0]) {
    throw new SubmitError(
      `the correction cannot be submitted until ${blockedCorrection.rows[0].document_number}'s void is approved and completed`,
    );
  }

  // -- user scripts: before_submit (veto / mutate) ------------------------
  const [org] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, doc.orgId));
  if (org) {
    const lines = await db
      .select()
      .from(schema.documentLines)
      .where(and(eq(schema.documentLines.documentId, targetId), eq(schema.documentLines.orgId, doc.orgId)));
    const user = await resolveScriptUser(doc.orgId, actorId ?? null, { required: false });
    const scriptCtx: ScriptContext = {
      trigger: "before_submit",
      document: doc as unknown as Record<string, unknown>,
      lines: lines as unknown as Record<string, unknown>[],
      org: { id: org.id, name: org.name, baseCurrency: org.baseCurrency },
      ...(user ? { user } : {}),
    };
    const outcomes = await runTriggerScripts("before_submit", scriptCtx, doc.id);
    const bad = outcomes.find((o) => o.status !== "ok");
    if (bad) {
      throw new Error(
        bad.status === "aborted"
          ? `submission vetoed by script "${bad.name}": ${bad.abortReason}`
          : `script "${bad.name}" ${bad.status}: ${bad.abortReason ?? ""}`,
      );
    }
    const mutations = Object.assign({}, ...outcomes.map((o) => o.set ?? {}));
    if (Object.keys(mutations).length > 0) {
      // Script mutations write around applyDocumentEdit: prove shapes and org
      // ownership here, or a well-formed foreign id persists as a silent
      // cross-tenant pointer (custom jsonb has no constraint at all).
      await assertDocumentMutationRefsOwned(
        doc.orgId,
        doc.kind,
        Object.entries(mutations).map(([field, value]) => ({ field, value })),
      );
      await db.update(schema.documents).set(mutations).where(and(eq(schema.documents.id, doc.id), eq(schema.documents.orgId, doc.orgId)));
    }
  }

  // Scripts may change the draft; validate the persisted employee under the
  // submission row lock before approval routing can release this evidence.
  if (doc.kind === "expense_report") {
    const [effective] = await db.select().from(schema.documents)
      .where(and(eq(schema.documents.id, targetId), eq(schema.documents.orgId, orgId)));
    if (!effective) throw new Error("target document not found");
    await assertExpenseEmployee(db, effective);
    await assertExpenseSettlement(db, effective);
  }

  // -- flows: on_submit --------------------------------------------------
  // A flow that produced approval gates OWNS this submit: the document goes
  // pending_approval and the flow run id stands in for the request id (the
  // caller only round-trips it as an opaque string). A flow that matched but
  // created no gates (pure automation) already ran its actions.
  const flowResult = await runRecordFlows({ kind: "on_submit" }, doc.kind, doc.id, {
    orgId: doc.orgId,
    userId: actorId ?? doc.createdBy,
  });
  // Fail closed FIRST, before looking at gates: when ANY flow in the dispatch
  // failed, the submission is refused even if a sibling flow gated. Approving
  // the sibling's gate would release a document whose other approval never
  // existed (subjectOpenGateCount only sees pending/escalated gates). The
  // sibling's gates are cancelled in this same transaction so nothing dangles
  // behind the refusal; the document stays draft and the caller surfaces the
  // named cause.
  if (flowResult.failed) {
    await cancelDispatchRuns(doc.orgId, flowResult.runs.map((r) => r.runId));
    const cause = dispatchFailureReason(flowResult) ?? "approval routing failed";
    return { gated: false, runId: null, flowError: `submission refused: ${cause}` };
  }
  if (flowResult.gatesCreated > 0) {
    const updated = await db
      .update(schema.documents)
      .set({
        status: "pending_approval",
        submittedBy: actorId ?? doc.createdBy,
        submittedAt: new Date(),
        updatedBy: actorId ?? doc.createdBy,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.documents.id, targetId), eq(schema.documents.orgId, doc.orgId)))
      .returning({ id: schema.documents.id });
    if (updated.length !== 1) {
      throw new Error("document changed while submission was being recorded");
    }
    const gatedRun = findGatingRun(flowResult);
    return { gated: true, runId: gatedRun?.runId ?? flowResult.runs[0]!.runId, flowError: null };
  }

  const updated = await db
    .update(schema.documents)
    .set({
      submittedBy: actorId ?? doc.createdBy,
      submittedAt: new Date(),
      updatedBy: actorId ?? doc.createdBy,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.documents.id, targetId), eq(schema.documents.orgId, doc.orgId)))
    .returning({ id: schema.documents.id });
  if (updated.length !== 1) {
    throw new Error("document changed while submission was being recorded");
  }
  return { gated: false, runId: null, flowError: null };
}

/**
 * Standard transaction submission primitive. Configured on_submit gates pause
 * the record; when none applies, the absence of a gate means no tenant approval
 * policy applies and the engine releases it to approved — UNLESS the org
 * requires approval before vendor bills release (Company Settings → Setup):
 * then an ungated vendor bill is refused by name and stays submitted, never
 * released. Posting permission is still enforced by the calling API.
 */
export async function submitAndReleaseIfUngated(
  targetKind: string,
  targetId: string,
  actorId: string | null,
): Promise<SubmissionReleaseResult> {
  const [candidate] = await db
    .select({ orgId: schema.documents.orgId })
    .from(schema.documents)
    .where(eq(schema.documents.id, targetId));
  if (!candidate) throw new Error("target document not found");

  // Keep the ungated release in the same transaction as submitForApproval.
  // Otherwise a deletion could wait for the submit transaction, observe the
  // still-draft status, and remove the document before this final transition.
  return withOrgTransaction(candidate.orgId, async () => {
    const result = await submitForApproval(targetKind, targetId, actorId);
    if (result.gated || result.flowError) {
      return { ...result, autoApproved: false, approvalRequired: false };
    }
    if (targetKind === VENDOR_BILL_KIND && (await isVendorBillApprovalRequired(candidate.orgId))) {
      // Fail closed: the submit stamps above stand (the bill stays
      // submitted), but the release to approved never happens. The caller
      // answers with VENDOR_BILL_APPROVAL_REQUIRED_MESSAGE.
      return { ...result, autoApproved: false, approvalRequired: true };
    }
    const released = await db
      .update(schema.documents)
      .set({
        status: "approved",
        updatedBy: actorId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.documents.id, targetId),
          eq(schema.documents.orgId, candidate.orgId),
          eq(schema.documents.status, "draft"),
        ),
      )
      .returning({ id: schema.documents.id });
    if (released.length !== 1) {
      throw new Error("document changed while submission was being released");
    }
    return { ...result, autoApproved: true, approvalRequired: false };
  });
}

/**
 * A return-to-draft refusal: the target is not in a returnable state
 * (posted, voided, already draft, still gated, or partially applied).
 * Callers map this to a 4xx with the message intact — a mis-approved
 * document the operator corrects is request state, not a server defect,
 * and must never surface as a 500.
 */
export class ReturnToDraftError extends Error {
  readonly name = "ReturnToDraftError";
  constructor(
    message: string,
    readonly status: number = 422,
    readonly code: "invalid_status" | "stale-revision" | "not-found" | "applied" = "invalid_status",
  ) {
    super(message);
  }
}

export interface ReturnToDraftInput {
  readonly documentId: string;
  readonly orgId: string;
  readonly actorId: string | null;
  /** Why the approval is withdrawn — required; the audit trail records it. */
  readonly reason: unknown;
  /** Optimistic concurrency token from the opened drawer; checked under lock. */
  readonly expectedUpdatedAt?: string | null;
  readonly allowedSubsidiaryIds?: ReadonlySet<string> | null;
}

export interface ReturnToDraftResult {
  readonly status: "draft";
  /** Completed approval runs superseded by the return (kept as history). */
  readonly supersededRunIds: string[];
  /** In-flight runs and gates cancelled by the return. */
  readonly cancelledRunIds: string[];
}

function requireReturnReason(reason: unknown): string {
  const value = typeof reason === "string" ? reason.trim() : "";
  if (value.length < 5 || value.length > 500) {
    throw new ReturnToDraftError("a return reason between 5 and 500 characters is required");
  }
  return value;
}

/**
 * Return an approved, never-posted document to draft so a mis-approval
 * corrects through edit and re-approval instead of a void on a document
 * that never touched the GL. Applies to every document kind sharing the
 * approve → post lifecycle (the status gate, not a kind list, decides).
 *
 * The aggregate lock precedes every check and the compare-and-set flip,
 * so a concurrent post either wins before this lock (the status gate
 * below refuses) or waits until the draft flip commits (its own approved
 * precondition then fails) — exactly one outcome converges. A zero-row
 * flip is a failure, never a success.
 *
 * Flow evidence: in-flight runs and pending gates cancel through the
 * native cancellation; completed approval runs are kept as history and
 * recorded superseded in the audit entry, so a resubmission starts a
 * new run and the returned document must be re-approved.
 */
export async function returnDocumentToDraft(
  input: ReturnToDraftInput,
): Promise<ReturnToDraftResult> {
  const reason = requireReturnReason(input.reason);
  return withOrgTransaction(input.orgId, async () => {
    const locked = (await db.execute<{
      id: string;
      kind: string;
      status: string;
      number: string | null;
      subsidiaryId: string | null;
      revision: string;
    }>(sql`
      select id, kind, status,
             document_number as number,
             subsidiary_id as "subsidiaryId",
             ${documentRevisionCounterSql(sql.raw("revision_seq"))} as revision
        from documents
       where id = ${input.documentId} and org_id = ${input.orgId}
       for update
    `)).rows[0];
    if (!locked) {
      throw new ReturnToDraftError("document not found in this organization", 404, "not-found");
    }
    if (
      input.allowedSubsidiaryIds !== undefined &&
      !subsidiaryScopeAllows(input.allowedSubsidiaryIds, locked.subsidiaryId)
    ) {
      throw new ScopeNotFoundError();
    }
    if (
      input.expectedUpdatedAt != null &&
      (!isDocumentRevisionToken(input.expectedUpdatedAt) || input.expectedUpdatedAt !== locked.revision)
    ) {
      throw new ReturnToDraftError(
        "this document changed after you opened it; reload and review the latest revision",
        409,
        "stale-revision",
      );
    }
    const name = locked.number ?? "this document";
    if (locked.status === "draft") {
      throw new ReturnToDraftError(`${name} is already a draft — nothing to return`);
    }
    if (locked.status === "posted") {
      throw new ReturnToDraftError(
        `${name} is already posted — void it or post a correction instead of returning to draft`,
      );
    }
    if (locked.status === "voided") {
      throw new ReturnToDraftError(`${name} is voided — voided documents are terminal`);
    }
    if (locked.status === "pending_approval") {
      throw new ReturnToDraftError(
        `${name} is still awaiting approval — decide or withdraw the approval request before returning to draft`,
      );
    }
    if (locked.status !== "approved") {
      throw new ReturnToDraftError(`${name} is ${locked.status} — only an approved document returns to draft`);
    }
    // Partial application refuses by name: money already moving against
    // these details must settle first, or the redraft would strand it.
    const applied = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from payment_instructions instruction
       where instruction.org_id = ${input.orgId}
         and instruction.payment_document_id = ${input.documentId}
         and instruction.status in ('pending', 'approved', 'generated', 'sent')
    `)).rows[0]?.n ?? 0;
    if (applied > 0) {
      throw new ReturnToDraftError(
        `${name} has live payment instructions against it — settle or cancel the payments before returning to draft`,
        422,
        "applied",
      );
    }
    // In-flight runs and pending gates cancel natively; completed runs
    // stay as history (superseded, never deleted), so a resubmission starts
    // a new run and the returned document must be re-approved.
    const runs = (await db.execute<{ id: string; status: string }>(sql`
      select id::text as id, status from flow_runs
       where org_id = ${input.orgId} and subject_id = ${input.documentId}
    `)).rows;
    const liveRunIds = runs.filter((run) => run.status === "running" || run.status === "waiting").map((run) => run.id);
    await cancelDispatchRuns(input.orgId, liveRunIds, { actorId: input.actorId });
    const supersededRunIds = runs.filter((run) => run.status === "completed").map((run) => run.id);
    const before = await captureTransactionAuditSnapshot(db, input.documentId, input.orgId);
    if (!before) {
      throw new ReturnToDraftError("document not found in this organization", 404, "not-found");
    }
    const flipped = (await db.execute<{ id: string }>(sql`
      update documents
         set status = 'draft',
             submitted_by = null, submitted_at = null,
             updated_at = now(), updated_by = ${input.actorId}
       where id = ${input.documentId} and org_id = ${input.orgId} and status = 'approved'
      returning id
    `)).rows[0];
    if (!flipped) {
      throw new ReturnToDraftError(
        `${name} changed while it was being returned to draft; reload and try again`,
      );
    }
    const after = await captureTransactionAuditSnapshot(db, input.documentId, input.orgId);
    if (!after) {
      throw new ReturnToDraftError(
        `${name} changed while it was being returned to draft; reload and try again`,
      );
    }
    await recordTransactionAudit(db, {
      orgId: input.orgId,
      documentId: input.documentId,
      action: "update",
      actorId: input.actorId,
      source: "documents.actions.return_to_draft",
      reason,
      before,
      after,
    });
    return { status: "draft" as const, supersededRunIds, cancelledRunIds: liveRunIds };
  });
}
