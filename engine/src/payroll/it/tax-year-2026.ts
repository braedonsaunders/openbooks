/**
 * Transcribed 2026 statutory tables for the IT payroll pack (anno d'imposta
 * 2026, calendar year, `taxYear: 2026`).
 *
 * Every figure below is quoted from the authority's own publication named in
 * its comment. "No quote, no citation": the sentence carrying the number is
 * reproduced so a reviewer can check the transcription without re-fetching.
 * Secondary sources (vendors, law firms, other ERPs) were used nowhere — not
 * even as corroboration.
 *
 * What changed from 2025 to 2026 (the whole delta):
 * - IRPEF second bracket 35% -> 33% (L. 199/2025 art. 1 c. 3), so the due tax
 *   above 50.000 is 13.700 + 43% (AdE rates page note, upd. 16/01/2026).
 * - New art. 16-ter c. 5-bis TUIR (L. 199/2025 art. 1 c. 4): −440 euro on the
 *   detrazione for 19% oneri / party donations / calamity premiums when the
 *   reddito complessivo exceeds 200.000. The engine carries no oneri inputs
 *   (see IT_REFUSED_2025, carried into IT_REFUSED_2026), so the reduction
 *   applies to a detrazione amount that is always zero here: computed
 *   normally, documented, never worked around.
 * - INPS annual values from Circolare n. 6 del 30 gennaio 2026 (minimale
 *   58,13 on a 611,85 trattamento minimo; prima fascia 56.224 / 4.685;
 *   massimale post-1995 122.295) with the FPLD 33% total re-attested for
 *   2026 by INPS Circolare n. 27 dell'11 marzo 2026; the 9,19/23,81 split is
 *   CARRIED from Tabella 1/2025 (labeled below, not freshly quoted).
 * - Everything else (art. 13 detrazione formula + 65 euro, c. 6 ulteriore
 *   detrazione, c. 4 somma, trattamento integrativo) is standing law the
 *   2026 Budget did not amend: L. 207/2024 c. 4 and c. 6 carry no sunset
 *   (full texts via the MEF portal, "In vigore dal 01/01/2025"), the c. 2
 *   art. 13 amendment and the c. 3 D.L. 3/2020 amendment are textual TUIR
 *   amendments, and no L. 199/2025 comma touches art. 13.
 * - Three NEW 2026-only measures (5% on contractual-renewal increases,
 *   15% on night/holiday/shift allowances, 15% trattamento integrativo
 *   speciale for tourism/hospitality night and festive-holiday overtime,
 *   L. 199/2025 c. 18–21 for prestazioni 1 Jan–30 Sep 2026) are REFUSED by
 *   name: the engine has no CCNL-increase, allowance, or sector inputs, so
 *   there is nothing to price them on. See IT_REFUSED_2026.
 *
 * Sourcing outcomes per host (recorded distinctly):
 * - agenziaentrate.gov.it: 200, full text — the EN IRPEF rates page (last
 *   update 16/01/2026: stale 35% table + the 33% note quoted below).
 * - def.giustiziatributaria.gov.it (MEF Documentazione Tributaria): 200,
 *   per-comma PDFs — L. 199/2025 art. 1 c. 3 and c. 4, L. 207/2024 art. 1
 *   c. 4 and c. 6, each quoted in full below.
 * - gazzettaufficiale.it caricaArticolo: 200 shell, article body
 *   JS-rendered ("Gazzetta in fase di caricamento") — NOT used; the MEF
 *   portal carries the same GU-published text (GU n. 301 del 30/12/2025,
 *   S.O. for L. 199/2025; GU n. 305 del 31/12/2024, S.O. for L. 207/2024).
 * - inps.it circular page: 200 JS shell (same as 2025) — NOT used. The
 *   INPS-authored Circolare 6/2026 values below are reached through three
 *   independent mirrors and corroborated by their own arithmetic (611,85 x
 *   9,5% = 58,12575 -> 58,13; 603,40 x 1,014 = 611,8476 -> 611,85;
 *   120.606,90 x 1,014 = 122.295,40 -> 122.295; 56.224 / 12 = 4.685,33 ->
 *   4.685), and the FPLD 33% total plus the 122.295 massimale through a
 *   second INPS-authored circular (27/2026) quoted below. One mirror's
 *   611,46 trattamento minimo is DISCARDED: 611,46 x 9,5% = 58,09, which
 *   contradicts the triple-attested 58,13.
 * - CU 2027 istruzioni (redditi 2026) and 730/2027 istruzioni: NOT yet
 *   published at transcription time (September 2026) — searched, not found.
 *   The half-up-to-cent rounding and the 4-decimal ratio truncation are
 *   CARRIED from the CU 2026 / 730-2026 texts with a re-verify note, not
 *   freshly quoted.
 *
 * Money discipline: figures are decimal STRINGS, never floats. The engine
 * consumes them with the repo's bigint-unit helpers (see canada/decimal.ts).
 * Ratios in the detrazione formula are TRUNCATED to 4 decimals per the
 * authority (730/2026 TABELLA 6 note 2, carried), and every pushed line is
 * rounded half-up to the cent per the CU 2026 istruzioni (quoted below,
 * carried pending CU 2027).
 */

import type { ItMarginalBand } from "./tax-year-2025.ts";

export const IT_2026_SOURCE_URLS = {
  adeRatesEn:
    "https://www.agenziaentrate.gov.it/portale/web/english/personal-income-tax-rates-and-calculation",
  inpsCirc6_2026:
    "https://www.inps.it/it/it/inps-comunica/atti/circolari-messaggi-e-normativa/dettaglio.circolari-e-messaggi.2026.01.circolare-numero-6-del-30-01-2026_15151.html",
} as const;

/**
 * IRPEF scaglioni 2026 — L. 199/2025 art. 1 c. 3 (GU n. 301 del 30/12/2025,
 * S.O.), via the MEF portal:
 *
 * "3. All'articolo 11, comma 1, lettera b), del testo unico delle imposte sui
 * redditi di cui al decreto del Presidente della Repubblica 22 dicembre
 * 1986, n. 917, le parole: «35 per cento» sono sostituite dalle seguenti:
 * «33 per cento»."
 *
 * Corroborated by the AdE rates page note (upd. 16/01/2026): "the 2026
 * Budget Law has reduced the second Irpef tax bracket (income between
 * €28,000 and €50,000) from 35% to 33%. As a result, for taxable incomes
 * exceeding €50,000, the due tax is €13,700 (instead of €14,140) and 43% on
 * the portion of income exceeding €50,000." 6.440 = 23% of 28.000 (carried);
 * 13.700 = 6.440 + 33% of 22.000. The page's own TABLE still prints the
 * prior 35% / 14.140 figures — the note governs, and both are recorded so
 * the inconsistency is visible rather than silently resolved.
 */
export const IT_2026_IRPEF_BANDS: readonly ItMarginalBand[] = [
  { upTo: "28000", rate: "0.23" },
  { upTo: "50000", rate: "0.33" },
  { upTo: null, rate: "0.43" },
];

/** Cumulative tax at each band boundary: AdE note (13.700), AdE table (6.440). */
export const IT_2026_IRPEF_CUMULATIVE = {
  at28000: "6440",
  at50000: "13700",
} as const;

/**
 * Sterilizzazione above 200.000 — L. 199/2025 art. 1 c. 4 (GU n. 301 del
 * 30/12/2025, S.O.), via the MEF portal:
 *
 * "4. All'articolo 16-ter del testo unico delle imposte sui redditi di cui
 * al decreto del Presidente della Repubblica 22 dicembre 1986, n. 917, dopo
 * il comma 5 è inserito il seguente: «5-bis. Per i contribuenti titolari di
 * un reddito complessivo superiore a 200.000 euro è diminuito di un importo
 * pari a 440 euro l'ammontare della detrazione dall'imposta lorda,
 * determinato tenendo conto di quanto previsto dai commi da 1 a 5 del
 * presente articolo e dall'articolo 15, comma 3-bis, spettante in relazione
 * ai seguenti oneri: a) gli oneri la cui detraibilità è fissata nella misura
 * del 19 per cento ... fatta eccezione per le spese sanitarie ...; b) le
 * erogazioni liberali in favore dei partiti politici ...; c) i premi di
 * assicurazione per rischio eventi calamitosi ...»."
 *
 * AdE rates page note: "For taxpayers with a total income exceeding
 * €200,000, a mechanism has been introduced to neutralize the tax benefit
 * arising from the reduction in the tax rate (Article 1, paragraphs 3 and 4,
 * Law No. 199/2025)."
 *
 * ENGINE EFFECT: NONE. The 440 euro reduction applies to the art. 16-ter /
 * art. 15 detrazioni for oneri, and the engine carries no oneri inputs (see
 * IT_REFUSED_2026: "art. 16-ter TUIR ... (no oneri inputs in the engine)").
 * A 250.000 reddito therefore computes the same IRPEF lorda/netta with or
 * without c. 4 — pinned by the 200k test in tax-year-2026.test.ts. Refusing
 * above-200k payrolls would block legitimate pay; inventing an oneri input
 * would price a detrazione nobody declared.
 */
export const IT_2026_STERILIZZAZIONE_200K = {
  thresholdExclusive: "200000",
  reduction: "440",
  engineEffect: "none — no oneri inputs in the engine",
} as const;

/**
 * Detrazione per redditi di lavoro dipendente 2026 — art. 13 c. 1 TUIR as
 * amended by L. 207/2024 art. 1 c. 2 (textual amendment: «1.880 euro» ->
 * «1.955 euro», quoted in tax-year-2025.ts), applied for 2026 unchanged:
 *
 * "fino a 15.000 euro: 1.955 (non inferiore a 690; se a tempo determinato,
 * non inferiore a 1.380)" / "oltre 15.000 euro e fino a 28.000 euro: 1.910 +
 * 1.190 x [(28.000 - reddito) / (28.000 - 15.000)]" / "oltre 28.000 euro e
 * fino a 50.000 euro: 1.910 x [(50.000 - reddito) / (50.000 - 28.000)]" /
 * "oltre 50.000 euro: nessuna detrazione" (AdE Circolare 4/E/2025 §1 schema,
 * carried: the formula is TUIR text, and L. 199/2025 leaves art. 13
 * untouched — its IRPEF provisions are commi 3 (art. 11) and 4 (art. 16-ter)
 * only).
 *
 * The no-tax-area arithmetic carries with it: 8.500 x 23% = 1.955 exactly.
 * Reddito complessivo al netto dell'abitazione principale (art. 13 c. 6-bis
 * TUIR) is unchanged standing law.
 */
export const IT_2026_DETRAZIONE_LAVORO = {
  bandA_cap: "15000",
  bandA_amount: "1955",
  floor: "690",
  floorFixedTerm: "1380",
  bandB_cap: "28000",
  bandB_base: "1910",
  bandB_factor: "1190",
  bandB_span: "13000",
  bandC_cap: "50000",
  bandC_base: "1910",
  bandC_span: "22000",
} as const;

/**
 * Art. 13 c. 2 TUIR increase, standing TUIR text (predates 2025, untouched
 * by both Budget laws) — carried for 2026: "La detrazione spettante ai sensi
 * del comma 1 è aumentata di un importo pari a 65 euro, se il reddito
 * complessivo è superiore a 25.000 euro ma non a 35.000 euro." The gate is
 * cent-precise (R > 25.000 and R ≤ 35.000): R is computed to the cent, so a
 * "25.001" whole-euro floor would wrongly exclude 25.000,01–25.000,99. The
 * constant below carries the EXCLUSIVE bound the engine compares with `>`.
 */
export const IT_2026_DETRAZIONE_C2 = {
  amount: "65",
  fromExclusive: "25000",
  toInclusive: "35000",
} as const;

/**
 * Ratio precision — CARRIED from 730/2026 TABELLA 6 note (2), pending the
 * 730/2027 istruzioni (redditi 2026, not yet published): "Se il risultato
 * dei rapporti è maggiore di 0, lo stesso si assume nelle prime 4 cifre
 * decimali." Ratios are TRUNCATED (not rounded) to 4 decimals. Re-verify
 * against TABELLA 6 of the 730/2027 istruzioni on publication; the rule
 * text is stable across years, which is why the carry is a note and not a
 * fresh quote.
 */
export const IT_2026_RATIO_DECIMALS = 4;

/**
 * Ulteriore detrazione 2026 — L. 207/2024 art. 1 c. 6 (GU n. 305 del
 * 31/12/2024, S.O.), via the MEF portal, in full (no sunset — "In vigore
 * dal 01/01/2025", so it governs 2026 unchanged):
 *
 * "6. Ai titolari di reddito di lavoro dipendente di cui all'articolo 49
 * del testo unico delle imposte sui redditi ..., con esclusione di quelli
 * indicati alla lettera a) del comma 2 del medesimo articolo 49, che hanno
 * un reddito complessivo superiore a 20.000 euro spetta un'ulteriore
 * detrazione dall'imposta lorda, rapportata al periodo di lavoro, di importo
 * pari: a) a 1.000 euro, se l'ammontare del reddito complessivo è superiore
 * a 20.000 euro ma non a 32.000 euro; b) al prodotto tra 1.000 euro e
 * l'importo corrispondente al rapporto tra 40.000 euro, diminuito del
 * reddito complessivo, e 8.000 euro, se l'ammontare del reddito complessivo
 * è superiore a 32.000 euro ma non a 40.000 euro."
 */
export const IT_2026_ULTERIORE_DETRAZIONE = {
  amount: "1000",
  bandA_fromExclusive: "20000",
  bandA_toInclusive: "32000",
  bandB_toExclusive: "40000",
  bandB_span: "8000",
} as const;

/**
 * Somma che non concorre al reddito 2026 — L. 207/2024 art. 1 c. 4 (GU
 * n. 305 del 31/12/2024, S.O.), via the MEF portal, in full (no sunset —
 * "In vigore dal 01/01/2025", so it governs 2026 unchanged):
 *
 * "4. Ai titolari di reddito di lavoro dipendente di cui all'articolo 49
 * del testo unico delle imposte sui redditi ..., con esclusione di quelli
 * indicati alla lettera a) del comma 2 del medesimo articolo 49, che hanno
 * un reddito complessivo non superiore a 20.000 euro è riconosciuta una
 * somma, che non concorre alla formazione del reddito, determinata
 * applicando al reddito di lavoro dipendente del contribuente la percentuale
 * corrispondente di seguito indicata: a) 7,1 per cento, se il reddito di
 * lavoro dipendente non è superiore a 8.500 euro; b) 5,3 per cento, se il
 * reddito di lavoro dipendente è superiore a 8.500 euro ma non a 15.000
 * euro; c) 4,8 per cento, se il reddito di lavoro dipendente è superiore a
 * 15.000 euro." C. 5 (rapportato all'intero anno) and c. 7 (sostituto
 * recognition all'atto dell'erogazione + conguaglio) are standing mechanics
 * of the same measure.
 */
export const IT_2026_SOMMA = {
  incomeCap: "20000",
  bands: [
    { upTo: "8500", rate: "0.071" },
    { upTo: "15000", rate: "0.053" },
    { upTo: null, rate: "0.048" },
  ],
} as const;

/**
 * Trattamento integrativo 2026 — D.L. 3/2020 art. 1 c. 1 as amended by
 * L. 207/2024 art. 1 c. 3 (textual amendment inserting the −75 euro
 * correction, quoted in tax-year-2025.ts), standing law the 2026 Budget did
 * not amend. 2026-positive corroboration (both 2026-dated, both restating
 * the full machinery): a February 2026 labor-consultancy memo ("diminuite
 * dell'importo di 75 euro rapportato al periodo di lavoro nell'anno" with
 * the 15.001–28.000 verifica capped at 1.200) and a 2026 employer notice
 * ("misura massima di euro 1.200,00 nell'anno in corso", 15.000 cap).
 *
 * "Per l'anno 2026 esso è riconosciuto nella misura di 1.200 euro ai
 * lavoratori la cui imposta lorda ... sia di importo superiore alle
 * detrazioni per lavoro dipendente, diminuite dell'importo di 75 euro
 * rapportato al periodo di lavoro nell'anno e il cui reddito complessivo
 * non sia superiore a 15.000 euro." Sostituto recognition in busta paga
 * from January (standing D.L. 3/2020 mechanics).
 */
export const IT_2026_TRATTAMENTO_INTEGRATIVO = {
  amount: "1200",
  incomeCap: "15000",
  detrazioneReduction: "75",
} as const;

/**
 * INPS FPLD/IVS 2026 — ordinary private-sector case (operai/impiegati a
 * tempo indeterminato).
 *
 * Total 33% re-attested for 2026 by INPS Circolare n. 27 dell'11 marzo 2026
 * (INPS-authored, via mirror): "Per l'anno 2026, l'aliquota contributiva a
 * carico dei lavoratori dipendenti non agricoli, autorizzati alla
 * prosecuzione volontaria nel Fondo pensioni lavoratori dipendenti (FPLD)
 * con decorrenza successiva al 31 dicembre 1995, è pari al 33%."
 *
 * The 9,19 / 23,81 split is CARRIED from INPS Tabella 1/2025 (attested in
 * tax-year-2025.ts: "Fondo pensioni 33,00" with "A carico dipendente 9,19",
 * 33,68 impresa + 9,19 = 42,87): 23,81 + 9,19 = 33,00 closes against the
 * re-attested 2026 total, and neither L. 199/2025 nor Circolare 6/2026
 * (whose contents all three mirrors enumerate as minimali/massimali/valori
 * only) amends FPLD rates. A Tabella 1/2026 stating the split row was not
 * obtainable (INPS allegati are JS-served); the carry is labeled here so a
 * reviewer can see exactly which cell is fresh-2026 and which is not.
 */
export const IT_2026_INPS_IVS = {
  total: "0.33",
  worker: "0.0919",
  employer: "0.2381",
} as const;

/**
 * Prima fascia / 1% additional 2026 — INPS Circolare 6/2026 via two
 * independent mirrors (tax publisher + employer association), identical
 * figures: "Prima fascia di retribuzione pensionabile annua (oltre la quale
 * è dovuta la contribuzione aggiuntiva IVS dell'1% a carico lavoratore ...
 * con aliquota IVS a proprio carico inferiore al 10%) = € 56.224,00 (mese
 * € 4.685,00)." 56.224 / 12 = 4.685,33 -> 4.685, same monthly convention as
 * 2025 (55.448 / 12 = 4.621,33 -> 4.621). Seat (standing law): art. 3-ter
 * D.L. 384/1992, mensilizzazione for the payment.
 */
export const IT_2026_PRIMA_FASCIA = {
  annual: "56224",
  monthly: "4685",
  additionalWorker: "0.01",
} as const;

/**
 * Massimale L. 335/1995 for post-1995 iscritti 2026 — INPS Circolare n. 27
 * dell'11 marzo 2026 (INPS-authored, via mirror): "... è pari a 122.295,00
 * euro" for contribution seniority not earlier than 1 January 1996.
 * Corroborated by Circolare 6/2026 via two mirrors ("Massimale contributivo
 * e pensionabile annuo ... = € 122.295,00") and by the arithmetic:
 * 120.606,90 x 1,014 (ISTAT FOI 2025/2024, per the employer-association
 * mirror) = 122.295,3966 -> 122.295, same unit rounding as 2025
 * (120.606,90 -> 120.607). Pre-1996 iscritti have NO massimale (only the
 * prima fascia above).
 */
export const IT_2026_MASSIMALE_POST1995 = "122295";

/**
 * Minimale giornaliero 2026 — INPS Circolare 6/2026 via THREE independent
 * mirrors (tax publisher, employer association, small-industry
 * confederation), identical figures: minimale giornaliero € 58,13, "9,5%
 * del trattamento minimo di pensione", trattamento minimo mensile FPLD
 * € 611,85. Arithmetic: 611,85 x 9,5% = 58,12575 -> 58,13; and 603,40 x
 * 1,014 (ISTAT) = 611,8476 -> 611,85. A second union table independently
 * stamps "Anno 2026 (T.M. mensile: € 611,85)".
 *
 * DISCARDED: one mirror's € 611,46 "minimo di pensione" — 611,46 x 9,5% =
 * 58,09, contradicting the triple-attested 58,13, so it cannot be the base
 * the circular's 9,5% rule was applied to. Recorded so nobody re-adds it.
 */
export const IT_2026_MINIMALE = {
  trattamentoMinimoMensile: "611.85",
  giornaliero: "58.13",
  percent: "0.095",
} as const;

/**
 * Rounding — CARRIED from the CU 2026 istruzioni (redditi 2025), AdE,
 * pending the CU 2027 istruzioni (redditi 2026, not yet published):
 *
 * "La certificazione è compilata in euro esponendo i dati in centesimi,
 * arrotondando per eccesso se la terza cifra decimale è uguale o superiore
 * a cinque o per difetto se inferiore a detto limite. Ad esempio: 55,505
 * diventa 55,51; 65,626 diventa 65,63; 65,493 diventa 65,49."
 * Half-up to the cent, at each certified amount. Re-verify against the CU
 * 2027 istruzioni on publication; the sentence is identical across years,
 * which is why the carry is a note and not a fresh quote.
 */
export const IT_2026_ROUNDING = "half-up-to-cent" as const;

/**
 * Addizionali regionale e comunale 2026 — tenant-entered rates, same model
 * as 2025 (standing law: D.Lgs. 15 dicembre 1997, n. 446; D.Lgs. 28
 * settembre 1998, n. 360). The computation from a declared rate is: surtax
 * = rate × reddito complessivo ai fini IRPEF (same base as IRPEF), with the
 * comune's exemption threshold zeroing the surtax at or below the soglia.
 * No pack constant can carry ~20 regional deliberations or ~7.900 comunali;
 * the 2026 deliberations are entered by the employer exactly as a SUI
 * experience rate is.
 */
export const IT_2026_SURTAX_MODEL = "tenant-declared-rate" as const;

/**
 * Named refusals: everything the 2026 engine does not compute, with the
 * reason. The engine quotes these names back. Carries the full 2025 list
 * (same gaps, same law) plus the four 2026-specific entries at the end:
 * the two 2026-only substitute-tax regimes, the tourism-sector integrativo,
 * and the 200k sterilizzazione recording.
 */
export const IT_REFUSED_2026: readonly string[] = [
  "art. 12 TUIR family detrazioni (coniuge/figli/ascendenti: needs ages, disability status and ripartizione the pack does not carry)",
  "trattamento integrativo for reddito complessivo 15.001–28.000 (needs art. 12/15 detrazioni to verify detrazioni > imposta lorda; see D.L. 3/2020 art. 1 c. 1 secondo periodo)",
  "D.L. 3/2020 art. 2 detrazione (not in force for 2026: absent from the live reliefs, which the 2026 Budget leaves untouched)",
  "INPS columns other than IVS (CUAF, NASpI/DS, CIG/CIGS ordinaria, Fondo garanzia TFR, maternità/malattia tutela, indennità economica di malattia)",
  "INPS regimes other than operai/impiegati privati a tempo indeterminato (dirigenti, apprendisti, tempo determinato +1,40% NASpI addizionale, edili/poste/ferrovie/volo funds, agricoli, domestici, Gestione Separata, Gestione pubblica, spettacolo, sportivi)",
  "INPS esoneri mirati (lavoratrici madri, etc.) and the expired general taglio-cuneo esonero (2024 6/7%: no 2026 general employee-side esonero exists)",
  "CCNL minimo contrattuale half of the imponibile floor (D.L. 338/1989: needs the applicable contract, which the pack does not carry)",
  "part-time minimale hourly computation and tempo parziale specifics",
  "addizionale regionale/comunale scaglioni schedules (bracketed deliberations cannot be entered in the flat rate slots)",
  "addizionale regionale detrazioni/casi particolari (Veneto/Marche CU cod. 1 and regional family relief: per-region tables not transcribed)",
  "addizionale comunale casi particolari tipizzazioni (Elenco colonne A–Z1) and fusioni handling",
  "addizionale comunale acconto 30% vs saldo timing and regionale ratei (the engine computes the annual surtax; declaration instalments are out of scope)",
  "art. 16-ter TUIR oneri detrazioni incl. the 75.000+ cap and the 2026 c. 5-bis 440 euro reduction above 200.000 (no oneri inputs in the engine: the sterilizzazione applies to a detrazione amount that is always zero here)",
  "impatriati/ricercatori exempt quotas and cedolare/mance extras in reddito complessivo (L. 207/2024 c. 9: needs CU data the pack does not carry)",
  "multi-employer conguaglio and prior-CU income (Circ. 4/E: the sostituto verifies on previsionale + worker-delivered CUs)",
  "10-rate recovery of indebiti over 60 euro (L. 207/2024 c. 7: year-end timing, not per-period arithmetic)",
  "pensionati (art. 49 c. 2 lett. a): TABELLA 7 detrazioni, not transcribed)",
  "TFR accrual, tredicesima/quattordicesima timing, CU/770 population, INAIL",
  "L. 199/2025 art. 1 c. 7 imposta sostitutiva 5% on 2026 contractual-renewal increases (private-sector, 2025 lavoro income ≤ 33.000; AdE Circ. 2/E/2026): the engine carries no CCNL-increase input, so no line can be priced under it",
  "L. 199/2025 art. 1 c. 10–11 imposta sostitutiva 15% on 2026 night/holiday/rest-day/shift allowances (cap 1.500/year; AdE FAQ Circ. 3/E/2026): the engine carries no allowance inputs, so no line can be priced under it",
  "L. 199/2025 art. 1 c. 18–21 trattamento integrativo speciale 15% for tourism/hospitality/food-service night work and festive-holiday overtime (prestazioni 1 Jan–30 Sep 2026): a sector- and date-gated credit the engine has no sector input to gate on, so no line can be priced under it",
];

/** Edition stamp for IT_TAX_YEARS. */
export const IT_2026_EDITION_LABEL =
  "Legge di Bilancio 2026 (L. 199/2025) + INPS Circ. 6/2026 + INPS Circ. 27/2026";
