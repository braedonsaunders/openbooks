import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalJson,
  parsePayRunCalculationSource,
  payRunCalculationSourceDigest,
  payRunCalculationSourceChanges,
  type PayRunCalculationSourceSnapshot,
} from "./run-calculation-evidence.ts";

const snapshot = (): PayRunCalculationSourceSnapshot => ({
  version: 2,
  timeEntries: [],
  timeTypes: [],
  payRates: [],
  itemAccounts: [],
  claimEntryIds: [],
  holidayFacts: { profiles: [], assertions: [], entitlementAssessments: [] },
  compensationPackages: [],
  assignmentRunPolicies: [],
  historicalEmploymentRoster: [],
  employerAssignments: [],
  holidayObligations: [],
  bonusIncomeReferences: [],
  payComponentStatutoryTreatments: [],
  holidayEmployments: [],
  incomeTaxOverrides: [],
  bankCashInputs: [],
  employerLevyAdjustments: [],
  declaredVacationAccruals: [],
  openingEmployerAuthorities: [],
  usFilingAccountLineages: [],
  openingLevySourceAuthorities: [],
  openingBalanceSources: [],
  entitlementSettlementPlans: [],
});

test("adding, removing or changing regular-only assignment windows invalidates calculated component evidence", () => {
  const empty = snapshot();
  assert.equal(
    payRunCalculationSourceChanges(empty, { ...empty, assignmentRunPolicies: [] }).components,
    false,
  );
  const policy = {
    id: "assignment",
    employeePartyId: "employee",
    employmentId: null,
    componentId: "allowance",
    policy: "regular_only",
    from: "2026-01-01",
    to: null,
  };
  const calculated = { ...snapshot(), assignmentRunPolicies: [policy] };
  assert.equal(payRunCalculationSourceChanges(empty, calculated).components, true);
  assert.equal(payRunCalculationSourceChanges(calculated, empty).components, true);
  for (const changes of [
    { from: "2026-01-02" },
    { to: "2026-01-09" },
    { employmentId: "new-employment" },
    { componentId: "premium" },
  ]) {
    assert.equal(
      payRunCalculationSourceChanges(calculated, {
        ...snapshot(),
        assignmentRunPolicies: [{ ...policy, ...changes }],
      }).components,
      true,
    );
  }
  assert.equal(parsePayRunCalculationSource({ ...empty, assignmentRunPolicies: null }), null);
});

test("operator-entered income-tax overrides are retained, validated and independently stale calculation evidence", () => {
  const empty = snapshot();
  const override: NonNullable<PayRunCalculationSourceSnapshot["incomeTaxOverrides"]>[number] = {
    adjustmentId: "10000000-0000-4000-8000-000000000001",
    employeePartyId: "10000000-0000-4000-8000-000000000002",
    componentId: "10000000-0000-4000-8000-000000000003",
    amount: "2999.7000",
    reason: "Withholding entered on issued cheque",
    sourceReference: "PayMate card 47308",
    requestId: "10000000-0000-4000-8000-000000000004",
  };
  const calculated = { ...empty, incomeTaxOverrides: [override] };
  assert.equal(payRunCalculationSourceChanges(empty, calculated).incomeTaxOverrides, true);
  assert.equal(payRunCalculationSourceChanges(calculated, empty).incomeTaxOverrides, true);
  assert.equal(
    payRunCalculationSourceChanges(calculated, {
      ...calculated,
      incomeTaxOverrides: [{ ...override, reason: "Updated reason" }],
    }).incomeTaxOverrides,
    true,
  );
  assert.deepEqual(parsePayRunCalculationSource(calculated), calculated);
  const zero = { ...calculated, incomeTaxOverrides: [{ ...override, amount: "0.0000" }] };
  assert.deepEqual(parsePayRunCalculationSource(zero), zero);
  assert.equal(payRunCalculationSourceChanges(empty, zero).incomeTaxOverrides, true);
  assert.equal(payRunCalculationSourceChanges(zero, empty).incomeTaxOverrides, true);
  for (const incomeTaxOverrides of [
    null,
    false,
    "[]",
    {},
    [{ ...override, amount: null }],
    [{ ...override, amount: "" }],
    [{ ...override, amount: "2999.7001" }],
    [{ ...override, amount: "-1.00" }],
    [{ ...override, requestId: "invalid" }],
  ]) {
    assert.equal(parsePayRunCalculationSource({ ...empty, incomeTaxOverrides }), null);
  }
});

test("audited bank cash inputs retain their keyed rate, paid hours, source and bank plan as stale evidence", () => {
  const empty = snapshot();
  const input: NonNullable<PayRunCalculationSourceSnapshot["bankCashInputs"]>[number] = {
    adjustmentId: "20000000-0000-4000-8000-000000000001",
    employeePartyId: "20000000-0000-4000-8000-000000000002",
    componentId: "20000000-0000-4000-8000-000000000003",
    amount: "1150.6400",
    hours: "8.00",
    bankPlanId: "20000000-0000-4000-8000-000000000004",
    bankPlanUnit: "hours",
    bankPlanDirection: "accrue",
    bankPlanAllowsNegativeBalance: false,
    bankPlanPayoutComponentId: "20000000-0000-4000-8000-000000000003",
    bankPlanDepositComponentId: null,
    reason: "Issued bank payout at the keyed cheque rate",
    sourceReference: "Payroll source document 2",
    requestId: "20000000-0000-4000-8000-000000000001",
    rate: "143.83",
  };
  const calculated = { ...empty, bankCashInputs: [input] };
  assert.equal(payRunCalculationSourceChanges(empty, calculated).bankCashInputs, true);
  assert.equal(payRunCalculationSourceChanges(calculated, empty).bankCashInputs, true);
  assert.equal(
    payRunCalculationSourceChanges(calculated, {
      ...calculated,
      bankCashInputs: [{ ...input, bankPlanAllowsNegativeBalance: true }],
    }).bankCashInputs,
    true,
  );
  assert.deepEqual(parsePayRunCalculationSource(calculated), calculated);
  const moneyBank = { ...calculated, bankCashInputs: [{ ...input, bankPlanUnit: "money" }] };
  assert.deepEqual(parsePayRunCalculationSource(moneyBank), moneyBank);
  assert.equal(payRunCalculationSourceChanges(calculated, moneyBank).bankCashInputs, true);
  const deposit = {
    ...input,
    hours: "-58.00",
    amount: "-1624.0000",
    rate: null,
    bankPlanPayoutComponentId: null,
    bankPlanDepositComponentId: input.componentId,
  };
  assert.deepEqual(parsePayRunCalculationSource({ ...empty, bankCashInputs: [deposit] }), {
    ...empty,
    bankCashInputs: [deposit],
  });
  for (const invalid of [
    { ...input, requestId: "20000000-0000-4000-8000-000000000099" },
    { ...input, bankPlanUnit: "quantity" },
    { ...input, bankPlanPayoutComponentId: null },
    { ...deposit, bankPlanDirection: "owe" },
    { ...deposit, bankPlanDepositComponentId: null },
    { ...input, hours: "0", amount: "0" },
    { ...input, hours: "-8.00" },
    { ...deposit, amount: null },
    { ...deposit, amount: "-1624.0001" },
  ])
    assert.equal(parsePayRunCalculationSource({ ...empty, bankCashInputs: [invalid] }), null);

  for (const bankCashInputs of [
    null,
    false,
    "[]",
    {},
    [{ ...input, rate: "143.831" }],
    [{ ...input, amount: "1150.6500" }],
  ]) {
    assert.equal(parsePayRunCalculationSource({ ...empty, bankCashInputs }), null);
  }
});

test("a split bank cash input retains its outside portion and frozen pay-date valuation as stale evidence", () => {
  const empty = snapshot();
  const splitInput: NonNullable<PayRunCalculationSourceSnapshot["bankCashInputs"]>[number] = {
    adjustmentId: "20000000-0000-4000-8000-000000000001",
    employeePartyId: "20000000-0000-4000-8000-000000000002",
    componentId: "20000000-0000-4000-8000-000000000003",
    amount: "1150.6400",
    hours: "8.00",
    bankPlanId: "20000000-0000-4000-8000-000000000004",
    bankPlanUnit: "money",
    bankPlanDirection: "accrue",
    bankPlanAllowsNegativeBalance: false,
    bankPlanPayoutComponentId: "20000000-0000-4000-8000-000000000003",
    bankPlanDepositComponentId: null,
    reason: "Issued bank payout with independently paid cash",
    sourceReference: "Payroll source document 7",
    requestId: "20000000-0000-4000-8000-000000000001",
    rate: "143.83",
    outsideBankAmount: "782.64",
    bankValuation: {
      rateId: "20000000-0000-4000-8000-000000000005",
      scope: "employee",
      hourlyWage: "46.0000",
      currency: "CAD",
      basis: "hour",
      rate: "46.0000",
      effectiveFrom: "2026-06-01",
      effectiveTo: null,
      annualHoursUsed: null,
      annualHoursSource: null,
      updatedAt: "2026-06-01T00:00:00.000000Z",
    },
  };
  const calculated = { ...empty, bankCashInputs: [splitInput] };
  assert.deepEqual(parsePayRunCalculationSource(calculated), calculated);
  assert.equal(payRunCalculationSourceChanges(empty, calculated).bankCashInputs, true);
  // A pay-date-only wage version change is a different frozen valuation and
  // therefore stale evidence, even when every period-end field is identical.
  for (const bankValuation of [
    { ...splitInput.bankValuation!, hourlyWage: "47.0000", rate: "47.0000" },
    {
      ...splitInput.bankValuation!,
      rateId: "20000000-0000-4000-8000-000000000006",
      effectiveFrom: "2026-06-15",
    },
    { ...splitInput.bankValuation!, updatedAt: "2026-06-15T00:00:00.000000Z" },
  ]) {
    const current = { ...empty, bankCashInputs: [{ ...splitInput, bankValuation }] };
    assert.equal(payRunCalculationSourceChanges(calculated, current).bankCashInputs, true);
    assert.notEqual(
      payRunCalculationSourceDigest(calculated),
      payRunCalculationSourceDigest(current),
    );
  }
  assert.equal(
    payRunCalculationSourceChanges(calculated, {
      ...calculated,
      bankCashInputs: [{ ...splitInput, outsideBankAmount: "782.63" }],
    }).bankCashInputs,
    true,
  );
  // Period-end-only evidence cannot certify a pay-date valuation: a split
  // without its frozen valuation, or a valuation without its split, fails closed.
  const { bankValuation: _omitted, ...splitWithoutValuation } = splitInput;
  const { outsideBankAmount: _outside, ...valuationWithoutSplit } = splitInput;
  for (const invalid of [
    splitWithoutValuation,
    valuationWithoutSplit,
    { ...splitInput, outsideBankAmount: "1150.64" },
    { ...splitInput, outsideBankAmount: "0.00" },
    { ...splitInput, outsideBankAmount: "-1.00" },
    { ...splitInput, hours: "-8.00", amount: "-1150.6400" },
    { ...splitInput, bankValuation: { ...splitInput.bankValuation!, hourlyWage: "46.0100" } },
    {
      ...splitInput,
      bankValuation: {
        ...splitInput.bankValuation!,
        basis: "year",
        rate: "95680.0000",
        annualHoursUsed: "2000",
        annualHoursSource: "rate" as const,
      },
    },
    { ...splitInput, bankValuation: { ...splitInput.bankValuation!, effectiveFrom: "2026-02-30" } },
    { ...splitInput, bankValuation: { ...splitInput.bankValuation!, rateId: "not-a-wage" } },
  ])
    assert.equal(parsePayRunCalculationSource({ ...empty, bankCashInputs: [invalid] }), null);
  // The same frozen shape certifies a time-based wage converted through its
  // retained annual-hours divisor: 95,680 a year over 2,080 hours is 46 an hour.
  // An explicitly unresolved pay-date valuation is retained as null so a
  // wage that later appears changes the evidence instead of certifying one.
  assert.deepEqual(
    parsePayRunCalculationSource({
      ...empty,
      bankCashInputs: [{ ...splitInput, bankValuation: null }],
    }),
    { ...empty, bankCashInputs: [{ ...splitInput, bankValuation: null }] },
  );
  // An observed foreign-currency valuation is retained, not hidden: a later
  // currency correction is a changed valuation and reads stale.
  const foreignValued = {
    ...splitInput,
    bankValuation: { ...splitInput.bankValuation!, currency: "USD" },
  };
  assert.deepEqual(parsePayRunCalculationSource({ ...empty, bankCashInputs: [foreignValued] }), {
    ...empty,
    bankCashInputs: [foreignValued],
  });
  assert.equal(
    payRunCalculationSourceChanges(calculated, { ...empty, bankCashInputs: [foreignValued] })
      .bankCashInputs,
    true,
  );
  const salaryValued = {
    ...splitInput,
    bankValuation: {
      ...splitInput.bankValuation!,
      basis: "year",
      rate: "95680.0000",
      hourlyWage: "46.0000",
      annualHoursUsed: "2080",
      annualHoursSource: "rate" as const,
    },
  };
  assert.deepEqual(parsePayRunCalculationSource({ ...empty, bankCashInputs: [salaryValued] }), {
    ...empty,
    bankCashInputs: [salaryValued],
  });
});

test("declared vacation accruals retain the exact per-cheque amount and source as stale evidence", () => {
  const empty = snapshot();
  const accrual: NonNullable<PayRunCalculationSourceSnapshot["declaredVacationAccruals"]>[number] =
    {
      adjustmentId: "30000000-0000-4000-8000-000000000001",
      employeePartyId: "30000000-0000-4000-8000-000000000002",
      componentId: "30000000-0000-4000-8000-000000000003",
      planId: "30000000-0000-4000-8000-000000000004",
      amount: "2500.8100",
      reason: "Vacation liability declared on the issued cheque",
      sourceReference: "Issued cheque 7, leave request 9",
      requestId: "30000000-0000-4000-8000-000000000001",
    };
  const calculated = { ...empty, declaredVacationAccruals: [accrual] };
  assert.equal(payRunCalculationSourceChanges(empty, calculated).declaredVacationAccruals, true);
  assert.equal(payRunCalculationSourceChanges(calculated, empty).declaredVacationAccruals, true);
  assert.equal(
    payRunCalculationSourceChanges(calculated, {
      ...calculated,
      declaredVacationAccruals: [{ ...accrual, amount: "2500.8200" }],
    }).declaredVacationAccruals,
    true,
  );
  assert.deepEqual(parsePayRunCalculationSource(calculated), calculated);
  for (const declaredVacationAccruals of [
    null,
    false,
    "[]",
    {},
    [{ ...accrual, amount: "0.0000" }],
    [{ ...accrual, amount: "2500.8101" }],
    [{ ...accrual, requestId: "invalid" }],
  ]) {
    assert.equal(parsePayRunCalculationSource({ ...empty, declaredVacationAccruals }), null);
  }
});

test("approved holiday ownership, source, wage and foreign payment claims invalidate a calculated run", () => {
  const empty = snapshot();
  assert.equal(
    payRunCalculationSourceChanges(empty, { ...empty, holidayObligations: [] }).holidayObligations,
    false,
  );
  const obligation: NonNullable<PayRunCalculationSourceSnapshot["holidayObligations"]>[number] = {
    id: "10000000-0000-4000-8000-000000000001",
    employeePartyId: "10000000-0000-4000-8000-000000000002",
    employmentId: "10000000-0000-4000-8000-000000000003",
    subsidiaryId: "10000000-0000-4000-8000-000000000004",
    paymentDate: "2026-01-16",
    foreignClaim: null,
    component: { id: "native-stat", taxable: true },
    profile: { country: "CA", province: "ON" },
    evidence: {
      instruction: {
        employeePartyId: "10000000-0000-4000-8000-000000000002",
        holidayDates: ["2025-12-25", "2025-12-26", "2026-01-01"],
        hours: "24.00",
        assessedOn: "2026-01-10",
        wageBasisDate: "2026-01-10",
        paymentDate: "2026-01-16",
        instructionKey: "owed-holidays",
        sourceReference: "Approved payroll instruction",
        sourceDigest: "a".repeat(64),
      },
      source: {
        fileId: "10000000-0000-4000-8000-000000000005",
        versionId: "10000000-0000-4000-8000-000000000006",
        versionNumber: 1,
        contentHash: "a".repeat(64),
      },
    },
    wage: {
      resolved: {
        rate: "45",
        annualHours: "2080",
        basis: "hour",
        currency: "CAD",
        payrollRateScale: 2,
        payrollAmountRounding: "dimension_group",
      },
      source: { id: "dated-wage" },
      fx: null,
    },
  };
  const calculated = { ...snapshot(), holidayObligations: [obligation] };
  assert.equal(payRunCalculationSourceChanges(empty, calculated).holidayObligations, true);
  for (const replacement of [
    {
      ...obligation,
      foreignClaim: { id: "other-claim", documentId: "other-payroll", status: "committed" },
    },
    {
      ...obligation,
      wage: { ...obligation.wage!, resolved: { ...obligation.wage!.resolved, rate: "46" } },
    },
    {
      ...obligation,
      evidence: {
        ...obligation.evidence,
        source: { ...obligation.evidence.source, versionNumber: 2 },
      },
    },
    { ...obligation, component: { ...obligation.component, taxable: false } },
  ]) {
    const changed = { ...snapshot(), holidayObligations: [replacement] };
    assert.equal(payRunCalculationSourceChanges(calculated, changed).holidayObligations, true);
    assert.notEqual(
      payRunCalculationSourceDigest(calculated),
      payRunCalculationSourceDigest(changed),
    );
  }
  assert.equal(payRunCalculationSourceChanges(calculated, empty).holidayObligations, true);
  for (const malformed of [null, false, "[]", {}])
    assert.equal(
      parsePayRunCalculationSource({ ...snapshot(), holidayObligations: malformed }),
      null,
    );
});

test("stored calculation evidence accepts the supported version and preserves routing evidence", () => {
  const value = snapshot();
  value.itemAccounts.push({
    id: "service-item",
    payrollExpenseAccountId: "expense-account",
    updatedAt: "2026-09-20",
  });
  assert.deepEqual(parsePayRunCalculationSource(value), value);
});

test("missing, scalar, array, and unsupported-version calculation evidence fails closed", () => {
  for (const value of [
    null,
    undefined,
    false,
    1,
    "{}",
    [],
    {},
    { ...snapshot(), version: 0 },
    { ...snapshot(), version: 1 },
  ]) {
    assert.equal(parsePayRunCalculationSource(value), null, JSON.stringify(value));
  }
});

test("each required evidence collection must be an array", () => {
  for (const key of Object.keys(snapshot()).filter((key) =>
    Array.isArray(snapshot()[key as keyof PayRunCalculationSourceSnapshot]),
  )) {
    for (const bad of [undefined, null, {}, "[]"]) {
      assert.equal(parsePayRunCalculationSource({ ...snapshot(), [key]: bad }), null, key);
    }
  }
});

test("missing routing evidence requires recalculation rather than an invented empty collection", () => {
  const partial: Partial<PayRunCalculationSourceSnapshot> = snapshot();
  delete partial.itemAccounts;
  assert.equal(parsePayRunCalculationSource(partial), null);
});

test("canonical evidence ignores object key order but preserves array order and values", () => {
  assert.equal(
    canonicalJson({ b: [null, 2], a: { z: false, y: "x" } }),
    canonicalJson({ a: { y: "x", z: false }, b: [null, 2] }),
  );
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  const first = snapshot();
  const reordered = Object.fromEntries(
    Object.entries(first).reverse(),
  ) as unknown as PayRunCalculationSourceSnapshot;
  assert.equal(payRunCalculationSourceDigest(first), payRunCalculationSourceDigest(reordered));
  assert.notEqual(
    payRunCalculationSourceDigest(first),
    payRunCalculationSourceDigest({ ...first, claimEntryIds: ["new-claim"] }),
  );
});

test("approved compensation package sources change the protected calculation evidence", () => {
  const empty = snapshot();
  assert.equal(payRunCalculationSourceChanges(empty, empty).compensationPackages, false);
  const source: NonNullable<PayRunCalculationSourceSnapshot["compensationPackages"]>[number] = {
    assignmentId: "assignment",
    packageId: "package",
    packageCode: "FIELD",
    employmentId: "employment",
    employeePartyId: "employee",
    subsidiaryId: "employer",
    country: "CA",
    currency: "CAD",
    currencyMinorUnits: 2,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    inputs: { allowance: "310" },
    versionId: "approved-version",
    versionEffectiveFrom: "2026-01-01",
    versionEffectiveTo: null,
    definitionHash: "approved-hash",
    definition: {
      orgId: "organization",
      country: "CA",
      currency: "CAD",
      partialPeriod: "allow",
      inputs: [],
      rules: [],
    },
    components: [],
  };
  const current = { ...snapshot(), compensationPackages: [source] };
  assert.equal(payRunCalculationSourceChanges(empty, current).compensationPackages, true);
  assert.notEqual(payRunCalculationSourceDigest(current), payRunCalculationSourceDigest(empty));
  const changed = {
    ...snapshot(),
    compensationPackages: [{ ...source, inputs: { allowance: "320" } }],
  };
  assert.equal(payRunCalculationSourceChanges(current, changed).compensationPackages, true);
});

test("a malformed package source is refused rather than treated as an empty population", () => {
  for (const compensationPackages of [null, false, "[]", {}]) {
    assert.equal(parsePayRunCalculationSource({ ...snapshot(), compensationPackages }), null);
  }
});

test("dated employer assignment evidence detects added, removed and changed historical sources while empty evidence remains unchanged", () => {
  const empty = snapshot();
  const emptyDigest = payRunCalculationSourceDigest(empty);
  assert.equal(
    payRunCalculationSourceChanges(empty, { ...empty, employerAssignments: [] }).roster,
    false,
  );
  assert.equal(payRunCalculationSourceDigest(parsePayRunCalculationSource(empty)!), emptyDigest);
  const source = {
    id: "assignment",
    employeePartyId: "employee",
    subsidiaryId: "employer",
    kind: "filing_account" as const,
    effectiveFrom: "2026-01-09",
    effectiveTo: "2026-01-09",
    filingAccountId: "reduced-account",
    workerCompGroupId: null,
    createdAt: "2026-10-06",
    sourceReference: "Original dated provider card",
  };
  const current = { ...snapshot(), employerAssignments: [source] };
  assert.equal(payRunCalculationSourceChanges(empty, current).roster, true);
  assert.equal(payRunCalculationSourceChanges(current, empty).roster, true);
  for (const change of [
    { filingAccountId: "standard-account" },
    { subsidiaryId: "other-employer" },
    { effectiveTo: "2026-01-10" },
    { sourceReference: "Another source" },
  ]) {
    assert.equal(
      payRunCalculationSourceChanges(current, {
        ...current,
        employerAssignments: [{ ...source, ...change }],
      }).roster,
      true,
    );
  }
  for (const employerAssignments of [null, false, "[]", {}]) {
    assert.equal(parsePayRunCalculationSource({ ...empty, employerAssignments }), null);
  }
});

test("historical roster admissions and changed windows stale a calculation while empty empty evidence stays equal", () => {
  const empty = snapshot();
  assert.equal(
    payRunCalculationSourceChanges(empty, { ...empty, historicalEmploymentRoster: [] }).roster,
    false,
  );
  const admission = {
    employeePartyId: "employee",
    employmentId: "employment",
    versionNo: 2,
    status: "active",
    effectiveFrom: "2026-01-23",
    effectiveTo: "2026-01-24",
    recordedAt: "2026-10-09T12:00:00.000000Z",
  };
  const calculated = { ...snapshot(), historicalEmploymentRoster: [admission] };
  assert.equal(payRunCalculationSourceChanges(empty, calculated).roster, true);
  assert.equal(payRunCalculationSourceChanges(calculated, empty).roster, true);
  for (const replacement of [
    { ...admission, status: "on_leave" },
    { ...admission, versionNo: 3 },
    { ...admission, effectiveFrom: "2026-01-22" },
    { ...admission, employmentId: "other-employment" },
  ])
    assert.equal(
      payRunCalculationSourceChanges(calculated, {
        ...snapshot(),
        historicalEmploymentRoster: [replacement],
      }).roster,
      true,
    );
  for (const malformed of [null, {}, false, "[]"]) {
    assert.equal(
      parsePayRunCalculationSource({ ...snapshot(), historicalEmploymentRoster: malformed }),
      null,
    );
  }
});

test("opening source identity remains auditable and changes invalidate opening evidence without rewriting empty snapshots", () => {
  const empty = snapshot();
  const source: NonNullable<PayRunCalculationSourceSnapshot["openingEmployerAuthorities"]>[number] =
    {
      id: "10000000-0000-4000-8000-000000000001",
      openingBalanceId: "10000000-0000-4000-8000-000000000002",
      employeePartyId: "10000000-0000-4000-8000-000000000003",
      taxYear: 2026,
      subsidiaryId: "10000000-0000-4000-8000-000000000004",
      sourceFileId: "10000000-0000-4000-8000-000000000005",
      sourceVersionId: "10000000-0000-4000-8000-000000000006",
      sourceSha256: "a".repeat(64),
      openingSha256: "b".repeat(64),
    };
  const retained = { ...empty, openingEmployerAuthorities: [source] };
  assert.deepEqual(parsePayRunCalculationSource(empty), empty);
  assert.deepEqual(parsePayRunCalculationSource(retained), retained);
  assert.equal(
    payRunCalculationSourceChanges(empty, { ...empty, openingEmployerAuthorities: [] })
      .openingBalances,
    false,
  );
  assert.equal(payRunCalculationSourceChanges(empty, retained).openingBalances, true);
  assert.equal(payRunCalculationSourceChanges(retained, empty).openingBalances, true);
  for (const change of [
    { subsidiaryId: "10000000-0000-4000-8000-000000000007" },
    { sourceVersionId: "10000000-0000-4000-8000-000000000008" },
    { sourceSha256: "c".repeat(64) },
    { openingSha256: "d".repeat(64) },
    { taxYear: 2027 },
  ]) {
    const current = { ...empty, openingEmployerAuthorities: [{ ...source, ...change }] };
    assert.equal(payRunCalculationSourceChanges(retained, current).openingBalances, true);
    assert.notEqual(
      payRunCalculationSourceDigest(retained),
      payRunCalculationSourceDigest(current),
    );
  }
  for (const malformed of [
    null,
    "[]",
    {},
    [null],
    [{ ...source, sourceSha256: "unknown" }],
    [{ ...source, sourceFileId: "missing" }],
    [{ ...source, taxYear: "2026" }],
  ]) {
    assert.equal(
      parsePayRunCalculationSource({ ...empty, openingEmployerAuthorities: malformed }),
      null,
    );
  }
});

test("dated statutory treatment identity, resolved group and policy window are protected calculation evidence", () => {
  const treatment = {
    id: "10000000-0000-4000-8000-000000000001",
    componentId: "10000000-0000-4000-8000-000000000002",
    workerCompGroupId: null,
    employeeWorkerCompGroupId: null,
    effectiveFrom: "2026-01-01",
    effectiveTo: "2026-12-31",
    programExclusions: ["wcb"],
    vacationable: false,
  };
  const original = { ...snapshot(), payComponentStatutoryTreatments: [treatment] };
  assert.deepEqual(parsePayRunCalculationSource(original), original);
  for (const change of [
    { id: "10000000-0000-4000-8000-000000000003" },
    { employeeWorkerCompGroupId: "10000000-0000-4000-8000-000000000004" },
    { effectiveTo: "2026-11-30" },
    { programExclusions: [] },
    { vacationable: true },
  ]) {
    const current = {
      ...snapshot(),
      payComponentStatutoryTreatments: [{ ...treatment, ...change }],
    };
    assert.equal(payRunCalculationSourceChanges(original, current).components, true);
    assert.notEqual(
      payRunCalculationSourceDigest(original),
      payRunCalculationSourceDigest(current),
    );
  }
  for (const change of [
    { id: null },
    { id: "unknown" },
    { employeeWorkerCompGroupId: undefined },
    { effectiveFrom: "2026-02-30" },
    { effectiveTo: "2025-12-31" },
    { programExclusions: [null] },
    { vacationable: undefined },
    { vacationable: "false" },
  ]) {
    assert.equal(
      parsePayRunCalculationSource({
        ...snapshot(),
        payComponentStatutoryTreatments: [{ ...treatment, ...change }],
      }),
      null,
    );
  }
});

test("selected holiday employment status history is validated and makes its calculated entitlement stale", () => {
  const row: NonNullable<PayRunCalculationSourceSnapshot["holidayEmployments"]>[number] = {
    orgId: "10000000-0000-4000-8000-000000000001",
    employeePartyId: "10000000-0000-4000-8000-000000000002",
    employmentId: "10000000-0000-4000-8000-000000000003",
    subsidiaryId: "10000000-0000-4000-8000-000000000004",
    employmentRevision: 1,
    versionId: "10000000-0000-4000-8000-000000000005",
    versionNo: 1,
    status: "active",
    effectiveFrom: "2026-04-05",
    effectiveTo: null,
    recordedAt: "2026-04-05T00:00:00.000000Z",
  };
  const calculated = { ...snapshot(), holidayEmployments: [row] };
  assert.deepEqual(parsePayRunCalculationSource(calculated), calculated);
  for (const changed of [
    { effectiveFrom: "2026-04-04" },
    { status: "ended" },
    { employmentRevision: 2 },
    { employmentId: "10000000-0000-4000-8000-000000000006" },
  ]) {
    assert.equal(
      payRunCalculationSourceChanges(calculated, {
        ...calculated,
        holidayEmployments: [{ ...row, ...changed }],
      }).holidayObligations,
      true,
    );
  }
  for (const changed of [
    { employmentRevision: 0 },
    { employmentId: "unknown" },
    { effectiveFrom: "2026-02-30" },
    { recordedAt: "unknown" },
  ]) {
    assert.equal(
      parsePayRunCalculationSource({ ...calculated, holidayEmployments: [{ ...row, ...changed }] }),
      null,
    );
  }
  assert.equal(payRunCalculationSourceChanges(calculated, snapshot()).holidayObligations, true);
});

test("issued employer premiums retain positive cents, source ownership and their original request identity", () => {
  const baseline = snapshot();
  const input = {
    adjustmentId: "70000000-0000-4000-8000-000000000001",
    employeePartyId: "70000000-0000-4000-8000-000000000002",
    componentId: "70000000-0000-4000-8000-000000000003",
    amount: "26.3200",
    programKey: "ca_eht",
    workerCompGroupId: null,
    sourceKey: "export:levy:001",
    reason: "Retain issued employer premium",
    sourceReference: "Reviewed export row 1",
    requestId: "70000000-0000-4000-8000-000000000001",
  };
  const current = { ...baseline, employerLevyAdjustments: [input] };
  assert.deepEqual(parsePayRunCalculationSource(current), current);
  assert.equal(payRunCalculationSourceChanges(baseline, current).employerLevyAdjustments, true);
  assert.equal(payRunCalculationSourceChanges(current, baseline).employerLevyAdjustments, true);
  for (const changes of [
    { amount: "-26.32" },
    { amount: "0.00" },
    { amount: "26.321" },
    { requestId: "70000000-0000-4000-8000-000000000004" },
    { programKey: "cpp" },
    { sourceKey: "" },
  ]) {
    assert.equal(
      parsePayRunCalculationSource({
        ...current,
        employerLevyAdjustments: [{ ...input, ...changes }],
      }),
      null,
    );
  }
  assert.notEqual(
    payRunCalculationSourceDigest(current),
    payRunCalculationSourceDigest({
      ...current,
      employerLevyAdjustments: [{ ...input, sourceKey: "export:levy:002" }],
    }),
  );
});

test("treatment evidence requires explicit vacation eligibility", () => {
  const treatment = {
    id: "0190d4c2-0000-7000-8000-000000000001",
    componentId: "0190d4c2-0000-7000-8000-000000000002",
    workerCompGroupId: null,
    employeeWorkerCompGroupId: null,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    programExclusions: ["eht"],
  };
  for (const vacationable of [undefined, null, "true", 1]) {
    assert.equal(
      parsePayRunCalculationSource({
        ...snapshot(),
        payComponentStatutoryTreatments: [{ ...treatment, vacationable }],
      }),
      null,
    );
  }
  const current = {
    ...snapshot(),
    payComponentStatutoryTreatments: [{ ...treatment, vacationable: false }],
  };
  assert.deepEqual(parsePayRunCalculationSource(current), current);
  assert.equal(
    payRunCalculationSourceChanges(current, {
      ...current,
      payComponentStatutoryTreatments: [{ ...treatment, vacationable: true }],
    }).components,
    true,
  );
});

test("entitlement settlement accounts are calculation evidence that stale a run when re-pointed", () => {
  const plan = {
    planId: "0190d4c2-0000-7000-8000-000000000003",
    planActive: true,
    liabilityAccountId: "0190d4c2-0000-7000-8000-000000000004",
    accrualComponentId: null,
    accrualLiabilityAccountId: null,
  };
  const calculated = { ...snapshot(), entitlementSettlementPlans: [plan] };
  assert.deepEqual(parsePayRunCalculationSource(calculated), calculated);
  assert.equal(
    parsePayRunCalculationSource({
      ...snapshot(),
      entitlementSettlementPlans: [{ ...plan, planActive: "yes" }],
    }),
    null,
  );
  assert.equal(
    payRunCalculationSourceChanges(calculated, {
      ...snapshot(),
      entitlementSettlementPlans: [
        { ...plan, liabilityAccountId: "0190d4c2-0000-7000-8000-000000000005" },
      ],
    }).components,
    true,
  );
  assert.equal(payRunCalculationSourceChanges(snapshot(), snapshot()).components, false);
});

test("persisted holiday decisions and profile facts invalidate calculation evidence", () => {
  const base = snapshot();
  const profile = {
    employee_party_id: "0190d4c2-0000-7000-8000-000000000001",
    paid_on_commission: false,
    statutory_occupation_class: "general",
    updated_at: "2026-10-19T12:00:00Z",
  };
  const current = { ...base, holidayFacts: { ...base.holidayFacts, profiles: [profile] } };
  assert.deepEqual(parsePayRunCalculationSource(current), current);
  for (const changes of [
    { paid_on_commission: true },
    { statutory_occupation_class: "construction" },
  ]) {
    const changed = {
      ...current,
      holidayFacts: { ...current.holidayFacts, profiles: [{ ...profile, ...changes }] },
    };
    assert.equal(payRunCalculationSourceChanges(current, changed).roster, true);
    assert.notEqual(payRunCalculationSourceDigest(current), payRunCalculationSourceDigest(changed));
  }
  for (const holidayFacts of [
    undefined,
    {},
    { ...current.holidayFacts, profiles: [{ ...profile, paid_on_commission: "no" }] },
  ]) {
    assert.equal(parsePayRunCalculationSource({ ...base, holidayFacts }), null);
  }
});
