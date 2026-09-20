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
import { add, cmp, formatMoney, neg } from "../money/money.ts";

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
  /** Declared transferor adjusted basis — buyer opening/closing checkpoint. */
  adjustedCarryover: string | null;
  priorDepreciation: string | null;
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

function splitOpenVintages(
  open: MacrsVintage[],
  disposedBasis: string,
  remainingBasis: string,
  disposedOn: string,
  recognition: MacrsVintage["recognition"],
): MacrsVintage[] {
  const total = open.reduce((sum, vintage) => add(sum, vintage.basis), "0");
  if (cmp(total, "0") <= 0) return [];
  const out: MacrsVintage[] = [];
  let disposedLeft = disposedBasis;
  for (const vintage of open) {
    const take = cmp(vintage.basis, disposedLeft) <= 0 ? vintage.basis : disposedLeft;
    if (positive(take)) {
      out.push({
        ...vintage,
        basis: formatMoney(take, 4),
        disposedOn,
        recognition: recognition ?? vintage.recognition,
      });
      disposedLeft = formatMoney(add(disposedLeft, neg(take)), 4);
    }
    const keep = formatMoney(add(vintage.basis, neg(take)), 4);
    if (positive(keep)) out.push({ ...vintage, basis: keep, disposedOn: null });
  }
  const kept = out.filter((vintage) => vintage.disposedOn == null).reduce((sum, vintage) => add(sum, vintage.basis), "0");
  if (positive(remainingBasis) && cmp(formatMoney(kept, 4), formatMoney(remainingBasis, 4)) !== 0) {
    const leftover = out.filter((vintage) => vintage.disposedOn == null);
    if (leftover.length === 1) leftover[0]!.basis = formatMoney(remainingBasis, 4);
  }
  return out;
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
    adjustedCarryover: null,
    priorDepreciation: null,
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
    disposedOn: null as string | null,
    adjustedCarryover: null as string | null,
    priorDepreciation: null as string | null,
  };
  const vintages: MacrsVintage[] = [];
  if (paper.recognition === "nontaxable" && paper.carryover_basis) {
    vintages.push(carryoverVintage(paper, {
      ...shared,
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
      section179: newVintageSection179,
      basis: paper.excess_basis!,
      placedInServiceOn: paper.effective_on,
      recoveryPeriodYears: buyer.recoveryPeriodYears,
      method: buyer.method,
      convention: buyer.convention,
    });
  }
  if (paper.recognition === "taxable" && paper.buyer_cost) {
    const buyer = frozenBuyerSchedule(paper);
    vintages.push({
      ...shared,
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
      vintages = seedAcquisition(
        args.defaults,
        paper.placed_in_service_on ?? args.placedOn,
        args.acquisitionCost,
        null,
      );
    }
    const open = vintages.filter((vintage) => vintage.disposedOn == null);
    const closed = vintages.filter((vintage) => vintage.disposedOn != null);
    const recognition = asRecognition(paper.recognition) ?? "taxable";
    if (positive(paper.disposed_unadjusted_basis) && paper.remaining_basis != null) {
      vintages = [
        ...closed,
        ...splitOpenVintages(
          open,
          paper.disposed_unadjusted_basis,
          paper.remaining_basis,
          paper.effective_on,
          recognition,
        ),
      ];
      continue;
    }
    if (positive(paper.disposed_unadjusted_basis) && !positive(paper.remaining_basis)) {
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
