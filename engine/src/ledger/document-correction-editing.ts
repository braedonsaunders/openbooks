/**
 * Posted-document correction commands shared by every adapter (the drawer,
 * REST, MCP and the assistant). The engine correction classifies the edit,
 * rechecks scope, permissions and the transaction feature on the locked
 * source, and records the retained correction evidence; these commands own
 * the surrounding transaction and the replacement draft's flow dispatch.
 */
import { withOrgTransaction } from "../platform/db.ts";
import type { CorrectPostedDocumentResult } from "./document-correction.ts";
import { lockDocumentInScope } from "./document-editing.ts";
import type { DocumentEditInput } from "./document-input.ts";
import { requestDocumentVoid } from "./document-void.ts";
import {
  correctPostedDocumentWithEditor,
  runPostedCorrectionDraftFlows,
  type DocumentEditContext,
} from "./document-write.ts";
import { createExpenseCorrectionDraft, type ExpenseCorrectionBody } from "./expense-editing.ts";

/** The actor a correction runs for; adapters check permissions before calling. */
export interface PostedCorrectionActor {
  orgId: string;
  userId: string;
  source: DocumentEditContext["source"];
}

/**
 * When a void-and-reissue replacement draft dispatches its on_create flows.
 * `with-correction` dispatches inside the correction's transaction, so a
 * failed dispatch rolls the correction back and an idempotent replay cannot
 * skip it. `after-commit` dispatches once the correction's transaction has
 * returned, so externally visible flow work never runs for a correction that
 * rolled back. In-place corrections keep the source and dispatch nothing.
 */
export type CorrectionDraftFlowDispatch = "with-correction" | "after-commit";

async function dispatchReplacementFlows(
  result: CorrectPostedDocumentResult,
  actor: PostedCorrectionActor,
) {
  if (result.kind !== "void-and-reissue") return;
  await runPostedCorrectionDraftFlows(result.replacement.id, result.replacement.kind, actor);
}

/**
 * Correct a posted document: metadata corrects in place, carried dimensions
 * reclass, and anything financial creates a retained replacement draft and
 * voids the source in one atomic unit.
 */
export async function applyPostedDocumentCorrection(
  actor: PostedCorrectionActor,
  input: { documentId: string; correction: DocumentEditInput },
  options: { draftFlows: CorrectionDraftFlowDispatch },
): Promise<CorrectPostedDocumentResult> {
  const corrected = await withOrgTransaction(actor.orgId, async () => {
    const result = await correctPostedDocumentWithEditor(input.documentId, input.correction, actor);
    if (options.draftFlows === "with-correction") await dispatchReplacementFlows(result, actor);
    return result;
  });
  if (options.draftFlows === "after-commit") await dispatchReplacementFlows(corrected, actor);
  return corrected;
}

/**
 * Correct a posted expense report: a faithful replacement draft with the
 * submitted edit applied, plus the source's controlled void, committed as one
 * unit under the source's row lock (rechecked against the actor's scope).
 * Expense drafts run no on_create flows; the replacement runs its submission
 * flows when it is submitted.
 */
export async function correctPostedExpenseReport(
  actor: {
    orgId: string;
    userId: string;
    allowedSubsidiaryIds: ReadonlySet<string> | null;
    source: NonNullable<Parameters<typeof requestDocumentVoid>[0]["source"]>;
  },
  input: { documentId: string; correction: ExpenseCorrectionBody },
): Promise<{
  replacement: { id: string; documentNumber: string };
  voidResult: Awaited<ReturnType<typeof requestDocumentVoid>>;
}> {
  return withOrgTransaction(actor.orgId, async () => {
    await lockDocumentInScope(actor.orgId, input.documentId, actor.allowedSubsidiaryIds);
    const replacement = await createExpenseCorrectionDraft(input.documentId, input.correction, {
      orgId: actor.orgId,
      userId: actor.userId,
      allowedSubsidiaryIds: actor.allowedSubsidiaryIds,
    });
    const voidResult = await requestDocumentVoid({
      documentId: input.documentId,
      orgId: actor.orgId,
      actorId: actor.userId,
      reason: (input.correction.amendmentReason ?? "").trim(),
      source: actor.source,
      expectedUpdatedAt: input.correction.expectedUpdatedAt,
    });
    return { replacement, voidResult };
  });
}
