/** Promotion codes the sales document drawers and the setup registry share. */
export {
  applyPromotion,
  listPromotions,
  PromotionRefusal,
  promotionStatusTransition,
  validatePromotionFields,
} from "./promotions.ts";
export type {
  AppliedPromotionLine,
  ApplyPromotionResult,
  Promotion,
  PromotionStatus,
} from "./promotions.ts";
