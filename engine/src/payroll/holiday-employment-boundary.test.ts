import { appendStatutoryHolidayEarningLines } from "./run-earning-lines.ts";
import type { Line } from "./run-stub-records.ts";
import { parseMoney } from "../money/brands.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  resolveStatutoryHolidayPay,
  statutoryHolidayEmploymentSource,
  type StatutoryHolidayPayInput,
} from "./holidays.ts";
import { approvedHolidayOccurrenceDates } from "./holiday-obligation-source.ts";

const ORG = "10000000-0000-4000-8000-000000000001";
const WORKER = "10000000-0000-4000-8000-000000000002";
const EMPLOYMENT = "10000000-0000-4000-8000-000000000003";
const EMPLOYER = "10000000-0000-4000-8000-000000000004";
const OTHER = "10000000-0000-4000-8000-000000000005";

const input: StatutoryHolidayPayInput = {
  orgId: ORG,
  employeePartyId: WORKER,
  employmentId: EMPLOYMENT,
  subsidiaryId: EMPLOYER,
  employeeName: "Holiday Worker",
  country: "CA",
  jurisdiction: "CA-ON",
  periodStart: "2026-04-01",
  periodEnd: "2026-04-15",
  hourlyRate: "25.00",
  holidayComponentId: OTHER,
  premiumComponentId: OTHER,
  excludeDocumentId: OTHER,
};

type Version = {
  status: string;
  effective_from: string;
  effective_to: string | null;
  recorded_until?: string | null;
};
const active = (from: string, to: string | null = null): Version => ({
  status: "active",
  effective_from: from,
  effective_to: to,
});

/** Only the database boundary is substituted; the calendar, employment
 * spell resolution, statutory qualification and pricing all run natively. */
function database(
  versions: Version[],
  options: { earnings?: boolean; holidayHours?: string } = {},
) {
  const queries: string[] = [];
  const dialect = new PgDialect();
  const executor = {
    execute: async (query: SQL, mode?: string) => {
      const inMode = <T extends { rows: unknown }>(result: T) =>
        mode === "objects" ? result.rows : result;
      const built = dialect.sqlToQuery(query);
      queries.push(built.sql);
      if (built.sql.includes("from worker_employments e")) {
        assert.match(built.sql, /e\.id = \$\d+/);
        assert.match(built.sql, /e\.worker_party_id = \$\d+/);
        assert.match(built.sql, /e\.employer_subsidiary_id = \$\d+/);
        assert.match(built.sql, /v\.org_id = e\.org_id/);
        assert.match(built.sql, /v\.recorded_until is null/);
        if (JSON.stringify(built.params) !== JSON.stringify([ORG, EMPLOYMENT, WORKER, EMPLOYER]))
          return inMode({ rows: [] });
        const current = versions.filter((v) => v.recorded_until == null);
        return inMode({
          rows: current.length
            ? current.map((v, i) => ({
                orgId: ORG,
                employeePartyId: WORKER,
                employmentId: EMPLOYMENT,
                subsidiaryId: EMPLOYER,
                employmentRevision: 4,
                versionId: OTHER,
                versionNo: i + 1,
                status: v.status,
                effectiveFrom: v.effective_from,
                effectiveTo: v.effective_to,
                recordedAt: "2026-10-01T00:00:00.000001Z",
              }))
            : [{ status: null, effectiveFrom: null, effectiveTo: null }],
        });
      }
      if (built.sql.includes("from payroll_employer_facts"))
        return inMode({
          rows: [
            { fact_value: built.params.includes("mb_remembrance_day_act_exempt") ? "false" : "1" },
          ],
        });
      if (built.sql.includes("select coalesce(c.system_key") && options.earnings)
        return inMode({
          rows: [
            {
              system_key: "regular",
              amount: "3000.00",
              earned_from: "2026-03-20",
              earned_to: "2026-03-20",
              period_start: "2026-03-20",
              period_end: "2026-03-20",
            },
          ],
        });
      if (built.sql.includes("select distinct worked_on") && options.earnings)
        return inMode({
          rows: Array.from({ length: 15 }, (_, i) => ({
            worked_on: `2026-03-${String(i + 4).padStart(2, "0")}`,
          })),
        });
      if (built.sql.includes("select coalesce(sum(hours), 0)::text as hours"))
        return inMode({
          rows: [{ hours: options.holidayHours ?? "0" }],
        });
      return inMode({ rows: [] });
    },
  };
  return { executor: executor as never, queries };
}

test("a native April 5 hire skips Good Friday in an April 1–15 pay period before asking eligibility facts", async () => {
  const fx = database([active("2026-04-05")]);
  assert.deepEqual(await resolveStatutoryHolidayPay(fx.executor, input), []);
  assert.equal(
    fx.queries.some(
      (q) =>
        q.includes("payroll_employer_facts") ||
        q.includes("pay_stub_lines") ||
        q.includes("time_entries"),
    ),
    false,
  );
  assert.equal(
    fx.queries.some((q) => q.includes("hired_on") || q.includes("employee_payroll_profiles")),
    false,
  );
});

test("retained holiday source evidence names the exact employment and each current recorded version", async () => {
  const fx = database([
    active("2026-01-01", "2026-03-01"),
    { ...active("2026-03-01"), status: "on_leave" },
  ]);
  const rows = await statutoryHolidayEmploymentSource(fx.executor, input);
  assert.deepEqual(
    rows.map((row) => [
      row.employmentId,
      row.subsidiaryId,
      row.employmentRevision,
      row.versionNo,
      row.status,
      row.effectiveFrom,
      row.effectiveTo,
      row.recordedAt,
    ]),
    [
      [
        EMPLOYMENT,
        EMPLOYER,
        4,
        1,
        "active",
        "2026-01-01",
        "2026-03-01",
        "2026-10-01T00:00:00.000001Z",
      ],
      [EMPLOYMENT, EMPLOYER, 4, 2, "on_leave", "2026-03-01", null, "2026-10-01T00:00:00.000001Z"],
    ],
  );
  assert.match(fx.queries[0]!, /v\.id::text as "versionId"/);
  assert.match(fx.queries[0]!, /v\.recorded_at at time zone 'UTC'/);
});

test("employment on the observed holiday still requires its own last-and-first assertion", async () => {
  for (const from of ["2020-01-01", "2026-04-03"]) {
    const fx = database([active(from)]);
    await assert.rejects(
      resolveStatutoryHolidayPay(fx.executor, {
        ...input,
        absentWithoutConsentByHoliday: { "christmas|2026-12-25": false },
      }),
      /Good Friday.*last-and-first-shift.*absence assertion/,
    );
  }
  const fx = database([active("2020-01-01")], { earnings: true });
  const lines = await resolveStatutoryHolidayPay(fx.executor, {
    ...input,
    absentWithoutConsentByHoliday: { "good_friday|2026-04-03": false },
  });
  assert.equal(lines[0]?.holidayDate, "2026-04-03");
  assert.equal(lines[0]?.amount, "150.0000");
  assert.deepEqual(
    await resolveStatutoryHolidayPay(fx.executor, {
      ...input,
      absentWithoutConsentByHoliday: { "good_friday|2026-04-03": true },
    }),
    [],
  );
});

test("ended, pending, uncovered and superseded holiday dates do not establish employment", async () => {
  for (const versions of [
    [active("2020-01-01", "2026-04-03")],
    [{ ...active("2020-01-01"), status: "terminated" }],
    [{ ...active("2020-01-01"), status: "pending" }],
    [active("2020-01-01", "2026-04-01"), active("2026-04-05")],
    [{ ...active("2020-01-01"), recorded_until: "2026-10-01T00:00:00Z" }, active("2026-04-05")],
  ]) {
    const fx = database(versions);
    assert.deepEqual(
      await resolveStatutoryHolidayPay(fx.executor, input),
      [],
      JSON.stringify(versions),
    );
  }
  const endedAfterHoliday = database([active("2020-01-01", "2026-04-04")]);
  await assert.rejects(
    resolveStatutoryHolidayPay(endedAfterHoliday.executor, input),
    /last-and-first-shift/,
  );
});

test("holiday employment identity refuses missing, foreign, employer-mismatched and unrecorded sources", async () => {
  const fx = database([active("2020-01-01")]);
  for (const changed of [
    { orgId: OTHER },
    { employeePartyId: OTHER },
    { employmentId: OTHER },
    { subsidiaryId: OTHER },
  ])
    await assert.rejects(
      resolveStatutoryHolidayPay(fx.executor, { ...input, ...changed }),
      /does not belong/,
    );
  for (const employmentId of [undefined, null, "unknown"])
    await assert.rejects(
      resolveStatutoryHolidayPay(fx.executor, {
        ...input,
        employmentId: employmentId as unknown as string,
      }),
      /selected native employment and paying legal employer/,
    );
  await assert.rejects(
    resolveStatutoryHolidayPay(fx.executor, { ...input, subsidiaryId: null }),
    /selected native employment/,
  );
  await assert.rejects(
    resolveStatutoryHolidayPay(database([]).executor, input),
    /no usable effective holiday-pay history/,
  );
  await assert.rejects(
    resolveStatutoryHolidayPay(
      database([active("2020-01-01", "2026-04-05"), active("2026-04-01")]).executor,
      input,
    ),
    /overlapping holiday-pay status windows/,
  );
});

test("continuous active, leave and suspended history preserves statutory tenure across status changes", async () => {
  const fx = database(
    [
      active("2026-02-01", "2026-03-01"),
      { ...active("2026-03-01", "2026-03-20"), status: "on_leave" },
      { ...active("2026-03-20", "2026-04-01"), status: "suspended" },
      active("2026-04-01"),
    ],
    { earnings: true },
  );
  const lines = await resolveStatutoryHolidayPay(fx.executor, { ...input, jurisdiction: "CA-BC" });
  assert.equal(lines[0]?.amount, "200.0000");
  assert.equal(lines[0]?.holidayDate, "2026-04-03");
});

test("a rehire cannot borrow tenure from a prior ended or disconnected spell", async () => {
  for (const versions of [
    [
      active("2026-01-01", "2026-03-01"),
      { ...active("2026-03-01", "2026-04-01"), status: "terminated" },
      active("2026-04-01"),
    ],
    [active("2026-01-01", "2026-03-01"), active("2026-04-01")],
    [active("2026-04-01")],
  ]) {
    const fx = database(versions, { earnings: true });
    assert.deepEqual(
      await resolveStatutoryHolidayPay(fx.executor, { ...input, jurisdiction: "CA-BC" }),
      [],
    );
  }
});

test("work-triggered holidays and construction premiums are also scoped to employment on their event date", async () => {
  const remembrance = {
    ...input,
    jurisdiction: "CA-MB",
    occupationClass: "general",
    periodStart: "2026-11-01",
    periodEnd: "2026-11-15",
  };
  const after = database([active("2026-11-12")], { holidayHours: "2" });
  assert.deepEqual(await resolveStatutoryHolidayPay(after.executor, remembrance), []);
  assert.equal(
    after.queries.some((q) => q.includes("time_entries") || q.includes("payroll_employer_facts")),
    false,
  );
  const during = database([active("2026-11-11")], { holidayHours: "2" });
  await assert.rejects(
    resolveStatutoryHolidayPay(during.executor, remembrance),
    /work schedule|normal.*day|normally scheduled/,
  );
  assert.equal(
    during.queries.some((q) => q.includes("payroll_employer_facts")),
    true,
  );
  const construction = database([active("2026-04-05")], { holidayHours: "8" });
  const lines = await resolveStatutoryHolidayPay(construction.executor, {
    ...input,
    jurisdiction: "CA-MB",
    occupationClass: "construction",
    periodRegularEarnings: "1000.00",
  });
  assert.deepEqual(
    lines.map((line) => [line.amount, line.periodWide]),
    [["40.0000", true]],
  );
  assert.equal(
    construction.queries.some((q) => q.includes("time_entries")),
    false,
  );
  const employedConstruction = database([active("2026-04-03")], { holidayHours: "8" });
  const workedLines = await resolveStatutoryHolidayPay(employedConstruction.executor, {
    ...input,
    jurisdiction: "CA-MB",
    occupationClass: "construction",
    periodRegularEarnings: "1000.00",
  });
  assert.deepEqual(
    workedLines.map((line) => [line.amount, line.periodWide]),
    [
      ["40.0000", true],
      ["100.0000", undefined],
    ],
  );
  assert.equal(workedLines[1]?.holidayDate, "2026-04-03");
});

test("approved occurrence ownership binds the selected employment, employer, employee and retained date", async () => {
  const dialect = new PgDialect();
  const occurrenceInput = {
    orgId: ORG,
    employeePartyId: WORKER,
    employmentId: EMPLOYMENT,
    subsidiaryId: EMPLOYER,
    from: "2026-04-01",
    to: "2026-04-15",
  };
  const instruction = {
    employeePartyId: WORKER,
    holidayDates: ["2026-04-03"],
    hours: "8.00",
    assessedOn: "2026-04-10",
    wageBasisDate: "2026-04-10",
    paymentDate: "2026-04-16",
    instructionKey: "approved-holiday",
    sourceReference: "Approved holiday evidence",
    sourceDigest: "a".repeat(64),
  };
  let retainedInstruction = instruction;
  let occurrenceDate = "2026-04-03";
  const executor = {
    execute: async (query: SQL, mode?: string) => {
      const inMode = <T extends { rows: unknown }>(result: T) =>
        mode === "objects" ? result.rows : result;
      const built = dialect.sqlToQuery(query);
      assert.match(built.sql, /o\.employment_id=\$\d+/);
      assert.match(built.sql, /o\.employee_party_id=occurrence\.employee_party_id/);
      assert.match(built.sql, /o\.subsidiary_id=occurrence\.subsidiary_id/);
      assert.match(built.sql, /e\.worker_party_id=o\.employee_party_id/);
      assert.match(built.sql, /e\.employer_subsidiary_id=o\.subsidiary_id/);
      assert.match(built.sql, /f\.status='applied'/);
      assert.match(built.sql, /occurrence\.holiday_date between \$\d+::date and \$\d+::date/);
      if (
        JSON.stringify(built.params) !==
        JSON.stringify([ORG, WORKER, EMPLOYMENT, EMPLOYER, "2026-04-01", "2026-04-15"])
      )
        return inMode({ rows: [] });
      return inMode({
        rows: [{ date: occurrenceDate, evidence: { instruction: retainedInstruction } }],
      });
    },
  };
  assert.deepEqual(
    [...(await approvedHolidayOccurrenceDates(executor as never, occurrenceInput))],
    ["2026-04-03"],
  );
  for (const changed of [
    { orgId: OTHER },
    { employeePartyId: OTHER },
    { employmentId: OTHER },
    { subsidiaryId: OTHER },
    { from: "2026-04-04" },
    { to: "2026-04-02" },
  ]) {
    assert.deepEqual(
      [
        ...(await approvedHolidayOccurrenceDates(executor as never, {
          ...occurrenceInput,
          ...changed,
        })),
      ],
      [],
    );
  }
  retainedInstruction = { ...instruction, employeePartyId: OTHER };
  await assert.rejects(
    approvedHolidayOccurrenceDates(executor as never, occurrenceInput),
    /retained employee and holiday-date evidence/,
  );
  retainedInstruction = instruction;
  occurrenceDate = "2026-04-06";
  await assert.rejects(
    approvedHolidayOccurrenceDates(executor as never, occurrenceInput),
    /retained employee and holiday-date evidence/,
  );
  await assert.rejects(
    approvedHolidayOccurrenceDates(executor as never, {
      ...occurrenceInput,
      employmentId: "unknown",
    }),
    /selected native employment/,
  );
});

test("construction holiday pay includes paid vacation wages and excludes native overtime wages on a pay with no holiday", async () => {
  const fx = database([active("2020-01-01")]);
  const overtime = "10000000-0000-4000-8000-000000000006";
  const lines: Line[] = [
    {
      componentId: "10000000-0000-4000-8000-000000000007",
      kind: "earning",
      description: "Regular wages",
      amount: parseMoney("1000"),
      sequence: 10,
      classification: "regular",
    },
    {
      componentId: overtime,
      kind: "earning",
      description: "Overtime wages",
      amount: parseMoney("200"),
      sequence: 20,
      classification: "overtime",
    },
    {
      componentId: "10000000-0000-4000-8000-000000000008",
      kind: "earning",
      description: "Paid vacation wages",
      amount: parseMoney("40"),
      sequence: 40,
    },
  ];
  await appendStatutoryHolidayEarningLines(fx.executor, {
    orgId: ORG,
    documentId: OTHER,
    employeePartyId: WORKER,
    emp: {
      employment_id: EMPLOYMENT,
      display_name: "Construction worker",
      pay_basis: "hourly",
      labour_jurisdiction: null,
    },
    country: "CA",
    subsidiaryId: EMPLOYER,
    province: "MB",
    run: { period_start: "2026-07-05", period_end: "2026-07-18", run_type: "regular" },
    payRate: null,
    statHolidayPay: true,
    oneOffRun: false,
    occupationClass: "construction",
    need: (key) => ({ id: key === "overtime" ? overtime : OTHER }),
    lines,
    currentEarningLines: lines,
  });
  assert.equal(lines.length, 4);
  assert.equal(lines[3]!.amount, "41.6000");
});
