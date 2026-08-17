import { PayrollError } from "./payroll-error.ts";
import {
  add, cmp, fromUnits, mulPercent, mulRatio, neg, normalizeMoney, sum, toUnits,
} from "./money.ts";
// Type-only: the classes are DECLARED by the country packs (packs.ts); this
// module only enforces what the declaration promises, and stays db-free.
import type { PayrollAssessedOn } from "./payroll/packs.ts";

/**
 * Payroll limits — deduction protection and component basis caps.
 *
 * Two statutory mechanisms that keep a deduction honest, kept PURE (no db) so
 * every case below is a hand-workable unit test rather than a fixture run:
 *
 * - Deduction protection: a deduction may not take more than a share of what
 *   the employee actually earns. Ontario's Wages Act caps ordinary garnishments
 *   at 20% of net wages and family support at 50%; the US CCPA caps at 25% of
 *   disposable earnings (50/55/60% for support). Both the percentage AND the
 *   base are configuration, because real orders measure against different
 *   pools — "50% of net, but the coverall allowance and the benefit deduction
 *   sit outside the 50%" is a pay-component flag here, never a code branch.
 * - Basis caps: the basis a percent-of-X / per-hour component computes on is
 *   limited before the amount is produced ("RRSP on at most 40 hours a week,
 *   job-charged overtime exempt"; the CRA money-purchase and US 402(g)
 *   elective-deferral limits), so nobody hand-computes it on a spreadsheet.
 *
 * Ordering in the run pipeline (.local/payroll-pipeline-contract.md): basis
 * caps run at component-computation time — they change the pre-tax deduction
 * the statutory pass consumes — and protection runs LAST, after the statutory
 * pass has fixed the withholdings the protected base is measured net of. When
 * a protected order is itself pre-tax (a factor-F2 support payment), that one
 * pass is not enough and the run iterates statutory ⇄ protection to a fixed
 * point; `protectionNeedsIteration` picks the path and `protectionConverged`
 * decides when it is done.
 *
 * Rounding doctrine: a protection cap is a CEILING, so it is floored to the
 * cent; a basis derived from a money cap is floored too. The employee keeps
 * the half-cent, never the creditor.
 */

const CENT = 100n;
const SCALE = 10_000n;

export type ProtectionBase = "none" | "net_pay" | "disposable_earnings" | "gross";

/** A limit refusal is a payroll refusal; callers catch on the base type. */
export class PayrollLimitError extends PayrollError {}

/** Truncate to whole cents. Caps are ceilings: rounding up would breach them. */
function floorCents(value: string): string {
  const units = toUnits(value);
  const truncated = (units / CENT) * CENT;
  // Truncation in BigInt rounds toward zero; a negative value must round down.
  return fromUnits(units < 0n && truncated !== units ? truncated - CENT : truncated);
}

/** `percent` of `amount`, exact, floored to the cent (never over the cap). */
function percentFloorCents(amount: string, percent: string): string {
  const exact = toUnits(amount) * toUnits(percent);
  if (exact < 0n) throw new PayrollLimitError("a protection cap cannot be negative");
  return fromUnits((exact / (100n * SCALE * CENT)) * CENT);
}

function requireNonNegative(value: string, label: string): string {
  if (cmp(value, "0") < 0) throw new PayrollLimitError(`${label} cannot be negative`);
  return normalizeMoney(value);
}

/** The floor-at-zero idiom, spelled once. Results are always canonical. */
function atLeastZero(value: string): string {
  return normalizeMoney(cmp(value, "0") > 0 ? value : "0");
}

function lesser(a: string, b: string): string {
  return normalizeMoney(cmp(a, b) <= 0 ? a : b);
}

/* ------------------------------------------------------------------ */
/* Disposable earnings — the protected base                            */
/* ------------------------------------------------------------------ */

/**
 * One resolved stub line as the protected base sees it. `amount` is always the
 * positive magnitude of the line, exactly as pay_stub_lines stores it; the
 * sign comes from `kind`.
 */
export interface DisposableEarningsLine {
  kind: "earning" | "deduction" | "employer_contribution";
  amount: string;
  /**
   * pay_components.include_in_disposable_earnings. Earnings included in the
   * base add to it, deductions included in it subtract from it. Excluding an
   * allowance keeps it out of the pool a garnishment is measured against;
   * excluding a benefit deduction means the benefit comes out of the
   * employee's own remainder instead of shrinking the creditor's ceiling.
   */
  includeInDisposableEarnings?: boolean;
  /** Employer-side accruals (vacation) never touch take-home pay. */
  accrualOnly?: boolean;
  /** This deduction is itself competing for the pool (see below). */
  protectedDeduction?: boolean;
}

export interface DisposableEarningsOptions {
  /**
   * Protected deductions are excluded from their own base by default: a
   * garnishment that shrank the pool it is measured against would converge on
   * paying itself less every pass.
   */
  excludeProtectedDeductions?: boolean;
}

/**
 * Disposable earnings = the included earnings less the included, unprotected
 * deductions. Never negative: an over-deducted period offers no pool at all,
 * it does not owe the creditor a negative amount.
 */
export function disposableEarnings(
  lines: readonly DisposableEarningsLine[],
  options: DisposableEarningsOptions = {},
): string {
  const excludeProtected = options.excludeProtectedDeductions ?? true;
  const signed: string[] = [];
  for (const line of lines) {
    if (line.accrualOnly) continue;
    if (line.includeInDisposableEarnings === false) continue;
    if (line.kind === "earning") signed.push(requireNonNegative(line.amount, "an earning"));
    else if (line.kind === "deduction") {
      if (excludeProtected && line.protectedDeduction) continue;
      signed.push(neg(requireNonNegative(line.amount, "a deduction")));
    }
  }
  return atLeastZero(sum(signed));
}

/**
 * Resolve a component's configured `protectionBase` into money.
 *
 * - `gross` — every earning, whatever its base flags say.
 * - `net_pay` — gross less every unprotected deduction (Ontario's "net wages":
 *   the pay the employee would have taken home had the order not existed).
 * - `disposable_earnings` — the flagged subset, per `disposableEarnings`.
 */
export function protectedBase(
  base: ProtectionBase,
  lines: readonly DisposableEarningsLine[],
  options: DisposableEarningsOptions = {},
): string {
  if (base === "none") return "0";
  if (base === "gross") {
    return atLeastZero(sum(
      lines.filter((line) => line.kind === "earning" && !line.accrualOnly).map((line) => line.amount),
    ));
  }
  const unflagged = base === "net_pay"
    ? lines.map((line) => ({ ...line, includeInDisposableEarnings: true }))
    : lines;
  return disposableEarnings(unflagged, options);
}

/* ------------------------------------------------------------------ */
/* Component basis caps                                                */
/* ------------------------------------------------------------------ */

export interface BasisCapComponent {
  basis: "fixed_amount" | "per_hour" | "percent_of_gross";
  /** Percent (percent_of_gross) or hourly rate (per_hour); the employee
   *  override when there is one, exactly as the run resolved it. */
  value?: string | null;
  /** pay_components basis-cap columns; null = no cap of that shape. */
  basisCapHoursPerPeriod?: string | null;
  basisCapAmountPerPeriod?: string | null;
  basisCapAmountPerYear?: string | null;
}

/**
 * An hours-bearing line behind the basis. `amount` is the money the line
 * contributes to a money basis and is omitted when the basis IS hours.
 */
export interface BasisCapLine {
  hours: string;
  amount?: string;
  /**
   * The hour is not subject to the hours cap — the customer rule is "RRSP on
   * 40 hours a week, but overtime/double time charged to a job is exempt".
   * Exemption is a property of the hour (its time type and its job tag), so it
   * arrives as a predicate the caller evaluates per line, never as a component
   * setting and never as a hardcoded time-type list. An exempt line always
   * contributes in full and never consumes the allowance.
   */
  exemptFromHoursCap?: boolean;
}

export interface BasisCapContext {
  /** The hours behind the basis. Required when an hours cap is configured;
   *  lines carrying no hours simply cannot be prorated and are never capped. */
  lines?: readonly BasisCapLine[];
  /** Amount this component already took earlier in the SAME period. */
  periodToDate?: string;
  /** Amount this component already took earlier in the tax year, opening
   *  balances included — mid-year adoption must not hand back a fresh limit. */
  yearToDate?: string;
}

/**
 * The component's unit rate expressed as an exact rational, so a money cap can
 * be converted back into basis room without ever touching a float.
 * amount = basis × numerator / denominator.
 */
function unitRate(component: BasisCapComponent): { numerator: bigint; denominator: bigint } {
  if (component.basis === "percent_of_gross") {
    return { numerator: toUnits(component.value ?? "0"), denominator: 100n * SCALE };
  }
  if (component.basis === "per_hour") {
    return { numerator: toUnits(component.value ?? "0"), denominator: SCALE };
  }
  // A fixed amount IS its own basis: rate 1.
  return { numerator: SCALE, denominator: SCALE };
}

/**
 * The largest basis whose amount still fits inside `room`. Floored, so the
 * amount computed from it never rounds past the cap: `room` is first truncated
 * to the cent, and rounding a value at or below a whole-cent ceiling to cents
 * can never exceed it.
 */
function basisWithin(room: string, rate: { numerator: bigint; denominator: bigint }): string {
  const roomUnits = toUnits(floorCents(room));
  return fromUnits((roomUnits * rate.denominator) / rate.numerator);
}

/**
 * Cap the basis a component computes on. Returns the capped basis in the same
 * shape it was given (money for percent-of-gross and fixed amounts, hours for
 * per-hour components).
 */
export function applyBasisCaps(
  component: BasisCapComponent,
  basis: string,
  context: BasisCapContext = {},
): string {
  let capped = requireNonNegative(basis, "a component basis");

  const hoursCap = component.basisCapHoursPerPeriod;
  if (hoursCap != null && cmp(hoursCap, "0") >= 0) {
    const lines = context.lines;
    if (!lines) {
      throw new PayrollLimitError(
        "an hours-capped component needs the hours behind its basis",
      );
    }
    const hoursBasis = component.basis === "per_hour";
    let allowance = requireNonNegative(hoursCap, "an hours cap");
    let dropped = "0";
    for (const line of lines) {
      if (line.exemptFromHoursCap) continue;
      const hours = requireNonNegative(line.hours, "line hours");
      if (cmp(hours, "0") === 0) continue;
      const taken = lesser(hours, allowance);
      allowance = add(allowance, neg(taken));
      const excess = add(hours, neg(taken));
      if (cmp(excess, "0") === 0) continue;
      // Money bases lose the excess hours' share of their own line, so a line
      // billed at a higher rate drops what that line actually cost.
      dropped = add(dropped, hoursBasis
        ? excess
        : mulRatio(requireNonNegative(line.amount ?? "0", "a line amount"),
                   toUnits(excess), toUnits(hours)));
    }
    capped = atLeastZero(add(capped, neg(dropped)));
  }

  const rate = unitRate(component);
  if (rate.numerator > 0n) {
    for (const [cap, taken] of [
      [component.basisCapAmountPerPeriod, context.periodToDate ?? "0"] as const,
      [component.basisCapAmountPerYear, context.yearToDate ?? "0"] as const,
    ]) {
      if (cap == null) continue;
      const room = atLeastZero(add(requireNonNegative(cap, "an amount cap"),
                                   neg(requireNonNegative(taken, "an amount already taken"))));
      capped = lesser(capped, basisWithin(room, rate));
    }
  }
  return capped;
}

/* ------------------------------------------------------------------ */
/* Deduction protection                                                */
/* ------------------------------------------------------------------ */

export interface ProtectedDeduction {
  /** The caller's handle (component id or code) for reconciling the result. */
  key: string;
  /** What the order wants to take this period, before protection. */
  requested: string;
  /** pay_components.protection_max_percent — share of the base (0–100). */
  maxPercent: string;
  /** pay_components.protection_priority — lowest first; ties keep input order
   *  so a recalculation of the same run is byte-identical. */
  priority?: number;
  /** The order's own base when it differs from the run-wide one (a support
   *  order measured on disposable earnings beside a creditor garnishment
   *  measured on net wages). */
  base?: string;
}

export interface DeductionProtectionOptions {
  /**
   * Cash actually left for the protected deductions — gross less every
   * UNPROTECTED deduction. This is the hard floor that keeps net pay from
   * going negative when the pool is wider than the remaining pay. Defaults to
   * the base, which is the conservative reading when the caller has nothing
   * better.
   */
  available?: string;
}

export interface AppliedDeduction {
  key: string;
  requested: string;
  /** What the run may actually deduct. */
  amount: string;
  /** The order's own ceiling — percentage of its base, floored to the cent. */
  cap: string;
}

export interface DeductionShortfall {
  key: string;
  requested: string;
  applied: string;
  /** requested − applied: a real unpaid balance the creditor still expects. */
  shortfall: string;
  /** Which limit bound: the protected pool, or the pay that was left. */
  reason: "protected_base" | "insufficient_pay";
}

/**
 * Apply protected deductions in priority order, each against what is LEFT of
 * the protected pool, and report what did not fit.
 *
 * A shortfall is a first-class result, not an exception: an unpaid garnishment
 * balance is a real obligation that carries to the next period, and swallowing
 * it silently is how a payroll system ends up in contempt of a court order.
 */
export function applyDeductionProtection(
  deductions: readonly ProtectedDeduction[],
  base: string,
  options: DeductionProtectionOptions = {},
): { applied: AppliedDeduction[]; shortfalls: DeductionShortfall[] } {
  requireNonNegative(base, "a protected base");
  const available = requireNonNegative(options.available ?? base, "available pay");

  const ordered = deductions
    .map((deduction, index) => ({ deduction, index }))
    .sort((a, b) =>
      (a.deduction.priority ?? 100) - (b.deduction.priority ?? 100) || a.index - b.index);

  const applied: AppliedDeduction[] = [];
  const shortfalls: DeductionShortfall[] = [];
  let taken = "0";

  for (const { deduction } of ordered) {
    const requested = requireNonNegative(deduction.requested, "a deduction");
    if (cmp(deduction.maxPercent, "0") < 0 || cmp(deduction.maxPercent, "100") > 0) {
      throw new PayrollLimitError(
        `protection percent for ${deduction.key} must be between 0 and 100`,
      );
    }
    const ownBase = requireNonNegative(deduction.base ?? base, "a protected base");
    const cap = percentFloorCents(ownBase, deduction.maxPercent);
    // One pool, several ceilings: every order competes for the same money, so
    // each one's room is its own ceiling less what the higher-priority orders
    // already took.
    const room = atLeastZero(add(cap, neg(taken)));
    const cash = atLeastZero(add(available, neg(taken)));
    const amount = lesser(lesser(requested, room), cash);
    applied.push({ key: deduction.key, requested, amount, cap });
    taken = add(taken, amount);
    if (cmp(amount, requested) < 0) {
      shortfalls.push({
        key: deduction.key,
        requested,
        applied: amount,
        shortfall: add(requested, neg(amount)),
        reason: cmp(room, cash) <= 0 ? "protected_base" : "insufficient_pay",
      });
    }
  }
  return { applied, shortfalls };
}

/* ------------------------------------------------------------------ */
/* Protection ⇄ statutory pass: which path, and when has it settled     */
/* ------------------------------------------------------------------ */

/**
 * Protection measures itself against pay the statutory pass has already fixed.
 * When every protected deduction is AFTER-tax the statutory pass is final
 * before protection runs, so one pass is exact and no iteration is needed —
 * the fast path, and the only one an ordinary garnishment ever takes.
 *
 * A pre-tax protected deduction is not a misconfiguration: a Canadian
 * court-ordered support payment is simultaneously T4127 factor F2 (deductible)
 * and the canonical 50%-of-net protection case. It just cannot be settled in
 * one pass, because capping it raises taxable income, which lowers net, which
 * lowers the cap. That case iterates instead (see `protectionConverged`).
 */
export function protectionNeedsIteration(
  components: readonly { taxTreatment?: string | null }[],
): boolean {
  return components.some(
    (component) => component.taxTreatment != null && component.taxTreatment !== "none",
  );
}

/**
 * The fast path's precondition, for callers that genuinely cannot iterate — a
 * preview that has no statutory pass to re-run. The pay-run pipeline chooses
 * its path with `protectionNeedsIteration` instead and never trips this.
 */
export function assertProtectionIsAfterTax(
  components: readonly { key: string; taxTreatment?: string | null }[],
): void {
  for (const component of components) {
    if (component.taxTreatment && component.taxTreatment !== "none") {
      throw new PayrollLimitError(
        `protected deduction ${component.key} is pre-tax (${component.taxTreatment}) — `
        + "protection is measured after the statutory pass, so a pre-tax order must "
        + "be settled by the iterate-to-fixpoint pass, not this one",
      );
    }
  }
}

/**
 * Drop the lines a country pack declared `taxable_income` — the ONLY lines a
 * protection pass may re-derive, because they are the only ones a pre-tax
 * deduction moves. Mutates in place, like the line set it serves.
 *
 * Earnings-assessed lines survive: they are computed from earnings, which
 * protection never changes, and re-emitting one would double a levy and
 * re-allocate a job split whose last job absorbs the rounding remainder.
 */
export function dropIncomeAssessedLines<T extends { assessedOn?: PayrollAssessedOn }>(
  lines: T[],
): void {
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index]!.assessedOn === "taxable_income") lines.splice(index, 1);
  }
}

/**
 * One statutory line the country pack declared `assessedOn: 'earnings'`, in
 * the shape the invariant check compares between passes.
 */
export interface EarningsAssessedLine {
  /** The component as the stub names it, so an error can point at it. */
  component: string;
  amount: string;
  /** The job-cost split (WCB), which must be allocated exactly once. */
  projectId?: string | null;
  departmentId?: string | null;
}

/**
 * The declared model's other half, enforced.
 *
 * A statutory line declared `earnings` is assessed on gross / pensionable /
 * insurable earnings or hours, and protection only ever changes DEDUCTIONS —
 * so the line the first pass produced must still be the line the last pass
 * leaves, to the cent and to the job. The pipeline computes it once and lets
 * every later pass skip it on the strength of that claim, so the claim is
 * checked rather than trusted: if a future levy really does depend on the
 * deductions taken, this fires loudly instead of letting a stale number reach
 * the stub, and the fix is to declare it `taxable_income` in its country pack.
 *
 * `first` and `final` are compared in order; the earnings-assessed lines keep
 * their relative order across passes because they are never re-pushed.
 */
export function assertEarningsAssessedStable(
  employee: string,
  first: readonly EarningsAssessedLine[],
  final: readonly EarningsAssessedLine[],
): void {
  const split = (line: EarningsAssessedLine) =>
    `${line.projectId ?? "no project"}/${line.departmentId ?? "no department"}`;
  const fail = (component: string, detail: string): never => {
    throw new PayrollLimitError(
      `earnings-assessed statutory line ${component} for ${employee} ${detail} across the `
      + "deduction-protection passes — an earnings-assessed levy is computed from earnings, "
      + "which protection never changes, so it is computed once. If it genuinely depends on "
      + "the deductions taken, declare it assessedOn: 'taxable_income' in its country pack "
      + "(engine/src/payroll/packs.ts) so every pass re-derives it",
    );
  };
  for (const [index, before] of first.entries()) {
    const after = final[index];
    if (!after) fail(before.component, "disappeared");
    if (after!.component !== before.component) {
      fail(before.component, `was replaced by ${after!.component}`);
    }
    if (cmp(after!.amount, before.amount) !== 0) {
      fail(before.component, `moved from ${normalizeMoney(before.amount)} to ${normalizeMoney(after!.amount)}`);
    }
    if (split(after!) !== split(before)) {
      fail(before.component, `moved from ${split(before)} to ${split(after!)}`);
    }
  }
  const appeared = final[first.length];
  if (appeared) fail(appeared.component, "appeared only after the first pass");
}

/** One pass's outcome, in the shape the loop compares between passes. */
export type ProtectionPass = readonly { key: string; amount: string }[];

/**
 * Hard bound on the fixpoint loop. Each pass contracts the error by roughly
 * (protection percent × marginal tax rate) — about 0.15 for a 50% support
 * order in a 30% bracket — so a real order settles in three or four passes and
 * eight is generous. The bound exists so a pathological rate table cannot spin
 * the run forever, never as an accepted stopping point: a run that reaches it
 * without settling fails loudly.
 */
export const PROTECTION_MAX_PASSES = 8;

/**
 * Has the loop reached a fixed point? `previous` is the set of amounts the
 * statutory pass was RUN with, `current` what protection produced from it, so
 * exact equality means the withholdings on the stub were computed from exactly
 * the deductions the stub takes. That is the self-consistency the run needs;
 * nothing weaker counts as converged.
 */
export function protectionConverged(previous: ProtectionPass, current: ProtectionPass): boolean {
  if (previous.length !== current.length) return false;
  const before = new Map(previous.map((entry) => [entry.key, entry.amount]));
  return current.every((entry) => {
    const amount = before.get(entry.key);
    return amount != null && cmp(amount, entry.amount) === 0;
  });
}

/**
 * Last resort when the loop has run out of passes without settling exactly.
 *
 * In exact arithmetic the sequence is monotone non-increasing and cannot cycle:
 * a smaller pre-tax deduction means more tax, less net, and a smaller cap. What
 * does cycle is the CENT — the statutory engine rounds at several stages, so
 * two neighbouring inputs can produce caps a penny apart forever.
 *
 * When the last two passes sit within a cent of each other the difference is
 * that rounding artifact, and we settle on the LOWER amount. That bias is
 * deliberate: under-taking a support order leaves a shortfall that is reported
 * and still owed, while over-taking it hands a creditor money the employee was
 * entitled to keep and that only a manual correction can give back. Returns
 * null when the gap is wider than a cent — that is a real failure to converge,
 * and the caller must raise it, not paper over it.
 */
export function settleProtectionOscillation(
  previous: ProtectionPass,
  current: ProtectionPass,
): { key: string; amount: string }[] | null {
  if (previous.length !== current.length) return null;
  const before = new Map(previous.map((entry) => [entry.key, entry.amount]));
  const settled: { key: string; amount: string }[] = [];
  for (const entry of current) {
    const amount = before.get(entry.key);
    if (amount == null) return null;
    const gap = cmp(amount, entry.amount) >= 0
      ? add(amount, neg(entry.amount))
      : add(entry.amount, neg(amount));
    if (cmp(gap, "0.01") > 0) return null;
    settled.push({ key: entry.key, amount: lesser(amount, entry.amount) });
  }
  return settled;
}

/** Total unpaid protected balance for a period — the figure the run surfaces. */
export function totalShortfall(shortfalls: readonly DeductionShortfall[]): string {
  return sum(shortfalls.map((entry) => entry.shortfall));
}

/** Convenience for the caller's own capping of a percent basis after caps. */
export function amountForBasis(component: BasisCapComponent, basis: string): string {
  if (component.basis === "percent_of_gross") return mulPercent(basis, component.value ?? "0", 2);
  const rate = unitRate(component);
  return fromUnits((toUnits(basis) * rate.numerator) / rate.denominator);
}
