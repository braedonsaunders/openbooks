import { abs, add, cmp, isZero, neg, normalizeMoney, sum } from "./money.ts";

/**
 * Parallel run: reconcile a prior payroll provider's register against our own
 * run for the same period and population, penny by penny.
 *
 * This module is a SIBLING of engine/src/harness — a verification instrument,
 * not a feature. Its whole value is that it cannot be talked out of a finding,
 * so it is written to the same rules the harness is:
 *
 *  1. PURE. `comparePriorPayrollPeriod` takes both sides as data and touches no
 *     database, no clock, and no configuration. Every claim it makes is
 *     reproducible from its arguments, and every test below is a real test
 *     rather than a fixture round-trip.
 *  2. ZERO TOLERANCE BY DEFAULT. A slot compares exactly unless somebody
 *     deliberately configured an allowance, and any allowance in force is
 *     reported back on the result. A tolerance you cannot see is worse than no
 *     comparison at all.
 *  3. ABSENCE IS NEVER AGREEMENT. "No differences" and "nothing to compare" are
 *     different outcomes with different names. An empty register against a real
 *     run reports `no_comparable_data`; it can never report `clean`.
 *
 * That third rule is the reason this file exists in the shape it does. This
 * codebase has already shipped a tie-out that passed against a database it
 * could not see (see the trust-corpus canaries), and a parallel run is exactly
 * the tool an operator will believe. So the vacuous paths are enumerated and
 * named here, not left to whether the caller remembered to check a row count:
 *
 *   - either side with no employees              → no_comparable_data
 *   - populations that do not intersect          → no_comparable_data
 *   - an employee on one side only               → its own classification, always emitted
 *   - a slot on one side only                    → its own classification, never a zero-match
 *   - a stated total the slots do not explain    → `unattributed`, a finding in its own right
 *   - a source column nobody mapped              → carried onto the result and counted
 *
 * COUNTRY-AGNOSTIC. Nothing here knows a jurisdiction, a statutory kind, or a
 * provider. A comparable SLOT is one of the org's own pay components addressed
 * by its stable key; the prior provider's column names are mapped onto those
 * keys upstream by the generic import wizard. A country pack that adds a
 * component adds a comparable slot with no change here.
 */

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

/** The three sides of a pay stub. Mirrors pay_stub_lines.kind exactly. */
export type ParallelSlotKind = "earning" | "deduction" | "employer_contribution";

/** Findings also cover the stated totals, which belong to no single side. */
export type ParallelFindingKind = ParallelSlotKind | "total";

/**
 * Reserved slot keys for a stub's stated totals.
 *
 * These are compared as first-class cells because they are the OLD system's own
 * arithmetic. Comparing only components would let a register whose columns we
 * mapped incompletely reconcile perfectly against nothing.
 */
export const TOTAL_SLOT_GROSS = "gross";
export const TOTAL_SLOT_NET = "net_pay";
export const TOTAL_SLOT_EMPLOYER_COST = "employer_cost";

export const TOTAL_SLOTS = [
  TOTAL_SLOT_GROSS,
  TOTAL_SLOT_NET,
  TOTAL_SLOT_EMPLOYER_COST,
] as const;

/** One amount against one comparable slot. */
export interface ParallelAmount {
  kind: ParallelSlotKind;
  /**
   * Stable slot key. For our side this is `pay_components.system_key`, or
   * `code:<pay_components.code>` for a user component — the pair (kind, slot)
   * is the identity, because employee and employer contributions of the same
   * statutory kind share a system key.
   */
  slot: string;
  amount: string;
  /** Prior side only: the column in the operator's file this came from. */
  sourceColumn?: string | null;
}

/** One employee's whole result on one side of the comparison. */
export interface ParallelEmployeeSide {
  employeePartyId: string;
  employeeName: string;
  /** The side's OWN stated totals. Null means the side states none. */
  gross: string | null;
  netPay: string | null;
  employerCost: string | null;
  amounts: ParallelAmount[];
}

/** A source column no slot claimed, with how many rows carried a value in it. */
export interface UnmappedSourceColumn {
  column: string;
  valuedRows: number;
}

/** A deliberate, attributable allowance for one slot. */
export interface ParallelTolerance {
  kind: ParallelFindingKind;
  slot: string;
  /** Absolute per-employee allowance. Non-negative; "0" means exact. */
  tolerance: string;
  reason: string;
}

export interface ParallelSide {
  /** How the result names this side, e.g. the register name or the run number. */
  label: string;
  employees: ParallelEmployeeSide[];
}

export interface ComparePriorPayrollInput {
  prior: ParallelSide & { unmappedColumns?: UnmappedSourceColumn[] };
  ours: ParallelSide;
  /** Absent or empty = exact everywhere, which is the default. */
  tolerances?: ParallelTolerance[];
  /** Display labels for slots, keyed by `${kind}/${slot}`. Cosmetic only. */
  slotLabels?: Record<string, string>;
}

export type ParallelClassification =
  | "match"
  | "within_tolerance"
  | "difference"
  | "prior_only"
  | "our_only"
  | "employee_prior_only"
  | "employee_our_only"
  | "unattributed";

/** Classifications that mean the operator still has work to do. */
export const UNRESOLVED_CLASSIFICATIONS: readonly ParallelClassification[] = [
  "difference",
  "prior_only",
  "our_only",
  "employee_prior_only",
  "employee_our_only",
  "unattributed",
] as const;

export interface ParallelFinding {
  /** Null only on a population-level `unattributed` row. */
  employeePartyId: string | null;
  employeeName: string;
  kind: ParallelFindingKind;
  slot: string;
  slotLabel: string;
  classification: ParallelClassification;
  priorAmount: string | null;
  ourAmount: string | null;
  /** prior − ours. Null only when neither side has an amount. */
  difference: string | null;
  toleranceApplied: string;
  sourceColumn: string | null;
  sequence: number;
}

/** Population-wide reconciliation of one slot, for the totals report. */
export interface ParallelSlotTotal {
  kind: ParallelFindingKind;
  slot: string;
  slotLabel: string;
  prior: string;
  ours: string;
  difference: string;
  /** Employees whose cell for this slot is not a match. */
  unresolvedEmployees: number;
}

export type ParallelStatus =
  | "clean"
  | "clean_within_tolerance"
  | "differences"
  | "no_comparable_data";

export interface ParallelTotalsReconciliation {
  prior: string;
  ours: string;
  difference: string;
  /** The part of `difference` the per-slot findings do not account for. */
  unattributed: string;
}

export interface ParallelComparison {
  status: ParallelStatus;
  /** Set only for `no_comparable_data`. Plain English, no i18n key. */
  blockedReason: string | null;
  priorLabel: string;
  ourLabel: string;
  populations: {
    prior: number;
    ours: number;
    compared: number;
    priorOnly: number;
    ourOnly: number;
  };
  counts: Record<ParallelClassification, number>;
  totals: {
    gross: ParallelTotalsReconciliation;
    netPay: ParallelTotalsReconciliation;
    employerCost: ParallelTotalsReconciliation;
  };
  /** Per-slot reconciliation across the whole population. */
  slotTotals: ParallelSlotTotal[];
  findings: ParallelFinding[];
  /** Every tolerance that was in force, echoed so a reader cannot miss it. */
  tolerancesApplied: ParallelTolerance[];
  /** Source columns nobody mapped onto a slot. */
  unmappedColumns: UnmappedSourceColumn[];
}

export class ParallelRunError extends Error {}

/* ------------------------------------------------------------------ */
/* Exact arithmetic (money.ts only — never a float, never a Number)    */
/* ------------------------------------------------------------------ */

/** a − b. money.ts exports no `sub`; this is the idiom used throughout. */
export function difference(a: string, b: string): string {
  return add(a, neg(b));
}

/** |difference| ≤ tolerance. Zero tolerance means exact equality. */
export function withinTolerance(diff: string, tolerance: string): boolean {
  return cmp(abs(diff), tolerance) <= 0;
}

/* ------------------------------------------------------------------ */
/* Slot keys                                                           */
/* ------------------------------------------------------------------ */

/**
 * The default tolerance: exact, in the ledger's canonical four-decimal form.
 *
 * Written out rather than computed so the zero-tolerance default is visible in
 * the source at every site that reads it, and so a persisted finding carries a
 * diffable "0.0000" instead of a bare "0".
 */
export const EXACT = "0.0000";

/** Composite cell key. `/` is safe: neither a system key nor a code holds one. */
export function slotKey(kind: ParallelFindingKind, slot: string): string {
  return `${kind}/${slot}`;
}

/**
 * Slot key for a component, given how it is identified.
 *
 * Pack-declared components have a stable `systemKey` that survives renaming and
 * is the same in every tenant. User components do not, so they fall back to the
 * org-unique code under a prefix that cannot collide with a system key.
 */
export function componentSlot(
  systemKey: string | null | undefined,
  code: string | null | undefined,
): string {
  if (systemKey) return systemKey;
  if (code) return `code:${code}`;
  throw new ParallelRunError("a comparable component needs a system key or a code");
}

const KIND_SEQUENCE: Record<ParallelFindingKind, number> = {
  earning: 100,
  deduction: 200,
  employer_contribution: 300,
  total: 400,
};

/* ------------------------------------------------------------------ */
/* Normalization                                                       */
/* ------------------------------------------------------------------ */

interface NormalizedSide {
  employeePartyId: string;
  employeeName: string;
  totals: Record<string, string | null>;
  amounts: Map<string, { kind: ParallelSlotKind; slot: string; amount: string; sourceColumn: string | null }>;
}

/**
 * Fold one side into a cell map, summing repeats.
 *
 * Repeats are normal on our side, not a defect: a job-costed wage or an
 * employer burden split across projects is several `pay_stub_lines` rows for
 * one component. Summing them here is what makes the comparison compare like
 * with like. On the prior side a repeat means two source columns mapped onto
 * one slot, which also sums — and the stated-total reconciliation is what
 * catches it if that was a mistake.
 */
function normalizeSide(employee: ParallelEmployeeSide): NormalizedSide {
  const amounts = new Map<string, {
    kind: ParallelSlotKind; slot: string; amount: string; sourceColumn: string | null;
  }>();
  for (const entry of employee.amounts) {
    if (!entry.slot) throw new ParallelRunError("a comparable amount needs a slot");
    const key = slotKey(entry.kind, entry.slot);
    const existing = amounts.get(key);
    const amount = normalizeMoney(entry.amount);
    if (existing) {
      existing.amount = add(existing.amount, amount);
      // Keep the first column named; the finding points at where to look.
      existing.sourceColumn ??= entry.sourceColumn ?? null;
    } else {
      amounts.set(key, {
        kind: entry.kind,
        slot: entry.slot,
        amount,
        sourceColumn: entry.sourceColumn ?? null,
      });
    }
  }
  return {
    employeePartyId: employee.employeePartyId,
    employeeName: employee.employeeName,
    totals: {
      [TOTAL_SLOT_GROSS]: employee.gross === null ? null : normalizeMoney(employee.gross),
      [TOTAL_SLOT_NET]: employee.netPay === null ? null : normalizeMoney(employee.netPay),
      [TOTAL_SLOT_EMPLOYER_COST]:
        employee.employerCost === null ? null : normalizeMoney(employee.employerCost),
    },
    amounts,
  };
}

function indexSide(side: ParallelSide): Map<string, NormalizedSide> {
  const byEmployee = new Map<string, NormalizedSide>();
  for (const employee of side.employees) {
    if (!employee.employeePartyId) {
      throw new ParallelRunError("every comparable employee needs an identity");
    }
    if (byEmployee.has(employee.employeePartyId)) {
      // Two rows for one person is ambiguous, and picking one silently is how
      // half a person's pay disappears from a reconciliation.
      throw new ParallelRunError(
        `employee ${employee.employeeName || employee.employeePartyId} appears twice on the ${side.label} side`,
      );
    }
    byEmployee.set(employee.employeePartyId, normalizeSide(employee));
  }
  return byEmployee;
}

function toleranceIndex(tolerances: readonly ParallelTolerance[]): Map<string, ParallelTolerance> {
  const index = new Map<string, ParallelTolerance>();
  for (const tolerance of tolerances) {
    const normalized = normalizeMoney(tolerance.tolerance);
    if (cmp(normalized, "0") < 0) {
      throw new ParallelRunError(`tolerance for ${tolerance.kind}/${tolerance.slot} is negative`);
    }
    if (!tolerance.reason?.trim()) {
      throw new ParallelRunError(
        `tolerance for ${tolerance.kind}/${tolerance.slot} needs a reason — an unexplained allowance is not a control`,
      );
    }
    index.set(slotKey(tolerance.kind, tolerance.slot), { ...tolerance, tolerance: normalized });
  }
  return index;
}

/* ------------------------------------------------------------------ */
/* The comparison                                                      */
/* ------------------------------------------------------------------ */

/**
 * Reconcile a prior provider's register against our run.
 *
 * Deterministic and total: every employee on either side, and every slot on
 * either side of every compared employee, produces exactly one finding. There
 * is no path through this function that drops an amount.
 */
export function comparePriorPayrollPeriod(input: ComparePriorPayrollInput): ParallelComparison {
  const prior = indexSide(input.prior);
  const ours = indexSide(input.ours);
  const tolerances = toleranceIndex(input.tolerances ?? []);
  const labels = input.slotLabels ?? {};
  const label = (kind: ParallelFindingKind, slot: string) =>
    labels[slotKey(kind, slot)] ?? slot;

  const findings: ParallelFinding[] = [];
  const counts: Record<ParallelClassification, number> = {
    match: 0,
    within_tolerance: 0,
    difference: 0,
    prior_only: 0,
    our_only: 0,
    employee_prior_only: 0,
    employee_our_only: 0,
    unattributed: 0,
  };
  const record = (finding: ParallelFinding) => {
    counts[finding.classification]++;
    findings.push(finding);
  };

  // Population sets, computed before any comparison so a mismatch is a fact
  // about the input rather than a by-product of iteration order.
  const priorIds = [...prior.keys()];
  const ourIds = [...ours.keys()];
  const comparedIds = priorIds.filter((id) => ours.has(id));
  const priorOnlyIds = priorIds.filter((id) => !ours.has(id));
  const ourOnlyIds = ourIds.filter((id) => !prior.has(id));

  const nameOf = (id: string) =>
    prior.get(id)?.employeeName ?? ours.get(id)?.employeeName ?? id;
  const byName = (a: string, b: string) => nameOf(a).localeCompare(nameOf(b)) || a.localeCompare(b);

  // Per-slot accumulators for the population totals and the attribution.
  const slotTotals = new Map<string, ParallelSlotTotal>();
  const accumulate = (
    kind: ParallelFindingKind,
    slot: string,
    priorAmount: string,
    ourAmount: string,
    unresolved: boolean,
  ) => {
    const key = slotKey(kind, slot);
    const existing = slotTotals.get(key);
    if (existing) {
      existing.prior = add(existing.prior, priorAmount);
      existing.ours = add(existing.ours, ourAmount);
      existing.difference = difference(existing.prior, existing.ours);
      if (unresolved) existing.unresolvedEmployees++;
    } else {
      slotTotals.set(key, {
        kind,
        slot,
        slotLabel: label(kind, slot),
        prior: priorAmount,
        ours: ourAmount,
        difference: difference(priorAmount, ourAmount),
        unresolvedEmployees: unresolved ? 1 : 0,
      });
    }
  };

  /* --- compared employees: cell by cell -------------------------------- */

  for (const employeeId of [...comparedIds].sort(byName)) {
    const left = prior.get(employeeId)!;
    const right = ours.get(employeeId)!;
    const employeeName = left.employeeName || right.employeeName;

    // The union of both sides' slots. Iterating one side would turn a slot the
    // other side alone carries into silence, which is the failure mode this
    // whole module exists to prevent.
    const cellKeys = [...new Set([...left.amounts.keys(), ...right.amounts.keys()])];
    const cells = cellKeys
      .map((key) => ({ key, left: left.amounts.get(key), right: right.amounts.get(key) }))
      .map((cell) => {
        const kind = (cell.left ?? cell.right)!.kind;
        const slot = (cell.left ?? cell.right)!.slot;
        return { ...cell, kind, slot };
      })
      .sort(
        (a, b) =>
          KIND_SEQUENCE[a.kind] - KIND_SEQUENCE[b.kind] || a.slot.localeCompare(b.slot),
      );

    for (const cell of cells) {
      const tolerance = tolerances.get(cell.key)?.tolerance ?? EXACT;
      const priorAmount = cell.left?.amount ?? null;
      const ourAmount = cell.right?.amount ?? null;
      const sourceColumn = cell.left?.sourceColumn ?? null;

      if (priorAmount !== null && ourAmount !== null) {
        const diff = difference(priorAmount, ourAmount);
        const classification: ParallelClassification = isZero(diff)
          ? "match"
          : withinTolerance(diff, tolerance)
            ? "within_tolerance"
            : "difference";
        record({
          employeePartyId: employeeId,
          employeeName,
          kind: cell.kind,
          slot: cell.slot,
          slotLabel: label(cell.kind, cell.slot),
          classification,
          priorAmount,
          ourAmount,
          difference: diff,
          toleranceApplied: tolerance,
          sourceColumn,
          sequence: KIND_SEQUENCE[cell.kind],
        });
        accumulate(cell.kind, cell.slot, priorAmount, ourAmount, classification !== "match");
        continue;
      }

      // One side only. A missing amount is NOT zero: "the old system had no
      // such deduction" and "the old system deducted nothing" are different
      // statements, and only one of them is a difference we can explain.
      const classification: ParallelClassification =
        priorAmount !== null ? "prior_only" : "our_only";
      const present = (priorAmount ?? ourAmount)!;
      const diff = priorAmount !== null ? present : neg(present);
      record({
        employeePartyId: employeeId,
        employeeName,
        kind: cell.kind,
        slot: cell.slot,
        slotLabel: label(cell.kind, cell.slot),
        classification,
        priorAmount,
        ourAmount,
        difference: diff,
        toleranceApplied: tolerance,
        sourceColumn,
        sequence: KIND_SEQUENCE[cell.kind],
      });
      accumulate(
        cell.kind,
        cell.slot,
        priorAmount ?? "0",
        ourAmount ?? "0",
        true,
      );
    }

    // The stated totals, compared as cells of their own.
    for (const totalSlot of TOTAL_SLOTS) {
      const priorTotal = left.totals[totalSlot] ?? null;
      const ourTotal = right.totals[totalSlot] ?? null;
      if (priorTotal === null && ourTotal === null) continue;
      const tolerance = tolerances.get(slotKey("total", totalSlot))?.tolerance ?? EXACT;
      if (priorTotal !== null && ourTotal !== null) {
        const diff = difference(priorTotal, ourTotal);
        const classification: ParallelClassification = isZero(diff)
          ? "match"
          : withinTolerance(diff, tolerance)
            ? "within_tolerance"
            : "difference";
        record({
          employeePartyId: employeeId,
          employeeName,
          kind: "total",
          slot: totalSlot,
          slotLabel: label("total", totalSlot),
          classification,
          priorAmount: priorTotal,
          ourAmount: ourTotal,
          difference: diff,
          toleranceApplied: tolerance,
          sourceColumn: null,
          sequence: KIND_SEQUENCE.total,
        });
        accumulate("total", totalSlot, priorTotal, ourTotal, classification !== "match");
      } else {
        const classification: ParallelClassification =
          priorTotal !== null ? "prior_only" : "our_only";
        const present = (priorTotal ?? ourTotal)!;
        record({
          employeePartyId: employeeId,
          employeeName,
          kind: "total",
          slot: totalSlot,
          slotLabel: label("total", totalSlot),
          classification,
          priorAmount: priorTotal,
          ourAmount: ourTotal,
          difference: priorTotal !== null ? present : neg(present),
          toleranceApplied: tolerance,
          sourceColumn: null,
          sequence: KIND_SEQUENCE.total,
        });
        accumulate("total", totalSlot, priorTotal ?? "0", ourTotal ?? "0", true);
      }
    }
  }

  /* --- employees on one side only -------------------------------------- */

  // These are the loudest findings in the whole exercise. A parallel run whose
  // population silently differs is worthless, so each missing person gets a
  // finding per slot they carry PLUS one for each stated total, and every one
  // of their amounts still lands in the population totals below.
  const oneSided = (
    ids: string[],
    side: Map<string, NormalizedSide>,
    classification: "employee_prior_only" | "employee_our_only",
  ) => {
    for (const employeeId of [...ids].sort(byName)) {
      const only = side.get(employeeId)!;
      const isPrior = classification === "employee_prior_only";
      const cells = [...only.amounts.values()].sort(
        (a, b) => KIND_SEQUENCE[a.kind] - KIND_SEQUENCE[b.kind] || a.slot.localeCompare(b.slot),
      );
      for (const cell of cells) {
        record({
          employeePartyId: employeeId,
          employeeName: only.employeeName,
          kind: cell.kind,
          slot: cell.slot,
          slotLabel: label(cell.kind, cell.slot),
          classification,
          priorAmount: isPrior ? cell.amount : null,
          ourAmount: isPrior ? null : cell.amount,
          difference: isPrior ? cell.amount : neg(cell.amount),
          toleranceApplied: EXACT,
          sourceColumn: cell.sourceColumn,
          sequence: KIND_SEQUENCE[cell.kind],
        });
        accumulate(
          cell.kind,
          cell.slot,
          isPrior ? cell.amount : "0",
          isPrior ? "0" : cell.amount,
          true,
        );
      }
      for (const totalSlot of TOTAL_SLOTS) {
        const amount = only.totals[totalSlot] ?? null;
        if (amount === null) continue;
        record({
          employeePartyId: employeeId,
          employeeName: only.employeeName,
          kind: "total",
          slot: totalSlot,
          slotLabel: label("total", totalSlot),
          classification,
          priorAmount: isPrior ? amount : null,
          ourAmount: isPrior ? null : amount,
          difference: isPrior ? amount : neg(amount),
          toleranceApplied: EXACT,
          sourceColumn: null,
          sequence: KIND_SEQUENCE.total,
        });
        accumulate("total", totalSlot, isPrior ? amount : "0", isPrior ? "0" : amount, true);
      }
    }
  };
  oneSided(priorOnlyIds, prior, "employee_prior_only");
  oneSided(ourOnlyIds, ours, "employee_our_only");

  /* --- totals reconciliation and attribution --------------------------- */

  // Population totals run over EVERY employee on each side, not just the
  // compared ones. A one-sided employee's pay therefore shows up in the total
  // difference as well as in their own findings — a population mismatch cannot
  // reconcile to zero.
  const sideTotal = (side: Map<string, NormalizedSide>, slot: string) =>
    sum([...side.values()].map((employee) => employee.totals[slot] ?? "0"));

  const kindDifference = (kind: ParallelSlotKind) =>
    sum(
      [...slotTotals.values()]
        .filter((total) => total.kind === kind)
        .map((total) => total.difference),
    );

  const earningDifference = kindDifference("earning");
  const deductionDifference = kindDifference("deduction");
  const employerDifference = kindDifference("employer_contribution");

  const priorGross = sideTotal(prior, TOTAL_SLOT_GROSS);
  const ourGross = sideTotal(ours, TOTAL_SLOT_GROSS);
  const priorNet = sideTotal(prior, TOTAL_SLOT_NET);
  const ourNet = sideTotal(ours, TOTAL_SLOT_NET);
  const priorEmployerCost = sideTotal(prior, TOTAL_SLOT_EMPLOYER_COST);
  const ourEmployerCost = sideTotal(ours, TOTAL_SLOT_EMPLOYER_COST);

  // Attribution: a stated-total difference must be the sum of the component
  // differences that produced it. Whatever is left over is `unattributed` — the
  // signature of an amount that moved a total with no comparable slot behind
  // it, which is precisely what an unmapped source column looks like from here.
  const grossReconciliation: ParallelTotalsReconciliation = {
    prior: priorGross,
    ours: ourGross,
    difference: difference(priorGross, ourGross),
    unattributed: difference(difference(priorGross, ourGross), earningDifference),
  };
  const netReconciliation: ParallelTotalsReconciliation = {
    prior: priorNet,
    ours: ourNet,
    difference: difference(priorNet, ourNet),
    unattributed: difference(
      difference(priorNet, ourNet),
      difference(earningDifference, deductionDifference),
    ),
  };
  const employerCostReconciliation: ParallelTotalsReconciliation = {
    prior: priorEmployerCost,
    ours: ourEmployerCost,
    difference: difference(priorEmployerCost, ourEmployerCost),
    unattributed: difference(
      difference(priorEmployerCost, ourEmployerCost),
      employerDifference,
    ),
  };

  const unattributedRows: { slot: string; reconciliation: ParallelTotalsReconciliation }[] = [
    { slot: TOTAL_SLOT_GROSS, reconciliation: grossReconciliation },
    { slot: TOTAL_SLOT_NET, reconciliation: netReconciliation },
    { slot: TOTAL_SLOT_EMPLOYER_COST, reconciliation: employerCostReconciliation },
  ];
  for (const row of unattributedRows) {
    if (isZero(row.reconciliation.unattributed)) continue;
    record({
      employeePartyId: null,
      employeeName: "All employees",
      kind: "total",
      slot: `unattributed:${row.slot}`,
      slotLabel: `Unattributed ${label("total", row.slot)} difference`,
      classification: "unattributed",
      priorAmount: row.reconciliation.prior,
      ourAmount: row.reconciliation.ours,
      difference: row.reconciliation.unattributed,
      toleranceApplied: EXACT,
      sourceColumn: null,
      sequence: KIND_SEQUENCE.total + 50,
    });
  }

  /* --- status ---------------------------------------------------------- */

  const unmappedColumns = (input.prior.unmappedColumns ?? []).filter(
    (column) => column.column.trim().length > 0,
  );

  // The anti-vacuous gate. Every way this comparison can be empty is named,
  // and none of them is a pass. Note the findings above are still returned:
  // "nothing to compare" is far more useful when it also says who was where.
  let blockedReason: string | null = null;
  if (prior.size === 0 && ours.size === 0) {
    blockedReason =
      "neither side has any employees — there is nothing to compare, not zero differences";
  } else if (prior.size === 0) {
    blockedReason = `the prior register "${input.prior.label}" has no employees, so nothing in ${input.ours.label} was verified against it`;
  } else if (ours.size === 0) {
    blockedReason = `${input.ours.label} has no employees, so nothing in the prior register "${input.prior.label}" was verified against it`;
  } else if (comparedIds.length === 0) {
    blockedReason = `no employee appears on both sides — ${prior.size} on the prior register and ${ours.size} in ${input.ours.label}, with no overlap, so no amount was compared`;
  }

  const unresolved = UNRESOLVED_CLASSIFICATIONS.reduce(
    (total, classification) => total + counts[classification],
    0,
  );

  const status: ParallelStatus = blockedReason
    ? "no_comparable_data"
    : unresolved > 0 || unmappedColumns.length > 0
      ? "differences"
      : counts.within_tolerance > 0
        ? "clean_within_tolerance"
        : "clean";

  return {
    status,
    blockedReason,
    priorLabel: input.prior.label,
    ourLabel: input.ours.label,
    populations: {
      prior: prior.size,
      ours: ours.size,
      compared: comparedIds.length,
      priorOnly: priorOnlyIds.length,
      ourOnly: ourOnlyIds.length,
    },
    counts,
    totals: {
      gross: grossReconciliation,
      netPay: netReconciliation,
      employerCost: employerCostReconciliation,
    },
    slotTotals: [...slotTotals.values()].sort(
      (a, b) => KIND_SEQUENCE[a.kind] - KIND_SEQUENCE[b.kind] || a.slot.localeCompare(b.slot),
    ),
    findings,
    tolerancesApplied: [...tolerances.values()].sort(
      (a, b) => KIND_SEQUENCE[a.kind] - KIND_SEQUENCE[b.kind] || a.slot.localeCompare(b.slot),
    ),
    unmappedColumns,
  };
}

/** One violated invariant, in the shape the harness reports its failures. */
export interface ParallelAuditFailure {
  invariant: string;
  detail: string;
}

/**
 * The comparison's own self-check, in the shape of the harness's assertions.
 *
 * Callers persisting a comparison run this FIRST and refuse to store a result
 * that fails it. That ordering is the point: a corrupted or partial read must
 * not become filed evidence of a clean parallel run, and the only way to
 * guarantee that is for the storing path to be unable to proceed.
 *
 * Returns the violated invariants — empty means the result may be trusted as
 * far as this module can tell.
 */
export function auditComparison(comparison: ParallelComparison): ParallelAuditFailure[] {
  const failures: ParallelAuditFailure[] = [];
  const fail = (invariant: string, detail: string) => failures.push({ invariant, detail });

  const clean = comparison.status === "clean" || comparison.status === "clean_within_tolerance";

  // The anti-vacuous invariants. Each one is a way a green result could have
  // been produced by an absence rather than by agreement.
  if (clean && comparison.populations.compared === 0) {
    fail("clean-compared-somebody", "a clean result compared no employees at all");
  }
  if (clean && comparison.populations.prior === 0) {
    fail("clean-had-a-prior-side", "a clean result had no prior-register employees");
  }
  if (clean && comparison.populations.ours === 0) {
    fail("clean-had-our-side", "a clean result had no employees in our run");
  }
  if (clean && comparison.findings.length === 0) {
    fail("clean-compared-something", "a clean result produced no findings — nothing was compared");
  }
  if (clean && comparison.blockedReason !== null) {
    fail("clean-is-not-blocked", `a clean result also carries a blocked reason: ${comparison.blockedReason}`);
  }
  if (comparison.status === "no_comparable_data" && comparison.blockedReason === null) {
    fail("blocked-says-why", "no_comparable_data must state what was missing");
  }
  if (clean) {
    for (const classification of UNRESOLVED_CLASSIFICATIONS) {
      if (comparison.counts[classification] > 0) {
        fail(
          "clean-has-no-unresolved-findings",
          `a clean result carries ${comparison.counts[classification]} ${classification} finding(s)`,
        );
      }
    }
    if (comparison.unmappedColumns.length > 0) {
      fail(
        "clean-mapped-every-column",
        `a clean result left ${comparison.unmappedColumns.length} source column(s) unmapped: ${comparison.unmappedColumns.map((c) => c.column).join(", ")}`,
      );
    }
    for (const total of Object.values(comparison.totals)) {
      if (!isZero(total.unattributed)) {
        fail(
          "clean-attributes-every-total",
          `a clean result leaves ${total.unattributed} of a stated total unexplained by any component`,
        );
      }
    }
  }
  if (comparison.status === "clean" && comparison.counts.within_tolerance > 0) {
    fail("exact-clean-used-no-tolerance", "an exact-clean result relied on a tolerance");
  }
  if (comparison.status === "clean_within_tolerance" && comparison.tolerancesApplied.length === 0) {
    fail("tolerance-is-disclosed", "a within-tolerance result discloses no tolerance");
  }

  // Every finding must actually carry the arithmetic it claims.
  for (const finding of comparison.findings) {
    const at = `${finding.employeeName} ${finding.kind}/${finding.slot}`;
    if (finding.priorAmount === null && finding.ourAmount === null) {
      fail("finding-has-an-amount", `${at} has no amount on either side`);
      continue;
    }
    if (finding.classification === "unattributed") continue;
    const expected = difference(finding.priorAmount ?? "0", finding.ourAmount ?? "0");
    if (finding.difference === null || cmp(finding.difference, expected) !== 0) {
      fail(
        "finding-difference-is-prior-minus-ours",
        `${at} reports ${finding.difference} but prior − ours is ${expected}`,
      );
    }
    if (finding.classification === "match" && !isZero(expected)) {
      fail("match-means-equal", `${at} is classified as a match but differs by ${expected}`);
    }
    if (finding.classification === "within_tolerance" && isZero(finding.toleranceApplied)) {
      fail(
        "tolerance-band-is-real",
        `${at} claims a zero tolerance band — that is a match or a difference, never in between`,
      );
    }
  }

  return failures;
}
