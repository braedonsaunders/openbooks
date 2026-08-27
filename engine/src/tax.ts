import {
  add,
  cmp,
  fromUnits,
  mulPercent,
  normalizeMoney,
  sum,
  toUnits,
} from "./money.ts";

/** Exact, auditable indirect-tax calculation. No monetary value becomes a JS Number. */

export type TaxCalculationType = "standard" | "withholding" | "reverse_charge";

export interface TaxComponentConfig {
  taxCodeId: string;
  code?: string;
  sequence: number;
  ratePercent: string;
  recoverablePercent?: string;
  calculationType?: TaxCalculationType;
  priceIncludesTax?: boolean;
  compoundOnPrevious?: boolean;
  roundingScale?: number;
  collectedAccountId?: string | null;
  paidAccountId?: string | null;
  withholdingAccountId?: string | null;
}

export interface ComputedTaxComponent {
  taxCodeId: string;
  code?: string;
  sequence: number;
  ratePercent: string;
  /** Configured recovery ratio retained even when the rounded tax is zero. */
  recoverablePercent?: string;
  taxableAmount: string;
  taxAmount: string;
  recoverableAmount: string;
  nonrecoverableAmount: string;
  calculationType: TaxCalculationType;
  priceIncludesTax: boolean;
  compoundOnPrevious: boolean;
  roundingScale: number;
  collectedAccountId: string | null;
  paidAccountId: string | null;
  withholdingAccountId: string | null;
  overridden: boolean;
}

export interface ComputedLineTax {
  /** User-entered amount before inclusive tax is extracted. */
  inputAmount: string;
  /** Tax-exclusive line amount stored and posted to income/expense. */
  netAmount: string;
  /** Signed amount added to the payable/receivable: standard − withholding. */
  taxTotal: string;
  /** Net amount + taxTotal. Reverse-charge components do not change settlement. */
  total: string;
  components: ComputedTaxComponent[];
  overridden: boolean;
}

export class TaxCalculationError extends Error {
  readonly name = "TaxCalculationError";
}

function validateConfig(
  components: TaxComponentConfig[],
): TaxComponentConfig[] {
  const sorted = [...components].sort((a, b) => a.sequence - b.sequence);
  const seen = new Set<string>();
  for (const c of sorted) {
    if (!c.taxCodeId)
      throw new TaxCalculationError("tax component is missing its tax code");
    if (seen.has(c.taxCodeId))
      throw new TaxCalculationError(
        `tax code ${c.taxCodeId} occurs more than once`,
      );
    seen.add(c.taxCodeId);
    // The rate domain is stated once here: a nonnegative exact decimal with at
    // most 4 decimal places (tax_rates.rate_percent is numeric(19,4)). Setup
    // validates the same contract before writes; this is the calculation-time
    // backstop, and it fails closed with the engine's error type instead of a
    // raw coercion fault.
    let rateUnits: bigint;
    try {
      rateUnits = toUnits(c.ratePercent);
    } catch {
      throw new TaxCalculationError(
        "tax rate must be an exact decimal with at most 4 decimal places",
      );
    }
    if (rateUnits < 0n)
      throw new TaxCalculationError("tax rate cannot be negative");
    let recoverable: bigint;
    try {
      recoverable = toUnits(c.recoverablePercent ?? "100");
    } catch {
      throw new TaxCalculationError(
        "recoverable percentage must be an exact decimal between 0 and 100",
      );
    }
    if (recoverable < 0n || recoverable > toUnits("100")) {
      throw new TaxCalculationError(
        "recoverable percentage must be between 0 and 100",
      );
    }
    const scale = c.roundingScale ?? 2;
    if (!Number.isInteger(scale) || scale < 0 || scale > 4) {
      throw new TaxCalculationError(
        "tax rounding scale must be an integer from 0 through 4",
      );
    }
    const kind = c.calculationType ?? "standard";
    if (c.priceIncludesTax && kind !== "standard") {
      throw new TaxCalculationError(
        "withholding and reverse-charge taxes cannot be price-inclusive",
      );
    }
  }
  const standards = sorted.filter(
    (c) => (c.calculationType ?? "standard") === "standard",
  );
  const inclusiveCount = standards.filter((c) => c.priceIncludesTax).length;
  if (inclusiveCount > 0 && inclusiveCount !== standards.length) {
    throw new TaxCalculationError(
      "a tax profile cannot mix inclusive and exclusive standard components",
    );
  }
  return sorted;
}

function calculateFromNet(
  netAmount: string,
  configs: TaxComponentConfig[],
): ComputedTaxComponent[] {
  const computed: ComputedTaxComponent[] = [];
  let priorTax = "0";
  for (const config of configs) {
    const taxableAmount = config.compoundOnPrevious
      ? add(netAmount, priorTax)
      : netAmount;
    const taxAmount = mulPercent(
      taxableAmount,
      config.ratePercent,
      config.roundingScale ?? 2,
    );
    const recoverableAmount = mulPercent(
      taxAmount,
      config.recoverablePercent ?? "100",
      4,
    );
    const nonrecoverableAmount = fromUnits(
      toUnits(taxAmount) - toUnits(recoverableAmount),
    );
    const calculationType = config.calculationType ?? "standard";
    computed.push({
      taxCodeId: config.taxCodeId,
      code: config.code,
      sequence: config.sequence,
      ratePercent: normalizeMoney(config.ratePercent),
      recoverablePercent: normalizeMoney(config.recoverablePercent ?? "100"),
      taxableAmount,
      taxAmount,
      recoverableAmount,
      nonrecoverableAmount,
      calculationType,
      priceIncludesTax: config.priceIncludesTax ?? false,
      compoundOnPrevious: config.compoundOnPrevious ?? false,
      roundingScale: config.roundingScale ?? 2,
      collectedAccountId: config.collectedAccountId ?? null,
      paidAccountId: config.paidAccountId ?? null,
      withholdingAccountId: config.withholdingAccountId ?? null,
      overridden: false,
    });
    // Compound basis follows statutory tax components, including a prior
    // reverse-charge component; withholding is a settlement deduction rather
    // than tax added to the taxable price and therefore never compounds.
    if (calculationType !== "withholding") priorTax = add(priorTax, taxAmount);
  }
  return computed;
}

function includedStandardTax(components: ComputedTaxComponent[]): string {
  return sum(
    components
      .filter((c) => c.calculationType === "standard" && c.priceIncludesTax)
      .map((c) => c.taxAmount),
  );
}

/**
 * Find the exact four-decimal net whose rounded component taxes reconcile to
 * the user-entered tax-inclusive amount. Integer binary search makes the
 * inversion deterministic even for compound taxes and per-component rounding.
 */
function extractInclusiveNet(
  inputAmount: string,
  configs: TaxComponentConfig[],
): string {
  const target = toUnits(inputAmount);
  if (target < 0n)
    throw new TaxCalculationError("tax input amount cannot be negative");
  let low = 0n;
  let high = target;
  while (low <= high) {
    const mid = (low + high) / 2n;
    const net = fromUnits(mid);
    const components = calculateFromNet(net, configs);
    const gross = mid + toUnits(includedStandardTax(components));
    if (gross === target) return net;
    if (gross < target) low = mid + 1n;
    else high = mid - 1n;
  }
  // A statutory rounding regime can make some sub-cent gross values
  // unreachable. Choose the closest candidate deterministically and expose a
  // reconciled last-component adjustment below, never a floating approximation.
  const candidates = [high, low].filter((u) => u >= 0n && u <= target);
  let best = candidates[0] ?? 0n;
  let bestDistance: bigint | null = null;
  for (const candidate of candidates) {
    const components = calculateFromNet(fromUnits(candidate), configs);
    const gross = candidate + toUnits(includedStandardTax(components));
    const distance = gross >= target ? gross - target : target - gross;
    if (
      bestDistance === null ||
      distance < bestDistance ||
      (distance === bestDistance && candidate < best)
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return fromUnits(best);
}

function applyAggregateOverride(
  components: ComputedTaxComponent[],
  overrideAmount: string,
): ComputedTaxComponent[] {
  const adjustable = [...components]
    .reverse()
    .find((c) => c.calculationType === "standard");
  if (!adjustable)
    throw new TaxCalculationError(
      "a manual tax override requires a standard tax component",
    );
  const current = sum(
    components
      .filter((c) => c.calculationType === "standard")
      .map((c) => c.taxAmount),
  );
  const delta = toUnits(normalizeMoney(overrideAmount)) - toUnits(current);
  return components.map((component) => {
    if (component !== adjustable) return component;
    const taxAmount = fromUnits(toUnits(component.taxAmount) + delta);
    if (toUnits(taxAmount) < 0n)
      throw new TaxCalculationError(
        "manual tax override cannot make a component negative",
      );
    // Preserve the configured recovery ratio exactly by deriving it from the
    // original component when possible. The explicit ratio survives the
    // zero-tax case, where the old equality heuristic guessed 100% recovery.
    const originalTax = toUnits(component.taxAmount);
    const configuredRecovery = component.recoverablePercent ??
      (component.recoverableAmount === component.taxAmount ? "100" : "0");
    const recovered =
      originalTax === 0n
        ? mulPercent(taxAmount, configuredRecovery, 4)
        : fromUnits(
            (toUnits(taxAmount) * toUnits(component.recoverableAmount) +
              originalTax / 2n) /
              originalTax,
          );
    return {
      ...component,
      taxAmount,
      recoverablePercent: configuredRecovery,
      recoverableAmount: recovered,
      nonrecoverableAmount: fromUnits(toUnits(taxAmount) - toUnits(recovered)),
      overridden: true,
    };
  });
}

export function computeLineTaxes(
  inputAmount: string,
  rawConfigs: TaxComponentConfig[],
  opts?: { overridden?: boolean; taxAmount?: string | null },
): ComputedLineTax {
  const canonicalInput = normalizeMoney(inputAmount);
  const inputUnits = toUnits(canonicalInput);
  // Discounts, refunds, and source adjustments legitimately carry signed
  // taxable bases. Calculate the magnitude through the exact positive path,
  // then apply its sign to every monetary result so rounding remains odd-
  // symmetric and there is only one statutory calculation implementation.
  if (inputUnits < 0n) {
    const overrideUnits =
      opts?.taxAmount == null || opts.taxAmount === ""
        ? null
        : toUnits(normalizeMoney(opts.taxAmount));
    if (overrideUnits !== null && overrideUnits > 0n) {
      throw new TaxCalculationError(
        "tax override must have the same sign as its taxable amount",
      );
    }
    const magnitude = computeLineTaxes(
      fromUnits(-inputUnits),
      rawConfigs,
      opts?.overridden
        ? {
            overridden: true,
            taxAmount:
              overrideUnits === null
                ? opts.taxAmount
                : fromUnits(-overrideUnits),
          }
        : opts,
    );
    return {
      ...magnitude,
      inputAmount: canonicalInput,
      netAmount: fromUnits(-toUnits(magnitude.netAmount)),
      taxTotal: fromUnits(-toUnits(magnitude.taxTotal)),
      total: fromUnits(-toUnits(magnitude.total)),
      components: magnitude.components.map((component) => ({
        ...component,
        taxableAmount: fromUnits(-toUnits(component.taxableAmount)),
        taxAmount: fromUnits(-toUnits(component.taxAmount)),
        recoverableAmount: fromUnits(-toUnits(component.recoverableAmount)),
        nonrecoverableAmount: fromUnits(
          -toUnits(component.nonrecoverableAmount),
        ),
      })),
    };
  }
  const configs = validateConfig(rawConfigs);
  if (configs.length === 0) {
    return {
      inputAmount: canonicalInput,
      netAmount: canonicalInput,
      taxTotal: "0.0000",
      total: canonicalInput,
      components: [],
      overridden: false,
    };
  }
  const inclusive = configs.some((c) => c.priceIncludesTax);
  const netAmount = inclusive
    ? extractInclusiveNet(canonicalInput, configs)
    : canonicalInput;
  let components = calculateFromNet(netAmount, configs);

  // Make an inclusive line cross-foot exactly after statutory component
  // rounding. Any unavoidable sub-cent inversion residue belongs on the final
  // included component and is explicitly marked as an override/evidence fact.
  if (inclusive) {
    const included = components.filter(
      (c) => c.calculationType === "standard" && c.priceIncludesTax,
    );
    const expectedIncludedTax = fromUnits(
      toUnits(canonicalInput) - toUnits(netAmount),
    );
    const computedIncludedTax = sum(included.map((c) => c.taxAmount));
    if (cmp(expectedIncludedTax, computedIncludedTax) !== 0) {
      components = applyAggregateOverride(components, expectedIncludedTax);
    }
  }
  if (opts?.overridden) {
    if (opts.taxAmount == null || opts.taxAmount === "") {
      throw new TaxCalculationError(
        "manual tax override is missing its amount",
      );
    }
    components = applyAggregateOverride(components, opts.taxAmount);
  }

  const standard = sum(
    components
      .filter((c) => c.calculationType === "standard")
      .map((c) => c.taxAmount),
  );
  const withholding = sum(
    components
      .filter((c) => c.calculationType === "withholding")
      .map((c) => c.taxAmount),
  );
  const taxTotal = fromUnits(toUnits(standard) - toUnits(withholding));
  return {
    inputAmount: canonicalInput,
    netAmount,
    taxTotal,
    total: add(netAmount, taxTotal),
    components,
    overridden: components.some((c) => c.overridden),
  };
}

/** Exact single-code resolver for callers that require one jurisdiction code. */
export interface TaxResolution {
  taxAmount: string;
  computed: string;
  overridden: boolean;
}

export function computeLineTax(
  amount: string | number,
  ratePercent: string | number,
): string {
  return mulPercent(normalizeMoney(amount), String(ratePercent), 2);
}

export function resolveLineTax(
  amount: string | number,
  ratePercent: string | number,
  opts?: { overridden?: boolean; taxAmount?: string | number | null },
): TaxResolution {
  const computed = computeLineTax(amount, ratePercent);
  if (opts?.overridden && opts.taxAmount != null && opts.taxAmount !== "") {
    return {
      taxAmount: normalizeMoney(opts.taxAmount),
      computed,
      overridden: true,
    };
  }
  return { taxAmount: computed, computed, overridden: false };
}

export function taxVaries(res: TaxResolution): boolean {
  const delta = toUnits(res.taxAmount) - toUnits(res.computed);
  return res.overridden && (delta < 0n ? -delta : delta) > 50n;
}
