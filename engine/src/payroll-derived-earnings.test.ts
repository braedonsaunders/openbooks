import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  applyDerivedRule,
  computeDerivedEarnings,
  derivedChargeWindow,
  derivedEntryWindow,
  DerivedCoverageError,
  DerivedEarningsError,
  loadActiveDerivedRules,
  settlementMonth,
  type DerivedComponent,
  type DerivedEarningsInput,
  type DerivedEmployeeScope,
  type DerivedEquipmentCharge,
  type DerivedRule,
  type DerivedTimeEntry,
} from "./payroll-derived-earnings.ts";
import { sum } from "./money.ts";
import { db } from "./db.ts";
import { createScratchOrg, dropScratchOrgReporting } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

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
    equipmentUnitId: null,
    itemId: null,
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

test("travel pay prefers the recorded clock time over the capture order", () => {
  const travel = rule({
    code: "TRAVEL", name: "Travel pay", componentId: TRAVEL,
    trigger: "distinct_day", timeTypeId: TT_TRAVEL, rateValue: "45",
    costingMode: "first_project_of_day",
  });

  // The case capture order gets WRONG. The field app uploaded the day in the
  // order it happened to sync — Job B's afternoon row first — so `created_at`
  // says Job B was first. The clock times say otherwise, and they are what the
  // employee actually did: he was on Job A at 07:00.
  const entries = [
    entry("2026-03-03", {
      projectId: JOB_B, startedAt: "2026-03-03T13:00:00Z", createdAt: "2026-03-03T20:00:00Z",
    }),
    entry("2026-03-03", {
      projectId: JOB_A, startedAt: "2026-03-03T07:00:00Z", createdAt: "2026-03-03T20:00:05Z",
    }),
    entry("2026-03-03", {
      projectId: JOB_B, timeTypeId: TT_TRAVEL, hours: "1",
      startedAt: "2026-03-03T17:00:00Z", createdAt: "2026-03-03T20:00:10Z",
    }),
  ];

  const lines = computeDerivedEarnings(input({ rules: [travel], entries }));

  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.amount, "45.0000");
  assert.equal(lines[0]!.projectId, JOB_A, "the 07:00 job, not the first row captured");
});

test("with no clock time at all, travel pay still falls back to capture order", () => {
  // Every row written before time_entries.started_at existed, and every surface
  // that still collects no clock time. The fallback must keep working exactly
  // as it did, or a historical recalculation would move.
  const travel = rule({
    code: "TRAVEL", name: "Travel pay", componentId: TRAVEL,
    trigger: "distinct_day", timeTypeId: TT_TRAVEL, rateValue: "45",
    costingMode: "first_project_of_day",
  });

  const entries = [
    entry("2026-03-03", { projectId: JOB_B, startedAt: null, createdAt: "2026-03-03T13:00:00Z" }),
    entry("2026-03-03", { projectId: JOB_A, startedAt: null, createdAt: "2026-03-03T08:00:00Z" }),
    entry("2026-03-03", {
      projectId: JOB_B, timeTypeId: TT_TRAVEL, hours: "1",
      startedAt: null, createdAt: "2026-03-03T17:00:00Z",
    }),
  ];

  assert.equal(
    computeDerivedEarnings(input({ rules: [travel], entries }))[0]!.projectId,
    JOB_A,
    "the earliest captured job",
  );
});

test("a known clock time outranks the capture order of a row that has none", () => {
  // A part-migrated day: the crew's morning row came off a clock-in app, the
  // afternoon row was keyed in later with no time. A null start is not
  // midnight — it is unknown — so it must not be allowed to claim "first".
  const travel = rule({
    code: "TRAVEL", name: "Travel pay", componentId: TRAVEL,
    trigger: "distinct_day", timeTypeId: TT_TRAVEL, rateValue: "45",
    costingMode: "first_project_of_day",
  });

  const entries = [
    // Captured FIRST, but asserts no clock time.
    entry("2026-03-03", { projectId: JOB_B, startedAt: null, createdAt: "2026-03-03T09:00:00Z" }),
    // Captured second, and says it began at 06:30.
    entry("2026-03-03", {
      projectId: JOB_A, startedAt: "2026-03-03T06:30:00Z", createdAt: "2026-03-03T18:00:00Z",
    }),
    entry("2026-03-03", {
      projectId: JOB_B, timeTypeId: TT_TRAVEL, hours: "1",
      startedAt: null, createdAt: "2026-03-03T19:00:00Z",
    }),
  ];

  assert.equal(
    computeDerivedEarnings(input({ rules: [travel], entries }))[0]!.projectId,
    JOB_A,
  );
});

test("the per-diem night is costed to the clock-time first job of the earlier day", () => {
  // Same ordering question, second consumer: the job the employee SLEPT at is
  // the earlier day's first job, so the clock time governs it too.
  const perDiem = rule({
    code: "PERDIEM", name: "Per diem", componentId: PER_DIEM,
    trigger: "night_stayed", quantityMode: "count_nights", rateValue: "70",
  });

  const lines = computeDerivedEarnings(input({
    rules: [perDiem],
    entries: [
      entry("2026-03-02", {
        projectId: JOB_B, startedAt: "2026-03-02T15:00:00Z", createdAt: "2026-03-02T15:00:00Z",
      }),
      entry("2026-03-02", {
        projectId: JOB_A, startedAt: "2026-03-02T06:00:00Z", createdAt: "2026-03-02T20:00:00Z",
      }),
      entry("2026-03-03", { projectId: JOB_A }),
    ],
  }));

  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.amount, "70.0000");
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

// --- 6. Equipment incentive: the SECOND fact source (project_charge lines) ---
//
// The customer's real policy is a share of what the machine BILLED, which the
// timesheet cannot express: an operator can run an excavator twelve hours on
// Monday at one rate and twelve on Tuesday at another, and the money he is owed
// differs even though the hours are identical. These cases work that through,
// including the one that matters most — what happens when nobody wrote down who
// was driving.

const OPERATOR = "eeeeeee1-0000-0000-0000-00000000000a";
const OTHER_OPERATOR = "eeeeeee1-0000-0000-0000-00000000000b";
const EXCAVATOR = "ddddddd1-0000-0000-0000-00000000000e";
const LOADER = "ddddddd1-0000-0000-0000-00000000000f";
const ITEM_EXCAVATOR_HOURS = "fffffff1-0000-0000-0000-000000000001";
const ITEM_LOADER_HOURS = "fffffff1-0000-0000-0000-000000000002";

let chargeSequence = 0;
function charge(
  day: string,
  overrides: Partial<DerivedEquipmentCharge> = {},
): DerivedEquipmentCharge {
  chargeSequence += 1;
  return {
    id: `charge-${String(chargeSequence).padStart(3, "0")}`,
    day,
    employeePartyId: OPERATOR,
    equipmentUnitId: EXCAVATOR,
    itemId: ITEM_EXCAVATOR_HOURS,
    projectId: JOB_A,
    departmentId: DEPT_FIELD,
    isBillable: true,
    baseQuantity: "8",
    billAmount: "1000.00",
    ...overrides,
  };
}

/** The operator, as the engine sees him: scope plus the party id charge lines
 *  point at. */
const DRIVER: DerivedEmployeeScope = {
  jobTitle: "Operator", tradeId: null, departmentId: DEPT_FIELD, partyId: OPERATOR,
};

function equipmentRule(overrides: Partial<DerivedRule> = {}): DerivedRule {
  return rule({
    code: "EQUIP-INC", name: "Equipment incentive", componentId: EQUIPMENT,
    trigger: "equipment_charge", quantityMode: "sum_bill_amount",
    rateMode: "percent_of_quantity", rateValue: "3", costingMode: "source",
    includedJobTitles: ["Operator"], sequence: 55,
    ...overrides,
  });
}

/** A settling period: 2026-03-30 → 2026-04-12 covers 31 March, so it settles
 *  March. Reused so every case below tests the SAME window the pay run uses. */
const SETTLES_MARCH = { periodStart: "2026-03-30", periodEnd: "2026-04-12" };

test("the equipment incentive pays a percent of what the unit billed", () => {
  // Three March charges on one job: 3% of $3,600.00 = $108.00. This is the
  // policy the customer runs off a hand-adjusted spreadsheet today.
  const lines = computeDerivedEarnings(input({
    ...SETTLES_MARCH,
    employee: DRIVER,
    rules: [equipmentRule()],
    charges: [
      charge("2026-03-04", { billAmount: "1200.00" }),
      charge("2026-03-18", { billAmount: "1500.00" }),
      charge("2026-03-31", { billAmount: "900.00" }),
    ],
  }));

  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.amount, "108.0000");
  assert.equal(lines[0]!.projectId, JOB_A);
  assert.equal(lines[0]!.componentId, EQUIPMENT);
  // The BASIS is named on the stub: "3% of gross" and "3% of what the machine
  // billed" are the two numbers this rule set must never let anyone confuse.
  assert.equal(lines[0]!.description, "Equipment incentive (3% of 3600.00 billed)");
  // A percentage is not a per-unit money rate, and a rate column would render
  // it as dollars.
  assert.equal(lines[0]!.rate, null);
});

test("the incentive settles once, on the first run after month end", () => {
  const charges = [
    charge("2026-03-10", { billAmount: "2000.00" }),
    // April is not settled by a period that closes March.
    charge("2026-04-02", { billAmount: "5000.00" }),
  ];

  const settling = computeDerivedEarnings(input({
    ...SETTLES_MARCH, employee: DRIVER, rules: [equipmentRule()], charges,
  }));
  assert.equal(settling.length, 1);
  assert.equal(settling[0]!.amount, "60.0000"); // 3% of 2,000.00 — March only.

  // The next period covers no month end, so March is never paid twice.
  const nextPeriod = computeDerivedEarnings(input({
    periodStart: "2026-04-13", periodEnd: "2026-04-26",
    employee: DRIVER, rules: [equipmentRule()], charges,
  }));
  assert.deepEqual(nextPeriod, []);
});

test("sum_quantity pays per unit produced, sum_bill_amount pays on revenue", () => {
  // The same two charges, the same operator, two different policies — and they
  // must produce different money, or the quantity mode means nothing. 20 hours
  // at $1.25 is $25.00; 3% of $4,000.00 is $120.00.
  const charges = [
    charge("2026-03-05", { baseQuantity: "12", billAmount: "2500.00" }),
    charge("2026-03-06", { baseQuantity: "8", billAmount: "1500.00" }),
  ];

  const perHour = computeDerivedEarnings(input({
    ...SETTLES_MARCH, employee: DRIVER, charges,
    rules: [equipmentRule({
      quantityMode: "sum_quantity", rateMode: "fixed_per_unit", rateValue: "1.25",
    })],
  }));
  assert.equal(perHour[0]!.amount, "25.0000");
  assert.equal(perHour[0]!.description, "Equipment incentive (20 × 1.25)");
  // A fixed per-unit rate IS a money rate, so it belongs in the rate column.
  assert.equal(perHour[0]!.rate, "1.2500");

  const onRevenue = computeDerivedEarnings(input({
    ...SETTLES_MARCH, employee: DRIVER, charges, rules: [equipmentRule()],
  }));
  assert.equal(onRevenue[0]!.amount, "120.0000");
});

test("the unit filter and the item filter each narrow the rule", () => {
  const charges = [
    charge("2026-03-05", { equipmentUnitId: EXCAVATOR, itemId: ITEM_EXCAVATOR_HOURS, billAmount: "1000.00" }),
    charge("2026-03-06", { equipmentUnitId: LOADER, itemId: ITEM_LOADER_HOURS, billAmount: "2000.00" }),
  ];

  // No filter: the whole fleet. 3% of 3,000.00.
  const fleet = computeDerivedEarnings(input({
    ...SETTLES_MARCH, employee: DRIVER, charges, rules: [equipmentRule()],
  }));
  assert.equal(fleet[0]!.amount, "90.0000");

  // One named machine.
  const oneUnit = computeDerivedEarnings(input({
    ...SETTLES_MARCH, employee: DRIVER, charges,
    rules: [equipmentRule({ equipmentUnitId: LOADER })],
  }));
  assert.equal(oneUnit[0]!.amount, "60.0000");

  // The item filter is the one that makes "all excavators" ONE reviewable rule
  // rather than one row per machine — the whole reason it exists.
  const byItem = computeDerivedEarnings(input({
    ...SETTLES_MARCH, employee: DRIVER, charges,
    rules: [equipmentRule({ itemId: ITEM_EXCAVATOR_HOURS })],
  }));
  assert.equal(byItem[0]!.amount, "30.0000");
});

test("an operator is paid his own charges and nobody else's", () => {
  // The month is fully attributed — just not all of it to him.
  const charges = [
    charge("2026-03-05", { employeePartyId: OPERATOR, billAmount: "1000.00" }),
    charge("2026-03-06", { employeePartyId: OTHER_OPERATOR, billAmount: "9000.00" }),
  ];

  const his = computeDerivedEarnings(input({
    ...SETTLES_MARCH, employee: DRIVER, charges, rules: [equipmentRule()],
  }));
  assert.equal(his[0]!.amount, "30.0000");

  const theirs = computeDerivedEarnings(input({
    ...SETTLES_MARCH, charges, rules: [equipmentRule()],
    employee: { ...DRIVER, partyId: OTHER_OPERATOR },
  }));
  assert.equal(theirs[0]!.amount, "270.0000");

  // Every cent of the month's incentive is paid to exactly one person: 3% of
  // 10,000.00, split with nothing lost and nothing paid twice.
  assert.equal(sum([his[0]!.amount, theirs[0]!.amount]), "300.0000");
});

test("charges split across jobs cost to their own job, penny-exact", () => {
  // A month that does not divide evenly: 3% of 333.33 is 9.9999 → 10.00, and
  // 3% of 666.67 is 20.0001 → 20.00. Each line is priced on its OWN revenue
  // because that is the line an operator disputes against the invoice.
  const lines = computeDerivedEarnings(input({
    ...SETTLES_MARCH, employee: DRIVER, rules: [equipmentRule()],
    charges: [
      charge("2026-03-05", { projectId: JOB_A, billAmount: "333.33" }),
      charge("2026-03-06", { projectId: JOB_B, billAmount: "666.67" }),
    ],
  }));

  assert.equal(lines.length, 2);
  assert.equal(lines.find((line) => line.projectId === JOB_A)!.amount, "10.0000");
  assert.equal(lines.find((line) => line.projectId === JOB_B)!.amount, "20.0000");
  assert.equal(sum(lines.map((line) => line.amount)), "30.0000");
});

// --- The coverage refusal ---------------------------------------------------

test("an unattributed charge REFUSES the month rather than under-paying", () => {
  // The failure this whole design exists to prevent. $9,000 of the month's
  // $10,000 has no operator recorded. Paying 3% of the $1,000 that happens to
  // be attributed produces $30 — a number that looks entirely ordinary on a
  // stub and is wrong by $270.
  const charges = [
    charge("2026-03-05", { employeePartyId: OPERATOR, billAmount: "1000.00" }),
    charge("2026-03-06", { employeePartyId: null, billAmount: "9000.00" }),
  ];

  assert.throws(
    () => computeDerivedEarnings(input({
      ...SETTLES_MARCH, employee: DRIVER, charges, rules: [equipmentRule()],
    })),
    (error: unknown) => {
      assert.ok(error instanceof DerivedCoverageError);
      assert.equal(error.detail.unattributed, 1);
      assert.equal(error.detail.qualifying, 2);
      assert.equal(error.detail.monthStart, "2026-03-01");
      assert.equal(error.detail.monthEnd, "2026-03-31");
      return true;
    },
  );
});

test("the refusal is scoped to the rule's own filters, not the whole fleet", () => {
  // A gap the rule does not read is not this rule's problem. The excavator
  // month is complete, so an excavator-only rule pays; the loader gap still
  // stops any rule that reads loaders. This is what makes "narrow the rule" a
  // real remedy rather than a way to hide the gap.
  const charges = [
    charge("2026-03-05", { equipmentUnitId: EXCAVATOR, itemId: ITEM_EXCAVATOR_HOURS, billAmount: "1000.00" }),
    charge("2026-03-06", {
      equipmentUnitId: LOADER, itemId: ITEM_LOADER_HOURS,
      employeePartyId: null, billAmount: "9000.00",
    }),
  ];

  const scoped = computeDerivedEarnings(input({
    ...SETTLES_MARCH, employee: DRIVER, charges,
    rules: [equipmentRule({ equipmentUnitId: EXCAVATOR })],
  }));
  assert.equal(scoped[0]!.amount, "30.0000");

  assert.throws(
    () => computeDerivedEarnings(input({
      ...SETTLES_MARCH, employee: DRIVER, charges,
      rules: [equipmentRule({ equipmentUnitId: LOADER })],
    })),
    DerivedCoverageError,
  );
});

test("the refusal fires for every employee, so a run cannot half-settle", () => {
  // The gap is a property of the MONTH. If it only stopped the employees who
  // happened to own an unattributed line, the rest of the crew would be paid
  // off an incomplete month and the run would look successful.
  const charges = [
    charge("2026-03-05", { employeePartyId: OPERATOR, billAmount: "1000.00" }),
    charge("2026-03-06", { employeePartyId: null, billAmount: "9000.00" }),
  ];
  for (const partyId of [OPERATOR, OTHER_OPERATOR]) {
    assert.throws(
      () => computeDerivedEarnings(input({
        ...SETTLES_MARCH, charges, rules: [equipmentRule()],
        employee: { ...DRIVER, partyId },
      })),
      DerivedCoverageError,
      `${partyId} must not be paid off a partially attributed month`,
    );
  }
});

test("an equipment rule refuses rather than silently pay nothing", () => {
  // Two ways a caller can make an equipment rule match nothing by accident.
  // Both have to be errors: "paid nothing" and "could not tell whose charges
  // these are" must never look the same on a stub.
  assert.throws(
    () => computeDerivedEarnings(input({
      ...SETTLES_MARCH, rules: [equipmentRule()],
      charges: [charge("2026-03-05")],
      employee: { jobTitle: "Operator", tradeId: null, departmentId: DEPT_FIELD },
    })),
    /no party id/,
  );

  assert.throws(
    () => computeDerivedEarnings(input({
      ...SETTLES_MARCH, employee: DRIVER, charges: [charge("2026-03-05")],
      rules: [equipmentRule({ timeTypeId: TT_EQUIPMENT })],
    })),
    /filters on a time type/,
  );
});

test("a charge with no equipment unit is not an equipment charge", () => {
  // Materials and services ride the same table. They are not the fleet, they
  // are not what an operator ran, and — crucially — an unattributed material
  // line must not trip the coverage refusal.
  const lines = computeDerivedEarnings(input({
    ...SETTLES_MARCH, employee: DRIVER, rules: [equipmentRule()],
    charges: [
      charge("2026-03-05", { billAmount: "1000.00" }),
      charge("2026-03-06", {
        equipmentUnitId: null, itemId: null, employeePartyId: null, billAmount: "9000.00",
      }),
    ],
  }));

  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.amount, "30.0000");
});

test("a month that nets negative is refused, not paid as a clawback", () => {
  // A credit posted into the settled month can drive a job's incentive below
  // zero. A negative earning is a hard failure downstream (the WCB job split
  // and disposable earnings both refuse them), so recovering an overpayment
  // has to be a deliberate, visible pay run adjustment.
  assert.throws(
    () => computeDerivedEarnings(input({
      ...SETTLES_MARCH, employee: DRIVER, rules: [equipmentRule()],
      charges: [
        charge("2026-03-05", { billAmount: "1000.00" }),
        charge("2026-03-06", { billAmount: "-4000.00" }),
      ],
    })),
    (error: unknown) => {
      assert.ok(error instanceof DerivedEarningsError);
      assert.match((error as Error).message, /negative earning/);
      return true;
    },
  );
});

test("the charge window is the settled month, and only for charge rules", () => {
  const equipment = equipmentRule();
  const daily = rule({ code: "ONCALL", componentId: ON_CALL });

  assert.deepEqual(derivedChargeWindow([equipment], "2026-03-30", "2026-04-12"), {
    start: "2026-03-01", end: "2026-03-31",
  });
  // A period closing no month settles nothing.
  assert.equal(derivedChargeWindow([equipment], "2026-04-13", "2026-04-26"), null);
  // A rule set with no charge rule reads no charges at all.
  assert.equal(derivedChargeWindow([daily], "2026-03-30", "2026-04-12"), null);
  // Charge rules do not widen the TIME entry window — different source.
  assert.deepEqual(derivedEntryWindow([equipment], "2026-03-30", "2026-04-12"), {
    from: "2026-03-30", to: "2026-04-12",
  });
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

test("effective-dated rule versions resolve by the pay-period end", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const componentId = `66666666-6666-4666-8666-${String(Date.now()).slice(-12).padStart(12, "0")}`;
  const ruleId = `77777777-7777-4777-8777-${String(Date.now()).slice(-12).padStart(12, "0")}`;
  const successorId = `88888888-8888-4888-8888-${String(Date.now()).slice(-12).padStart(12, "0")}`;
  try {
    await db.execute(sql`
      insert into pay_components (id, org_id, code, name, kind, value)
      values (${componentId}, ${org.orgId}, 'EFFECTIVE-TEST', 'Effective test', 'earning', '1')`);
    await db.execute(sql`
      insert into pay_derived_rules (id, org_id, code, name, component_id, trigger,
                                     quantity_mode, rate_mode, rate_value, costing_mode,
                                     effective_from, effective_to, is_active)
      values (${ruleId}, ${org.orgId}, 'VERSIONED', 'Original', ${componentId}, 'distinct_day',
              'count', 'fixed_per_unit', '10', 'source', '2026-01-01', '2026-06-30', true)`);
    await db.execute(sql`
      insert into pay_derived_rules (id, org_id, code, name, component_id, trigger,
                                     quantity_mode, rate_mode, rate_value, costing_mode,
                                     effective_from, is_active)
      values (${successorId}, ${org.orgId}, 'VERSIONED', 'Successor', ${componentId}, 'distinct_day',
              'count', 'fixed_per_unit', '25', 'source', '2026-07-01', true)`);

    const before = await loadActiveDerivedRules(db, org.orgId, "2026-06-30");
    const after = await loadActiveDerivedRules(db, org.orgId, "2026-07-01");
    assert.deepEqual(before.map((rule) => [rule.id, rule.name, rule.rateValue]), [[ruleId, "Original", "10.0000"]]);
    assert.deepEqual(after.map((rule) => [rule.id, rule.name, rule.rateValue]), [[successorId, "Successor", "25.0000"]]);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
