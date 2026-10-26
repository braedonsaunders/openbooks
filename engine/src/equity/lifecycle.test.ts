import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCapTable,
  conversionOnVoidedTerms,
  conversionRatio,
  conversionPrice,
  convertibleState,
  convertibleTerms,
  electionInForce,
  electionOnVoidedSource,
  eventsOf,
  holdingState,
} from "./cap-table.ts";
import { compensationTranches } from "./compensation.ts";
import { EquityError } from "./errors.ts";
import { days360, noteInterest, yearFraction } from "./interest.ts";
import { compareMfnTerms, mfnCandidates } from "./mfn.ts";
import { formatMoney, formatPrice, rational } from "./quantities.ts";
import {
  depositSlice,
  earlyExerciseSchedule,
  election83bStatus,
  measureRelease,
  releasedUnits,
  unreleasedDeposit,
} from "./restricted-stock.ts";
import type { EquityBook, SecurityEventRecord, SecurityRecord, ShareClassRecord } from "./types.ts";

const COMMON: ShareClassRecord = {
  id: "c-common",
  code: "CS",
  name: "Common",
  kind: "common",
  effectiveOn: "2026-01-01",
  initialAuthorizedShares: 20_000_000n,
  parValue: "0.0001",
  originalIssuePrice: null,
  initialConversionPrice: null,
  liquidationMultiple: null,
  participation: "none",
  participationCapMultiple: null,
  seniority: 0,
  antiDilution: "none",
  conversionShareClassId: null,
  conversionAdjustsForSplits: true,
  liquidationPreferenceBasis: "original_issue_price",
};
const SERIES_A: ShareClassRecord = {
  id: "c-a",
  code: "A",
  name: "Series A Preferred",
  kind: "preferred",
  effectiveOn: "2026-01-01",
  initialAuthorizedShares: 5_000_000n,
  parValue: "0.0001",
  originalIssuePrice: "1.0000000000",
  initialConversionPrice: "1.0000000000",
  liquidationMultiple: "1.0000",
  participation: "none",
  participationCapMultiple: null,
  seniority: 1,
  antiDilution: "none",
  conversionShareClassId: COMMON.id,
  conversionAdjustsForSplits: true,
  liquidationPreferenceBasis: "original_issue_price",
};

function security(
  overrides: Partial<SecurityRecord> & Pick<SecurityRecord, "id" | "kind">,
): SecurityRecord {
  return {
    securityNumber: overrides.id.toUpperCase(),
    holderPartyId: "holder",
    shareClassId: COMMON.id,
    planId: null,
    roundId: null,
    sourceSecurityId: null,
    issueDate: "2026-01-01",
    quantity: 1000n,
    pricePerShare: null,
    considerationAmount: null,
    currency: "USD",
    vestingStart: null,
    vestingMonths: null,
    cliffMonths: null,
    vestingFrequency: null,
    vestingTranches: null,
    acceleration: "none",
    accelerationPercent: null,
    expirationDate: null,
    optionType: null,
    earlyExercise: false,
    safeType: null,
    valuationCap: null,
    discountPercent: null,
    interestRatePercent: null,
    interestBasis: null,
    interestDayCount: null,
    maturityDate: null,
    fairValuePerUnit: null,
    expenseAttribution: null,
    mfn: false,
    unvestedRepurchaseBasis: null,
    fxRate: "1",
    ...overrides,
  };
}

function event(
  overrides: Partial<SecurityEventRecord> &
    Pick<SecurityEventRecord, "id" | "securityId" | "kind" | "effectiveOn">,
): SecurityEventRecord {
  return {
    quantity: null,
    pricePerShare: null,
    amount: null,
    resultingSecurityId: null,
    roundId: null,
    reversesEventId: null,
    ...overrides,
  };
}

function book(overrides: Partial<EquityBook> = {}): EquityBook {
  return {
    classes: [COMMON, SERIES_A],
    amendments: [],
    splits: [],
    plans: [],
    reserveChanges: [],
    rounds: [],
    securities: [],
    events: [],
    securityAmendments: [],
    ...overrides,
  };
}

const note = (overrides: Partial<SecurityRecord> = {}): SecurityRecord =>
  security({
    id: "n-1",
    kind: "note",
    shareClassId: null,
    quantity: null,
    considerationAmount: "100000.0000",
    issueDate: "2026-01-01",
    interestRatePercent: "8.0000",
    interestBasis: "simple",
    interestDayCount: "actual_365",
    ...overrides,
  });
const interest = (security: SecurityRecord, asOf: string) =>
  formatMoney(noteInterest(convertibleTerms(security), asOf));

test("day counts follow their conventions: actual over 365 or 360, the 30/360 bond basis and Actual/Actual ISDA", () => {
  assert.deepEqual(yearFraction("actual_365", "2026-01-01", "2026-07-01"), rational(181n, 365n));
  assert.deepEqual(yearFraction("actual_360", "2026-01-01", "2026-07-01"), rational(181n, 360n));
  assert.equal(days360("2026-01-31", "2026-03-31"), 60, "a 31st counts as the 30th on both ends");
  assert.equal(
    days360("2026-01-15", "2026-03-31"),
    76,
    "a closing 31st stays when the period opened before the 30th",
  );
  assert.deepEqual(yearFraction("thirty_360", "2026-01-01", "2026-07-01"), rational(1n, 2n));
  // 2027-07-01 to 2028-07-01 spans 184 days of 2027 and 182 days of the 2028 leap year.
  assert.deepEqual(
    yearFraction("actual_actual", "2027-07-01", "2028-07-01"),
    rational(184n * 366n + 182n * 365n, 365n * 366n),
  );
  assert.throws(
    () => yearFraction(null as never, "2026-01-01", "2026-02-01"),
    (error: unknown) => error instanceof EquityError && error.code === "equity_note_terms_missing",
  );
});

test("simple and compound notes accrue on their basis and compound only at completed periods", () => {
  assert.equal(interest(note(), "2026-07-01"), "3967.1233", "100,000 × 8% × 181/365");
  assert.equal(interest(note({ interestDayCount: "thirty_360" }), "2026-07-01"), "4000.0000");
  // Quarterly compounding: two full quarters at 2% each, then nothing for the part period.
  assert.equal(
    interest(
      note({ interestBasis: "compound_quarterly", interestDayCount: "thirty_360" }),
      "2026-07-01",
    ),
    "4040.0000",
  );
  // Annual compounding: one full year at 8%, then 8% × 181/365 on the compounded balance.
  assert.equal(interest(note({ interestBasis: "compound_annual" }), "2027-07-01"), "12284.4932");
  assert.equal(
    interest(
      note({ interestBasis: "compound_monthly", interestDayCount: "thirty_360" }),
      "2026-03-01",
    ),
    formatMoney(rational(100000n * 151n * 151n - 100000n * 150n * 150n, 150n * 150n)),
  );
  assert.equal(interest(note(), "2026-01-01"), "0.0000", "nothing accrues on the issue date");
});

test("an MFN comparison names each term a later instrument improves or concedes", () => {
  const current = {
    id: "s-mfn",
    kind: "safe" as const,
    issueDate: "2026-01-01",
    principal: "100000",
    safeType: "pre_money" as const,
    valuationCap: null,
    discountPercent: null,
    interestRatePercent: null,
    interestBasis: null,
    interestDayCount: null,
    currency: "USD",
  };
  assert.deepEqual(
    compareMfnTerms(current, {
      valuationCap: "8000000.0000",
      discountPercent: "20.0000",
      safeType: "post_money",
    }),
    { improves: ["cap", "discount", "post_money"], concedes: [] },
  );
  const capped = {
    ...current,
    valuationCap: "6000000.0000",
    discountPercent: "25.0000",
    safeType: "post_money" as const,
  };
  assert.deepEqual(
    compareMfnTerms(capped, {
      valuationCap: "5000000.0000",
      discountPercent: "20.0000",
      safeType: "pre_money",
    }),
    { improves: ["cap"], concedes: ["discount", "post_money"] },
  );
});

test("an MFN SAFE sees later instruments in its currency with better terms, until it stops being outstanding", () => {
  const mfn = security({
    id: "s-mfn",
    kind: "safe",
    shareClassId: null,
    quantity: null,
    considerationAmount: "100000.0000",
    safeType: "post_money",
    mfn: true,
  });
  const better = security({
    id: "s-later",
    kind: "safe",
    shareClassId: null,
    quantity: null,
    considerationAmount: "50000.0000",
    issueDate: "2026-03-01",
    safeType: "post_money",
    valuationCap: "4000000.0000",
  });
  const euro = security({
    id: "s-euro",
    kind: "safe",
    shareClassId: null,
    quantity: null,
    considerationAmount: "50000.0000",
    issueDate: "2026-03-01",
    safeType: "post_money",
    valuationCap: "3000000.0000",
    currency: "EUR",
  });
  const earlier = security({
    id: "s-earlier",
    kind: "note",
    shareClassId: null,
    quantity: null,
    considerationAmount: "50000.0000",
    issueDate: "2025-12-01",
    valuationCap: "2000000.0000",
    interestRatePercent: "5",
    interestBasis: "simple",
    interestDayCount: "actual_365",
  });
  const current = book({ securities: [earlier, mfn, better, euro] });
  assert.deepEqual(
    mfnCandidates(current, mfn, "2026-02-01").map((row) => row.sourceSecurityId),
    [],
    "nothing later is issued yet",
  );
  const candidates = mfnCandidates(current, mfn, "2026-03-15");
  assert.deepEqual(
    candidates.map((row) => row.sourceSecurityId),
    ["s-later"],
    "earlier and other-currency instruments are not candidates",
  );
  assert.deepEqual(candidates[0]!.improves, ["cap"]);
  const elected = book({
    securities: [earlier, mfn, better, euro],
    securityAmendments: [
      {
        id: "am-1",
        securityId: mfn.id,
        kind: "mfn_election",
        effectiveOn: "2026-03-20",
        sourceSecurityId: better.id,
        valuationCap: "4000000.0000",
        discountPercent: null,
        safeType: "post_money",
        reversesAmendmentId: null,
      },
    ],
  });
  assert.equal(
    convertibleState(elected, mfn, "2026-03-19").terms.valuationCap,
    null,
    "the election changes nothing before its date",
  );
  assert.equal(convertibleState(elected, mfn, "2026-03-20").terms.valuationCap, "4000000.0000");
  assert.deepEqual(
    mfnCandidates(elected, mfn, "2026-03-25"),
    [],
    "an adopted instrument is not offered again",
  );
  const converted = book({
    ...elected,
    events: [
      event({
        id: "e-1",
        securityId: mfn.id,
        kind: "convert",
        effectiveOn: "2026-04-01",
        resultingSecurityId: "s-cert",
      }),
    ],
  });
  assert.deepEqual(mfnCandidates(converted, mfn, "2026-04-02"), []);
});

test("an MFN SAFE carries an election only while it stands: a reversal returns the terms in force before it, and a voided source's terms never apply", () => {
  const mfn = security({
    id: "s-mfn",
    kind: "safe",
    shareClassId: null,
    quantity: null,
    considerationAmount: "100000.0000",
    safeType: "pre_money",
    mfn: true,
  });
  const later = security({
    id: "s-later",
    kind: "safe",
    shareClassId: null,
    quantity: null,
    considerationAmount: "50000.0000",
    issueDate: "2026-03-01",
    safeType: "post_money",
    valuationCap: "4000000.0000",
    discountPercent: "20.0000",
  });
  const election = {
    id: "am-1",
    securityId: mfn.id,
    kind: "mfn_election" as const,
    effectiveOn: "2026-03-20",
    sourceSecurityId: later.id,
    valuationCap: "4000000.0000",
    discountPercent: "20.0000",
    safeType: "post_money" as const,
    reversesAmendmentId: null,
  };
  const reversal = {
    ...election,
    id: "am-2",
    kind: "mfn_reversal" as const,
    effectiveOn: "2026-05-01",
    valuationCap: null,
    discountPercent: null,
    safeType: "pre_money" as const,
    reversesAmendmentId: election.id,
  };
  const reversed = book({ securities: [mfn, later], securityAmendments: [election, reversal] });
  assert.equal(
    convertibleState(reversed, mfn, "2026-04-30").terms.valuationCap,
    "4000000.0000",
    "the election stands until its reversal",
  );
  const after = convertibleState(reversed, mfn, "2026-05-01");
  assert.deepEqual(
    [after.terms.valuationCap, after.terms.discountPercent, after.terms.safeType, after.electionId],
    [null, null, "pre_money", null],
  );
  assert.deepEqual(
    mfnCandidates(reversed, mfn, "2026-05-02").map((row) => row.sourceSecurityId),
    [later.id],
    "a reversed election's source may be adopted again",
  );
  const voided = book({
    securities: [mfn, later],
    securityAmendments: [election],
    events: [
      event({ id: "e-void", securityId: later.id, kind: "void", effectiveOn: "2026-04-10" }),
    ],
  });
  assert.equal(
    convertibleState(voided, mfn, "2026-04-09").terms.valuationCap,
    null,
    "terms adopted from an instrument entered in error never apply",
  );
  assert.equal(convertibleState(voided, mfn, "2026-04-10").terms.valuationCap, null);
  assert.equal(
    electionInForce(voided, mfn, "2026-04-10", { includeVoidedSources: true })?.id,
    election.id,
    "the recorded election is still found for review",
  );
});

test("a conversion on terms adopted from a voided instrument is flagged whether the void is dated before or after it", () => {
  const mfn = security({
    id: "s-mfn",
    kind: "safe",
    shareClassId: null,
    quantity: null,
    considerationAmount: "100000.0000",
    safeType: "pre_money",
    mfn: true,
  });
  const later = security({
    id: "s-later",
    kind: "safe",
    shareClassId: null,
    quantity: null,
    considerationAmount: "50000.0000",
    issueDate: "2026-02-01",
    safeType: "post_money",
    valuationCap: "4000000.0000",
  });
  const election = {
    id: "am-1",
    securityId: mfn.id,
    kind: "mfn_election" as const,
    effectiveOn: "2026-02-10",
    sourceSecurityId: later.id,
    valuationCap: "4000000.0000",
    discountPercent: null,
    safeType: "post_money" as const,
    reversesAmendmentId: null,
  };
  const voidLater = event({
    id: "e-void",
    securityId: later.id,
    kind: "void",
    effectiveOn: "2026-02-27",
  });
  const convert = event({
    id: "e-convert",
    securityId: mfn.id,
    kind: "convert",
    effectiveOn: "2026-02-28",
    resultingSecurityId: "s-cert",
    roundId: "r-1",
  });

  // Recorded in this order: the source voided on February 27, then the SAFE converted on February 28 on its terms.
  const voidedFirst = book({
    securities: [mfn, later],
    securityAmendments: [election],
    events: [voidLater, convert],
  });
  assert.deepEqual(conversionOnVoidedTerms(voidedFirst, mfn, "2026-03-01"), {
    electionId: election.id,
    sourceSecurityId: later.id,
    sourceVoidedOn: "2026-02-27",
    resultingSecurityId: "s-cert",
  });
  assert.equal(
    conversionOnVoidedTerms(voidedFirst, mfn, "2026-02-26"),
    null,
    "nothing has converted on the as-of date",
  );

  const voidedAfter = book({
    securities: [mfn, later],
    securityAmendments: [election],
    events: [convert, { ...voidLater, effectiveOn: "2026-03-05" }],
  });
  assert.equal(
    conversionOnVoidedTerms(voidedAfter, mfn, "2026-03-04"),
    null,
    "the source still stands on the as-of date",
  );
  assert.equal(
    conversionOnVoidedTerms(voidedAfter, mfn, "2026-03-05")?.sourceVoidedOn,
    "2026-03-05",
  );

  // Reversing the election by the conversion date and converting again clears the flag.
  const reversal = {
    ...election,
    id: "am-2",
    kind: "mfn_reversal" as const,
    effectiveOn: "2026-02-28",
    valuationCap: null,
    safeType: "pre_money" as const,
    reversesAmendmentId: election.id,
  };
  const corrected = book({
    securities: [mfn, later],
    securityAmendments: [election, reversal],
    events: [
      voidLater,
      convert,
      event({ id: "e-void-cert", securityId: "s-cert", kind: "void", effectiveOn: "2026-02-28" }),
      { ...convert, id: "e-convert-2", resultingSecurityId: "s-cert-2" },
    ],
  });
  assert.equal(conversionOnVoidedTerms(corrected, mfn, "2026-03-01"), null);
  assert.equal(
    electionOnVoidedSource(corrected, mfn, "2026-02-28"),
    null,
    "a reversed election no longer holds a conversion back",
  );
  assert.equal(
    electionOnVoidedSource(voidedFirst, mfn, "2026-02-28")?.election.id,
    election.id,
    "an unreversed election naming a void instrument holds a conversion back",
  );

  // An election whose adopted terms equal the SAFE's own terms changes no conversion, so nothing is flagged.
  const same = book({
    securities: [mfn, later],
    securityAmendments: [{ ...election, valuationCap: null, safeType: "pre_money" }],
    events: [voidLater, convert],
  });
  assert.equal(conversionOnVoidedTerms(same, mfn, "2026-03-01"), null);
});

test("a stated 0% discount neither betters nor concedes against no discount", () => {
  const current = {
    id: "s-mfn",
    kind: "safe" as const,
    issueDate: "2026-01-01",
    principal: "100000",
    safeType: "pre_money" as const,
    valuationCap: null,
    discountPercent: null,
    interestRatePercent: null,
    interestBasis: null,
    interestDayCount: null,
    currency: "USD",
  };
  assert.deepEqual(
    compareMfnTerms(current, {
      valuationCap: null,
      discountPercent: "0.0000",
      safeType: "pre_money",
    }),
    { improves: [], concedes: [] },
  );
  assert.deepEqual(
    compareMfnTerms(
      { ...current, discountPercent: "0.0000" },
      { valuationCap: null, discountPercent: "10.0000", safeType: "pre_money" },
    ),
    { improves: ["discount"], concedes: [] },
  );
  assert.deepEqual(
    compareMfnTerms(
      { ...current, discountPercent: "15.0000" },
      { valuationCap: null, discountPercent: "0.0000", safeType: "pre_money" },
    ),
    { improves: [], concedes: ["discount"] },
  );
});

test("a common split adjusts the conversion price of preferred converting into it, from the split date only", () => {
  const split = {
    id: "sp-1",
    shareClassId: COMMON.id,
    effectiveOn: "2026-06-01",
    ratioNumerator: 2n,
    ratioDenominator: 1n,
  };
  const current = book({ splits: [split] });
  assert.equal(formatPrice(conversionPrice(current, SERIES_A, "2026-05-31")!), "1.0000000000");
  assert.equal(formatPrice(conversionPrice(current, SERIES_A, "2026-06-01")!), "0.5000000000");
  assert.equal(formatPrice(conversionRatio(current, SERIES_A, "2026-06-01")), "2.0000000000");
  const fixed = { ...SERIES_A, conversionAdjustsForSplits: false };
  assert.equal(
    formatPrice(
      conversionRatio(book({ classes: [COMMON, fixed], splits: [split] }), fixed, "2026-06-01"),
    ),
    "1.0000000000",
    "terms that do not adjust keep their ratio",
  );
  const preferredShares = security({
    id: "s-a",
    kind: "share",
    shareClassId: SERIES_A.id,
    quantity: 1000n,
  });
  const table = buildCapTable(
    book({ splits: [split], securities: [preferredShares] }),
    "2026-06-01",
  );
  assert.equal(
    table.classes.find((row) => row.shareClassId === SERIES_A.id)!.asConvertedOutstanding,
    "2000",
  );
  const otherCommon = { ...COMMON, id: "c-b", code: "CB" };
  const moved = book({
    classes: [COMMON, otherCommon, SERIES_A],
    splits: [split],
    amendments: [
      {
        id: "am",
        shareClassId: SERIES_A.id,
        kind: "conversion_class",
        effectiveOn: "2026-05-01",
        authorizedShares: null,
        conversionPrice: null,
        conversionShareClassId: otherCommon.id,
        reason: "Converts into class B",
      },
    ],
  });
  assert.equal(
    formatPrice(conversionRatio(moved, SERIES_A, "2026-06-01")),
    "1.0000000000",
    "a split of a class it no longer converts into does not adjust it",
  );
});

const option = security({
  id: "o-1",
  kind: "option",
  quantity: 4800n,
  pricePerShare: "1.0000000000",
  issueDate: "2026-01-01",
  earlyExercise: true,
  unvestedRepurchaseBasis: "lower_of_cost_or_fmv",
  vestingStart: "2026-01-01",
  vestingMonths: 48,
  cliffMonths: 0,
  vestingFrequency: "monthly",
  optionType: "nso",
  fairValuePerUnit: "0.5000000000",
  expenseAttribution: "straight_line",
});

test("an early exercise takes vested units first, then the earliest installments, and the option keeps the later ones", () => {
  const schedule = earlyExerciseSchedule(
    book({ securities: [option] }),
    option,
    1000n,
    "2026-03-01",
  )!;
  assert.equal(schedule.vestedOnIssue, 200n);
  assert.deepEqual(schedule.tranches.slice(0, 3), [
    { date: "2026-03-01", quantity: 200n },
    { date: "2026-04-01", quantity: 100n },
    { date: "2026-05-01", quantity: 100n },
  ]);
  assert.equal(
    schedule.tranches.reduce((sum, tranche) => sum + tranche.quantity, 0n),
    1000n,
  );
  assert.equal(schedule.tranches.at(-1)!.date, "2026-11-01");
  const exercised = book({
    securities: [option],
    events: [
      event({
        id: "e-ex",
        securityId: option.id,
        kind: "exercise",
        effectiveOn: "2026-03-01",
        quantity: 1000n,
        resultingSecurityId: "s-cert",
      }),
    ],
  });
  const after = holdingState(exercised, option, "2026-10-01");
  assert.equal(after.outstanding, 3800n);
  assert.equal(
    after.vestedAvailable,
    0n,
    "the option's own units vest only after the exercised ones",
  );
  assert.equal(holdingState(exercised, option, "2026-12-01").vestedAvailable, 100n);
  assert.equal(
    earlyExerciseSchedule(book({ securities: [option] }), option, 200n, "2026-03-01"),
    null,
    "an exercise within the vested units issues unrestricted shares",
  );
  const plain = { ...option, earlyExercise: false };
  assert.throws(
    () =>
      holdingState(
        book({
          securities: [plain],
          events: exercised.events.map((row) => ({ ...row, securityId: plain.id })),
        }),
        plain,
        "2026-12-31",
      ),
    (error: unknown) =>
      error instanceof EquityError && error.code === "equity_event_exceeds_holding",
    "without early exercise unvested units cannot be exercised",
  );
});

test("restricted shares release their deposit front to back and repurchases take it back to front", () => {
  const certificate = security({
    id: "s-cert",
    kind: "share",
    quantity: 1000n,
    pricePerShare: "1.0000000000",
    issueDate: "2026-03-01",
    sourceSecurityId: option.id,
    vestingTranches: earlyExerciseSchedule(
      book({ securities: [option] }),
      option,
      1000n,
      "2026-03-01",
    )!.tranches,
  });
  const exercise = event({
    id: "e-ex",
    securityId: option.id,
    kind: "exercise",
    effectiveOn: "2026-03-01",
    quantity: 1000n,
    resultingSecurityId: certificate.id,
  });
  const current = book({ securities: [option, certificate], events: [exercise] });
  assert.deepEqual(releasedUnits(current, certificate, "2026-05-15"), rational(200n));
  const release = measureRelease(current, certificate, option, COMMON, "2026-05-15", {
    certificate: 2,
    functional: 2,
  });
  assert.equal(release.deposit, 2_000_000n, "200 shares × 1.00");
  assert.equal(release.reclass, 1_000_000n, "200 units × 0.50 grant-date value");
  assert.equal(release.par, 200n, "200 × 0.0001 par");
  assert.equal(
    depositSlice(certificate, rational(0n), rational(800n), 2),
    8_000_000n,
    "the whole restricted portion carries the unvested cash",
  );
  const repurchased = book({
    ...current,
    events: [
      exercise,
      event({
        id: "e-rp",
        securityId: certificate.id,
        kind: "repurchase",
        effectiveOn: "2026-05-15",
        quantity: 600n,
      }),
    ],
  });
  assert.deepEqual(
    releasedUnits(repurchased, certificate, "2026-12-31"),
    rational(200n),
    "repurchased unvested shares never release",
  );
  // The option's cost loses the installments the repurchased shares would have vested on.
  const tranches = compensationTranches(repurchased, option, "2026-12-31");
  const live = tranches.reduce(
    (sum, tranche) => sum + Number(tranche.units.numerator / tranche.units.denominator),
    0,
  );
  assert.equal(live, 4200);
});

test("an early-exercised certificate's deposit on unvested shares follows its vesting as of each date", () => {
  // 288,000 options at 0.12, four-year monthly vesting with a one-year cliff, exercised in full before any vests.
  const grant = security({
    id: "o-maya",
    kind: "option",
    quantity: 288_000n,
    pricePerShare: "0.1200000000",
    issueDate: "2024-03-04",
    earlyExercise: true,
    unvestedRepurchaseBasis: "cost",
    vestingStart: "2024-03-04",
    vestingMonths: 48,
    cliffMonths: 12,
    vestingFrequency: "monthly",
    optionType: "iso",
  });
  const schedule = earlyExerciseSchedule(
    book({ securities: [grant] }),
    grant,
    288_000n,
    "2024-03-18",
  )!;
  assert.equal(schedule.vestedOnIssue, 0n);
  const certificate = security({
    id: "s-cs3",
    kind: "share",
    quantity: 288_000n,
    pricePerShare: "0.1200000000",
    issueDate: "2024-03-18",
    sourceSecurityId: grant.id,
    vestingTranches: schedule.tranches,
  });
  const exercised = book({
    securities: [grant, certificate],
    events: [
      event({
        id: "e-ex",
        securityId: grant.id,
        kind: "exercise",
        effectiveOn: "2024-03-18",
        quantity: 288_000n,
        resultingSecurityId: certificate.id,
      }),
    ],
  });
  assert.equal(
    unreleasedDeposit(exercised, certificate, "2024-06-27", 2),
    345_600_000n,
    "nothing has vested: the whole $34,560 is held",
  );
  assert.equal(
    unreleasedDeposit(exercised, certificate, "2026-10-19", 2),
    122_400_000n,
    "31 of 48 months vested: $12,240 on 102,000 unvested shares",
  );
  assert.equal(
    unreleasedDeposit(exercised, certificate, "2024-03-17", 2),
    0n,
    "nothing is held before the exercise",
  );
});

test("an 83(b) election is open for 30 days from issue, then recorded or missed", () => {
  const certificate = security({
    id: "s-rs",
    kind: "share",
    issueDate: "2026-03-01",
    vestingTranches: [
      { date: "2026-03-01", quantity: 400n },
      { date: "2027-03-01", quantity: 600n },
    ],
  });
  const current = book({ securities: [certificate] });
  assert.deepEqual(election83bStatus(current, certificate, "2026-03-11"), {
    state: "open",
    deadline: "2026-03-31",
    filedOn: null,
    daysLeft: 20,
  });
  assert.equal(election83bStatus(current, certificate, "2026-04-01")!.state, "missed");
  const filed = book({
    securities: [certificate],
    events: [
      event({
        id: "e-83b",
        securityId: certificate.id,
        kind: "election_83b",
        effectiveOn: "2026-03-20",
      }),
    ],
  });
  assert.equal(election83bStatus(filed, certificate, "2026-05-01")!.state, "filed");
  const reversed = book({
    ...filed,
    events: [
      ...filed.events,
      event({
        id: "e-rev",
        securityId: certificate.id,
        kind: "reverse",
        effectiveOn: "2026-03-22",
        reversesEventId: "e-83b",
      }),
    ],
  });
  assert.equal(
    election83bStatus(reversed, certificate, "2026-03-25")!.state,
    "open",
    "a reversed election no longer counts",
  );
  assert.equal(
    election83bStatus(current, security({ id: "s-plain", kind: "share" }), "2026-03-11"),
    null,
    "fully vested shares need no election",
  );
});

test("a reversal undoes one event from its date and leaves earlier history as it stood", () => {
  const award = security({
    id: "o-2",
    kind: "option",
    quantity: 1000n,
    vestingStart: "2026-01-01",
    vestingMonths: 10,
    cliffMonths: 0,
    vestingFrequency: "monthly",
    pricePerShare: "1",
  });
  const forfeit = event({
    id: "e-f",
    securityId: award.id,
    kind: "forfeit",
    effectiveOn: "2026-02-01",
    quantity: 500n,
  });
  const reversal = event({
    id: "e-r",
    securityId: award.id,
    kind: "reverse",
    effectiveOn: "2026-02-10",
    reversesEventId: forfeit.id,
  });
  const current = book({ securities: [award], events: [forfeit, reversal] });
  assert.equal(holdingState(current, award, "2026-02-09").outstanding, 500n);
  assert.equal(holdingState(current, award, "2026-02-10").outstanding, 1000n);
  assert.deepEqual(
    eventsOf(current, award.id, "2026-12-31"),
    [],
    "neither the reversed event nor the reversal changes the holding",
  );
});
