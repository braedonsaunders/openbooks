/**
 * Connecticut income-tax withholding — TPG-211 calculation rules.
 *
 * Source (fetched from portal.ct.gov, not memory):
 *   TPG-211, 2026 Withholding Calculation Rules (Rev. 12/25),
 *     https://portal.ct.gov/-/media/drs/forms/2025/wth/tpg-211_1225.pdf
 *     — Steps 1–16; Tables A–E; "The 2026 withholding calculation rules and
 *       2026 withholding tables are unchanged from 2025."
 *   Informational Publication 2026(1), Connecticut Employer's Tax Guide,
 *     Circular CT, https://portal.ct.gov/-/media/drs/publications/pubsip/2026/ip-2026-1.pdf
 *     — no completed CT-W4 → 6.99% with no exemption; Form CT-W4 lines 2 and 3;
 *       supplemental wages paid separately are recomputed on regular + bonus
 *       minus tax already withheld from the regular check (not a flat rate).
 *   Form CT-W4 (Rev. 12/25) — withholding codes A, B, C, D, E, F.
 *
 * TPG-211: "There is no percentage method available to determine Connecticut
 * wage withholding." The engine is these calculation rules, not the wage-bracket
 * tables. Circular CT Example 9 prints a weekly $1,000 / Code A table figure
 * of $39.97; the calculation rules on the same facts are a different cent
 * amount, pinned in the conformance test so the two methods are not collapsed.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. No floats.
 */
import { D, divIntCents, max0, mulRateCents, U } from "../../canada/decimal.ts";
import { certificateAmount, certificateChoice } from "../../certificates.ts";
import type { PayrollTaxYearEdition } from "../../tax-years.ts";
import { pctToRate } from "./transcription.ts";
import {
  refuseUntranscribedYear,
  type UsStateWithholdingEngine,
  type UsStateWithholdingInput,
  type UsStateWithholdingResult,
} from "./types.ts";

const RATES_MODULE = "engine/src/payroll/us/states/ct.ts";

export type CtWithholdingCode = "A" | "B" | "C" | "D" | "F";

export interface CtYearRates {
  year: number;
  status: "published" | "draft";
  /** Circular CT: no completed CT-W4 withholds this flat rate, no exemption. */
  noCertificateRate: string;
}

export const CT_RATES_2026: CtYearRates = {
  year: 2026,
  status: "published",
  noCertificateRate: pctToRate("6.99"),
};

const CT_EDITIONS_BY_YEAR: Record<number, CtYearRates> = {
  [CT_RATES_2026.year]: CT_RATES_2026,
};

export const CT_TAX_YEAR_EDITIONS: readonly PayrollTaxYearEdition[] = [{
  year: 2026,
  label: "TPG-211 2026 Withholding Calculation Rules (Rev. 12/25)",
  effectiveFrom: "2026-01-01",
  citation:
    "Connecticut DRS, TPG-211, 2026 Withholding Calculation Rules (Rev. 12/25); "
    + "Informational Publication 2026(1), Circular CT; Form CT-W4 (Rev. 12/25)",
  status: "published",
  region: "CT",
}];

export function ctRatesForPayDate(payDate: string): CtYearRates {
  const year = Number(payDate.slice(0, 4));
  const rates = CT_EDITIONS_BY_YEAR[year];
  if (!rates || rates.status !== "published") {
    refuseUntranscribedYear(CT_WITHHOLDING, year);
  }
  return rates;
}

const THOUSAND = U("1000");

/**
 * Table A — Personal Exemptions.
 *
 * Each code phases the printed first-band exemption out by $1,000 for each
 * $1,000 (or fraction) of annualized salary above the first ceiling, then
 * zero. Code D is $0 on every salary. TPG-211: "For Withholding Code D, the
 * Personal Exemption is $0".
 */
export function ctPersonalExemption(code: CtWithholdingCode, annualSalary: bigint): bigint {
  if (code === "D") return 0n;
  const first = {
    A: { upTo: U("24000"), exemption: U("12000") },
    B: { upTo: U("38000"), exemption: U("19000") },
    C: { upTo: U("48000"), exemption: U("24000") },
    F: { upTo: U("30000"), exemption: U("15000") },
  }[code];
  if (annualSalary <= first.upTo) return first.exemption;
  const steps = (annualSalary - first.upTo + THOUSAND - 1n) / THOUSAND;
  return max0(first.exemption - steps * THOUSAND);
}

interface TaxBand {
  upTo: string | null;
  base: string;
  over: string;
  rate: string;
}

/** Table B — Initial Tax Calculation. Addends are the publication's own. */
const TABLE_B: Record<CtWithholdingCode, readonly TaxBand[]> = {
  A: [
    { upTo: "10000", base: "0", over: "0", rate: pctToRate("2") },
    { upTo: "50000", base: "200", over: "10000", rate: pctToRate("4.5") },
    { upTo: "100000", base: "2000", over: "50000", rate: pctToRate("5.5") },
    { upTo: "200000", base: "4750", over: "100000", rate: pctToRate("6") },
    { upTo: "250000", base: "10750", over: "200000", rate: pctToRate("6.5") },
    { upTo: "500000", base: "14000", over: "250000", rate: pctToRate("6.9") },
    { upTo: null, base: "31250", over: "500000", rate: pctToRate("6.99") },
  ],
  F: [
    { upTo: "10000", base: "0", over: "0", rate: pctToRate("2") },
    { upTo: "50000", base: "200", over: "10000", rate: pctToRate("4.5") },
    { upTo: "100000", base: "2000", over: "50000", rate: pctToRate("5.5") },
    { upTo: "200000", base: "4750", over: "100000", rate: pctToRate("6") },
    { upTo: "250000", base: "10750", over: "200000", rate: pctToRate("6.5") },
    { upTo: "500000", base: "14000", over: "250000", rate: pctToRate("6.9") },
    { upTo: null, base: "31250", over: "500000", rate: pctToRate("6.99") },
  ],
  D: [
    { upTo: "10000", base: "0", over: "0", rate: pctToRate("2") },
    { upTo: "50000", base: "200", over: "10000", rate: pctToRate("4.5") },
    { upTo: "100000", base: "2000", over: "50000", rate: pctToRate("5.5") },
    { upTo: "200000", base: "4750", over: "100000", rate: pctToRate("6") },
    { upTo: "250000", base: "10750", over: "200000", rate: pctToRate("6.5") },
    { upTo: "500000", base: "14000", over: "250000", rate: pctToRate("6.9") },
    { upTo: null, base: "31250", over: "500000", rate: pctToRate("6.99") },
  ],
  B: [
    { upTo: "16000", base: "0", over: "0", rate: pctToRate("2") },
    { upTo: "80000", base: "320", over: "16000", rate: pctToRate("4.5") },
    { upTo: "160000", base: "3200", over: "80000", rate: pctToRate("5.5") },
    { upTo: "320000", base: "7600", over: "160000", rate: pctToRate("6") },
    { upTo: "400000", base: "17200", over: "320000", rate: pctToRate("6.5") },
    { upTo: "800000", base: "22400", over: "400000", rate: pctToRate("6.9") },
    { upTo: null, base: "50000", over: "800000", rate: pctToRate("6.99") },
  ],
  C: [
    { upTo: "20000", base: "0", over: "0", rate: pctToRate("2") },
    { upTo: "100000", base: "400", over: "20000", rate: pctToRate("4.5") },
    { upTo: "200000", base: "4000", over: "100000", rate: pctToRate("5.5") },
    { upTo: "400000", base: "9500", over: "200000", rate: pctToRate("6") },
    { upTo: "500000", base: "21500", over: "400000", rate: pctToRate("6.5") },
    { upTo: "1000000", base: "28000", over: "500000", rate: pctToRate("6.9") },
    { upTo: null, base: "62500", over: "1000000", rate: pctToRate("6.99") },
  ],
};

export function ctInitialTax(code: CtWithholdingCode, taxable: bigint): bigint {
  for (const band of TABLE_B[code]) {
    if (band.upTo === null || taxable <= U(band.upTo)) {
      return U(band.base) + mulRateCents(max0(taxable - U(band.over)), band.rate);
    }
  }
  throw new Error(`Connecticut Table B is incomplete for ${code}`);
}

interface StepBand {
  moreThan: string;
  upTo: string | null;
  amount: string;
}

function lookupStep(salary: bigint, bands: readonly StepBand[]): bigint {
  for (const band of bands) {
    if (salary > U(band.moreThan) && (band.upTo === null || salary <= U(band.upTo))) {
      return U(band.amount);
    }
  }
  return 0n;
}

/** Table C — 2% Tax Rate Phase-Out Add-Back, transcribed from TPG-211. */
const TABLE_C: Record<CtWithholdingCode, readonly StepBand[]> = {
  A: [
    { moreThan: "50250", upTo: "52750", amount: "25" },
    { moreThan: "52750", upTo: "55250", amount: "50" },
    { moreThan: "55250", upTo: "57750", amount: "75" },
    { moreThan: "57750", upTo: "60250", amount: "100" },
    { moreThan: "60250", upTo: "62750", amount: "125" },
    { moreThan: "62750", upTo: "65250", amount: "150" },
    { moreThan: "65250", upTo: "67750", amount: "175" },
    { moreThan: "67750", upTo: "70250", amount: "200" },
    { moreThan: "70250", upTo: "72750", amount: "225" },
    { moreThan: "72750", upTo: null, amount: "250" },
  ],
  D: [
    { moreThan: "50250", upTo: "52750", amount: "25" },
    { moreThan: "52750", upTo: "55250", amount: "50" },
    { moreThan: "55250", upTo: "57750", amount: "75" },
    { moreThan: "57750", upTo: "60250", amount: "100" },
    { moreThan: "60250", upTo: "62750", amount: "125" },
    { moreThan: "62750", upTo: "65250", amount: "150" },
    { moreThan: "65250", upTo: "67750", amount: "175" },
    { moreThan: "67750", upTo: "70250", amount: "200" },
    { moreThan: "70250", upTo: "72750", amount: "225" },
    { moreThan: "72750", upTo: null, amount: "250" },
  ],
  B: [
    { moreThan: "78500", upTo: "82500", amount: "40" },
    { moreThan: "82500", upTo: "86500", amount: "80" },
    { moreThan: "86500", upTo: "90500", amount: "120" },
    { moreThan: "90500", upTo: "94500", amount: "160" },
    { moreThan: "94500", upTo: "98500", amount: "200" },
    { moreThan: "98500", upTo: "102500", amount: "240" },
    { moreThan: "102500", upTo: "106500", amount: "280" },
    { moreThan: "106500", upTo: "110500", amount: "320" },
    { moreThan: "110500", upTo: "114500", amount: "360" },
    { moreThan: "114500", upTo: null, amount: "400" },
  ],
  C: [
    { moreThan: "100500", upTo: "105500", amount: "50" },
    { moreThan: "105500", upTo: "110500", amount: "100" },
    { moreThan: "110500", upTo: "115500", amount: "150" },
    { moreThan: "115500", upTo: "120500", amount: "200" },
    { moreThan: "120500", upTo: "125500", amount: "250" },
    { moreThan: "125500", upTo: "130500", amount: "300" },
    { moreThan: "130500", upTo: "135500", amount: "350" },
    { moreThan: "135500", upTo: "140500", amount: "400" },
    { moreThan: "140500", upTo: "145500", amount: "450" },
    { moreThan: "145500", upTo: null, amount: "500" },
  ],
  F: [
    { moreThan: "56500", upTo: "61500", amount: "25" },
    { moreThan: "61500", upTo: "66500", amount: "50" },
    { moreThan: "66500", upTo: "71500", amount: "75" },
    { moreThan: "71500", upTo: "76500", amount: "100" },
    { moreThan: "76500", upTo: "81500", amount: "125" },
    { moreThan: "81500", upTo: "86500", amount: "150" },
    { moreThan: "86500", upTo: "91500", amount: "175" },
    { moreThan: "91500", upTo: "96500", amount: "200" },
    { moreThan: "96500", upTo: "101500", amount: "225" },
    { moreThan: "101500", upTo: null, amount: "250" },
  ],
};

export function ctPhaseOutAddBack(code: CtWithholdingCode, annualSalary: bigint): bigint {
  return lookupStep(annualSalary, TABLE_C[code]);
}

/**
 * Table D — Tax Recapture. Encoded from the printed breakpoints: $25 per
 * $5,000 from $105,000 to $150,000 (A/D/F), a $250 plateau to $200,000, then
 * $90 per $5,000 to $345,000, a $2,950 plateau to $500,000, then $50 per
 * $5,000 to the $3,400 cap. B and C use the publication's own step and caps.
 */
function recaptureStepped(
  salary: bigint,
  start: bigint,
  step: bigint,
  increment: bigint,
  plateauFrom: bigint,
  plateauAmount: bigint,
  secondStart: bigint,
  secondIncrement: bigint,
  secondPlateauFrom: bigint,
  secondPlateau: bigint,
  tailStart: bigint,
  tailIncrement: bigint,
  capFrom: bigint,
  cap: bigint,
): bigint {
  if (salary <= start) return 0n;
  if (salary <= plateauFrom) {
    const steps = (salary - start + step - 1n) / step;
    return steps * increment;
  }
  if (salary <= secondStart) return plateauAmount;
  if (salary <= secondPlateauFrom) {
    const steps = (salary - secondStart + step - 1n) / step;
    return plateauAmount + secondIncrement + (steps - 1n) * secondIncrement;
  }
  if (salary <= tailStart) return secondPlateau;
  if (salary <= capFrom) {
    const steps = (salary - tailStart + step - 1n) / step;
    return secondPlateau + tailIncrement + (steps - 1n) * tailIncrement;
  }
  return cap;
}

export function ctTaxRecapture(code: CtWithholdingCode, annualSalary: bigint): bigint {
  if (code === "A" || code === "D" || code === "F") {
    return recaptureStepped(
      annualSalary,
      U("105000"), U("5000"), U("25"),
      U("150000"), U("250"),
      U("200000"), U("90"),
      U("345000"), U("2950"),
      U("500000"), U("50"),
      U("540000"), U("3400"),
    );
  }
  if (code === "B") {
    return recaptureStepped(
      annualSalary,
      U("168000"), U("8000"), U("40"),
      U("240000"), U("400"),
      U("320000"), U("140"),
      U("552000"), U("4600"),
      U("800000"), U("80"),
      U("864000"), U("5320"),
    );
  }
  return recaptureStepped(
    annualSalary,
    U("210000"), U("10000"), U("50"),
    U("300000"), U("500"),
    U("400000"), U("180"),
    U("690000"), U("5900"),
    U("1000000"), U("100"),
    U("1080000"), U("6800"),
  );
}

interface CreditBand {
  moreThan: string;
  upTo: string | null;
  credit: string;
}

/** Table E — Personal Tax Credits. Code D is 0.00 on every salary. */
const TABLE_E: Record<Exclude<CtWithholdingCode, "D">, readonly CreditBand[]> = {
  A: [
    { moreThan: "12000", upTo: "15000", credit: "0.75" },
    { moreThan: "15000", upTo: "15500", credit: "0.70" },
    { moreThan: "15500", upTo: "16000", credit: "0.65" },
    { moreThan: "16000", upTo: "16500", credit: "0.60" },
    { moreThan: "16500", upTo: "17000", credit: "0.55" },
    { moreThan: "17000", upTo: "17500", credit: "0.50" },
    { moreThan: "17500", upTo: "18000", credit: "0.45" },
    { moreThan: "18000", upTo: "18500", credit: "0.40" },
    { moreThan: "18500", upTo: "20000", credit: "0.35" },
    { moreThan: "20000", upTo: "20500", credit: "0.30" },
    { moreThan: "20500", upTo: "21000", credit: "0.25" },
    { moreThan: "21000", upTo: "21500", credit: "0.20" },
    { moreThan: "21500", upTo: "25000", credit: "0.15" },
    { moreThan: "25000", upTo: "25500", credit: "0.14" },
    { moreThan: "25500", upTo: "26000", credit: "0.13" },
    { moreThan: "26000", upTo: "26500", credit: "0.12" },
    { moreThan: "26500", upTo: "27000", credit: "0.11" },
    { moreThan: "27000", upTo: "48000", credit: "0.10" },
    { moreThan: "48000", upTo: "48500", credit: "0.09" },
    { moreThan: "48500", upTo: "49000", credit: "0.08" },
    { moreThan: "49000", upTo: "49500", credit: "0.07" },
    { moreThan: "49500", upTo: "50000", credit: "0.06" },
    { moreThan: "50000", upTo: "50500", credit: "0.05" },
    { moreThan: "50500", upTo: "51000", credit: "0.04" },
    { moreThan: "51000", upTo: "51500", credit: "0.03" },
    { moreThan: "51500", upTo: "52000", credit: "0.02" },
    { moreThan: "52000", upTo: "52500", credit: "0.01" },
    { moreThan: "52500", upTo: null, credit: "0.00" },
  ],
  B: [
    { moreThan: "19000", upTo: "24000", credit: "0.75" },
    { moreThan: "24000", upTo: "24500", credit: "0.70" },
    { moreThan: "24500", upTo: "25000", credit: "0.65" },
    { moreThan: "25000", upTo: "25500", credit: "0.60" },
    { moreThan: "25500", upTo: "26000", credit: "0.55" },
    { moreThan: "26000", upTo: "26500", credit: "0.50" },
    { moreThan: "26500", upTo: "27000", credit: "0.45" },
    { moreThan: "27000", upTo: "27500", credit: "0.40" },
    { moreThan: "27500", upTo: "34000", credit: "0.35" },
    { moreThan: "34000", upTo: "34500", credit: "0.30" },
    { moreThan: "34500", upTo: "35000", credit: "0.25" },
    { moreThan: "35000", upTo: "35500", credit: "0.20" },
    { moreThan: "35500", upTo: "44000", credit: "0.15" },
    { moreThan: "44000", upTo: "44500", credit: "0.14" },
    { moreThan: "44500", upTo: "45000", credit: "0.13" },
    { moreThan: "45000", upTo: "45500", credit: "0.12" },
    { moreThan: "45500", upTo: "46000", credit: "0.11" },
    { moreThan: "46000", upTo: "74000", credit: "0.10" },
    { moreThan: "74000", upTo: "74500", credit: "0.09" },
    { moreThan: "74500", upTo: "75000", credit: "0.08" },
    { moreThan: "75000", upTo: "75500", credit: "0.07" },
    { moreThan: "75500", upTo: "76000", credit: "0.06" },
    { moreThan: "76000", upTo: "76500", credit: "0.05" },
    { moreThan: "76500", upTo: "77000", credit: "0.04" },
    { moreThan: "77000", upTo: "77500", credit: "0.03" },
    { moreThan: "77500", upTo: "78000", credit: "0.02" },
    { moreThan: "78000", upTo: "78500", credit: "0.01" },
    { moreThan: "78500", upTo: null, credit: "0.00" },
  ],
  C: [
    { moreThan: "24000", upTo: "30000", credit: "0.75" },
    { moreThan: "30000", upTo: "30500", credit: "0.70" },
    { moreThan: "30500", upTo: "31000", credit: "0.65" },
    { moreThan: "31000", upTo: "31500", credit: "0.60" },
    { moreThan: "31500", upTo: "32000", credit: "0.55" },
    { moreThan: "32000", upTo: "32500", credit: "0.50" },
    { moreThan: "32500", upTo: "33000", credit: "0.45" },
    { moreThan: "33000", upTo: "33500", credit: "0.40" },
    { moreThan: "33500", upTo: "40000", credit: "0.35" },
    { moreThan: "40000", upTo: "40500", credit: "0.30" },
    { moreThan: "40500", upTo: "41000", credit: "0.25" },
    { moreThan: "41000", upTo: "41500", credit: "0.20" },
    { moreThan: "41500", upTo: "50000", credit: "0.15" },
    { moreThan: "50000", upTo: "50500", credit: "0.14" },
    { moreThan: "50500", upTo: "51000", credit: "0.13" },
    { moreThan: "51000", upTo: "51500", credit: "0.12" },
    { moreThan: "51500", upTo: "52000", credit: "0.11" },
    { moreThan: "52000", upTo: "96000", credit: "0.10" },
    { moreThan: "96000", upTo: "96500", credit: "0.09" },
    { moreThan: "96500", upTo: "97000", credit: "0.08" },
    { moreThan: "97000", upTo: "97500", credit: "0.07" },
    { moreThan: "97500", upTo: "98000", credit: "0.06" },
    { moreThan: "98000", upTo: "98500", credit: "0.05" },
    { moreThan: "98500", upTo: "99000", credit: "0.04" },
    { moreThan: "99000", upTo: "99500", credit: "0.03" },
    { moreThan: "99500", upTo: "100000", credit: "0.02" },
    { moreThan: "100000", upTo: "100500", credit: "0.01" },
    { moreThan: "100500", upTo: null, credit: "0.00" },
  ],
  F: [
    { moreThan: "15000", upTo: "18800", credit: "0.75" },
    { moreThan: "18800", upTo: "19300", credit: "0.70" },
    { moreThan: "19300", upTo: "19800", credit: "0.65" },
    { moreThan: "19800", upTo: "20300", credit: "0.60" },
    { moreThan: "20300", upTo: "20800", credit: "0.55" },
    { moreThan: "20800", upTo: "21300", credit: "0.50" },
    { moreThan: "21300", upTo: "21800", credit: "0.45" },
    { moreThan: "21800", upTo: "22300", credit: "0.40" },
    { moreThan: "22300", upTo: "25000", credit: "0.35" },
    { moreThan: "25000", upTo: "25500", credit: "0.30" },
    { moreThan: "25500", upTo: "26000", credit: "0.25" },
    { moreThan: "26000", upTo: "26500", credit: "0.20" },
    { moreThan: "26500", upTo: "31300", credit: "0.15" },
    { moreThan: "31300", upTo: "31800", credit: "0.14" },
    { moreThan: "31800", upTo: "32300", credit: "0.13" },
    { moreThan: "32300", upTo: "32800", credit: "0.12" },
    { moreThan: "32800", upTo: "33300", credit: "0.11" },
    { moreThan: "33300", upTo: "60000", credit: "0.10" },
    { moreThan: "60000", upTo: "60500", credit: "0.09" },
    { moreThan: "60500", upTo: "61000", credit: "0.08" },
    { moreThan: "61000", upTo: "61500", credit: "0.07" },
    { moreThan: "61500", upTo: "62000", credit: "0.06" },
    { moreThan: "62000", upTo: "62500", credit: "0.05" },
    { moreThan: "62500", upTo: "63000", credit: "0.04" },
    { moreThan: "63000", upTo: "63500", credit: "0.03" },
    { moreThan: "63500", upTo: "64000", credit: "0.02" },
    { moreThan: "64000", upTo: "64500", credit: "0.01" },
    { moreThan: "64500", upTo: null, credit: "0.00" },
  ],
};

export function ctPersonalCredit(code: CtWithholdingCode, annualSalary: bigint): string {
  if (code === "D") return "0.00";
  for (const band of TABLE_E[code]) {
    if (annualSalary > U(band.moreThan) && (band.upTo === null || annualSalary <= U(band.upTo))) {
      return band.credit;
    }
  }
  return "0.00";
}

function compute(input: UsStateWithholdingInput): UsStateWithholdingResult {
  const rates = ctRatesForPayDate(input.payDate);
  const P = input.periodsPerYear;
  if (!Number.isInteger(P) || P < 1 || P > 2000) {
    throw new Error(`invalid pay periods per year for Connecticut withholding: ${P}`);
  }
  const factors: Record<string, string> = {};
  const trace = (key: string, value: bigint) => { factors[key] = D(value); };

  const codeRaw = certificateChoice(input.certificate, "withholding_code");
  if (codeRaw === "E") {
    trace("CT_EXEMPT", 1n);
    return { state: "CT", year: rates.year, tax: D(0n), taxSupplemental: D(0n), factors };
  }

  // Circular CT: paid with regular wages, add them and run the rules once.
  // Separately-paid supplementals are a two-check recompute the engine is
  // not given last-period regular tax for — not a silent 6.99%.
  const wages = U(input.wages) + U(input.supplemental ?? "0");

  if (codeRaw == null) {
    const flat = mulRateCents(wages, rates.noCertificateRate);
    factors.CT_NO_CERTIFICATE = "1";
    trace("CT_TAX", flat);
    return { state: "CT", year: rates.year, tax: D(flat), taxSupplemental: D(0n), factors };
  }
  if (codeRaw !== "A" && codeRaw !== "B" && codeRaw !== "C" && codeRaw !== "D" && codeRaw !== "F") {
    throw new Error(`Connecticut withholding code "${codeRaw}" is not A, B, C, D, E, or F`);
  }
  const code = codeRaw;

  const annualWages = wages * BigInt(P);
  trace("CT_ANNUAL_WAGES", annualWages);

  const exemption = ctPersonalExemption(code, annualWages);
  trace("CT_EXEMPTION", exemption);

  const taxable = max0(annualWages - exemption);
  trace("CT_TAXABLE", taxable);

  if (taxable === 0n) {
    const extraOnly = max0(
      U(certificateAmount(input.certificate, "additional_per_period") ?? "0")
      - U(certificateAmount(input.certificate, "reduced_per_period") ?? "0"),
    );
    trace("CT_TAX", extraOnly);
    return { state: "CT", year: rates.year, tax: D(extraOnly), taxSupplemental: D(0n), factors };
  }

  const initial = ctInitialTax(code, taxable);
  trace("CT_INITIAL_TAX", initial);
  const phaseOut = ctPhaseOutAddBack(code, annualWages);
  trace("CT_PHASE_OUT", phaseOut);
  const recapture = ctTaxRecapture(code, annualWages);
  trace("CT_RECAPTURE", recapture);
  const beforeCredit = initial + phaseOut + recapture;
  trace("CT_BEFORE_CREDIT", beforeCredit);

  const credit = ctPersonalCredit(code, annualWages);
  factors.CT_CREDIT = credit;
  const keep = D(U("1") - U(credit));
  const afterCredit = mulRateCents(beforeCredit, keep);
  trace("CT_AFTER_CREDIT", afterCredit);

  const periodTax = divIntCents(afterCredit, P);
  trace("CT_PERIOD_TAX", periodTax);

  const extra = U(certificateAmount(input.certificate, "additional_per_period") ?? "0");
  const reduced = U(certificateAmount(input.certificate, "reduced_per_period") ?? "0");
  const total = max0(periodTax + extra - reduced);
  trace("CT_WITHHELD", total);

  return {
    state: "CT",
    year: rates.year,
    tax: D(total),
    taxSupplemental: D(0n),
    factors,
  };
}

export const CT_WITHHOLDING: UsStateWithholdingEngine = {
  state: "CT",
  label: "Connecticut income tax",
  certificateKey: "us_ct_ctw4",
  ratesModule: RATES_MODULE,
  editions: CT_TAX_YEAR_EDITIONS,
  printedPeriods: null,
  compute,
};
