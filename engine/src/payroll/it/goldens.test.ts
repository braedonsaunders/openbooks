/**
 * IT conformance goldens for the IRPEF/INPS engine (compute-statutory.ts),
 * every transcribed year in one table.
 *
 * External goldens: AdE Circolare 4/E/2025 Esempi 1–3 (the only worked
 * examples published for the 2025 package), the AdE 2026 rates-page note
 * ("for taxable incomes exceeding €50,000, the due tax is €13,700 ... and
 * 43%") and the INPS-authored annual values (Circ. 6/2026, 14/2026, 27/2026).
 * Everything else is hand-worked from the transcribed tables.
 *
 * Isolation rule: rows proving one table pass pensionable "0" (no
 * contribution noise) and zero surtax rates; the INPS and surtax paths are
 * proven by their own rows.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fromUnits, toUnits } from "../../money/money.ts";
import { calculateIt2025, calculateIt2026, type It2025Input, type It2025Result } from "./compute-statutory.ts";
import { IT_REFUSED_2025 } from "./tax-year-2025.ts";
import { IT_REFUSED_2026 } from "./tax-year-2026.ts";

const ENGINES: Record<number, (input: It2025Input) => It2025Result> = { 2025: calculateIt2025, 2026: calculateIt2026 };

const BASE: It2025Input = {
  annualGrossEmployment: "0",
  annualPensionable: "0",
  periodsPerYear: 12,
  regionCode: "01",
  comuneCode: "H501",
  regionalRate: "0",
  municipalSurtax: { rate: "0" },
  hasDetrazioniDeclaration: false,
  isFixedTerm: false,
};

type Overrides = Partial<It2025Input>;
/** Table isolation: gross with no pensionable pay, so R is exactly the gross. */
const reddito = (gross: string, extra: Overrides = {}): Overrides => ({ annualGrossEmployment: gross, ...extra });
/** Contribution rows: the whole gross is pensionable. */
const insured = (gross: string, extra: Overrides = {}): Overrides =>
  ({ annualGrossEmployment: gross, annualPensionable: gross, ...extra });
const DECL = { hasDetrazioniDeclaration: true };
const SURTAXED = insured("20000", { regionalRate: "1.23", municipalSurtax: { rate: "0.8" } });

interface Golden {
  year: number;
  label: string;
  input: Overrides;
  /** Result fields (period figures as `period.<field>`), asserted to the 4dp unit. */
  expected: Record<string, string>;
  citation: string;
}

const CIRC_4E = "AdE Circolare 4/E/2025";
const ART13 = "TUIR art. 13 (standing law, hand-worked)";
const TI_9500 = { irpefLorda: "2185", detrazioneLavoro: "1955", irpefNetta: "230", trattamentoIntegrativo: "1200", somma: "503.50" };

/** Standing-law cases asserted in both years: the tables they read did not change for 2026. */
const STANDING: readonly Omit<Golden, "year">[] = [
  { label: "IRPEF lorda at 28.000", input: reddito("28000"), expected: { irpefLorda: "6440" }, citation: "28.000 x 23%" },
  { label: "Circ. 4/E Esempio 2: somma 159 euro", input: reddito("3000", { sommaBandBase: "11902.17" }), expected: { somma: "159" },
    citation: `${CIRC_4E} Esempio 2: 3.000/92 x 365 = 11.902,17 in 8.501–15.000 → 5,3% x 3.000 (L. 207/2024 c. 4 carries no sunset)` },
  { label: "detrazione lavoro at 20.000", input: reddito("20000", DECL), expected: { detrazioneLavoro: "2642.21" },
    citation: `${ART13}: 1.910 + 1.190 x trunc4(8.000/13.000 = 0,6153)` },
  { label: "detrazione lavoro at 30.000", input: reddito("30000", DECL), expected: { detrazioneLavoro: "1801.19" },
    citation: `${ART13}: 1.910 x trunc4(20.000/22.000 = 0,9090) = 1.736,19, +65 (c. 2 band)` },
  { label: "ulteriore detrazione flat at 32.000", input: reddito("32000"), expected: { ulterioreDetrazione: "1000" },
    citation: "L. 207/2024 c. 6 (no sunset): flat 1.000 to 32.000" },
  { label: "ulteriore detrazione decalage at 36.000", input: reddito("36000"), expected: { ulterioreDetrazione: "500" },
    citation: "L. 207/2024 c. 6: 1.000 x (40.000 − 36.000)/8.000" },
  { label: "trattamento integrativo and somma at 9.500", input: reddito("9500", DECL), expected: TI_9500,
    citation: "lorda 23% x 9.500 = 2.185 > 1.955 − 75 → TI 1.200; detrazione capped at 1.955; somma 5,3% x 9.500" },
  // Art. 13 c. 2 "superiore a 25.000 euro": the gate is cent-precise, and detC1 (2.184,53) is identical at all three points.
  { label: "c. 2 +65 gate: 25.000,00 earns no +65", input: reddito("25000.00", DECL),
    expected: { redditoComplessivo: "25000", detrazioneLavoro: "2184.53" }, citation: `${ART13}: 1.910 + 1.190 x 0,2307` },
  { label: "c. 2 +65 gate: 25.000,01 earns +65", input: reddito("25000.01", DECL),
    expected: { redditoComplessivo: "25000.01", detrazioneLavoro: "2249.53" }, citation: `${ART13}: 2.184,53 + 65` },
  { label: "c. 2 +65 gate: 25.000,50 earns +65", input: reddito("25000.50", DECL),
    expected: { redditoComplessivo: "25000.50", detrazioneLavoro: "2249.53" }, citation: `${ART13}: 2.184,53 + 65` },
];

const GOLDENS: readonly Golden[] = [
  ...[2025, 2026].flatMap((year) => STANDING.map((row) => ({ year, ...row }))),

  // ---- 2025 -----------------------------------------------------------------
  // The circular prints 11.744,19; 2.000/62 x 365 recomputes to 11.774,19 — a
  // transposition that does not move the 8.501–15.000 band.
  { year: 2025, label: "Circ. 4/E Esempio 1: somma 106 euro", input: reddito("2000", { sommaBandBase: "11744.19", presumedTotalIncome: "6000" }),
    expected: { redditoComplessivo: "6000", somma: "106" }, citation: `${CIRC_4E} Esempio 1: 5,3% x 2.000` },
  { year: 2025, label: "Circ. 4/E Esempio 3: somma 238,50 euro", input: reddito("4500", { sommaBandBase: "15000", presumedTotalIncome: "15000" }),
    expected: { redditoComplessivo: "15000", somma: "238.50" }, citation: `${CIRC_4E} Esempio 3: 5,3% x 4.500 (quota imponibile in Italia)` },
  { year: 2025, label: "IRPEF lorda at 50.000", input: reddito("50000"), expected: { irpefLorda: "14140" }, citation: "6.440 + 22.000 x 35%" },
  { year: 2025, label: "IRPEF lorda at 100.000", input: reddito("100000"), expected: { irpefLorda: "35640" }, citation: "14.140 + 50.000 x 43%" },
  { year: 2025, label: "detrazione lavoro at 40.000", input: reddito("40000", DECL), expected: { detrazioneLavoro: "868.10", ulterioreDetrazione: "0" },
    citation: `${ART13}: 1.910 x trunc4(10.000/22.000 = 0,4545); no +65 above 35.000; ulteriore 0 at 40.000` },
  { year: 2025, label: "no declaration: gross IRPEF, TI still paid", input: reddito("9500"),
    expected: { detrazioneLavoro: "0", irpefNetta: "2185", trattamentoIntegrativo: "1200", somma: "503.50" },
    citation: "art. 13 needs the dichiarazione; TI reads the spettante detrazione and somma is automatic (Circ. 4/E)" },
  { year: 2025, label: "INPS pre-1996 at 60.000", input: insured("60000"), expected: { inpsWorker: "5559.52", inpsEmployer: "14286" },
    citation: "9,19% x 60.000 + 1% x (60.000 − 55.448); employer 23,81%" },
  { year: 2025, label: "INPS post-1995 at 130.000 capped at the 120.607 massimale", input: insured("130000", { isPost1995: true }),
    expected: { inpsWorker: "11735.37", inpsEmployer: "28716.53" },
    citation: "9,19% x 120.607 = 11.083,78 + 1% x 65.159 = 651,59; employer 23,81% x 120.607" },
  { year: 2025, label: "comunale soglia 12.000 exempts at the soglia", input: reddito("12000", { regionalRate: "1.23", municipalSurtax: { rate: "0.8", exemption: "12000" } }),
    expected: { addizionaleComunale: "0", addizionaleRegionale: "147.60" }, citation: "0,8% with a 12.000 soglia; regionale 1,23% x 12.000 has no soglia" },
  { year: 2025, label: "comunale one cent above the soglia", input: reddito("12000.01", { regionalRate: "1.23", municipalSurtax: { rate: "0.8", exemption: "12000" } }),
    expected: { addizionaleComunale: "96" }, citation: "0,8% x 12.000,01 = 96,00008" },
  { year: 2025, label: "annual and period split at 30.000", input: insured("30000", { ...DECL, regionalRate: "1.23", municipalSurtax: { rate: "0.8" } }),
    expected: {
      redditoComplessivo: "27243", irpefLorda: "6265.89", detrazioneLavoro: "2044.26", ulterioreDetrazione: "1000", irpefNetta: "3221.63",
      trattamentoIntegrativo: "0", somma: "0", inpsWorker: "2757", inpsEmployer: "7143", addizionaleRegionale: "335.09",
      addizionaleComunale: "217.94", "period.irpef": "268.47", "period.inpsWorker": "229.75", "period.trattamentoIntegrativo": "0",
    },
    citation: "R 27.243 after INPS 2.757; det 1.910 + 1.190 x 0,0582 + 65; period = annual/12 half-up (3.221,63/12 = 268,4691)" },
  { year: 2025, label: "no family charges in the TI band computes TI 0", input: { ...SURTAXED, ...insured("25000", { hasFamilyCharges: false }) },
    expected: { trattamentoIntegrativo: "0" }, citation: "R > 15.000 with no family: TI 0" },

  // ---- 2026 -----------------------------------------------------------------
  { year: 2026, label: "IRPEF lorda at 50.000 (AdE note)", input: reddito("50000"), expected: { irpefLorda: "13700" },
    citation: "AdE rates page note (upd. 16/01/2026): 6.440 + 22.000 x 33% = 13.700" },
  { year: 2026, label: "IRPEF lorda at 100.000", input: reddito("100000"), expected: { irpefLorda: "35200" }, citation: "13.700 + 50.000 x 43%" },
  { year: 2026, label: "sweep: 27.999", input: reddito("27999"), expected: { irpefLorda: "6439.77" }, citation: "23% x 27.999" },
  { year: 2026, label: "sweep: 28.001", input: reddito("28001"), expected: { irpefLorda: "6440.33" }, citation: "6.440 + 33% x 1" },
  { year: 2026, label: "sweep: 49.999", input: reddito("49999"), expected: { irpefLorda: "13699.67" }, citation: "6.440 + 33% x 21.999" },
  { year: 2026, label: "sweep: 50.001", input: reddito("50001"), expected: { irpefLorda: "13700.43" }, citation: "13.700 + 43% x 1" },
  // L. 199/2025 c. 4 trims only art. 16-ter oneri detrazioni, which the engine does not carry: 250.000 computes, not refuses.
  { year: 2026, label: "the 200k sterilizzazione has no engine effect at 250.000", input: reddito("250000", DECL),
    expected: { irpefLorda: "99700", detrazioneLavoro: "0", ulterioreDetrazione: "0", irpefNetta: "99700", trattamentoIntegrativo: "0", somma: "0" },
    citation: "13.700 + 43% x 200.000; no detrazioni above 50.000" },
  { year: 2026, label: "INPS pre-1996 at 60.000", input: insured("60000"), expected: { inpsWorker: "5551.76", inpsEmployer: "14286" },
    citation: "INPS Circ. 6/2026: 9,19% x 60.000 + 1% x (60.000 − 56.224); employer 23,81%" },
  { year: 2026, label: "INPS post-1995 at 130.000 capped at the 122.295 massimale", input: insured("130000", { isPost1995: true }),
    expected: { inpsWorker: "11899.62", inpsEmployer: "29118.44" },
    citation: "INPS Circ. 14/2026 massimale: 9,19% x 122.295 = 11.238,91 + 1% x 66.071 = 660,71; employer 23,81% x 122.295" },
  { year: 2026, label: "unknown post-1995 status below the massimale computes", input: insured("120000", { isPost1995: undefined }),
    expected: { inpsWorker: "11665.76" }, citation: "L. 335/1995 art. 2 c. 18: the massimale does not bind below 122.295" },
  { year: 2026, label: "substitute regimes price flat rates on carved-out bases",
    input: insured("30000", { renewalIncrease: "1200.00", shiftAllowance: "200.00", premiRisultato: "1000.00", priorYearEmploymentIncome: "30000", premiRisultatoEligible: true }),
    expected: { "period.sostitutivaRinnovi": "60", "period.sostitutivaTurni": "30", "period.sostitutivaPremi": "10" },
    citation: "L. 199/2025: rinnovi 1.200 x 5%, turni 200 x 15%, premi 1.000 x 1% (within caps)" },
];

function compute(row: { year: number; input: Overrides }): It2025Result {
  const engine = ENGINES[row.year];
  assert.ok(engine, `no IT engine for ${row.year}`);
  return engine({ ...BASE, ...row.input });
}

for (const row of GOLDENS) {
  test(`${row.year} ${row.label}`, () => {
    const result = compute(row);
    const actual: Record<string, string> = { ...(result as unknown as Record<string, string>) };
    for (const [field, value] of Object.entries(result.period)) actual[`period.${field}`] = value;
    for (const [field, figure] of Object.entries(row.expected)) {
      assert.equal(actual[field], fromUnits(toUnits(figure)), `${row.year} ${row.label}: ${field} — ${row.citation}`);
    }
  });
}

const REFUSALS: readonly { year: number; label: string; input: Overrides; refusal: RegExp }[] = [
  { year: 2025, label: "pension income", input: { ...SURTAXED, isPensioner: true }, refusal: /TABELLA 7/ },
  { year: 2025, label: "unknown regione", input: { ...SURTAXED, regionCode: "XX" }, refusal: /unknown IT regione/ },
  { year: 2025, label: "unknown domicile comune", input: { ...SURTAXED, comuneCode: null }, refusal: /domicile comune is unknown/ },
  { year: 2025, label: "comune that is not a codice catastale", input: { ...SURTAXED, comuneCode: "ROMA" }, refusal: /codice catastale/ },
  { year: 2025, label: "missing regionale rate", input: { ...SURTAXED, regionalRate: null }, refusal: /it_addizionale_regionale/ },
  { year: 2025, label: "missing comunale rate", input: { ...SURTAXED, municipalSurtax: null }, refusal: /it_addizionale_comunale/ },
  { year: 2025, label: "family charges in the TI band", input: { ...SURTAXED, ...insured("25000", { hasFamilyCharges: true }) },
    refusal: /art\. 12 TUIR.*IT_REFUSED_2025/ },
  { year: 2025, label: "negative gross", input: { ...SURTAXED, annualGrossEmployment: "-1" }, refusal: /non-negative/ },
  { year: 2026, label: "missing regionale rate", input: { ...SURTAXED, regionalRate: null }, refusal: /in 2026/ },
  { year: 2026, label: "missing comunale rate", input: { ...SURTAXED, municipalSurtax: null }, refusal: /it_addizionale_comunale.*H501.*in 2026/ },
  { year: 2026, label: "family charges in the TI band", input: { ...SURTAXED, ...insured("25000", { hasFamilyCharges: true }) },
    refusal: /IT_REFUSED_2026/ },
  // TUIR art. 12 (L. 207/2024, D.Lgs. 192/2025) needs family facts the declaration does not carry, at any income.
  { year: 2026, label: "family charges outside the TI band", input: insured("35000", { hasFamilyCharges: true }),
    refusal: /art\. 12 TUIR.*IT_REFUSED_2026/ },
  { year: 2026, label: "pensionable pay below the daily-minimum base", input: insured("14400"),
    refusal: /daily-minimum base.*contribution days.*CCNL minimum/ },
  { year: 2026, label: "unknown post-1995 status where the massimale changes IVS", input: insured("130000", { isPost1995: undefined }),
    refusal: /IVS base.*122295.*anzianita_post_1995/ },
  // L. 92/2012 art. 2 c. 28 (INPS Circ. 13/2023, 91/2020): renewals and exclusions need facts the pack does not carry.
  { year: 2026, label: "fixed-term NASpI surcharge", input: insured("35000", { isFixedTerm: true }), refusal: /tempo determinato.*NASpI.*1\.40%.*0\.50/ },
  { year: 2026, label: "unknown employment term", input: insured("35000", { isFixedTerm: null }), refusal: /employment term.*unknown.*NASpI.*1\.40%.*0\.50/ },
];

for (const row of REFUSALS) {
  test(`${row.year} refused: ${row.label}`, () => {
    assert.throws(() => compute(row), row.refusal, `${row.year} ${row.label}`);
  });
}

test("2026 IRPEF lorda never decreases across the scale, 0 to 100.000", () => {
  let previous = -1n;
  for (let gross = 0; gross <= 100_000; gross += 1_000) {
    const lorda = toUnits(calculateIt2026({ ...BASE, annualGrossEmployment: String(gross) }).irpefLorda);
    assert.ok(lorda >= previous, `${gross}: ${fromUnits(lorda)} < ${fromUnits(previous)}`);
    previous = lorda;
  }
});

test("2026 substitute regimes carve their 2.400 base out of ordinary IRPEF", () => {
  const plain = calculateIt2026({ ...BASE, ...insured("30000") });
  const carved = compute(GOLDENS.find((row) => row.label.startsWith("substitute regimes"))!);
  assert.equal(fromUnits(toUnits(plain.imponibileIrpef) - toUnits(carved.imponibileIrpef)), "2400.0000");
});

test("the refused lists stay honest about out-of-scope and newly priced mechanics", () => {
  for (const [year, list, present, absent] of [
    [2025, IT_REFUSED_2025, ["art. 12 TUIR", "TFR", "INAIL"], []],
    [2026, IT_REFUSED_2026, ["art. 12 TUIR", "TFR", "INAIL", "200.000"], ["rinnovi contrattuali", "c. 10–11", "c. 18–21"]],
  ] as const) {
    assert.ok(list.length >= 15, `${year}: ${list.length} refused entries`);
    for (const needle of present) assert.ok(list.some((entry) => entry.includes(needle)), `${year} refuses ${needle}`);
    for (const needle of absent) assert.ok(!list.some((entry) => entry.includes(needle)), `${year} prices ${needle}, not refuses`);
  }
});
