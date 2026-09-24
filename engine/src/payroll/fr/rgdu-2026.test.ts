import assert from "node:assert/strict";
import test from "node:test";
import { calculateFrRgdu2026, frRgduSmicFromHours2026 } from "./rgdu-2026.ts";

test("D.241-7 prices contractual and eligible extra hours at the 1 January 2026 hourly SMIC", () => {
  // Décret n° 2025-1228 set the 1 January 2026 hourly SMIC at EUR 12.02;
  // CSS D.241-7 IV adds eligible overtime/complementary hours at that rate.
  // https://www.legifrance.gouv.fr/eli/decret/2025/12/17/2025-1228/jo/texte
  assert.equal(frRgduSmicFromHours2026("151.6667", "0"), "1823.0300");
  assert.equal(frRgduSmicFromHours2026("151.6667", "8"), "1919.1900");
});

test("URSSAF June 2026 full-time example calculates the RGDU reduction", () => {
  // URSSAF RGDU (2026) publishes a June example: 2,000 EUR, 35 hours/week,
  // full month, no overtime; a 70-person employer has coefficient 0.3178
  // and reduction 635.60 EUR.
  // https://www.urssaf.fr/accueil/employeur/beneficier-exonerations/reduction-generale-cotisation.html
  const result = calculateFrRgdu2026({
    employerEffectif: "70",
    eligible: true,
    remunerationYearToDate: "2000.00",
    smicYearToDate: "1823.03",
    priorReductionYearToDate: "0.00",
    urssafCoveredRate: "0.3420",
    agircArrcoCoveredRate: "0.0601",
  });
  assert.deepEqual(result, {
    coefficient: "0.3178",
    cumulativeReduction: "635.6000",
    periodAdjustment: "635.6000",
    urssafAdjustment: "540.6000",
    agircArrcoAdjustment: "95.0000",
    maximumCoefficient: "0.4021",
  });
});

test("URSSAF progressive regularization subtracts reductions from earlier pay periods", () => {
  // URSSAF's July example: cumulative remuneration 15,000 EUR, seven months,
  // prior reductions 3,347.50 EUR; cumulative target is 3,978 EUR.
  // https://www.urssaf.fr/accueil/employeur/beneficier-exonerations/reduction-generale-cotisation.html
  const result = calculateFrRgdu2026({
    employerEffectif: "70",
    eligible: true,
    remunerationYearToDate: "15000.00",
    smicYearToDate: "12761.21",
    priorReductionYearToDate: "3347.50",
    urssafCoveredRate: "0.3420",
    agircArrcoCoveredRate: "0.0601",
  });
  assert.deepEqual(result, {
    coefficient: "0.2652",
    cumulativeReduction: "3978.0000",
    periodAdjustment: "630.5000",
    urssafAdjustment: "536.2600",
    agircArrcoAdjustment: "94.2400",
    maximumCoefficient: "0.4021",
  });
});

test("the published Tdelta changes at the legal fifty-employee boundary", () => {
  const input = {
    eligible: true,
    remunerationYearToDate: "2000.00",
    smicYearToDate: "1823.03",
    priorReductionYearToDate: "0.00",
    urssafCoveredRate: "0.3380",
    agircArrcoCoveredRate: "0.0601",
  };
  assert.equal(calculateFrRgdu2026({ ...input, employerEffectif: "49.9999" }).coefficient, "0.3147");
  assert.equal(calculateFrRgdu2026({ ...input, employerEffectif: "50", urssafCoveredRate: "0.3420" }).coefficient, "0.3178");
});

test("Tdelta caps to covered rates and allocates the reduction by covered institution rates", () => {
  // CSS D.241-7 III and VI cap Tdelta to the employer's owed covered rate and
  // apportion Urssaf/Agirc-Arrco using each institution's covered rate.
  // https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000046843821
  const result = calculateFrRgdu2026({
    employerEffectif: "10.00",
    eligible: true,
    remunerationYearToDate: "100.00",
    smicYearToDate: "1823.03",
    priorReductionYearToDate: "0.00",
    urssafCoveredRate: "0.3200",
    agircArrcoCoveredRate: "0.0601",
  });
  assert.equal(result.maximumCoefficient, "0.3801");
  assert.equal(result.coefficient, "0.3801", "the low-wage coefficient is capped to the contributions owed");
  assert.equal(result.periodAdjustment, "38.0100");
  assert.equal(result.urssafAdjustment, "32.0000");
  assert.equal(result.agircArrcoAdjustment, "6.0100");
});

test("ineligible or over-ceiling remuneration has no cumulative reduction", () => {
  const base = {
    employerEffectif: "12",
    eligible: true,
    remunerationYearToDate: "5470.00",
    smicYearToDate: "1823.33",
    priorReductionYearToDate: "120.00",
    urssafCoveredRate: "0.3380",
    agircArrcoCoveredRate: "0.0601",
  };
  assert.equal(calculateFrRgdu2026({ ...base, eligible: false }).periodAdjustment, "-120.0000");
  assert.equal(calculateFrRgdu2026(base).cumulativeReduction, "0.0000");
});
