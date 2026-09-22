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
  codes: Record<string, Record<string, string | null>>,
): PayrollStatutoryComputeContext["certificateFor"] {
  return ((key: string) => {
    const answers = codes[key];
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
  codes?: Record<string, Record<string, string | null>>;
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
    certificateFor: certificateForCodes(overrides.codes ?? {}),
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
  // Month 1, £4,000, 1257L cumulative from zero priors: free pay 1,048.25
  // (12,579 × 1/12 — the code's allowance), taxable 2,951.75 at 20% →
  // £590.35. NIC from the 2025 thresholds at the 15% employer rate:
  // employee (4,000 − 1,048) × 8% = £236.16; employer (4,000 − 417) × 15% =
  // £537.45.
  const { ctx, pushed } = gbContext({
    payDate: "2025-04-06",
    taxYear: 2025,
    tx: stubTx(EMPTY_YTD),
    income: "4000",
    pensionable: "4000",
    codes: NOTICE_1257L,
  });
  const factors = await computeGbStatutory(ctx);
  assert.equal(factors.GB_TAX, "590.3500");
  assert.deepEqual(pushed.map((line) => line.amount), ["590.3500", "236.1600", "537.4500"]);
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
  // Month 1, £2,250, S1257L cumulative from zero priors: free pay 1,048.25,
  // taxable 1,201.75, through the month-1 bands (starter £331, basic
  // £1,413): 331 × 19% = £62.89 plus 870.75 × 20% = £174.15 → £237.04.
  // NIC is the same UK-wide schedule as rUK.
  const { ctx, pushed } = gbContext({
    region: "SCT",
    tx: stubTx(EMPTY_YTD),
    income: "2250",
    pensionable: "2250",
    codes: { gb_tax_code_notice: { tax_code: "S1257L", non_cumulative: null } },
  });
  const factors = await computeGbStatutory(ctx);
  assert.equal(pushed[0]!.amount, "237.0400");
  assert.equal(factors.GB_TAX, "237.0400");
});

test("an S-code prices Scottish bands in any region; SBR is whole-pay 20%", async () => {
  const { ctx, pushed } = gbContext({
    region: "ENG",
    income: "3200",
    pensionable: "3200",
    codes: { gb_tax_code_notice: { tax_code: "SBR", non_cumulative: null } },
  });
  const factors = await computeGbStatutory(ctx);
  assert.equal(pushed[0]!.amount, "640.0000");
  assert.equal(factors.GB_TAX, "640.0000");
});

test("a missing coding notice is refused, naming the P6/P9", async () => {
  const { ctx } = gbContext({ codes: {} });
  await assert.rejects(() => computeGbStatutory(ctx), /gb_tax_code_notice/);
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
  const factors = await computeGbStatutory(ctx);
  // NIC still prices £5,000 monthly: (4,189 − 1,048) × 8% = £251.28 plus
  // (5,000 − 4,189) × 2% = £16.22 = £267.50; employer (5,000 − 417) × 15%.
  assert.deepEqual(
    pushed.map((line) => [line.systemKey, line.kind, line.amount]),
    [
      ["paye", "deduction", "0.0000"],
      ["nic", "deduction", "267.5000"],
      ["nic", "employer_contribution", "687.4500"],
    ],
  );
  assert.equal(factors.GB_TAX, "0.0000");
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
      ["nic", "employer_contribution", "417.4500"],
    ],
  );
  assert.deepEqual(factors, {
    GB_TAXABLE: "3200.0000",
    GB_ADDPAY: "0.0000",
    GB_TAX: "640.0000",
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
      ["paye", "deduction", "240.3500"],
      ["nic", "deduction", "96.1600"],
      ["nic", "employer_contribution", "274.9500"],
    ],
  );
  assert.equal(factors.GB_TAXABLE, "2250.0000");
  assert.equal(factors.GB_TAX, "240.3500");
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
  // Month 8 with first-year pay of £9,000: free pay to date
  // 12,579 × 8/12 = £8,386, taxable £614, due £122.80 — the A declaration
  // makes zero priors the truth.
  const { ctx, pushed } = gbContext({
    payDate: "2026-11-06",
    tx: stubTx(EMPTY_YTD),
    income: "9000",
    pensionable: "2250",
    codes: {
      ...NOTICE_1257L,
      gb_starter_checklist: { starter_declaration: "A", student_loan_plan: "none" },
    },
  });
  await computeGbStatutory(ctx);
  assert.equal(pushed[0]!.amount, "122.8000");
});

test("stubs spanning the year start price with priors applied", async () => {
  const { ctx, pushed } = gbContext({
    payDate: "2026-06-06",
    tx: stubTx({
      taxable: "2250.0000",
      addpay: "0",
      tax: "240.3500",
      stub_count: "1",
      first_pay: "2026-04-06",
    }),
    income: "2250",
    pensionable: "2250",
    codes: NOTICE_1257L,
  });
  await computeGbStatutory(ctx);
  // Free pay to date £3,144.75; cumulative £4,500; taxable £1,355.25;
  // liability £271.05 less £240.35 paid = £30.70.
  assert.equal(pushed[0]!.amount, "30.7000");
});
