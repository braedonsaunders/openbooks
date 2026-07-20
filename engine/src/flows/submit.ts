import { eq } from "drizzle-orm";
import { db, schema } from "../db.ts";
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
 * WITHOUT changing status, and leaves the "does this kind still require an
 * approval that was never configured?" decision to the caller (the web layer,
 * which knows each kind's direct-post / credit-memo policy). There is no
 * fallback approval engine — Flows is the only path.
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

export async function submitForApproval(
  _targetKind: string,
  targetId: string,
): Promise<SubmitResult> {
  const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, targetId));
  if (!doc) throw new Error("target document not found");
  if (doc.status !== "draft") throw new Error(`document is ${doc.status}, not draft`);

  // -- user scripts: before_submit (veto / mutate) ------------------------
  const [org] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, doc.orgId));
  if (org) {
    const lines = await db
      .select()
      .from(schema.documentLines)
      .where(eq(schema.documentLines.documentId, targetId));
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
      await db.update(schema.documents).set(mutations).where(eq(schema.documents.id, doc.id));
    }
  }

  // -- flows: on_submit --------------------------------------------------
  // A flow that produced approval gates OWNS this submit: the document goes
  // pending_approval and the flow run id stands in for the request id (the
  // caller only round-trips it as an opaque string). A flow that matched but
  // created no gates (pure automation) already ran its actions; the caller
  // decides whether this kind may proceed without an approval.
  const flowResult = await runRecordFlows({ kind: "on_submit" }, doc.kind, doc.id, {
    orgId: doc.orgId,
    userId: doc.createdBy,
  });
  if (flowResult.gatesCreated > 0) {
    await db
      .update(schema.documents)
      .set({ status: "pending_approval" })
      .where(eq(schema.documents.id, targetId));
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

  return { gated: false, runId: null, flowError: null };
}
