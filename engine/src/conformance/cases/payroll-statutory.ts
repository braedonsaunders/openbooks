/**
 * Payroll statutory deductions and withholding — CRA T4127 (Canada), IRS
 * Publication 15-T and the Code's FICA provisions (United States), and one
 * state-booklet sample (Alabama).
 *
 * These cases drive the product's actual statutory engines — `calculateT4127`
 * (the CRA guide's Option-1 periodic method in the guide's own factor
 * notation), `calculatePub15T` (Worksheet 1A plus FICA/FUTA), and Alabama's
 * booklet formula engine — with every figure hand-worked in `facts` through
 * the guide's formulas step by step, independent of the engine code. A case
 * that recomputed the answer itself would prove nothing.
 *
 * Out-of-scope methods the guides define but the product does not implement
 * are published as gaps at the end, never silently omitted.
 */

import "../../payroll/packs.ts";
import { calculateT4127 } from "../../payroll/canada/t4127.ts";
import { calculatePub15T } from "../../payroll/us/pub15t.ts";
import { AL_CERTIFICATE, AL_WITHHOLDING } from "../../payroll/us/states/al.ts";
import { resolvedCertificate } from "../../payroll/us/states/conformance-support.ts";
import type { ConformanceCase } from "../types.ts";

export const PAYROLL_STATUTORY_CASES: readonly ConformanceCase[] = [
  {
    id: "payroll-cpp-ei-basic",
    title: "Weekly CPP and EI apply at statutory rates within their maxima",
    citations: [
      {
        standard: "CRA T4127",
        reference: "T4127 122nd edition — CPP/QPP and EI factors (C, EI)",
        kind: "requirement",
        requirement:
          "Each pay period deducts CPP on pensionable earnings above the per-period exemption up to the annual maximum, and EI on insurable earnings up to its annual maximum, with the employer paying the matching and 1.4x shares.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "A $1,500.00 weekly Saskatchewan pay deducts $85.25 of CPP and $24.45 of EI, and the employer accrues $85.25 and $34.23 — every figure the guide's per-period formulas produce, with neither maximum yet in reach.",
    facts: [
      "Pay date 2026-01-15 (122nd edition), Saskatchewan, 52 pay periods, pensionable and insurable earnings of $1,500.00, no year-to-date balances.",
      "CPP exemption for weekly pay is $67.30; contributory earnings are 1,500.00 − 67.30 = $1,432.70.",
      "CPP is 1,432.70 × 5.95% = 85.24565, rounded half-up to $85.25 — within the $4,230.45 maximum, and below the YMPE so no second-tier contribution.",
      "EI is 1,500.00 × 1.63% = $24.45 — within the $1,123.07 maximum.",
      "Employer CPP matches at $85.25; employer EI is 24.45 × 1.4 = $34.23.",
      "The enhanced-CPP income deduction (F5) is 85.25 × 1.00/5.95 = $14.33, carried wholly against periodic pay.",
      "Annual taxable income is (1,500.00 − 14.33) × 52 = $77,254.84; federal tax on it is $8,869.87 and Saskatchewan tax is $5,938.39, so the period withholding is (8,869.87 + 5,938.39) / 52 = $284.77.",
    ],
    expected: {
      values: {
        cpp: "85.2500",
        cpp2: "0.0000",
        cppEmployer: "85.2500",
        ei: "24.4500",
        eiEmployer: "34.2300",
        qpip: "0.0000",
        f5: "14.3300",
        periodicTax: "284.7700",
        bonusTax: "0.0000",
        totalTax: "284.7700",
      },
    },
    run: () => {
      const result = calculateT4127({
        payDate: "2026-01-15",
        province: "SK",
        periodsPerYear: 52,
        income: "1500.00",
      });
      return {
        values: {
          cpp: result.cpp,
          cpp2: result.cpp2,
          cppEmployer: result.cppEmployer,
          ei: result.ei,
          eiEmployer: result.eiEmployer,
          qpip: result.qpip,
          f5: result.f5,
          periodicTax: result.periodicTax,
          bonusTax: result.bonusTax,
          totalTax: result.totalTax,
        },
      };
    },
  },

  {
    id: "payroll-cpp2-second-tier",
    title: "Earnings above the YMPE attract the second-tier CPP2 contribution",
    citations: [
      {
        standard: "CRA T4127",
        reference: "T4127 122nd edition — second-additional factor (C2, W)",
        kind: "requirement",
        requirement:
          "Pensionable earnings in the band between the YMPE and the YAMPE attract the second-additional contribution at 4%, bounded by its own annual maximum and year-to-date room.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "An employee whose year-to-date pensionable earnings reach $74,000.00 pays $56.00 of CPP2 on a $2,000.00 biweekly pay — 4% on exactly the $1,400.00 of the band this period enters — while base CPP continues against its own remaining room.",
    facts: [
      "Pay date 2026-01-15, Saskatchewan, 26 pay periods, pensionable earnings of $2,000.00.",
      "Year-to-date with this employer: pensionable $74,000.00, CPP $4,000.00, CPP2 $0.00.",
      "2026 YMPE is $74,600.00 and YAMPE is $85,000.00, so W is max(74,000.00, 74,600.00) = $74,600.00.",
      "This period enters the band by 74,000.00 + 2,000.00 − 74,600.00 = $1,400.00; CPP2 is 1,400.00 × 4% = $56.00, within the $416.00 maximum.",
      "Base CPP is min(4,230.45 − 4,000.00, (2,000.00 − 134.61) × 5.95%) = min(230.45, 110.99) = $110.99.",
    ],
    expected: {
      values: {
        cpp: "110.9900",
        cpp2: "56.0000",
        cppEmployer: "166.9900",
        ei: "32.6000",
        eiEmployer: "45.6400",
      },
    },
    run: () => {
      const result = calculateT4127({
        payDate: "2026-01-15",
        province: "SK",
        periodsPerYear: 26,
        income: "2000.00",
        ytd: { cpp: "4000.00", cpp2: "0.00", pensionable: "74000.00" },
      });
      return {
        values: {
          cpp: result.cpp,
          cpp2: result.cpp2,
          cppEmployer: result.cppEmployer,
          ei: result.ei,
          eiEmployer: result.eiEmployer,
        },
      };
    },
  },

  {
    id: "payroll-ei-max-stops-premium",
    title: "EI premiums stop once the annual maximum is reached",
    citations: [
      {
        standard: "CRA T4127",
        reference: "T4127 122nd edition — EI maximum (D1)",
        kind: "requirement",
        requirement:
          "EI premiums for the year cannot exceed the annual maximum; once year-to-date premiums reach it, further insurable earnings in the year attract no premium.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "An employee who has already paid the full $1,123.07 of EI pays $0.00 on a further $2,000.00 of insurable earnings — while CPP, which has its own maximum still unreached, continues at $110.99.",
    facts: [
      "Pay date 2026-01-15, Saskatchewan, 26 pay periods, insurable and pensionable earnings of $2,000.00.",
      "Year-to-date EI premiums of $1,123.07 — the 2026 maximum exactly.",
      "EI room is 1,123.07 − 1,123.07 = $0.00, so this period's premium is $0.00 and the employer share is $0.00.",
      "CPP is unaffected by the EI maximum: (2,000.00 − 134.61) × 5.95% = $110.99.",
    ],
    expected: {
      values: {
        cpp: "110.9900",
        ei: "0.0000",
        eiEmployer: "0.0000",
      },
    },
    run: () => {
      const result = calculateT4127({
        payDate: "2026-01-15",
        province: "SK",
        periodsPerYear: 26,
        income: "2000.00",
        ytd: { ei: "1123.07" },
      });
      return {
        values: { cpp: result.cpp, ei: result.ei, eiEmployer: result.eiEmployer },
      };
    },
  },

  {
    id: "payroll-quebec-qpip-abatement",
    title: "Québec pay carries QPP, QPIP and reduced EI with the federal abatement",
    citations: [
      {
        standard: "CRA T4127",
        reference: "T4127 122nd edition — Quebec factors (QPP, QPIP, abatement)",
        kind: "requirement",
        requirement:
          "Québec employment uses QPP rates for pensions, QPIP premiums for parental insurance, the reduced Québec EI rate, and the 16.5% federal abatement in place of provincial income tax under T4127.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "A $1,500.00 weekly Québec pay deducts $90.26 of QPP, $19.50 of EI at the Québec rate, and $6.45 of QPIP, while federal tax is reduced by the 16.5% abatement to a $141.63 period withholding — with no provincial T4127 tax, which Revenu Québec administers separately.",
    facts: [
      "Pay date 2026-01-15, Québec, 52 pay periods, earnings of $1,500.00, no year-to-date balances.",
      "QPP is (1,500.00 − 67.30) × 6.30% = 90.2601, rounded to $90.26 — within the $4,479.30 maximum.",
      "EI at the Québec rate is 1,500.00 × 1.30% = $19.50; employer EI is 19.50 × 1.4 = $27.30.",
      "QPIP is 1,500.00 × 0.43% = $6.45; employer QPIP is 1,500.00 × 0.602% = $9.03.",
      "The F5 deduction is 90.26 × 1.00/6.30 = $14.33, giving the same $77,254.84 annual income as the matching non-Québec pay.",
      "The K2 credit basis annualizes the base share of QPP (90.26 × 52 = 4,693.52, base share $3,948.52) capped at the QPP base maximum of $3,768.30 — not the CPP cap — plus EI capped at the Québec maximum of $895.70 and QPIP of $335.40, for K2 of (3,768.30 + 895.70 + 335.40) × 14% = $699.92.",
      "Federal gross tax is $8,819.90; less the 16.5% abatement of $1,455.28, federal tax is $7,364.62.",
      "The period withholding is 7,364.62 / 52 = $141.63.",
    ],
    expected: {
      values: {
        cpp: "90.2600",
        cpp2: "0.0000",
        ei: "19.5000",
        eiEmployer: "27.3000",
        qpip: "6.4500",
        qpipEmployer: "9.0300",
        periodicTax: "141.6300",
        totalTax: "141.6300",
      },
    },
    run: () => {
      const result = calculateT4127({
        payDate: "2026-01-15",
        province: "QC",
        periodsPerYear: 52,
        income: "1500.00",
      });
      return {
        values: {
          cpp: result.cpp,
          cpp2: result.cpp2,
          ei: result.ei,
          eiEmployer: result.eiEmployer,
          qpip: result.qpip,
          qpipEmployer: result.qpipEmployer,
          periodicTax: result.periodicTax,
          totalTax: result.totalTax,
        },
      };
    },
  },

  {
    id: "payroll-bonus-lump-sum-rate",
    title: "A small bonus is taxed at the lump-sum rate, not the marginal rate",
    citations: [
      {
        standard: "CRA T4127",
        reference: "T4127 122nd edition — tax on non-periodic payments (TB)",
        kind: "requirement",
        requirement:
          "When annualized income including the bonus does not exceed $5,000, tax on the bonus is a flat 10% in Québec and 15% elsewhere; larger bonuses are taxed at the marginal difference.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "A $2,000.00 bonus paid with no other income in the year attracts exactly $300.00 of tax at the 15% lump-sum rate — while CPP and EI still apply to the bonus as pensionable and insurable earnings.",
    facts: [
      "Pay date 2026-01-15, Ontario, 52 pay periods, periodic income of $0.00 with a $2,000.00 bonus.",
      "Annualized income with the bonus is $1,980.67 after the $19.33 F5 bonus split — at or below $5,000, so the flat rate applies.",
      "Bonus tax is 2,000.00 × 15% = $300.00; periodic tax is $0.00.",
      "CPP on the bonus is (2,000.00 − 67.30) × 5.95% = 114.99565, rounded to $115.00.",
      "EI on the bonus is 2,000.00 × 1.63% = $32.60.",
    ],
    expected: {
      values: {
        cpp: "115.0000",
        ei: "32.6000",
        eiEmployer: "45.6400",
        periodicTax: "0.0000",
        bonusTax: "300.0000",
        totalTax: "300.0000",
      },
    },
    run: () => {
      const result = calculateT4127({
        payDate: "2026-01-15",
        province: "ON",
        periodsPerYear: 52,
        income: "0.00",
        nonPeriodic: "2000.00",
      });
      return {
        values: {
          cpp: result.cpp,
          ei: result.ei,
          eiEmployer: result.eiEmployer,
          periodicTax: result.periodicTax,
          bonusTax: result.bonusTax,
          totalTax: result.totalTax,
        },
      };
    },
  },

  {
    id: "payroll-us-fit-fica-basic",
    title: "US federal withholding follows Worksheet 1A with FICA alongside",
    citations: [
      {
        standard: "IRS Pub 15-T",
        reference: "Pub 15-T Worksheet 1A (percentage method)",
        kind: "requirement",
        requirement:
          "Withholding annualizes periodic wages, adjusts per the W-4, looks the result up in the annual percentage-method schedule, and de-annualizes — rounding half-up at each worksheet line.",
      },
      {
        standard: "IRC 3101/3111",
        reference: "IRC 3101(a)-(b) / 3111(a)-(b) — OASDI and Hospital Insurance rates",
        kind: "requirement",
        requirement:
          "Social Security tax is 6.2% of wages to the annual wage base and Medicare tax is 1.45% of all wages, each matched equally by the employer.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "A single filer earning $3,000.00 biweekly withholds $320.38 of federal income tax — $8,330.00 of tentative annual tax de-annualized over 26 periods — plus $186.00 of Social Security and $43.50 of Medicare, each matched by the employer.",
    facts: [
      "Pay date 2026-03-15 (2026 edition), single filing status, 26 pay periods, wages of $3,000.00, no W-4 adjustments beyond the standard.",
      "Annualized wages are 3,000.00 × 26 = $78,000.00; less the $8,600.00 W-4 wage adjustment, the adjusted annual wage amount is $69,400.00.",
      "The single STANDARD schedule row is $57,900.00 plus 22% of the excess: 5,800.00 + (69,400.00 − 57,900.00) × 22% = 5,800.00 + 2,530.00 = $8,330.00.",
      "De-annualized withholding is 8,330.00 / 26 = $320.38.",
      "Social Security is 3,000.00 × 6.2% = $186.00, within the $184,500.00 wage base; Medicare is 3,000.00 × 1.45% = $43.50.",
    ],
    expected: {
      values: {
        fit: "320.3800",
        ss: "186.0000",
        ssEmployer: "186.0000",
        medicare: "43.5000",
        medicareEmployer: "43.5000",
        additionalMedicare: "0.0000",
      },
    },
    run: () => {
      const result = calculatePub15T({
        payDate: "2026-03-15",
        periodsPerYear: 26,
        wages: "3000.00",
        filingStatus: "single",
      });
      return {
        values: {
          fit: result.fit,
          ss: result.ss,
          ssEmployer: result.ssEmployer,
          medicare: result.medicare,
          medicareEmployer: result.medicareEmployer,
          additionalMedicare: result.additionalMedicare,
        },
      };
    },
  },

  {
    id: "payroll-us-supplemental-medicare-cap",
    title: "Supplemental wages past $1M and wages past the Social Security base are handled exactly",
    citations: [
      {
        standard: "IRS Pub 15",
        reference: "Pub 15 section 7 — supplemental wage withholding",
        kind: "requirement",
        requirement:
          "Supplemental wages are withheld at the 22% flat rate, except that wages past $1,000,000 of year-to-date supplemental pay are withheld at the mandatory 37%.",
      },
      {
        standard: "IRC 3101/3111",
        reference: "IRC 3101(b)(2) — Additional Hospital Insurance Tax",
        kind: "requirement",
        requirement:
          "Additional Medicare tax of 0.9% applies to wages above $200,000 (employee only, no employer match), while Social Security stops at the wage base.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "A $200,000.00 bonus on top of $900,000.00 of prior supplemental pay withholds $59,000.00 — $100,000.00 at 22% and $100,000.00 at the mandatory 37% — while Social Security caps at $11,439.00, Medicare runs uncapped at $2,943.50, and Additional Medicare takes $27.00 on the slice above $200,000.00.",
    facts: [
      "Pay date 2026-03-15, single, 26 pay periods, periodic wages of $3,000.00 plus a $200,000.00 bonus; $900,000.00 of prior supplemental pay.",
      "The first $100,000.00 of the bonus (up to the $1,000,000.00 threshold) is withheld at 22% = $22,000.00; the remaining $100,000.00 at 37% = $37,000.00; supplemental withholding is $59,000.00.",
      "FICA wages are 203,000.00: Social Security taxes min(203,000.00, 184,500.00) = 184,500.00 × 6.2% = $11,439.00.",
      "Medicare is 203,000.00 × 1.45% = $2,943.50.",
      "Additional Medicare is (203,000.00 − 200,000.00) × 0.9% = $27.00, employee only.",
      "FUTA is min(203,000.00, 7,000.00) × 0.6% = $42.00, employer only.",
    ],
    expected: {
      values: {
        fitSupplemental: "59000.0000",
        ss: "11439.0000",
        medicare: "2943.5000",
        additionalMedicare: "27.0000",
        futa: "42.0000",
      },
    },
    run: () => {
      const result = calculatePub15T({
        payDate: "2026-03-15",
        periodsPerYear: 26,
        wages: "3000.00",
        supplemental: "200000.00",
        filingStatus: "single",
        ytd: { supplemental: "900000.00", ssWages: "0.00", medicareWages: "0.00" },
      });
      return {
        values: {
          fitSupplemental: result.fitSupplemental,
          ss: result.ss,
          medicare: result.medicare,
          additionalMedicare: result.additionalMedicare,
          futa: result.futa,
        },
      };
    },
  },

  {
    id: "payroll-us-al-booklet-sample",
    title: "Alabama withholding reproduces the booklet's official worked example",
    citations: [
      {
        standard: "AL DOR",
        reference: "Withholding Tax Tables and Instructions, rev. Aug 2024 — official M-2 / $850 example",
        kind: "illustrative-example",
        requirement:
          "The booklet's formula on a married employee with 2 dependents earning $850.00 weekly and $35.19 of federal withholding produces $29.59 of Alabama withholding.",
      },
    ],
    support: "supported",
    tier: "computation",
    assertion:
      "Annualized income of $44,200.00 less the $5,000.00 standard deduction, $3,000.00 personal exemption, $2,000.00 of dependent allowances and $1,829.88 of annualized federal tax leaves the booklet's taxable figure, and the engine's $29.59 matches the printed answer to the cent.",
    facts: [
      "Married employee, exemption M with 2 dependents, $850.00 weekly, federal withholding of $35.19 for the period.",
      "Annualized gross is 850.00 × 52 = $44,200.00; standard deduction $5,000.00; personal exemption $3,000.00; dependents 2 × $1,000.00 = $2,000.00.",
      "Annualized federal tax is 35.19 × 52 = $1,829.88.",
      "Withholding for the period is $29.59 — the booklet's printed figure.",
    ],
    expected: {
      values: { tax: "29.5900", alGrossIncome: "44200.0000" },
    },
    run: () => {
      const result = AL_WITHHOLDING.compute({
        payDate: "2026-03-15",
        periodsPerYear: 52,
        wages: "850.00",
        basis: "resident",
        federalIncomeTax: "35.19",
        certificate: resolvedCertificate(AL_CERTIFICATE, { exemption: "M", dependents: "2" }),
      });
      return {
        values: { tax: result.tax, alGrossIncome: result.factors.AL_GI! },
      };
    },
  },

  {
    id: "payroll-cumulative-averaging",
    title: "Cumulative averaging (Option 2) for uneven pay",
    citations: [
      {
        standard: "CRA T4127",
        reference: "T4127 — Option 2 cumulative averaging",
        kind: "requirement",
        requirement:
          "An employer paying uneven amounts through the year may average income tax deductions cumulatively so employees with lumpy pay are not over-withheld early in the year.",
      },
    ],
    support: "not-implemented",
    tier: "computation",
    assertion:
      "An employee paid unevenly through the year has income tax averaged cumulatively across elapsed periods, so a large early payment does not over-withhold against the annual liability.",
    facts: [
      "An employee earns $60,000.00 in the first quarter and $10,000.00 per quarter after.",
      "Under Option 1 each period annualizes its own pay; under Option 2 the deduction averages cumulative income over elapsed periods.",
      "The required outcome is the cumulative-average deduction for the current period.",
    ],
    gap:
      "The engine implements only the Option-1 periodic method (plus the YTD variant of the K2 credit basis, which is not Option 2). There is no cumulative-averaging computation: uneven pay is annualized period by period, which over-withholds early lump sums relative to the guide's Option 2.",
    expected: {
      values: { periodicTax: "0.0000" },
    },
  },

  {
    id: "payroll-quebec-provincial-tax",
    title: "Québec provincial income tax (TP-1015)",
    citations: [
      {
        standard: "CRA T4127",
        reference: "T4127 — Quebec provincial tax administered via TP-1015",
        kind: "requirement",
        requirement:
          "Québec employees have provincial income tax withheld under Revenu Québec's TP-1015 source-deduction tables in addition to the federal tax T4127 computes.",
      },
    ],
    support: "not-implemented",
    tier: "computation",
    assertion:
      "A Québec pay deducts provincial income tax per the TP-1015 tables alongside federal tax, QPP, QPIP and EI — the stub's total withholding is complete for a Québec employee.",
    facts: [
      "Québec employment: T4127 covers the federal side (including the abatement) plus QPP, QPIP and EI.",
      "Provincial income tax under TP-1015 is a further required deduction on the same pay.",
      "The required outcome is the TP-1015 provincial withholding for the period.",
    ],
    gap:
      "Québec provincial income tax is not implemented: the engine computes the federal side for Québec employment (abatement, K2Q, QPP/QPIP) and provincials for every other jurisdiction, but TP-1015 tables are absent, so a Québec stub understates total withholding by the provincial share.",
    expected: {
      values: { provincialTax: "0.0000" },
    },
  },
];
