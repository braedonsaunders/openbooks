export type PromotionTransition = "review" | "approve" | "apply";
export interface PromotionState {
  status: string;
  captureComplete: boolean;
  itemCount: number;
  capturedCount: number;
  baseComplete: boolean;
  createdBy: string | null;
  reviewedBy: string | null;
  approvedBy: string | null;
}

/**
 * Stable refusal codes for a blocked promotion. The drawer resolves these
 * through the admin.sandboxes.changeSets.reasons catalog in the request
 * locale — the library itself carries no reviewer-facing copy, so a reason
 * can never render in the wrong language.
 */
export type PromotionBlockReason = "incomplete" | "noSnapshot" | "empty" | "segregation";

/** Presentation of the engine's independent-actor lifecycle, never authority. */
export function promotionNextStep(state: PromotionState, actorId: string): { transition: PromotionTransition | null; reasonKey: PromotionBlockReason | null } {
  if (state.status === "applied" || state.status === "discarded") return { transition: null, reasonKey: null };
  if (!state.captureComplete || state.itemCount !== state.capturedCount) return { transition: null, reasonKey: "incomplete" };
  if (!state.baseComplete) return { transition: null, reasonKey: "noSnapshot" };
  if (state.itemCount === 0) return { transition: null, reasonKey: "empty" };
  const transition = state.status === "draft" ? "review" : state.status === "reviewed" ? "approve" : state.status === "approved" ? "apply" : null;
  const prior = [state.createdBy, ...(transition !== "review" ? [state.reviewedBy] : []), ...(transition === "apply" ? [state.approvedBy] : [])];
  if (transition && prior.includes(actorId)) return { transition: null, reasonKey: "segregation" };
  return { transition, reasonKey: null };
}
