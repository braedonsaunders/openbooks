import assert from "node:assert/strict";
import test from "node:test";
import {
  createSettlementPush,
  isFinalPeriodOfTaxYear,
  missingSettlementInputs,
  resolveAnnualSettlement,
  type PayrollAnnualSettlement,
} from "./annual-settlement.ts";
import type { PayrollCountryPack, PayrollTaxYearDefinition } from "./packs.ts";
import { PayrollPackError } from "./payroll-error.ts";

const CALENDAR: PayrollTaxYearDefinition = {
  basis: "calendar",
  startMonth: 1,
  startDay: 1,
  namedBy: "opening_year",
};

function packWith(
  settlement: PayrollAnnualSettlement | null,
): Pick<PayrollCountryPack, "statutorySlots"> & {
  annualSettlement?: (taxYear: number) => PayrollAnnualSettlement | null;
} {
  return {
    statutorySlots: [
      {
        key: "gensen",
        components: [
          {
            code: "GENSEN",
            name: "withholding income tax",
            systemKey: "income_tax",
            kind: "deduction",
            sequence: 110,
            assessedOn: "taxable_income",
            remittance: "tax_authority",
          },
        ],
      },
    ],
    annualSettlement: () => settlement,
  };
}

const DECLARATION: PayrollAnnualSettlement = {
  label: "settlement under test",
  citation: "test citation",
  mode: "adjustment_line",
  requiredEmployeeFacts: ["fact_a"],
  requiredCertificates: ["cert_b"],
  usesTenantRates: ["rate_c"],
  settlementSystemKey: "income_tax",
  compute: async () => ({}),
};

test("absent declaration resolves to no settlement — the monthly path is untouched", () => {
  assert.equal(resolveAnnualSettlement({}, 2026), null);
  assert.equal(
    resolveAnnualSettlement({ annualSettlement: () => null }, 2026),
    null,
  );
});

test("a settlement against a systemKey no slot declares is refused by name", () => {
  const bad: PayrollAnnualSettlement = {
    ...DECLARATION,
    settlementSystemKey: " bahn_bonus",
  };
  assert.throws(
    () =>
      resolveAnnualSettlement(
        packWith(bad) as PayrollCountryPack,
        2026,
      ),
    (error: unknown) =>
      error instanceof PayrollPackError
      && /bahn_bonus/.test(error.message)
      && /no statutory slot/.test(error.message),
  );
});

test("final-period gate: December closes a monthly calendar year, November does not", () => {
  assert.equal(isFinalPeriodOfTaxYear(CALENDAR, 12, "2026-12-15"), true);
  assert.equal(isFinalPeriodOfTaxYear(CALENDAR, 12, "2026-11-30"), false);
  assert.equal(isFinalPeriodOfTaxYear(CALENDAR, 12, "2026-01-31"), false);
});

test("final-period gate: a fiscal year closes the month before it opens", () => {
  const fiscal: PayrollTaxYearDefinition = {
    basis: "fiscal",
    startMonth: 4,
    startDay: 6,
    namedBy: "opening_year",
  };
  assert.equal(isFinalPeriodOfTaxYear(fiscal, 12, "2026-03-31"), true);
  assert.equal(isFinalPeriodOfTaxYear(fiscal, 12, "2026-04-30"), false);
});

test("final-period gate: non-monthly frequencies never settle (v1 is monthly only)", () => {
  assert.equal(isFinalPeriodOfTaxYear(CALENDAR, 26, "2026-12-31"), false);
  assert.equal(isFinalPeriodOfTaxYear(CALENDAR, 52, "2026-12-31"), false);
});

test("final-period gate refuses an unreadable pay date by name", () => {
  assert.throws(() => isFinalPeriodOfTaxYear(CALENDAR, 12, "not-a-date"), PayrollPackError);
});

test("missing-input scan names the undeclared fact AND the missing certificate", () => {
  const missing = missingSettlementInputs(DECLARATION, {
    emp: { fact_a: null },
    certificateFor: () => null,
  });
  assert.deepEqual(missing, ["employee fact fact_a", "certificate cert_b"]);
});

test("missing-input scan is silent when everything is declared", () => {
  const missing = missingSettlementInputs(DECLARATION, {
    emp: { fact_a: "1" },
    certificateFor: (key) =>
      key === "cert_b"
        ? ({ answers: {} }) as unknown as import("./certificates.ts").ResolvedCertificate
        : null,
  });
  assert.deepEqual(missing, []);
});

test("settlement push refuses a negative amount — direction rides the kind", () => {
  const pushed: string[] = [];
  const push = createSettlementPush(() => {
    pushed.push("pushed");
  });
  assert.throws(
    () => push("income_tax", "deduction", "settlement", "-1", 110),
    (error: unknown) =>
      error instanceof PayrollPackError && /negative/.test(error.message),
  );
  assert.deepEqual(pushed, []);
});

test("settlement push passes a positive refund credit through", () => {
  const seen: { kind: string; amount: string }[] = [];
  const push = createSettlementPush((systemKey, kind, _d, amount, _s) => {
    seen.push({ kind, amount });
    assert.equal(systemKey, "income_tax");
  });
  push("income_tax", "credit", "refund", "1200", 115);
  assert.deepEqual(seen, [{ kind: "credit", amount: "1200" }]);
});
