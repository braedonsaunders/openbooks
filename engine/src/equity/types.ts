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
export type InterestBasis =
  "simple" | "compound_annual" | "compound_semiannual" | "compound_quarterly" | "compound_monthly";
/** How a note counts the days of an accrual period. */
export type DayCount = "actual_365" | "actual_360" | "thirty_360" | "actual_actual";
export type RepurchaseBasis = "cost" | "lower_of_cost_or_fmv";
export type ExpenseAttribution = "straight_line" | "graded";
/**
 * What a preferred class's liquidation preference is measured on, per share:
 * the class's original issue price, or what was paid for each certificate
 * (its purchase price, or the amount a SAFE or note converted), so shares a
 * convertible bought at a discount or under a cap carry the investment as
 * their preference.
 */
export type LiquidationPreferenceBasis = "original_issue_price" | "amount_paid";
export const LIQUIDATION_PREFERENCE_BASES: readonly LiquidationPreferenceBasis[] = [
  "original_issue_price",
  "amount_paid",
];
export type SecurityEventKind =
  | "exercise"
  | "settle"
  | "forfeit"
  | "expire"
  | "cancel"
  | "repurchase"
  | "transfer"
  | "convert"
  | "void"
  | "repay"
  | "reverse"
  | "election_83b";

export const INTEREST_BASES: readonly InterestBasis[] = [
  "simple",
  "compound_annual",
  "compound_semiannual",
  "compound_quarterly",
  "compound_monthly",
];
export const DAY_COUNTS: readonly DayCount[] = [
  "actual_365",
  "actual_360",
  "thirty_360",
  "actual_actual",
];

export const SECURITY_KINDS: readonly SecurityKind[] = [
  "share",
  "option",
  "rsu",
  "warrant",
  "safe",
  "note",
];
export const SECURITY_EVENT_KINDS: readonly SecurityEventKind[] = [
  "exercise",
  "settle",
  "forfeit",
  "expire",
  "cancel",
  "repurchase",
  "transfer",
  "convert",
  "void",
  "repay",
  "reverse",
  "election_83b",
];
/** Events a governed reversal may undo. */
export const REVERSIBLE_EVENT_KINDS: readonly SecurityEventKind[] = [
  "forfeit",
  "expire",
  "cancel",
  "repurchase",
  "repay",
  "election_83b",
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
  liquidationPreferenceBasis: LiquidationPreferenceBasis;
  participation: Participation;
  participationCapMultiple: string | null;
  seniority: number;
  antiDilution: AntiDilution;
  /** The common class a preferred class converts into, when recorded on the class. */
  conversionShareClassId: string | null;
  /** Whether the conversion price adjusts for splits of the conversion class. */
  conversionAdjustsForSplits: boolean;
}

export interface ClassAmendmentRecord {
  id: string;
  shareClassId: string;
  kind: "authorized_shares" | "conversion_price" | "conversion_class";
  effectiveOn: string;
  authorizedShares: bigint | null;
  conversionPrice: string | null;
  conversionShareClassId: string | null;
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
  interestDayCount: DayCount | null;
  maturityDate: string | null;
  fairValuePerUnit: string | null;
  expenseAttribution: ExpenseAttribution | null;
  mfn: boolean;
  unvestedRepurchaseBasis: RepurchaseBasis | null;
  /** Functional-currency units per unit of the security's currency on its issue date. */
  fxRate: string;
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
  /** The event a reversal undoes. */
  reversesEventId: string | null;
}

/**
 * A SAFE holder's MFN election (the later instrument's terms adopted from a
 * date), or the reversal of one: from its date the SAFE carries the terms
 * the reversal records again, and the election no longer applies.
 */
export interface SecurityAmendmentRecord {
  id: string;
  securityId: string;
  kind: "mfn_election" | "mfn_reversal";
  effectiveOn: string;
  /** The instrument whose terms the election adopted (a reversal names its election's source). */
  sourceSecurityId: string;
  /** An election's adopted terms; a reversal's restored terms. */
  valuationCap: string | null;
  discountPercent: string | null;
  safeType: SafeType;
  /** The election a reversal undoes. */
  reversesAmendmentId: string | null;
}

/** A financing round with the terms its latest amendment states. Voided rounds are not part of the book. */
export interface FinancingRoundRecord {
  id: string;
  name: string;
  shareClassId: string;
  closedOn: string;
  pricePerShare: string;
  preMoneyValuation: string;
  currency: string;
  /** Why the pre-money valuation is stated on a basis other than the price times the pre-round fully diluted shares. */
  preMoneyBasisReason: string | null;
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
  securityAmendments: readonly SecurityAmendmentRecord[];
}

export const EMPTY_EQUITY_BOOK: EquityBook = {
  classes: [],
  amendments: [],
  splits: [],
  plans: [],
  reserveChanges: [],
  rounds: [],
  securities: [],
  events: [],
  securityAmendments: [],
};
