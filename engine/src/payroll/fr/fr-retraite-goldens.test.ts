/**
 * FR retraite-complémentaire conformance goldens, calendar 2026.
 *
 * Mechanism 1 (agency's own published output): the AGIRC-ARRCO page
 * publishes rates and split columns, not worked examples. The
 * mechanism-1 goldens pin every transcribed constant and prove the
 * engine's exact 60/40 split rounds to the page's displayed split
 * columns (7,87 % → 3,15 / 4,72; 2,15 % → 0,86 / 1,29). Mechanism 2
 * hand-works two full cases with the arithmetic shown, pins the T2 top
 * and the strict CET trigger, and sweeps the tranche edges.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { toUnits } from "../../money/money.ts";
import { calculateFrCotisations2026 } from "./cotisations.ts";
import {
  FR_APEC_2026,
  FR_ARRCO_TAUX_2026,
  FR_ARRCO_TRANCHES_2026,
  FR_CEG_2026,
  FR_CET_2026,
} from "./retraite-2026.ts";

const small = { brut: "2000.00", payDate: "2026-06-15", periodsPerYear: 12, employerEmployeeCount: 10 } as const;

test("table integrity: tranches, taux appelés, CEG, CET and APEC", () => {
  // Tranches corroborate the PASS: T1 tops at 1×, T2 at 8×.
  assert.equal(FR_ARRCO_TRANCHES_2026.t1TopMonthly, "4005");
  assert.equal(FR_ARRCO_TRANCHES_2026.t2TopMonthly, "32040");
  assert.equal(FR_ARRCO_TRANCHES_2026.t1TopAnnual, "48060");
  assert.equal(FR_ARRCO_TRANCHES_2026.t2TopAnnual, "384480");
  assert.equal(String(Number(FR_ARRCO_TRANCHES_2026.t1TopMonthly) * 8), FR_ARRCO_TRANCHES_2026.t2TopMonthly);
  assert.equal(String(Number(FR_ARRCO_TRANCHES_2026.t1TopAnnual) * 8), FR_ARRCO_TRANCHES_2026.t2TopAnnual);
  // Taux appelés and équilibre contributions.
  assert.equal(FR_ARRCO_TAUX_2026.t1.rate, "0.0787");
  assert.equal(FR_ARRCO_TAUX_2026.t2.rate, "0.2159");
  assert.equal(FR_ARRCO_TAUX_2026.appelPct, "127");
  assert.equal(FR_CEG_2026.t1.rate, "0.0215");
  assert.equal(FR_CEG_2026.t2.rate, "0.027");
  assert.equal(FR_CET_2026.rate, "0.0035");
  // APEC transcribed and refused (cadres only, no channel).
  assert.equal(FR_APEC_2026.rate, "0.0006");
});

test("page-display cross-check: the exact 60/40 split rounds to the printed columns", () => {
  // 100 € brut, all T1: salarié 100 × 7,87 % × 40 % = 3,148 → 3,15;
  // patronal 100 × 7,87 % × 60 % = 4,722 → 4,72 — the page's columns.
  // CEG: 100 × 2,15 % × 40 % = 0,86; × 60 % = 1,29 — exact.
  const r = calculateFrCotisations2026({ ...small, brut: "100.00" });
  assert.equal(r.t1Base, "100.0000");
  assert.equal(r.t2Base, "0.0000");
  assert.equal(r.arrcoSalT1, "3.1500");
  assert.equal(r.arrcoErT1, "4.7200");
  assert.equal(r.cegSalT1, "0.8600");
  assert.equal(r.cegErT1, "1.2900");
  assert.equal(r.cetApplies, false);
});

test("hand-worked: 2 000 € brut, monthly — T1 only, no CET", () => {
  const r = calculateFrCotisations2026({ ...small });
  assert.equal(r.t1Base, "2000.0000");
  assert.equal(r.t2Base, "0.0000");
  // ARRCO T1: 2 000 × 7,87 % = 157,40; salarié 40 % = 62,96;
  // employeur 60 % = 94,44.
  assert.equal(r.arrcoSalT1, "62.9600");
  assert.equal(r.arrcoErT1, "94.4400");
  assert.equal(r.arrcoSalT2, "0.0000");
  assert.equal(r.arrcoErT2, "0.0000");
  assert.equal(r.arrcoSal, "62.9600");
  assert.equal(r.arrcoEr, "94.4400");
  // CEG T1: 2 000 × 2,15 % = 43,00; salarié 17,20; employeur 25,80.
  assert.equal(r.cegSalT1, "17.2000");
  assert.equal(r.cegErT1, "25.8000");
  assert.equal(r.cegSal, "17.2000");
  assert.equal(r.cegEr, "25.8000");
  // 2 000 € does not exceed the 4 005 € plafond: no CET.
  assert.equal(r.cetApplies, false);
  assert.equal(r.cetBase, "0.0000");
  assert.equal(r.cetSal, "0.0000");
  assert.equal(r.cetEr, "0.0000");
});

test("hand-worked: 20 000 € brut, monthly — T1 capped, T2, CET", () => {
  const r = calculateFrCotisations2026({
    brut: "20000.00", payDate: "2026-06-15", periodsPerYear: 12, employerEmployeeCount: 60,
  });
  assert.equal(r.t1Base, "4005.0000");
  assert.equal(r.t2Base, "15995.0000");
  // ARRCO T1: 4 005 × 3,148 % = 126,0774 → 126,08 salarié;
  // 4 005 × 4,722 % = 189,1161 → 189,12 employeur.
  assert.equal(r.arrcoSalT1, "126.0800");
  assert.equal(r.arrcoErT1, "189.1200");
  // ARRCO T2: 15 995 × 8,636 % = 1 381,3282 → 1 381,33;
  // 15 995 × 12,954 % = 2 071,9923 → 2 071,99.
  assert.equal(r.arrcoSalT2, "1381.3300");
  assert.equal(r.arrcoErT2, "2071.9900");
  assert.equal(r.arrcoSal, "1507.4100");
  assert.equal(r.arrcoEr, "2261.1100");
  // CEG T1: 4 005 × 0,86 % = 34,443 → 34,44;
  // 4 005 × 1,29 % = 51,6645 → 51,66.
  assert.equal(r.cegSalT1, "34.4400");
  assert.equal(r.cegErT1, "51.6600");
  // CEG T2: 15 995 × 1,08 % = 172,746 → 172,75;
  // 15 995 × 1,62 % = 259,119 → 259,12.
  assert.equal(r.cegSalT2, "172.7500");
  assert.equal(r.cegErT2, "259.1200");
  assert.equal(r.cegSal, "207.1900");
  assert.equal(r.cegEr, "310.7800");
  // 20 000 € exceeds the plafond: CET on T1+T2 = 20 000 at 0,35 % =
  // 70,00; salarié 28,00; employeur 42,00.
  assert.equal(r.cetApplies, true);
  assert.equal(r.cetBase, "20000.0000");
  assert.equal(r.cetSal, "28.0000");
  assert.equal(r.cetEr, "42.0000");
});

test("tranche edges: T2 top freezes at 32 040 €, CET triggers strictly above 4 005 €", () => {
  const at = (brut: string) => calculateFrCotisations2026({ ...small, brut });
  // Exactly at the plafond: full T1, empty T2, no CET ("supérieur" is strict).
  const edge = at("4005.00");
  assert.equal(edge.t1Base, "4005.0000");
  assert.equal(edge.t2Base, "0.0000");
  assert.equal(edge.cetApplies, false);
  // One centime above: T2 opens and CET applies on T1+T2.
  const over = at("4005.01");
  assert.equal(over.t2Base, "0.0100");
  assert.equal(over.cetApplies, true);
  assert.equal(over.cetBase, "4005.0100");
  // T2 top: 32 040 → 28 035,00; 32 041 caps to the same 28 035,00.
  assert.equal(at("32040.00").t2Base, "28035.0000");
  assert.equal(at("32041.00").t2Base, "28035.0000");
  assert.equal(at("32040.00").arrcoSalT2, at("32041.00").arrcoSalT2);
  // Monotonicity across the edges: no retraite line falls as brut rises.
  const keys = ["arrcoSal", "arrcoEr", "cegSal", "cegEr", "cetSal", "cetEr"] as const;
  let prev = at("0.00");
  for (const brut of ["100.00", "4004.99", "4005.00", "4005.01", "32039.99", "32040.00", "32040.01", "100000.00"]) {
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

test("retraite tables refuse out-of-year pay dates on both sides", () => {
  for (const payDate of ["2025-12-31", "2027-01-01"]) {
    assert.throws(
      () => calculateFrCotisations2026({ ...small, payDate }),
      /no transcribed tables/,
      payDate,
    );
  }
});
