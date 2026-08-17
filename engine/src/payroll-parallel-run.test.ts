import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { cmp } from "./money.ts";
import {
  auditComparison,
  componentSlot,
  comparePriorPayrollPeriod,
  difference,
  ParallelRunError,
  slotKey,
  UNRESOLVED_CLASSIFICATIONS,
  withinTolerance,
  type ComparePriorPayrollInput,
  type ParallelComparison,
  type ParallelEmployeeSide,
  type ParallelFinding,
} from "./payroll-parallel-run.ts";

/**
 * Parallel-run reconciliation controls.
 *
 * Each test names the failure it prevents. These are deliberately PURE — no
 * database, no scratch org, no clock — because the whole value of a
 * verification instrument is that its own correctness is checkable from its
 * arguments. A comparison engine proven only through fixtures it also wrote is
 * exactly the shape of the tie-outs this repository has already been burned by.
 *
 * The load-bearing test in this file is the last one: an empty import against a
 * real run must report "nothing to compare", never "no differences".
 */

/* ------------------------------------------------------------------ */
/* Fixtures — one biweekly period, one Ontario employee, hand-computed */
/* ------------------------------------------------------------------ */

const DEREK = "11111111-1111-4111-8111-111111111111";
const GRACE = "22222222-2222-4222-8222-222222222222";
const OMAR = "33333333-3333-4333-8333-333333333333";

/** Derek's real numbers from the verification tenant, to the penny. */
function derekOurs(): ParallelEmployeeSide {
  return {
    employeePartyId: DEREK,
    employeeName: "Derek Cole",
    gross: "2634.62",
    netPay: "2031.06",
    employerCost: "314.25",
    amounts: [
      { kind: "earning", slot: "base_pay", amount: "2634.62" },
      { kind: "deduction", slot: "cpp", amount: "148.75" },
      { kind: "deduction", slot: "ei", amount: "42.94" },
      { kind: "deduction", slot: "income_tax", amount: "411.87" },
      { kind: "employer_contribution", slot: "cpp", amount: "148.75" },
      { kind: "employer_contribution", slot: "ei", amount: "60.12" },
      { kind: "employer_contribution", slot: "vacation_accrual", amount: "105.38" },
    ],
  };
}

function graceOurs(): ParallelEmployeeSide {
  return {
    employeePartyId: GRACE,
    employeeName: "Grace Liu",
    gross: "3115.38",
    netPay: "2330.74",
    employerCost: "373.07",
    amounts: [
      { kind: "earning", slot: "base_pay", amount: "3115.38" },
      { kind: "deduction", slot: "cpp", amount: "177.36" },
      { kind: "deduction", slot: "ei", amount: "50.78" },
      { kind: "deduction", slot: "income_tax", amount: "556.50" },
      { kind: "employer_contribution", slot: "cpp", amount: "177.36" },
      { kind: "employer_contribution", slot: "ei", amount: "71.09" },
      { kind: "employer_contribution", slot: "vacation_accrual", amount: "124.62" },
    ],
  };
}

/**
 * The same employee as the prior provider's register states them, with each
 * amount tagged with the column it came out of. `sourceColumn` is what lets a
 * finding say which cell of the operator's file to look at.
 */
function asPriorRegister(side: ParallelEmployeeSide): ParallelEmployeeSide {
  const columns: Record<string, string> = {
    "earning/base_pay": "Regular Earnings",
    "deduction/cpp": "CPP Employee",
    "deduction/ei": "EI Employee",
    "deduction/income_tax": "Fed Tax",
    "employer_contribution/cpp": "CPP Employer",
    "employer_contribution/ei": "EI Employer",
    "employer_contribution/vacation_accrual": "Vac Accrual",
  };
  return {
    ...side,
    amounts: side.amounts.map((amount) => ({
      ...amount,
      sourceColumn: columns[slotKey(amount.kind, amount.slot)] ?? null,
    })),
  };
}

function baseInput(
  priorEmployees: ParallelEmployeeSide[],
  ourEmployees: ParallelEmployeeSide[],
  overrides: Partial<ComparePriorPayrollInput> = {},
): ComparePriorPayrollInput {
  return {
    prior: { label: "Prior provider — Jul 14 2026", employees: priorEmployees, unmappedColumns: [] },
    ours: { label: "PAY-00001", employees: ourEmployees },
    ...overrides,
  };
}

function findingFor(
  comparison: ParallelComparison,
  employeePartyId: string | null,
  kind: ParallelFinding["kind"],
  slot: string,
): ParallelFinding {
  const found = comparison.findings.find(
    (finding) =>
      finding.employeePartyId === employeePartyId &&
      finding.kind === kind &&
      finding.slot === slot,
  );
  assert.ok(found, `no finding for ${employeePartyId} ${kind}/${slot}`);
  return found;
}

/** Every result this suite calls trustworthy must survive the self-check. */
function assertSelfConsistent(comparison: ParallelComparison): void {
  assert.deepEqual(
    auditComparison(comparison),
    [],
    "the comparison failed its own audit",
  );
}

/* ------------------------------------------------------------------ */
/* Exact arithmetic                                                    */
/* ------------------------------------------------------------------ */

test("differences are exact decimal strings, never floating point", () => {
  // 5185.20 + 455.25 is 5640.450000000001 in binary floating point; a payroll
  // reconciliation that only holds to within an epsilon is not a reconciliation.
  assert.equal(difference("5640.45", "5185.20"), "455.2500");
  assert.equal(difference("2634.62", "2634.62"), "0.0000");
  assert.equal(difference("2634.62", "2634.63"), "-0.0100");
  // A tenth of a cent is a difference. numeric(19,4) is the ledger's precision.
  assert.equal(difference("100.0001", "100.0000"), "0.0001");
  assert.equal(withinTolerance("-0.0100", "0"), false);
  assert.equal(withinTolerance("-0.0100", "0.01"), true);
  assert.equal(withinTolerance("0.0101", "0.01"), false);
  assert.equal(withinTolerance("0", "0"), true);
});

test("a component's slot key is stable across renaming, and a user component falls back to its code", () => {
  assert.equal(componentSlot("cpp", "CPP"), "cpp");
  // A pack rename of the display code must not re-key the comparison.
  assert.equal(componentSlot("cpp", "QPP"), "cpp");
  assert.equal(componentSlot(null, "RRSP-EE"), "code:RRSP-EE");
  // A code slot can never collide with a system key — the prefix is reserved.
  assert.notEqual(componentSlot(null, "cpp"), componentSlot("cpp", null));
  assert.throws(() => componentSlot(null, null), ParallelRunError);
});

/* ------------------------------------------------------------------ */
/* An exact period reconciles to zero differences                      */
/* ------------------------------------------------------------------ */

test("an exact period reconciles to zero differences, and says how much it compared", () => {
  const comparison = comparePriorPayrollPeriod(
    baseInput(
      [asPriorRegister(derekOurs()), asPriorRegister(graceOurs())],
      [derekOurs(), graceOurs()],
    ),
  );

  assert.equal(comparison.status, "clean");
  assert.equal(comparison.blockedReason, null);
  assert.equal(comparison.counts.difference, 0);
  for (const classification of UNRESOLVED_CLASSIFICATIONS) {
    assert.equal(comparison.counts[classification], 0, `unexpected ${classification}`);
  }
  // A tolerance nobody configured must not appear, and "clean" must mean exact.
  assert.equal(comparison.counts.within_tolerance, 0);
  assert.deepEqual(comparison.tolerancesApplied, []);

  // Populations are stated, not implied. This is the difference between "we
  // agree about two people" and "we agree about nothing".
  assert.deepEqual(comparison.populations, {
    prior: 2, ours: 2, compared: 2, priorOnly: 0, ourOnly: 0,
  });
  // 7 components + 3 stated totals, twice over.
  assert.equal(comparison.counts.match, 20);
  assert.equal(comparison.findings.length, 20);

  // The totals reconcile AND the difference is fully attributed.
  assert.equal(comparison.totals.gross.prior, "5750.0000");
  assert.equal(comparison.totals.gross.ours, "5750.0000");
  assert.equal(comparison.totals.gross.difference, "0.0000");
  assert.equal(comparison.totals.gross.unattributed, "0.0000");
  assert.equal(comparison.totals.netPay.difference, "0.0000");
  assert.equal(comparison.totals.netPay.unattributed, "0.0000");
  assert.equal(comparison.totals.employerCost.difference, "0.0000");
  assert.equal(comparison.totals.employerCost.unattributed, "0.0000");

  assertSelfConsistent(comparison);
});

/* ------------------------------------------------------------------ */
/* A seeded one-cent difference on one component                       */
/* ------------------------------------------------------------------ */

test("a one-cent difference on one component surfaces, classified and attributed", () => {
  // The prior provider withheld one cent more income tax, so its net is one
  // cent lower. Nothing else moves.
  const prior = asPriorRegister(derekOurs());
  prior.amounts = prior.amounts.map((amount) =>
    amount.kind === "deduction" && amount.slot === "income_tax"
      ? { ...amount, amount: "411.88" }
      : amount,
  );
  prior.netPay = "2031.05";

  const comparison = comparePriorPayrollPeriod(
    baseInput([prior, asPriorRegister(graceOurs())], [derekOurs(), graceOurs()]),
  );

  assert.equal(comparison.status, "differences");
  assert.equal(comparison.counts.difference, 2); // the tax cell and Derek's net
  assert.equal(comparison.counts.within_tolerance, 0);
  assert.equal(comparison.populations.compared, 2);

  const tax = findingFor(comparison, DEREK, "deduction", "income_tax");
  assert.equal(tax.classification, "difference");
  assert.equal(tax.priorAmount, "411.8800");
  assert.equal(tax.ourAmount, "411.8700");
  assert.equal(tax.difference, "0.0100");
  assert.equal(tax.toleranceApplied, "0.0000");
  // The operator is told which column of their own file to look at.
  assert.equal(tax.sourceColumn, "Fed Tax");

  const net = findingFor(comparison, DEREK, "total", "net_pay");
  assert.equal(net.classification, "difference");
  assert.equal(net.difference, "-0.0100");

  // Everything else on Derek still matches — a difference does not smear.
  assert.equal(findingFor(comparison, DEREK, "earning", "base_pay").classification, "match");
  assert.equal(findingFor(comparison, DEREK, "total", "gross").classification, "match");
  assert.equal(findingFor(comparison, GRACE, "deduction", "income_tax").classification, "match");

  // ATTRIBUTION: the net difference is exactly the deduction difference, so
  // nothing is unattributed. That is what makes the finding actionable rather
  // than "somewhere in here there is a cent".
  assert.equal(comparison.totals.netPay.difference, "-0.0100");
  assert.equal(comparison.totals.netPay.unattributed, "0.0000");
  assert.equal(comparison.totals.gross.difference, "0.0000");
  assert.equal(comparison.totals.gross.unattributed, "0.0000");

  const taxTotal = comparison.slotTotals.find((t) => t.slot === "income_tax" && t.kind === "deduction");
  assert.ok(taxTotal);
  assert.equal(taxTotal.difference, "0.0100");
  assert.equal(taxTotal.unresolvedEmployees, 1);

  assertSelfConsistent(comparison);
});

test("a configured tolerance is applied, disclosed, and cannot be reached by default", () => {
  const prior = asPriorRegister(derekOurs());
  prior.amounts = prior.amounts.map((amount) =>
    amount.kind === "deduction" && amount.slot === "income_tax"
      ? { ...amount, amount: "411.88" }
      : amount,
  );
  prior.netPay = "2031.05";

  // Same input as the test above, with no tolerance: a difference.
  const strict = comparePriorPayrollPeriod(baseInput([prior], [derekOurs()]));
  assert.equal(strict.status, "differences");

  const tolerated = comparePriorPayrollPeriod(
    baseInput([prior], [derekOurs()], {
      tolerances: [
        { kind: "deduction", slot: "income_tax", tolerance: "0.01", reason: "prior provider rounds the tax table per period" },
        { kind: "total", slot: "net_pay", tolerance: "0.01", reason: "consequence of the tax rounding above" },
      ],
    }),
  );
  assert.equal(tolerated.status, "clean_within_tolerance");
  assert.equal(tolerated.counts.within_tolerance, 2);
  assert.equal(tolerated.counts.difference, 0);
  // The allowance is echoed on the result. A tolerance the reader cannot see
  // would defeat the entire exercise, so this is not optional output.
  assert.equal(tolerated.tolerancesApplied.length, 2);
  assert.equal(findingFor(tolerated, DEREK, "deduction", "income_tax").toleranceApplied, "0.0100");
  assert.equal(
    tolerated.tolerancesApplied[0]!.reason,
    "prior provider rounds the tax table per period",
  );
  assertSelfConsistent(tolerated);

  // One cent of allowance does not cover two.
  const twoCents = asPriorRegister(derekOurs());
  twoCents.amounts = twoCents.amounts.map((amount) =>
    amount.kind === "deduction" && amount.slot === "income_tax"
      ? { ...amount, amount: "411.89" }
      : amount,
  );
  twoCents.netPay = "2031.04";
  const exceeded = comparePriorPayrollPeriod(
    baseInput([twoCents], [derekOurs()], {
      tolerances: [
        { kind: "deduction", slot: "income_tax", tolerance: "0.01", reason: "rounding" },
        { kind: "total", slot: "net_pay", tolerance: "0.01", reason: "rounding" },
      ],
    }),
  );
  assert.equal(exceeded.status, "differences");
  assert.equal(exceeded.counts.difference, 2);

  // A tolerance with no reason is refused: agreeing to stop looking at a
  // difference is a decision that has to be attributable.
  assert.throws(
    () =>
      comparePriorPayrollPeriod(
        baseInput([prior], [derekOurs()], {
          tolerances: [{ kind: "deduction", slot: "income_tax", tolerance: "0.01", reason: "  " }],
        }),
      ),
    /needs a reason/,
  );
  assert.throws(
    () =>
      comparePriorPayrollPeriod(
        baseInput([prior], [derekOurs()], {
          tolerances: [{ kind: "deduction", slot: "cpp", tolerance: "-1", reason: "no" }],
        }),
      ),
    /negative/,
  );
});

/* ------------------------------------------------------------------ */
/* One-sided populations and one-sided components                      */
/* ------------------------------------------------------------------ */

test("an employee present in only one side is a prominent finding, never dropped", () => {
  const omarOurs: ParallelEmployeeSide = {
    employeePartyId: OMAR,
    employeeName: "Omar Khalil",
    gross: "3538.46",
    netPay: "2597.56",
    employerCost: "424.82",
    amounts: [
      { kind: "earning", slot: "base_pay", amount: "3538.46" },
      { kind: "deduction", slot: "income_tax", amount: "680.69" },
    ],
  };

  // Every amount on both sides is identical for the people who appear on both.
  // Only the population differs — the exact scenario a totals-only comparison
  // would call clean if it summed the compared employees alone.
  const comparison = comparePriorPayrollPeriod(
    baseInput([asPriorRegister(derekOurs())], [derekOurs(), omarOurs]),
  );

  assert.equal(comparison.status, "differences");
  assert.deepEqual(comparison.populations, {
    prior: 1, ours: 2, compared: 1, priorOnly: 0, ourOnly: 1,
  });
  assert.equal(comparison.counts.employee_our_only, 5); // 2 components + 3 totals
  assert.equal(comparison.counts.employee_prior_only, 0);

  const omarBase = findingFor(comparison, OMAR, "earning", "base_pay");
  assert.equal(omarBase.classification, "employee_our_only");
  assert.equal(omarBase.priorAmount, null);
  assert.equal(omarBase.ourAmount, "3538.4600");
  assert.equal(omarBase.difference, "-3538.4600");

  // Derek still reconciles exactly. A population mismatch must not be laundered
  // into a per-cell difference for the people who do agree.
  assert.equal(findingFor(comparison, DEREK, "earning", "base_pay").classification, "match");

  // And the population totals carry Omar's pay, so the totals cannot net to
  // zero while a whole person is missing from one side.
  assert.equal(comparison.totals.gross.prior, "2634.6200");
  assert.equal(comparison.totals.gross.ours, "6173.0800");
  assert.equal(comparison.totals.gross.difference, "-3538.4600");
  assert.equal(comparison.totals.gross.unattributed, "0.0000");

  assertSelfConsistent(comparison);

  // The mirror case: somebody the old system paid whom we did not.
  const mirrored = comparePriorPayrollPeriod(
    baseInput(
      [asPriorRegister(derekOurs()), asPriorRegister(graceOurs())],
      [derekOurs()],
    ),
  );
  assert.equal(mirrored.status, "differences");
  assert.equal(mirrored.populations.priorOnly, 1);
  assert.equal(mirrored.counts.employee_prior_only, 10); // 7 components + 3 totals
  assert.equal(findingFor(mirrored, GRACE, "earning", "base_pay").classification, "employee_prior_only");
  assertSelfConsistent(mirrored);
});

test("a component on one side only is its own classification, never a zero match", () => {
  const withRrsp = derekOurs();
  withRrsp.amounts.push({ kind: "deduction", slot: "code:RRSP-EE", amount: "50.00" });
  withRrsp.netPay = "1981.06";

  const comparison = comparePriorPayrollPeriod(
    baseInput([asPriorRegister(derekOurs())], [withRrsp]),
  );

  const rrsp = findingFor(comparison, DEREK, "deduction", "code:RRSP-EE");
  // Absence is not zero. "The old system had no such deduction" and "the old
  // system deducted nothing" are different statements.
  assert.equal(rrsp.classification, "our_only");
  assert.equal(rrsp.priorAmount, null);
  assert.equal(rrsp.ourAmount, "50.0000");
  assert.equal(rrsp.difference, "-50.0000");
  assert.equal(comparison.status, "differences");
  assertSelfConsistent(comparison);
});

/* ------------------------------------------------------------------ */
/* Unmapped source columns                                             */
/* ------------------------------------------------------------------ */

test("an unmapped prior-system column is reported, and its money shows up as unattributed", () => {
  // The operator's file had an "RRSP Employee" column nobody mapped onto a
  // slot. The prior provider's own stated net therefore already has that $50
  // taken out, while the amounts we can see account for none of it.
  const prior = asPriorRegister(derekOurs());
  prior.netPay = "1981.06";
  const ourSide = derekOurs();
  ourSide.amounts.push({ kind: "deduction", slot: "code:RRSP-EE", amount: "50.00" });
  ourSide.netPay = "1981.06";

  const comparison = comparePriorPayrollPeriod({
    prior: {
      label: "Prior provider — Jul 14 2026",
      employees: [prior],
      unmappedColumns: [{ column: "RRSP Employee", valuedRows: 1 }],
    },
    ours: { label: "PAY-00001", employees: [ourSide] },
  });

  // 1. The column itself is named on the result, so an operator reading the
  //    reconciliation — not the import screen — learns about it.
  assert.deepEqual(comparison.unmappedColumns, [{ column: "RRSP Employee", valuedRows: 1 }]);
  // 2. An unmapped column alone is enough to deny a clean result.
  assert.equal(comparison.status, "differences");
  // 3. STRUCTURAL: even if nobody had recorded the column, the money cannot
  //    hide. Both sides' stated net agree, but the deduction that produced it
  //    exists on only one side, so $50 of the net is unexplained.
  assert.equal(comparison.totals.netPay.difference, "0.0000");
  assert.equal(comparison.totals.netPay.unattributed, "-50.0000");
  const unattributed = findingFor(comparison, null, "total", "unattributed:net_pay");
  assert.equal(unattributed.classification, "unattributed");
  assert.equal(unattributed.difference, "-50.0000");
  assert.equal(comparison.counts.unattributed, 1);

  // The same reconciliation with the column mapped is clean, which is what
  // makes the finding above a real signal rather than permanent noise.
  const mapped = comparePriorPayrollPeriod({
    prior: {
      label: "Prior provider — Jul 14 2026",
      employees: [
        {
          ...prior,
          amounts: [
            ...prior.amounts,
            { kind: "deduction", slot: "code:RRSP-EE", amount: "50.00", sourceColumn: "RRSP Employee" },
          ],
        },
      ],
      unmappedColumns: [],
    },
    ours: { label: "PAY-00001", employees: [ourSide] },
  });
  assert.equal(mapped.status, "clean");
  assert.equal(mapped.totals.netPay.unattributed, "0.0000");
  assertSelfConsistent(mapped);
});

test("a stated total the components cannot explain is reported even with every column mapped", () => {
  // A register whose stated gross is $100 above the sum of its earnings. No
  // column is missing from the mapping — the old system's own arithmetic is
  // what disagrees, and this is the only way anybody finds out.
  const prior = asPriorRegister(derekOurs());
  prior.gross = "2734.62";
  const comparison = comparePriorPayrollPeriod(baseInput([prior], [derekOurs()]));

  assert.equal(comparison.status, "differences");
  assert.equal(comparison.totals.gross.difference, "100.0000");
  assert.equal(comparison.totals.gross.unattributed, "100.0000");
  assert.equal(findingFor(comparison, null, "total", "unattributed:gross").difference, "100.0000");
  assertSelfConsistent(comparison);
});

/* ------------------------------------------------------------------ */
/* Aggregation and input hygiene                                       */
/* ------------------------------------------------------------------ */

test("a job-costed component split across projects is compared as one amount", () => {
  // Our side legitimately carries several pay_stub_lines for one component when
  // wages or an employer burden are charged to different projects. Comparing
  // line by line would report three phantom differences.
  const split = derekOurs();
  split.amounts = [
    { kind: "earning", slot: "base_pay", amount: "1000.00" },
    { kind: "earning", slot: "base_pay", amount: "1634.62" },
    { kind: "deduction", slot: "cpp", amount: "148.75" },
    { kind: "deduction", slot: "ei", amount: "42.94" },
    { kind: "deduction", slot: "income_tax", amount: "411.87" },
    { kind: "employer_contribution", slot: "cpp", amount: "148.75" },
    { kind: "employer_contribution", slot: "ei", amount: "60.12" },
    { kind: "employer_contribution", slot: "vacation_accrual", amount: "105.38" },
  ];
  const comparison = comparePriorPayrollPeriod(
    baseInput([asPriorRegister(derekOurs())], [split]),
  );
  assert.equal(comparison.status, "clean");
  assert.equal(findingFor(comparison, DEREK, "earning", "base_pay").ourAmount, "2634.6200");
  assertSelfConsistent(comparison);
});

test("the same employee twice on one side is refused, not silently halved", () => {
  assert.throws(
    () =>
      comparePriorPayrollPeriod(
        baseInput([asPriorRegister(derekOurs()), asPriorRegister(derekOurs())], [derekOurs()]),
      ),
    /appears twice/,
  );
});

/* ------------------------------------------------------------------ */
/* THE ANTI-VACUOUS GUARANTEE                                          */
/* ------------------------------------------------------------------ */

test("an empty import against a real run reports no comparable data, never zero differences", () => {
  const comparison = comparePriorPayrollPeriod(
    baseInput([], [derekOurs(), graceOurs()]),
  );

  // This is the whole point of the module. A failed or empty import must not be
  // readable as agreement.
  assert.equal(comparison.status, "no_comparable_data");
  assert.notEqual(comparison.status, "clean");
  assert.ok(comparison.blockedReason);
  assert.match(comparison.blockedReason!, /has no employees/);
  assert.equal(comparison.populations.prior, 0);
  assert.equal(comparison.populations.compared, 0);
  assert.equal(comparison.counts.match, 0);

  // The result is still useful: it names who was on our side with nobody to
  // check them against.
  assert.equal(comparison.counts.employee_our_only, 20);
  assertSelfConsistent(comparison);
});

test("every way the comparison can be empty is named, and none of them is a pass", () => {
  const cases: { name: string; input: ComparePriorPayrollInput; expect: RegExp }[] = [
    {
      name: "empty prior register",
      input: baseInput([], [derekOurs()]),
      expect: /prior register .* has no employees/,
    },
    {
      name: "empty run",
      input: baseInput([asPriorRegister(derekOurs())], []),
      expect: /PAY-00001 has no employees/,
    },
    {
      name: "both sides empty",
      input: baseInput([], []),
      expect: /neither side has any employees/,
    },
    {
      name: "populations do not intersect",
      input: baseInput([asPriorRegister(graceOurs())], [derekOurs()]),
      expect: /no employee appears on both sides/,
    },
  ];

  for (const testCase of cases) {
    const comparison = comparePriorPayrollPeriod(testCase.input);
    assert.equal(comparison.status, "no_comparable_data", testCase.name);
    assert.match(comparison.blockedReason ?? "", testCase.expect, testCase.name);
    assert.equal(comparison.populations.compared, 0, testCase.name);
    assertSelfConsistent(comparison);
  }

  // Two employees, neither of whom is the other: the populations are non-empty
  // on both sides and the comparison STILL cannot claim anything. A row-count
  // check on either side alone would have passed this.
  const disjoint = comparePriorPayrollPeriod(
    baseInput([asPriorRegister(graceOurs())], [derekOurs()]),
  );
  assert.equal(disjoint.populations.prior, 1);
  assert.equal(disjoint.populations.ours, 1);
  assert.equal(disjoint.status, "no_comparable_data");
});

test("the self-check refuses a fabricated clean result", () => {
  // The audit exists so a corrupted or hand-edited comparison cannot be filed
  // as evidence. Prove it actually catches each fabrication.
  const good = comparePriorPayrollPeriod(
    baseInput([asPriorRegister(derekOurs())], [derekOurs()]),
  );
  assert.deepEqual(auditComparison(good), []);

  const noPopulation: ParallelComparison = {
    ...good,
    populations: { ...good.populations, compared: 0 },
  };
  assert.ok(
    auditComparison(noPopulation).some((f) => f.invariant === "clean-compared-somebody"),
  );

  const noFindings: ParallelComparison = { ...good, findings: [], counts: { ...good.counts, match: 0 } };
  assert.ok(
    auditComparison(noFindings).some((f) => f.invariant === "clean-compared-something"),
  );

  const hiddenColumn: ParallelComparison = {
    ...good,
    unmappedColumns: [{ column: "Union Dues", valuedRows: 4 }],
  };
  assert.ok(
    auditComparison(hiddenColumn).some((f) => f.invariant === "clean-mapped-every-column"),
  );

  const lyingMatch: ParallelComparison = {
    ...good,
    findings: good.findings.map((finding) =>
      finding.slot === "base_pay" ? { ...finding, ourAmount: "1.0000", difference: "0.0000" } : finding,
    ),
  };
  const lyingFailures = auditComparison(lyingMatch);
  assert.ok(lyingFailures.some((f) => f.invariant === "finding-difference-is-prior-minus-ours"));
  assert.ok(lyingFailures.some((f) => f.invariant === "match-means-equal"));

  const undisclosedTolerance: ParallelComparison = {
    ...good,
    status: "clean_within_tolerance",
    tolerancesApplied: [],
  };
  assert.ok(
    auditComparison(undisclosedTolerance).some((f) => f.invariant === "tolerance-is-disclosed"),
  );

  const laundered: ParallelComparison = {
    ...good,
    status: "clean",
    totals: { ...good.totals, gross: { ...good.totals.gross, unattributed: "-50.0000" } },
  };
  assert.ok(
    auditComparison(laundered).some((f) => f.invariant === "clean-attributes-every-total"),
  );

  const blockedButClean: ParallelComparison = { ...good, blockedReason: "nothing to compare" };
  assert.ok(auditComparison(blockedButClean).some((f) => f.invariant === "clean-is-not-blocked"));
});

/* ------------------------------------------------------------------ */
/* Structural guard on the status expression itself                    */
/* ------------------------------------------------------------------ */

test("the status expression still contains every anti-vacuous guard", () => {
  // The source-text half of the control, following
  // engine/src/harness/replay/replay-safety.test.ts. Behavioural tests prove
  // today's guards work; this one fails if a future edit removes a branch
  // instead of changing its outcome, which is how a verification tool quietly
  // becomes an affirmation.
  const source = readFileSync("engine/src/payroll-parallel-run.ts", "utf8");

  const gate =
    source.match(/let blockedReason: string \| null = null;[\s\S]*?const unresolved =/)?.[0] ?? "";
  assert.ok(gate, "the blocked-reason gate is no longer recognizable");
  assert.match(gate, /prior\.size === 0 && ours\.size === 0/);
  assert.match(gate, /prior\.size === 0/);
  assert.match(gate, /ours\.size === 0/);
  assert.match(gate, /comparedIds\.length === 0/);

  const status = source.match(/const status: ParallelStatus =[\s\S]*?: "clean";/)?.[0] ?? "";
  assert.ok(status, "the status expression is no longer recognizable");
  assert.match(status, /blockedReason\s*\n?\s*\?\s*"no_comparable_data"/);
  assert.match(status, /unresolved > 0 \|\| unmappedColumns\.length > 0/);
  assert.match(status, /counts\.within_tolerance > 0/);

  // Zero tolerance by default, expressed as a default in the code and not as a
  // convention somebody has to remember.
  assert.match(source, /export const EXACT = "0\.0000";/);
  assert.match(source, /\?\.tolerance \?\? EXACT/);
  // No floating point anywhere in the comparison.
  assert.doesNotMatch(source, /parseFloat|Number\(|Math\.abs/);

  const audit = source.match(/export function auditComparison[\s\S]*?\n}/)?.[0] ?? "";
  assert.ok(audit, "auditComparison is no longer recognizable");
  for (const invariant of [
    "clean-compared-somebody",
    "clean-had-a-prior-side",
    "clean-had-our-side",
    "clean-compared-something",
    "clean-mapped-every-column",
    "clean-attributes-every-total",
    "tolerance-is-disclosed",
  ]) {
    assert.ok(audit.includes(invariant), `auditComparison no longer checks ${invariant}`);
  }
});

test("the comparison is deterministic and reads no ambient state", () => {
  const input = baseInput(
    [asPriorRegister(derekOurs()), asPriorRegister(graceOurs())],
    [graceOurs(), derekOurs()],
  );
  const first = comparePriorPayrollPeriod(input);
  const second = comparePriorPayrollPeriod(input);
  assert.deepEqual(first, second);
  // Findings are ordered by employee then by kind, regardless of input order.
  assert.deepEqual(
    [...new Set(first.findings.map((f) => f.employeeName))],
    ["Derek Cole", "Grace Liu"],
  );
  assert.equal(cmp(first.totals.gross.prior, first.totals.gross.ours), 0);
});
