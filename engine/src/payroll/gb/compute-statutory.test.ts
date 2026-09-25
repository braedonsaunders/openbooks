/**
 * GB computeStatutory wrapper tests — run with `node --import tsx
 * engine/src/payroll/gb/compute-statutory.test.ts`.
 *
 * The arithmetic lives in calculate.ts (see parity.test.ts); these prove the
 * wrapper's plumbing: edition refusal outside every transcribed year, a
 * prior-year correction pricing its own tables end to end, the SCT
 * guard, the P6/P9 code requirement, the cumulative completeness gate, and
 * the pushed lines plus GB factor keys. The database is a hand-rolled fake:
 * tests that must not read YTD fail the fake's `execute` loudly, proving
 * the no-DB paths touch nothing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { db } from "../../platform/db.ts";
import type {
  PayrollStatutoryComputeContext,
  PushStatutoryFn,
} from "../statutory-context.ts";
import { computeGbStatutory } from "./compute-statutory.ts";

type Tx = Pick<typeof db, "execute">;

interface Pushed {
  systemKey: string;
  kind: string;
  description: string;
  amount: string;
  sequence: number;
}

function refusingTx(): Tx {
  return {
    execute: async () => {
      throw new Error("database touched on a path that must not read YTD");
    },
  } as unknown as Tx;
}

function stubTx(rows: Record<string, unknown>): Tx {
  return {
    execute: async () => ({ rows: [rows] }),
  } as unknown as Tx;
}

const EMPTY_YTD = {
  taxable: "0",
  addpay: "0",
  tax: "0",
  stub_count: "0",
  first_pay: null,
};

function certificateForCodes(
  codes: Record<string, Record<string, string | null> | null>,
): PayrollStatutoryComputeContext["certificateFor"] {
  return ((key: string) => {
    const answers = key === "gb_nic_category"
      ? { category_letter: "A", director_status: "not_director", ...codes[key] }
      : codes[key] ?? (key === "gb_workplace_pension"
        ? { age_band: "under_16_or_other_exclusion", worker_status: "noneligible_jobholder", enrolment_status: "not_enrolled" }
        : undefined);
    if (!answers) return null;
    return {
      certificate: { key },
      onFile: true,
      effectiveFrom: null,
      answers,
      missing: [],
    };
  }) as unknown as PayrollStatutoryComputeContext["certificateFor"];
}

function gbContext(overrides: {
  payDate?: string;
  taxYear?: number;
  region?: string;
  tx?: Tx;
  codes?: Record<string, Record<string, string | null> | null>;
  income?: string;
  pensionable?: string;
  pushed?: Pushed[];
}): { ctx: PayrollStatutoryComputeContext; pushed: Pushed[] } {
  const pushed: Pushed[] = overrides.pushed ?? [];
  const pushStatutory = ((
    systemKey: string,
    kind: "deduction" | "employer_contribution",
    description: string,
    amount: string,
    sequence: number,
  ) => {
    pushed.push({ systemKey, kind, description, amount, sequence });
  }) as PushStatutoryFn;
  const ctx = {
    tx: overrides.tx ?? refusingTx(),
    orgId: "org",
    documentId: "doc",
    employeePartyId: "emp",
    employeeName: "Test Employee",
    taxYear: overrides.taxYear ?? 2026,
    country: "GB",
    region: overrides.region ?? "ENG",
    run: { pay_date: overrides.payDate ?? "2026-04-06" },
    emp: {},
    filingAccountId: null,
    periodsPerYear: 12,
    income: overrides.income ?? "0",
    nonPeriodic: "0",
    pensionable: overrides.pensionable ?? "0",
    insurable: "0",
    deduction: () => "0",
    pushStatutory,
    storedCertificates: [],
    certificateFor: certificateForCodes({
      gb_nic_category: { category_letter: "A" },
      gb_starter_checklist: {
        student_loan_plan: "none",
        student_loan_postgraduate: "false",
      },
      gb_workplace_pension_assessment: {
        age_band: "22_to_state_pension_age",
        membership_status: "not_eligible",
        scheme_basis: "not_applicable",
        deduction_method: "not_applicable",
      },
      ...(overrides.codes ?? {}),
    }),
    bool: (value: string | null | undefined) => value === "true",
    assertRegionSupported: () => {},
    employerLevies: {},
  } as unknown as PayrollStatutoryComputeContext;
  return { ctx, pushed };
}

const NOTICE_1257L = {
  gb_tax_code_notice: { tax_code: "1257L", non_cumulative: null },
};

test("pay dates outside every transcribed year throw without touching the database", async () => {
  for (const payDate of ["2024-04-05", "2027-04-06", "2028-01-01"]) {
    const { ctx } = gbContext({ payDate, codes: NOTICE_1257L });
    await assert.rejects(() => computeGbStatutory(ctx), /no transcribed tables/, payDate);
  }
});

test("a 2025/26 correction prices the 2025 tables end to end", async () => {
  const { ctx, pushed } = gbContext({
    payDate: "2025-04-06",
    taxYear: 2025,
    tx: stubTx(EMPTY_YTD),
    income: "4000",
    pensionable: "4000",
    codes: NOTICE_1257L,
  });
  const factors = await computeGbStatutory(ctx);
  assert.equal(factors.GB_TAX, "590.2000");
  assert.deepEqual(pushed.map((line) => line.amount), [
    "590.2000", "236.1600", "0.0000", "0.0000", "537.4500",
  ]);
});

test("a pay date is never priced from another year's tables", async () => {
  // 2025-06-06 falls in 2025/26: a run filed as tax year 2026 is refused by
  // name naming both years, not priced from the 2026 tables.
  const { ctx } = gbContext({ payDate: "2025-06-06", taxYear: 2026, codes: NOTICE_1257L });
  await assert.rejects(() => computeGbStatutory(ctx), /in 2025 against the run's tax year 2026/);
});

test("an S-less code on an SCT run is refused by name, never fallen through", async () => {
  const { ctx } = gbContext({ region: "SCT", codes: NOTICE_1257L });
  await assert.rejects(() => computeGbStatutory(ctx), /S-prefix|SCT/);
});

test("SCT with an S-code prices the Scottish bands end to end", async () => {
  const { ctx, pushed } = gbContext({
    tx: stubTx(EMPTY_YTD),
    region: "SCT",
    income: "2250",
    pensionable: "2250",
    codes: { gb_tax_code_notice: { tax_code: "S1257L", non_cumulative: null } },
  });
  await computeGbStatutory(ctx);
  assert.equal(pushed[0]!.amount, "236.8900");
});

test("a recorded student-loan plan is deducted from NIC-able earnings", async () => {
  const { ctx, pushed } = gbContext({
    tx: stubTx(EMPTY_YTD),
    codes: {
      ...NOTICE_1257L,
      gb_starter_checklist: {
        starter_declaration: "A",
        student_loan_plan: "plan_2",
        student_loan_postgraduate: "false",
      },
    },
    income: "3000",
    pensionable: "3000",
  });

  const factors = await computeGbStatutory(ctx);
  assert.equal(factors.GB_STUDENT_LOAN, "49.0000");
  assert.equal(factors.GB_POSTGRADUATE_LOAN, "0.0000");
  assert.deepEqual(
    pushed.map((line) => [line.systemKey, line.amount]),
    [
      ["paye", "390.2000"],
      ["nic", "156.1600"],
      ["student_loan", "49.0000"],
      ["postgraduate_loan", "0.0000"],
      ["nic", "387.4500"],
    ],
  );
});

test("a postgraduate loan is collected alongside the selected undergraduate plan", async () => {
  const { ctx, pushed } = gbContext({
    tx: stubTx(EMPTY_YTD),
    codes: {
      ...NOTICE_1257L,
      gb_starter_checklist: {
        starter_declaration: "A",
        student_loan_plan: "plan_2",
        student_loan_postgraduate: "true",
      },
    },
    income: "3000",
    pensionable: "3000",
  });

  const factors = await computeGbStatutory(ctx);
  assert.equal(factors.GB_STUDENT_LOAN, "49.0000");
  assert.equal(factors.GB_POSTGRADUATE_LOAN, "75.0000");
  assert.deepEqual(
    pushed.filter((line) => line.systemKey === "student_loan" || line.systemKey === "postgraduate_loan")
      .map((line) => [line.systemKey, line.amount]),
    [["student_loan", "49.0000"], ["postgraduate_loan", "75.0000"]],
  );
});

test("missing student-loan facts refuse by name instead of silently treating the employee as debt-free", async () => {
  const { ctx, pushed } = gbContext({
    codes: {
      ...NOTICE_1257L,
      gb_starter_checklist: {
        starter_declaration: "A",
        student_loan_plan: null,
        student_loan_postgraduate: "false",
      },
    },
    income: "3000",
    pensionable: "3000",
  });
  await assert.rejects(() => computeGbStatutory(ctx), /cannot calculate without student loan plan/);
  assert.deepEqual(pushed, []);
});

test("missing postgraduate-loan status refuses instead of omitting a concurrent deduction", async () => {
  const { ctx, pushed } = gbContext({
    codes: {
      ...NOTICE_1257L,
      gb_starter_checklist: {
        starter_declaration: "A",
        student_loan_plan: "none",
        student_loan_postgraduate: null,
      },
    },
    income: "3000",
    pensionable: "3000",
  });
  await assert.rejects(() => computeGbStatutory(ctx), /cannot calculate without postgraduate loan status/);
  assert.deepEqual(pushed, []);
});

test("a missing NIC category refuses instead of assuming category A", async () => {
  const { ctx, pushed } = gbContext({
    codes: {
      ...NOTICE_1257L,
      gb_nic_category: { category_letter: null },
    },
    income: "3000",
    pensionable: "3000",
  });

  await assert.rejects(
    () => computeGbStatutory(ctx),
    /cannot calculate without National Insurance category letter.*must not assume category A/s,
  );
  assert.deepEqual(pushed, []);
});

test("a valid non-A NIC category refuses rather than applying category-A bands", async () => {
  const { ctx, pushed } = gbContext({
    codes: {
      ...NOTICE_1257L,
      gb_nic_category: { category_letter: "C" },
    },
    income: "3000",
    pensionable: "3000",
  });

  await assert.rejects(
    () => computeGbStatutory(ctx),
    /cannot calculate National Insurance category C: this pack currently implements category A only/,
  );
  assert.deepEqual(pushed, []);
  const { ctx: directorCtx } = gbContext({ codes: { gb_nic_category: { category_letter: "A", director_status: "director", directorship_start_date: "2026-04-06" } } });
  await assert.rejects(() => computeGbStatutory(directorCtx), /CA44 requires cumulative annual or pro-rata/);
});

// One assertion for the 223 minimums: a coherently enrolled worker prices
// THROUGH the narrowed enrolled gates — both certificates agree
// contributions are due. Monthly £3,000: qualifying £2,480; 5% = £124.
test("an enrolled worker with priced scheme terms prices AE minimums", async () => {
  const { ctx } = gbContext({
    tx: stubTx(EMPTY_YTD),
    codes: {
      ...NOTICE_1257L,
      gb_workplace_pension: { age_band: "22_to_state_pension_age", worker_status: "eligible_jobholder", enrolment_status: "enrolled" },
      gb_workplace_pension_assessment: { age_band: "22_to_state_pension_age", membership_status: "active_member", scheme_basis: "qualifying_earnings_minimum", deduction_method: "net_pay" },
    },
    income: "3000",
    pensionable: "3000",
  });
  assert.equal((await computeGbStatutory(ctx)).GB_AE_EMPLOYEE, "124.0000");
});

test("an S-code prices Scottish bands in any region; SBR is whole-pay 20%", async () => {
  const { ctx, pushed } = gbContext({
    region: "ENG",
    income: "3200",
    pensionable: "3200",
    codes: { gb_tax_code_notice: { tax_code: "SBR", non_cumulative: null } },
  });
  await computeGbStatutory(ctx);
  assert.equal(pushed[0]!.amount, "640.0000");
});

test("a missing coding notice is refused, naming the P6/P9", async () => {
  const { ctx } = gbContext({ codes: {} });
  await assert.rejects(() => computeGbStatutory(ctx), /gb_tax_code_notice/);
});

test("enrolled workplace-pension contributions refuse instead of disappearing", async () => {
  const { ctx } = gbContext({ codes: { gb_workplace_pension: { age_band: "22_to_state_pension_age", worker_status: "eligible_jobholder", enrolment_status: "enrolled" } } });
  await assert.rejects(() => computeGbStatutory(ctx), /workplace-pension contributions are due/);
});

test("an inoperable code is refused by name", async () => {
  const { ctx } = gbContext({
    codes: { gb_tax_code_notice: { tax_code: "SK475", non_cumulative: null } },
  });
  await assert.rejects(() => computeGbStatutory(ctx), /SK475/);
});

test("NT pushes zeros and reads nothing", async () => {
  const { ctx, pushed } = gbContext({
    income: "5000",
    pensionable: "5000",
    codes: { gb_tax_code_notice: { tax_code: "NT", non_cumulative: null } },
  });
  await computeGbStatutory(ctx);
  assert.deepEqual(
    pushed.map((line) => [line.systemKey, line.kind, line.amount]),
    [
      ["paye", "deduction", "0.0000"],
      ["nic", "deduction", "267.5000"],
      ["student_loan", "deduction", "0.0000"],
      ["postgraduate_loan", "deduction", "0.0000"],
      ["nic", "employer_contribution", "687.4500"],
    ],
  );
});

test("BR prices the whole period with no YTD read", async () => {
  const { ctx, pushed } = gbContext({
    income: "3200",
    pensionable: "3200",
    codes: { gb_tax_code_notice: { tax_code: "BR", non_cumulative: null } },
  });
  const factors = await computeGbStatutory(ctx);
  assert.deepEqual(
    pushed.map((line) => [line.systemKey, line.kind, line.amount]),
    [
      ["paye", "deduction", "640.0000"],
      ["nic", "deduction", "172.1600"],
      ["student_loan", "deduction", "0.0000"],
      ["postgraduate_loan", "deduction", "0.0000"],
      ["nic", "employer_contribution", "417.4500"],
    ],
  );
  assert.deepEqual(factors, {
    GB_TAXABLE: "3200.0000",
    GB_ADDPAY: "0.0000",
    GB_TAX: "640.0000",
    GB_STUDENT_LOAN: "0.0000",
    GB_POSTGRADUATE_LOAN: "0.0000",
    GB_AE_EMPLOYEE: "0.0000",
    GB_AE_EMPLOYER: "0.0000",
  });
});

test("cumulative 1257L in month 1 prices from zero priors", async () => {
  const { ctx, pushed } = gbContext({
    tx: stubTx(EMPTY_YTD),
    income: "2250",
    pensionable: "2250",
    codes: NOTICE_1257L,
  });
  const factors = await computeGbStatutory(ctx);
  assert.deepEqual(
    pushed.map((line) => [line.systemKey, line.kind, line.amount]),
    [
      ["paye", "deduction", "240.2000"],
      ["nic", "deduction", "96.1600"],
      ["student_loan", "deduction", "0.0000"],
      ["postgraduate_loan", "deduction", "0.0000"],
      ["nic", "employer_contribution", "274.9500"],
    ],
  );
  assert.equal(factors.GB_TAXABLE, "2250.0000");
  assert.equal(factors.GB_TAX, "240.2000");
});

test("cumulative 1257L after month 1 with no record is refused", async () => {
  const { ctx } = gbContext({
    payDate: "2026-11-06",
    tx: stubTx(EMPTY_YTD),
    income: "2250",
    pensionable: "2250",
    codes: NOTICE_1257L,
  });
  await assert.rejects(() => computeGbStatutory(ctx), /complete in-year record/);
});

test("declaration A certifies the empty record", async () => {
  const { ctx, pushed } = gbContext({
    payDate: "2026-11-06",
    tx: stubTx(EMPTY_YTD),
    income: "9000",
    pensionable: "2250",
    codes: {
      ...NOTICE_1257L,
      gb_starter_checklist: {
        starter_declaration: "A",
        student_loan_plan: "none",
        student_loan_postgraduate: "false",
      },
    },
  });
  await computeGbStatutory(ctx);
  assert.equal(pushed[0]!.amount, "122.6000");
});

test("stubs spanning the year start price with priors applied", async () => {
  const { ctx, pushed } = gbContext({
    payDate: "2026-06-06",
    tx: stubTx({
      taxable: "2250.0000",
      addpay: "0",
      tax: "240.2000",
      stub_count: "1",
      first_pay: "2026-04-06",
    }),
    income: "2250",
    pensionable: "2250",
    codes: NOTICE_1257L,
  });
  await computeGbStatutory(ctx);
  // Free pay to date 3 × £1,048.26 = £3,144.78; cumulative £4,500;
  // Un = £1,355.22, Tn = £1,355; liability £271.00 less £240.20 paid =
  // £30.80.
  assert.equal(pushed[0]!.amount, "30.8000");
});
