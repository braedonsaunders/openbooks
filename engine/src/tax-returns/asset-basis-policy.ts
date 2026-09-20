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
import { add, cmp, formatMoney, mulDecimal, mulPercent, mulRatio, neg, normalizeMoney, toUnits } from "../money/money.ts";

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

export const TAX_BASIS_SOURCE_KINDS = ["partially_disposed", "transferred"] as const;
export type TaxBasisSourceKind = (typeof TAX_BASIS_SOURCE_KINDS)[number];

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

export const US_SHORT_YEAR_METHODS = ["simplified", "allocation"] as const;
export type UsShortYearMethod = (typeof US_SHORT_YEAR_METHODS)[number];

export const US_AMOUNT_REALIZED_RULES = ["amount_realized", "section_482", "other_evidenced"] as const;
export type UsAmountRealizedRule = (typeof US_AMOUNT_REALIZED_RULES)[number];

export const NZ_ASSOCIATE_COST_BASES = ["original_cost", "first_business_use_fmv"] as const;
export type NzAssociateCostBasis = (typeof NZ_ASSOCIATE_COST_BASES)[number];

export const MACRS_METHODS = ["200_db", "150_db", "straight_line"] as const;
export type MacrsMethod = (typeof MACRS_METHODS)[number];

export const MACRS_CONVENTIONS = ["half_year", "mid_quarter", "mid_month"] as const;
export type MacrsConvention = (typeof MACRS_CONVENTIONS)[number];

/** Client POST body. effectiveOn, requiredSubsidiaryIds and receivingAssetId
 *  are derived from the source financial change and must not be supplied. */
export interface TaxAssetBasisInput {
  sourceChangeId: string;
  sourceEventId?: string;
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

export interface TaxBasisValidationContext {
  sourceOperation: TaxBasisSourceOperation;
}

/** GET /assets/:id/tax-basis-sources — operator picks a labelled row.
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
  regimes: { code: TaxBasisRegime; name: string }[];
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
  sourceChangeId: string;
  effectiveOn: string;
  requiredSubsidiaryIds: string[];
  receivingAssetId: string | null;
  regimes: TaxBasisRegime[];
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
  dispositionTrigger: UsDispositionTrigger;
  partialDispositionElection?: boolean;
  originalUnadjustedBasis: string;
  remainingUnadjustedBasis: string;
  disposedUnadjustedBasis: string;
  placedInServiceOn: string;
  recoveryPeriodYears: string;
  method: MacrsMethod;
  convention: MacrsConvention;
  recognition: UsRecognition;
  relatedPerson: boolean;
  statutoryProceeds?: string;
  amountRealizedRule?: UsAmountRealizedRule;
  adjustedAmountRealized?: string;
  deemedValueAdjustmentEvidence?: string;
  buyerCost?: string;
  carryoverBasis?: string;
  excessBasis?: string;
  shortYearMethod?: UsShortYearMethod;
}

export type TaxBasisFieldKind = "decimal" | "boolean" | "enum" | "text" | "date";

export type TaxBasisFieldPredicate =
  | { always: true }
  | { never: true }
  | { regime: TaxBasisRegime }
  | { relationship: TaxBasisRelationship }
  | { sourceOperation: TaxBasisSourceOperation }
  | { fieldEquals: { name: string; values: readonly string[] } }
  | { fieldTrue: string }
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

const BUYER: TaxBasisFieldPredicate = { sourceOperation: "intercompany_transfer" };

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
    visibleWhen: { regime: "ca_cca" },
    requiredWhen: { regime: "ca_cca" },
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
    visibleWhen: { regime: "ca_cca" },
    requiredWhen: { regime: "ca_cca" },
    help: "Book portion percent and group_component are not the tax allocation.",
  },
  {
    name: "allocatedCapitalCost",
    label: "Allocated capital cost of the part",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "ca_cca" }, { fieldEquals: { name: "allocationMethod", values: ["ascertainable_amount", "operator_reasonable"] } }] },
    requiredWhen: { all: [{ regime: "ca_cca" }, { fieldEquals: { name: "allocationMethod", values: ["ascertainable_amount", "operator_reasonable"] } }] },
  },
  {
    name: "allocationFraction",
    label: "Ascertainable fraction of capital cost",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "ca_cca" }, { fieldEquals: { name: "allocationMethod", values: ["ascertainable_fraction"] } }] },
    requiredWhen: { all: [{ regime: "ca_cca" }, { fieldEquals: { name: "allocationMethod", values: ["ascertainable_fraction"] } }] },
  },
  {
    name: "allocationReason",
    label: "Reason the allocation is reasonable",
    kind: "text",
    visibleWhen: { all: [{ regime: "ca_cca" }, { fieldEquals: { name: "allocationMethod", values: ["fmv_prorata", "operator_reasonable"] } }] },
    requiredWhen: { all: [{ regime: "ca_cca" }, { fieldEquals: { name: "allocationMethod", values: ["fmv_prorata", "operator_reasonable"] } }] },
  },
  {
    name: "partFairMarketValue",
    label: "Fair market value of the part disposed of",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "ca_cca" }, { fieldEquals: { name: "allocationMethod", values: ["fmv_prorata"] } }] },
    requiredWhen: { all: [{ regime: "ca_cca" }, { fieldEquals: { name: "allocationMethod", values: ["fmv_prorata"] } }] },
  },
  {
    name: "retainedFairMarketValue",
    label: "Fair market value of the part retained",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "ca_cca" }, { fieldEquals: { name: "allocationMethod", values: ["fmv_prorata"] } }] },
    requiredWhen: { all: [{ regime: "ca_cca" }, { fieldEquals: { name: "allocationMethod", values: ["fmv_prorata"] } }] },
  },
  {
    name: "statutoryProceeds",
    label: "Actual proceeds / amount realized",
    kind: "decimal",
    visibleWhen: { any: [{ regime: "ca_cca" }, { regime: "uk_wda" }, { regime: "us_macrs" }] },
    requiredWhen: { any: [
      { all: [{ regime: "ca_cca" }, { not: { fieldEquals: { name: "rolloverElection", values: ["s85", "s97", "other"] } } }] },
      { all: [{ regime: "uk_wda" }, { relationship: "arms_length" }] },
      { all: [{ regime: "us_macrs" }, { fieldEquals: { name: "recognition", values: ["taxable"] } }] },
    ] },
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
    visibleWhen: { all: [{ regime: "ca_cca" }, { relationship: "non_arms_length" }, BUYER] },
    requiredWhen: { all: [{ regime: "ca_cca" }, { relationship: "non_arms_length" }, BUYER] },
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
    name: "capitalGainsInclusionRate",
    label: "Taxable capital-gains inclusion rate",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "ca_cca" }, { relationship: "non_arms_length" }, BUYER] },
    requiredWhen: { all: [{ regime: "ca_cca" }, { relationship: "non_arms_length" }, BUYER] },
    help: "Legislative rate for the year. The engine multiplies it by the excess of payment over seller cost. Do not type the taxable gain itself. Buyer capital cost — not collected on a sale to a customer.",
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
    visibleWhen: { regime: "uk_wda" },
    requiredWhen: { regime: "uk_wda" },
  },
  {
    name: "allocatedQualifyingExpenditure",
    label: "Qualifying expenditure of the part disposed of",
    kind: "decimal",
    visibleWhen: { regime: "uk_wda" },
    requiredWhen: { never: true },
  },
  {
    name: "saleBelowMarket",
    label: "Sold at less than market value",
    kind: "boolean",
    visibleWhen: { regime: "uk_wda" },
    requiredWhen: { regime: "uk_wda" },
  },
  {
    name: "buyerCanClaimPma",
    label: "Buyer can claim plant and machinery allowances",
    kind: "boolean",
    visibleWhen: { regime: "uk_wda" },
    requiredWhen: { regime: "uk_wda" },
  },
  {
    name: "connectedChain",
    label: "Acquired in a connected-person chain",
    kind: "boolean",
    visibleWhen: { regime: "uk_wda" },
    requiredWhen: { regime: "uk_wda" },
  },
  {
    name: "greatestQualifyingExpenditureInChain",
    label: "Greatest qualifying expenditure in the connected chain",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "uk_wda" }, { fieldTrue: "connectedChain" }] },
    requiredWhen: { all: [{ regime: "uk_wda" }, { fieldTrue: "connectedChain" }] },
    help: "CAA 2001 s.62 / HMRC CA23250. This is the disposal-value cap, not the buyer's price.",
  },
  {
    name: "buyerQualifyingExpenditure",
    label: "Buyer's qualifying expenditure",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "uk_wda" }, BUYER] },
    requiredWhen: { never: true },
  },
  {
    name: "taxableUsePercent",
    label: "Taxable-use percent",
    kind: "decimal",
    visibleWhen: { regime: "au_pool" },
    requiredWhen: { regime: "au_pool" },
  },
  {
    name: "terminationValue",
    label: "Termination value (arm's-length proceeds)",
    kind: "decimal",
    visibleWhen: { regime: "au_pool" },
    requiredWhen: { all: [{ regime: "au_pool" }, { relationship: "arms_length" }] },
  },
  {
    name: "allocatedCost",
    label: "Allocated cost of the part",
    kind: "decimal",
    visibleWhen: { regime: "au_pool" },
    requiredWhen: { never: true },
  },
  {
    name: "buyerCost",
    label: "Buyer's first-element cost",
    kind: "decimal",
    visibleWhen: { all: [{ any: [{ regime: "au_pool" }, { regime: "us_macrs" }] }, BUYER] },
    requiredWhen: { never: true },
  },
  {
    name: "consideration",
    label: "Consideration derived on disposal",
    kind: "decimal",
    visibleWhen: { regime: "nz_pool" },
    requiredWhen: { regime: "nz_pool" },
  },
  {
    name: "disposalExpenditure",
    label: "Expenditure incurred in deriving the consideration",
    kind: "decimal",
    visibleWhen: { regime: "nz_pool" },
    requiredWhen: { regime: "nz_pool" },
  },
  {
    name: "buyerPrice",
    label: "Price paid by the buyer",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "nz_pool" }, { relationship: "non_arms_length" }, BUYER] },
    requiredWhen: { all: [{ regime: "nz_pool" }, { relationship: "non_arms_length" }, BUYER] },
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
    visibleWhen: { regime: "us_macrs" },
    requiredWhen: { regime: "us_macrs" },
    help: "A native partial_disposal is a sale of a portion. Do not require an election for that trigger.",
  },
  {
    name: "partialDispositionElection",
    label: "Partial disposition election under Treas. Reg. 1.168(i)-8(d)",
    kind: "boolean",
    visibleWhen: { all: [{ regime: "us_macrs" }, { fieldEquals: { name: "dispositionTrigger", values: ["elective_other"] } }] },
    requiredWhen: { all: [{ regime: "us_macrs" }, { fieldEquals: { name: "dispositionTrigger", values: ["elective_other"] } }] },
  },
  {
    name: "originalUnadjustedBasis",
    label: "Original unadjusted depreciable basis",
    kind: "decimal",
    visibleWhen: { regime: "us_macrs" },
    requiredWhen: { regime: "us_macrs" },
  },
  {
    name: "remainingUnadjustedBasis",
    label: "Remaining unadjusted basis (same vintage)",
    kind: "decimal",
    visibleWhen: { regime: "us_macrs" },
    requiredWhen: { regime: "us_macrs" },
    help: "Continues the original placed-in-service date, method and convention. Do not restart the schedule.",
  },
  {
    name: "disposedUnadjustedBasis",
    label: "Disposed unadjusted basis (same vintage)",
    kind: "decimal",
    visibleWhen: { regime: "us_macrs" },
    requiredWhen: { regime: "us_macrs" },
  },
  {
    name: "placedInServiceOn",
    label: "Original placed-in-service date",
    kind: "date",
    visibleWhen: { regime: "us_macrs" },
    requiredWhen: { regime: "us_macrs" },
  },
  {
    name: "recoveryPeriodYears",
    label: "Recovery period (years)",
    kind: "decimal",
    visibleWhen: { regime: "us_macrs" },
    requiredWhen: { regime: "us_macrs" },
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
    visibleWhen: { regime: "us_macrs" },
    requiredWhen: { regime: "us_macrs" },
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
    visibleWhen: { regime: "us_macrs" },
    requiredWhen: { regime: "us_macrs" },
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
    visibleWhen: { all: [{ regime: "us_macrs" }, { fieldEquals: { name: "recognition", values: ["taxable"] } }] },
    requiredWhen: { all: [{ regime: "us_macrs" }, { fieldEquals: { name: "recognition", values: ["taxable"] } }] },
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
    visibleWhen: { all: [{ regime: "us_macrs" }, BUYER, { fieldEquals: { name: "recognition", values: ["nontaxable"] } }] },
    requiredWhen: { all: [{ regime: "us_macrs" }, BUYER, { fieldEquals: { name: "recognition", values: ["nontaxable"] } }] },
  },
  {
    name: "excessBasis",
    label: "Excess basis (newly placed)",
    kind: "decimal",
    visibleWhen: { all: [{ regime: "us_macrs" }, BUYER, { fieldEquals: { name: "recognition", values: ["nontaxable"] } }] },
    requiredWhen: { all: [{ regime: "us_macrs" }, BUYER, { fieldEquals: { name: "recognition", values: ["nontaxable"] } }] },
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
};

/** Buyer capital-cost / first-element / associate-cost facts. Hidden on a
 *  customer partial_disposal; required only when the receiving asset is ours. */
export const TAX_BASIS_BUYER_FIELD_NAMES = [
  "payment",
  "sellerOriginalCapitalCost",
  "transferorCharacter",
  "capitalGainsInclusionRate",
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
] as const;

export function attachTaxBasisSource(
  draft: TaxBasisDraft,
  sourceOperation: TaxBasisSourceOperation,
): TaxBasisDraft {
  return { ...draft, sourceOperation };
}

export function matchTaxBasisPredicate(predicate: TaxBasisFieldPredicate, draft: TaxBasisDraft): boolean {
  if ("always" in predicate) return true;
  if ("never" in predicate) return false;
  if ("regime" in predicate) return draft.regime === predicate.regime;
  if ("relationship" in predicate) return draft.relationship === predicate.relationship;
  if ("sourceOperation" in predicate) return draft.sourceOperation === predicate.sourceOperation;
  if ("fieldEquals" in predicate) return predicate.fieldEquals.values.includes(String(draft[predicate.fieldEquals.name] ?? ""));
  if ("fieldTrue" in predicate) return draft[predicate.fieldTrue] === true;
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
    "transferorCharacter", "capitalGainsInclusionRate", "capitalGainsDeductionClaimed",
    "rolloverElection", "electedAmount",
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
    "relatedPerson", "statutoryProceeds", "amountRealizedRule", "adjustedAmountRealized",
    "deemedValueAdjustmentEvidence", "buyerCost", "carryoverBasis", "excessBasis",
    "shortYearMethod",
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
  return moneyExact(draft[name], name);
}

function optionalMoney(draft: TaxBasisDraft, name: string): string | undefined {
  if (draft[name] == null || draft[name] === "") return undefined;
  return moneyExact(draft[name], name);
}

const DRAFT_CONTEXT_KEYS = new Set(["sourceOperation"]);

/** Calendar date without importing platform (that module pulls the database). */
export function isTaxBasisCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
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

function stripDraftContext(draft: TaxBasisDraft): TaxBasisDraft {
  const { sourceOperation: _sourceOperation, ...rest } = draft;
  return rest;
}

export function validateTaxRegimeBasis(
  input: unknown,
  context?: TaxBasisValidationContext,
): TaxRegimeBasis {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TaxBasisPolicyError("each regime workpaper must be an object");
  }
  const raw = input as TaxBasisDraft;
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
  const draft: TaxBasisDraft = { ...raw, sourceOperation: resolveSourceOperation(raw, context) };
  for (const field of TAX_BASIS_FIELDS) {
    if (!taxBasisFieldRequired(field, draft)) continue;
    if (draft[field.name] == null || draft[field.name] === "") {
      throw new TaxBasisPolicyError(`${field.name} is required for this ${regime} treatment — ${field.label.toLowerCase()}`);
    }
    if (field.kind === "decimal") moneyExact(draft[field.name], field.name);
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
  return validateUs(draft);
}

function validateCa(draft: TaxBasisDraft): CaCcaRegimeBasis {
  const allocationMethod = draft.allocationMethod as CaAllocationMethod;
  if (allocationMethod === "ascertainable_fraction") {
    const fraction = moneyExact(draft.allocationFraction, "allocationFraction");
    if (cmp(fraction, "0") <= 0 || cmp(fraction, "1") > 0) {
      throw new TaxBasisPolicyError("allocationFraction must be greater than 0 and at most 1");
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
  if (draft.relationship === "non_arms_length" && draft.sourceOperation === "intercompany_transfer") {
    const inclusion = moneyExact(draft.capitalGainsInclusionRate, "capitalGainsInclusionRate");
    if (cmp(inclusion, "0") <= 0 || cmp(inclusion, "1") > 0) {
      throw new TaxBasisPolicyError("capitalGainsInclusionRate must be greater than 0 and at most 1");
    }
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
  if (typeof draft.saleBelowMarket !== "boolean" || typeof draft.buyerCanClaimPma !== "boolean" || typeof draft.connectedChain !== "boolean") {
    throw new TaxBasisPolicyError("UK saleBelowMarket, buyerCanClaimPma and connectedChain must be booleans");
  }
  return stripDraftContext(draft) as unknown as UkWdaRegimeBasis;
}

function validateAu(draft: TaxBasisDraft): AuPoolRegimeBasis {
  const percent = moneyExact(draft.taxableUsePercent, "taxableUsePercent");
  if (cmp(percent, "0") < 0 || cmp(percent, "100") > 0) {
    throw new TaxBasisPolicyError("taxableUsePercent must be between 0 and 100");
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

function validateUs(draft: TaxBasisDraft): UsMacrsRegimeBasis {
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
  const original = moneyExact(draft.originalUnadjustedBasis, "originalUnadjustedBasis");
  const remaining = moneyExact(draft.remainingUnadjustedBasis, "remainingUnadjustedBasis");
  const disposed = moneyExact(draft.disposedUnadjustedBasis, "disposedUnadjustedBasis");
  if (cmp(add(remaining, disposed), original) !== 0) {
    throw new TaxBasisPolicyError(
      `remainingUnadjustedBasis ${remaining} plus disposedUnadjustedBasis ${disposed} must equal originalUnadjustedBasis ${original}; the vintage is split, not restarted`,
    );
  }
  if (!isTaxBasisCalendarDate(draft.placedInServiceOn)) {
    throw new TaxBasisPolicyError("placedInServiceOn must be a calendar date (YYYY-MM-DD)");
  }
  if (draft.recognition === "nontaxable" && draft.sourceOperation !== "intercompany_transfer") {
    throw new TaxBasisPolicyError(
      "a nontaxable MACRS carryover belongs on the receiving asset of an intercompany_transfer; a sale to a customer is a taxable disposition — do not record buyer carryover on a partial_disposal",
    );
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
  if (!input.sourceChangeId) throw new TaxBasisPolicyError("sourceChangeId is required");
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
    const validated = validateTaxRegimeBasis(row, context);
    if (seen.has(validated.regime)) throw new TaxBasisPolicyError(`regime ${validated.regime} is declared more than once`);
    seen.add(validated.regime);
    return validated;
  });
  return {
    sourceChangeId: input.sourceChangeId,
    sourceEventId: input.sourceEventId,
    reason: input.reason.trim(),
    assessment: input.assessment.trim(),
    idempotencyKey: input.idempotencyKey,
    regimes,
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
  const consideration = moneyExact(row.consideration, "consideration");
  const expenditure = moneyExact(row.disposalExpenditure, "disposalExpenditure");
  const excess = add(consideration, neg(expenditure));
  return formatMoney(cmp(excess, "0") < 0 ? "0" : excess, 2);
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
