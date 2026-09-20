
/**
 * `retro` pays, in the current period, the difference a backdated change makes
 * to periods that have ALREADY been paid (engine/src/payroll/retro.ts). Like
 * `bonus` and `termination` it is off-cycle: landing inside an already-paid
 * period is the entire point, so it is exempt from the regular-run overlap
 * guard below, which only ever inspected `run_type = 'regular'`.
 */
export type PayRunType = "regular" | "bonus" | "termination" | "retro";

/** Run types that pay ONLY their own one-off lines: no salary, no time, no
 *  recurring components, no derived earnings, no statutory holiday pay. */
export const ONE_OFF_RUN_TYPES = new Set<string>(["bonus", "retro"]);
