/**
 * FR PAS conformance goldens, calendar 2026.
 *
 * External checks: DGFiP worked examples from BOI-IR-PAS-20-20-30-20-20250507
 * (current version, bofip.impots.gouv.fr) — inputs and expected outputs quoted
 * from the agency's own text, asserted to the centime. Where the agency gives
 * the mechanism but no 2026-figure example, the golden is built from the
 * transcribed tables with the arithmetic shown.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { calculateFrPas2026, computeFrStatutory } from "./compute-statutory.ts";

const METRO = "metropole" as const;

test("DGFiP example: 2 000 € monthly salary -> 2,9 % -> 58 € retenue", () => {
  // "Son salaire imposable s'élève chaque mois à 2 000 €. Le taux par défaut
  // correspondant s'élève à 2,9 % (grille applicable aux revenus perçus au
  // 1er mai 2025). La retenue à la source effectuée chaque mois par le
  // débiteur s'élève à 58 € (2 000 x 2,9 %)"
  const result = calculateFrPas2026({
    base: "2000.00",
    payDate: "2026-02-15",
    periodsPerYear: 12,
    transmittedRatePct: null,
    domicile: METRO,
  });
  assert.equal(result.rateSource, "grille");
  assert.equal(result.ratePct, "2.9000");
  assert.equal(result.pas, "58.0000");
});

test("DGFiP example: post-abattement base 1 800 € -> 2,1 % -> 37,80 €", () => {
  // "Après abattement, l'assiette du prélèvement est de 1 800 € (2 500 -
  // 700). Le taux proportionnel prévu par la grille de taux par défaut
  // correspondant est de 2,1 % (grille applicable aux revenus perçus au 1er
  // mai 2025) … prélève une retenue à la source égale à 1 800 x 2,1 %,
  // soit 37,80 €."
  // The 2 500 − 700 abattement step is quoted, not engine-applied
  // (contrats-courts refused by name); the golden starts at the 1 800 €
  // assiette the agency hands the grille.
  const result = calculateFrPas2026({
    base: "1800.00",
    payDate: "2026-03-31",
    periodsPerYear: 12,
    transmittedRatePct: null,
    domicile: METRO,
  });
  assert.equal(result.ratePct, "2.1000");
  assert.equal(result.pas, "37.8000");
});

test("prime aggregation: 2 000 € salary + 1 000 € prime -> grille(3 000 €)", () => {
  // "Pour une prime de 1 000 € versée avec un salaire mensuel de 2 000 €,
  // le taux … est celui correspondant à un versement de 3 000 €"
  // (BOI-IR-PAS-20-20-30-10). On the May-2026 grids 3 000 € falls in
  // 2 738–3 135 → 7,5 %; 3 000 × 7,5 % = 225,00 €.
  const result = calculateFrPas2026({
    base: "3000.00",
    payDate: "2026-06-15",
    periodsPerYear: 12,
    transmittedRatePct: null,
    domicile: METRO,
  });
  assert.equal(result.ratePct, "7.5000");
  assert.equal(result.pas, "225.0000");
});

test("weekly pay scales to the monthly equivalent (§180), rate hits the versement", () => {
  // Mechanism of the agency's weekly example ("600 x 7,5 %, soit 45 € par
  // versement" on the 2023 grids): monthly equivalent 600 × 52/12 =
  // 2 600,00 €; on the May-2026 grids 2 600 € falls in 2 315–2 738 → 5,3 %;
  // 600 × 5,3 % = 31,80 €. The equivalent is centime-rounded half-up per
  // the quoted §180 rule.
  const result = calculateFrPas2026({
    base: "600.00",
    payDate: "2026-09-15",
    periodsPerYear: 52,
    transmittedRatePct: null,
    domicile: METRO,
  });
  assert.equal(result.monthlyBase, "2600.0000");
  assert.equal(result.ratePct, "5.3000");
  assert.equal(result.pas, "31.8000");
});

test("transmitted rate wins over the grille; product rounds half-up", () => {
  // 1 785 € at a transmitted 7,5 % (May-2026 grille would give 0,5 %):
  // 1 785 × 0,075 = 133,875 → 133,88 €. The half-up centime rule is the
  // agency's quoted §180 rule, applied to the product (engine-stated —
  // every published PAS product lands exact).
  const result = calculateFrPas2026({
    base: "1785.00",
    payDate: "2026-06-15",
    periodsPerYear: 12,
    transmittedRatePct: "7.5",
    domicile: METRO,
  });
  assert.equal(result.rateSource, "transmis");
  assert.equal(result.ratePct, "7.5000");
  assert.equal(result.pas, "133.8800");
});

test("May boundary moves real money: 1 630 € is 0,5 % in April, 0 % in May", () => {
  // May-2025 grids: 1 620–1 683 → 0,5 % (1 630 × 0,5 % = 8,15 €).
  // May-2026 grids: below 1 635 → 0 %.
  const april = calculateFrPas2026({
    base: "1630.00",
    payDate: "2026-04-30",
    periodsPerYear: 12,
    transmittedRatePct: null,
    domicile: METRO,
  });
  const may = calculateFrPas2026({
    base: "1630.00",
    payDate: "2026-05-01",
    periodsPerYear: 12,
    transmittedRatePct: null,
    domicile: METRO,
  });
  assert.equal(april.ratePct, "0.5000");
  assert.equal(april.pas, "8.1500");
  assert.equal(may.ratePct, "0.0000");
  assert.equal(may.pas, "0.0000");
});

test("guards: DOM domiciles, out-of-year dates, bad rates and periods refuse", () => {
  const base = {
    base: "2000.00",
    payDate: "2026-06-15",
    periodsPerYear: 12,
    transmittedRatePct: null,
    domicile: METRO,
  } as const;
  assert.throws(
    () => calculateFrPas2026({ ...base, domicile: "guyane_mayotte" as never }),
    /Guyane/,
  );
  assert.throws(
    () => calculateFrPas2026({ ...base, payDate: "2025-12-31" }),
    /no transcribed grille/,
  );
  assert.throws(
    () => calculateFrPas2026({ ...base, payDate: "2027-01-01" }),
    /no transcribed grille/,
  );
  assert.throws(
    () => calculateFrPas2026({ ...base, transmittedRatePct: "100.5" }),
    /out of range/,
  );
  assert.throws(
    () => calculateFrPas2026({ ...base, periodsPerYear: 0 }),
    /periodsPerYear/,
  );
  assert.throws(
    () => calculateFrPas2026({ ...base, base: "-10.00" }),
    /non-negative/,
  );
});

test("a hors-de-France domicile refuses with the 182 A mechanism, never grille I", async () => {
  // CGI art. 182 A prices salaires for French work paid to non-residents —
  // "différente du PAS" (DGFiP non-resident fiche 03-2026). Pricing grille I
  // here would be the wrong mechanism at the right rate shape, so both the
  // pure grille function and the pack adapter refuse by name.
  assert.throws(
    () =>
      calculateFrPas2026({
        base: "2000.00",
        payDate: "2026-06-15",
        periodsPerYear: 12,
        transmittedRatePct: null,
        domicile: "hors_de_france",
      }),
    /182 A.*never priced with grille I/,
  );
  // The adapter refuses before any line is pushed: a minimal context reaches
  // the domicile branch with only taxYear, region, pay date and answers.
  const ctx = {
    taxYear: 2026,
    region: "FR",
    run: { pay_date: "2026-06-15" },
    certificateFor: () => ({ answers: { domicile: "hors_de_france" } }),
  } as never;
  await assert.rejects(computeFrStatutory(ctx), /182 A.*never priced with grille I/);
});

test("the retired lumped domicile refuses with the re-affirmation remedy", async () => {
  // "metropole_hors_france" affirmed two populations that price under
  // different mechanisms. Stored answers carrying it must not silently
  // price as métropole — the operator re-affirms the split domicile.
  const ctx = {
    taxYear: 2026,
    region: "FR",
    run: { pay_date: "2026-06-15" },
    certificateFor: () => ({ answers: { domicile: "metropole_hors_france" } }),
  } as never;
  await assert.rejects(computeFrStatutory(ctx), /re-affirm domicile/);
});
