/**
 * Ordered per-asset MACRS lifecycle. A latest-row shortcut cannot see a
 * subsequent disposal of a received vintage, and it drops every partial
 * except sellerPapers.at(-1).
 *
 * Typed workpaper placedInServiceOn/method/convention/recovery describe the
 * SELLER original vintage on applicable=both. Taxable buyer cost and
 * nontaxable excess are newly placed: receiving-asset date + receiving class.
 * Carryover keeps transferor history.
 */
import { add, cmp, formatMoney, mulRatio, neg, toUnits } from "../money/money.ts";
import {
  TaxBasisPolicyError,
  macrsVintageKey,
  parseMacrsVintageAllocations,
  type MacrsVintageAllocationInput,
  type MacrsVintageSource,
  type OpenMacrsVintage,
  type UsSellerMacrsVintageContext,
} from "./asset-basis-policy.ts";

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
      placedInServiceOn: vintage.placedInServiceOn,
      transferOn: vintage.transferOn,
      unadjustedBasis: vintage.basis,
      adjustedCarryover: vintage.adjustedCarryover,
      section179: vintage.section179,
      priorDepreciation: vintage.priorDepreciation,
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
  };
  const vintages: MacrsVintage[] = [];
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
