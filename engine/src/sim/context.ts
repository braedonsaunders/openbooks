import type { Rng } from "./rng.ts";
import type { SimOrg } from "./world.ts";
import type { Profile } from "./profiles/index.ts";

/**
 * The mutable state threaded through every activity on a given simulated day.
 * `rng` is the master stream; activities take named sub-streams from it so their
 * draws are independent and stable. `coverage` accumulates capability keys so the
 * oracle can prove every expected feature fired.
 */
export interface SimContext {
  profile: Profile;
  world: SimOrg;
  rng: Rng;
  /** The current simulated day (YYYY-MM-DD). */
  simDate: string;
  counters: Record<string, number>;
  coverage: Set<string>;
  log: (msg: string) => void;
}

/** Record that a capability was exercised, and bump its counter. */
export function mark(ctx: SimContext, capability: string): void {
  ctx.coverage.add(capability);
  ctx.counters[capability] = (ctx.counters[capability] ?? 0) + 1;
}

/** A deterministic, monotonic document number per prefix within a run. */
export function nextNumber(ctx: SimContext, prefix: string): string {
  const key = `seq:${prefix}`;
  const n = (ctx.counters[key] ?? 0) + 1;
  ctx.counters[key] = n;
  return `${prefix}-${String(n).padStart(6, "0")}`;
}
