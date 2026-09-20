import { fromUnits, roundDiv, toUnits } from "../money/money.ts";
import type {
  AllocationResidualPolicy,
  AllocationRuleTarget,
  ApportionedTarget,
  ApportionResult,
  WeightedTarget,
} from "./types.ts";

/**
 * Exact apportionment over bigint money (engine/src/money/money.ts, 1e4 units).
 *
 * Floors every target's exact share and books the whole leftover on ONE
 * absorber chosen by the residual policy, so Σ(amounts) == total by
 * construction — a cent can never be lost or invented. `amount` INCLUDES the
 * residual slice; `residual` memos how much of that amount came from the
 * policy (zero for every other target). Shares are informational, rounded to
 * 10 dp.
 *
 * Absorber precedence: an explicit `explicit_target` key wins; otherwise a
 * sole `isRemainder` target absorbs (the fixed_percent remainder takes the
 * remainder); otherwise the residual policy (first / last / largest exact
 * share, ties to the earliest target) decides.
 */
export class AllocationApportionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AllocationApportionError";
    this.code = code;
  }
}

/** Weights are exact decimals up to 10 dp (shares resolve to 10 dp). */
const WEIGHT_SCALE = 10_000_000_000n;
const PERCENT_HUNDRED_UNITS = 100n * 10_000n;

function parseWeightUnits(value: string, what: string): bigint {
  const raw = String(value).trim();
  const m = /^([-+])?(\d+)?(?:\.(\d*))?$/.exec(raw);
  const whole = m?.[2];
  const frac = m?.[3];
  if (!m || (whole === undefined && (frac === undefined || frac === ""))) {
    throw new AllocationApportionError("weight_invalid", `${what} is not a decimal number: "${value}"`);
  }
  if ((frac?.length ?? 0) > 10) {
    throw new AllocationApportionError(
      "weight_precision",
      `${what} loses precision beyond 10 decimal places: "${value}"`,
    );
  }
  const magnitude = BigInt(whole ?? "0") * WEIGHT_SCALE + BigInt(((frac ?? "") + "0".repeat(10)).slice(0, 10));
  return m[1] === "-" ? -magnitude : magnitude;
}

/** Minimal canonical decimal (no trailing zeros): "60", "33.3334". */
function formatWeightUnits(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const int = (abs / WEIGHT_SCALE).toString();
  const frac = (abs % WEIGHT_SCALE).toString().padStart(10, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${frac === "" ? int : `${int}.${frac}`}`;
}

/** Exact share in [0,1] formatted to fixed 10 dp. */
function formatShare10(weightUnits: bigint, weightTotalUnits: bigint): string {
  const quanta = roundDiv(weightUnits * WEIGHT_SCALE, weightTotalUnits);
  const int = (quanta / WEIGHT_SCALE).toString();
  return `${int}.${(quanta % WEIGHT_SCALE).toString().padStart(10, "0")}`;
}

export function apportion(
  total: string,
  weights: WeightedTarget[],
  residualPolicy: AllocationResidualPolicy,
  residualKey?: string | null,
): ApportionResult {
  let totalUnits: bigint;
  try {
    totalUnits = toUnits(total);
  } catch {
    throw new AllocationApportionError("total_invalid", `total is not ledger money (numeric 19,4): "${total}"`);
  }
  const canonicalTotal = fromUnits(totalUnits);

  const seen = new Set<string>();
  for (const w of weights) {
    if (seen.has(w.key)) {
      throw new AllocationApportionError("duplicate_key", `duplicate apportion target key: "${w.key}"`);
    }
    seen.add(w.key);
  }
  const parsed = weights.map((w) => ({ ...w, units: parseWeightUnits(w.weight, `weight for target "${w.key}"`) }));
  for (const p of parsed) {
    if (p.units < 0n) {
      throw new AllocationApportionError("weight_negative", `weight for target "${p.key}" is negative: "${p.weight}"`);
    }
  }
  const remainderCount = parsed.filter((p) => p.isRemainder).length;
  if (remainderCount > 1) {
    throw new AllocationApportionError("remainder_count", "at most one apportion target may take the remainder");
  }
  const soleRemainder: (typeof parsed)[number] | undefined = parsed.find((p) => p.isRemainder);

  if (parsed.length === 0) {
    if (totalUnits !== 0n) {
      throw new AllocationApportionError("no_targets", `cannot apportion ${canonicalTotal} over zero targets`);
    }
    return { total: canonicalTotal, weightTotal: "0", targets: [], residualKey: null };
  }
  const first: (typeof parsed)[number] | undefined = parsed[0];
  const last: (typeof parsed)[number] | undefined = parsed[parsed.length - 1];
  if (first === undefined || last === undefined) {
    throw new AllocationApportionError("no_targets", "cannot apportion over zero targets");
  }

  let absorberKey: string;
  if (residualPolicy === "explicit_target") {
    if (residualKey !== undefined && residualKey !== null) {
      if (!seen.has(residualKey)) {
        throw new AllocationApportionError("residual_unknown", `explicit residual target does not exist: "${residualKey}"`);
      }
      absorberKey = residualKey;
    } else if (soleRemainder !== undefined) {
      absorberKey = soleRemainder.key;
    } else {
      throw new AllocationApportionError("residual_missing", "explicit_target residual policy needs a residual target key");
    }
  } else if (soleRemainder !== undefined) {
    absorberKey = soleRemainder.key;
  } else if (residualPolicy === "first_target") {
    absorberKey = first.key;
  } else if (residualPolicy === "last_target") {
    absorberKey = last.key;
  } else {
    let best = first;
    for (const p of parsed) {
      if (p.units > best.units) best = p;
    }
    absorberKey = best.key;
  }

  const weightTotalUnits = parsed.reduce((acc, p) => acc + p.units, 0n);
  // All-zero weights carry no information: split equally so the money
  // invariant still holds, and report zero shares honestly.
  const allZero = weightTotalUnits === 0n;
  const basis = allZero ? BigInt(parsed.length) : weightTotalUnits;
  const unitOf = (units: bigint): bigint => (allZero ? 1n : units);

  const negative = totalUnits < 0n;
  const magnitude = negative ? -totalUnits : totalUnits;
  const floors = parsed.map((p) => (magnitude * unitOf(p.units)) / basis);
  const flooredSum = floors.reduce((acc, f) => acc + f, 0n);
  const leftover = magnitude - flooredSum;

  const targets: ApportionedTarget[] = parsed.map((p, index) => {
    const floor: bigint = floors[index] ?? 0n;
    const isAbsorber = p.key === absorberKey;
    const units = floor + (isAbsorber ? leftover : 0n);
    const signed = negative ? -units : units;
    const residualUnits = isAbsorber ? (negative ? -leftover : leftover) : 0n;
    return {
      key: p.key,
      weight: p.weight,
      share: allZero ? "0.0000000000" : formatShare10(p.units, weightTotalUnits),
      amount: fromUnits(signed),
      residual: fromUnits(residualUnits),
    };
  });

  return { total: canonicalTotal, weightTotal: formatWeightUnits(weightTotalUnits), targets, residualKey: absorberKey };
}

/**
 * Convert explicit fixed_percent targets to apportion weights. The remainder
 * target (when present) takes weight 100 − Σ(percents) exactly, so a plain
 * proportional apportionment reproduces the grid and the caller routes the
 * rounding dust with residualPolicy 'explicit_target' naming that key.
 *
 * Refuses (rather than silently under-allocating): percents summing past 100,
 * more than one remainder, a non-positive or missing percent on a
 * non-remainder target, and a grid summing below 100 with no remainder.
 */
export function fixedPercentWeights(targets: AllocationRuleTarget[]): WeightedTarget[] {
  if (targets.filter((t) => t.isRemainder).length > 1) {
    throw new AllocationApportionError("remainder_count", "at most one target may take the remainder");
  }
  let sum = 0n;
  const out: WeightedTarget[] = targets.map((t) => {
    const key = t.id ?? `sequence:${t.sequence}`;
    if (t.isRemainder === true) return { key, weight: "0", isRemainder: true };
    if (t.fixedPercent === null || t.fixedPercent === undefined) {
      throw new AllocationApportionError(
        "fixed_percent_missing",
        `fixed_percent target "${key}" needs a percent on a fixed_percent basis`,
      );
    }
    let units: bigint;
    try {
      units = toUnits(t.fixedPercent);
    } catch {
      throw new AllocationApportionError(
        "fixed_percent_invalid",
        `fixed_percent target "${key}" is not a 4dp percent: "${t.fixedPercent}"`,
      );
    }
    if (units <= 0n || units > PERCENT_HUNDRED_UNITS) {
      throw new AllocationApportionError(
        "fixed_percent_range",
        `fixed_percent target "${key}" must be within (0, 100]: "${t.fixedPercent}"`,
      );
    }
    sum += units;
    return { key, weight: fromUnits(units), isRemainder: false };
  });
  if (sum > PERCENT_HUNDRED_UNITS) {
    throw new AllocationApportionError(
      "fixed_percent_sum",
      `fixed percents sum past 100 (${fromUnits(sum)}); refusing to invent money`,
    );
  }
  const remainder: WeightedTarget | undefined = out.find((w) => w.isRemainder);
  if (remainder === undefined && sum < PERCENT_HUNDRED_UNITS) {
    throw new AllocationApportionError(
      "fixed_percent_sum",
      `fixed percents sum to ${fromUnits(sum)} below 100 with no remainder target; refusing to drop money`,
    );
  }
  if (remainder !== undefined) remainder.weight = fromUnits(PERCENT_HUNDRED_UNITS - sum);
  return out;
}

/** One marginal slice of a stepped (graduated-tier) basis. */
export interface SteppedTier {
  /** Inclusive upper bound of the slice in ledger money; null = unbounded (must be last). */
  upTo: string | null;
  /** Stable target key; defaults to `tier:<1-based index>`. */
  targetKey?: string;
}

/**
 * Convert stepped tiers to apportion weights: each tier's weight is the
 * marginal slice of |total| falling inside it. The weights sum to |total|
 * exactly, so apportioning the signed total over them reproduces the slices
 * with the sign applied. Refuses tiers that cannot cover the total,
 * non-ascending bounds, or an open tier anywhere but last.
 */
export function steppedWeights(total: string, tiers: readonly SteppedTier[]): WeightedTarget[] {
  let totalUnits: bigint;
  try {
    totalUnits = toUnits(total);
  } catch {
    throw new AllocationApportionError("total_invalid", `total is not ledger money (numeric 19,4): "${total}"`);
  }
  if (tiers.length === 0) {
    throw new AllocationApportionError("stepped_tiers", "stepped basis needs at least one tier");
  }
  const seen = new Set<string>();
  let prev = 0n;
  let remaining = totalUnits < 0n ? -totalUnits : totalUnits;
  const out: WeightedTarget[] = tiers.map((tier, index) => {
    const key = tier.targetKey ?? `tier:${index + 1}`;
    if (seen.has(key)) {
      throw new AllocationApportionError("duplicate_key", `duplicate stepped tier key: "${key}"`);
    }
    seen.add(key);
    let cap: bigint | null = null;
    if (tier.upTo !== null) {
      try {
        cap = toUnits(tier.upTo);
      } catch {
        throw new AllocationApportionError(
          "stepped_tiers",
          `stepped tier "${key}" bound is not ledger money: "${tier.upTo}"`,
        );
      }
      if (cap < 0n) {
        throw new AllocationApportionError("stepped_tiers", `stepped tier "${key}" bound is negative: "${tier.upTo}"`);
      }
      if (cap <= prev) {
        throw new AllocationApportionError(
          "stepped_tiers",
          `stepped tier "${key}" bound must ascend past ${fromUnits(prev)}: "${tier.upTo}"`,
        );
      }
    } else if (index !== tiers.length - 1) {
      throw new AllocationApportionError("stepped_tiers", `open stepped tier "${key}" must be the last tier`);
    }
    const width = cap === null ? remaining : cap - prev;
    const take = width < remaining ? width : remaining;
    remaining -= take;
    if (cap !== null) prev = cap;
    return { key, weight: fromUnits(take) };
  });
  if (remaining > 0n) {
    throw new AllocationApportionError(
      "stepped_tiers",
      `stepped tiers cap at ${fromUnits(prev)} below the total ${fromUnits(totalUnits)}; refusing to drop money`,
    );
  }
  return out;
}
