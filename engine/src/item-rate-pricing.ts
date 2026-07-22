import { cmp, fromUnits, mul, sum, toUnits } from "./money.ts";

export type RateRole = "cost" | "bill";
export type PricingPolicy = "capped_ladder" | "lowest_cost";

export interface RateTier {
  id?: string | null;
  unitCode: string;
  unitName: string;
  baseQuantity: string;
  costRate: string | null;
  billRate: string | null;
}

export interface RateComponent {
  rateLineId: string | null;
  unitCode: string;
  unitName: string;
  quantity: string;
  rate: string;
  amount: string;
}

export interface RatePrice {
  amount: string;
  components: RateComponent[];
}

function rateFor(tier: RateTier, role: RateRole): string | null {
  return role === "cost" ? tier.costRate : tier.billRate;
}

function availableTiers(tiers: RateTier[], role: RateRole): RateTier[] {
  const usable = tiers.filter((t) => rateFor(t, role) != null).sort((a, b) => cmp(a.baseQuantity, b.baseQuantity));
  if (!usable.length) throw new Error(`No ${role} rates are configured`);
  if (toUnits(usable[0]!.baseQuantity) <= 0n) throw new Error("Rate tier quantities must be positive");
  for (let i = 1; i < usable.length; i++) {
    if (cmp(usable[i - 1]!.baseQuantity, usable[i]!.baseQuantity) === 0) {
      throw new Error("Rate tier quantities must be unique");
    }
  }
  return usable;
}

function component(tier: RateTier, role: RateRole, quantityUnits: bigint): RateComponent {
  const quantity = fromUnits(quantityUnits);
  const rate = rateFor(tier, role)!;
  return {
    rateLineId: tier.id ?? null,
    unitCode: tier.unitCode,
    unitName: tier.unitName,
    quantity,
    rate,
    amount: mul(quantity, rate),
  };
}

/**
 * Hierarchical capped ladder used by adminapp2. It decomposes from the largest
 * package down, then promotes a lower package only when its subtotal is
 * strictly greater than one next-tier price. The strict comparison preserves
 * legacy equality behavior; 1/4/12 tiers reproduce day/week/month exactly.
 */
export function priceCappedLadder(baseQuantity: string, tiers: RateTier[], role: RateRole): RatePrice {
  const target = toUnits(baseQuantity);
  if (target < 0n) throw new Error("Usage quantity cannot be negative");
  if (target === 0n) return { amount: "0.0000", components: [] };
  const usable = availableTiers(tiers, role);
  const counts = new Array<bigint>(usable.length).fill(0n);
  let remaining = target;

  for (let i = usable.length - 1; i >= 1; i--) {
    const size = toUnits(usable[i]!.baseQuantity);
    counts[i] = (remaining / size) * 10_000n;
    remaining %= size;
  }
  const smallest = toUnits(usable[0]!.baseQuantity);
  // The smallest tier can be fractional (hours, partial days, kilometres).
  counts[0] = (remaining * 10_000n) / smallest;

  for (let i = 0; i < usable.length - 1; i++) {
    if (counts[i] === 0n) continue;
    const lowerSubtotal = mul(fromUnits(counts[i]), rateFor(usable[i]!, role)!);
    const upperRate = rateFor(usable[i + 1]!, role)!;
    if (cmp(lowerSubtotal, upperRate) > 0) {
      counts[i] = 0n;
      counts[i + 1] += 10_000n;
    }
  }

  const components = usable
    .map((tier, i) => ({ tier, quantity: counts[i]! }))
    .filter((x) => x.quantity !== 0n)
    .reverse()
    .map((x) => component(x.tier, role, x.quantity));
  return { amount: sum(components.map((c) => c.amount)), components };
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** True minimum-cost package cover. Intended for configurable non-legacy
 * ladders; it may cover slightly more than the entered usage, like rental
 * package pricing. */
export function priceLowestCost(baseQuantity: string, tiers: RateTier[], role: RateRole): RatePrice {
  const targetUnits = toUnits(baseQuantity);
  if (targetUnits < 0n) throw new Error("Usage quantity cannot be negative");
  if (targetUnits === 0n) return { amount: "0.0000", components: [] };
  const usable = availableTiers(tiers, role);
  const sizes = usable.map((t) => toUnits(t.baseQuantity));
  const step = sizes.reduce(gcd);
  const target = Number((targetUnits + step - 1n) / step);
  const packageSizes = sizes.map((s) => Number(s / step));
  const maxPackage = Math.max(...packageSizes);
  if (target + maxPackage > 100_000) throw new Error("Rate ladder is too granular for lowest-cost pricing");

  const limit = target + maxPackage;
  const best: Array<bigint | null> = new Array(limit + 1).fill(null);
  const prior: Array<{ at: number; tier: number } | null> = new Array(limit + 1).fill(null);
  best[0] = 0n;
  for (let at = 0; at <= limit; at++) {
    if (best[at] == null) continue;
    for (let i = 0; i < usable.length; i++) {
      const next = at + packageSizes[i]!;
      if (next > limit) continue;
      const cost = best[at]! + toUnits(rateFor(usable[i]!, role)!);
      if (best[next] == null || cost < best[next]!) {
        best[next] = cost;
        prior[next] = { at, tier: i };
      }
    }
  }
  let winner = -1;
  for (let at = target; at <= limit; at++) {
    if (best[at] != null && (winner < 0 || best[at]! < best[winner]!)) winner = at;
  }
  if (winner < 0) throw new Error("Rate ladder cannot cover the usage quantity");
  const counts = new Array<bigint>(usable.length).fill(0n);
  for (let at = winner; at > 0; ) {
    const p = prior[at];
    if (!p) throw new Error("Invalid rate ladder solution");
    counts[p.tier] += 10_000n;
    at = p.at;
  }
  const components = usable
    .map((tier, i) => ({ tier, quantity: counts[i]! }))
    .filter((x) => x.quantity !== 0n)
    .reverse()
    .map((x) => component(x.tier, role, x.quantity));
  return { amount: sum(components.map((c) => c.amount)), components };
}

export function priceItemRate(
  baseQuantity: string,
  tiers: RateTier[],
  role: RateRole,
  policy: PricingPolicy,
): RatePrice {
  return policy === "lowest_cost"
    ? priceLowestCost(baseQuantity, tiers, role)
    : priceCappedLadder(baseQuantity, tiers, role);
}

/** Price an explicitly selected package unit. Unlike the automatic ladder,
 * this never promotes or decomposes the user's choice: 2 Weeks remains two
 * weekly packages even when a monthly package would be cheaper. */
export function priceSelectedRateUnit(
  quantity: string,
  tier: RateTier,
  role: RateRole,
): RatePrice {
  const quantityUnits = toUnits(quantity);
  if (quantityUnits <= 0n) throw new Error("Rate-unit quantity must be positive");
  if (toUnits(tier.baseQuantity) <= 0n) throw new Error("Rate tier quantities must be positive");
  if (rateFor(tier, role) == null) throw new Error(`No ${role} rate is configured for ${tier.unitName}`);
  const selected = component(tier, role, quantityUnits);
  return { amount: selected.amount, components: [selected] };
}
