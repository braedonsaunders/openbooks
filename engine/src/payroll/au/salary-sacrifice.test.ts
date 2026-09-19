/**
 * AU salary sacrifice: the wrong-money defect, proved fixed (unit partition).
 *
 * Observed in the browser (APAC persona, Australian org): a $200 pre-tax
 * salary-sacrifice deduction left PAYG at exactly $806.00 whether the $200
 * was a stub adjustment, removed entirely, or a recurring component row —
 * while SG correctly stayed at $438.46. The taxable base handed to the
 * pack was built from earning lines only, so the deduction never reduced it.
 *
 * Hand-worked expectations below (Schedule 1 scale 2, fortnightly, resident
 * claiming the threshold, TFN quoted, no STSL — `lessThan: "2596"` row,
 * a = 0.3200, b = 181.7319):
 *
 *   full gross  3653.85: weekly equiv 3653.85/2 = 1826.925 → x = 1826.99.
 *     y = 0.3200×1826.99 − 181.7319 = 584.6368 − 181.7319 = 402.9049 → $403,
 *     fortnightly 403×2 = $806. SG = 3653.85×12% = 438.462 → $438.46.
 *   reduced     3453.85: weekly equiv 3453.85/2 = 1726.925 → x = 1726.99.
 *     y = 0.3200×1726.99 − 181.7319 = 552.6368 − 181.7319 = 370.9049 → $371,
 *     fortnightly 371×2 = $742. SG unchanged: 3653.85×12% = $438.46.
 *
 * A test showing only that the tax moved would pass a generic
 * `reducesTaxableIncome` boolean too — so this asserts BOTH: PAYG falls to
 * exactly $742.00 AND SG stays $438.46 to the cent. The boolean
 * implementation would have moved SG as well.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_EMPLOYER_LEVY_FACTORS } from "../statutory-context.ts";
import { reduceTaxBases } from "../treatment-bases.ts";
import { computeAuStatutory } from "./compute-statutory.ts";
import { AU_PAYROLL_PACK } from "./pack.ts";

const GROSS = "3653.8500";
const SACRIFICE = "200.0000";

const TFN_ANSWERS: Record<string, string | null> = {
  residency: "australian_resident",
  working_holiday_maker: null,
  tax_free_threshold: "true",
  tax_file_number: "123456782",
  stsl_debt: null,
};

async function runAuStatutory(sacrificeTreatment: string): Promise<{
  factors: Record<string, string>;
  pushed: { systemKey: string; amount: string }[];
}> {
  const lines = [
    { kind: "earning", amount: GROSS },
    { kind: "deduction", amount: SACRIFICE, taxTreatment: sacrificeTreatment },
  ];
  const reducedBases = reduceTaxBases(lines, {
    income: GROSS,
    nonPeriodic: "0.0000",
    pensionable: GROSS,
    insurable: GROSS,
  }, AU_PAYROLL_PACK.deductionTreatments);
  const pushed: { systemKey: string; amount: string }[] = [];
  const factors = await computeAuStatutory({
    tx: {} as never,
    orgId: "org",
    documentId: "doc",
    employeePartyId: "emp",
    employeeName: "Test Employee",
    taxYear: 2027,
    country: "AU",
    region: "NSW",
    run: { pay_date: "2026-07-16" },
    emp: {},
    filingAccountId: null,
    periodsPerYear: 26,
    income: GROSS,
    nonPeriodic: "0.0000",
    pensionable: GROSS,
    insurable: GROSS,
    reducedBases,
    deduction: () => "0.0000",
    pushStatutory: (systemKey, _kind, _description, amount, _sequence) => {
      pushed.push({ systemKey, amount });
    },
    storedCertificates: [],
    certificateFor: ((key: string) =>
      key === "au_tfn_declaration"
        ? { answers: TFN_ANSWERS, onFile: true }
        : null) as never,
    bool: (value) => value === "true",
    assertRegionSupported: () => {},
    employerLevies: EMPTY_EMPLOYER_LEVY_FACTORS,
  });
  return { factors, pushed };
}

const paygOf = (pushed: { systemKey: string; amount: string }[]): string =>
  pushed.find((line) => line.systemKey === "payg_withholding")?.amount ?? "missing";
const sgOf = (pushed: { systemKey: string; amount: string }[]): string =>
  pushed.find((line) => line.systemKey === "super_guarantee")?.amount ?? "missing";

test("a $200 salary sacrifice taxes on 3453.85: PAYG 742.00, SG unchanged 438.46", async () => {
  const { factors, pushed } = await runAuStatutory("salary_sacrifice");
  assert.equal(paygOf(pushed), "742.0000");
  assert.equal(sgOf(pushed), "438.4600");
  // The trace factor moves with the base it prices — the defect left I
  // stuck at the unreduced gross.
  assert.equal(factors["I"], "3453.8500");
  assert.equal(factors["PI"], GROSS);
});

test("control: the same $200 tagged after-tax withholds the defect's 806.00", async () => {
  const { pushed } = await runAuStatutory("none");
  assert.equal(paygOf(pushed), "806.0000");
  assert.equal(sgOf(pushed), "438.4600");
});
