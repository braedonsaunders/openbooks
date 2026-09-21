/**
 * Ordered per-asset MACRS lifecycle. A latest-row shortcut cannot see a
 * subsequent disposal of a received vintage, and it drops every partial
 * except sellerPapers.at(-1).
 *
 * Typed workpaper placedInServiceOn/method/convention/recovery describe the
 * SELLER original vintage on a first declaration. After ready history, buyer
 * carryover is reconstructed from frozen buyer_vintages (per disposed vintage
 * date/method/convention/recovery and parentKey). Taxable buyer cost and
 * nontaxable excess that are not in buyer_vintages stay newly placed on the
 * receiving class. A missing buyer_vintages array keeps the legacy one-header
 * carryover path for already-applied papers.
 */
import { add, cmp, formatMoney, mulRatio, neg, toUnits } from "../money/money.ts";
import {
  TaxBasisPolicyError,
  macrsVintageKey,
  parseFrozenMacrsBuyerVintages,
  parseMacrsVintageAllocations,
  type FrozenMacrsBuyerVintage,
  type MacrsVintageAllocationInput,
  type MacrsVintageSource,
  type OpenMacrsVintage,
  type UsSellerMacrsVintageContext,
} from "./asset-basis-policy.ts";
import {
  macrsOwnershipWindowLoads,
  nextCalendarDay,
  type MacrsAppliedWindowSet,
  type MacrsYearWindow,
} from "./depreciation-pool.ts";
import {
  freezeTaxYearWindowEvidence,
  MacrsCalendarError,
  taxYearWindowEvidence,
} from "./macrs-calendar.ts";

export class MacrsVintageError extends Error {
  readonly name = "MacrsVintageError";
}

export type MacrsVintage = {
  basis: string;
  placedInServiceOn: string;
  recoveryPeriodYears: string;
  method: "200_db" | "150_db" | "straight_line";
  convention: "half_year" | "mid_quarter" | "mid_month";
  disposedOn: string | null;
  section179: string;
  bonusPercent: string;
  businessUsePercent: string;
  shortYearMethod: "simplified" | "allocation";
  role: "seller" | "buyer";
  transferOn: string | null;
  recognition: "taxable" | "nontaxable" | null;
  section168i7Kind: "nonrecognition" | "partnership_721_prior_interest" | "consolidated_group" | null;
  /** Declared transferor adjusted basis — buyer opening/closing checkpoint. */
  adjustedCarryover: string | null;
  priorDepreciation: string | null;
  /** Stable source for vintageAllocations. Retained splits keep this key. */
  source: MacrsVintageSource;
  /** Open vintage this carryover was split from. Null on original / new placement. */
  parentKey: string | null;
};

export type MacrsWorkpaperEvent = {
  asset_id: string;
  receiving_asset_id: string | null;
  effective_on: string;
  seller_subsidiary_id: string;
  buyer_subsidiary_id: string | null;
  remaining_basis: string | null;
  disposed_unadjusted_basis: string | null;
  carryover_basis: string | null;
  excess_basis: string | null;
  buyer_cost: string | null;
  recognition: string | null;
  section_168i7_kind: string | null;
  related_person: string | null;
  recovery_period_years: string | null;
  placed_in_service_on: string | null;
  macrs_method: string | null;
  macrs_convention: string | null;
  short_year_method: string | null;
  buyer_placed_in_service_on: string | null;
  buyer_recovery_period_years: string | null;
  buyer_method: string | null;
  buyer_convention: string | null;
  original_unadjusted_basis: string | null;
  section_179: string | null;
  bonus_percent: string | null;
  business_use_percent: string | null;
  prior_depreciation: string | null;
  vintage_allocations: MacrsVintageAllocationInput[] | null;
  buyer_vintages: FrozenMacrsBuyerVintage[] | null;
};

export type MacrsVintageDefaults = {
  recoveryPeriodYears: string;
  method: MacrsVintage["method"];
  convention: MacrsVintage["convention"];
  section179: string;
  bonusPercent: string;
  businessUsePercent: string;
  shortYearMethod: "simplified" | "allocation";
};

/** Asset/vintage identity used to find the paper that received or dated a vintage. */
export type MacrsLineageIdentity = {
  source: MacrsVintageSource;
  placedInServiceOn: string;
  transferOn: string | null;
  parentKey: string | null;
};

export type MacrsLineagePaper = {
  asset_id: string;
  receiving_asset_id: string | null;
  effective_on: string;
  seller_subsidiary_id: string;
  buyer_vintages?: unknown;
  vintage_allocations?: unknown;
};

function lineageKey(identity: MacrsLineageIdentity): string {
  return macrsVintageKey(identity);
}

function lineageParseError(error: unknown): never {
  throw error instanceof TaxBasisPolicyError || error instanceof MacrsVintageError
    ? new MacrsVintageError(error.message)
    : error;
}

function paperBuyerIdentities(paper: MacrsLineagePaper): MacrsLineageIdentity[] | null {
  if (paper.buyer_vintages == null) return null;
  if (!Array.isArray(paper.buyer_vintages)) {
    lineageParseError(new TaxBasisPolicyError(
      "buyerVintages must freeze each disposed MACRS vintage; do not invent one composite receiver schedule",
    ));
  }
  if (paper.buyer_vintages.length === 0) return [];
  try {
    return parseFrozenMacrsBuyerVintages(paper.buyer_vintages).map((vintage) => ({
      source: vintage.source,
      placedInServiceOn: vintage.placedInServiceOn,
      transferOn: vintage.transferOn,
      parentKey: vintage.parentKey,
    }));
  } catch (error) {
    lineageParseError(error);
  }
}

function paperSellerIdentities(paper: MacrsLineagePaper): MacrsLineageIdentity[] | null {
  if (paper.vintage_allocations == null) return null;
  try {
    return parseMacrsVintageAllocations(paper.vintage_allocations).map((row) => ({
      source: row.source,
      placedInServiceOn: row.placedInServiceOn,
      transferOn: row.transferOn ?? null,
      parentKey: row.parentKey ?? null,
    }));
  } catch (error) {
    lineageParseError(error);
  }
}

function paperReceivesVintage(paper: MacrsLineagePaper, vintage: MacrsLineageIdentity): boolean {
  if (paper.receiving_asset_id == null) return false;
  if (vintage.transferOn == null || paper.effective_on !== vintage.transferOn) return false;
  const buyers = paperBuyerIdentities(paper);
  if (buyers == null) return true;
  return buyers.some((row) => lineageKey(row) === lineageKey(vintage));
}

function paperAllocatesSellerVintage(paper: MacrsLineagePaper, vintage: MacrsLineageIdentity): boolean {
  const allocations = paperSellerIdentities(paper);
  if (!allocations) return false;
  return allocations.some((row) => lineageKey(row) === lineageKey(vintage));
}

/** The workpaper that received this vintage onto `receivingAssetId`.
 *  Two same-day transfers to one entity are distinguished by receiving
 *  asset and buyer-vintage parentKey — not by date and buyer subsidiary. */
export function macrsVintageReceivingPaper<T extends MacrsLineagePaper>(
  papers: readonly T[],
  receivingAssetId: string,
  vintage: MacrsLineageIdentity,
): T | null {
  if (vintage.transferOn == null) return null;
  const ontoAsset = papers.filter((paper) => paper.receiving_asset_id === receivingAssetId);
  const identified = ontoAsset.filter((paper) => paperReceivesVintage(paper, vintage));
  if (identified.length === 1) return identified[0]!;
  if (identified.length > 1) {
    const sources = identified.map((paper) => paper.asset_id).sort().join(", ");
    throw new MacrsVintageError(
      `two applied workpapers on ${vintage.transferOn} receive onto this asset (${sources}); identify the vintage by source, placedInServiceOn, transferOn and parentKey — do not pick a transferor by date and buyer subsidiary`,
    );
  }
  return null;
}

/** Applied papers that dated this vintage, oldest first: the receiving paper
 *  plus later seller allocations on the same asset. */
export function macrsVintageDatingPapers<T extends MacrsLineagePaper>(
  papers: readonly T[],
  assetId: string,
  vintage: MacrsLineageIdentity,
): T[] {
  const dating = papers.filter((paper) => {
    if (paper.receiving_asset_id === assetId && paperReceivesVintage(paper, vintage)) return true;
    if (paper.asset_id !== assetId) return false;
    if (paperAllocatesSellerVintage(paper, vintage)) return true;
    return paper.receiving_asset_id !== assetId
      && paper.vintage_allocations == null
      && (vintage.transferOn == null || paper.effective_on >= vintage.transferOn);
  });
  return [...dating].sort((left, right) =>
    left.effective_on === right.effective_on
      ? left.asset_id.localeCompare(right.asset_id)
      : left.effective_on.localeCompare(right.effective_on),
  );
}

export type MacrsFrozenLineagePaper = MacrsLineagePaper & {
  taxYearWindows?: MacrsYearWindow[] | null;
};

/** Live loads after every applied paper that already froze this vintage.
 *  Transferor history is not re-fetched once a paper sealed its window set. */
export function macrsVintageWindowPlan(args: {
  assetId: string;
  currentSubsidiaryId: string;
  asOf: string;
  vintage: MacrsLineageIdentity;
  papers: readonly MacrsFrozenLineagePaper[];
}): {
  transferorSubsidiaryId: string | null;
  frozenSets: MacrsAppliedWindowSet[];
  liveLoads: { subsidiaryId: string; fromOn: string; throughOn: string }[];
} {
  const receiving = macrsVintageReceivingPaper(args.papers, args.assetId, args.vintage);
  const dating = macrsVintageDatingPapers(args.papers, args.assetId, args.vintage);
  const frozenSets = dating
    .filter((paper) => (paper.taxYearWindows?.length ?? 0) > 0)
    .map((paper) => ({
      throughOn: paper.effective_on,
      windows: paper.taxYearWindows!,
    }));
  const lastFrozenOn = frozenSets.at(-1)?.throughOn ?? null;
  if (frozenSets.length > 0 && lastFrozenOn) {
    const laterFrom = nextCalendarDay(lastFrozenOn);
    return {
      transferorSubsidiaryId: receiving?.seller_subsidiary_id ?? null,
      frozenSets,
      liveLoads: laterFrom <= args.asOf
        ? [{
            subsidiaryId: args.currentSubsidiaryId,
            fromOn: laterFrom,
            throughOn: args.asOf,
          }]
        : [],
    };
  }
  return {
    transferorSubsidiaryId: receiving?.seller_subsidiary_id ?? null,
    frozenSets: [],
    liveLoads: macrsOwnershipWindowLoads({
      placedInServiceOn: args.vintage.placedInServiceOn,
      transferOn: args.vintage.transferOn,
      asOf: args.asOf,
      currentSubsidiaryId: args.currentSubsidiaryId,
      transferorSubsidiaryId: receiving?.seller_subsidiary_id ?? null,
    }),
  };
}

/** Rehydrate an applied paper's computed.taxYearWindows. `null` means the
 *  paper predates the freeze and reconstruction must live-load. */
export function macrsWindowsFromAppliedComputed(computed: unknown): MacrsYearWindow[] | null {
  if (computed == null || typeof computed !== "object" || Array.isArray(computed)) return null;
  const rows = (computed as { taxYearWindows?: unknown }).taxYearWindows;
  if (rows == null) return null;
  if (!Array.isArray(rows)) {
    throw new MacrsVintageError(
      "applied workpaper computed.taxYearWindows must be an array of the windows that paper consumed; reverse and re-propose it — do not load a live calendar over a missing set",
    );
  }
  try {
    return freezeTaxYearWindowEvidence(rows.map((row, index) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new MacrsVintageError(
          `applied workpaper computed.taxYearWindows[${index}] must be a registered window; reverse and re-propose it`,
        );
      }
      const raw = row as Record<string, unknown>;
      return taxYearWindowEvidence({
        id: typeof raw.id === "string" ? raw.id : undefined,
        subsidiaryId: typeof raw.subsidiaryId === "string" ? raw.subsidiaryId : undefined,
        regime: typeof raw.regime === "string" ? raw.regime : undefined,
        taxYear: typeof raw.filingYear === "number" ? raw.filingYear : Number(raw.taxYear),
        yearStart: String(raw.yearStart ?? ""),
        yearEnd: String(raw.yearEnd ?? ""),
      });
    })).map((row) => ({
      id: row.id,
      subsidiaryId: row.subsidiaryId,
      regime: row.regime,
      taxYear: row.filingYear,
      yearStart: row.yearStart,
      yearEnd: row.yearEnd,
    }));
  } catch (error) {
    if (error instanceof MacrsVintageError) throw error;
    throw new MacrsVintageError(
      error instanceof MacrsCalendarError || error instanceof Error
        ? error.message
        : "applied workpaper computed.taxYearWindows could not be read; reverse and re-propose it",
    );
  }
}

function positive(value: string | null | undefined): value is string {
  return !!value && cmp(value, "0") > 0;
}

function asMethod(value: string | null, fallback: MacrsVintage["method"]): MacrsVintage["method"] {
  return value === "200_db" || value === "150_db" || value === "straight_line" ? value : fallback;
}

function asConvention(
  value: string | null,
  fallback: MacrsVintage["convention"],
): MacrsVintage["convention"] {
  return value === "half_year" || value === "mid_quarter" || value === "mid_month" ? value : fallback;
}

function asRecognition(value: string | null): MacrsVintage["recognition"] {
  return value === "nontaxable" || value === "taxable" ? value : null;
}

function as168i7Kind(value: string | null): MacrsVintage["section168i7Kind"] {
  return value === "nonrecognition"
    || value === "partnership_721_prior_interest"
    || value === "consolidated_group"
    ? value
    : null;
}

function splitAmount(amount: string | null, take: string, total: string): { take: string | null; keep: string | null } {
  if (amount == null) return { take: null, keep: null };
  if (cmp(total, "0") <= 0) return { take: formatMoney(amount, 4), keep: formatMoney("0", 4) };
  const taken = formatMoney(mulRatio(amount, toUnits(take), toUnits(total)), 4);
  return { take: taken, keep: formatMoney(add(amount, neg(taken)), 4) };
}

function splitOneVintage(
  vintage: MacrsVintage,
  disposedBasis: string,
  remainingBasis: string,
  disposedOn: string,
  recognition: MacrsVintage["recognition"],
): MacrsVintage[] {
  if (cmp(add(disposedBasis, remainingBasis), vintage.basis) !== 0) {
    throw new MacrsVintageError(
      `vintage ${macrsVintageKey(vintage)} disposed ${disposedBasis} plus remaining ${remainingBasis} must equal that vintage's unadjusted basis ${vintage.basis}; do not overwrite a retained vintage to hide a conflicting split`,
    );
  }
  const section179 = splitAmount(vintage.section179, disposedBasis, vintage.basis);
  const priorDepreciation = splitAmount(vintage.priorDepreciation, disposedBasis, vintage.basis);
  const adjustedCarryover = splitAmount(vintage.adjustedCarryover, disposedBasis, vintage.basis);
  const out: MacrsVintage[] = [];
  if (positive(disposedBasis)) {
    out.push({
      ...vintage,
      basis: formatMoney(disposedBasis, 4),
      disposedOn,
      recognition: recognition ?? vintage.recognition,
      section179: section179.take ?? vintage.section179,
      priorDepreciation: priorDepreciation.take,
      adjustedCarryover: adjustedCarryover.take,
    });
  }
  if (positive(remainingBasis)) {
    out.push({
      ...vintage,
      basis: formatMoney(remainingBasis, 4),
      disposedOn: null,
      section179: section179.keep ?? vintage.section179,
      priorDepreciation: priorDepreciation.keep,
      adjustedCarryover: adjustedCarryover.keep,
    });
  }
  return out;
}

function splitOpenVintages(
  open: MacrsVintage[],
  disposedBasis: string,
  remainingBasis: string,
  disposedOn: string,
  recognition: MacrsVintage["recognition"],
  allocations?: MacrsVintageAllocationInput[],
): MacrsVintage[] {
  const total = open.reduce((sum, vintage) => add(sum, vintage.basis), "0");
  if (cmp(total, "0") <= 0) {
    throw new MacrsVintageError(
      "this MACRS workpaper disposes basis but no open vintage remains; reverse and re-propose it — do not invent a split",
    );
  }
  if (cmp(add(disposedBasis, remainingBasis), total) !== 0) {
    throw new MacrsVintageError(
      `disposedUnadjustedBasis ${disposedBasis} plus remaining basis ${remainingBasis} must equal open MACRS basis ${total}; do not overwrite a retained vintage to hide a conflicting split`,
    );
  }
  if (allocations && allocations.length > 0) {
    const byKey = new Map(open.map((vintage) => [macrsVintageKey(vintage), vintage]));
    if (allocations.length !== open.length) {
      throw new MacrsVintageError(
        `vintageAllocations must declare every open MACRS vintage exactly once (${open.map((vintage) => macrsVintageKey(vintage)).join(", ")}); do not infer a leftover vintage from header remaining`,
      );
    }
    const used = new Set<string>();
    const out: MacrsVintage[] = [];
    for (const row of allocations) {
      const key = macrsVintageKey(row);
      const vintage = byKey.get(key);
      if (!vintage) {
        throw new MacrsVintageError(
          `vintageAllocations names ${key} but the open vintages are ${[...byKey.keys()].join(", ")}; record the source, placedInServiceOn and transferOn of an open vintage — do not invent a key`,
        );
      }
      if (used.has(key)) {
        throw new MacrsVintageError(
          `vintageAllocations declares ${key} more than once; each open vintage is allocated exactly once`,
        );
      }
      used.add(key);
      out.push(...splitOneVintage(
        vintage,
        row.disposedUnadjustedBasis,
        row.remainingUnadjustedBasis,
        disposedOn,
        recognition,
      ));
    }
    return out;
  }
  if (open.length === 1) {
    return splitOneVintage(open[0]!, disposedBasis, remainingBasis, disposedOn, recognition);
  }
  if (cmp(disposedBasis, total) === 0 && !positive(remainingBasis)) {
    return open.flatMap((vintage) =>
      splitOneVintage(vintage, vintage.basis, "0", disposedOn, recognition),
    );
  }
  throw new MacrsVintageError(
    `this workpaper's disposed/remaining split does not identify which MACRS vintage is transferred; declare vintageAllocations for each open vintage (${open.map((vintage) => macrsVintageKey(vintage)).join(", ")}) — do not FIFO-allocate carryover and excess`,
  );
}

/** Open vintages the native editor must present as allocation rows. */
export function listOpenMacrsVintages(vintages: readonly MacrsVintage[]): OpenMacrsVintage[] {
  return vintages
    .filter((vintage) => vintage.disposedOn == null)
    .map((vintage) => ({
      key: macrsVintageKey(vintage),
      source: vintage.source,
      parentKey: vintage.parentKey,
      placedInServiceOn: vintage.placedInServiceOn,
      transferOn: vintage.transferOn,
      unadjustedBasis: vintage.basis,
      adjustedCarryover: vintage.adjustedCarryover,
      section179: vintage.section179,
      priorDepreciation: vintage.priorDepreciation,
      recoveryPeriodYears: vintage.recoveryPeriodYears,
      method: vintage.method,
      convention: vintage.convention,
      bonusPercent: vintage.bonusPercent,
      businessUsePercent: vintage.businessUsePercent,
      shortYearMethod: vintage.shortYearMethod,
      section168i7Kind: vintage.section168i7Kind,
    }));
}

export function missingUsSellerPrerequisite(
  priorSources: readonly { key: string; occurredOn: string }[],
  paperSourceKeys: readonly string[],
): { key: string; occurredOn: string } | null {
  const have = new Set(paperSourceKeys);
  return priorSources.find((source) => !have.has(source.key)) ?? null;
}

/** Reconstruct seller history immediately before a source. No prior papers
 *  is a first declaration only when no earlier source event exists. A prior
 *  source without a US paper is refused — not treated as a first declaration
 *  and not seeded from book cost. */
export function sellerMacrsHistoryBeforeSource(args: {
  assetId: string;
  subsidiaryId: string;
  papers: MacrsWorkpaperEvent[];
  defaults: MacrsVintageDefaults;
  priorSources?: { key: string; occurredOn: string }[];
  paperSourceKeys?: string[];
}): UsSellerMacrsVintageContext {
  const missing = missingUsSellerPrerequisite(args.priorSources ?? [], args.paperSourceKeys ?? []);
  if (missing) {
    return {
      status: "history_refused",
      refusal:
        `the earlier ${missing.occurredOn} disposal or transfer has no applied US tax basis workpaper; record and apply that workpaper before this source — do not treat a missing prerequisite paper as a first original declaration`,
    };
  }
  if (args.papers.length === 0) {
    return { status: "original_declaration_required" };
  }
  try {
    const vintages = resolveMacrsVintages({
      assetId: args.assetId,
      subsidiaryId: args.subsidiaryId,
      placedOn: "0001-01-01",
      acquisitionCost: "0",
      disposedOn: null,
      papers: args.papers,
      defaults: args.defaults,
      allowBookAcquisition: false,
    });
    const open = listOpenMacrsVintages(vintages);
    if (open.length === 0) {
      return {
        status: "history_refused",
        refusal:
          "no open MACRS vintage remains before this source; the earlier workpaper disposed the last unadjusted basis — do not seed book acquisition cost or invent a composite vintage",
      };
    }
    return { status: "ready", vintages: open };
  } catch (error) {
    return {
      status: "history_refused",
      refusal:
        error instanceof Error
          ? error.message
          : "MACRS history could not be reconstructed from the frozen workpapers",
    };
  }
}

function seedSellerPaper(paper: MacrsWorkpaperEvent, defaults: MacrsVintageDefaults): MacrsVintage[] {
  if (!paper.original_unadjusted_basis) {
    throw new MacrsVintageError(
      "frozen US workpaper is missing originalUnadjustedBasis for the seller vintage; reverse and re-propose it — do not substitute book acquisition cost",
    );
  }
  if (!paper.placed_in_service_on) {
    throw new MacrsVintageError(
      "frozen US workpaper is missing placedInServiceOn for the seller vintage; reverse and re-propose it — do not use the mutable asset date",
    );
  }
  if (!paper.recovery_period_years) {
    throw new MacrsVintageError(
      "frozen US workpaper is missing recoveryPeriodYears for the seller vintage; reverse and re-propose it — do not use the mutable class recovery period",
    );
  }
  if (
    paper.macrs_method !== "200_db"
    && paper.macrs_method !== "150_db"
    && paper.macrs_method !== "straight_line"
  ) {
    throw new MacrsVintageError(
      "frozen US workpaper is missing method for the seller vintage; reverse and re-propose it — do not use the mutable class method",
    );
  }
  if (
    paper.macrs_convention !== "half_year"
    && paper.macrs_convention !== "mid_quarter"
    && paper.macrs_convention !== "mid_month"
  ) {
    throw new MacrsVintageError(
      "frozen US workpaper is missing convention for the seller vintage; reverse and re-propose it — do not use the mutable class convention",
    );
  }
  return [{
    ...defaults,
    basis: paper.original_unadjusted_basis,
    placedInServiceOn: paper.placed_in_service_on,
    recoveryPeriodYears: paper.recovery_period_years,
    method: paper.macrs_method,
    convention: paper.macrs_convention,
    section179: paper.section_179 ?? defaults.section179,
    bonusPercent: paper.bonus_percent ?? defaults.bonusPercent,
    businessUsePercent: paper.business_use_percent ?? defaults.businessUsePercent,
    disposedOn: null,
    role: "seller",
    transferOn: null,
    recognition: null,
    section168i7Kind: as168i7Kind(paper.section_168i7_kind),
    adjustedCarryover: null,
    priorDepreciation: paper.prior_depreciation,
    source: "original",
    parentKey: null,
  }];
}

function seedAcquisition(
  defaults: MacrsVintageDefaults,
  placedOn: string,
  basis: string,
  disposedOn: string | null,
): MacrsVintage[] {
  return [{
    ...defaults,
    basis,
    placedInServiceOn: placedOn,
    disposedOn,
    role: "seller",
    transferOn: null,
    recognition: disposedOn ? "taxable" : null,
    section168i7Kind: null,
    adjustedCarryover: null,
    priorDepreciation: null,
    source: "original",
    parentKey: null,
  }];
}

function frozenBuyerSchedule(paper: MacrsWorkpaperEvent): {
  placedInServiceOn: string;
  recoveryPeriodYears: string;
  method: MacrsVintage["method"];
  convention: MacrsVintage["convention"];
} {
  if (
    !paper.buyer_placed_in_service_on ||
    !paper.buyer_recovery_period_years ||
    !paper.buyer_method ||
    !paper.buyer_convention
  ) {
    throw new MacrsVintageError(
      "frozen US workpaper is missing the buyer MACRS schedule; reverse and re-propose it — do not substitute the receiving asset's current class or the transferor's vintage",
    );
  }
  return {
    placedInServiceOn: paper.buyer_placed_in_service_on,
    recoveryPeriodYears: paper.buyer_recovery_period_years,
    method: asMethod(paper.buyer_method, "200_db"),
    convention: asConvention(paper.buyer_convention, "half_year"),
  };
}

function receiverFromFrozenBuyerVintage(
  paper: MacrsWorkpaperEvent,
  defaults: MacrsVintageDefaults,
  vintage: FrozenMacrsBuyerVintage,
): MacrsVintage {
  const shortYearMethod = paper.short_year_method === "allocation" ? "allocation" : defaults.shortYearMethod;
  return {
    ...defaults,
    shortYearMethod,
    role: "buyer",
    source: vintage.source,
    parentKey: vintage.parentKey,
    placedInServiceOn: vintage.placedInServiceOn,
    transferOn: vintage.transferOn,
    recoveryPeriodYears: vintage.recoveryPeriodYears,
    method: vintage.method,
    convention: vintage.convention,
    basis: vintage.unadjustedBasis,
    section179: vintage.section179,
    bonusPercent: vintage.bonusPercent,
    businessUsePercent: vintage.businessUsePercent,
    adjustedCarryover: vintage.adjustedCarryover,
    priorDepreciation: vintage.priorDepreciation,
    recognition: asRecognition(paper.recognition),
    section168i7Kind: as168i7Kind(paper.section_168i7_kind),
    disposedOn: null,
  };
}

function receiverVintages(
  paper: MacrsWorkpaperEvent,
  defaults: MacrsVintageDefaults,
  runSubsidiaryId: string,
): MacrsVintage[] {
  if (paper.buyer_subsidiary_id !== runSubsidiaryId) return [];
  const related = paper.related_person === "true";
  const newVintageSection179 = related ? "0" : defaults.section179;
  const transferorRecovery = paper.recovery_period_years || defaults.recoveryPeriodYears;
  const transferorMethod = asMethod(paper.macrs_method, defaults.method);
  const transferorConvention = asConvention(paper.macrs_convention, defaults.convention);
  const shortYearMethod = paper.short_year_method === "allocation" ? "allocation" : defaults.shortYearMethod;
  const recognition = asRecognition(paper.recognition);
  const transferorPlaced = paper.placed_in_service_on ?? paper.effective_on;
  const shared = {
    ...defaults,
    shortYearMethod,
    role: "buyer" as const,
    transferOn: paper.effective_on,
    recognition,
    section168i7Kind: as168i7Kind(paper.section_168i7_kind),
    disposedOn: null as string | null,
    adjustedCarryover: null as string | null,
    priorDepreciation: null as string | null,
    parentKey: null as string | null,
  };
  const vintages: MacrsVintage[] = [];
  if (paper.buyer_vintages && paper.buyer_vintages.length > 0) {
    let frozen: FrozenMacrsBuyerVintage[];
    try {
      frozen = parseFrozenMacrsBuyerVintages(paper.buyer_vintages);
    } catch (error) {
      throw error instanceof TaxBasisPolicyError ? new MacrsVintageError(error.message) : error;
    }
    vintages.push(...frozen.map((vintage) => receiverFromFrozenBuyerVintage(paper, defaults, vintage)));
    const hasExcess = frozen.some((vintage) => vintage.source === "excess");
    const hasTaxable = frozen.some((vintage) => vintage.source === "taxable_cost");
    if (paper.recognition === "nontaxable" && positive(paper.excess_basis) && !hasExcess) {
      const buyer = frozenBuyerSchedule(paper);
      vintages.push({
        ...shared,
        source: "excess",
        section179: newVintageSection179,
        basis: paper.excess_basis!,
        placedInServiceOn: buyer.placedInServiceOn,
        recoveryPeriodYears: buyer.recoveryPeriodYears,
        method: buyer.method,
        convention: buyer.convention,
      });
    }
    if (paper.recognition === "taxable" && paper.buyer_cost && !hasTaxable) {
      const buyer = frozenBuyerSchedule(paper);
      vintages.push({
        ...shared,
        source: "taxable_cost",
        section179: newVintageSection179,
        basis: paper.buyer_cost,
        placedInServiceOn: buyer.placedInServiceOn,
        recoveryPeriodYears: buyer.recoveryPeriodYears,
        method: buyer.method,
        convention: buyer.convention,
      });
    }
    return vintages;
  }
  if (paper.recognition === "nontaxable" && paper.carryover_basis) {
    vintages.push(carryoverVintage(paper, {
      ...shared,
      source: "carryover",
      placedInServiceOn: transferorPlaced,
      recoveryPeriodYears: transferorRecovery,
      method: transferorMethod,
      convention: transferorConvention,
    }));
  }
  if (paper.recognition === "nontaxable" && positive(paper.excess_basis)) {
    const buyer = frozenBuyerSchedule(paper);
    vintages.push({
      ...shared,
      source: "excess",
      section179: newVintageSection179,
      basis: paper.excess_basis!,
      placedInServiceOn: buyer.placedInServiceOn,
      recoveryPeriodYears: buyer.recoveryPeriodYears,
      method: buyer.method,
      convention: buyer.convention,
    });
  }
  if (paper.recognition === "taxable" && paper.buyer_cost) {
    const buyer = frozenBuyerSchedule(paper);
    vintages.push({
      ...shared,
      source: "taxable_cost",
      section179: newVintageSection179,
      basis: paper.buyer_cost,
      placedInServiceOn: buyer.placedInServiceOn,
      recoveryPeriodYears: buyer.recoveryPeriodYears,
      method: buyer.method,
      convention: buyer.convention,
    });
  }
  return vintages;
}

function requireFrozenElection(paper: MacrsWorkpaperEvent, field: keyof MacrsWorkpaperEvent, name: string): string {
  const value = paper[field];
  if (value == null || value === "") {
    throw new MacrsVintageError(
      `frozen US workpaper is missing ${name} for nontaxable carryover; reverse and re-propose it — missing receiving or foreign tax-depreciation JSON is not a zero ${name}, and the whole source-asset election must not be copied onto this slice`,
    );
  }
  return String(value);
}

function carryoverVintage(
  paper: MacrsWorkpaperEvent,
  shared: Omit<MacrsVintage, "basis" | "section179" | "bonusPercent" | "businessUsePercent">,
): MacrsVintage {
  const original = paper.disposed_unadjusted_basis || paper.original_unadjusted_basis;
  if (!original) {
    throw new MacrsVintageError(
      "frozen US workpaper is missing the transferor original tax basis for nontaxable carryover; reverse and re-propose it — do not treat carryoverBasis as original unadjusted basis",
    );
  }
  return {
    ...shared,
    basis: original,
    adjustedCarryover: paper.carryover_basis,
    priorDepreciation: requireFrozenElection(paper, "prior_depreciation", "priorDepreciation"),
    section179: requireFrozenElection(paper, "section_179", "section179"),
    bonusPercent: requireFrozenElection(paper, "bonus_percent", "bonusPercent"),
    businessUsePercent: requireFrozenElection(paper, "business_use_percent", "businessUsePercent"),
  };
}

export function resolveMacrsVintages(args: {
  assetId: string;
  subsidiaryId: string;
  placedOn: string;
  acquisitionCost: string;
  disposedOn: string | null;
  papers: MacrsWorkpaperEvent[];
  defaults: MacrsVintageDefaults;
  /** Pool-run may seed the first undeclared vintage from book acquisition.
   *  Seller source reconstruction must not — missing papers are a first
   *  declaration or a refused history. */
  allowBookAcquisition?: boolean;
}): MacrsVintage[] {
  const ordered = [...args.papers].sort((left, right) =>
    left.effective_on === right.effective_on
      ? left.asset_id.localeCompare(right.asset_id)
      : left.effective_on.localeCompare(right.effective_on),
  );
  let vintages: MacrsVintage[] = [];
  for (const paper of ordered) {
    if (paper.receiving_asset_id === args.assetId) {
      const received = receiverVintages(paper, args.defaults, args.subsidiaryId);
      if (received.length > 0) vintages = received;
      continue;
    }
    if (paper.asset_id !== args.assetId || paper.seller_subsidiary_id !== args.subsidiaryId) continue;
    if (vintages.length === 0) {
      vintages = seedSellerPaper(paper, args.defaults);
    }
    const open = vintages.filter((vintage) => vintage.disposedOn == null);
    const closed = vintages.filter((vintage) => vintage.disposedOn != null);
    const recognition = asRecognition(paper.recognition) ?? "taxable";
    if (positive(paper.disposed_unadjusted_basis) && paper.remaining_basis != null) {
      let allocations: MacrsVintageAllocationInput[] | undefined;
      if (paper.vintage_allocations != null) {
        try {
          allocations = parseMacrsVintageAllocations(paper.vintage_allocations);
        } catch (error) {
          throw error instanceof TaxBasisPolicyError ? new MacrsVintageError(error.message) : error;
        }
      }
      vintages = [
        ...closed,
        ...splitOpenVintages(
          open,
          paper.disposed_unadjusted_basis,
          paper.remaining_basis,
          paper.effective_on,
          recognition,
          allocations,
        ),
      ];
      continue;
    }
    if (positive(paper.disposed_unadjusted_basis) && paper.remaining_basis == null) {
      const total = open.reduce((sum, vintage) => add(sum, vintage.basis), "0");
      if (cmp(paper.disposed_unadjusted_basis, total) !== 0) {
        throw new MacrsVintageError(
          `disposedUnadjustedBasis ${paper.disposed_unadjusted_basis} does not equal open MACRS basis ${total} and remaining basis was omitted; record the leftover remaining vintage or a whole-vintage disposal — do not leave requested disposal basis unallocated`,
        );
      }
      vintages = [
        ...closed,
        ...open.map((vintage) => ({
          ...vintage,
          disposedOn: paper.effective_on,
          recognition,
        })),
      ];
    }
  }
  if (vintages.length === 0) {
    if (args.allowBookAcquisition === false) {
      throw new MacrsVintageError(
        "no frozen MACRS vintage exists before this source; declare the original statutory basis on the first workpaper — do not seed book acquisition cost",
      );
    }
    return seedAcquisition(args.defaults, args.placedOn, args.acquisitionCost, args.disposedOn);
  }
  if (args.disposedOn) {
    vintages = vintages.map((vintage) =>
      vintage.disposedOn == null
        ? { ...vintage, disposedOn: args.disposedOn, recognition: "taxable" }
        : vintage,
    );
  }
  return vintages;
}
