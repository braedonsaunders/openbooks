/**
 * FR 2026 conformance goldens for every engine the pack composes: PAS (DGFiP
 * worked examples, asserted to the centime), cotisations and retraite
 * complémentaire (URSSAF and AGIRC-ARRCO publish rates, not worked payslips,
 * so those rows are hand-worked from the published rates with the arithmetic
 * shown), RGDU (URSSAF worked examples, CSS D.241-7) and the pack adapter.
 */
import assert from "node:assert/strict";
import test from "node:test";
import "../packs.ts";
import { add, toUnits } from "../../money/money.ts";
import { EMPTY_EMPLOYER_LEVY_FACTORS, type PayrollStatutoryComputeContext } from "../statutory-context.ts";
import { reduceTaxBases } from "../treatment-bases.ts";
import { calculateFrPas2026, type FrPas2026Input } from "./compute-statutory.ts";
import { calculateFrCotisations2026, type FrCotisations2026Input } from "./cotisations.ts";
import { FR_PAYROLL_PACK } from "./pack.ts";
import { calculateFrRgdu2026, frRgduSmicFromHours2026, type FrRgdu2026Input } from "./rgdu-2026.ts";

const PAS: FrPas2026Input = { base: "2000.00", payDate: "2026-06-15", periodsPerYear: 12, transmittedRatePct: null, domicile: "metropole" };
const SMALL: FrCotisations2026Input = { brut: "2000.00", payDate: "2026-06-15", periodsPerYear: 12, employerEffectif: "10.00" };
// URSSAF's June 2026 RGDU example: 2 000 € for a full month at 35 h/week, 70-person employer.
const RGDU: FrRgdu2026Input = {
  employerEffectif: "70", eligible: true, remunerationYearToDate: "2000.00", smicYearToDate: "1823.03",
  priorReductionYearToDate: "0.00", urssafCoveredRate: "0.3420", agircArrcoCoveredRate: "0.0601",
};

/** The pack adapter's context: `facts` answer the employer-fact reads in query order, the last repeating. */
interface AdapterInput {
  facts: Record<string, string>[];
  answers: Record<string, string>;
  rates?: Record<string, Record<string, string>>;
  ctx?: Partial<PayrollStatutoryComputeContext>;
}
type Line = { systemKey: string; amount: string };
type Engine =
  | { engine: "pas"; input: Partial<FrPas2026Input> }
  | { engine: "cotisations"; input: Partial<FrCotisations2026Input> }
  | { engine: "rgdu"; input: Partial<FrRgdu2026Input> }
  | { engine: "smic"; input: { regular: string; extra: string } }
  | { engine: "adapter"; input: AdapterInput };

function adapterContext({ facts, answers, rates = {}, ctx }: AdapterInput, pushed: Line[]): PayrollStatutoryComputeContext {
  let query = 0;
  const legs = { income: "2000.00", nonPeriodic: "0", pensionable: "2000.00", insurable: "0" };
  return {
    tx: { execute: async () => ({ rows: facts.length ? [facts[Math.min(query++, facts.length - 1)]] : [] }) } as never,
    orgId: "org", subsidiaryId: "legal-employer", documentId: "doc", employeePartyId: "emp", employmentId: "employment",
    employeeName: "Test", taxYear: 2026, country: "FR", region: "FR", emp: {}, filingAccountId: "fr-siret-account",
    run: { pay_date: "2026-06-15", run_type: "regular" }, periodsPerYear: 12, ...legs, gross: "2000.0000",
    statutoryHours: { regular: "151.6667", extra: "0" },
    // FR declares no pre-tax treatments: the reduced legs are derived via the real helper.
    reducedBases: reduceTaxBases([], legs, FR_PAYROLL_PACK.deductionTreatments),
    resolveStatutoryRates: async () => ({ values: (slotKey: string) => rates[slotKey] ?? null }) as never,
    deduction: () => "0",
    pushStatutory: (systemKey, _kind, _description, amount) => { pushed.push({ systemKey, amount }); },
    storedCertificates: [],
    certificateFor: (() => ({ answers })) as never,
    bool: () => false,
    assertRegionSupported: () => {},
    employerLevies: { ...EMPTY_EMPLOYER_LEVY_FACTORS },
    ...ctx,
  };
}

/** Runs one engine; adapter output is its factors plus every pushed line as `line <systemKey>`. */
async function compute(row: Engine, pushed: Line[] = []): Promise<Record<string, unknown>> {
  switch (row.engine) {
    case "pas": return { ...calculateFrPas2026({ ...PAS, ...row.input }) };
    case "cotisations": return { ...calculateFrCotisations2026({ ...SMALL, ...row.input }) };
    case "rgdu": return { ...calculateFrRgdu2026({ ...RGDU, ...row.input }) };
    case "smic": return { smic: frRgduSmicFromHours2026(row.input.regular, row.input.extra) };
    case "adapter": {
      const factors = await FR_PAYROLL_PACK.computeStatutory(adapterContext(row.input, pushed));
      const lines: Record<string, string> = {};
      for (const { systemKey, amount } of pushed) {
        const key = `line ${systemKey}`;
        lines[key] = lines[key] ? `${lines[key]},${amount}` : amount;
      }
      const rgduTotal = pushed.filter((l) => l.systemKey.startsWith("rgdu_")).reduce((sum, l) => add(sum, l.amount), "0");
      return { ...factors, ...lines, "rgdu_* lines total": rgduTotal };
    }
  }
}

const DGFIP = "DGFiP BOI-IR-PAS-20-20-30-20-20250507, worked example";
const GRILLES = "DGFiP PAS grilles de taux par défaut, May-2025 and May-2026 editions";
const URSSAF = "URSSAF taux de cotisations secteur privé 2026, hand-worked";
const PLAFOND = "URSSAF plafond 2026 (PASS 48 060 €, 4 005 €/month)";
const ARRCO = "AGIRC-ARRCO taux de cotisation 2026, hand-worked";
const RGDU_PAGE = "URSSAF réduction générale dégressive unique (2026)";
const D241_7 = "CSS D.241-7 (LEGIARTI000046843821)";

type Golden = Engine & { year: number; label: string; citation: string; expected: Record<string, string | boolean> };

const GOLDENS: Golden[] = [
  // PAS — "Le taux par défaut … 2,9 % … La retenue … s'élève à 58 € (2 000 x 2,9 %)".
  { year: 2026, label: "PAS 2 000 € monthly salary → 2,9 % → 58 €", citation: `${DGFIP} (salaire imposable 2 000 €)`, engine: "pas", input: { payDate: "2026-02-15" }, expected: { rateSource: "grille", ratePct: "2.9000", pas: "58.0000" } },
  // The 2 500 − 700 abattement is quoted, not engine-applied (contrats courts refuse by name); the row starts at the 1 800 € assiette.
  { year: 2026, label: "PAS post-abattement base 1 800 € → 2,1 % → 37,80 €", citation: `${DGFIP} (assiette après abattement 1 800 €)`, engine: "pas", input: { base: "1800.00", payDate: "2026-03-31" }, expected: { ratePct: "2.1000", pas: "37.8000" } },
  // "Pour une prime de 1 000 € versée avec un salaire mensuel de 2 000 €, le taux … est celui … de 3 000 €"; May-2026 band 2 738–3 135 → 7,5 %.
  { year: 2026, label: "PAS 2 000 € salary + 1 000 € prime priced at grille(3 000 €) → 225 €", citation: "DGFiP BOI-IR-PAS-20-20-30-10 (primes); May-2026 grille", engine: "pas", input: { base: "3000.00" }, expected: { ratePct: "7.5000", pas: "225.0000" } },
  // Monthly equivalent 600 × 52/12 = 2 600 € (§180, centime half-up); May-2026 band 2 315–2 738 → 5,3 %; 600 × 5,3 % = 31,80 €.
  { year: 2026, label: "PAS weekly 600 € scales to the monthly equivalent, rate hits the versement", citation: "DGFiP BOI-IR-PAS-20-20-30-20 §180 (weekly example mechanism)", engine: "pas", input: { base: "600.00", payDate: "2026-09-15", periodsPerYear: 52 }, expected: { monthlyBase: "2600.0000", ratePct: "5.3000", pas: "31.8000" } },
  // 1 785 × 0,075 = 133,875 → 133,88 € half-up (the grille would give 0,5 %).
  { year: 2026, label: "PAS transmitted 7,5 % wins over the grille; product rounds half-up", citation: "DGFiP BOI-IR-PAS-20-20-30-20 §180 rounding rule", engine: "pas", input: { base: "1785.00", transmittedRatePct: "7.5" }, expected: { rateSource: "transmis", ratePct: "7.5000", pas: "133.8800" } },
  { year: 2026, label: "PAS 1 630 € in April prices on the May-2025 grille (1 620–1 683 → 0,5 %)", citation: GRILLES, engine: "pas", input: { base: "1630.00", payDate: "2026-04-30" }, expected: { ratePct: "0.5000", pas: "8.1500" } },
  { year: 2026, label: "PAS 1 630 € in May prices on the May-2026 grille (below 1 635 → 0 %)", citation: GRILLES, engine: "pas", input: { base: "1630.00", payDate: "2026-05-01" }, expected: { ratePct: "0.0000", pas: "0.0000" } },

  // Cotisations. CSG/CRDS base 2 000 × 98,25 % = 1 965 (not 2 000); CRDS 9,825 → 9,83 half-up;
  // CDN = FNAL 2,00 + CSA 6,00 + dialogue 0,32. Undeclared AT/MP and VM price at zero.
  {
    year: 2026, label: "cotisations 2 000 € brut, monthly, 10 salariés — every line", citation: URSSAF, engine: "cotisations", input: {},
    expected: {
      vieillesseSalPlafonnee: "138.0000", vieillesseSalDeplafonnee: "8.0000", vieillesseSal: "146.0000",
      csgBase: "1965.0000", csgImposable: "47.1600", csgNonImposable: "133.6200", csg: "180.7800", crds: "9.8300",
      maladieEr: "260.0000", vieillesseErPlafonnee: "171.0000", vieillesseErDeplafonnee: "42.2000", vieillesseEr: "213.2000",
      allocFamErRate: "0.0525", allocFamEr: "105.0000", chomageEr: "80.0000", agsEr: "5.0000",
      fnalEr: "2.0000", csaEr: "6.0000", dialogueEr: "0.3200", cdnEr: "8.3200", atmpEr: "0.0000", versementMobiliteEr: "0.0000",
    },
  },
  { year: 2026, label: "AGS for a temporary-work agency: 2 000 € → 0,60 €", citation: "URSSAF assurance chômage / AGS page", engine: "cotisations", input: { agsInterim: true }, expected: { agsEr: "0.6000" } },
  { year: 2026, label: "ordinary employers keep the 5,25 % family rate at 3 000 €", citation: "URSSAF cotisation allocations familiales page", engine: "cotisations", input: { brut: "3000.00" }, expected: { allocFamErRate: "0.0525", allocFamEr: "157.5000" } },
  // Plafonnée 4 005 × 6,90 % = 276,345 → 276,35; CSG base 4×PASS 16 020 × 98,25 % = 15 739,65;
  // CSG 377,7516 → 377,75 + 1 070,2962 → 1 070,30; FNAL ≥ 50 20 000 × 0,50 %; CDN 100 + 60 + 3,20.
  {
    year: 2026, label: "cotisations 20 000 € brut, monthly, 60 salariés — capped lines", citation: `${URSSAF}; ${PLAFOND}`, engine: "cotisations", input: { brut: "20000.00", employerEffectif: "60.00" },
    expected: {
      vieillesseSalPlafonnee: "276.3500", vieillesseSalDeplafonnee: "80.0000", vieillesseSal: "356.3500",
      csgBase: "15739.6500", csgImposable: "377.7500", csgNonImposable: "1070.3000", csg: "1448.0500", crds: "78.7000",
      vieillesseErPlafonnee: "342.4300", vieillesseErDeplafonnee: "422.0000", vieillesseEr: "764.4300",
      chomageEr: "640.8000", agsEr: "40.0500", fnalEr: "100.0000", cdnEr: "163.2000",
    },
  },
  // 3 000 € is under the plafond, so only the FNAL rate differs: CDN 3 + 9 + 0,48 vs 15 + 9 + 0,48.
  { year: 2026, label: "FNAL at 49,99 salariés prices at 0,10 %", citation: URSSAF, engine: "cotisations", input: { brut: "3000.00", employerEffectif: "49.99" }, expected: { fnalEr: "3.0000", cdnEr: "12.4800" } },
  { year: 2026, label: "FNAL at 50 salariés prices at 0,50 %", citation: URSSAF, engine: "cotisations", input: { brut: "3000.00", employerEffectif: "50.00" }, expected: { fnalEr: "15.0000", cdnEr: "24.4800" } },
  { year: 2026, label: "an effectif of 49,50 (hundredths) is accepted and prices FNAL < 50", citation: URSSAF, engine: "cotisations", input: { employerEffectif: "49.50" }, expected: { fnalEr: "2.0000" } },
  { year: 2026, label: "tenant AT/MP 1,1 % and VM 2,5 % price as separate lines, others untouched", citation: "URSSAF taux secteur privé 2026 and versement mobilité lookup", engine: "cotisations", input: { atmpRatePct: "1.1", versementMobilitePct: "2.5" }, expected: { atmpEr: "22.0000", versementMobiliteEr: "50.0000", cdnEr: "8.3200", vieillesseSal: "146.0000", maladieEr: "260.0000" } },
  { year: 2026, label: "plafonnée below the plafond: 4 004 € → 276,28 €", citation: PLAFOND, engine: "cotisations", input: { brut: "4004.00" }, expected: { vieillesseSalPlafonnee: "276.2800" } },
  { year: 2026, label: "exactly at the plafond: 4 005 € — full T1, empty T2, no CET (strictly above)", citation: `${PLAFOND}; ${ARRCO}`, engine: "cotisations", input: { brut: "4005.00" }, expected: { vieillesseSalPlafonnee: "276.3500", t1Base: "4005.0000", t2Base: "0.0000", cetApplies: false } },
  { year: 2026, label: "one centime above the plafond: T2 opens and CET applies on T1+T2", citation: ARRCO, engine: "cotisations", input: { brut: "4005.01" }, expected: { t2Base: "0.0100", cetApplies: true, cetBase: "4005.0100" } },
  // 4 006 × 12 = 48 072 > PASS, so plafonnée caps back while déplafonnée climbs (16,024 → 16,02).
  { year: 2026, label: "4 006 € annualises above the PASS: plafonnée caps, déplafonnée climbs", citation: PLAFOND, engine: "cotisations", input: { brut: "4006.00" }, expected: { vieillesseSalPlafonnee: "276.3500", vieillesseSalDeplafonnee: "16.0200" } },
  ...["16020.00", "16021.00"].map((brut): Golden => ({
    year: 2026, label: `chômage, AGS and CSG base freeze at 4×PASS monthly: ${brut} €`, citation: PLAFOND, engine: "cotisations", input: { brut },
    expected: { chomageEr: "640.8000", agsEr: "40.0500", csgBase: "15739.6500" },
  })),
  ...["32040.00", "32041.00"].map((brut): Golden => ({
    year: 2026, label: `T2 freezes at 8×PASS monthly: ${brut} € → 28 035 €`, citation: ARRCO, engine: "cotisations", input: { brut }, expected: { t2Base: "28035.0000" },
  })),
  // Cumulative 33 000 + 13 000 = 46 000 € stays under the 48 060 € annual PASS: 6,90 % on all 13 000 €, no T2, no CET.
  { year: 2026, label: "December bonus under the annual PASS stays capped (progressive regularisation)", citation: "URSSAF régularisation progressive du plafond", engine: "cotisations", input: { brut: "13000.00", payDate: "2026-12-15", ytdRemunerationBefore: "33000.00", ceilingPeriodsElapsed: 12 }, expected: { t1Base: "13000.0000", t2Base: "0.0000", vieillesseSalPlafonnee: "897.0000", cetApplies: false, cetBase: "0.0000" } },

  // Retraite. 100 € × 7,87 % × 40 % = 3,148 → 3,15 and × 60 % = 4,722 → 4,72 — the page's printed split columns.
  { year: 2026, label: "retraite page-display cross-check: the exact 60/40 split rounds to the printed columns", citation: "AGIRC-ARRCO taux 2026, printed salarié/employeur columns", engine: "cotisations", input: { brut: "100.00" }, expected: { t1Base: "100.0000", t2Base: "0.0000", arrcoSalT1: "3.1500", arrcoErT1: "4.7200", cegSalT1: "0.8600", cegErT1: "1.2900", cetApplies: false } },
  // ARRCO T1 2 000 × 7,87 % = 157,40 split 62,96 / 94,44; CEG 2 000 × 2,15 % = 43,00 split 17,20 / 25,80.
  {
    year: 2026, label: "retraite 2 000 € brut, monthly — T1 only, no CET", citation: ARRCO, engine: "cotisations", input: {},
    expected: {
      t1Base: "2000.0000", t2Base: "0.0000", arrcoSalT1: "62.9600", arrcoErT1: "94.4400", arrcoSalT2: "0.0000", arrcoErT2: "0.0000",
      arrcoSal: "62.9600", arrcoEr: "94.4400", cegSalT1: "17.2000", cegErT1: "25.8000", cegSal: "17.2000", cegEr: "25.8000",
      cetApplies: false, cetBase: "0.0000", cetSal: "0.0000", cetEr: "0.0000",
    },
  },
  // T1 4 005 × 3,148 % / 4,722 %; T2 15 995 × 8,636 % / 12,954 %; CEG T2 × 1,08 % / 1,62 %; CET 20 000 × 0,35 % = 70 split 28 / 42.
  {
    year: 2026, label: "retraite 20 000 € brut, monthly — T1 capped, T2, CET", citation: ARRCO, engine: "cotisations", input: { brut: "20000.00", employerEffectif: "60.00" },
    expected: {
      t1Base: "4005.0000", t2Base: "15995.0000", arrcoSalT1: "126.0800", arrcoErT1: "189.1200", arrcoSalT2: "1381.3300", arrcoErT2: "2071.9900",
      arrcoSal: "1507.4100", arrcoEr: "2261.1100", cegSalT1: "34.4400", cegErT1: "51.6600", cegSalT2: "172.7500", cegErT2: "259.1200",
      cegSal: "207.1900", cegEr: "310.7800", cetApplies: true, cetBase: "20000.0000", cetSal: "28.0000", cetEr: "42.0000",
    },
  },

  // RGDU.
  { year: 2026, label: "RGDU SMIC for 151,6667 contractual hours at 12,02 €", citation: `Décret n° 2025-1228; ${D241_7} IV`, engine: "smic", input: { regular: "151.6667", extra: "0" }, expected: { smic: "1823.0300" } },
  { year: 2026, label: "RGDU SMIC adds 8 eligible extra hours at the same rate", citation: `Décret n° 2025-1228; ${D241_7} IV`, engine: "smic", input: { regular: "151.6667", extra: "8" }, expected: { smic: "1919.1900" } },
  { year: 2026, label: "RGDU June example: coefficient 0,3178, reduction 635,60 €", citation: `${RGDU_PAGE}, June example`, engine: "rgdu", input: {}, expected: { coefficient: "0.3178", cumulativeReduction: "635.6000", periodAdjustment: "635.6000", urssafAdjustment: "540.6000", agircArrcoAdjustment: "95.0000", maximumCoefficient: "0.4021" } },
  { year: 2026, label: "RGDU July example: cumulative 3 978 € less 3 347,50 € prior reductions", citation: `${RGDU_PAGE}, July example (progressive regularisation)`, engine: "rgdu", input: { remunerationYearToDate: "15000.00", smicYearToDate: "12761.21", priorReductionYearToDate: "3347.50" }, expected: { coefficient: "0.2652", cumulativeReduction: "3978.0000", periodAdjustment: "630.5000", urssafAdjustment: "536.2600", agircArrcoAdjustment: "94.2400", maximumCoefficient: "0.4021" } },
  { year: 2026, label: "RGDU Tdelta below the fifty-employee boundary: 49,9999 → 0,3147", citation: `${RGDU_PAGE}, Tdelta by effectif`, engine: "rgdu", input: { employerEffectif: "49.9999", urssafCoveredRate: "0.3380" }, expected: { coefficient: "0.3147" } },
  { year: 2026, label: "RGDU Tdelta at the fifty-employee boundary: 50 → 0,3178", citation: `${RGDU_PAGE}, Tdelta by effectif`, engine: "rgdu", input: { employerEffectif: "50" }, expected: { coefficient: "0.3178" } },
  // Tdelta caps to the covered rates owed (0,3200 + 0,0601) and apportions by each institution's covered rate.
  { year: 2026, label: "RGDU Tdelta caps to covered rates and allocates by institution", citation: `${D241_7} III and VI`, engine: "rgdu", input: { employerEffectif: "10.00", remunerationYearToDate: "100.00", urssafCoveredRate: "0.3200" }, expected: { maximumCoefficient: "0.3801", coefficient: "0.3801", periodAdjustment: "38.0100", urssafAdjustment: "32.0000", agircArrcoAdjustment: "6.0100" } },
  { year: 2026, label: "RGDU ineligible employee reverses the 120 € prior reduction", citation: D241_7, engine: "rgdu", input: { employerEffectif: "12", eligible: false, remunerationYearToDate: "5470.00", smicYearToDate: "1823.33", priorReductionYearToDate: "120.00", urssafCoveredRate: "0.3380" }, expected: { periodAdjustment: "-120.0000" } },
  { year: 2026, label: "RGDU remuneration of 5 470 € over 3 × 1 823,33 € SMIC has no cumulative reduction", citation: D241_7, engine: "rgdu", input: { employerEffectif: "12", remunerationYearToDate: "5470.00", smicYearToDate: "1823.33", priorReductionYearToDate: "120.00", urssafCoveredRate: "0.3380" }, expected: { cumulativeReduction: "0.0000" } },

  // Adapter. 2 000 € × 3,45 % = 69,00 for a filing account declared eligible for the reduced family rate.
  {
    year: 2026, label: "adapter prices the reduced 3,45 % family rate for an eligible filing account", citation: "URSSAF cotisation allocations familiales page", engine: "adapter",
    input: {
      facts: [{ fact_value: "10.00" }, { fact_value: "ordinary" }, { fact_value: "droit_commun" }],
      answers: { domicile: "metropole", rgdu_eligibility: "excluded", apec_eligibility: "not_covered" },
      rates: { fr_atmp: { taux: "1.1000" }, fr_allocfam: { reduced_rate_eligible: "true" } },
      ctx: { filingAccountId: "siret-eligible" },
    },
    expected: { FAM_ER: "69.0000" },
  },
  // The emitted rgdu_* lines must reconcile exactly to the calculator's 635,60 € adjustment.
  {
    year: 2026, label: "adapter emits the URSSAF June RGDU and apportions it to both institutions", citation: `${RGDU_PAGE}, June example`, engine: "adapter",
    input: {
      facts: [{ fact_value: "70.00" }, { fact_value: "ordinary" }, { fact_value: "droit_commun" }, { fact_value: "ordinary", remuneration: "0", smic: "0", reduction: "0" }],
      answers: { domicile: "metropole", taux_option: "non_personnalise", rgdu_eligibility: "eligible", apec_eligibility: "covered" },
      rates: { fr_atmp: { taux: "1.1000" }, fr_versement_mobilite: { taux: "2.5000" } },
    },
    expected: {
      FR_RGDU_COEFFICIENT: "0.3178", "line apec": "0.4800,0.7200", "line rgdu_urssaf": "-540.6000", "line rgdu_arrco": "-95.0000",
      "rgdu_* lines total": "-635.6000", "line atmp": "22.0000", "line versement_mobilite_er": "50.0000", "line cdn_er": "16.3200", "line cfp_er": "20.0000",
    },
  },
];

for (const row of GOLDENS) {
  test(`${row.year} ${row.label}`, async () => {
    const result = await compute(row);
    for (const [key, want] of Object.entries(row.expected)) {
      assert.equal(result[key], want, `${row.label}: ${key} is ${String(result[key])}, expected ${String(want)} (${row.citation})`);
    }
  });
}

const HORS_DE_FRANCE = /182 A.*never priced with grille I/;
const METRO_ELIGIBLE = { domicile: "metropole", rgdu_eligibility: "eligible", apec_eligibility: "not_covered" };
const ZERO_RATES = { fr_atmp: { taux: "0.0000" }, fr_versement_mobilite: { taux: "0.0000" } };

const REFUSALS: (Engine & { label: string; refusal: RegExp })[] = [
  { label: "PAS for a Guyane / Mayotte domicile (grille III)", engine: "pas", input: { domicile: "guyane_mayotte" as never }, refusal: /Guyane/ },
  { label: "PAS before 2026", engine: "pas", input: { payDate: "2025-12-31" }, refusal: /no transcribed grille/ },
  { label: "PAS after 2026", engine: "pas", input: { payDate: "2027-01-01" }, refusal: /no transcribed grille/ },
  { label: "PAS transmitted rate above 100 %", engine: "pas", input: { transmittedRatePct: "100.5" }, refusal: /out of range/ },
  { label: "PAS zero periods per year", engine: "pas", input: { periodsPerYear: 0 }, refusal: /periodsPerYear/ },
  { label: "PAS negative base", engine: "pas", input: { base: "-10.00" }, refusal: /non-negative/ },
  // CGI art. 182 A prices French work paid to non-residents "différente du PAS": grille I would be the wrong mechanism.
  { label: "PAS for a hors-de-France domicile names the 182 A mechanism", engine: "pas", input: { domicile: "hors_de_france" }, refusal: HORS_DE_FRANCE },
  { label: "cotisations before 2026", engine: "cotisations", input: { payDate: "2025-12-31" }, refusal: /no transcribed tables/ },
  { label: "cotisations after 2026", engine: "cotisations", input: { payDate: "2027-01-01" }, refusal: /no transcribed tables/ },
  { label: "cotisations without a known effectif name FNAL", engine: "cotisations", input: { employerEffectif: null }, refusal: /FNAL refuses/ },
  { label: "cotisations on a negative brut", engine: "cotisations", input: { brut: "-10.00" }, refusal: /non-negative/ },
  { label: "cotisations with zero periods per year", engine: "cotisations", input: { periodsPerYear: 0 }, refusal: /periodsPerYear/ },
  { label: "cotisations with an AT/MP rate above 100 %", engine: "cotisations", input: { atmpRatePct: "100.5" }, refusal: /out of range/ },
  { label: "cotisations with an effectif finer than hundredths", engine: "cotisations", input: { employerEffectif: "49.501" }, refusal: /hundredths/ },
  { label: "adapter for a hors-de-France domicile", engine: "adapter", input: { facts: [{ fact_value: "12.00" }], answers: { domicile: "hors_de_france" } }, refusal: HORS_DE_FRANCE },
  // The retired lumped domicile affirmed two populations priced under different mechanisms: re-affirm, never price as métropole.
  { label: "adapter for the retired metropole_hors_france domicile", engine: "adapter", input: { facts: [{ fact_value: "12.00" }], answers: { domicile: "metropole_hors_france" } }, refusal: /re-affirm domicile/ },
  // CSS D.241-7 IV adjusts the annual SMIC to contractual hours and eligible extra hours.
  {
    label: "adapter for an RGDU-eligible employee without contractual hours", engine: "adapter",
    input: { facts: [{ fact_value: "12.00" }, { fact_value: "ordinary" }, { fact_value: "droit_commun", remuneration: "0", smic: "0", reduction: "0" }], answers: METRO_ELIGIBLE, rates: ZERO_RATES, ctx: { statutoryHours: undefined } },
    refusal: /contractual hours for this pay period are missing/,
  },
  // The 748 € / 766 € contrats-courts abattement is transcribed but never applied, so the default grille would over-withhold.
  { label: "adapter for a declared short contract without a transmitted rate", engine: "adapter", input: { facts: [], answers: { domicile: "metropole", short_contract: "true" } }, refusal: /declared short contract.*abattement.*is not computed/ },
  { label: "adapter without a known effectif names the employer fact", engine: "adapter", input: { facts: [], answers: { domicile: "metropole", apec_eligibility: "not_covered" } }, refusal: /Effectif salarié annuel de l'employeur.*effectif_moyen_annuel/ },
];

for (const row of REFUSALS) {
  test(`refuses: ${row.label}`, async () => {
    const pushed: Line[] = [];
    await assert.rejects(() => compute(row, pushed), row.refusal, row.label);
    assert.deepEqual(pushed, [], `${row.label}: no statutory line is emitted after the refusal`);
  });
}

test("no cotisation or retraite line falls as brut rises through the plafond, 4×PASS and 8×PASS edges", () => {
  const keys = [
    "vieillesseSal", "csg", "crds", "maladieEr", "vieillesseEr", "allocFamEr", "chomageEr", "agsEr", "fnalEr", "cdnEr",
    "arrcoSal", "arrcoEr", "cegSal", "cegEr", "cetSal", "cetEr",
  ] as const;
  let prev = calculateFrCotisations2026({ ...SMALL, brut: "0.00" });
  for (const brut of ["0.01", "100.00", "4004.99", "4005.00", "4005.01", "16019.99", "16020.00", "16020.01", "32039.99", "32040.00", "32040.01", "100000.00"]) {
    const cur = calculateFrCotisations2026({ ...SMALL, brut });
    for (const key of keys) {
      assert.ok(toUnits(cur[key]) >= toUnits(prev[key]), `${key} fell from ${prev[key]} to ${cur[key]} at brut ${brut}`);
    }
    prev = cur;
  }
});
