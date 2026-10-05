
/**
 * `retro` pays, in the current period, the difference a backdated change makes
 * to periods that have ALREADY been paid (engine/src/payroll/retro.ts). Like
 * `bonus` and `termination` it is off-cycle: landing inside an already-paid
 * period is the entire point, so it is exempt from the regular-run overlap
 * guard below, which only ever inspected `run_type = 'regular'`.
 *
 * `supplemental` is the periodic off-cycle run: a second (or third) pay run
 * inside an already-open period — a vacation payout ahead of the main weekly
 * run, or a late-hours correction after it. Unlike the one-off types it pays
 * the same periodic wages a regular run pays (salary, time, recurring
 * components), so the pack taxes it with the periodic method; unlike a
 * regular run it may overlap one. Statutory shares for the period are
 * computed on the period-to-date total across the period's runs, so a
 * per-period exemption applies once per period rather than once per run.
 */
export type PayRunType = "regular" | "bonus" | "termination" | "retro" | "supplemental";

/** Run types that pay ONLY their own one-off lines: no salary, no time, no
 *  recurring components, no derived earnings, no statutory holiday pay. */
export const ONE_OFF_RUN_TYPES = new Set<string>(["bonus", "retro"]);

/** Run types that pay periodic wages for the period and share its per-period
 *  statutory basis: the period-to-date treatment sequences across these, and
 *  only these, run types. */
export const PERIODIC_RUN_TYPES = new Set<string>(["regular", "supplemental"]);
