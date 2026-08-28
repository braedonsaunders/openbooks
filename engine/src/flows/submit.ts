import { and, eq, sql } from "drizzle-orm";
import { db, schema, withOrgTransaction } from "../db.ts";
import { runTriggerScripts, type ScriptContext } from "../scripting.ts";
import { runRecordFlows } from "./run.ts";

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
  if (doc.status !== "draft") throw new Error(`document is ${doc.status}, not draft`);
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
    throw new Error(
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
    const scriptCtx: ScriptContext = {
      trigger: "before_submit",
      document: doc as unknown as Record<string, unknown>,
      lines: lines as unknown as Record<string, unknown>[],
      org: { id: org.id, name: org.name, baseCurrency: org.baseCurrency },
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
      await db.update(schema.documents).set(mutations).where(and(eq(schema.documents.id, doc.id), eq(schema.documents.orgId, doc.orgId)));
    }
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
    const gatedRun = flowResult.runs.find((r) => r.gatesCreated > 0);
    return { gated: true, runId: gatedRun?.runId ?? flowResult.runs[0]!.runId, flowError: null };
  }

  // A matched approval flow errored (or dispatch threw) without producing a
  // gate. FAIL CLOSED: never let the caller treat this as "no approval needed"
  // and auto-approve — the document stays draft and the caller surfaces it.
  if (flowResult.failed) {
    const reason = flowResult.runs.find((r) => r.status === "failed") ? "an approval flow errored" : "approval routing failed";
    return { gated: false, runId: null, flowError: reason };
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
 * policy applies and the engine releases it to approved. Posting permission is
 * still enforced by the calling API.
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
      return { ...result, autoApproved: false };
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
    return { ...result, autoApproved: true };
  });
}
