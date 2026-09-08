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

/** Presentation of the engine's independent-actor lifecycle, never authority. */
export function promotionNextStep(state: PromotionState, actorId: string): { transition: PromotionTransition | null; reason: string | null } {
  if (state.status === "applied" || state.status === "discarded") return { transition: null, reason: null };
  if (!state.captureComplete || state.itemCount !== state.capturedCount) return { transition: null, reason: "This capture is incomplete. Capture a new change set from the environment." };
  if (!state.baseComplete) return { transition: null, reason: "This older capture has no production snapshot. Capture and review a new change set before applying it." };
  if (state.itemCount === 0) return { transition: null, reason: "No configuration changes were captured." };
  const transition = state.status === "draft" ? "review" : state.status === "reviewed" ? "approve" : state.status === "approved" ? "apply" : null;
  const prior = [state.createdBy, ...(transition !== "review" ? [state.reviewedBy] : []), ...(transition === "apply" ? [state.approvedBy] : [])];
  if (transition && prior.includes(actorId)) return { transition: null, reason: "The creator, reviewer, approver and applier must be four different users. Another authorized user must perform the next step." };
  return { transition, reason: null };
}
