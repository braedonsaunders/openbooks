import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDerivedRule,
  computeDerivedEarnings,
  derivedEntryWindow,
  settlementMonth,
  type DerivedComponent,
  type DerivedEarningsInput,
  type DerivedEmployeeScope,
  type DerivedRule,
  type DerivedTimeEntry,
} from "./payroll-derived-earnings.ts";
import { sum } from "./money.ts";

/**
 * Hand-worked cases for the five earnings a construction payroll derives from
 * operational facts, plus the edges that make each one wrong when it is done by
 * hand: the traveller who hits two jobs in a day, the quiet day, the excluded
 * project manager, and the percentage that has to split across jobs without
 * losing a penny.
 */

const PER_DIEM = "11111111-1111-1111-1111-111111111111";
const ON_CALL = "22222222-2222-2222-2222-222222222222";
const TRAVEL = "33333333-3333-3333-3333-333333333333";
const INCENTIVE = "44444444-4444-4444-4444-444444444444";
const EQUIPMENT = "55555555-5555-5555-5555-555555555555";

const TT_ON_CALL = "aaaaaaa1-0000-0000-0000-000000000001";
const TT_TRAVEL = "aaaaaaa1-0000-0000-0000-000000000002";
const TT_REGULAR = "aaaaaaa1-0000-0000-0000-000000000003";
const TT_EQUIPMENT = "aaaaaaa1-0000-0000-0000-000000000004";

const JOB_A = "bbbbbbb1-0000-0000-0000-00000000000a";
const JOB_B = "bbbbbbb1-0000-0000-0000-00000000000b";
const DEPT_FIELD = "ccccccc1-0000-0000-0000-00000000000f";

function component(id: string, name: string, value: string | null = null): DerivedComponent {
  return {
    id, name, value,
    taxable: true, pensionable: true, insurable: true, vacationable: true, nonPeriodic: false,
  };
}

const COMPONENTS = new Map<string, DerivedComponent>([
  [PER_DIEM, component(PER_DIEM, "Per diem")],
  [ON_CALL, component(ON_CALL, "On-call")],
  [TRAVEL, component(TRAVEL, "Travel pay")],
  [INCENTIVE, component(INCENTIVE, "Site incentive", "2.00")],
  [EQUIPMENT, component(EQUIPMENT, "Equipment incentive")],
]);

function rule(overrides: Partial<DerivedRule> & Pick<DerivedRule, "code" | "componentId">): DerivedRule {
  return {
    id: `rule-${overrides.code}`,
    name: overrides.code,
    trigger: "distinct_day",
    timeTypeId: null,
    projectId: null,
    departmentId: null,
    tradeId: null,
    jobTitle: null,
    billableOnly: false,
    includedJobTitles: [],
    excludedJobTitles: [],
    quantityMode: "count",
    rateMode: "fixed_per_unit",
    rateValue: "0",
    costingMode: "source",
    sequence: 50,
    ...overrides,
  };
}

let entrySequence = 0;
function entry(
  workedOn: string,
  overrides: Partial<DerivedTimeEntry> = {},
): DerivedTimeEntry {
  entrySequence += 1;
  return {
    id: `entry-${String(entrySequence).padStart(3, "0")}`,
    workedOn,
    hours: "8",
    timeTypeId: TT_REGULAR,
    projectId: JOB_A,
    departmentId: DEPT_FIELD,
    isBillable: true,
    createdAt: `2026-03-01T00:00:${String(entrySequence % 60).padStart(2, "0")}Z`,
    ...overrides,
  };
}

const CREW: DerivedEmployeeScope = { jobTitle: "Journeyman", tradeId: null, departmentId: DEPT_FIELD };

function input(overrides: Partial<DerivedEarningsInput>): DerivedEarningsInput {
  return {
    rules: [],
    components: COMPONENTS,
    employee: CREW,
    entries: [],
    periodStart: "2026-03-02",
    periodEnd: "2026-03-15",
    gross: "0",
    ...overrides,
  };
}

// --- 1. Per diem: $70 a night, only for nights actually stayed --------------

test("per diem pays $70 for the nights between consecutive jobsite days", () => {
  // Mon 2nd through Fri 6th on site, home for the weekend, back Mon 9th.
  // Nights stayed = Mon/Tue, Tue/Wed, Wed/Thu, Thu/Fri = 4. The Sun/Mon night
  // before the 9th was not stayed (no time on Sunday), and the Fri/Sat night
  // was not either — he drove home.
  const days = ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-09"];
  const perDiem = rule({
    code: "PERDIEM", name: "Per diem", componentId: PER_DIEM,
    trigger: "night_stayed", quantityMode: "count_nights", rateValue: "70",
  });

  const lines = computeDerivedEarnings(input({
    rules: [perDiem],
    entries: days.map((day) => entry(day)),
  }));

  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.amount, "280.0000");
  assert.equal(lines[0]!.projectId, JOB_A);
  assert.equal(lines[0]!.description, "Per diem (4 × 70.00)");
  assert.equal(lines[0]!.componentId, PER_DIEM);
  assert.equal(lines[0]!.kind, "earning");
});

test("a stay that began in the previous period pays its first night once", () => {
  // Sunday the 1st belongs to the previous period; the Sun/Mon night is
  // credited to Monday the 2nd, which is this period's first day.
  const perDiem = rule({
    code: "PERDIEM", name: "Per diem", componentId: PER_DIEM,
    trigger: "night_stayed", quantityMode: "count_nights", rateValue: "70",
  });
  const entries = ["2026-03-01", "2026-03-02", "2026-03-03"].map((day) => entry(day));

  const { units, lines } = applyDerivedRule(perDiem, input({ rules: [perDiem], entries }));

  assert.deepEqual(units.map((unit) => unit.day), ["2026-03-02", "2026-03-03"]);
  assert.equal(lines[0]!.amount, "140.0000");
});

// --- 2. On-call: $75 a day, asserted by a supervisor on the timesheet -------

test("on-call pays $75 for each day carrying the flagged time type", () => {
  const onCall = rule({
    code: "ONCALL", name: "On-call", componentId: ON_CALL,
    trigger: "distinct_day", timeTypeId: TT_ON_CALL, rateValue: "75",
    costingMode: "none",
  });

  const lines = computeDerivedEarnings(input({
    rules: [onCall],
    entries: [
      entry("2026-03-02"),
      entry("2026-03-02", { timeTypeId: TT_ON_CALL, hours: "0", projectId: null }),
      entry("2026-03-03", { timeTypeId: TT_ON_CALL, hours: "0", projectId: null }),
      // Two on-call rows on one day are still one on-call day.
      entry("2026-03-03", { timeTypeId: TT_ON_CALL, hours: "0", projectId: null }),
      entry("2026-03-04"),
    ],
  }));

  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.amount, "150.0000");
  assert.equal(lines[0]!.projectId, null);
  assert.equal(lines[0]!.description, "On-call (2 × 75.00)");
});

// --- 3. Travel pay: costed to the job he went to FIRST that day -------------

test("travel pay costs to the first job of the day, not the travel row's job", () => {
  const travel = rule({
    code: "TRAVEL", name: "Travel pay", componentId: TRAVEL,
    trigger: "distinct_day", timeTypeId: TT_TRAVEL, rateValue: "45",
    costingMode: "first_project_of_day",
  });

  // He starts on Job A, moves to Job B after lunch, and books travel last —
  // against Job B, because that is where he was standing when he filled the
  // sheet in. The travel belongs to Job A.
  const entries = [
    entry("2026-03-03", { projectId: JOB_A, createdAt: "2026-03-03T08:00:00Z" }),
    entry("2026-03-03", { projectId: JOB_B, createdAt: "2026-03-03T13:00:00Z" }),
    entry("2026-03-03", {
      projectId: JOB_B, timeTypeId: TT_TRAVEL, hours: "1", createdAt: "2026-03-03T17:00:00Z",
    }),
  ];

  const lines = computeDerivedEarnings(input({ rules: [travel], entries }));

  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.amount, "45.0000");
  assert.equal(lines[0]!.projectId, JOB_A);
});

test("a day with no qualifying time pays nothing", () => {
  const travel = rule({
    code: "TRAVEL", name: "Travel pay", componentId: TRAVEL,
    trigger: "distinct_day", timeTypeId: TT_TRAVEL, rateValue: "45",
    costingMode: "first_project_of_day",
  });

  const lines = computeDerivedEarnings(input({
    rules: [travel],
    entries: [entry("2026-03-03"), entry("2026-03-04")],
  }));

  assert.deepEqual(lines, []);
});

// --- 4. Site incentive: paid on field time, never to the excluded titles ----

const SITE_INCENTIVE_EXCLUSIONS = [
  "Project Manager", "General Manager", "Department Manager", "Health & Safety",
];

test("site incentive pays $2 per billable onsite hour", () => {
  // The crew rule. It is a separate row from the supervisory one below not
  // because of who is paid — an inclusion list settles that — but because the
  // crew qualifies on BILLABLE time while supervisors qualify on any time
  // charged to a job. That is a difference of condition, not of population.
  const incentive = rule({
    code: "SITE", name: "Site incentive", componentId: INCENTIVE,
    trigger: "distinct_project_day", quantityMode: "sum_hours",
    billableOnly: true, rateMode: "rate_card",
    excludedJobTitles: SITE_INCENTIVE_EXCLUSIONS,
  });

  const lines = computeDerivedEarnings(input({
    rules: [incentive],
    entries: [
      entry("2026-03-02", { hours: "9.5" }),
      entry("2026-03-03", { hours: "10" }),
      // Shop time is not billable — it earns no site incentive.
      entry("2026-03-04", { hours: "8", isBillable: false }),
      entry("2026-03-05", { hours: "8", projectId: JOB_B }),
    ],
  }));

  // Job A: (9.5 + 10) h × $2 = $39.00. Job B: 8 h × $2 = $16.00.
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.projectId, JOB_A);
  assert.equal(lines[0]!.amount, "39.0000");
  assert.equal(lines[0]!.description, "Site incentive (19.5 h × 2.00)");
  assert.equal(lines[1]!.projectId, JOB_B);
  assert.equal(lines[1]!.amount, "16.0000");
});

test("the excluded job title is the whole rule — the PM earns nothing", () => {
  const incentive = rule({
    code: "SITE", name: "Site incentive", componentId: INCENTIVE,
    trigger: "distinct_project_day", quantityMode: "sum_hours",
    billableOnly: true, rateMode: "rate_card",
    excludedJobTitles: SITE_INCENTIVE_EXCLUSIONS,
  });
  const entries = [entry("2026-03-02", { hours: "9.5" }), entry("2026-03-03", { hours: "10" })];

  // Free-text titles: spacing and case must not decide who gets paid.
  for (const jobTitle of ["Project Manager", " project  manager ", "HEALTH & SAFETY"]) {
    const lines = computeDerivedEarnings(input({
      rules: [incentive], entries,
      employee: { jobTitle, tradeId: null, departmentId: DEPT_FIELD },
    }));
    assert.deepEqual(lines, [], `${jobTitle} must not earn the site incentive`);
  }
});

test("one supervisory row covers supervisors and the quality coordinator", () => {
  // The whole supervisory POPULATION is one row: same component, looser test
  // (no billable filter), narrowed by an inclusion list. Two rows named by
  // title would make the reader reassemble the policy from the parts.
  const supervisory = rule({
    code: "SITE-SUP", name: "Site incentive", componentId: INCENTIVE,
    trigger: "distinct_project_day", quantityMode: "sum_hours",
    billableOnly: false, rateMode: "rate_card",
    includedJobTitles: ["Supervisor", "Quality Coordinator"],
    excludedJobTitles: SITE_INCENTIVE_EXCLUSIONS,
  });

  const entries = [
    entry("2026-03-02", { hours: "9.5", isBillable: false }),
    // Time with no job is not job time; the incentive is for time charged to a job.
    entry("2026-03-03", { hours: "4", projectId: null, isBillable: false }),
  ];
  const paid = (jobTitle: string) => computeDerivedEarnings(input({
    rules: [supervisory], entries,
    employee: { jobTitle, tradeId: null, departmentId: DEPT_FIELD },
  }));

  // 9.5 h on Job A plus 4 h untagged, both at $2 — the untagged day pays but
  // is not job costed.
  for (const jobTitle of ["Supervisor", "quality  coordinator"]) {
    const lines = paid(jobTitle);
    assert.equal(lines.length, 2, jobTitle);
    assert.equal(sum(lines.map((line) => line.amount)), "27.0000", jobTitle);
    assert.equal(lines.find((line) => line.projectId === JOB_A)!.amount, "19.0000");
    assert.equal(lines.find((line) => line.projectId === null)!.amount, "8.0000");
  }
  assert.deepEqual(paid("Journeyman"), [], "an inclusion list narrows the rule to those titles");
});

test("exclusions win over inclusions", () => {
  // A title in both lists is excluded. Not paying is the safe failure for a
  // money rule, and a reviewer should never have to guess the precedence.
  const contested = rule({
    code: "SITE-SUP", name: "Site incentive", componentId: INCENTIVE,
    trigger: "distinct_project_day", quantityMode: "sum_hours", rateMode: "rate_card",
    includedJobTitles: ["Supervisor", "Project Manager"],
    excludedJobTitles: ["Project Manager"],
  });
  const entries = [entry("2026-03-02", { hours: "8" })];

  assert.equal(computeDerivedEarnings(input({
    rules: [contested], entries,
    employee: { jobTitle: "Supervisor", tradeId: null, departmentId: DEPT_FIELD },
  })).length, 1);
  assert.deepEqual(computeDerivedEarnings(input({
    rules: [contested], entries,
    employee: { jobTitle: "Project Manager", tradeId: null, departmentId: DEPT_FIELD },
  })), []);
});

test("the single jobTitle filter still handles the one-title case", () => {
  const clerkOnly = rule({
    code: "SITECLERK", name: "Site clerk allowance", componentId: INCENTIVE,
    trigger: "distinct_day", rateMode: "fixed_per_unit", rateValue: "25",
    jobTitle: "Site Clerk",
  });
  const entries = [entry("2026-03-02")];

  assert.equal(computeDerivedEarnings(input({
    rules: [clerkOnly], entries,
    employee: { jobTitle: " site clerk ", tradeId: null, departmentId: DEPT_FIELD },
  }))[0]!.amount, "25.0000");
  assert.deepEqual(computeDerivedEarnings(input({ rules: [clerkOnly], entries })), []);
});

test("an empty inclusion list means everyone", () => {
  const crew = rule({
    code: "SITE", name: "Site incentive", componentId: INCENTIVE,
    trigger: "distinct_project_day", quantityMode: "sum_hours", rateMode: "rate_card",
    includedJobTitles: [],
  });
  const entries = [entry("2026-03-02", { hours: "8" })];

  for (const jobTitle of ["Journeyman", "Apprentice", "Supervisor"]) {
    assert.equal(computeDerivedEarnings(input({
      rules: [crew], entries,
      employee: { jobTitle, tradeId: null, departmentId: DEPT_FIELD },
    })).length, 1, jobTitle);
  }
});

// --- 5. Equipment incentive: computed monthly, paid after month end ---------

test("the equipment incentive settles the month the period closes", () => {
  const equipment = rule({
    code: "EQUIP", name: "Equipment incentive", componentId: EQUIPMENT,
    trigger: "month_end", timeTypeId: TT_EQUIPMENT, quantityMode: "sum_hours",
    rateValue: "1.25",
  });

  // The biweekly period 2026-03-30 → 2026-04-12 covers 31 March, so it settles
  // all of March — including the hours already paid as wages in earlier runs.
  const march = ["2026-03-04", "2026-03-18", "2026-03-31"].map((day) =>
    entry(day, { timeTypeId: TT_EQUIPMENT, hours: "6" }));
  const april = [entry("2026-04-02", { timeTypeId: TT_EQUIPMENT, hours: "6" })];

  const lines = computeDerivedEarnings(input({
    rules: [equipment],
    entries: [...march, ...april],
    periodStart: "2026-03-30",
    periodEnd: "2026-04-12",
  }));

  // 18 equipment hours in March × $1.25 = $22.50. April is not settled yet.
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.amount, "22.5000");

  // The next period covers no month end, so March is never paid twice.
  const nextPeriod = computeDerivedEarnings(input({
    rules: [equipment],
    entries: [...march, ...april],
    periodStart: "2026-04-13",
    periodEnd: "2026-04-26",
  }));
  assert.deepEqual(nextPeriod, []);
});

test("settlementMonth names the month a period closes, and only that month", () => {
  assert.deepEqual(settlementMonth("2026-03-30", "2026-04-12"), {
    start: "2026-03-01", end: "2026-03-31",
  });
  assert.deepEqual(settlementMonth("2026-06-01", "2026-06-30"), {
    start: "2026-06-01", end: "2026-06-30",
  });
  assert.equal(settlementMonth("2026-04-13", "2026-04-26"), null);
  assert.deepEqual(settlementMonth("2026-02-22", "2026-03-07"), {
    start: "2026-02-01", end: "2026-02-28",
  });
});

test("the read window widens for lookbacks, and only for them", () => {
  const nightly = rule({
    code: "PERDIEM", componentId: PER_DIEM, trigger: "night_stayed",
    quantityMode: "count_nights", rateValue: "70",
  });
  const monthly = rule({ code: "EQUIP", componentId: EQUIPMENT, trigger: "month_end" });
  const daily = rule({ code: "ONCALL", componentId: ON_CALL });

  assert.deepEqual(derivedEntryWindow([daily], "2026-03-30", "2026-04-12"), {
    from: "2026-03-30", to: "2026-04-12",
  });
  assert.deepEqual(derivedEntryWindow([nightly], "2026-03-30", "2026-04-12"), {
    from: "2026-03-29", to: "2026-04-12",
  });
  assert.deepEqual(derivedEntryWindow([nightly, monthly], "2026-03-30", "2026-04-12"), {
    from: "2026-03-01", to: "2026-04-12",
  });
});

// --- Penny exactness --------------------------------------------------------

test("a percent-of-gross rule splits across jobs without losing a penny", () => {
  const bonus = rule({
    code: "FIELDPCT", name: "Field bonus", componentId: INCENTIVE,
    trigger: "distinct_project_day", quantityMode: "sum_hours",
    rateMode: "percent_of_gross", rateValue: "5",
  });

  // $1,000.03 of gross split three ways by hours that do not divide evenly:
  // 5% is $50.00, and 1/3 of that is $16.6666… on every job.
  const lines = computeDerivedEarnings(input({
    rules: [bonus],
    gross: "1000.03",
    entries: [
      entry("2026-03-02", { hours: "5", projectId: JOB_A }),
      entry("2026-03-03", { hours: "5", projectId: JOB_B }),
      entry("2026-03-04", { hours: "5", projectId: null }),
    ],
  }));

  assert.equal(lines.length, 3);
  assert.equal(sum(lines.map((line) => line.amount)), "50.0000");
  assert.deepEqual(lines.map((line) => line.amount), ["16.6700", "16.6700", "16.6600"]);
  assert.equal(lines[0]!.rate, null);
  assert.equal(lines[0]!.description, "Field bonus (5% of gross)");
});

test("derived lines carry no hours, so per-hour components are not paid twice", () => {
  const incentive = rule({
    code: "SITE", name: "Site incentive", componentId: INCENTIVE,
    trigger: "distinct_project_day", quantityMode: "sum_hours", rateMode: "rate_card",
  });

  const lines = computeDerivedEarnings(input({
    rules: [incentive],
    entries: [entry("2026-03-02", { hours: "8" })],
  }));

  assert.equal(lines.length, 1);
  assert.equal(Object.hasOwn(lines[0]!, "hours"), false);
  assert.equal(lines[0]!.rate, "2.0000");
});

test("rules emit in sequence order so later components compute on them", () => {
  const perDiem = rule({
    code: "PERDIEM", name: "Per diem", componentId: PER_DIEM,
    trigger: "distinct_day", timeTypeId: TT_ON_CALL, rateValue: "70", sequence: 60,
  });
  const travel = rule({
    code: "TRAVEL", name: "Travel pay", componentId: TRAVEL,
    trigger: "distinct_day", timeTypeId: TT_TRAVEL, rateValue: "45", sequence: 41,
  });

  const lines = computeDerivedEarnings(input({
    rules: [perDiem, travel],
    entries: [
      entry("2026-03-02", { timeTypeId: TT_TRAVEL }),
      entry("2026-03-02", { timeTypeId: TT_ON_CALL }),
    ],
  }));

  assert.deepEqual(lines.map((line) => line.ruleCode), ["TRAVEL", "PERDIEM"]);
  assert.deepEqual(lines.map((line) => line.sequence), [41, 60]);
});
