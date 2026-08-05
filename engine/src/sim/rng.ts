/**
 * Deterministic, serializable, splittable PRNG for the simulation harness.
 *
 * Reproducibility rule: a run is identified by (profile, seed). Every stochastic
 * choice draws from a NAMED sub-stream derived from the master seed, so adding a
 * new activity type (a new stream name) does not shift the numbers any existing
 * stream produces. Streams are seeded by hashing `${masterSeed}:${name}` — never
 * by sharing one global cursor.
 *
 * Algorithm: SplitMix64 (a well-known, fast, statistically solid 64-bit mixer).
 * State is a single u64, so it serializes to a decimal string and restores
 * exactly — that is how a paused run resumes mid-stream.
 */

const MASK64 = (1n << 64n) - 1n;

function mix64(z: bigint): bigint {
  let x = z & MASK64;
  x = ((x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  x = ((x ^ (x >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (x ^ (x >> 31n)) & MASK64;
}

/** FNV-1a over a string → u64, used to derive a sub-stream seed from its name. */
function hashName(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & MASK64;
  }
  return h;
}

export class Rng {
  private state: bigint;

  private constructor(state: bigint) {
    this.state = state & MASK64;
  }

  /** Master RNG for a run. `seed` may be a number or any string. */
  static fromSeed(seed: number | string): Rng {
    const base = typeof seed === "number" ? BigInt(Math.trunc(seed)) : hashName(seed);
    return new Rng(mix64(base ^ 0x9e3779b97f4a7c15n));
  }

  /** Restore exact state from a serialized cursor (see `serialize`). */
  static deserialize(state: string): Rng {
    return new Rng(BigInt(state));
  }

  /** The exact state, for the resumable run manifest. */
  serialize(): string {
    return this.state.toString();
  }

  /**
   * A deterministic child stream. Same (parent seed, name) always yields the
   * same stream regardless of how many other streams were split, so activity
   * order/count never perturbs an unrelated stream.
   */
  stream(name: string): Rng {
    return new Rng(mix64(this.state ^ hashName(name)));
  }

  /** Next raw u64. */
  private nextU64(): bigint {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & MASK64;
    return mix64(this.state);
  }

  /** Uniform float in [0, 1). 53 bits of entropy. */
  next(): number {
    return Number(this.nextU64() >> 11n) / 2 ** 53;
  }

  /** Uniform integer in [minInclusive, maxInclusive]. */
  int(minInclusive: number, maxInclusive: number): number {
    if (maxInclusive < minInclusive) throw new Error("int: max < min");
    const span = BigInt(maxInclusive - minInclusive + 1);
    return minInclusive + Number(this.nextU64() % span);
  }

  /** Uniform float in [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** True with probability p (0..1). */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Uniformly pick one element. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick: empty array");
    return items[this.int(0, items.length - 1)]!;
  }

  /** Pick by weight. `weights[i]` is the relative weight of `items[i]`. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    if (items.length === 0 || items.length !== weights.length) {
      throw new Error("weighted: items/weights length mismatch or empty");
    }
    const total = weights.reduce((a, b) => a + Math.max(0, b), 0);
    if (total <= 0) return this.pick(items);
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= Math.max(0, weights[i]!);
      if (r < 0) return items[i]!;
    }
    return items[items.length - 1]!;
  }

  /**
   * A money amount as a ledger-canonical decimal string with 2 fractional
   * digits, drawn log-uniformly between `min` and `max` so small invoices are
   * common and large ones rare (realistic long tail).
   */
  money(min: number, max: number): string {
    const lo = Math.log(Math.max(1, min));
    const hi = Math.log(Math.max(min + 1, max));
    const v = Math.exp(this.float(lo, hi));
    return (Math.round(v * 100) / 100).toFixed(2);
  }

  /** Fisher–Yates shuffle returning a new array (does not mutate input). */
  shuffle<T>(items: readonly T[]): T[] {
    const a = items.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }
}
