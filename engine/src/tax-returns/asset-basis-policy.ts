/**
 * Client-safe statutory tax-basis workpaper policy. No database, no book
 * amounts, no group_component. The UI imports this module for field metadata;
 * the engine uses the same predicates and computations.
 *
 * Corrections locked to primary sources before this file was written:
 * - NZ IR260 p.24 (current): lower of buyer price and associate original cost
 *   (or first-business-use FMV); rate no higher than the associate equivalent.
 * - Treas. Reg. 1.168(i)-8(d)(1) / Pub 544: sale of a portion is a REQUIRED
 *   partial disposition — native partial_disposal does not need an election.
 * - CRA NAL worksheets: transferor CHARACTER (individual/partnership vs
 *   corporation/nonresident), payment vs SELLER COST, not FMV.
 * - ITA 69(1)(b)(i) lifts seller proceeds to FMV only when proceeds are nil
 *   or below FMV; above-FMV actual proceeds are not reduced. ITA 69(1)(a)
 *   separately caps the buyer's excessive acquisition price at FMV.
 * - Pub 544 amount realized is money + FMV of other property/services +
 *   assumed liabilities. Related status does not substitute the transferred
 *   asset's FMV; a §482 or other deemed-value adjustment must be evidenced.
 */
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { add, cmp, formatMoney, mulDecimal, mulPercent, mulRatio, neg, normalizeDecimal, normalizeMoney, sum, toUnits } from "../money/money.ts";

export class TaxBasisPolicyError extends Error {
  readonly name = "TaxBasisPolicyError";
}

export const TAX_BASIS_REGIMES = ["ca_cca", "uk_wda", "au_pool", "nz_pool", "us_macrs"] as const;
export type TaxBasisRegime = (typeof TAX_BASIS_REGIMES)[number];

export const TAX_BASIS_REGIME_LABELS: Record<TaxBasisRegime, string> = {
  ca_cca: "Canada — Capital Cost Allowance",
  uk_wda: "United Kingdom — Writing-Down Allowances",
  au_pool: "Australia — Depreciation Pools",
  nz_pool: "New Zealand — Pool method",
  us_macrs: "United States — MACRS",
};

/** Native financial-change operations that can source a tax workpaper.
 *  Set this on TaxBasisDraft from the selected source — it is not an
 *  operator field and must not be typed as a UUID. Buyer-side facts are
 *  visible only on intercompany_transfer; a partial_disposal to a
 *  customer must not require them. */
export const TAX_BASIS_SOURCE_OPERATIONS = ["partial_disposal", "intercompany_transfer"] as const;
export type TaxBasisSourceOperation = (typeof TAX_BASIS_SOURCE_OPERATIONS)[number];

/** Native full disposal under operation partial_disposal writes kind
 *  `disposed`. Legacy write-offs are `written_off`. Both are tax sources. */
export const TAX_BASIS_SOURCE_KINDS = [
  "partially_disposed",
  "transferred",
  "disposed",
  "written_off",
] as const;
export type TaxBasisSourceKind = (typeof TAX_BASIS_SOURCE_KINDS)[number];

export function taxBasisSourceOperation(
  kind: TaxBasisSourceKind,
): TaxBasisSourceOperation {
  return kind === "transferred" ? "intercompany_transfer" : "partial_disposal";
}

export const TAX_BASIS_RELATIONSHIPS = ["arms_length", "non_arms_length"] as const;
export type TaxBasisRelationship = (typeof TAX_BASIS_RELATIONSHIPS)[number];

export const CA_TRANSFEROR_CHARACTERS = [
  "resident_individual",
  "resident_partnership",
  "corporation",
  "nonresident",
  "other_partnership",
] as const;
export type CaTransferorCharacter = (typeof CA_TRANSFEROR_CHARACTERS)[number];

export const CA_ALLOCATION_METHODS = [
  "ascertainable_amount",
  "ascertainable_fraction",
  "fmv_prorata",
  "operator_reasonable",
] as const;
export type CaAllocationMethod = (typeof CA_ALLOCATION_METHODS)[number];

export const CA_ROLLOVERS = ["none", "s85", "s97", "other"] as const;
export type CaRollover = (typeof CA_ROLLOVERS)[number];

export const US_DISPOSITION_TRIGGERS = [
  "sale",
  "section_168i7b",
  "casualty",
  "like_kind_1031",
  "involuntary_1033",
  "elective_other",
] as const;
export type UsDispositionTrigger = (typeof US_DISPOSITION_TRIGGERS)[number];

export const US_REQUIRED_PARTIAL_TRIGGERS: readonly UsDispositionTrigger[] = [
  "sale",
  "section_168i7b",
  "casualty",
  "like_kind_1031",
  "involuntary_1033",
];

export const US_RECOGNITIONS = ["taxable", "nontaxable"] as const;
export type UsRecognition = (typeof US_RECOGNITIONS)[number];

/** §168(i)(7) vehicle. Monthly placement-year allocation is only (B)(i)
 *  outside a consolidated group. 26 CFR 1.168(d)-1(b)(7); 1.168(k)-2(g)(1)(iii). */
export const US_SECTION_168I7_KINDS = [
  "nonrecognition",
  "partnership_721_prior_interest",
  "consolidated_group",
] as const;
export type UsSection168i7Kind = (typeof US_SECTION_168I7_KINDS)[number];

/** Stable identity for one open MACRS vintage. `original` is the seller
 *  statutory vintage; buyer-created vintages include transferOn so two
 *  carryovers placed on the same day do not collapse. */
export const MACRS_VINTAGE_SOURCES = ["original", "carryover", "excess", "taxable_cost"] as const;
export type MacrsVintageSource = (typeof MACRS_VINTAGE_SOURCES)[number];

export const MACRS_VINTAGE_SOURCE_LABELS: Record<MacrsVintageSource, string> = {
  original: "Original seller vintage — frozen statutory basis and recovery",
  carryover: "§168(i)(7) carryover — transferor history and declared adjusted checkpoint",
  excess: "Nontaxable excess basis — newly placed on the receiving schedule",
  taxable_cost: "Taxable buyer cost — newly placed on the receiving schedule",
};

export const MACRS_METHODS = ["200_db", "150_db", "straight_line"] as const;
export type MacrsMethod = (typeof MACRS_METHODS)[number];

export const MACRS_CONVENTIONS = ["half_year", "mid_quarter", "mid_month"] as const;
export type MacrsConvention = (typeof MACRS_CONVENTIONS)[number];

/** Operator-declared split of one identified vintage. Header
 *  disposedUnadjustedBasis / remainingUnadjustedBasis are the sums.
 *  `parentKey` is required when the open vintage key includes lineage. */
export interface MacrsVintageAllocationInput {
  source: MacrsVintageSource;
  placedInServiceOn: string;
  transferOn?: string | null;
  parentKey?: string | null;
  disposedUnadjustedBasis: string;
  remainingUnadjustedBasis: string;
}

export function macrsVintageKey(args: {
  source: MacrsVintageSource;
  placedInServiceOn: string;
  transferOn?: string | null;
  parentKey?: string | null;
}): string {
  if (args.source === "original") return `original:${args.placedInServiceOn}`;
  const base = `${args.source}:${args.placedInServiceOn}:${args.transferOn ?? ""}`;
  return args.parentKey ? `${base}:${args.parentKey}` : base;
}

/** One open seller vintage reconstructed immediately before the selected
 *  source. Identities and recovery are server-derived; the editor allocates
 *  disposed and retained amounts against these rows. */
export interface OpenMacrsVintage {
  key: string;
  source: MacrsVintageSource;
  parentKey: string | null;
  placedInServiceOn: string;
  transferOn: string | null;
  unadjustedBasis: string;
  adjustedCarryover: string | null;
  section179: string;
  priorDepreciation: string | null;
  recoveryPeriodYears: string;
  method: MacrsMethod;
  convention: MacrsConvention;
  bonusPercent: string;
  businessUsePercent: string;
  shortYearMethod?: UsShortYearMethod;
  section168i7Kind?: UsSection168i7Kind | null;
}

/** Frozen receiving vintage for one disposed allocation. Carryover keeps
 *  transferor recovery; `parentKey` is the open vintage that was split. */
export interface FrozenMacrsBuyerVintage {
  key: string;
  source: "carryover" | "excess" | "taxable_cost";
  parentKey: string | null;
  placedInServiceOn: string;
  transferOn: string;
  recoveryPeriodYears: string;
  method: MacrsMethod;
  convention: MacrsConvention;
  unadjustedBasis: string;
  adjustedCarryover: string | null;
  section179: string;
  priorDepreciation: string | null;
  bonusPercent: string;
  businessUsePercent: string;
}

export const US_SELLER_MACRS_VINTAGE_STATUSES = [
  "ready",
  "original_declaration_required",
  "history_refused",
] as const;
export type UsSellerMacrsVintageStatus = (typeof US_SELLER_MACRS_VINTAGE_STATUSES)[number];

/** Seller-side US source context. Missing history is not an empty valid
 *  list and is not book acquisition cost. `null` on the source choice means
 *  US is not seller-applicable. */
export type UsSellerMacrsVintageContext =
  | {
      status: "ready";
      vintages: OpenMacrsVintage[];
      /** Exact registered windows consumed to date these vintages, including
       *  one convention-only successor when the loader retained it. */
      taxYearWindows?: Array<{
        id: string;
        subsidiaryId: string;
        regime: string;
        yearStart: string;
        yearEnd: string;
        filingYear: number;
      }>;
    }
  | { status: "original_declaration_required" }
  | { status: "history_refused"; refusal: string };

export const US_SHORT_YEAR_METHODS = ["simplified", "allocation"] as const;
export type UsShortYearMethod = (typeof US_SHORT_YEAR_METHODS)[number];

export const US_AMOUNT_REALIZED_RULES = ["amount_realized", "section_482", "other_evidenced"] as const;
export type UsAmountRealizedRule = (typeof US_AMOUNT_REALIZED_RULES)[number];

export const NZ_ASSOCIATE_COST_BASES = ["original_cost", "first_business_use_fmv"] as const;
export type NzAssociateCostBasis = (typeof NZ_ASSOCIATE_COST_BASES)[number];

/** Client POST body. effectiveOn, requiredSubsidiaryIds and receivingAssetId
 *  are derived from the source financial change or legacy event and must not
 *  be supplied. sourceChangeId is null for a legacy event that has no
 *  financial_change_id; then sourceEventId is required. */
export interface TaxAssetBasisInput {
  sourceChangeId?: string | null;
  sourceEventId?: string | null;
  reason: string;
  assessment: string;
  idempotencyKey: string;
  regimes: TaxRegimeBasis[];
}

/** tax_basis_reversal deliberately has no effectiveOn. The workpaper
 *  reverses in the tax year of the source financial change; a second
 *  date would reprice a different year. */
export interface TaxAssetBasisReversalInput {
  sourceChangeId: string;
  reason: string;
  idempotencyKey: string;
}

/**
 * Which classified party a regime workpaper is for. Derived from the seller
 * and receiving assets' tax classification — not an operator election.
 * `seller`: seller classified, receiver not (or no receiver).
 * `buyer`: receiver classified, seller not.
 * `both`: both classified.
 */
export const TAX_BASIS_APPLICABLE_SIDES = ["seller", "buyer", "both"] as const;
export type TaxBasisApplicableSide = (typeof TAX_BASIS_APPLICABLE_SIDES)[number];

export const TAX_BASIS_APPLICABLE_SIDE_LABELS: Record<TaxBasisApplicableSide, string> = {
  seller: "Seller",
  buyer: "Buyer",
  both: "Seller and buyer",
};

export function taxBasisApplicableSide(
  sellerClassified: boolean,
  receiverClassified: boolean,
): TaxBasisApplicableSide | null {
  if (sellerClassified && receiverClassified) return "both";
  if (sellerClassified) return "seller";
  if (receiverClassified) return "buyer";
  return null;
}

export function taxBasisSideApplies(
  applicable: TaxBasisApplicableSide | undefined,
  side: "seller" | "buyer",
): boolean {
  return applicable === "both" || applicable === side;
}

/** Union of classified seller/receiver regimes with the derived side. */
export function taxBasisSourceRegimes(
  seller: readonly { code: TaxBasisRegime; name?: string }[],
  receiver: readonly { code: TaxBasisRegime; name?: string }[],
  transfer: boolean,
): TaxAssetBasisSourceRegime[] {
  const out: TaxAssetBasisSourceRegime[] = [];
  for (const code of TAX_BASIS_REGIMES) {
    const applicable = taxBasisApplicableSide(
      seller.some((row) => row.code === code),
      transfer && receiver.some((row) => row.code === code),
    );
    if (!applicable) continue;
    out.push({ code, name: TAX_BASIS_REGIME_LABELS[code], applicable });
  }
  return out;
}

export interface TaxBasisSourceContext {
  sourceOperation: TaxBasisSourceOperation;
  applicable: TaxBasisApplicableSide;
  usSellerMacrs?: UsSellerMacrsVintageContext | null;
  /** Source occurredOn. Required to freeze buyer vintage transferOn. */
  effectiveOn?: string;
}

export interface TaxBasisValidationContext extends Partial<TaxBasisSourceContext> {
  sourceOperation: TaxBasisSourceOperation;
  applicableByRegime?: Readonly<Partial<Record<TaxBasisRegime, TaxBasisApplicableSide>>>;
  usSellerMacrs?: UsSellerMacrsVintageContext | null;
  /** Source effective date. Required to freeze buyer vintage transferOn. */
  effectiveOn?: string;
}

/** One classified regime on a GET source row. `applicable` is server-derived. */
export interface TaxAssetBasisSourceRegime {
  code: TaxBasisRegime;
  name: string;
  applicable: TaxBasisApplicableSide;
}

/** GET/POST /api/assets/:id/tax-basis — operator picks a labelled row.
 *  Do not ask them to type a UUID. */
export interface TaxAssetBasisSourceChoice {
  key: string;
  sourceChangeId: string | null;
  sourceEventId: string | null;
  occurredOn: string;
  sourceKind: TaxBasisSourceKind;
  sourceOperation: TaxBasisSourceOperation;
  bookLabel: string | null;
  assetLabel: string;
  subsidiaryLabel: string;
  receivingAssetLabel: string | null;
  regimes: TaxAssetBasisSourceRegime[];
  /** Seller-side US vintage history immediately before this source.
   *  `null` when US is not seller-applicable. */
  openMacrsVintages: UsSellerMacrsVintageContext | null;
  appliedWorkpaper: {
    changeId: string;
    status: "draft" | "pending" | "approved" | "rejected" | "applied";
  } | null;
}

export interface TaxAssetBasisSourcesResponse {
  assetId: string;
  assetNumber: string;
  sources: TaxAssetBasisSourceChoice[];
}

export interface TaxAssetBasisApplyResult {
  changeId: string;
  workpaperId: string;
  workpaperIds: string[];
  sourceChangeId: string | null;
  sourceEventId: string | null;
  effectiveOn: string;
  requiredSubsidiaryIds: string[];
  receivingAssetId: string | null;
  regimes: TaxBasisRegime[];
  computed: Record<string, unknown>;
}

/** Stable service signatures. Implementations land with the workpaper table;
 *  the drawer can import these types from this SHA. */
export type ProposeTaxAssetBasis = (
  orgId: string,
  assetId: string,
  actorId: string,
  input: TaxAssetBasisInput,
) => Promise<string>;
export type ApplyTaxAssetBasis = (
  orgId: string,
  changeId: string,
  actorId: string,
) => Promise<TaxAssetBasisApplyResult>;
export type ProposeTaxAssetBasisReversal = (
  orgId: string,
  sourceChangeId: string,
  actorId: string,
  input: Omit<TaxAssetBasisReversalInput, "sourceChangeId">,
) => Promise<string>;
export type ApplyTaxAssetBasisReversal = (
  orgId: string,
  changeId: string,
  actorId: string,
) => Promise<TaxAssetBasisApplyResult>;

export type TaxRegimeBasis =
  | CaCcaRegimeBasis
  | UkWdaRegimeBasis
  | AuPoolRegimeBasis
  | NzPoolRegimeBasis
  | UsMacrsRegimeBasis;

interface TaxRegimeBasisBase {
  relationship: TaxBasisRelationship;
}

export interface CaCcaRegimeBasis extends TaxRegimeBasisBase {
  regime: "ca_cca";
  originalCapitalCost: string;
  allocationMethod: CaAllocationMethod;
  allocatedCapitalCost?: string;
  allocationFraction?: string;
  allocationReason?: string;
  partFairMarketValue?: string;
  retainedFairMarketValue?: string;
  statutoryProceeds?: string;
  fairMarketValue?: string;
  payment?: string;
  sellerOriginalCapitalCost?: string;
  transferorCharacter?: CaTransferorCharacter;
  capitalGainsInclusionRate?: string;
  capitalGainsInclusionRateCitation?: string;
  capitalGainsDeductionClaimed?: string;
  rolloverElection: CaRollover;
  electedAmount?: string;
}

export interface UkWdaRegimeBasis extends TaxRegimeBasisBase {
  regime: "uk_wda";
  qualifyingExpenditure: string;
  allocatedQualifyingExpenditure?: string;
  statutoryProceeds?: string;
  fairMarketValue?: string;
  saleBelowMarket: boolean;
  buyerCanClaimPma: boolean;
  connectedChain: boolean;
  greatestQualifyingExpenditureInChain?: string;
  buyerQualifyingExpenditure?: string;
}

export interface AuPoolRegimeBasis extends TaxRegimeBasisBase {
  regime: "au_pool";
  taxableUsePercent: string;
  terminationValue?: string;
  fairMarketValue?: string;
  allocatedCost?: string;
  buyerCost?: string;
}

export interface NzPoolRegimeBasis extends TaxRegimeBasisBase {
  regime: "nz_pool";
  consideration: string;
  disposalExpenditure: string;
  buyerPrice?: string;
  associatedPersonCostBasis?: NzAssociateCostBasis;
  associatedPersonOriginalCost?: string;
  firstBusinessUseFairMarketValue?: string;
  associatedPersonEquivalentRate?: string;
  commissionerActualCost: boolean;
  commissionerApprovalEvidence?: string;
  consolidatingGroupAtv: boolean;
  associatedPersonAtv?: string;
}

export interface UsMacrsRegimeBasis extends TaxRegimeBasisBase {
  regime: "us_macrs";
  dispositionTrigger?: UsDispositionTrigger;
  partialDispositionElection?: boolean;
  originalUnadjustedBasis?: string;
  remainingUnadjustedBasis?: string;
  disposedUnadjustedBasis?: string;
  placedInServiceOn?: string;
  recoveryPeriodYears?: string;
  method?: MacrsMethod;
  convention?: MacrsConvention;
  recognition: UsRecognition;
  section168i7Kind?: UsSection168i7Kind;
  relatedPerson: boolean;
  statutoryProceeds?: string;
  amountRealizedRule?: UsAmountRealizedRule;
  adjustedAmountRealized?: string;
  deemedValueAdjustmentEvidence?: string;
  buyerCost?: string;
  carryoverBasis?: string;
  excessBasis?: string;
  shortYearMethod?: UsShortYearMethod;
  /** Allocated to this transferred slice — not the whole source-asset election. */
  section179?: string;
  bonusPercent?: string;
  businessUsePercent?: string;
  priorDepreciation?: string;
  /** Required when more than one vintage is open. Each row is one vintage;
   *  header disposed/remaining are the sums. Do not match a vintage by amount. */
  vintageAllocations?: MacrsVintageAllocationInput[];
  /** Frozen per-disposed-vintage receiver schedules. Derived from ready
   *  history; not an operator-typed composite header. */
  buyerVintages?: FrozenMacrsBuyerVintage[];
}

export type TaxBasisFieldKind = "decimal" | "boolean" | "enum" | "text" | "date";

export type TaxBasisFieldPredicate =
  | { always: true }
  | { never: true }
  | { regime: TaxBasisRegime }
  | { relationship: TaxBasisRelationship }
  | { sourceOperation: TaxBasisSourceOperation }
  | { side: "seller" | "buyer" }
  | { fieldEquals: { name: string; values: readonly string[] } }
  | { fieldTrue: string }
  | { usSellerMacrsStatus: UsSellerMacrsVintageStatus }
  | { all: TaxBasisFieldPredicate[] }
  | { any: TaxBasisFieldPredicate[] }
  | { not: TaxBasisFieldPredicate };

export interface TaxBasisFieldMeta {
  name: string;
  label: string;
  kind: TaxBasisFieldKind;
  choices?: { value: string; label: string }[];
  visibleWhen: TaxBasisFieldPredicate;
  requiredWhen: TaxBasisFieldPredicate;
  help?: string;
}

const BUYER: TaxBasisFieldPredicate = {
  all: [{ sourceOperation: "intercompany_transfer" }, { side: "buyer" }],
};
const SELLER: TaxBasisFieldPredicate = { side: "seller" };
/** First seller declaration only. Frozen history supplies each vintage's own
 *  placed date, method, convention and recovery — do not invent one composite. */
const US_SELLER_ORIGINAL_DECLARATION: TaxBasisFieldPredicate = {
  all: [
    SELLER,
    { not: { usSellerMacrsStatus: "ready" } },
    { not: { usSellerMacrsStatus: "history_refused" } },
  ],
};
/** Seller first declaration, or buyer nontaxable carryover before seller
 *  history is ready. Once vintages are ready the header original is derived. */
const US_ORIGINAL_STATUTORY: TaxBasisFieldPredicate = {
  any: [
    US_SELLER_ORIGINAL_DECLARATION,
    {
      all: [
        BUYER,
        { fieldEquals: { name: "recognition", values: ["nontaxable"] } },
        { not: { usSellerMacrsStatus: "ready" } },
      ],
    },
  ],
};
/** Seller first declaration, or buyer nontaxable carryover before seller
 *  history is ready. Ready history freezes date/method/convention/recovery
 *  per disposed vintage — do not retype a composite header. */
const US_TRANSFEROR_HISTORY: TaxBasisFieldPredicate = {
  any: [
    US_SELLER_ORIGINAL_DECLARATION,
    {
      all: [
        BUYER,
        { fieldEquals: { name: "recognition", values: ["nontaxable"] } },
        { not: { usSellerMacrsStatus: "ready" } },
      ],
    },
  ],
};
const US_SELLER_SPLIT_AMOUNTS: TaxBasisFieldPredicate = {
  all: [SELLER, { not: { usSellerMacrsStatus: "history_refused" } }],
};
/** Historical elections allocated to the carried-over slice. Missing JSON is
 *  not zero. Ready seller history derives these per disposed vintage. */
const US_CARRYOVER_ELECTIONS: TaxBasisFieldPredicate = {
  all: [
    BUYER,
    { fieldEquals: { name: "recognition", values: ["nontaxable"] } },
    { not: { usSellerMacrsStatus: "ready" } },
  ],
};

function labeledChoices<T extends string>(
  values: readonly T[],
  labels: Record<T, string>,
): { value: T; label: string }[] {
  return values.map((value) => ({ value, label: labels[value] }));
}

export const TAX_BASIS_FIELDS: TaxBasisFieldMeta[] = [
  {
    name: "regime",
    label: "Tax depreciation regime",
    kind: "enum",
    choices: labeledChoices(TAX_BASIS_REGIMES, TAX_BASIS_REGIME_LABELS),
    visibleWhen: { always: true },
    requiredWhen: { always: true },
  },
  {
    name: "relationship",
    label: "Arm's-length relationship",
    kind: "enum",
    choices: [
      { value: "arms_length", label: "Arm's length" },
      { value: "non_arms_length", label: "Not at arm's length / associated / connected / related" },
    ],
    visibleWhen: { always: true },
    requiredWhen: { always: true },
    help: "Related status is a fact, not an election. It does not by itself authorize a cost override.",
  },
  {
    name: "originalCapitalCost",
    label: "Original capital cost of the whole property",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "ca_cca" }, SELLER] },
    requiredWhen: { all: [{ regime: "ca_cca" }, SELLER] },
  },
  {
    name: "allocationMethod",
    label: "Section 43 allocation method",
    kind: "enum",
    choices: labeledChoices(CA_ALLOCATION_METHODS, {
      ascertainable_amount: "Identifiable capital cost of the part",
      ascertainable_fraction: "Identifiable fraction of capital cost",
      fmv_prorata: "Fair-market-value pro-rata",
      operator_reasonable: "Other reasonable allocation (must be explained)",
    }),
    visibleWhen: { all: [{ regime: "ca_cca" }, SELLER] },
    requiredWhen: { all: [{ regime: "ca_cca" }, SELLER] },
    help: "Book portion percent and group_component are not the tax allocation.",
  },
  {
    name: "allocatedCapitalCost",
    label: "Allocated capital cost of the part",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "ca_cca" }, SELLER, { fieldEquals: { name: "allocationMethod", values: ["ascertainable_amount", "operator_reasonable"] } }] },
    requiredWhen: { all: [{ regime: "ca_cca" }, SELLER, { fieldEquals: { name: "allocationMethod", values: ["ascertainable_amount", "operator_reasonable"] } }] },
  },
  {
    name: "allocationFraction",
    label: "Ascertainable fraction of capital cost",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "ca_cca" }, SELLER, { fieldEquals: { name: "allocationMethod", values: ["ascertainable_fraction"] } }] },
    requiredWhen: { all: [{ regime: "ca_cca" }, SELLER, { fieldEquals: { name: "allocationMethod", values: ["ascertainable_fraction"] } }] },
  },
  {
    name: "allocationReason",
    label: "Reason the allocation is reasonable",
    kind: "text",
    visibleWhen: { all: [{ regime: "ca_cca" }, SELLER, { fieldEquals: { name: "allocationMethod", values: ["fmv_prorata", "operator_reasonable"] } }] },
    requiredWhen: { all: [{ regime: "ca_cca" }, SELLER, { fieldEquals: { name: "allocationMethod", values: ["fmv_prorata", "operator_reasonable"] } }] },
  },
  {
    name: "partFairMarketValue",
    label: "Fair market value of the part disposed of",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "ca_cca" }, SELLER, { fieldEquals: { name: "allocationMethod", values: ["fmv_prorata"] } }] },
    requiredWhen: { all: [{ regime: "ca_cca" }, SELLER, { fieldEquals: { name: "allocationMethod", values: ["fmv_prorata"] } }] },
  },
  {
    name: "retainedFairMarketValue",
    label: "Fair market value of the part retained",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "ca_cca" }, SELLER, { fieldEquals: { name: "allocationMethod", values: ["fmv_prorata"] } }] },
    requiredWhen: { all: [{ regime: "ca_cca" }, SELLER, { fieldEquals: { name: "allocationMethod", values: ["fmv_prorata"] } }] },
  },
  {
    name: "statutoryProceeds",
    label: "Actual proceeds / amount realized",
    kind: "decimal",
    visibleWhen: { all: [SELLER, { any: [{ regime: "ca_cca" }, { regime: "uk_wda" }, { regime: "us_macrs" }] }] },
    requiredWhen: { all: [SELLER, { any: [
      { all: [{ regime: "ca_cca" }, { not: { fieldEquals: { name: "rolloverElection", values: ["s85", "s97", "other"] } } }] },
      { all: [{ regime: "uk_wda" }, { relationship: "arms_length" }] },
      { all: [{ regime: "us_macrs" }, { fieldEquals: { name: "recognition", values: ["taxable"] } }] },
    ] }] },
    help: "Enter the actual proceeds. ITA 69(1)(b)(i) substitutes FMV only when CA non-arm's-length proceeds are nil or below FMV; above-FMV proceeds are not reduced. US Pub 544 amount realized is money plus FMV of other property or services plus assumed liabilities — not the FMV of the transferred asset merely because related.",
  },
  {
    name: "fairMarketValue",
    label: "Fair market value",
    kind: "decimal",
    visibleWhen: { any: [
      { all: [{ regime: "ca_cca" }, { relationship: "non_arms_length" }] },
      { all: [{ regime: "ca_cca" }, { fieldEquals: { name: "allocationMethod", values: ["fmv_prorata"] } }] },
      { all: [{ regime: "uk_wda" }, { fieldTrue: "saleBelowMarket" }] },
      { all: [{ regime: "au_pool" }, { relationship: "non_arms_length" }] },
    ] },
    requiredWhen: { any: [
      { all: [{ regime: "ca_cca" }, { relationship: "non_arms_length" }, { not: { fieldEquals: { name: "rolloverElection", values: ["s85", "s97", "other"] } } }] },
      { all: [{ regime: "uk_wda" }, { fieldTrue: "saleBelowMarket" }, { not: { fieldTrue: "buyerCanClaimPma" } }] },
      { all: [{ regime: "au_pool" }, { relationship: "non_arms_length" }] },
    ] },
    help: "ITA 69(1) comparison value / CAA 2001 s.61 item 2 / ITAA 1997 s.40-300 item 6. Separate from the CRA 13(7)(e) payment-versus-seller-cost rule. Not the US amount realized.",
  },
  {
    name: "payment",
    label: "Amount paid (consideration)",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "ca_cca" }, BUYER] },
    requiredWhen: { all: [{ regime: "ca_cca" }, BUYER] },
    help: "ITA 69(1)(a) first caps an excessive purchase at FMV. 13(7)(e) then compares that deemed payment to the seller's original cost, not to FMV. Buyer capital cost — not collected on a sale to a customer.",
  },
  {
    name: "sellerOriginalCapitalCost",
    label: "Seller's original capital cost",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "ca_cca" }, { relationship: "non_arms_length" }, BUYER] },
    requiredWhen: { all: [{ regime: "ca_cca" }, { relationship: "non_arms_length" }, BUYER] },
  },
  {
    name: "transferorCharacter",
    label: "Transferor tax character",
    kind: "enum",
    choices: [
      { value: "resident_individual", label: "Resident individual (CGE worksheet)" },
      { value: "resident_partnership", label: "Certain resident partnership (CGE worksheet)" },
      { value: "corporation", label: "Corporation" },
      { value: "nonresident", label: "Non-resident" },
      { value: "other_partnership", label: "Other partnership" },
    ],
    visibleWhen: { all: [{ regime: "ca_cca" }, { relationship: "non_arms_length" }, BUYER] },
    requiredWhen: { all: [{ regime: "ca_cca" }, { relationship: "non_arms_length" }, BUYER] },
    help: "CRA uses the CGE worksheet for resident individuals/certain partnerships and the other worksheet for corporations, non-residents and other partnerships.",
  },
  {
    name: "capitalGainsDeductionClaimed",
    label: "Capital gains deduction claimed on this property",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "ca_cca" }, { relationship: "non_arms_length" }, BUYER, { fieldEquals: { name: "transferorCharacter", values: ["resident_individual", "resident_partnership"] } }] },
    requiredWhen: { all: [{ regime: "ca_cca" }, { relationship: "non_arms_length" }, BUYER, { fieldEquals: { name: "transferorCharacter", values: ["resident_individual", "resident_partnership"] } }] },
    help: "Independently assessed on the transferor's return. Cannot be derived here. Enter 0.00 when none was claimed.",
  },
  {
    name: "rolloverElection",
    label: "Rollover election",
    kind: "enum",
    choices: labeledChoices(CA_ROLLOVERS, {
      none: "No rollover",
      s85: "Subsection 85(1) election",
      s97: "Subsection 97(2) election",
      other: "Other rollover election",
    }),
    visibleWhen: { regime: "ca_cca" },
    requiredWhen: { regime: "ca_cca" },
  },
  {
    name: "electedAmount",
    label: "Elected rollover amount",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "ca_cca" }, { fieldEquals: { name: "rolloverElection", values: ["s85", "s97", "other"] } }] },
    requiredWhen: { all: [{ regime: "ca_cca" }, { fieldEquals: { name: "rolloverElection", values: ["s85", "s97", "other"] } }] },
  },
  {
    name: "qualifyingExpenditure",
    label: "Qualifying expenditure of this person",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "uk_wda" }, SELLER] },
    requiredWhen: { all: [{ regime: "uk_wda" }, SELLER] },
  },
  {
    name: "allocatedQualifyingExpenditure",
    label: "Qualifying expenditure of the part disposed of",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "uk_wda" }, SELLER] },
    requiredWhen: { never: true },
  },
  {
    name: "saleBelowMarket",
    label: "Sold at less than market value",
    kind: "boolean",
    visibleWhen: { all: [{ regime: "uk_wda" }, SELLER] },
    requiredWhen: { all: [{ regime: "uk_wda" }, SELLER] },
  },
  {
    name: "buyerCanClaimPma",
    label: "Buyer can claim plant and machinery allowances",
    kind: "boolean",
    visibleWhen: { all: [{ regime: "uk_wda" }, SELLER] },
    requiredWhen: { all: [{ regime: "uk_wda" }, SELLER] },
  },
  {
    name: "connectedChain",
    label: "Acquired in a connected-person chain",
    kind: "boolean",
    visibleWhen: { all: [{ regime: "uk_wda" }, SELLER] },
    requiredWhen: { all: [{ regime: "uk_wda" }, SELLER] },
  },
  {
    name: "greatestQualifyingExpenditureInChain",
    label: "Greatest qualifying expenditure in the connected chain",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "uk_wda" }, SELLER, { fieldTrue: "connectedChain" }] },
    requiredWhen: { all: [{ regime: "uk_wda" }, SELLER, { fieldTrue: "connectedChain" }] },
    help: "CAA 2001 s.62 / HMRC CA23250. This is the disposal-value cap, not the buyer's price.",
  },
  {
    name: "buyerQualifyingExpenditure",
    label: "Buyer's qualifying expenditure",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "uk_wda" }, BUYER] },
    requiredWhen: { all: [{ regime: "uk_wda" }, BUYER] },
  },
  {
    name: "taxableUsePercent",
    label: "Taxable-use percent",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "au_pool" }, SELLER] },
    requiredWhen: { all: [{ regime: "au_pool" }, SELLER] },
  },
  {
    name: "terminationValue",
    label: "Termination value (arm's-length proceeds)",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "au_pool" }, SELLER] },
    requiredWhen: { all: [{ regime: "au_pool" }, SELLER, { relationship: "arms_length" }] },
  },
  {
    name: "allocatedCost",
    label: "Allocated cost of the part",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "au_pool" }, SELLER] },
    requiredWhen: { never: true },
  },
  {
    name: "buyerCost",
    label: "Buyer's first-element cost",
    kind: "decimal",
    visibleWhen: { all: [{ any: [{ regime: "au_pool" }, { regime: "us_macrs" }] }, BUYER] },
    requiredWhen: { any: [
      { all: [{ regime: "au_pool" }, BUYER] },
      { all: [{ regime: "us_macrs" }, BUYER, { fieldEquals: { name: "recognition", values: ["taxable"] } }] },
    ] },
  },
  {
    name: "consideration",
    label: "Consideration derived on disposal",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "nz_pool" }, SELLER] },
    requiredWhen: { all: [{ regime: "nz_pool" }, SELLER] },
  },
  {
    name: "disposalExpenditure",
    label: "Expenditure incurred in deriving the consideration",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "nz_pool" }, SELLER] },
    requiredWhen: { all: [{ regime: "nz_pool" }, SELLER] },
  },
  {
    name: "buyerPrice",
    label: "Price paid by the buyer",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "nz_pool" }, BUYER] },
    requiredWhen: { all: [{ regime: "nz_pool" }, BUYER] },
  },
  {
    name: "associatedPersonCostBasis",
    label: "Associate's cost-base measure",
    kind: "enum",
    choices: [
      { value: "original_cost", label: "Price the associate originally paid" },
      { value: "first_business_use_fmv", label: "Market value when the associate was first entitled to depreciate" },
    ],
    visibleWhen: { all: [{ regime: "nz_pool" }, { relationship: "non_arms_length" }, BUYER] },
    requiredWhen: { all: [{ regime: "nz_pool" }, { relationship: "non_arms_length" }, BUYER, { not: { fieldTrue: "commissionerActualCost" } }, { not: { fieldTrue: "consolidatingGroupAtv" } }] },
  },
  {
    name: "associatedPersonOriginalCost",
    label: "Associate's original cost",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "nz_pool" }, BUYER, { fieldEquals: { name: "associatedPersonCostBasis", values: ["original_cost"] } }] },
    requiredWhen: { all: [{ regime: "nz_pool" }, { relationship: "non_arms_length" }, BUYER, { fieldEquals: { name: "associatedPersonCostBasis", values: ["original_cost"] } }, { not: { fieldTrue: "commissionerActualCost" } }, { not: { fieldTrue: "consolidatingGroupAtv" } }] },
  },
  {
    name: "firstBusinessUseFairMarketValue",
    label: "Market value at the associate's first depreciable use",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "nz_pool" }, BUYER, { fieldEquals: { name: "associatedPersonCostBasis", values: ["first_business_use_fmv"] } }] },
    requiredWhen: { all: [{ regime: "nz_pool" }, BUYER, { fieldEquals: { name: "associatedPersonCostBasis", values: ["first_business_use_fmv"] } }] },
  },
  {
    name: "associatedPersonEquivalentRate",
    label: "Associate's equivalent depreciation rate",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "nz_pool" }, { relationship: "non_arms_length" }, BUYER] },
    requiredWhen: { all: [{ regime: "nz_pool" }, { relationship: "non_arms_length" }, BUYER] },
    help: "IR260: the buyer's rate cannot be higher than the associate's equivalent rate.",
  },
  {
    name: "commissionerActualCost",
    label: "Commissioner written approval to use the buyer's price",
    kind: "boolean",
    visibleWhen: { all: [{ regime: "nz_pool" }, BUYER] },
    requiredWhen: { all: [{ regime: "nz_pool" }, BUYER] },
    help: "An exception. Related/associated status alone is not this election. Buyer cost — not collected on a sale to a customer.",
  },
  {
    name: "commissionerApprovalEvidence",
    label: "Commissioner approval evidence",
    kind: "text",
    visibleWhen: { all: [{ regime: "nz_pool" }, BUYER, { fieldTrue: "commissionerActualCost" }] },
    requiredWhen: { all: [{ regime: "nz_pool" }, BUYER, { fieldTrue: "commissionerActualCost" }] },
  },
  {
    name: "consolidatingGroupAtv",
    label: "100% commonly-owned consolidating-group ATV transfer",
    kind: "boolean",
    visibleWhen: { all: [{ regime: "nz_pool" }, BUYER] },
    requiredWhen: { all: [{ regime: "nz_pool" }, BUYER] },
  },
  {
    name: "associatedPersonAtv",
    label: "Associate's adjusted tax value",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "nz_pool" }, BUYER, { fieldTrue: "consolidatingGroupAtv" }] },
    requiredWhen: { all: [{ regime: "nz_pool" }, BUYER, { fieldTrue: "consolidatingGroupAtv" }] },
  },
  {
    name: "dispositionTrigger",
    label: "MACRS partial-disposition trigger",
    kind: "enum",
    choices: [
      { value: "sale", label: "Sale of a portion (required — Treas. Reg. 1.168(i)-8(d)(1))" },
      { value: "section_168i7b", label: "§168(i)(7)(B) step-in-the-shoes transfer of a portion (required)" },
      { value: "casualty", label: "Casualty of a portion (required)" },
      { value: "like_kind_1031", label: "§1031 like-kind exchange of a portion (required)" },
      { value: "involuntary_1033", label: "§1033 involuntary conversion of a portion (required)" },
      { value: "elective_other", label: "Other partial disposition (election required)" },
    ],
    visibleWhen: { all: [{ regime: "us_macrs" }, SELLER] },
    requiredWhen: { all: [{ regime: "us_macrs" }, SELLER] },
    help: "A native partial_disposal is a sale of a portion. Do not require an election for that trigger.",
  },
  {
    name: "partialDispositionElection",
    label: "Partial disposition election under Treas. Reg. 1.168(i)-8(d)",
    kind: "boolean",
    visibleWhen: { all: [{ regime: "us_macrs" }, SELLER, { fieldEquals: { name: "dispositionTrigger", values: ["elective_other"] } }] },
    requiredWhen: { all: [{ regime: "us_macrs" }, SELLER, { fieldEquals: { name: "dispositionTrigger", values: ["elective_other"] } }] },
  },
  {
    name: "originalUnadjustedBasis",
    label: "Original unadjusted depreciable basis",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "us_macrs" }, US_ORIGINAL_STATUTORY] },
    requiredWhen: { all: [{ regime: "us_macrs" }, US_ORIGINAL_STATUTORY] },
    help: "Required on the first seller declaration and on a buyer-only nontaxable carryover. After frozen seller history is ready, the server derives this as the sum of open vintage unadjusted bases — do not invent a composite vintage.",
  },
  {
    name: "remainingUnadjustedBasis",
    label: "Remaining unadjusted basis (same vintage)",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "us_macrs" }, US_SELLER_SPLIT_AMOUNTS] },
    requiredWhen: { all: [{ regime: "us_macrs" }, US_SELLER_SPLIT_AMOUNTS] },
    help: "Continues the original placed-in-service date, method and convention. When frozen history is ready, this is the sum of vintageAllocations.remainingUnadjustedBasis — identify each vintage by source, placedInServiceOn, transferOn and parentKey; do not match a vintage by amount.",
  },
  {
    name: "disposedUnadjustedBasis",
    label: "Disposed unadjusted basis (same vintage)",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "us_macrs" }, US_SELLER_SPLIT_AMOUNTS] },
    requiredWhen: { all: [{ regime: "us_macrs" }, US_SELLER_SPLIT_AMOUNTS] },
    help: "When frozen history is ready, this is the sum of vintageAllocations.disposedUnadjustedBasis. Record one allocation row per open vintage; do not FIFO-allocate carryover and excess.",
  },
  {
    name: "placedInServiceOn",
    label: "Original placed-in-service date",
    kind: "date",
    visibleWhen: { all: [{ regime: "us_macrs" }, US_TRANSFEROR_HISTORY] },
    requiredWhen: { all: [{ regime: "us_macrs" }, US_TRANSFEROR_HISTORY] },
    help: "Required on the first seller declaration and on a nontaxable buyer carryover before seller history is ready. Ready history freezes each disposed vintage's date, method, convention and recovery — do not retype a composite header.",
  },
  {
    name: "recoveryPeriodYears",
    label: "Recovery period (years)",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "us_macrs" }, US_TRANSFEROR_HISTORY] },
    requiredWhen: { all: [{ regime: "us_macrs" }, US_TRANSFEROR_HISTORY] },
    help: "Required on the first seller declaration and on a nontaxable buyer carryover before seller history is ready. Ready history freezes each disposed vintage's recovery — do not invent a composite schedule.",
  },
  {
    name: "method",
    label: "MACRS method",
    kind: "enum",
    choices: labeledChoices(MACRS_METHODS, {
      "200_db": "200% declining balance",
      "150_db": "150% declining balance",
      straight_line: "Straight line",
    }),
    visibleWhen: { all: [{ regime: "us_macrs" }, US_TRANSFEROR_HISTORY] },
    requiredWhen: { all: [{ regime: "us_macrs" }, US_TRANSFEROR_HISTORY] },
    help: "Required on the first seller declaration and on a nontaxable buyer carryover before seller history is ready. Ready history freezes each disposed vintage's method — do not invent a composite schedule.",
  },
  {
    name: "convention",
    label: "MACRS convention",
    kind: "enum",
    choices: labeledChoices(MACRS_CONVENTIONS, {
      half_year: "Half-year",
      mid_quarter: "Mid-quarter",
      mid_month: "Mid-month",
    }),
    visibleWhen: { all: [{ regime: "us_macrs" }, US_TRANSFEROR_HISTORY] },
    requiredWhen: { all: [{ regime: "us_macrs" }, US_TRANSFEROR_HISTORY] },
    help: "Required on the first seller declaration and on a nontaxable buyer carryover before seller history is ready. Ready history freezes each disposed vintage's convention — do not invent a composite schedule.",
  },
  {
    name: "recognition",
    label: "Recognition",
    kind: "enum",
    choices: [
      { value: "taxable", label: "Taxable transfer" },
      { value: "nontaxable", label: "Nontaxable transfer (carryover history)" },
    ],
    visibleWhen: { regime: "us_macrs" },
    requiredWhen: { regime: "us_macrs" },
    help: "An intercompany book transfer is not nontaxable by default.",
  },
  {
    name: "section168i7Kind",
    label: "§168(i)(7) transfer kind",
    kind: "enum",
    choices: labeledChoices(US_SECTION_168I7_KINDS, {
      nonrecognition: "§168(i)(7)(B)(i) 332/351/361/721/731 — monthly months-held allocation",
      partnership_721_prior_interest: "§721(a) where another partner already had a depreciable interest — bonus stays with the transferor",
      consolidated_group: "§168(i)(7)(B)(ii) consolidated-group member transfer — no monthly split",
    }),
    visibleWhen: { all: [{ regime: "us_macrs" }, { fieldEquals: { name: "recognition", values: ["nontaxable"] } }] },
    requiredWhen: { all: [{ regime: "us_macrs" }, { fieldEquals: { name: "recognition", values: ["nontaxable"] } }] },
    help: "26 CFR 1.168(d)-1(b)(7) monthly allocation does not apply between consolidated-group members. Ordinary half-year disposal is not this allocation.",
  },
  {
    name: "relatedPerson",
    label: "Related person (Pub 946 / §179 / §267)",
    kind: "boolean",
    visibleWhen: { regime: "us_macrs" },
    requiredWhen: { regime: "us_macrs" },
  },
  {
    name: "amountRealizedRule",
    label: "Amount realized rule",
    kind: "enum",
    choices: labeledChoices(US_AMOUNT_REALIZED_RULES, {
      amount_realized: "Pub 544 amount realized (money + FMV of other property or services + assumed liabilities)",
      section_482: "Section 482 deemed-value adjustment (evidenced)",
      other_evidenced: "Other independently evidenced deemed-value adjustment",
    }),
    visibleWhen: { all: [{ regime: "us_macrs" }, SELLER, { fieldEquals: { name: "recognition", values: ["taxable"] } }] },
    requiredWhen: { all: [{ regime: "us_macrs" }, SELLER, { fieldEquals: { name: "recognition", values: ["taxable"] } }] },
    help: "Related-person status does not replace amount realized with the FMV of the transferred asset. A §482 or other deemed-value adjustment must be independently evidenced.",
  },
  {
    name: "adjustedAmountRealized",
    label: "Adjusted amount realized",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "us_macrs" }, { fieldEquals: { name: "amountRealizedRule", values: ["section_482", "other_evidenced"] } }] },
    requiredWhen: { all: [{ regime: "us_macrs" }, { fieldEquals: { name: "amountRealizedRule", values: ["section_482", "other_evidenced"] } }] },
  },
  {
    name: "deemedValueAdjustmentEvidence",
    label: "Deemed-value adjustment evidence",
    kind: "text",
    visibleWhen: { all: [{ regime: "us_macrs" }, { fieldEquals: { name: "amountRealizedRule", values: ["section_482", "other_evidenced"] } }] },
    requiredWhen: { all: [{ regime: "us_macrs" }, { fieldEquals: { name: "amountRealizedRule", values: ["section_482", "other_evidenced"] } }] },
    help: "Related-person status alone is not this evidence.",
  },
  {
    name: "carryoverBasis",
    label: "Carryover basis",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "us_macrs" }, US_CARRYOVER_ELECTIONS] },
    requiredWhen: { all: [{ regime: "us_macrs" }, US_CARRYOVER_ELECTIONS] },
    help: "Required on a nontaxable buyer carryover before seller history is ready. Ready history derives this checkpoint from each disposed vintage — do not retype a composite carryover.",
  },
  {
    name: "excessBasis",
    label: "Excess basis (newly placed)",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "us_macrs" }, BUYER, { fieldEquals: { name: "recognition", values: ["nontaxable"] } }] },
    requiredWhen: { all: [{ regime: "us_macrs" }, BUYER, { fieldEquals: { name: "recognition", values: ["nontaxable"] } }] },
  },
  {
    name: "section179",
    label: "Section 179 (allocated historical election)",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "us_macrs" }, US_CARRYOVER_ELECTIONS] },
    requiredWhen: { all: [{ regime: "us_macrs" }, US_CARRYOVER_ELECTIONS] },
    help: "Declare the transferor's §179 allocated to this slice. Missing receiving or foreign tax-depreciation JSON is not a zero election — do not copy the whole source-asset election onto a partial.",
  },
  {
    name: "bonusPercent",
    label: "Bonus depreciation percent (allocated historical election)",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "us_macrs" }, US_CARRYOVER_ELECTIONS] },
    requiredWhen: { all: [{ regime: "us_macrs" }, US_CARRYOVER_ELECTIONS] },
    help: "Declare the transferor's bonus percent for this slice. Absence must be supplied; it is not zero.",
  },
  {
    name: "businessUsePercent",
    label: "Business-use percent (allocated historical election)",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "us_macrs" }, US_CARRYOVER_ELECTIONS] },
    requiredWhen: { all: [{ regime: "us_macrs" }, US_CARRYOVER_ELECTIONS] },
  },
  {
    name: "priorDepreciation",
    label: "Prior MACRS depreciation (this slice)",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "us_macrs" }, US_CARRYOVER_ELECTIONS] },
    requiredWhen: { all: [{ regime: "us_macrs" }, US_CARRYOVER_ELECTIONS] },
    help: "MACRS already taken on this slice before the transfer. The declared carryover is the buyer opening checkpoint; do not re-subtract this amount from it.",
  },
  {
    name: "shortYearMethod",
    label: "Short-year method (Pub 946 / Rev. Proc. 89-15)",
    kind: "enum",
    choices: labeledChoices(US_SHORT_YEAR_METHODS, {
      simplified: "Simplified method (Pub 946)",
      allocation: "Allocation method (Rev. Proc. 89-15)",
    }),
    visibleWhen: { regime: "us_macrs" },
    requiredWhen: { never: true },
  },
];

export type TaxBasisDraft = Record<string, unknown> & {
  regime?: string;
  relationship?: string;
  /** From the selected source choice — not an operator-typed field. */
  sourceOperation?: TaxBasisSourceOperation;
  /** From the selected source regime row — classified seller/receiver, not an election. */
  applicable?: TaxBasisApplicableSide;
  /** From the selected source's openMacrsVintages.status — not an election. */
  usSellerMacrsStatus?: UsSellerMacrsVintageStatus;
};

/** Buyer capital-cost / first-element / associate-cost facts. Hidden on a
 *  customer partial_disposal; required only when the receiving asset is ours. */
export const TAX_BASIS_BUYER_FIELD_NAMES = [
  "payment",
  "sellerOriginalCapitalCost",
  "transferorCharacter",
  "capitalGainsDeductionClaimed",
  "buyerQualifyingExpenditure",
  "buyerCost",
  "buyerPrice",
  "associatedPersonCostBasis",
  "associatedPersonOriginalCost",
  "firstBusinessUseFairMarketValue",
  "associatedPersonEquivalentRate",
  "commissionerActualCost",
  "commissionerApprovalEvidence",
  "consolidatingGroupAtv",
  "associatedPersonAtv",
  "carryoverBasis",
  "excessBasis",
  "section179",
  "bonusPercent",
  "businessUsePercent",
  "priorDepreciation",
] as const;

export function attachTaxBasisSource(
  draft: TaxBasisDraft,
  context: TaxBasisSourceContext,
): TaxBasisDraft {
  return {
    ...draft,
    sourceOperation: context.sourceOperation,
    applicable: context.applicable,
    ...(context.usSellerMacrs
      ? { usSellerMacrsStatus: context.usSellerMacrs.status }
      : {}),
  };
}

export function matchTaxBasisPredicate(predicate: TaxBasisFieldPredicate, draft: TaxBasisDraft): boolean {
  if ("always" in predicate) return true;
  if ("never" in predicate) return false;
  if ("regime" in predicate) return draft.regime === predicate.regime;
  if ("relationship" in predicate) return draft.relationship === predicate.relationship;
  if ("sourceOperation" in predicate) return draft.sourceOperation === predicate.sourceOperation;
  if ("side" in predicate) return taxBasisSideApplies(draft.applicable, predicate.side);
  if ("fieldEquals" in predicate) return predicate.fieldEquals.values.includes(String(draft[predicate.fieldEquals.name] ?? ""));
  if ("fieldTrue" in predicate) return draft[predicate.fieldTrue] === true;
  if ("usSellerMacrsStatus" in predicate) return draft.usSellerMacrsStatus === predicate.usSellerMacrsStatus;
  if ("all" in predicate) return predicate.all.every((item) => matchTaxBasisPredicate(item, draft));
  if ("any" in predicate) return predicate.any.some((item) => matchTaxBasisPredicate(item, draft));
  return !matchTaxBasisPredicate(predicate.not, draft);
}

export function taxBasisFieldVisible(field: TaxBasisFieldMeta, draft: TaxBasisDraft): boolean {
  return matchTaxBasisPredicate(field.visibleWhen, draft);
}

export function taxBasisFieldRequired(field: TaxBasisFieldMeta, draft: TaxBasisDraft): boolean {
  return taxBasisFieldVisible(field, draft) && matchTaxBasisPredicate(field.requiredWhen, draft);
}

const ALLOWED_KEYS: Record<TaxBasisRegime, readonly string[]> = {
  ca_cca: [
    "regime", "relationship", "originalCapitalCost", "allocationMethod", "allocatedCapitalCost",
    "allocationFraction", "allocationReason", "partFairMarketValue", "retainedFairMarketValue",
    "statutoryProceeds", "fairMarketValue", "payment", "sellerOriginalCapitalCost",
    "transferorCharacter",
    "capitalGainsDeductionClaimed", "rolloverElection", "electedAmount",
  ],
  uk_wda: [
    "regime", "relationship", "qualifyingExpenditure", "allocatedQualifyingExpenditure",
    "statutoryProceeds", "fairMarketValue", "saleBelowMarket", "buyerCanClaimPma",
    "connectedChain", "greatestQualifyingExpenditureInChain", "buyerQualifyingExpenditure",
  ],
  au_pool: [
    "regime", "relationship", "taxableUsePercent", "terminationValue", "fairMarketValue",
    "allocatedCost", "buyerCost",
  ],
  nz_pool: [
    "regime", "relationship", "consideration", "disposalExpenditure", "buyerPrice",
    "associatedPersonCostBasis", "associatedPersonOriginalCost", "firstBusinessUseFairMarketValue",
    "associatedPersonEquivalentRate", "commissionerActualCost", "commissionerApprovalEvidence",
    "consolidatingGroupAtv", "associatedPersonAtv",
  ],
  us_macrs: [
    "regime", "relationship", "dispositionTrigger", "partialDispositionElection",
    "originalUnadjustedBasis", "remainingUnadjustedBasis", "disposedUnadjustedBasis",
    "placedInServiceOn", "recoveryPeriodYears", "method", "convention", "recognition",
    "section168i7Kind",
    "relatedPerson", "statutoryProceeds", "amountRealizedRule", "adjustedAmountRealized",
    "deemedValueAdjustmentEvidence", "buyerCost", "carryoverBasis", "excessBasis",
    "section179", "bonusPercent", "businessUsePercent", "priorDepreciation",
    "shortYearMethod", "vintageAllocations",
  ],
};

export function moneyExact(value: unknown, name: string): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new TaxBasisPolicyError(`${name} must be an exact decimal`);
  try {
    return normalizeMoney(exact);
  } catch {
    throw new TaxBasisPolicyError(`${name} must be an exact decimal`);
  }
}

function requireMoney(draft: TaxBasisDraft, name: string): string {
  if (draft[name] == null || draft[name] === "") {
    throw new TaxBasisPolicyError(`${name} is required for this ${String(draft.regime)} treatment`);
  }
  return validateDeclaredDecimal(name, draft[name]);
}

function optionalMoney(draft: TaxBasisDraft, name: string): string | undefined {
  if (draft[name] == null || draft[name] === "") return undefined;
  return validateDeclaredDecimal(name, draft[name]);
}

/** Declared cost, basis, proceeds and rates are nonnegative. A signed NZ
 *  pool reduction is computed from consideration − disposal expenditure. */
export function validateDeclaredDecimal(name: string, value: unknown): string {
  const amount = moneyExact(value, name);
  if (name === "allocationFraction") {
    if (cmp(amount, "0") <= 0 || cmp(amount, "1") > 0) {
      throw new TaxBasisPolicyError("allocationFraction must be greater than 0 and at most 1");
    }
    return amount;
  }
  if (name === "taxableUsePercent" || name === "bonusPercent" || name === "businessUsePercent") {
    if (cmp(amount, "0") < 0 || cmp(amount, "100") > 0) {
      throw new TaxBasisPolicyError(`${name} must be between 0 and 100`);
    }
    return amount;
  }
  if (name === "recoveryPeriodYears" || name === "associatedPersonEquivalentRate") {
    if (cmp(amount, "0") <= 0) {
      throw new TaxBasisPolicyError(`${name} must be greater than 0`);
    }
    return amount;
  }
  if (cmp(amount, "0") < 0) {
    throw new TaxBasisPolicyError(
      `${name} must be nonnegative; a signed net is computed from declared facts (for example NZ consideration less disposal expenditure), not entered as a negative cost, basis, proceeds or rate`,
    );
  }
  return amount;
}

const DRAFT_CONTEXT_KEYS = new Set(["sourceOperation", "applicable", "usSellerMacrsStatus"]);

/** Server-derived facts. Never declared on a workpaper request; validate
 *  always drops an incoming copy and reconstructs from history or
 *  effectiveOn. */
export const DERIVED_TAX_REGIME_FACT_KEYS = [
  "buyerVintages",
  "capitalGainsInclusionRate",
  "capitalGainsInclusionRateCitation",
] as const;

export function declaredTaxRegimeFacts<T extends TaxRegimeBasis>(row: T): T {
  return stripDerivedTaxRegimeFacts(row as TaxBasisDraft) as T;
}

function stripDerivedTaxRegimeFacts(draft: TaxBasisDraft): TaxBasisDraft {
  const {
    buyerVintages: _buyerVintages,
    capitalGainsInclusionRate: _capitalGainsInclusionRate,
    capitalGainsInclusionRateCitation: _capitalGainsInclusionRateCitation,
    ...declared
  } = draft;
  return declared;
}

/** Calendar date without importing platform (that module pulls the database). */
export function isTaxBasisCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const VINTAGE_ALLOCATION_KEYS = [
  "source",
  "placedInServiceOn",
  "transferOn",
  "parentKey",
  "disposedUnadjustedBasis",
  "remainingUnadjustedBasis",
] as const;

/** Parse operator-declared per-vintage splits. An empty array is not a
 *  silent whole-vintage match. */
export function parseMacrsVintageAllocations(value: unknown): MacrsVintageAllocationInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TaxBasisPolicyError(
      "vintageAllocations must identify each open MACRS vintage; do not infer a split by matching disposed basis to a vintage amount",
    );
  }
  const seen = new Set<string>();
  return value.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new TaxBasisPolicyError(`vintageAllocations[${index}] must be an object`);
    }
    const raw = row as Record<string, unknown>;
    const unknown = Object.keys(raw).filter(
      (key) => !(VINTAGE_ALLOCATION_KEYS as readonly string[]).includes(key),
    );
    if (unknown.length > 0) {
      throw new TaxBasisPolicyError(
        `unknown vintageAllocations[${index}] field(s): ${unknown.sort().join(", ")}`,
      );
    }
    if (!(MACRS_VINTAGE_SOURCES as readonly string[]).includes(String(raw.source ?? ""))) {
      throw new TaxBasisPolicyError(
        `vintageAllocations[${index}].source must be one of ${MACRS_VINTAGE_SOURCES.join(", ")}`,
      );
    }
    const source = raw.source as MacrsVintageSource;
    if (!isTaxBasisCalendarDate(raw.placedInServiceOn)) {
      throw new TaxBasisPolicyError(
        `vintageAllocations[${index}].placedInServiceOn must be a calendar date (YYYY-MM-DD)`,
      );
    }
    if (source !== "original") {
      if (raw.transferOn == null || raw.transferOn === "") {
        throw new TaxBasisPolicyError(
          `vintageAllocations[${index}].transferOn is required for a ${source} vintage so two buyer vintages placed on the same day are not collapsed`,
        );
      }
      if (!isTaxBasisCalendarDate(raw.transferOn)) {
        throw new TaxBasisPolicyError(
          `vintageAllocations[${index}].transferOn must be a calendar date (YYYY-MM-DD)`,
        );
      }
    } else if (raw.transferOn != null && raw.transferOn !== "" && !isTaxBasisCalendarDate(raw.transferOn)) {
      throw new TaxBasisPolicyError(
        `vintageAllocations[${index}].transferOn must be a calendar date (YYYY-MM-DD)`,
      );
    }
    if (raw.parentKey != null && raw.parentKey !== "" && typeof raw.parentKey !== "string") {
      throw new TaxBasisPolicyError(
        `vintageAllocations[${index}].parentKey must identify the open vintage lineage`,
      );
    }
    if (source === "original" && raw.parentKey != null && raw.parentKey !== "") {
      throw new TaxBasisPolicyError(
        `vintageAllocations[${index}].parentKey is not used for an original vintage; identify it by placedInServiceOn`,
      );
    }
    const disposed = validateDeclaredDecimal(
      `vintageAllocations[${index}].disposedUnadjustedBasis`,
      raw.disposedUnadjustedBasis,
    );
    const remaining = validateDeclaredDecimal(
      `vintageAllocations[${index}].remainingUnadjustedBasis`,
      raw.remainingUnadjustedBasis,
    );
    const transferOn = source === "original"
      ? (isTaxBasisCalendarDate(raw.transferOn) ? raw.transferOn : null)
      : String(raw.transferOn);
    const parentKey = typeof raw.parentKey === "string" && raw.parentKey !== "" ? raw.parentKey : null;
    const key = macrsVintageKey({ source, placedInServiceOn: raw.placedInServiceOn, transferOn, parentKey });
    if (seen.has(key)) {
      throw new TaxBasisPolicyError(
        `vintageAllocations declares ${key} more than once; each open vintage is allocated exactly once`,
      );
    }
    seen.add(key);
    return {
      source,
      placedInServiceOn: raw.placedInServiceOn,
      transferOn,
      parentKey,
      disposedUnadjustedBasis: disposed,
      remainingUnadjustedBasis: remaining,
    };
  });
}

export function assertMacrsVintageAllocationTotals(
  allocations: readonly MacrsVintageAllocationInput[],
  disposedTotal: string,
  remainingTotal: string,
): void {
  const disposed = allocations.reduce((sum, row) => add(sum, row.disposedUnadjustedBasis), "0");
  const remaining = allocations.reduce((sum, row) => add(sum, row.remainingUnadjustedBasis), "0");
  if (cmp(disposed, disposedTotal) !== 0 || cmp(remaining, remainingTotal) !== 0) {
    throw new TaxBasisPolicyError(
      `vintageAllocations disposed ${formatMoney(disposed, 4)} and remaining ${formatMoney(remaining, 4)} must equal disposedUnadjustedBasis ${disposedTotal} and remainingUnadjustedBasis ${remainingTotal}; the header amounts are the sums, not a second vintage`,
    );
  }
}

/** Revalidate operator allocations against the reconstructed open vintages.
 *  A client-only check is not enough; propose and apply must call this. */
export function assertMacrsVintageAllocationsMatchOpen(
  allocations: readonly MacrsVintageAllocationInput[],
  open: readonly OpenMacrsVintage[],
): void {
  if (open.length === 0) {
    throw new TaxBasisPolicyError(
      "vintageAllocations cannot be checked against an empty vintage list; reconstruct the frozen history or declare the original statutory vintage — do not treat missing rows as a valid split",
    );
  }
  if (allocations.length !== open.length) {
    throw new TaxBasisPolicyError(
      `vintageAllocations must name every open MACRS vintage (${open.map((row) => row.key).join(", ")}); do not invent a composite vintage or omit a key`,
    );
  }
  const used = new Set<string>();
  for (const row of allocations) {
    const key = macrsVintageKey(row);
    const vintage = open.find((item) => item.key === key);
    if (!vintage) {
      throw new TaxBasisPolicyError(
        `vintageAllocations name ${key}, which is not an open MACRS vintage (${open.map((item) => item.key).join(", ")}); reconstruct from the frozen history — do not invent a vintage`,
      );
    }
    if (used.has(key)) {
      throw new TaxBasisPolicyError(`vintageAllocations name ${key} more than once`);
    }
    used.add(key);
    const slice = add(row.disposedUnadjustedBasis, row.remainingUnadjustedBasis);
    if (cmp(slice, vintage.unadjustedBasis) !== 0) {
      throw new TaxBasisPolicyError(
        `vintageAllocations for ${key} disposed ${row.disposedUnadjustedBasis} plus remaining ${row.remainingUnadjustedBasis} must equal that vintage's unadjusted basis ${vintage.unadjustedBasis}; do not invent a composite basis`,
      );
    }
  }
}

function resolveSourceOperation(
  draft: TaxBasisDraft,
  context?: TaxBasisValidationContext,
): TaxBasisSourceOperation {
  const sourceOperation = context?.sourceOperation ?? draft.sourceOperation;
  if (!sourceOperation || !TAX_BASIS_SOURCE_OPERATIONS.includes(sourceOperation)) {
    throw new TaxBasisPolicyError(
      "sourceOperation is required to decide buyer-side facts — set it from the selected source change (partial_disposal or intercompany_transfer). Do not type it as a UUID",
    );
  }
  return sourceOperation;
}

function resolveApplicable(
  draft: TaxBasisDraft,
  context: TaxBasisValidationContext | undefined,
  sourceOperation: TaxBasisSourceOperation,
): TaxBasisApplicableSide {
  const regime = draft.regime as TaxBasisRegime | undefined;
  const applicable =
    (regime ? context?.applicableByRegime?.[regime] : undefined) ??
    context?.applicable ??
    draft.applicable;
  if (applicable && (TAX_BASIS_APPLICABLE_SIDES as readonly string[]).includes(applicable)) {
    if (sourceOperation === "partial_disposal" && applicable !== "seller") {
      throw new TaxBasisPolicyError(
        "a customer partial_disposal has no receiving tax asset; applicable must be seller, derived from the source asset's classification",
      );
    }
    return applicable;
  }
  if (sourceOperation === "partial_disposal") return "seller";
  throw new TaxBasisPolicyError(
    "applicable is derived from the classified seller and receiving assets — set it from the selected source's regime row (seller, buyer, or both). Do not elect a side",
  );
}

function stripDraftContext(draft: TaxBasisDraft): TaxBasisDraft {
  const {
    sourceOperation: _sourceOperation,
    applicable: _applicable,
    usSellerMacrsStatus: _usSellerMacrsStatus,
    ...rest
  } = draft;
  return rest;
}

export function validateTaxRegimeBasis(
  input: unknown,
  context?: TaxBasisValidationContext,
): TaxRegimeBasis {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TaxBasisPolicyError("each regime workpaper must be an object");
  }
  const raw = stripDerivedTaxRegimeFacts(input as TaxBasisDraft);
  if (!TAX_BASIS_REGIMES.includes(raw.regime as TaxBasisRegime)) {
    throw new TaxBasisPolicyError(`unknown tax depreciation regime "${String(raw.regime ?? "")}"`);
  }
  const regime = raw.regime as TaxBasisRegime;
  const unknown = Object.keys(raw).filter(
    (key) => !ALLOWED_KEYS[regime].includes(key) && !DRAFT_CONTEXT_KEYS.has(key),
  );
  if (unknown.length > 0) {
    throw new TaxBasisPolicyError(`unknown ${regime} workpaper field(s): ${unknown.sort().join(", ")}`);
  }
  if (regime === "us_macrs" && context?.usSellerMacrs?.status === "history_refused") {
    throw new TaxBasisPolicyError(context.usSellerMacrs.refusal);
  }
  const sourceOperation = resolveSourceOperation(raw, context);
  const draft: TaxBasisDraft = {
    ...raw,
    sourceOperation,
    applicable: resolveApplicable(raw, context, sourceOperation),
    usSellerMacrsStatus: context?.usSellerMacrs?.status ?? raw.usSellerMacrsStatus,
  };
  for (const field of TAX_BASIS_FIELDS) {
    const supplied = draft[field.name] != null && draft[field.name] !== "";
    if (!taxBasisFieldRequired(field, draft) && !supplied) continue;
    if (!supplied) {
      throw new TaxBasisPolicyError(`${field.name} is required for this ${regime} treatment — ${field.label.toLowerCase()}`);
    }
    if (field.kind === "decimal") validateDeclaredDecimal(field.name, draft[field.name]);
    if (field.kind === "boolean" && typeof draft[field.name] !== "boolean") {
      throw new TaxBasisPolicyError(`${field.name} must be true or false`);
    }
    if (field.kind === "date" && !isTaxBasisCalendarDate(draft[field.name])) {
      throw new TaxBasisPolicyError(`${field.name} must be a calendar date (YYYY-MM-DD)`);
    }
    if (field.choices && !field.choices.some((choice) => choice.value === String(draft[field.name]))) {
      throw new TaxBasisPolicyError(`${field.name} must be one of ${field.choices.map((choice) => choice.value).join(", ")}`);
    }
  }
  if (regime === "ca_cca") return validateCa(draft);
  if (regime === "uk_wda") return validateUk(draft);
  if (regime === "au_pool") return validateAu(draft);
  if (regime === "nz_pool") return validateNz(draft);
  return validateUs(draft, context);
}

function validateCa(draft: TaxBasisDraft): CaCcaRegimeBasis {
  if (taxBasisSideApplies(draft.applicable, "seller")) {
    if (draft.originalCapitalCost != null && draft.originalCapitalCost !== "") {
      const original = validateDeclaredDecimal("originalCapitalCost", draft.originalCapitalCost);
      if (draft.allocatedCapitalCost != null && draft.allocatedCapitalCost !== "") {
        const allocated = validateDeclaredDecimal("allocatedCapitalCost", draft.allocatedCapitalCost);
        if (cmp(allocated, original) > 0) {
          throw new TaxBasisPolicyError(
            `allocatedCapitalCost ${allocated} cannot exceed originalCapitalCost ${original}`,
          );
        }
      }
    }
    if (draft.relationship === "non_arms_length" && draft.rolloverElection === "none") {
      if (draft.fairMarketValue == null || draft.fairMarketValue === "") {
        throw new TaxBasisPolicyError(
          "a non-arm's-length CCA transfer without a rollover must declare fairMarketValue so ITA 69(1)(b)(i) can lift nil or below-FMV proceeds; above-FMV actual proceeds are not reduced",
        );
      }
      if (draft.statutoryProceeds == null || draft.statutoryProceeds === "") {
        throw new TaxBasisPolicyError(
          "a non-arm's-length CCA transfer without a rollover must declare actual statutoryProceeds (0.00 if none) so ITA 69(1)(b)(i) does not silently replace above-FMV proceeds with FMV",
        );
      }
    }
  }
  if (draft.capitalGainsInclusionRate != null && draft.capitalGainsInclusionRate !== "") {
    throw new TaxBasisPolicyError(
      "capitalGainsInclusionRate is ITA 38(a) ordinary one-half, not an operator election; the engine derives and freezes it from the source effective date",
    );
  }
  if (
    taxBasisSideApplies(draft.applicable, "buyer") &&
    draft.relationship === "non_arms_length" &&
    draft.sourceOperation === "intercompany_transfer"
  ) {
    const character = draft.transferorCharacter as CaTransferorCharacter;
    if (
      (character === "corporation" || character === "nonresident" || character === "other_partnership") &&
      draft.capitalGainsDeductionClaimed != null
    ) {
      throw new TaxBasisPolicyError(
        "capitalGainsDeductionClaimed belongs only on the resident-individual/certain-partnership worksheet; do not enter it for a corporation, non-resident or other partnership",
      );
    }
  }
  return stripDraftContext(draft) as unknown as CaCcaRegimeBasis;
}

function validateUk(draft: TaxBasisDraft): UkWdaRegimeBasis {
  if (
    taxBasisSideApplies(draft.applicable, "seller") &&
    (typeof draft.saleBelowMarket !== "boolean" || typeof draft.buyerCanClaimPma !== "boolean" || typeof draft.connectedChain !== "boolean")
  ) {
    throw new TaxBasisPolicyError("UK saleBelowMarket, buyerCanClaimPma and connectedChain must be booleans");
  }
  return stripDraftContext(draft) as unknown as UkWdaRegimeBasis;
}

function validateAu(draft: TaxBasisDraft): AuPoolRegimeBasis {
  if (taxBasisSideApplies(draft.applicable, "seller")) {
    const percent = moneyExact(draft.taxableUsePercent, "taxableUsePercent");
    if (cmp(percent, "0") < 0 || cmp(percent, "100") > 0) {
      throw new TaxBasisPolicyError("taxableUsePercent must be between 0 and 100");
    }
  }
  return stripDraftContext(draft) as unknown as AuPoolRegimeBasis;
}

function validateNz(draft: TaxBasisDraft): NzPoolRegimeBasis {
  if (draft.commissionerActualCost === true && String(draft.commissionerApprovalEvidence ?? "").trim().length < 8) {
    throw new TaxBasisPolicyError(
      "commissionerActualCost requires written-approval evidence; associated-person status alone is not that approval",
    );
  }
  return stripDraftContext(draft) as unknown as NzPoolRegimeBasis;
}

function requireCarryoverElection(draft: TaxBasisDraft, name: string): string {
  if (draft[name] == null || draft[name] === "") {
    throw new TaxBasisPolicyError(
      `${name} is required for nontaxable MACRS carryover; declare the transferor's historical fact allocated to this slice — missing receiving or foreign tax-depreciation JSON is not a zero ${name}`,
    );
  }
  return validateDeclaredDecimal(name, draft[name]);
}

/** Declared carryover is the buyer opening. Original + allocated elections +
 *  prior depreciation must reconstruct it; a re-walked schedule must not. */
function macrsCheckpointReconstructed(args: {
  originalBasis: string;
  elected179: string;
  bonus: string;
  prior: string;
  remaining: string;
}): string {
  const postElection = formatMoney(add(args.originalBasis, neg(sum([args.elected179, args.bonus]))), 4);
  if (cmp(args.remaining, postElection) > 0) {
    return formatMoney(sum([args.prior, args.remaining]), 4);
  }
  return formatMoney(sum([args.elected179, args.bonus, args.prior, args.remaining]), 4);
}

function assertUsCarryoverCheckpoint(draft: TaxBasisDraft): void {
  const original = requireCarryoverElection(draft, "originalUnadjustedBasis");
  const section179 = requireCarryoverElection(draft, "section179");
  const bonusPercent = requireCarryoverElection(draft, "bonusPercent");
  const businessUsePercent = requireCarryoverElection(draft, "businessUsePercent");
  const priorDepreciation = requireCarryoverElection(draft, "priorDepreciation");
  const carryover = requireCarryoverElection(draft, "carryoverBasis");
  const slice = taxBasisSideApplies(draft.applicable, "seller") && draft.disposedUnadjustedBasis != null && draft.disposedUnadjustedBasis !== ""
    ? validateDeclaredDecimal("disposedUnadjustedBasis", draft.disposedUnadjustedBasis)
    : original;
  const originalBasis = mulPercent(slice, businessUsePercent);
  const elected179 = cmp(section179, originalBasis) < 0 ? section179 : originalBasis;
  const after179 = add(originalBasis, neg(elected179));
  const bonus = mulPercent(after179, bonusPercent);
  const reconstructed = macrsCheckpointReconstructed({
    originalBasis,
    elected179,
    bonus,
    prior: priorDepreciation,
    remaining: carryover,
  });
  if (cmp(reconstructed, formatMoney(originalBasis, 4)) !== 0) {
    throw new TaxBasisPolicyError(
      `nontaxable MACRS carryover ${carryover} plus allocated elections and priorDepreciation ${priorDepreciation} must equal original unadjusted basis ${originalBasis} after business use; declare the dated slice elections and remaining — do not subtract a full original bonus from a checkpoint that still holds the buyer share`,
    );
  }
}

function splitAllocatedAmount(amount: string | null, take: string, total: string): string | null {
  if (amount == null) return null;
  if (cmp(total, "0") <= 0) return formatMoney(amount, 4);
  return formatMoney(mulRatio(amount, toUnits(take), toUnits(total)), 4);
}

function derivedDisposedCheckpoint(
  vintage: OpenMacrsVintage,
  disposed: string,
): Pick<FrozenMacrsBuyerVintage, "section179" | "priorDepreciation" | "adjustedCarryover"> {
  const section179 = splitAllocatedAmount(vintage.section179, disposed, vintage.unadjustedBasis) ?? "0.0000";
  const priorFromHistory = splitAllocatedAmount(vintage.priorDepreciation, disposed, vintage.unadjustedBasis);
  const carryFromHistory = splitAllocatedAmount(vintage.adjustedCarryover, disposed, vintage.unadjustedBasis);
  if (carryFromHistory != null) {
    return { section179, priorDepreciation: priorFromHistory, adjustedCarryover: carryFromHistory };
  }
  if (priorFromHistory != null) {
    const originalBasis = mulPercent(disposed, vintage.businessUsePercent);
    const elected179 = cmp(section179, originalBasis) < 0 ? section179 : originalBasis;
    const after179 = add(originalBasis, neg(elected179));
    const bonus = mulPercent(after179, vintage.bonusPercent);
    const carryClassic = formatMoney(add(originalBasis, neg(sum([elected179, bonus, priorFromHistory]))), 4);
    if (cmp(carryClassic, "0") >= 0) {
      return { section179, priorDepreciation: priorFromHistory, adjustedCarryover: carryClassic };
    }
    const carryAllocated = formatMoney(add(originalBasis, neg(priorFromHistory)), 4);
    if (cmp(carryAllocated, "0") < 0) {
      throw new TaxBasisPolicyError(
        `frozen vintage ${vintage.key} cannot derive a carryover checkpoint from disposed ${disposed}, section179 ${elected179}, bonus ${bonus} and priorDepreciation ${priorFromHistory}; reverse and re-propose the earlier workpaper — do not invent the buyer's opening`,
      );
    }
    return { section179, priorDepreciation: priorFromHistory, adjustedCarryover: carryAllocated };
  }
  if (vintage.source === "excess" || vintage.source === "taxable_cost") {
    const originalBasis = mulPercent(disposed, vintage.businessUsePercent);
    const elected179 = cmp(section179, originalBasis) < 0 ? section179 : originalBasis;
    const after179 = add(originalBasis, neg(elected179));
    const bonus = mulPercent(after179, vintage.bonusPercent);
    const carryover = formatMoney(add(originalBasis, neg(sum([elected179, bonus]))), 4);
    if (cmp(carryover, "0") < 0) {
      throw new TaxBasisPolicyError(
        `frozen vintage ${vintage.key} cannot derive a newly placed opening from disposed ${disposed}, section179 ${elected179} and bonus ${bonus}; reverse and re-propose the earlier workpaper — do not invent the buyer's opening`,
      );
    }
    return { section179, priorDepreciation: "0.0000", adjustedCarryover: carryover };
  }
  throw new TaxBasisPolicyError(
    `frozen vintage ${vintage.key} has no adjusted carryover checkpoint or prior depreciation; reverse and re-propose the earlier workpaper — do not invent the buyer's opening`,
  );
}

function assertFrozenBuyerVintageCheckpoint(row: FrozenMacrsBuyerVintage): void {
  if (row.adjustedCarryover == null) {
    throw new TaxBasisPolicyError(
      `buyer vintage ${row.key} is missing its adjusted carryover checkpoint; derive it from applied history — do not leave the opening unstated`,
    );
  }
  const originalBasis = mulPercent(row.unadjustedBasis, row.businessUsePercent);
  const elected179 = cmp(row.section179, originalBasis) < 0 ? row.section179 : originalBasis;
  const after179 = add(originalBasis, neg(elected179));
  const bonus = mulPercent(after179, row.bonusPercent);
  const prior = row.priorDepreciation ?? "0";
  const reconstructed = macrsCheckpointReconstructed({
    originalBasis,
    elected179,
    bonus,
    prior,
    remaining: row.adjustedCarryover,
  });
  if (cmp(reconstructed, formatMoney(originalBasis, 4)) !== 0) {
    throw new TaxBasisPolicyError(
      `buyer vintage ${row.key} carryover ${row.adjustedCarryover} plus allocated elections and priorDepreciation ${prior} must equal original unadjusted basis ${originalBasis} after business use; derive the dated slice — do not subtract a full original bonus from a checkpoint that still holds the buyer share`,
    );
  }
}

function uniqueBuyerVintageValue<T>(
  vintages: readonly FrozenMacrsBuyerVintage[],
  get: (row: FrozenMacrsBuyerVintage) => T,
): T | null {
  const values = [...new Set(vintages.map((row) => String(get(row))))];
  return values.length === 1 ? get(vintages[0]!) : null;
}

/** Per-disposed-vintage receiver schedules. Carryover keeps transferor
 *  recovery; lineage is the open vintage key. Excess and taxable cost stay
 *  newly placed on the receiving class. */
export function deriveMacrsDisposedBuyerVintages(args: {
  open: readonly OpenMacrsVintage[];
  allocations: readonly MacrsVintageAllocationInput[];
  transferOn: string;
}): FrozenMacrsBuyerVintage[] {
  if (!isTaxBasisCalendarDate(args.transferOn)) {
    throw new TaxBasisPolicyError(
      "the selected source effective date is required to freeze buyer vintage transfer dates; pass the source occurredOn — do not invent a transferOn",
    );
  }
  const derived: FrozenMacrsBuyerVintage[] = [];
  for (const row of args.allocations) {
    if (cmp(row.disposedUnadjustedBasis, "0") <= 0) continue;
    const key = macrsVintageKey(row);
    const vintage = args.open.find((item) => item.key === key);
    if (!vintage) {
      throw new TaxBasisPolicyError(
        `vintageAllocations name ${key}, which is not an open MACRS vintage (${args.open.map((item) => item.key).join(", ")}); reconstruct from the frozen history — do not invent a vintage`,
      );
    }
    const checkpoint = derivedDisposedCheckpoint(vintage, row.disposedUnadjustedBasis);
    const buyer: FrozenMacrsBuyerVintage = {
      key: macrsVintageKey({
        source: "carryover",
        placedInServiceOn: vintage.placedInServiceOn,
        transferOn: args.transferOn,
        parentKey: vintage.key,
      }),
      source: "carryover",
      parentKey: vintage.key,
      placedInServiceOn: vintage.placedInServiceOn,
      transferOn: args.transferOn,
      recoveryPeriodYears: vintage.recoveryPeriodYears,
      method: vintage.method,
      convention: vintage.convention,
      unadjustedBasis: moneyExact(row.disposedUnadjustedBasis, "disposedUnadjustedBasis"),
      section179: checkpoint.section179,
      priorDepreciation: checkpoint.priorDepreciation,
      adjustedCarryover: checkpoint.adjustedCarryover,
      bonusPercent: vintage.bonusPercent,
      businessUsePercent: vintage.businessUsePercent,
    };
    assertFrozenBuyerVintageCheckpoint(buyer);
    derived.push(buyer);
  }
  if (derived.length === 0) {
    throw new TaxBasisPolicyError(
      "a nontaxable MACRS carryover requires a disposed vintage slice; allocate disposedUnadjustedBasis on the vintage whose transferor history the buyer continues — do not invent a header schedule for a zero disposal",
    );
  }
  return derived;
}

function assertSuppliedHeaderMatchesFrozenBuyerVintages(
  draft: TaxBasisDraft,
  derived: readonly FrozenMacrsBuyerVintage[],
): void {
  const checks = [
    ["placedInServiceOn", (row: FrozenMacrsBuyerVintage) => row.placedInServiceOn],
    ["recoveryPeriodYears", (row: FrozenMacrsBuyerVintage) => row.recoveryPeriodYears],
    ["method", (row: FrozenMacrsBuyerVintage) => row.method],
    ["convention", (row: FrozenMacrsBuyerVintage) => row.convention],
  ] as const;
  for (const [name, get] of checks) {
    const supplied = draft[name];
    if (supplied == null || supplied === "") continue;
    const values = [...new Set(derived.map((row) => String(get(row))))];
    if (values.length !== 1) {
      throw new TaxBasisPolicyError(
        `${name} cannot be one header ${String(supplied)} when the disposed vintages have ${name} ${values.join(", ")}; buyer recovery is frozen per vintage — do not invent a composite schedule`,
      );
    }
    if (name === "recoveryPeriodYears") {
      if (cmp(moneyExact(supplied, name), moneyExact(values[0], name)) !== 0) {
        throw new TaxBasisPolicyError(
          `${name} ${String(supplied)} does not match the frozen disposed vintage ${name} ${values[0]}; buyer recovery is derived from applied history — do not invent a schedule`,
        );
      }
      continue;
    }
    if (String(supplied) !== values[0]) {
      throw new TaxBasisPolicyError(
        `${name} ${String(supplied)} does not match the frozen disposed vintage ${name} ${values[0]}; buyer recovery is derived from applied history — do not invent a schedule`,
      );
    }
  }
}

function applyDerivedBuyerVintages(draft: TaxBasisDraft, derived: FrozenMacrsBuyerVintage[]): void {
  draft.buyerVintages = derived;
  const carryover = derived.reduce((total, row) => add(total, row.adjustedCarryover ?? "0"), "0");
  const section179 = derived.reduce((total, row) => add(total, row.section179), "0");
  const prior = derived.reduce((total, row) => add(total, row.priorDepreciation ?? "0"), "0");
  if (draft.carryoverBasis != null && draft.carryoverBasis !== "") {
    if (cmp(moneyExact(draft.carryoverBasis, "carryoverBasis"), formatMoney(carryover, 4)) !== 0) {
      throw new TaxBasisPolicyError(
        `carryoverBasis ${draft.carryoverBasis} must equal the sum of frozen disposed vintage checkpoints ${formatMoney(carryover, 4)}; buyer recovery is derived from applied history — do not invent a composite carryover`,
      );
    }
  }
  draft.carryoverBasis = formatMoney(carryover, 4);
  draft.section179 = formatMoney(section179, 4);
  draft.priorDepreciation = formatMoney(prior, 4);
  const bonus = uniqueBuyerVintageValue(derived, (row) => row.bonusPercent);
  const businessUse = uniqueBuyerVintageValue(derived, (row) => row.businessUsePercent);
  if (bonus != null) draft.bonusPercent = bonus;
  else delete draft.bonusPercent;
  if (businessUse != null) draft.businessUsePercent = businessUse;
  else delete draft.businessUsePercent;
  const placed = uniqueBuyerVintageValue(derived, (row) => row.placedInServiceOn);
  const recovery = uniqueBuyerVintageValue(derived, (row) => row.recoveryPeriodYears);
  const method = uniqueBuyerVintageValue(derived, (row) => row.method);
  const convention = uniqueBuyerVintageValue(derived, (row) => row.convention);
  if (placed != null && recovery != null && method != null && convention != null) {
    draft.placedInServiceOn = placed;
    draft.recoveryPeriodYears = recovery;
    draft.method = method;
    draft.convention = convention;
  } else {
    delete draft.placedInServiceOn;
    delete draft.recoveryPeriodYears;
    delete draft.method;
    delete draft.convention;
  }
}

const FROZEN_BUYER_VINTAGE_KEYS = [
  "key",
  "source",
  "parentKey",
  "placedInServiceOn",
  "transferOn",
  "recoveryPeriodYears",
  "method",
  "convention",
  "unadjustedBasis",
  "adjustedCarryover",
  "section179",
  "priorDepreciation",
  "bonusPercent",
  "businessUsePercent",
] as const;

/** Rehydrate frozen receiver vintages from applied computed JSON. */
export function parseFrozenMacrsBuyerVintages(value: unknown): FrozenMacrsBuyerVintage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TaxBasisPolicyError(
      "buyerVintages must freeze each disposed MACRS vintage; do not invent one composite receiver schedule",
    );
  }
  return value.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new TaxBasisPolicyError(`buyerVintages[${index}] must be an object`);
    }
    const raw = row as Record<string, unknown>;
    const unknown = Object.keys(raw).filter(
      (key) => !(FROZEN_BUYER_VINTAGE_KEYS as readonly string[]).includes(key),
    );
    if (unknown.length > 0) {
      throw new TaxBasisPolicyError(
        `unknown buyerVintages[${index}] field(s): ${unknown.sort().join(", ")}`,
      );
    }
    if (raw.source !== "carryover" && raw.source !== "excess" && raw.source !== "taxable_cost") {
      throw new TaxBasisPolicyError(
        `buyerVintages[${index}].source must be carryover, excess, or taxable_cost`,
      );
    }
    if (typeof raw.key !== "string" || raw.key === "") {
      throw new TaxBasisPolicyError(`buyerVintages[${index}].key is required to identify the receiving vintage`);
    }
    if (raw.parentKey != null && typeof raw.parentKey !== "string") {
      throw new TaxBasisPolicyError(`buyerVintages[${index}].parentKey must identify the disposed vintage`);
    }
    if (!isTaxBasisCalendarDate(raw.placedInServiceOn)) {
      throw new TaxBasisPolicyError(
        `buyerVintages[${index}].placedInServiceOn must be a calendar date (YYYY-MM-DD)`,
      );
    }
    if (!isTaxBasisCalendarDate(raw.transferOn)) {
      throw new TaxBasisPolicyError(
        `buyerVintages[${index}].transferOn must be a calendar date (YYYY-MM-DD)`,
      );
    }
    if (!(MACRS_METHODS as readonly string[]).includes(String(raw.method ?? ""))) {
      throw new TaxBasisPolicyError(`buyerVintages[${index}].method must be 200_db, 150_db, or straight_line`);
    }
    if (!(MACRS_CONVENTIONS as readonly string[]).includes(String(raw.convention ?? ""))) {
      throw new TaxBasisPolicyError(`buyerVintages[${index}].convention must be half_year, mid_quarter, or mid_month`);
    }
    const vintage: FrozenMacrsBuyerVintage = {
      key: raw.key,
      source: raw.source,
      parentKey: typeof raw.parentKey === "string" && raw.parentKey !== "" ? raw.parentKey : null,
      placedInServiceOn: raw.placedInServiceOn,
      transferOn: raw.transferOn,
      recoveryPeriodYears: (() => {
        const recovery = normalizeDecimal(String(raw.recoveryPeriodYears ?? ""), 10);
        if (cmp(recovery, "0") <= 0) {
          throw new TaxBasisPolicyError(
            `buyerVintages[${index}].recoveryPeriodYears must be greater than 0`,
          );
        }
        return String(raw.recoveryPeriodYears);
      })(),
      method: raw.method as MacrsMethod,
      convention: raw.convention as MacrsConvention,
      unadjustedBasis: moneyExact(raw.unadjustedBasis, `buyerVintages[${index}].unadjustedBasis`),
      adjustedCarryover: raw.adjustedCarryover == null || raw.adjustedCarryover === ""
        ? null
        : moneyExact(raw.adjustedCarryover, `buyerVintages[${index}].adjustedCarryover`),
      section179: moneyExact(raw.section179, `buyerVintages[${index}].section179`),
      priorDepreciation: raw.priorDepreciation == null || raw.priorDepreciation === ""
        ? null
        : moneyExact(raw.priorDepreciation, `buyerVintages[${index}].priorDepreciation`),
      bonusPercent: normalizeDecimal(String(raw.bonusPercent ?? ""), 10),
      businessUsePercent: normalizeDecimal(String(raw.businessUsePercent ?? ""), 10),
    };
    if (vintage.source === "carryover") assertFrozenBuyerVintageCheckpoint(vintage);
    return vintage;
  });
}

function validateUs(draft: TaxBasisDraft, context?: TaxBasisValidationContext): UsMacrsRegimeBasis {
  const history = context?.usSellerMacrs ?? null;
  if (taxBasisSideApplies(draft.applicable, "seller")) {
    const trigger = draft.dispositionTrigger as UsDispositionTrigger;
    if (trigger === "elective_other" && draft.partialDispositionElection !== true) {
      throw new TaxBasisPolicyError(
        "this MACRS partial disposition is elective under Treas. Reg. 1.168(i)-8(d); record the partial disposition election, or it is not a disposition",
      );
    }
    if (US_REQUIRED_PARTIAL_TRIGGERS.includes(trigger) && draft.partialDispositionElection === false) {
      throw new TaxBasisPolicyError(
        `a ${trigger} of a portion of MACRS property is a required partial disposition under Treas. Reg. 1.168(i)-8(d)(1) and Pub 544; an election is not required and cannot be used to ignore it`,
      );
    }
    if (history?.status === "ready") {
      if (history.vintages.length === 0) {
        throw new TaxBasisPolicyError(
          "open MACRS vintages were reported ready with no rows; reconstruct the frozen history — do not treat a missing list as an empty valid vintage",
        );
      }
      const derivedOriginal = history.vintages.reduce((total, row) => add(total, row.unadjustedBasis), "0");
      if (draft.originalUnadjustedBasis != null && draft.originalUnadjustedBasis !== "") {
        if (cmp(moneyExact(draft.originalUnadjustedBasis, "originalUnadjustedBasis"), derivedOriginal) !== 0) {
          throw new TaxBasisPolicyError(
            `originalUnadjustedBasis ${draft.originalUnadjustedBasis} must equal the sum of open MACRS vintage bases ${derivedOriginal}; do not invent a composite vintage`,
          );
        }
      }
      draft.originalUnadjustedBasis = moneyExact(derivedOriginal, "originalUnadjustedBasis");
      if (draft.vintageAllocations == null || draft.vintageAllocations === "") {
        throw new TaxBasisPolicyError(
          `vintageAllocations must name every open MACRS vintage (${history.vintages.map((row) => row.key).join(", ")}); the header remaining/disposed amounts are the sums — do not invent a composite vintage`,
        );
      }
    }
    const original = moneyExact(draft.originalUnadjustedBasis, "originalUnadjustedBasis");
    const remaining = moneyExact(draft.remainingUnadjustedBasis, "remainingUnadjustedBasis");
    const disposed = moneyExact(draft.disposedUnadjustedBasis, "disposedUnadjustedBasis");
    if (cmp(add(remaining, disposed), original) !== 0) {
      throw new TaxBasisPolicyError(
        `remainingUnadjustedBasis ${remaining} plus disposedUnadjustedBasis ${disposed} must equal originalUnadjustedBasis ${original}; the vintage is split, not restarted`,
      );
    }
    if (draft.vintageAllocations != null && draft.vintageAllocations !== "") {
      const allocations = parseMacrsVintageAllocations(draft.vintageAllocations);
      assertMacrsVintageAllocationTotals(allocations, disposed, remaining);
      if (history?.status === "ready") {
        assertMacrsVintageAllocationsMatchOpen(allocations, history.vintages);
        const buyerTransferorHistory =
          taxBasisSideApplies(draft.applicable, "buyer") && draft.recognition === "nontaxable";
        if (buyerTransferorHistory) {
          const transferOn = context?.effectiveOn;
          if (!transferOn || !isTaxBasisCalendarDate(transferOn)) {
            throw new TaxBasisPolicyError(
              "the selected source effective date is required to freeze buyer vintage transfer dates; pass the source occurredOn — do not invent a transferOn",
            );
          }
          const derived = deriveMacrsDisposedBuyerVintages({
            open: history.vintages,
            allocations,
            transferOn,
          });
          assertSuppliedHeaderMatchesFrozenBuyerVintages(draft, derived);
          applyDerivedBuyerVintages(draft, derived);
        } else {
          for (const name of ["placedInServiceOn", "recoveryPeriodYears", "method", "convention"] as const) {
            if (draft[name] != null && draft[name] !== "") {
              throw new TaxBasisPolicyError(
                `${name} cannot be declared as one seller vintage when frozen MACRS history is authoritative; allocate each open vintage in vintageAllocations`,
              );
            }
          }
        }
      }
      draft.vintageAllocations = allocations;
    }
  } else if (draft.vintageAllocations != null && draft.vintageAllocations !== "") {
    throw new TaxBasisPolicyError(
      "vintageAllocations identify the seller's open vintages; a buyer-only workpaper does not split them — do not declare seller allocations on the receiving side",
    );
  }
  if (
    taxBasisSideApplies(draft.applicable, "buyer") &&
    draft.recognition === "nontaxable" &&
    !(Array.isArray(draft.buyerVintages) && draft.buyerVintages.length > 0)
  ) {
    assertUsCarryoverCheckpoint(draft);
  }
  if (draft.recognition === "nontaxable" && draft.sourceOperation !== "intercompany_transfer") {
    throw new TaxBasisPolicyError(
      "a nontaxable MACRS carryover belongs on the receiving asset of an intercompany_transfer; a sale to a customer is a taxable disposition — do not record buyer carryover on a partial_disposal",
    );
  }
  if (draft.recognition === "nontaxable") {
    const kind = draft.section168i7Kind;
    if (kind !== "nonrecognition" && kind !== "partnership_721_prior_interest" && kind !== "consolidated_group") {
      throw new TaxBasisPolicyError(
        "section168i7Kind is required for a nontaxable MACRS transfer; declare §168(i)(7)(B)(i) nonrecognition, a §721 prior-partner depreciable interest, or a consolidated-group member transfer — do not allocate the placement year by ordinary half-year disposal",
      );
    }
  }
  if (
    draft.recognition === "taxable" &&
    (draft.amountRealizedRule === "section_482" || draft.amountRealizedRule === "other_evidenced") &&
    String(draft.deemedValueAdjustmentEvidence ?? "").trim().length < 8
  ) {
    throw new TaxBasisPolicyError(
      "a §482 or other deemed-value adjustment requires independent evidence; related-person status is not that evidence and does not substitute the transferred asset's FMV for Pub 544 amount realized",
    );
  }
  return stripDraftContext(draft) as unknown as UsMacrsRegimeBasis;
}

export function validateTaxAssetBasisInput(
  input: TaxAssetBasisInput,
  context?: TaxBasisValidationContext,
): TaxAssetBasisInput {
  const sourceChangeId = input.sourceChangeId || null;
  const sourceEventId = input.sourceEventId || null;
  if (!sourceChangeId && !sourceEventId) {
    throw new TaxBasisPolicyError(
      "select a posted source: sourceChangeId or, for a legacy event with no financial change, sourceEventId",
    );
  }
  if (input.reason.trim().length < 8 || input.reason.trim().length > 1000) {
    throw new TaxBasisPolicyError("record a change reason between 8 and 1,000 characters");
  }
  if (input.assessment.trim().length < 8 || input.assessment.trim().length > 4000) {
    throw new TaxBasisPolicyError("record an assessment between 8 and 4,000 characters");
  }
  if (!input.idempotencyKey || input.idempotencyKey.length > 120) {
    throw new TaxBasisPolicyError("provide a request key of at most 120 characters");
  }
  if (!Array.isArray(input.regimes) || input.regimes.length === 0) {
    throw new TaxBasisPolicyError("declare at least one regime workpaper");
  }
  const seen = new Set<string>();
  const regimes = input.regimes.map((row) => {
    if (context?.applicableByRegime && !context.applicableByRegime[row.regime]) {
      throw new TaxBasisPolicyError(
        `neither the seller nor the receiving asset is classified for ${row.regime}; assign the tax class on the applicable Tax tab — do not invent a classification to collect inapplicable facts`,
      );
    }
    const validated = validateTaxRegimeBasis(row, context);
    if (seen.has(validated.regime)) throw new TaxBasisPolicyError(`regime ${validated.regime} is declared more than once`);
    seen.add(validated.regime);
    return validated;
  });
  return {
    sourceChangeId,
    sourceEventId,
    reason: input.reason.trim(),
    assessment: input.assessment.trim(),
    idempotencyKey: input.idempotencyKey,
    regimes,
  };
}

/**
 * ITA 38(a) supplies one-half of the capital gain as the taxable capital
 * gain, subject to the named exceptions in that section. The CRA non-arm's-
 * length worksheet prints the same half multiplier. Ordinary depreciable-
 * property transfers use this rate; it is not an operator election.
 * https://laws-lois.justice.gc.ca/eng/acts/I-3.3/section-38.html
 * https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/sole-proprietorships-partnerships/report-business-income-expenses/claiming-capital-cost-allowance/non-arms-length-transactions.html
 */
export const CA_ORDINARY_INCLUSION_RATE_EDITIONS = [
  {
    effectiveFrom: "1972-01-01",
    rate: "0.5",
    citation: "ITA 38(a)",
    edition: "https://laws-lois.justice.gc.ca/eng/acts/I-3.3/section-38.html",
    worksheet:
      "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/sole-proprietorships-partnerships/report-business-income-expenses/claiming-capital-cost-allowance/non-arms-length-transactions.html",
  },
] as const;

export function caOrdinaryCapitalGainsInclusion(effectiveOn: string): {
  rate: string;
  citation: string;
  edition: string;
  worksheet: string;
} {
  if (!isTaxBasisCalendarDate(effectiveOn)) {
    throw new TaxBasisPolicyError(
      "a calendar effective date is required to resolve the ITA 38(a) inclusion rate",
    );
  }
  const edition = [...CA_ORDINARY_INCLUSION_RATE_EDITIONS]
    .reverse()
    .find((row) => row.effectiveFrom <= effectiveOn);
  if (!edition) {
    throw new TaxBasisPolicyError(
      `no ITA 38(a) ordinary inclusion-rate edition is in force on ${effectiveOn}`,
    );
  }
  return {
    rate: edition.rate,
    citation: edition.citation,
    edition: edition.edition,
    worksheet: edition.worksheet,
  };
}

export function freezeCaRegimeBasis(row: CaCcaRegimeBasis, effectiveOn: string): CaCcaRegimeBasis {
  const inclusion = caOrdinaryCapitalGainsInclusion(effectiveOn);
  return {
    ...row,
    capitalGainsInclusionRate: inclusion.rate,
    capitalGainsInclusionRateCitation: `${inclusion.citation} one-half; ${inclusion.edition}`,
  };
}

export interface CaCapitalCostResult {
  capitalCost: string;
  deemedPriorCca: string;
  uccAddition: string;
  taxableCapitalGain: string;
}

/** CRA NAL capital-cost worksheets. Compares PAYMENT to SELLER COST. */
export function computeCaNalCapitalCost(input: {
  payment: string;
  sellerOriginalCapitalCost: string;
  transferorCharacter: CaTransferorCharacter;
  capitalGainsInclusionRate: string;
  capitalGainsDeductionClaimed?: string;
}): CaCapitalCostResult {
  const payment = moneyExact(input.payment, "payment");
  const seller = moneyExact(input.sellerOriginalCapitalCost, "sellerOriginalCapitalCost");
  if (cmp(payment, seller) < 0) {
    return {
      capitalCost: seller,
      deemedPriorCca: formatMoney(add(seller, neg(payment)), 2),
      uccAddition: formatMoney(payment, 2),
      taxableCapitalGain: "0.00",
    };
  }
  const excess = add(payment, neg(seller));
  const taxable = formatMoney(mulDecimal(excess, input.capitalGainsInclusionRate), 2);
  const usesCge =
    input.transferorCharacter === "resident_individual" ||
    input.transferorCharacter === "resident_partnership";
  if (usesCge) {
    const cge = moneyExact(input.capitalGainsDeductionClaimed ?? "0", "capitalGainsDeductionClaimed");
    const afterCge = cmp(add(taxable, neg(cge)), "0") < 0 ? "0.00" : formatMoney(add(taxable, neg(cge)), 2);
    const capitalCost = formatMoney(add(seller, afterCge), 2);
    return { capitalCost, deemedPriorCca: "0.00", uccAddition: capitalCost, taxableCapitalGain: taxable };
  }
  const capitalCost = formatMoney(add(seller, taxable), 2);
  return { capitalCost, deemedPriorCca: "0.00", uccAddition: capitalCost, taxableCapitalGain: taxable };
}

export function allocatedCaCapitalCost(row: CaCcaRegimeBasis): string {
  const original = moneyExact(row.originalCapitalCost, "originalCapitalCost");
  if (row.allocationMethod === "ascertainable_amount" || row.allocationMethod === "operator_reasonable") {
    return formatMoney(requireMoney(row as unknown as TaxBasisDraft, "allocatedCapitalCost"), 2);
  }
  if (row.allocationMethod === "ascertainable_fraction") {
    return formatMoney(mulDecimal(original, row.allocationFraction!), 2);
  }
  const part = moneyExact(row.partFairMarketValue, "partFairMarketValue");
  const retained = moneyExact(row.retainedFairMarketValue, "retainedFairMarketValue");
  const whole = add(part, retained);
  if (cmp(whole, "0") <= 0) {
    throw new TaxBasisPolicyError("FMV pro-rata allocation needs a positive combined fair market value");
  }
  return formatMoney(mulRatio(original, toUnits(part), toUnits(whole)), 2);
}

/** ITA 69(1)(b)(i): nil or below-FMV NAL proceeds become FMV; above-FMV actual
 *  proceeds are not reduced. https://laws-lois.justice.gc.ca/eng/acts/I-3.3/section-69.html */
export function caStatutoryProceeds(row: CaCcaRegimeBasis): string {
  if (row.rolloverElection !== "none") {
    return formatMoney(requireMoney(row as unknown as TaxBasisDraft, "electedAmount"), 2);
  }
  const actual = requireMoney(row as unknown as TaxBasisDraft, "statutoryProceeds");
  if (row.relationship !== "non_arms_length") return formatMoney(actual, 2);
  const market = requireMoney(row as unknown as TaxBasisDraft, "fairMarketValue");
  return formatMoney(cmp(actual, market) < 0 ? market : actual, 2);
}

/** ITA 69(1)(a): buyer who paid more than FMV is deemed to have acquired at
 *  FMV. Payment at or below FMV is not increased. */
export function caDeemedAcquisitionPayment(row: CaCcaRegimeBasis): string {
  const payment = requireMoney(row as unknown as TaxBasisDraft, "payment");
  if (row.relationship !== "non_arms_length" || row.rolloverElection !== "none") {
    return formatMoney(payment, 2);
  }
  const market = requireMoney(row as unknown as TaxBasisDraft, "fairMarketValue");
  return formatMoney(cmp(payment, market) > 0 ? market : payment, 2);
}

export function caDispositionAmount(row: CaCcaRegimeBasis): string {
  const proceeds = caStatutoryProceeds(row);
  const cost = allocatedCaCapitalCost(row);
  return formatMoney(cmp(proceeds, cost) <= 0 ? proceeds : cost, 2);
}

export function caBuyerAddition(row: CaCcaRegimeBasis): string | null {
  if (row.relationship !== "non_arms_length") return optionalMoney(row as unknown as TaxBasisDraft, "payment") ?? null;
  if (row.rolloverElection !== "none") {
    return formatMoney(requireMoney(row as unknown as TaxBasisDraft, "electedAmount"), 2);
  }
  return computeCaNalCapitalCost({
    payment: caDeemedAcquisitionPayment(row),
    sellerOriginalCapitalCost: row.sellerOriginalCapitalCost!,
    transferorCharacter: row.transferorCharacter!,
    capitalGainsInclusionRate: row.capitalGainsInclusionRate!,
    capitalGainsDeductionClaimed: row.capitalGainsDeductionClaimed,
  }).uccAddition;
}

export function ukDisposalValue(row: UkWdaRegimeBasis): string {
  let value = row.saleBelowMarket && !row.buyerCanClaimPma
    ? moneyExact(row.fairMarketValue, "fairMarketValue")
    : moneyExact(row.statutoryProceeds ?? row.fairMarketValue, "statutoryProceeds");
  const cap = row.connectedChain
    ? moneyExact(row.greatestQualifyingExpenditureInChain, "greatestQualifyingExpenditureInChain")
    : moneyExact(row.allocatedQualifyingExpenditure ?? row.qualifyingExpenditure, "qualifyingExpenditure");
  if (cmp(value, cap) > 0) value = cap;
  return formatMoney(value, 2);
}

export function auTerminationValue(row: AuPoolRegimeBasis): string {
  if (row.relationship === "non_arms_length") {
    const market = moneyExact(row.fairMarketValue, "fairMarketValue");
    const otherwise = optionalMoney(row as unknown as TaxBasisDraft, "terminationValue") ?? market;
    return formatMoney(cmp(otherwise, market) < 0 ? market : otherwise, 2);
  }
  return formatMoney(requireMoney(row as unknown as TaxBasisDraft, "terminationValue"), 2);
}

export function auPoolReduction(row: AuPoolRegimeBasis): string {
  return formatMoney(mulPercent(auTerminationValue(row), row.taxableUsePercent), 2);
}

export function nzPoolReduction(row: NzPoolRegimeBasis): string {
  const consideration = validateDeclaredDecimal("consideration", row.consideration);
  const expenditure = validateDeclaredDecimal("disposalExpenditure", row.disposalExpenditure);
  return formatMoney(add(consideration, neg(expenditure)), 2);
}

/** IR260 p.24: lower of buyer price and associate original cost (or first-use FMV). */
export function nzBuyerDepreciationCost(row: NzPoolRegimeBasis): string {
  if (row.relationship !== "non_arms_length") {
    return formatMoney(requireMoney(row as unknown as TaxBasisDraft, "buyerPrice"), 2);
  }
  if (row.commissionerActualCost) {
    return formatMoney(requireMoney(row as unknown as TaxBasisDraft, "buyerPrice"), 2);
  }
  if (row.consolidatingGroupAtv) {
    return formatMoney(requireMoney(row as unknown as TaxBasisDraft, "associatedPersonAtv"), 2);
  }
  const price = moneyExact(row.buyerPrice, "buyerPrice");
  const cap = row.associatedPersonCostBasis === "first_business_use_fmv"
    ? moneyExact(row.firstBusinessUseFairMarketValue, "firstBusinessUseFairMarketValue")
    : moneyExact(row.associatedPersonOriginalCost, "associatedPersonOriginalCost");
  return formatMoney(cmp(price, cap) <= 0 ? price : cap, 2);
}

/** IR260 p.24 rate restriction: the acquirer's equivalent rate, when declared. */
export function nzAssociatedPersonEquivalentRate(row: {
  relationship?: string;
  associatedPersonEquivalentRate?: string | null;
}): string | null {
  if (row.relationship !== "non_arms_length") return null;
  const declared = row.associatedPersonEquivalentRate;
  if (declared == null || String(declared).trim() === "") {
    throw new TaxBasisPolicyError(
      "associatedPersonEquivalentRate is required for a non-arm's-length NZ buyer; do not depreciate at the class rate",
    );
  }
  return normalizeDecimal(declared, 10);
}

/** NZ pool method uses the lowest DV rate of assets in the pool. An associated-person
 *  equivalent rate is a ceiling on that pool rate, not a silent class-rate fallback. */
export function nzPooledDepreciationRate(
  classRate: string | number,
  associatedEquivalentRates: readonly string[],
): string {
  let rate = normalizeDecimal(classRate, 10);
  for (const candidate of associatedEquivalentRates) {
    const exact = normalizeDecimal(candidate, 10);
    if (cmp(exact, rate) < 0) rate = exact;
  }
  return rate;
}

/** IR260 p24 associated-person equivalent-rate cap continues while the
 *  acquired cost remains. A prior-year transfer still restricts later years. */
export function continuingNzAssociatedRates(
  papers: ReadonlyArray<{
    effective_on: string;
    buyer_subsidiary_id: string | null;
    buyer_class: string | null;
    relationship: string | null;
    associated_person_equivalent_rate: string | null;
  }>,
  run: { subsidiaryId: string; yearEnd: string },
  classCode: string,
): string[] {
  const associated: string[] = [];
  for (const paper of papers) {
    if (paper.effective_on > run.yearEnd) continue;
    if (paper.buyer_subsidiary_id !== run.subsidiaryId || paper.buyer_class !== classCode) continue;
    if (paper.relationship !== "non_arms_length") continue;
    if (!paper.associated_person_equivalent_rate) {
      throw new TaxBasisPolicyError(
        `NZ associated-person transfer into class ${classCode} is missing associatedPersonEquivalentRate; reverse and re-propose the workpaper — do not depreciate at the class rate`,
      );
    }
    associated.push(paper.associated_person_equivalent_rate);
  }
  return associated;
}

/** Receiving-asset MACRS schedule frozen on approval. Taxable cost and
 *  nontaxable excess use this; carryover keeps the transferor vintage. */
export type UsBuyerMacrsSchedule = {
  placedInServiceOn: string;
  recoveryPeriodYears: string;
  method: MacrsMethod;
  convention: MacrsConvention;
};

function freezeUsBuyerMacrsSchedule(schedule: UsBuyerMacrsSchedule | null | undefined): {
  buyerPlacedInServiceOn: string;
  buyerRecoveryPeriodYears: string;
  buyerMethod: MacrsMethod;
  buyerConvention: MacrsConvention;
} {
  if (!schedule) {
    throw new TaxBasisPolicyError(
      "a US receiving tax asset must freeze its own placed-in-service date, recovery period, method and convention; set in_service_on or acquired_on and the receiving MACRS class — do not inherit the transferor's vintage",
    );
  }
  if (!isTaxBasisCalendarDate(schedule.placedInServiceOn)) {
    throw new TaxBasisPolicyError("buyerPlacedInServiceOn must be a calendar date (YYYY-MM-DD)");
  }
  if (!(MACRS_METHODS as readonly string[]).includes(schedule.method)) {
    throw new TaxBasisPolicyError("buyerMethod must be 200_db, 150_db, or straight_line");
  }
  if (!(MACRS_CONVENTIONS as readonly string[]).includes(schedule.convention)) {
    throw new TaxBasisPolicyError("buyerConvention must be half_year, mid_quarter, or mid_month");
  }
  const recovery = normalizeDecimal(schedule.recoveryPeriodYears, 10);
  if (cmp(recovery, "0") <= 0) {
    throw new TaxBasisPolicyError("buyerRecoveryPeriodYears must be greater than 0");
  }
  return {
    buyerPlacedInServiceOn: schedule.placedInServiceOn,
    buyerRecoveryPeriodYears: recovery,
    buyerMethod: schedule.method,
    buyerConvention: schedule.convention,
  };
}

function freezeUsCarryoverElections(row: UsMacrsRegimeBasis): {
  originalUnadjustedBasis: string;
  section179: string;
  bonusPercent: string;
  businessUsePercent: string;
  priorDepreciation: string;
} {
  if (row.originalUnadjustedBasis == null || row.originalUnadjustedBasis === "") {
    throw new TaxBasisPolicyError(
      "originalUnadjustedBasis is required for nontaxable MACRS carryover; declare the transferor original tax basis for this slice — do not relabel carryoverBasis as original unadjusted basis",
    );
  }
  if (row.section179 == null || row.section179 === "") {
    throw new TaxBasisPolicyError(
      "section179 is required for nontaxable MACRS carryover; declare the transferor's historical election allocated to this slice — missing receiving or foreign tax-depreciation JSON is not a zero election",
    );
  }
  if (row.bonusPercent == null || row.bonusPercent === "") {
    throw new TaxBasisPolicyError(
      "bonusPercent is required for nontaxable MACRS carryover; declare the transferor's historical bonus allocated to this slice — missing tax-depreciation JSON is not a zero bonus",
    );
  }
  if (row.businessUsePercent == null || row.businessUsePercent === "") {
    throw new TaxBasisPolicyError(
      "businessUsePercent is required for nontaxable MACRS carryover; declare the transferor's historical business-use percent allocated to this slice — missing tax-depreciation JSON is not 100% or zero",
    );
  }
  if (row.priorDepreciation == null || row.priorDepreciation === "") {
    throw new TaxBasisPolicyError(
      "priorDepreciation is required for nontaxable MACRS carryover; declare MACRS already taken on this slice — do not re-walk a nominal schedule to invent it",
    );
  }
  return {
    originalUnadjustedBasis: moneyExact(row.originalUnadjustedBasis, "originalUnadjustedBasis"),
    section179: moneyExact(row.section179, "section179"),
    bonusPercent: normalizeDecimal(row.bonusPercent, 10),
    businessUsePercent: normalizeDecimal(row.businessUsePercent, 10),
    priorDepreciation: moneyExact(row.priorDepreciation, "priorDepreciation"),
  };
}

/** Frozen MACRS workpaper outcome. Nontaxable carryover has no Pub 544
 *  amount realized and must not call usDispositionProceeds. */
export function usRegimeWorkpaperOutcome(
  row: UsMacrsRegimeBasis,
  sourceOperation: TaxBasisSourceOperation,
  applicable: TaxBasisApplicableSide = "both",
  buyerSchedule?: UsBuyerMacrsSchedule | null,
): Record<string, unknown> {
  const seller = taxBasisSideApplies(applicable, "seller");
  const buyer = sourceOperation === "intercompany_transfer" && taxBasisSideApplies(applicable, "buyer");
  const taxable = row.recognition === "taxable";
  const transferorHistory = seller || (buyer && !taxable);
  const buyerVintages = buyer && !taxable && row.buyerVintages && row.buyerVintages.length > 0
    ? parseFrozenMacrsBuyerVintages(row.buyerVintages)
    : null;
  const carryoverElections = buyer && !taxable
    ? buyerVintages
      ? {
          originalUnadjustedBasis: seller
            ? row.originalUnadjustedBasis ?? null
            : buyerVintages.reduce((total, vintage) => add(total, vintage.unadjustedBasis), "0"),
          section179: formatMoney(
            buyerVintages.reduce((total, vintage) => add(total, vintage.section179), "0"),
            4,
          ),
          bonusPercent: uniqueBuyerVintageValue(buyerVintages, (vintage) => vintage.bonusPercent),
          businessUsePercent: uniqueBuyerVintageValue(buyerVintages, (vintage) => vintage.businessUsePercent),
          priorDepreciation: formatMoney(
            buyerVintages.reduce((total, vintage) => add(total, vintage.priorDepreciation ?? "0"), "0"),
            4,
          ),
        }
      : freezeUsCarryoverElections(row)
    : {
        originalUnadjustedBasis: seller ? row.originalUnadjustedBasis ?? null : null,
        section179: null,
        bonusPercent: null,
        businessUsePercent: null,
        priorDepreciation: null,
      };
  return {
    amountRealized: seller && taxable ? usDispositionProceeds(row) : null,
    remainingUnadjustedBasis: seller ? row.remainingUnadjustedBasis : null,
    disposedUnadjustedBasis: seller ? row.disposedUnadjustedBasis : null,
    vintageAllocations: seller && row.vintageAllocations
      ? parseMacrsVintageAllocations(row.vintageAllocations)
      : null,
    buyerVintages,
    placedInServiceOn: transferorHistory ? row.placedInServiceOn ?? null : null,
    recoveryPeriodYears: transferorHistory ? row.recoveryPeriodYears ?? null : null,
    method: transferorHistory ? row.method ?? null : null,
    convention: transferorHistory ? row.convention ?? null : null,
    recognition: row.recognition,
    section168i7Kind: !taxable ? row.section168i7Kind ?? null : null,
    carryoverBasis: buyer && !taxable
      ? buyerVintages
        ? formatMoney(
            buyerVintages.reduce((total, vintage) => add(total, vintage.adjustedCarryover ?? "0"), "0"),
            4,
          )
        : row.carryoverBasis ?? null
      : null,
    excessBasis: buyer && !taxable ? row.excessBasis ?? null : null,
    buyerCost: buyer && taxable ? row.buyerCost ?? null : null,
    shortYearMethod: row.shortYearMethod ?? null,
    ...carryoverElections,
    ...(buyer
      ? freezeUsBuyerMacrsSchedule(buyerSchedule)
      : {
          buyerPlacedInServiceOn: null,
          buyerRecoveryPeriodYears: null,
          buyerMethod: null,
          buyerConvention: null,
        }),
  };
}

/** Seller-side pool reduction from a frozen workpaper. Nontaxable MACRS uses
 *  the disposed unadjusted basis, not amount realized. */
export function taxWorkpaperSellerDisposition(
  regime: TaxBasisRegime,
  computed: Record<string, unknown>,
): string {
  if (regime === "us_macrs" && computed.recognition === "nontaxable") {
    return moneyExact(computed.disposedUnadjustedBasis, "disposedUnadjustedBasis");
  }
  const name =
    regime === "ca_cca"
      ? "dispositionAmount"
      : regime === "uk_wda"
        ? "disposalValue"
        : regime === "au_pool" || regime === "nz_pool"
          ? "poolReduction"
          : "amountRealized";
  if (computed[name] == null || computed[name] === "") {
    throw new TaxBasisPolicyError(
      `frozen ${regime} workpaper is missing ${name}; reverse that workpaper and re-propose it — do not substitute book proceeds`,
    );
  }
  return moneyExact(computed[name], name);
}

/** Receiving-asset addition from a frozen workpaper. Nontaxable MACRS is
 *  carryover plus excess; never book buyerAmount. */
export function taxWorkpaperBuyerAddition(
  regime: TaxBasisRegime,
  computed: Record<string, unknown>,
): string {
  if (computed.recognition === "nontaxable") {
    return formatMoney(
      add(
        moneyExact(computed.carryoverBasis, "carryoverBasis"),
        moneyExact(computed.excessBasis, "excessBasis"),
      ),
      2,
    );
  }
  const name =
    regime === "ca_cca"
      ? "buyerAddition"
      : regime === "uk_wda"
        ? "buyerQualifyingExpenditure"
        : regime === "nz_pool"
          ? "buyerDepreciationCost"
          : "buyerCost";
  if (computed[name] == null || computed[name] === "") {
    throw new TaxBasisPolicyError(
      `frozen ${regime} workpaper is missing ${name} for the receiving asset; reverse that workpaper and re-propose it — do not substitute book cost`,
    );
  }
  return moneyExact(computed[name], name);
}

/** Pub 544 amount realized: money + FMV of other property/services + assumed
 *  liabilities. Related status does not substitute the transferred asset's FMV.
 *  https://www.irs.gov/publications/p544 */
export function usDispositionProceeds(row: UsMacrsRegimeBasis): string {
  const rule = row.amountRealizedRule ?? "amount_realized";
  if (rule !== "amount_realized") {
    if (String(row.deemedValueAdjustmentEvidence ?? "").trim().length < 8) {
      throw new TaxBasisPolicyError(
        "a §482 or other deemed-value adjustment requires independent evidence; related-person status is not that evidence and does not substitute the transferred asset's FMV for Pub 544 amount realized",
      );
    }
    return formatMoney(requireMoney(row as unknown as TaxBasisDraft, "adjustedAmountRealized"), 2);
  }
  return formatMoney(requireMoney(row as unknown as TaxBasisDraft, "statutoryProceeds"), 2);
}

export function usBuyerSection179Allowed(row: UsMacrsRegimeBasis): boolean {
  return !row.relatedPerson;
}
