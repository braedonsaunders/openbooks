/**
 * FR cotisation conformance goldens, calendar 2026.
 *
 * Mechanism 1 (agency's own published output): the URSSAF taux-secteur-privé
 * page publishes RATES, not worked examples — no agency hand-worked payslip
 * exists to reproduce. The mechanism-1 goldens therefore pin every
 * transcribed constant against the page's quoted figure (table integrity:
 * any drift in a rate, the PASS, or the 4×PASS cap relationship fails
 * loudly), and every engine golden below prices from those tables with the
 * arithmetic shown (mechanism 2, independent of the engine code).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { toUnits } from "../../money.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import { reduceTaxBases } from "../treatment-bases.ts";
import { calculateFrCotisations2026 } from "./cotisations.ts";
import {
  FR_AGS_ER_2026,
  FR_ALLOC_FAM_ER_2026,
  FR_CHOMAGE_ER_2026,
  FR_CRDS_SAL_2026,
  FR_CSA_ER_2026,
  FR_CSG_SAL_2026,
  FR_DIALOGUE_SOCIAL_ER_2026,
  FR_FNAL_ER_2026,
  FR_MALADIE_ER_2026,
  FR_PASS_2026_URSSAF,
  FR_QUATRE_PASS_2026,
  FR_VIEILLESSE_ER_2026,
  FR_VIEILLESSE_SAL_2026,
} from "./cotisations-2026.ts";
import { FR_PAYROLL_PACK } from "./pack.ts";

const small = { brut: "2000.00", payDate: "2026-06-15", periodsPerYear: 12, employerEmployeeCount: 10 } as const;

test("table integrity: every transcribed rate matches its page quote", () => {
  // Taux patronaux.
  assert.equal(FR_MALADIE_ER_2026.plein.rate, "0.13");
  assert.equal(FR_MALADIE_ER_2026.reduit.rate, "0.07");
  assert.equal(FR_CSA_ER_2026.rate, "0.003");
  assert.equal(FR_VIEILLESSE_ER_2026.deplafonnee.rate, "0.0211");
  assert.equal(FR_VIEILLESSE_ER_2026.plafonnee.rate, "0.0855");
  assert.equal(FR_ALLOC_FAM_ER_2026.plein.rate, "0.0525");
  assert.equal(FR_ALLOC_FAM_ER_2026.reduit.rate, "0.0345");
  assert.equal(FR_DIALOGUE_SOCIAL_ER_2026.rate, "0.00016");
  assert.equal(FR_CHOMAGE_ER_2026.rate.rate, "0.04");
  assert.equal(FR_AGS_ER_2026.rate.rate, "0.0025");
  assert.equal(FR_AGS_ER_2026.interimVariant.rate, "0.0003");
  assert.equal(FR_FNAL_ER_2026.moins50.rate, "0.001");
  assert.equal(FR_FNAL_ER_2026.cinquanteEtPlus.rate, "0.005");
  // Taux salariaux.
  assert.equal(FR_VIEILLESSE_SAL_2026.deplafonnee.rate, "0.004");
  assert.equal(FR_VIEILLESSE_SAL_2026.plafonnee.rate, "0.069");
  assert.equal(FR_CSG_SAL_2026.abattement, "0.9825");
  assert.equal(FR_CSG_SAL_2026.imposable.rate, "0.024");
  assert.equal(FR_CSG_SAL_2026.nonImposable.rate, "0.068");
  assert.equal(FR_CRDS_SAL_2026.rate, "0.005");
  // PASS corroborated by the plafonds page; the 192 240 € caps are 4×PASS.
  assert.equal(FR_PASS_2026_URSSAF.annual, "48060");
  assert.equal(FR_PASS_2026_URSSAF.monthly, "4005");
  assert.equal(FR_QUATRE_PASS_2026, "192240");
  assert.equal(String(Number(FR_PASS_2026_URSSAF.annual) * 4), FR_QUATRE_PASS_2026);
  assert.equal(FR_CHOMAGE_ER_2026.capAnnual, FR_QUATRE_PASS_2026);
  assert.equal(FR_AGS_ER_2026.capAnnual, FR_QUATRE_PASS_2026);
  assert.equal(FR_CSG_SAL_2026.capAnnual, FR_QUATRE_PASS_2026);
});

test("hand-worked: 2 000 € brut, monthly, 10 salariés — every line", () => {
  const r = calculateFrCotisations2026({ ...small });
  // Employee: 2 000 × 6,90 % = 138,00 plafonnée; 2 000 × 0,40 % = 8,00.
  assert.equal(r.vieillesseSalPlafonnee, "138.0000");
  assert.equal(r.vieillesseSalDeplafonnee, "8.0000");
  assert.equal(r.vieillesseSal, "146.0000");
  // Abated base 2 000 × 98,25 % = 1 965,00 (NOT 2 000 — the defect guard).
  assert.equal(r.csgBase, "1965.0000");
  // 1 965 × 2,40 % = 47,16; 1 965 × 6,80 % = 133,62; total 180,78.
  assert.equal(r.csgImposable, "47.1600");
  assert.equal(r.csgNonImposable, "133.6200");
  assert.equal(r.csg, "180.7800");
  // 1 965 × 0,50 % = 9,825 → 9,83 half-up.
  assert.equal(r.crds, "9.8300");
  // Employer plein rates: 2 000 × 13 % = 260,00 maladie (NOT the 7 % réduit).
  assert.equal(r.maladieEr, "260.0000");
  // 2 000 × 8,55 % = 171,00 + 2 000 × 2,11 % = 42,20 → 213,20.
  assert.equal(r.vieillesseErPlafonnee, "171.0000");
  assert.equal(r.vieillesseErDeplafonnee, "42.2000");
  assert.equal(r.vieillesseEr, "213.2000");
  // 2 000 € annualises to 24 000 €, below the 76 567,26 € ceiling
  // (3,5 × SMIC, CSS art. L241-6-1) → 2 000 × 3,45 % = 69,00.
  assert.equal(r.allocFamErRate, "0.0345");
  assert.equal(r.allocFamEr, "69.0000");
  // 2 000 × 4 % = 80,00 chômage; 2 000 × 0,25 % = 5,00 AGS.
  assert.equal(r.chomageEr, "80.0000");
  assert.equal(r.agsEr, "5.0000");
  // FNAL < 50: 2 000 × 0,10 % = 2,00; CSA 2 000 × 0,30 % = 6,00;
  // dialogue 2 000 × 0,016 % = 0,32 → CDN 8,32.
  assert.equal(r.fnalEr, "2.0000");
  assert.equal(r.csaEr, "6.0000");
  assert.equal(r.dialogueEr, "0.3200");
  assert.equal(r.cdnEr, "8.3200");
  // Undeclared tenant rates price at zero and are pushed nowhere.
  assert.equal(r.atmpEr, "0.0000");
  assert.equal(r.versementMobiliteEr, "0.0000");
});

test("hand-worked: 20 000 € brut, monthly, 60 salariés — capped lines", () => {
  const r = calculateFrCotisations2026({
    brut: "20000.00", payDate: "2026-06-15", periodsPerYear: 12, employerEmployeeCount: 60,
  });
  // Plafond mensuel 4 005: 4 005 × 6,90 % = 276,345 → 276,35 half-up.
  assert.equal(r.vieillesseSalPlafonnee, "276.3500");
  assert.equal(r.vieillesseSalDeplafonnee, "80.0000");
  assert.equal(r.vieillesseSal, "356.3500");
  // 4 × PASS monthly 16 020: abated 16 020 × 98,25 % = 15 739,65.
  assert.equal(r.csgBase, "15739.6500");
  // 15 739,65 × 2,40 % = 377,7516 → 377,75;
  // 15 739,65 × 6,80 % = 1 070,2962 → 1 070,30; total 1 448,05.
  assert.equal(r.csgImposable, "377.7500");
  assert.equal(r.csgNonImposable, "1070.3000");
  assert.equal(r.csg, "1448.0500");
  // 15 739,65 × 0,50 % = 78,69825 → 78,70.
  assert.equal(r.crds, "78.7000");
  // 4 005 × 8,55 % = 342,4275 → 342,43; 20 000 × 2,11 % = 422,00.
  assert.equal(r.vieillesseErPlafonnee, "342.4300");
  assert.equal(r.vieillesseErDeplafonnee, "422.0000");
  assert.equal(r.vieillesseEr, "764.4300");
  // 16 020 × 4 % = 640,80 chômage; 16 020 × 0,25 % = 40,05 AGS.
  assert.equal(r.chomageEr, "640.8000");
  assert.equal(r.agsEr, "40.0500");
  // FNAL ≥ 50: 20 000 × 0,50 % = 100,00; CDN 100 + 60 + 3,20 = 163,20.
  assert.equal(r.fnalEr, "100.0000");
  assert.equal(r.cdnEr, "163.2000");
});

test("FNAL threshold: 49 salariés plafonné, 50 déplafonné", () => {
  // 3 000 € brut is below the 4 005 € plafond, so only the rate differs:
  // 49 → 3 000 × 0,10 % = 3,00; 50 → 3 000 × 0,50 % = 15,00.
  const under = calculateFrCotisations2026({ ...small, brut: "3000.00", employerEmployeeCount: 49 });
  const over = calculateFrCotisations2026({ ...small, brut: "3000.00", employerEmployeeCount: 50 });
  assert.equal(under.fnalEr, "3.0000");
  assert.equal(over.fnalEr, "15.0000");
  // CDN carries the difference: 3 + 9 + 0,48 = 12,48 vs 15 + 9 + 0,48 = 24,48.
  assert.equal(under.cdnEr, "12.4800");
  assert.equal(over.cdnEr, "24.4800");
});

test("tenant-declared AT/MP and versement mobilité price when declared", () => {
  // 2 000 € brut, AT/MP 1,1 % → 22,00; VM 2,5 % → 50,00; CDN 8,32 + 50 = 58,32.
  const r = calculateFrCotisations2026({
    ...small, atmpRatePct: "1.1", versementMobilitePct: "2.5",
  });
  assert.equal(r.atmpEr, "22.0000");
  assert.equal(r.versementMobiliteEr, "50.0000");
  assert.equal(r.cdnEr, "58.3200");
  // Every other line is untouched by the tenant rates.
  assert.equal(r.vieillesseSal, "146.0000");
  assert.equal(r.maladieEr, "260.0000");
});

test("tranche edges: plafonds bite at 4 005 € and 16 020 €, monotonic above", () => {
  const at = (brut: string) => calculateFrCotisations2026({ ...small, brut });
  // Vieillesse plafonnée: 4 004 × 6,90 % = 276,276 → 276,28;
  // 4 005 × 6,90 % = 276,345 → 276,35; 4 006 annualises above the PASS
  // (4 006 × 12 = 48 072 > 48 060) so it caps back to 276,35 while the
  // déplafonnée line keeps climbing (4 006 × 0,40 % = 16,024 → 16,02).
  assert.equal(at("4004.00").vieillesseSalPlafonnee, "276.2800");
  assert.equal(at("4005.00").vieillesseSalPlafonnee, "276.3500");
  assert.equal(at("4006.00").vieillesseSalPlafonnee, "276.3500");
  assert.equal(at("4006.00").vieillesseSalDeplafonnee, "16.0200");
  // Chômage/AGS freeze at the 4×PASS monthly equivalent:
  // 16 020 × 4 % = 640,80 and 16 021 caps to the same.
  assert.equal(at("16020.00").chomageEr, "640.8000");
  assert.equal(at("16021.00").chomageEr, "640.8000");
  assert.equal(at("16020.00").agsEr, "40.0500");
  assert.equal(at("16021.00").agsEr, "40.0500");
  // CSG base freezes too: 16 020 × 98,25 % = 15 739,65 both sides.
  assert.equal(at("16020.00").csgBase, "15739.6500");
  assert.equal(at("16021.00").csgBase, "15739.6500");
  // Monotonicity: no line falls as brut rises through the edges.
  const keys = ["vieillesseSal", "csg", "crds", "maladieEr", "vieillesseEr", "allocFamEr", "chomageEr", "agsEr", "fnalEr", "cdnEr"] as const;
  let prev = at("0.00");
  for (const brut of ["0.01", "100.00", "4004.99", "4005.00", "4005.01", "16019.99", "16020.00", "16020.01", "100000.00"]) {
    const cur = at(brut);
    for (const key of keys) {
      assert.ok(
        toUnits(cur[key]) >= toUnits(prev[key]),
        `${key} fell from ${prev[key]} to ${cur[key]} at brut ${brut}`,
      );
    }
    prev = cur;
  }
});

test("guards: out-of-year dates, unknown effectif, bad amounts refuse by name", () => {
  for (const payDate of ["2025-12-31", "2027-01-01"]) {
    assert.throws(
      () => calculateFrCotisations2026({ ...small, payDate }),
      /no transcribed tables/,
      payDate,
    );
  }
  assert.throws(
    () => calculateFrCotisations2026({ ...small, employerEmployeeCount: null }),
    /FNAL refuses/,
  );
  assert.throws(
    () => calculateFrCotisations2026({ ...small, brut: "-10.00" }),
    /non-negative/,
  );
  assert.throws(
    () => calculateFrCotisations2026({ ...small, periodsPerYear: 0 }),
    /periodsPerYear/,
  );
  assert.throws(
    () => calculateFrCotisations2026({ ...small, atmpRatePct: "100.5" }),
    /out of range/,
  );
  assert.throws(
    () => calculateFrCotisations2026({ ...small, employerEmployeeCount: 49.5 }),
    /integer/,
  );
});

test("adapter: 2 000 € June versement pushes PAS, the nine URSSAF lines and the six retraite lines", async () => {
  const pushed: { systemKey: string; kind: string; amount: string; sequence: number }[] = [];
  const ctx: PayrollStatutoryComputeContext = {
    tx: null as never,
    orgId: "org",
    documentId: "doc",
    employeePartyId: "emp",
    employeeName: "Test",
    taxYear: 2026,
    country: "FR",
    region: "FR",
    run: { pay_date: "2026-06-15" },
    emp: {},
    filingAccountId: null,
    periodsPerYear: 12,
    income: "2000.00",
    nonPeriodic: "0",
    pensionable: "2000.00",
    insurable: "0",
    // FR declares no pre-tax treatments: the reduced legs equal the raw
    // legs by construction — derived via the real helper, not mirrored.
    reducedBases: reduceTaxBases(
      [],
      { income: "2000.00", nonPeriodic: "0", pensionable: "2000.00", insurable: "0" },
      FR_PAYROLL_PACK.deductionTreatments,
    ),
    deduction: () => "0",
    pushStatutory: (systemKey, kind, _description, amount, sequence) => {
      pushed.push({ systemKey, kind, amount, sequence });
    },
    storedCertificates: [],
    certificateFor: (() => ({
      answers: { domicile: "metropole_hors_france", taux_option: "non_personnalise" },
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
  const result = await FR_PAYROLL_PACK.computeStatutory(ctx);
  // PAS prices the net imposable, not the 2 000 € brut: 2 000 − 146,00
  // (vieillesse) − 133,62 (CSG 6,8) − 62,96 (ARRCO) − 17,20 (CEG) =
  // 1 640,22 € → May-2026 grille 1 635–1 698 → 0,5 % → 8,20 € PAS
  // (CGI art. 204 A et s., BOI-IR-PAS-20-10-10 I-A §10).
  assert.equal(result["NET_IMPOSABLE"], "1640.2200");
  assert.equal(result["PAS"], "8.2000");
  // 2 000 € brut, all T1: ARRCO 2 000 × 7,87 % = 157,40 (sal 62,96 /
  // er 94,44); CEG 2 000 × 2,15 % = 43,00 (17,20 / 25,80); no CET.
  assert.equal(result["ARRCO_SAL"], "62.9600");
  assert.equal(result["ARRCO_ER"], "94.4400");
  assert.equal(result["CEG_SAL"], "17.2000");
  assert.equal(result["CEG_ER"], "25.8000");
  assert.equal(result["CET_SAL"], "0.0000");
  assert.equal(result["CET_ER"], "0.0000");
  // 1 PAS + 3 salariales + 5 patronales + 1 CDN + 2 ARRCO + 2 CEG + 2 CET
  // = 16 lines, enumerated so the next addition fails loudly this same way.
  assert.equal(pushed.length, 16);
  assert.deepEqual(
    pushed.map((line) => [line.systemKey, line.kind, line.amount, line.sequence]),
    [
      ["pas", "deduction", "8.2000", 110],
      ["vieillesse", "deduction", "146.0000", 120],
      ["csg", "deduction", "180.7800", 130],
      ["crds", "deduction", "9.8300", 135],
      ["maladie_er", "employer_contribution", "260.0000", 210],
      ["vieillesse_er", "employer_contribution", "213.2000", 211],
      ["allocfam_er", "employer_contribution", "69.0000", 215],
      ["chomage_er", "employer_contribution", "80.0000", 225],
      ["ags_er", "employer_contribution", "5.0000", 226],
      ["cdn_er", "employer_contribution", "8.3200", 230],
      ["arrco", "deduction", "62.9600", 140],
      ["arrco", "employer_contribution", "94.4400", 240],
      ["ceg", "deduction", "17.2000", 141],
      ["ceg", "employer_contribution", "25.8000", 241],
      ["cet", "deduction", "0.0000", 142],
      ["cet", "employer_contribution", "0.0000", 242],
    ],
  );
  // No AT/MP line without a tenant rate, no APEC line without a cadre channel.
  assert.ok(!pushed.some((line) => line.systemKey === "atmp"));
  assert.ok(!pushed.some((line) => line.systemKey === "apec"));
});

test("adapter refuses without a known effectif, naming FNAL", async () => {
  const ctx: PayrollStatutoryComputeContext = {
    tx: null as never,
    orgId: "org",
    documentId: "doc",
    employeePartyId: "emp",
    employeeName: "Test",
    taxYear: 2026,
    country: "FR",
    region: "FR",
    run: { pay_date: "2026-06-15" },
    emp: {},
    filingAccountId: null,
    periodsPerYear: 12,
    income: "2000.00",
    nonPeriodic: "0",
    pensionable: "2000.00",
    insurable: "0",
    reducedBases: reduceTaxBases(
      [],
      { income: "2000.00", nonPeriodic: "0", pensionable: "2000.00", insurable: "0" },
      FR_PAYROLL_PACK.deductionTreatments,
    ),
    deduction: () => "0",
    pushStatutory: () => {},
    storedCertificates: [],
    certificateFor: (() => ({
      answers: { domicile: "metropole_hors_france" },
    })) as never,
    bool: () => false,
    assertRegionSupported: () => {},
    employerLevies: {
      wcbAmount: "0",
      wcbAssessable: "0",
      ehtAmount: "0",
      ehtEarnings: "0",
      hsfAmount: "0",
      hsfEarnings: "0",
    },
  };
  await assert.rejects(() => FR_PAYROLL_PACK.computeStatutory(ctx), /FNAL refuses/);
});
