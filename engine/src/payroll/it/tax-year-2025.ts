/**
 * Transcribed 2025 statutory tables for the IT payroll pack (anno d'imposta
 * 2025, calendar year, `taxYear: 2025`).
 *
 * Every figure below is quoted from the authority's own publication named in
 * its comment. "No quote, no citation": the sentence carrying the number is
 * reproduced so a reviewer can check the transcription without re-fetching.
 * Secondary sources (vendors, law firms, other ERPs) were used nowhere — not
 * even as corroboration.
 *
 * Sourcing outcomes per host (recorded distinctly):
 * - agenziaentrate.gov.it: 200, full text — the EN IRPEF rates page, the
 *   730/2026 istruzioni (redditi 2025), Circolare 4/E del 16 maggio 2025, the
 *   CU 2026 istruzioni, and the Elenco addizionale comunale 2025 (196 pages).
 * - gazzettaufficiale.it: 200, full text — L. 207/2024 art. 1 commi 2–9, 11
 *   (24G00229) and D.Lgs. 216/2023 art. 1 (23G00228), per-comma pages.
 * - normattiva.it: 200 shell, article endpoint "Errore nel caricamento delle
 *   informazioni" (session-walled) — NOT used.
 * - inps.it: listing page 200-with-a-JS-shell (JS-only-SPA discovery: no
 *   circular links server-rendered), guessed search/detail URLs 404,
 *   servizi2.inps.it file-level 200 for old files but 404 for guessed 2025
 *   names, CircolariZIP directory listing 403 edge deny. The INPS-authored
 *   Circolare 26/2025 and Tabella 1/2025 texts below were therefore reached
 *   through mirrors and corroborated: minimale/massimale figures against a
 *   second independent mirror plus their own arithmetic (603,40 x 9,5% =
 *   57,323 -> 57,32; 120.606,90 -> 120.607; 241,36 x 52 = 12.550,72 ->
 *   12.551), and the 9,19/33,00 split against a second INPS-authored
 *   circular allegato plus the table's own column arithmetic
 *   (33,68 + 9,19 = 42,87).
 * - def.finanze.it / def.giustiziatributaria.gov.it: article pages need
 *   session GUIDs (500 NullPointerException without) — NOT used.
 * - finanze.gov.it new-site paths: 404 on every guessed slug — NOT used
 *   (the AdE Elenco carries the scale evidence instead).
 *
 * Money discipline: figures are decimal STRINGS, never floats. The engine
 * consumes them with the repo's bigint-unit helpers (see canada/decimal.ts).
 * Ratios in the detrazione formula are TRUNCATED to 4 decimals per the
 * authority (730/2026 TABELLA 6 note 2), and every pushed line is rounded
 * half-up to the cent per the CU 2026 istruzioni (quoted below).
 */

export const IT_2025_SOURCE_URLS = {
  adeRatesEn:
    "https://www.agenziaentrate.gov.it/portale/web/english/personal-income-tax-rates-and-calculation",
  guL207:
    "https://www.gazzettaufficiale.it/atto/serie_generale/caricaArticolo?art.versione=1&art.idGruppo=1&art.flagTipoArticolo=0&art.codiceRedazionale=24G00229&art.idArticolo=1&art.idSottoArticolo=1&art.idSottoArticolo1=10&art.dataPubblicazioneGazzetta=2024-12-31&art.progressivo=1",
  guDLgs216:
    "https://www.gazzettaufficiale.it/atto/serie_generale/caricaArticolo?art.versione=1&art.idGruppo=0&art.flagTipoArticolo=0&art.codiceRedazionale=23G00228&art.idArticolo=1&art.idSottoArticolo=1&art.idSottoArticolo1=10&art.dataPubblicazioneGazzetta=2023-12-30&art.progressivo=0",
  ade730_2026:
    "https://www.agenziaentrate.gov.it/portale/730-2026/modello-e-istruzioni",
  adeCirc4E:
    "https://www.agenziaentrate.gov.it/portale/documents/20143/8410823/Circolare+lavoro+dipendente+LB2025+DD+IRPEF+n.+4+del+16+maggio+2025.pdf/36979eaa-9fc5-a4ec-a7aa-136497c53f91",
  adeCU2026:
    "https://www.agenziaentrate.gov.it/portale/certificazione-unica-2026/modello-e-istruzioni",
} as const;

/**
 * IRPEF scaglioni 2025 — L. 207/2024 art. 1 c. 2, lett. a), GU 24G00229:
 *
 * "«1. L'imposta lorda e' determinata applicando al reddito complessivo, al
 * netto degli oneri deducibili indicati nell'articolo 10, le seguenti aliquote
 * per scaglioni di reddito: a) fino a 28.000 euro, 23 per cento; b) oltre
 * 28.000 euro e fino a 50.000 euro, 35 per cento; c) oltre 50.000 euro, 43
 * per cento»"
 *
 * Corroborated by the AdE rates page (upd. 16/01/2026): "up to EUR 28 000
 * 23% ... 23% of total amount" / "from EUR 28 001 up to EUR 50 000 35% ...
 * EUR 6 440 + 35% on income exceeding EUR 28 000" / "above EUR 50 000 43%
 * ... EUR 14 140 + 43% on income exceeding EUR 50 000", and by 730/2026
 * TABELLA 1 ("23% sull'intero importo" / "6.440,00 + 35% parte eccedente
 * 28.000,00" / "14.140,00 + 43% parte eccedente 50.000,00"). 6.440 = 23% of
 * 28.000; 14.140 = 6.440 + 35% of 22.000. Three brackets — the 2024
 * consolidation (D.Lgs. 216/2023, transitory) made structural for 2025.
 */
export interface ItMarginalBand {
  readonly upTo: string | null;
  readonly rate: string;
}

export const IT_2025_IRPEF_BANDS: readonly ItMarginalBand[] = [
  { upTo: "28000", rate: "0.23" },
  { upTo: "50000", rate: "0.35" },
  { upTo: null, rate: "0.43" },
];

/** Cumulative tax at each band boundary, from the AdE table. */
export const IT_2025_IRPEF_CUMULATIVE = {
  at28000: "6440",
  at50000: "14140",
} as const;

/**
 * Detrazione per redditi di lavoro dipendente 2025 (art. 13 c. 1 TUIR as
 * applied for 2025) — AdE Circolare 4/E/2025 §1 schema:
 *
 * "fino a 15.000 euro: 1.955 (non inferiore a 690; se a tempo determinato,
 * non inferiore a 1.380)" / "oltre 15.000 euro e fino a 28.000 euro: 1.910 +
 * 1.190 x [(28.000 - reddito) / (28.000 - 15.000)]" / "oltre 28.000 euro e
 * fino a 50.000 euro: 1.910 x [(50.000 - reddito) / (50.000 - 28.000)]" /
 * "oltre 50.000 euro: nessuna detrazione"
 *
 * The 1.955 is L. 207/2024 art. 1 c. 2 lett. b) (GU): "all'articolo 13,
 * comma 1, lettera a) ... le parole: «1.880 euro» sono sostituite dalle
 * seguenti: «1.955 euro»". Circ. 4/E: "La modifica conferma, pertanto,
 * l'ampliamento fino a 8.500 euro dell'ammontare del reddito escluso da
 * imposizione (c.d. no tax area)" — 8.500 x 23% = 1.955 exactly.
 * Reddito complessivo is al netto dell'abitazione principale (art. 13
 * c. 6-bis TUIR, Circ. 4/E: "il reddito complessivo è assunto al netto del
 * reddito dell'unità immobiliare adibita ad abitazione principale e di
 * quello delle relative pertinenze").
 */
export const IT_2025_DETRAZIONE_LAVORO = {
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
 * Art. 13 c. 2 TUIR increase as applied for 2025 — 730/2026 TABELLA 6
 * note (4): "La detrazione spettante è aumentata di un importo pari a 65
 * euro, se il reddito complessivo è compreso tra 25.001 euro e 35.000 euro."
 */
export const IT_2025_DETRAZIONE_C2 = {
  amount: "65",
  fromExclusive: "25001",
  toInclusive: "35000",
} as const;

/**
 * Ratio precision — 730/2026 TABELLA 6 note (2): "Se il risultato dei
 * rapporti è maggiore di 0, lo stesso si assume nelle prime 4 cifre
 * decimali." Ratios are TRUNCATED (not rounded) to 4 decimals.
 */
export const IT_2025_RATIO_DECIMALS = 4;

/**
 * Ulteriore detrazione 2025 (L. 207/2024 art. 1 c. 6, GU 24G00229):
 *
 * "spetta un'ulteriore detrazione dall'imposta lorda, rapportata al periodo
 * di lavoro, di importo pari: a) a 1.000 euro, se l'ammontare del reddito
 * complessivo e' superiore a 20.000 euro ma non a 32.000 euro; b) al
 * prodotto tra 1.000 euro e l'importo corrispondente al rapporto tra 40.000
 * euro, diminuito del reddito complessivo, e 8.000 euro, se l'ammontare del
 * reddito complessivo e' superiore a 32.000 euro ma non a 40.000 euro."
 * For titolari di reddito di lavoro dipendente art. 49 TUIR esclusi i
 * pensionati (art. 49 c. 2 lett. a)). Circ. 4/E: "La detrazione, pertanto, è
 * pari a 1.000 euro per i redditi superiori a 20.000 euro e fino a 32.000
 * euro, mentre decresce progressivamente per i redditi superiori a 32.000
 * euro, fino ad azzerarsi raggiunta la soglia dei 40.000 euro."
 */
export const IT_2025_ULTERIORE_DETRAZIONE = {
  amount: "1000",
  bandA_fromExclusive: "20000",
  bandA_toInclusive: "32000",
  bandB_toExclusive: "40000",
  bandB_span: "8000",
} as const;

/**
 * Somma che non concorre al reddito 2025 (L. 207/2024 art. 1 c. 4, GU):
 *
 * "che hanno un reddito complessivo non superiore a 20.000 euro e'
 * riconosciuta una somma, che non concorre alla formazione del reddito,
 * determinata applicando al reddito di lavoro dipendente del contribuente
 * la percentuale corrispondente di seguito indicata: a) 7,1 per cento, se il
 * reddito di lavoro dipendente non e' superiore a 8.500 euro; b) 5,3 per
 * cento, se il reddito di lavoro dipendente e' superiore a 8.500 euro ma non
 * a 15.000 euro; c) 4,8 per cento, se il reddito di lavoro dipendente e'
 * superiore a 15.000 euro." Art. 49 TUIR esclusi i pensionati. C. 5: "Ai
 * soli fini dell'individuazione della percentuale applicabile ai sensi del
 * comma 4 il reddito di lavoro dipendente e' rapportato all'intero anno."
 * C. 7 (sostituto, GU): "riconoscono in via automatica la somma di cui al
 * comma 4 e la detrazione di cui al comma 6 ... all'atto dell'erogazione
 * delle retribuzioni e verificano in sede di conguaglio la spettanza delle
 * stesse."
 */
export const IT_2025_SOMMA = {
  incomeCap: "20000",
  bands: [
    { upTo: "8500", rate: "0.071" },
    { upTo: "15000", rate: "0.053" },
    { upTo: null, rate: "0.048" },
  ],
} as const;

/**
 * Trattamento integrativo 2025 (D.L. 3/2020 art. 1 c. 1 as amended) — AdE
 * 730/2026 istruzioni Sezione V:
 *
 * "Per l'anno 2025 esso è riconosciuto nella misura di 1.200 euro ai
 * lavoratori la cui imposta lorda, determinata tenendo conto solo dei
 * redditi da lavoro dipendente e di alcuni assimilati, sia di importo
 * superiore alle detrazioni per lavoro dipendente, diminuite
 * dell'importo di 75 euro rapportato al periodo di lavoro nell'anno e il
 * cui reddito complessivo non sia superiore a 15.000 euro."
 *
 * The −75 euro correction is L. 207/2024 art. 1 c. 3 (GU): "dopo le parole:
 * «della detrazione spettante ai sensi dell'articolo 13, comma 1, del
 * citato testo unico,» sono inserite le seguenti: «diminuita dell'importo
 * di 75 euro rapportato al periodo di lavoro nell'anno,»". Circ. 4/E:
 * "La previsione di una riduzione di 75 euro ... mira a neutralizzare
 * l'incremento dell'importo della detrazione per redditi di lavoro
 * dipendente, introdotto a regime dal comma 2, lettera b)". Sostituto
 * recognition: "Il trattamento integrativo è riconosciuto direttamente dal
 * datore di lavoro in busta paga a partire dal mese di gennaio."
 */
export const IT_2025_TRATTAMENTO_INTEGRATIVO = {
  amount: "1200",
  incomeCap: "15000",
  detrazioneReduction: "75",
} as const;

/**
 * INPS FPLD/IVS 2025 — ordinary private-sector case (operai/impiegati a
 * tempo indeterminato). INPS Tabella 1/2025 "ALIQUOTE CONTRIBUTIVE INPS DAL
 * 1° GENNAIO 2025": "Fondo pensioni 33,00" with "A carico dipendente 9,19"
 * (TOTALE 42,87 = 33,68 impresa + 9,19 dipendente). Employer IVS share is
 * 33,00 − 9,19 = 23,81. IVS-only: the table's other columns (CUAF, NASpI,
 * CIG, Fondo garanzia TFR, maternità/malattia) vary by sector and firm size
 * and are refused by name (see IT_REFUSED_2025).
 */
export const IT_2025_INPS_IVS = {
  total: "0.33",
  worker: "0.0919",
  employer: "0.2381",
} as const;

/**
 * Prima fascia / 1% additional 2025 — INPS Circ. 26/2025 §5:
 *
 * "Posto che la prima fascia di retribuzione pensionabile è stata
 * determinata, per l'anno 2025, in 55.448,00 euro, l'aliquota aggiuntiva
 * dell'1% deve essere applicata sulla quota di retribuzione eccedente il
 * predetto tetto retributivo che, rapportato a dodici mesi, è pari a
 * 4.621,00 euro." / "ai fini del versamento del contributo aggiuntivo in
 * questione deve essere osservato il criterio della mensilizzazione."
 * Seat: "articolo 3-ter del decreto-legge 19 settembre 1992, n. 384 ...
 * un'aliquota aggiuntiva a carico del lavoratore, nella misura di un punto
 * percentuale, sulle quote eccedenti il limite della prima fascia di
 * retribuzione pensionabile ... dovuto nei casi in cui il regime
 * pensionistico di iscrizione preveda aliquote contributive a carico del
 * lavoratore inferiori al 10%" (9,19 < 10, so it applies).
 */
export const IT_2025_PRIMA_FASCIA = {
  annual: "55448",
  monthly: "4621",
  additionalWorker: "0.01",
} as const;

/**
 * Massimale L. 335/1995 for post-1995 iscritti — INPS Circ. 26/2025 §6:
 *
 * "Il massimale annuo della base contributiva e pensionabile previsto
 * dall'articolo 2, comma 18, secondo periodo, della legge 8 agosto 1995,
 * n. 335, per i lavoratori iscritti successivamente al 31 dicembre 1995 a
 * forme pensionistiche obbligatorie e per coloro che optano per la pensione
 * con il sistema contributivo, sulla base dell'indice dei prezzi al consumo
 * per le famiglie di operai e impiegati calcolato dall'ISTAT, è pari, per
 * l'anno 2025, a 120.606,90 euro, che arrotondato all'unità di euro è pari
 * a 120.607,00 euro." Pre-1996 iscritti have NO massimale (only the prima
 * fascia above). Tabella 1/2025 note (2) corroborates: "il contributo
 * complessivo al Fondo pensioni (compreso il contributo aggiuntivo pari
 * all'1% a carico del lavoratore) è dovuto, per il 2025, sino al massimale
 * annuo di € 120.607,00."
 */
export const IT_2025_MASSIMALE_POST1995 = "120607";

/**
 * Minimale giornaliero 2025 — INPS Circ. 26/2025 §1:
 *
 * "non può essere inferiore al 9,50% dell'importo del trattamento minimo
 * mensile di pensione a carico del Fondo pensioni lavoratori dipendenti
 * (FPLD) in vigore al 1° gennaio di ciascun anno" (art. 7 c. 1 D.L.
 * 463/1983). "Tali limiti ... devono essere ragguagliati a 57,32 euro
 * (9,5% dell'importo del trattamento minimo mensile di pensione a carico
 * del Fondo pensioni lavoratori dipendenti in vigore al 1° gennaio 2025,
 * pari a 603,40 euro mensili) se di importo inferiore." ISTAT perequazione
 * 2024: +0,8%. The engine applies the floor to daily earnings
 * (period pay / 26 not modelled — the floor is checked against the
 * contractual daily minimum the employer already guarantees; see
 * IT_REFUSED_2025 for the CCNL-minimum half).
 */
export const IT_2025_MINIMALE = {
  trattamentoMinimoMensile: "603.40",
  giornaliero: "57.32",
  percent: "0.095",
} as const;

/**
 * Rounding — CU 2026 istruzioni (redditi 2025), AdE:
 *
 * "La certificazione è compilata in euro esponendo i dati in centesimi,
 * arrotondando per eccesso se la terza cifra decimale è uguale o superiore
 * a cinque o per difetto se inferiore a detto limite. Ad esempio: 55,505
 * diventa 55,51; 65,626 diventa 65,63; 65,493 diventa 65,49."
 * And for the previdenziali section: "gli importi delle retribuzioni e
 * delle contribuzioni devono essere indicati in Euro, esponendo i dati in
 * centesimi, arrotondando per eccesso se la terza cifra decimale è uguale
 * o superiore a cinque o per difetto se inferiore a detto limite."
 * Half-up to the cent, at each certified amount. (The 730 euro-unit rule —
 * "arrotondati all'unità di euro per eccesso se la frazione decimale è
 * uguale o superiore a cinquanta centesimi" — governs the RETURN, not the
 * withholding computation.)
 */
export const IT_2025_ROUNDING = "half-up-to-cent" as const;

/**
 * Addizionali regionale e comunale 2025 — tenant-entered rates.
 *
 * Why not transcribed: the AdE "ELENCO DELLE ALIQUOTE PER LA DETERMINAZIONE
 * DELL'ADDIZIONALE COMUNALE PER IL SALDO 2024 E PER L'ACCONTO 2025" runs to
 * 196 pages of per-comune rows (codice catastale, Aliquota unica OR 3–4
 * scaglioni mirroring the IRPEF bands, soglia di esenzione, and
 * tipizzazioni A–Z1 for casi particolari plus fusioni). Regions deliberate
 * likewise (D.Lgs. 15 dicembre 1997, n. 446). A pack constant would be wrong
 * for whichever comune was revised after the release. The computation from
 * a declared rate is: surtax = rate × reddito complessivo ai fini IRPEF
 * (same base as IRPEF — cf. 730/2026 "Domicilio fiscale per l'attribuzione
 * dell'addizionale regionale e dell'addizionale comunale": "Il domicilio
 * fiscale consente di individuare la Regione e il Comune per i quali è
 * dovuta rispettivamente l'addizionale regionale e comunale"), with the
 * comune's exemption threshold zeroing the surtax at or below the soglia.
 * Domicile selects: CU carries the domicilio fiscale at 1 January and
 * 31 December for exactly this computation.
 */
export const IT_2025_SURTAX_MODEL = "tenant-declared-rate" as const;

/**
 * Named refusals: everything the 2025 engine does not compute, with the
 * reason. The engine quotes these names back. Out-of-scope per the pack
 * brief (named): TFR accrual, tredicesima/quattordicesima timing, CU/770
 * submission, INAIL, contratti collettivi specifics.
 */
export const IT_REFUSED_2025: readonly string[] = [
  "art. 12 TUIR family detrazioni (coniuge/figli/ascendenti: needs ages, disability status and ripartizione the pack does not carry)",
  "trattamento integrativo for reddito complessivo 15.001–28.000 (needs art. 12/15 detrazioni to verify detrazioni > imposta lorda; see D.L. 3/2020 art. 1 c. 1 secondo periodo)",
  "D.L. 3/2020 art. 2 detrazione (not in force for 2025: absent from Circ. 4/E/2025 and the 730/2026 instructions, which enumerate the live reliefs)",
  "INPS columns other than IVS (CUAF, NASpI/DS, CIG/CIGS ordinaria, Fondo garanzia TFR, maternità/malattia tutela, indennità economica di malattia)",
  "INPS regimes other than operai/impiegati privati a tempo indeterminato (dirigenti, apprendisti, tempo determinato +1,40% NASpI addizionale, edili/poste/ferrovie/volo funds, agricoli, domestici, Gestione Separata, Gestione pubblica, spettacolo, sportivi)",
  "INPS esoneri mirati (lavoratrici madri, etc.) and the expired general taglio-cuneo esonero (2024 6/7%: no 2025 general employee-side esonero exists)",
  "CCNL minimo contrattuale half of the imponibile floor (D.L. 338/1989: needs the applicable contract, which the pack does not carry)",
  "part-time minimale hourly computation and tempo parziale specifics",
  "addizionale regionale/comunale scaglioni schedules (bracketed deliberations cannot be entered in the flat rate slots)",
  "addizionale regionale detrazioni/casi particolari (Veneto/Marche CU cod. 1 and regional family relief: per-region tables not transcribed)",
  "addizionale comunale casi particolari tipizzazioni (Elenco colonne A–Z1) and fusioni handling",
  "addizionale comunale acconto 30% vs saldo timing and regionale ratei (the engine computes the annual surtax; declaration instalments are out of scope)",
  "art. 16-ter TUIR 75.000+ oneri cap (no oneri inputs in the engine)",
  "impatriati/ricercatori exempt quotas and cedolare/mance extras in reddito complessivo (L. 207/2024 c. 9: needs CU data the pack does not carry)",
  "multi-employer conguaglio and prior-CU income (Circ. 4/E: the sostituto verifies on previsionale + worker-delivered CUs)",
  "10-rate recovery of indebiti over 60 euro (L. 207/2024 c. 7: year-end timing, not per-period arithmetic)",
  "pensionati (art. 49 c. 2 lett. a): TABELLA 7 detrazioni, not transcribed)",
  "TFR accrual, tredicesima/quattordicesima timing, CU/770 population, INAIL",
];

/** Edition stamp for IT_TAX_YEARS. */
export const IT_2025_EDITION_LABEL =
  "Legge di Bilancio 2025 (L. 207/2024) + AdE Circ. 4/E/2025 + INPS Circ. 26/2025";
