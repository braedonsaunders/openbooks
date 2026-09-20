import assert from "node:assert/strict";
import test from "node:test";
import { add, cmp } from "../money/money.ts";
import {
  assertAggregateLeviesValid,
  assessAggregateLevyStub,
  type AggregateStubPriors,
} from "./employer-aggregate.ts";
import type { PayrollEmployerAggregateLevy } from "./packs.ts";

/**
 * Employer-aggregate levies, pure arithmetic half.
 *
 * No database, no pack, no country: synthetic declarations only, so a
 * failure here is about the money (room consumption, marginal bands,
 * annual-timing zeros) and never about the plumbing. The DB-backed priors
 * resolver and the run wiring are tested beside the run.
 */

const PRIORS: AggregateStubPriors = {
  employerPriorBase: "0",
  employeePriorBase: "0",
  tenantValues: {},
};

/** Flat percent past an employer allowance — the threshold shape. */
const THRESHOLD_LEVY: PayrollEmployerAggregateLevy = {
  key: "threshold",
  label: "Threshold levy",
  systemKey: "threshold",
  description: "Threshold levy",
  sequence: 280,
  base: { source: "gross", scope: "org" },
  timing: "per_run",
  rate: { kind: "flat_percent", percent: "1" },
  allowance: { kind: "employer_allowance", amount: "2000" },
  factorKey: "THR",
};

/** Flat percent under a per-employee cap — the labour-standards shape. */
const CAP_LEVY: PayrollEmployerAggregateLevy = {
  key: "capped",
  label: "Capped levy",
  systemKey: "capped",
  description: "Capped levy",
  sequence: 280,
  base: { source: "gross", scope: "org" },
  timing: "per_run",
  rate: { kind: "flat_percent", percent: "0.06" },
  allowance: { kind: "per_employee_cap", amount: "103000" },
  factorKey: "CAP",
};

/** Marginal bands on the employer total — the rate-from-payroll shape. */
const BAND_LEVY: PayrollEmployerAggregateLevy = {
  key: "banded",
  label: "Banded levy",
  systemKey: "banded",
  description: "Banded levy",
  sequence: 280,
  base: { source: "gross", scope: "org" },
  timing: "per_run",
  rate: {
    kind: "marginal_bands",
    bands: [
      { upTo: "1000", percent: "1" },
      { upTo: null, percent: "2" },
    ],
  },
  allowance: { kind: "none" },
  factorKey: "BND",
};

test("threshold levy prices only the base above the allowance", () => {
  const priors: AggregateStubPriors = { ...PRIORS, employerPriorBase: "1500" };
  const got = assessAggregateLevyStub(THRESHOLD_LEVY, "1000", priors);
  assert.equal(cmp(got.assessable, "500"), 0);
  assert.equal(cmp(got.amount, "5"), 0);
  assert.equal(cmp(got.factors.THR ?? "?", got.amount), 0);
  // Past a shelter the accumulator is the FULL stub base: room is measured
  // against total base, so the factor must carry it.
  assert.equal(cmp(got.factors.THR_EARN ?? "?", "1000"), 0);
});

test("threshold levy accrues nothing while the allowance still covers the stub", () => {
  const priors: AggregateStubPriors = { ...PRIORS, employerPriorBase: "500" };
  const got = assessAggregateLevyStub(THRESHOLD_LEVY, "1000", priors);
  assert.equal(got.amount, "0");
  assert.equal(got.assessable, "0");
  // ...but the base is still stamped: room is measured against total base,
  // so a stamp-less stub would let the next stub price this slice again.
  assert.equal(cmp(got.factors.THR_EARN ?? "?", "1000"), 0);
});

test("sheltered stubs sequence room across the run in order", () => {
  // Allowance 2000: the first 1000 prices nothing but still stamps its base,
  // so the second stub (prior 1000, base 1500) prices the 500 above 2000.
  const first = assessAggregateLevyStub(THRESHOLD_LEVY, "1000", PRIORS);
  assert.equal(cmp(first.amount, "0"), 0);
  const second = assessAggregateLevyStub(THRESHOLD_LEVY, "1500", {
    ...PRIORS,
    employerPriorBase: first.factors.THR_EARN ?? "?",
  });
  assert.equal(cmp(second.assessable, "500"), 0);
  assert.equal(cmp(second.amount, "5"), 0);
});

test("per-employee cap binds on personal room, not employer room", () => {
  const priors: AggregateStubPriors = {
    ...PRIORS,
    employerPriorBase: "5000000",
    employeePriorBase: "100000",
  };
  const got = assessAggregateLevyStub(CAP_LEVY, "5000", priors);
  assert.equal(cmp(got.assessable, "3000"), 0);
  assert.equal(cmp(got.amount, "1.8"), 0);
});

test("exhausted personal cap accrues nothing and stamps no factors", () => {
  const priors: AggregateStubPriors = { ...PRIORS, employeePriorBase: "103000" };
  assert.deepEqual(assessAggregateLevyStub(CAP_LEVY, "5000", priors), {
    amount: "0",
    assessable: "0",
    factors: {},
  });
});

test("marginal bands price each slice at its own rate", () => {
  const priors: AggregateStubPriors = { ...PRIORS, employerPriorBase: "800" };
  const got = assessAggregateLevyStub(BAND_LEVY, "500", priors);
  assert.equal(cmp(got.assessable, "500"), 0);
  // 200 at 1% plus 300 at 2%.
  assert.equal(cmp(got.amount, "8"), 0);
});

test("marginal bands reconcile across stubs regardless of split", () => {
  const first = assessAggregateLevyStub(BAND_LEVY, "500", PRIORS);
  const second = assessAggregateLevyStub(
    BAND_LEVY,
    "500",
    { ...PRIORS, employerPriorBase: "500" },
  );
  const whole = assessAggregateLevyStub(BAND_LEVY, "1000", PRIORS);
  assert.equal(cmp(first.amount, "5"), 0);
  assert.equal(cmp(second.amount, "5"), 0);
  assert.equal(cmp(whole.amount, "10"), 0);
  assert.equal(cmp(add(first.amount, second.amount), whole.amount), 0);
});

test("annual-timing levies accrue nothing per run, however large the base", () => {
  const annual: PayrollEmployerAggregateLevy = {
    ...THRESHOLD_LEVY,
    key: "annual",
    timing: "annual",
    offset: { kind: "tenant_spend", slotKey: "spend", amountField: "amount" },
    factorKey: "ANN",
  };
  const priors: AggregateStubPriors = {
    ...PRIORS,
    employerPriorBase: "99999999",
    tenantValues: { spend: { amount: "100" } },
  };
  assert.deepEqual(assessAggregateLevyStub(annual, "1000000", priors), {
    amount: "0",
    assessable: "0",
    factors: {},
  });
});

test("excluded employer class accrues nothing", () => {
  const levy: PayrollEmployerAggregateLevy = {
    ...CAP_LEVY,
    key: "excluded",
    factorKey: "EXC",
    excludedBy: { slotKey: "org", flagField: "exempt" },
  };
  const priors: AggregateStubPriors = {
    ...PRIORS,
    tenantValues: { org: { exempt: "true" } },
  };
  assert.deepEqual(assessAggregateLevyStub(levy, "5000", priors), {
    amount: "0",
    assessable: "0",
    factors: {},
  });
  const included = assessAggregateLevyStub(levy, "5000", {
    ...PRIORS,
    tenantValues: { org: { exempt: "false" } },
  });
  assert.equal(cmp(included.amount, "3"), 0);
});

test("tenant-slot rate refuses a missing configuration by levy name", () => {
  const levy: PayrollEmployerAggregateLevy = {
    ...THRESHOLD_LEVY,
    key: "slotrate",
    rate: { kind: "tenant_slot", slotKey: "health", percentField: "rate" },
    allowance: { kind: "none" },
    factorKey: "SLT",
  };
  assert.throws(
    () => assessAggregateLevyStub(levy, "1000", PRIORS),
    /slotrate.*health/,
  );
  const got = assessAggregateLevyStub(levy, "1000", {
    ...PRIORS,
    tenantValues: { health: { rate: "1.95" } },
  });
  assert.equal(cmp(got.amount, "19.5"), 0);
});

test("class bands select the employer's class, default otherwise", () => {
  const levy: PayrollEmployerAggregateLevy = {
    ...BAND_LEVY,
    key: "classed",
    factorKey: "CLS",
    classSlotKey: "org",
    rate: {
      kind: "marginal_bands",
      bands: [{ upTo: null, percent: "1" }],
      classBands: [{ flag: "heavy", bands: [{ upTo: null, percent: "4" }] }],
    },
  };
  const plain = assessAggregateLevyStub(levy, "1000", PRIORS);
  assert.equal(cmp(plain.amount, "10"), 0);
  const heavy = assessAggregateLevyStub(levy, "1000", {
    ...PRIORS,
    tenantValues: { org: { heavy: "true" } },
  });
  assert.equal(cmp(heavy.amount, "40"), 0);
  const noSlot: PayrollEmployerAggregateLevy = {
    ...levy,
    key: "noslot",
    factorKey: "NSL",
    classSlotKey: undefined,
  };
  assert.throws(
    () => assertAggregateLeviesValid([noSlot]),
    /no class slot/,
  );
  const twoClass: PayrollEmployerAggregateLevy = {
    ...levy,
    key: "twoclass",
    factorKey: "TWO",
    rate: {
      kind: "marginal_bands",
      bands: [{ upTo: null, percent: "1" }],
      classBands: [
        { flag: "heavy", bands: [{ upTo: null, percent: "4" }] },
        { flag: "other", bands: [{ upTo: null, percent: "5" }] },
      ],
    },
  };
  assert.throws(
    () => assessAggregateLevyStub(twoClass, "1000", {
      ...PRIORS,
      tenantValues: { org: { heavy: "true", other: "true" } },
    }),
    /matches 2 employer classes/,
  );
});

test("declaration validation refuses what the generic layer cannot compute", () => {
  const bad = (levy: PayrollEmployerAggregateLevy, pattern: RegExp) => {
    assert.throws(() => assertAggregateLeviesValid([levy]), pattern, levy.key);
  };
  bad({ ...CAP_LEVY, key: "", factorKey: "X" }, /no key/);
  bad({ ...CAP_LEVY, key: "k", factorKey: "lower" }, /factor keys are uppercase/);
  bad(
    {
      ...CAP_LEVY, key: "k", factorKey: "K",
      base: { source: "net", scope: "org" },
    } as unknown as PayrollEmployerAggregateLevy,
    /base source "net"/,
  );
  bad(
    {
      ...CAP_LEVY, key: "k", factorKey: "K",
      rate: { kind: "per_stub_guess" },
    } as unknown as PayrollEmployerAggregateLevy,
    /rate kind "per_stub_guess"/,
  );
  bad(
    {
      ...CAP_LEVY, key: "k", factorKey: "K",
      rate: { kind: "marginal_bands", bands: [{ upTo: "100", percent: "1" }] },
    },
    /no open top band/,
  );
  bad(
    {
      ...CAP_LEVY, key: "k", factorKey: "K",
      rate: {
        kind: "marginal_bands",
        bands: [
          { upTo: "100", percent: "1" },
          { upTo: "50", percent: "2" },
          { upTo: null, percent: "3" },
        ],
      },
    },
    /must rise/,
  );
  bad(
    {
      ...THRESHOLD_LEVY, key: "k", factorKey: "K",
      offset: { kind: "tenant_spend", slotKey: "s", amountField: "a" },
    },
    /per-run assessment/,
  );
  // The offset check fires before the annual-cap check: a spend offset has
  // no meaning against a personal cap under either timing.
  bad(
    {
      ...CAP_LEVY, key: "k", factorKey: "K",
      timing: "annual",
      offset: { kind: "tenant_spend", slotKey: "s", amountField: "a" },
    },
    /offsets spend against "per_employee_cap"/,
  );
  bad(
    {
      ...CAP_LEVY, key: "k", factorKey: "K",
      timing: "annual",
    },
    /settles annually against a per-employee cap/,
  );
  assert.throws(
    () => assertAggregateLeviesValid([
      { ...CAP_LEVY, key: "same" },
      { ...THRESHOLD_LEVY, key: "same", factorKey: "OTHER" },
    ]),
    /duplicate.*key "same"/,
  );
  assert.throws(
    () => assertAggregateLeviesValid([
      CAP_LEVY,
      { ...THRESHOLD_LEVY, factorKey: "CAP" },
    ]),
    /reuses factor "CAP"/,
  );
});
