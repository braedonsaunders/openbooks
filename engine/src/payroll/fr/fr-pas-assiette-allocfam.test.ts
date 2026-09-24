/**
 * FR money-defect regressions: PAS assiette + allocations familiales taux réduit.
 *
 * Defect 1 — PAS base (CGI art. 204 A à 204 M; assiette précisée par BOFiP
 * BOI-IR-PAS-20-10-10, I-A §10: "l'assiette de la retenue à la source,
 * c'est-à-dire au montant imposable du revenu"). The pack priced the
 * transmitted/default rate on the brut; the statute prices it on the net
 * imposable (brut minus déductible lines, CSG 2,4 pts + CRDS added back:
 * CGI art. 83 1° and 154 quinquies — "la fraction restante de la CSG,
 * soit 2,4 points, demeure non déductible comme la CRDS").
 *
 * Defect 2 — allocations familiales (CSS art. L241-6-1, modalités art.
 * D241-3-1): 5,25 % generally, or 3,45 % for specified exemption/special-
 * regime employers below 3,5 × the 31-Dec-2023 SMIC (ceiling 73 382,40 €).
 * The pack applied 3,45 % based only on remuneration.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { toUnits } from "../../money/money.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import { reduceTaxBases } from "../treatment-bases.ts";
import { buildResolution } from "../statutory-rates.ts";
import type { StatutoryRateRow } from "../statutory-rates.ts";
import { calculateFrPas2026 } from "./compute-statutory.ts";
import {
  calculateFrCotisations2026,
  calculateFrNetImposable2026,
} from "./cotisations.ts";
import {
  FR_ALLOC_FAM_ER_2026,
  FR_ALLOC_FAM_SEUIL_2026,
  FR_SMIC_2026,
} from "./cotisations-2026.ts";
import { FR_PAYROLL_PACK } from "./pack.ts";
import { frAllocFamReducedEligible, FR_PACK_RATES } from "./statutory-rates.ts";

const PAY = "2026-06-15";
const COTS = { payDate: PAY, periodsPerYear: 12, employerEffectif: "10.00" } as const;

/** Adapter context for a métropole employee with a transmitted PAS rate. */
function ctxFor(brut: string, transmitted: string): PayrollStatutoryComputeContext {
  const pushed: { systemKey: string; kind: string; amount: string }[] = [];
  return {
    tx: { execute: async () => ({ rows: [{ fact_value: "10.00" }] }) } as never,
    orgId: "org",
    subsidiaryId: "legal-employer",
    documentId: "doc",
    employeePartyId: "emp",
    employeeName: "Test",
    taxYear: 2026,
    country: "FR",
    region: "FR",
    run: { pay_date: PAY },
    emp: {},
    filingAccountId: null,
    periodsPerYear: 12,
    income: brut,
    nonPeriodic: "0",
    pensionable: brut,
    insurable: "0",
    reducedBases: reduceTaxBases(
      [],
      { income: brut, nonPeriodic: "0", pensionable: brut, insurable: "0" },
      FR_PAYROLL_PACK.deductionTreatments,
    ),
    deduction: () => "0",
    pushStatutory: (systemKey, kind, _description, amount) => {
      pushed.push({ systemKey, kind, amount });
    },
    storedCertificates: [],
    certificateFor: (() => ({
      answers: {
        domicile: "metropole",
        taux_option: "personnalise",
        taux_transmis: transmitted,
      },
    })) as never,
    bool: () => false,
    assertRegionSupported: () => {},
    employerEmployeeCount: 10,
    employerLevies: {
      wcbAmount: "0",
      wcbAssessable: "0",
      ehtAmount: "0",
      ehtEarnings: "0",
      hsfAmount: "0",
      hsfEarnings: "0",
    },
  };
}

test("DEFECT 1: PAS prices the net imposable, not the brut (3 400 €, transmis 5 %)", () => {
  // Persona case: 3 400 € brut mensuel, taux personnalisé 5 %.
  // Pack (defective): 3 400 × 5 % = 170,00 €.
  const defective = calculateFrPas2026({
    base: "3400.00",
    payDate: PAY,
    periodsPerYear: 12,
    transmittedRatePct: "5",
    domicile: "metropole",
  });
  assert.equal(defective.pas, "170.0000");

  // Statute composition — each line hand-derived from the transcribed tables:
  // vieillesse 3 400 × 6,90 % = 234,60 + 3 400 × 0,40 % = 13,60 → 248,20 ;
  // CSG base 3 400 × 98,25 % = 3 340,50 : déductible 6,8 % = 227,15,
  // non déductible 2,4 % = 80,17 ; CRDS 0,50 % = 16,70 ;
  // ARRCO T1 3 400 × 7,87 % × 40 % = 107,03 ; CEG T1 3 400 × 2,15 % × 40 %
  // = 29,24 ; no CET (below the PASS).
  const net = calculateFrNetImposable2026({
    brut: "3400.00",
    payDate: PAY,
    periodsPerYear: 12,
  });
  assert.equal(net.vieillesseSal, "248.2000");
  assert.equal(net.csgDeductible, "227.1500");
  assert.equal(net.csgNonDeductible, "80.1700");
  assert.equal(net.crds, "16.7000");
  assert.equal(net.arrcoSal, "107.0300");
  assert.equal(net.cegSal, "29.2400");
  assert.equal(net.cetSal, "0.0000");
  assert.equal(net.netSocial, "2691.5100");
  // 3 400 − 248,20 − 227,15 − 107,03 − 29,24 = 2 788,38.
  assert.equal(net.netImposable, "2788.3800");

  // 2 788,38 × 5 % = 139,42 € — the statute figure, 30,58 €/month below
  // what the pack withheld.
  const statutory = calculateFrPas2026({
    base: net.netImposable,
    payDate: PAY,
    periodsPerYear: 12,
    transmittedRatePct: "5",
    domicile: "metropole",
  });
  assert.equal(statutory.pas, "139.4200");
});

test("adapter does not publish a complete payslip before unsupported RGDU is priced", async () => {
  await assert.rejects(
    FR_PAYROLL_PACK.computeStatutory(ctxFor("3400.00", "5")),
    /FR RGDU.*2026 reduction générale dégressive unifiée.*not calculated/,
  );
});

test("PAS assiette: CSG add-back identity holds below and above the PASS", () => {
  // netImposable = brut − déductibles; equivalently netSocial + CSG 2,4 pts
  // + CRDS + CET. If the add-back silently regressed to rate × brut, the
  // second identity breaks first.
  for (const brut of ["2000.00", "3400.00", "5000.00", "20000.00"]) {
    const net = calculateFrNetImposable2026({ brut, payDate: PAY, periodsPerYear: 12 });
    const cots = calculateFrCotisations2026({ brut, ...COTS });
    // The bridge reuses the cotisation lines exactly.
    assert.equal(net.vieillesseSal, cots.vieillesseSal, brut);
    assert.equal(net.csgDeductible, cots.csgNonImposable, brut);
    assert.equal(net.csgNonDeductible, cots.csgImposable, brut);
    assert.equal(net.crds, cots.crds, brut);
    assert.equal(net.arrcoSal, cots.arrcoSal, brut);
    assert.equal(net.cegSal, cots.cegSal, brut);
    assert.equal(net.cetSal, cots.cetSal, brut);
    // brut − déductibles form.
    const expected = toUnits(brut)
      - toUnits(net.vieillesseSal)
      - toUnits(net.csgDeductible)
      - toUnits(net.arrcoSal)
      - toUnits(net.cegSal);
    assert.equal(toUnits(net.netImposable), expected, brut);
    // net social + add-back form.
    const rebuilt = toUnits(net.netSocial)
      + toUnits(net.csgNonDeductible)
      + toUnits(net.crds)
      + toUnits(net.cetSal);
    assert.equal(toUnits(net.netImposable), rebuilt, brut);
  }
});

test("PAS assiette above the PASS: CET stays in the base (5 000 €)", () => {
  // 5 000 € brut: vieillesse 276,35 + 20,00 = 296,35 ; CSG base 4 912,50 :
  // déductible 334,05, non déductible 117,90 ; CRDS 24,56 ;
  // ARRCO sal 126,08 + 85,93 = 212,01 ; CEG sal 34,44 + 10,75 = 45,19 ;
  // CET applies (60 000 annualised > 48 060) : 5 000 × 0,14 % = 7,00 sal.
  const net = calculateFrNetImposable2026({
    brut: "5000.00",
    payDate: PAY,
    periodsPerYear: 12,
  });
  assert.equal(net.vieillesseSal, "296.3500");
  assert.equal(net.csgDeductible, "334.0500");
  assert.equal(net.csgNonDeductible, "117.9000");
  assert.equal(net.crds, "24.5600");
  assert.equal(net.arrcoSal, "212.0100");
  assert.equal(net.cegSal, "45.1900");
  assert.equal(net.cetSal, "7.0000");
  // 5 000 − 296,35 − 334,05 − 212,01 − 45,19 = 4 112,40 : the 7,00 € CET
  // is NOT subtracted.
  assert.equal(net.netImposable, "4112.4000");
});

test("eligible employer: 3 400 € annualises below 3.5×2023 SMIC → 3.45%", () => {
  // Only specified exemption/special-regime employers can use the reduced
  // rate; the €73,382.40 annual threshold is 3.5×the 31-Dec-2023 SMIC.
  const r = calculateFrCotisations2026({
    brut: "3400.00", ...COTS, allocFamReducedEligible: true,
  });
  assert.equal(r.allocFamErRate, FR_ALLOC_FAM_ER_2026.reduit.rate);
  assert.equal(r.allocFamErRate, "0.0345");
  assert.equal(r.allocFamEr, "117.3000");
});

test("eligible employer above the 2023-SMIC ceiling owes the 5.25% family rate", () => {
  // 7,000 × 12 exceeds the €73,382.40 reduced-rate ceiling.
  const r = calculateFrCotisations2026({
    brut: "7000.00", ...COTS, allocFamReducedEligible: true,
  });
  assert.equal(r.allocFamErRate, FR_ALLOC_FAM_ER_2026.plein.rate);
  assert.equal(r.allocFamErRate, "0.0525");
  assert.equal(r.allocFamEr, "367.5000");
});

test("eligible employer: reduced-rate threshold includes its €73,382.40 boundary", () => {
  // URSSAF keys this special reduced-rate threshold to the 31-Dec-2023 SMIC.
  const at = calculateFrCotisations2026({
    brut: "73382.40",
    payDate: PAY,
    periodsPerYear: 1,
    employerEffectif: "10.00",
    allocFamReducedEligible: true,
  });
  assert.equal(at.allocFamErRate, "0.0345");
  // 73 382,40 × 3,45 % = 2 532,6936 → 2 532,69.
  assert.equal(at.allocFamEr, "2531.6900");
  const over = calculateFrCotisations2026({
    brut: "73382.41",
    payDate: PAY,
    periodsPerYear: 1,
    employerEffectif: "10.00",
    allocFamReducedEligible: true,
  });
  assert.equal(over.allocFamErRate, "0.0525");
  // 73 382,41 × 5,25 % = 3 852,576525 → 3 852,58.
  assert.equal(over.allocFamEr, "3852.5800");
});

test("ordinary employer below the former 2026-SMIC cutoff still owes 5.25%", () => {
  const result = calculateFrCotisations2026({ brut: "6380.60", ...COTS });
  assert.equal(result.allocFamErRate, "0.0525");
  assert.equal(result.allocFamEr, "334.9800");
});

test("reduced-rate eligibility resolves only from the employer's account", () => {
  const rate: StatutoryRateRow = {
    id: "eligible-account",
    country: "FR",
    rateKey: "fr_allocfam",
    region: "FR",
    filingAccountId: "siret-eligible",
    taxYear: 2026,
    values: { reduced_rate_eligible: "true" },
    supersededOn: null,
  };
  const resolution = buildResolution({
    country: "FR", taxYear: 2026, pack: FR_PACK_RATES, rows: [rate], legacy: [],
  });
  assert.equal(frAllocFamReducedEligible(resolution, "FR", "siret-eligible"), true);
  assert.equal(frAllocFamReducedEligible(resolution, "FR", "siret-ordinary"), false);
  assert.equal(frAllocFamReducedEligible(resolution, "FR", null), false);
});

test("year values: reduced-rate threshold is tied to the 2023 SMIC", () => {
  assert.equal(FR_SMIC_2026.hourly, "12.02");
  assert.equal(FR_SMIC_2026.monthly, "1823.03");
  assert.equal(FR_SMIC_2026.annual, "21876.36");
  // Annual is monthly × 12, not an independent figure (bigint: floats lose it).
  assert.equal(toUnits(FR_SMIC_2026.annual), toUnits(FR_SMIC_2026.monthly) * 12n);
  // The ceiling is 3.5 × the 31-Dec-2023 annual SMIC, not the 2026 SMIC.
  assert.equal(FR_ALLOC_FAM_SEUIL_2026.multiple, "3.5");
  assert.equal(FR_ALLOC_FAM_SEUIL_2026.annual, "73382.40");
  assert.equal(FR_ALLOC_FAM_SEUIL_2026.referenceSmicAnnual, "20966.40");
  assert.equal(toUnits(FR_ALLOC_FAM_SEUIL_2026.annual), (toUnits(FR_ALLOC_FAM_SEUIL_2026.referenceSmicAnnual) * 35n) / 10n);
});
