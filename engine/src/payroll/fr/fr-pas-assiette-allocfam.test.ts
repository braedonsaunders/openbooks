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
 * D241-3-1): 3,45 % when the annualised remuneration does not exceed
 * 3,5 × SMIC (décret n° 2025-1228: 1 823,03 € mensuel, 21 876,36 € annuel;
 * ceiling 76 567,26 €), 5,25 % above. The pack charged 5,25 % flat.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { toUnits } from "../../money.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
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

const PAY = "2026-06-15";
const COTS = { payDate: PAY, periodsPerYear: 12, employerEmployeeCount: 10 } as const;

/** Adapter context for a métropole employee with a transmitted PAS rate. */
function ctxFor(brut: string, transmitted: string): PayrollStatutoryComputeContext {
  const pushed: { systemKey: string; kind: string; amount: string }[] = [];
  return {
    tx: null as never,
    orgId: "org",
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
    deduction: () => "0",
    pushStatutory: (systemKey, kind, _description, amount) => {
      pushed.push({ systemKey, kind, amount });
    },
    storedCertificates: [],
    certificateFor: (() => ({
      answers: {
        domicile: "metropole_hors_france",
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
    domicile: "metropole_hors_france",
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
    domicile: "metropole_hors_france",
  });
  assert.equal(statutory.pas, "139.4200");
});

test("DEFECT 1: adapter withholds 139,42 € (not 170,00 €) on 3 400 € + 5 %", async () => {
  const result = await FR_PAYROLL_PACK.computeStatutory(ctxFor("3400.00", "5"));
  assert.equal(result["BRUT"], "3400.0000");
  assert.equal(result["NET_IMPOSABLE"], "2788.3800");
  assert.equal(result["PAS"], "139.4200");
  assert.equal(result["TAUX_PAS"], "5.0000");
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

test("DEFECT 2: 3 400 € annualises below 3,5 SMIC → 3,45 % = 117,30 €", () => {
  // 3 400 × 12 = 40 800 ≤ 76 567,26 : réduit. Pack (defective) charged
  // 3 400 × 5,25 % = 178,50 €.
  const r = calculateFrCotisations2026({ brut: "3400.00", ...COTS });
  assert.equal(r.allocFamErRate, FR_ALLOC_FAM_ER_2026.reduit.rate);
  assert.equal(r.allocFamErRate, "0.0345");
  assert.equal(r.allocFamEr, "117.3000");
});

test("DEFECT 2: 7 000 € annualises above 3,5 SMIC → 5,25 % = 367,50 €", () => {
  // 7 000 × 12 = 84 000 > 76 567,26 : plein.
  const r = calculateFrCotisations2026({ brut: "7000.00", ...COTS });
  assert.equal(r.allocFamErRate, FR_ALLOC_FAM_ER_2026.plein.rate);
  assert.equal(r.allocFamErRate, "0.0525");
  assert.equal(r.allocFamEr, "367.5000");
});

test("DEFECT 2: the 3,5-SMIC boundary itself — at or below réduit, above plein", () => {
  // Annual pay hits the ceiling exactly: 76 567,26 annualised = ceiling →
  // réduit ("n'excède pas", CSS art. L241-6-1).
  const at = calculateFrCotisations2026({
    brut: "76567.26",
    payDate: PAY,
    periodsPerYear: 1,
    employerEmployeeCount: 10,
  });
  assert.equal(at.allocFamErRate, "0.0345");
  // 76 567,26 × 3,45 % = 2 641,57047 → 2 641,57.
  assert.equal(at.allocFamEr, "2641.5700");
  const over = calculateFrCotisations2026({
    brut: "76567.27",
    payDate: PAY,
    periodsPerYear: 1,
    employerEmployeeCount: 10,
  });
  assert.equal(over.allocFamErRate, "0.0525");
  // 76 567,27 × 5,25 % = 4 019,781675 → 4 019,78.
  assert.equal(over.allocFamEr, "4019.7800");
});

test("DEFECT 2: monthly edges around 3,5 × SMIC mensuel (6 380,605 €)", () => {
  // 6 380,60 × 12 = 76 567,20 ≤ 76 567,26 → réduit;
  // 6 380,61 × 12 = 76 567,32 > 76 567,26 → plein.
  const under = calculateFrCotisations2026({ brut: "6380.60", ...COTS });
  assert.equal(under.allocFamErRate, "0.0345");
  // 6 380,60 × 3,45 % = 220,1307 → 220,13.
  assert.equal(under.allocFamEr, "220.1300");
  const above = calculateFrCotisations2026({ brut: "6380.61", ...COTS });
  assert.equal(above.allocFamErRate, "0.0525");
  // 6 380,61 × 5,25 % = 334,982025 → 334,98.
  assert.equal(above.allocFamEr, "334.9800");
});

test("year values: SMIC 2026 and the 3,5-SMIC ceiling assert their relationships", () => {
  assert.equal(FR_SMIC_2026.hourly, "12.02");
  assert.equal(FR_SMIC_2026.monthly, "1823.03");
  assert.equal(FR_SMIC_2026.annual, "21876.36");
  // Annual is monthly × 12, not an independent figure (bigint: floats lose it).
  assert.equal(toUnits(FR_SMIC_2026.annual), toUnits(FR_SMIC_2026.monthly) * 12n);
  // The ceiling is 3,5 × SMIC annuel, not an independent figure.
  assert.equal(FR_ALLOC_FAM_SEUIL_2026.multiple, "3.5");
  assert.equal(FR_ALLOC_FAM_SEUIL_2026.annual, "76567.26");
  assert.equal(toUnits(FR_ALLOC_FAM_SEUIL_2026.annual), (toUnits(FR_SMIC_2026.annual) * 35n) / 10n);
});
