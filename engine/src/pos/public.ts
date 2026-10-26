/** Point of sale: the application contract for registers, drawer sessions, register sales and refunds. */
export { PosError, type PosRefusalCode } from "./errors.ts";
export {
  POS_TENDER_KINDS,
  acceptedTenderKinds,
  cashReasonSetupRefusal,
  listUsableRegisters,
  loadRegisterForUse,
  registerSetupRefusal,
  type PosRegister,
  type PosTenderKind,
} from "./registers.ts";
export {
  POS_FEATURE_REMEDY,
  closeSession,
  listSessions,
  lockSession,
  openSession,
  readRegisterContext,
  readSessionSummary,
  recordCashMovement,
  type PosSessionRow,
  type SessionListRow,
  type SessionSummary,
} from "./sessions.ts";
export {
  completePosRefund,
  completePosSale,
  findPosReceiptByNumber,
  listSessionReceipts,
  quotePosCart,
  readPosReceipt,
  type PosAuthority,
  type PosCompletion,
  type PosPaymentInput,
  type PosPricingDeps,
  type PosPricingRequest,
  type PosQuote,
  type PosReceipt,
  type PosSaleLineInput,
} from "./sales.ts";
export {
  holdCart,
  listHeldCarts,
  resumeHeldCart,
  type HeldCartContent,
  type ResumedCart,
} from "./held-carts.ts";
export {
  searchPosCustomers,
  searchPosItems,
  type PosCustomerSearchResult,
  type PosItemSearchResult,
} from "./register-search.ts";
