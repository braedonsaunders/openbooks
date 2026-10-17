/**
 * The stored equity records of one legal entity, as the pure cap-table math
 * reads them. Quantities are bigint shares; prices, money and percentages
 * are the exact decimal strings their columns store. Arrays arrive in
 * recording order (created_at, id): that order breaks ties between records
 * dated the same day.
 */

export type ShareClassKind = "common" | "preferred";
export type Participation = "none" | "full" | "capped";
export type AntiDilution = "none" | "broad_based" | "narrow_based" | "full_ratchet";
export type SecurityKind = "share" | "option" | "rsu" | "warrant" | "safe" | "note";
export type VestingFrequency = "monthly" | "quarterly" | "annual";
export type Acceleration = "none" | "single" | "double";
export type SafeType = "pre_money" | "post_money";
export type InterestBasis = "simple" | "compound_annual";
export type ExpenseAttribution = "straight_line" | "graded";
export type SecurityEventKind =
  | "exercise"
  | "settle"
  | "forfeit"
  | "expire"
  | "cancel"
  | "repurchase"
  | "transfer"
  | "convert"
  | "void";

export const SECURITY_KINDS: readonly SecurityKind[] = ["share", "option", "rsu", "warrant", "safe", "note"];
export const SECURITY_EVENT_KINDS: readonly SecurityEventKind[] = [
  "exercise", "settle", "forfeit", "expire", "cancel", "repurchase", "transfer", "convert", "void",
];
/** Kinds that carry a share count and an underlying class. */
export const SHARE_BASED_KINDS: readonly SecurityKind[] = ["share", "option", "rsu", "warrant"];
/** Awards that convert into shares on exercise or settlement. */
export const AWARD_KINDS: readonly SecurityKind[] = ["option", "rsu", "warrant"];
/** Convertible instruments measured in money, not shares. */
export const CONVERTIBLE_KINDS: readonly SecurityKind[] = ["safe", "note"];

export interface ShareClassRecord {
  id: string;
  code: string;
  name: string;
  kind: ShareClassKind;
  effectiveOn: string;
  initialAuthorizedShares: bigint;
  parValue: string;
  originalIssuePrice: string | null;
  initialConversionPrice: string | null;
  liquidationMultiple: string | null;
  participation: Participation;
  participationCapMultiple: string | null;
  seniority: number;
  antiDilution: AntiDilution;
}

export interface ClassAmendmentRecord {
  id: string;
  shareClassId: string;
  kind: "authorized_shares" | "conversion_price";
  effectiveOn: string;
  authorizedShares: bigint | null;
  conversionPrice: string | null;
  reason: string;
}

export interface SplitRecord {
  id: string;
  shareClassId: string;
  effectiveOn: string;
  ratioNumerator: bigint;
  ratioDenominator: bigint;
}

export interface PlanRecord {
  id: string;
  code: string;
  name: string;
  shareClassId: string;
  effectiveOn: string;
  initialReservedShares: bigint;
  recycleForfeited: boolean;
  recycleExpired: boolean;
  recycleRepurchased: boolean;
}

export interface ReserveChangeRecord {
  id: string;
  planId: string;
  effectiveOn: string;
  shareDelta: bigint;
}

export interface VestingTranche {
  date: string;
  quantity: bigint;
}

export interface SecurityRecord {
  id: string;
  securityNumber: string;
  kind: SecurityKind;
  holderPartyId: string;
  shareClassId: string | null;
  planId: string | null;
  roundId: string | null;
  sourceSecurityId: string | null;
  issueDate: string;
  quantity: bigint | null;
  pricePerShare: string | null;
  considerationAmount: string | null;
  currency: string;
  vestingStart: string | null;
  vestingMonths: number | null;
  cliffMonths: number | null;
  vestingFrequency: VestingFrequency | null;
  vestingTranches: readonly VestingTranche[] | null;
  acceleration: Acceleration;
  accelerationPercent: string | null;
  expirationDate: string | null;
  optionType: "iso" | "nso" | null;
  earlyExercise: boolean;
  safeType: SafeType | null;
  valuationCap: string | null;
  discountPercent: string | null;
  interestRatePercent: string | null;
  interestBasis: InterestBasis | null;
  maturityDate: string | null;
  fairValuePerUnit: string | null;
  expenseAttribution: ExpenseAttribution | null;
}

export interface SecurityEventRecord {
  id: string;
  securityId: string;
  kind: SecurityEventKind;
  effectiveOn: string;
  quantity: bigint | null;
  pricePerShare: string | null;
  amount: string | null;
  resultingSecurityId: string | null;
  roundId: string | null;
}

export interface FinancingRoundRecord {
  id: string;
  name: string;
  shareClassId: string;
  closedOn: string;
  pricePerShare: string;
  preMoneyValuation: string;
  currency: string;
}

/** Everything recorded for one legal entity. */
export interface EquityBook {
  classes: readonly ShareClassRecord[];
  amendments: readonly ClassAmendmentRecord[];
  splits: readonly SplitRecord[];
  plans: readonly PlanRecord[];
  reserveChanges: readonly ReserveChangeRecord[];
  rounds: readonly FinancingRoundRecord[];
  securities: readonly SecurityRecord[];
  events: readonly SecurityEventRecord[];
}

export const EMPTY_EQUITY_BOOK: EquityBook = {
  classes: [], amendments: [], splits: [], plans: [], reserveChanges: [], rounds: [], securities: [], events: [],
};
