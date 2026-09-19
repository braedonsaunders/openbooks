import type { PayrollPackRates } from "../statutory-rates.ts";
import type { PayrollEditionScaffold, PayrollTaxYearSupport } from "../tax-years.ts";

/**
 * Germany — 2026 statutory tables (transcribed) + tax-year declaration.
 *
 * Every figure below is quoted from the authority's own publication named in
 * its comment. "No quote, no citation": the German sentence carrying the
 * number is reproduced so a reviewer can check the transcription without
 * re-fetching. Secondary sources (vendors, law firms, other ERPs) were used
 * nowhere — not even as corroboration.
 *
 * Sourcing outcomes per host (recorded distinctly):
 * - gesetze-im-internet.de (BMJ): 200, full text — EStG §32a, SolZG §§3–4,
 *   SGB V §§6/223/241/249, SGB VI §168, SGB III §§341/346, SGB XI §§55/58,
 *   PBAV 2025, RVBeitrSBek 2026.
 * - bmas.de SVRV 2026 PDF (Bundesgesetzblatt, BGBl 2025, ausgegeben zu Bonn
 *   am 26. November 2025, Nr. 278): 200, full text.
 * - bundesrat.de BR-Drs. 567/25 (SVRV 2026 Begründung + table): 200.
 * - bmas.de press-release HTML for the 2026 Rechengrößen: 200 with a
 *   not-found body ("Seite nicht gefunden") — wrong slug; NOT used.
 *
 * The BMF Programmablaufplan für den Lohnsteuerabzug 2026 itself is NOT
 * transcribed here — that is the engine step (pap.ts), not this file.
 */

export const DE_2026_SOURCE_URLS = {
  estg32a: "https://www.gesetze-im-internet.de/estg/__32a.html",
  solzg3: "https://www.gesetze-im-internet.de/solzg_1995/__3.html",
  solzg4: "https://www.gesetze-im-internet.de/solzg_1995/__4.html",
  sgb5_223: "https://www.gesetze-im-internet.de/sgb_5/__223.html",
  sgb5_241: "https://www.gesetze-im-internet.de/sgb_5/__241.html",
  sgb5_249: "https://www.gesetze-im-internet.de/sgb_5/__249.html",
  sgb6_168: "https://www.gesetze-im-internet.de/sgb_6/__168.html",
  sgb3_341: "https://www.gesetze-im-internet.de/sgb_3/__341.html",
  sgb3_346: "https://www.gesetze-im-internet.de/sgb_3/__346.html",
  sgb11_55: "https://www.gesetze-im-internet.de/sgb_11/__55.html",
  sgb11_58: "https://www.gesetze-im-internet.de/sgb_11/__58.html",
  pbav2025: "http://www.gesetze-im-internet.de/pbav_2025/PBAV_2025.pdf",
  rvBek2026: "https://www.gesetze-im-internet.de/rvbeitrsbek_2026/BJNR1230A0025.html",
  svrv2026: "https://www.bmas.de/SharedDocs/Downloads/DE/Gesetze/Verordnungsabschluesse/sozialversicherungs-rechengroessenverordnung-2026.pdf?__blob=publicationFile",
  svrvBegruendung: "https://www.bundesrat.de/SharedDocs/drucksachen/2025/0501-0600/567-25.pdf?__blob=publicationFile&v=1",
} as const;

/**
 * §32a EStG income-tax tariff, Veranlagungszeitraum 2026.
 *
 * Quoted (EStG §32a Abs. 1): "Sie beträgt ab dem Veranlagungszeitraum 2026
 * ... jeweils in Euro für zu versteuernde Einkommen 1. bis 12 348 Euro
 * (Grundfreibetrag): 0; 2. von 12 349 Euro bis 17 799 Euro: (914,51 • y +
 * 1 400) • y; 3. von 17 800 Euro bis 69 878 Euro: (173,10 • z + 2 397) • z +
 * 1 034,87; 4. von 69 879 Euro bis 277 825 Euro: 0,42 • x – 11 135,63; 5. von
 * 277 826 Euro an: 0,45 • x – 19 470,38."
 *
 * Quoted: "Die Größe „y“ ist ein Zehntausendstel des den Grundfreibetrag
 * übersteigenden Teils" / "Die Größe „z“ ist ein Zehntausendstel des 17 799
 * Euro übersteigenden Teils" / "Die Größe „x“ ist das auf einen vollen
 * Euro-Betrag abgerundete zu versteuernde Einkommen." / "Der sich ergebende
 * Steuerbetrag ist auf den nächsten vollen Euro-Betrag abzurunden."
 * Splitting (§32a Abs. 5): "das Zweifache des Steuerbetrags, der sich für
 * die Hälfte ihres gemeinsam zu versteuernden Einkommens nach Absatz 1
 * ergibt (Splitting-Verfahren)."
 */
export const DE_2026_TARIFF = {
  grundfreibetrag: 12348,
  zone2: { from: 12349, to: 17799, a: 914.51, b: 1400 },
  zone3: { from: 17800, to: 69878, a: 173.1, b: 2397, c: 1034.87 },
  zone4: { from: 69879, to: 277825, rate: 0.42, subtrahend: 11135.63 },
  zone5: { from: 277826, rate: 0.45, subtrahend: 19470.38 },
} as const;

/**
 * Solidaritätszuschlag 2026.
 *
 * Quoted (§4 SolZG): "Der Solidaritätszuschlag beträgt 5,5 Prozent der
 * Bemessungsgrundlage. Er beträgt nicht mehr als 11,9 Prozent des
 * Unterschiedsbetrages zwischen der Bemessungsgrundlage ... und der nach
 * § 3 Absatz 3, 4 und 5 jeweils maßgebenden Freigrenze."
 * Quoted (§4 Satz 4): Lohnsteuer nach §39b Abs. 3 (sonstige Bezüge) is
 * always full 5,5 Prozent ("beträgt ungeachtet des Satzes 2 5,5 Prozent").
 * Quoted (§3 Abs. 3): Freigrenze "in den Fällen des § 32a Absatz 5 und 6
 * ... 40 700 Euro, in anderen Fällen 20 350 Euro". Quoted (§3 Abs. 4): the
 * monthly test is "mehr als ein Zwölftel" of those amounts (Kl. III vs the
 * 40 700 figure, Kl. I/II/IV–VI vs the 20 350 figure); weekly 7/360, daily
 * 1/360. No rounding of cents fractions: "Bruchteile eines Cents bleiben
 * außer Ansatz" (§4 Satz 3).
 */
export const DE_2026_SOLI = {
  rate: 5.5,
  milderungRate: 11.9,
  freigrenzeSplitting: 40700,
  freigrenzeOther: 20350,
} as const;

/**
 * 2026 Sozialversicherung assessment ceilings — all "bundeseinheitlich":
 * the East/West split is gone (unified since 2025; the SVRV sets single
 * figures and the Begründung calls each "bundeseinheitlich geltende ...").
 *
 * Quoted (SVRV 2026, BGBl Nr. 278): §1 "Die Bezugsgröße ... für das Jahr
 * 2026 beträgt 47 460 Euro. Umgerechnet auf den Monat ergeben sich
 * 3 955 Euro." / §2 "wird für das Jahr 2026 auf 77 400 Euro festgesetzt.
 * Umgerechnet auf den Monat ergeben sich 6 450 Euro." (§6 Abs. 6,
 * Versicherungspflichtgrenze) and "auf 69 750 Euro festgesetzt. Umgerechnet
 * auf den Monat ergeben sich 5 812,50 Euro." (§6 Abs. 7) / §4 "in der
 * allgemeinen Rentenversicherung auf 101 400 Euro jährlich; umgerechnet auf
 * den Monat ergeben sich 8 450 Euro" and "in der knappschaftlichen
 * Rentenversicherung auf 124 800 Euro jährlich; umgerechnet auf den Monat
 * ergeben sich 10 400 Euro."
 *
 * Quoted (BR-Drs. 567/25 Begründung zu §2 Abs. 2): "wird die
 * bundeseinheitlich geltende Jahresarbeitsentgeltgrenze nach § 6 Absatz 1
 * Nummer 1 in Verbindung mit Absatz 7 SGB V (Beitragsbemessungsgrenze) für
 * das Jahr 2026 bestimmt" — i.e. the §6(7) figure IS the KV/PV
 * Beitragsbemessungsgrenze: 69 750 €/Jahr, 5 812,50 €/Monat. Quoted
 * (§55 Abs. 2 SGB XI): "bis zu einem Betrag von 1/360 der in § 6 Abs. 7 des
 * Fünften Buches festgelegten Jahresarbeitsentgeltgrenze" — PV rides the
 * same ceiling.
 */
export const DE_2026_CEILINGS = {
  /** BBG Kranken-/Pflegeversicherung, jährlich / monatlich. */
  kvPbbgAnnual: 69750,
  kvPbbgMonthly: 5812.5,
  /** Versicherungspflichtgrenze (allgemeine JAEG §6 Abs. 6). */
  jaegAnnual: 77400,
  jaegMonthly: 6450,
  /** BBG allgemeine Rentenversicherung = BBG Arbeitslosenversicherung. */
  rvBbgAnnual: 101400,
  rvBbgMonthly: 8450,
  knappschaftBbgAnnual: 124800,
  knappschaftBbgMonthly: 10400,
  bezugsgroesseAnnual: 47460,
  bezugsgroesseMonthly: 3955,
} as const;

/**
 * 2026 contribution rates.
 *
 * KV: quoted (§241 SGB V): "Der allgemeine Beitragssatz beträgt 14,6
 * Prozent". Split quoted (§249 Abs. 1 SGB V): "tragen die nach dem
 * Arbeitsentgelt zu bemessenden Beiträge jeweils zur Hälfte." The
 * kassenindividuelle Zusatzbeitrag is fund-specific and therefore a
 * tenant-entered rate — no authority figure is transcribed for it (the
 * BMG-announced 2026 average is NOT transcribed; the engine must refuse to
 * run without the fund's own rate).
 *
 * RV: quoted (BMAS Bekanntmachung v. 24.11.2025, BGBl. 2025 I Nr. 291):
 * "Der Beitragssatz für das Jahr 2026 beträgt weiterhin in der allgemeinen
 * Rentenversicherung 18,6 Prozent und in der knappschaftlichen
 * Rentenversicherung 24,7 Prozent." Split quoted (§168 Abs. 1 SGB VI):
 * "von den Versicherten und von den Arbeitgebern je zur Hälfte".
 *
 * AV: quoted (§341 Abs. 2 SGB III): "Der Beitragssatz beträgt 2,6 Prozent."
 * Split quoted (§346 Abs. 1 SGB III): "von den versicherungspflichtig
 * Beschäftigten und den Arbeitgebern je zur Hälfte getragen." Ceiling
 * quoted (§341 Abs. 4): "Beitragsbemessungsgrenze ist die
 * Beitragsbemessungsgrenze der allgemeinen Rentenversicherung."
 *
 * PV: quoted (PBAV 2025 §1, BGBl 30.12.2024; no 2026 amendment found, so
 * 3,6 Prozent carries into 2026): "wird zum 1. Januar 2025 auf 3,6 Prozent
 * der beitragspflichtigen Einnahmen der Mitglieder festgesetzt." Base rule
 * quoted (§55 Abs. 1 SGB XI): "beträgt ... bundeseinheitlich 3,4 Prozent"
 * (raised to 3,6 by the PBAV Verordnungsermächtigung). Childless surcharge
 * quoted (§55 Abs. 3): "erhöht sich ... um einen Beitragszuschlag in Höhe
 * von 0,6 Beitragssatzpunkten (Beitragszuschlag für Kinderlose)" with
 * "einen Abschlag in Höhe von 0,25 Beitragssatzpunkten" per child from the
 * second to the fifth. Borne quoted (§58 Abs. 1 Satz 3 SGB XI): "Den
 * Beitragszuschlag für Kinderlose nach § 55 Absatz 3 Satz 1 tragen die
 * Beschäftigten." Base split quoted (§58 Abs. 1): "tragen die ...
 * Beiträge jeweils zur Hälfte."
 *
 * Sachsen exception quoted (§58 Abs. 3 SGB XI): "tragen die Beiträge in Höhe
 * von 1 vom Hundert allein, wenn der Beschäftigungsort in einem Land liegt,
 * in dem die am 31. Dezember 1993 bestehende Anzahl der gesetzlichen
 * landesweiten Feiertage nicht um einen Feiertag ... vermindert worden
 * ist" — that Land is Sachsen (only Land that kept Buß- und Bettag), and
 * "für die Berechnung des Beitragsanteils des Arbeitgebers ein
 * Beitragssatz in Höhe des um einen Prozentpunkt verminderten
 * Beitragssatzes" (§58 Abs. 5).
 */
export const DE_2026_RATES = {
  /** KV allgemeiner Satz, percent. */
  kv: 14.6,
  /** RV allgemeiner Satz, percent. */
  rv: 18.6,
  /** AV Satz, percent. */
  av: 2.6,
  /** PV Satz (base, before Kinderlosenzuschlag/child discounts), percent. */
  pv: 3.6,
  /** PV Kinderlosenzuschlag, percentage points, employee-borne. */
  pvKinderlosenzuschlag: 0.6,
  /** PV Abschlag per child (2nd–5th), percentage points. */
  pvKindAbschlag: 0.25,
  /** Sachsen: employee-borne extra share, percentage points. */
  pvSachsenExtra: 1.0,
} as const;

export const DE_EDITION_SCAFFOLD: PayrollEditionScaffold = {
  files: [],
  barrels: [],
  steps: [
    "Transcribe the BMF Programmablaufplan für den Lohnsteuerabzug 2027 "
    + "into engine/src/payroll/de/pap.ts (the 2026 PAP is implemented).",
    "Transcribe the 2027 SV Rechengrößen (Sozialversicherungs-Rechengrößenverordnung 2027).",
    "Add a published 2027 edition to DE_TAX_YEARS; refuse 2027 by name until then.",
  ],
};

export const DE_TAX_YEARS: PayrollTaxYearSupport = {
  country: "DE",
  editions: [
    {
      year: 2026,
      label: "BMF Programmablaufplan für den Lohnsteuerabzug 2026 (Stand 12.11.2025, endgültig)",
      effectiveFrom: "2026-01-01",
      citation:
        "BMF-Schreiben vom 12.11.2025, GZ IV C 5 - S 2361/00025/016/028 "
        + "(Programmablaufplan für die maschinelle Berechnung der vom "
        + "Arbeitslohn einzubehaltenden Lohnsteuer 2026, Anlage 1, 40 Seiten); "
        + "Sozialversicherungs-Rechengrößenverordnung 2026 (BGBl 2025 Nr. 278); "
        + "EStG §32a (Tarif 2026); SolZG §§3–4; SGB V §§6/223/241/249; "
        + "SGB VI §168; SGB III §§341/346; SGB XI §§55/58",
      status: "published",
    },
  ],
  regionsWithOwnTables: [],
  ratesModule: "engine/src/payroll/de/rates.ts",
  scaffold: DE_EDITION_SCAFFOLD,
};

/**
 * Tenant-entered statutory rates: the kassenindividuelle Zusatzbeiträge.
 *
 * Quoted (§241 SGB V): "Der allgemeine Beitragssatz beträgt 14,6 Prozent"
 * — but the fund-specific top-up has no authority figure: each Krankenkasse
 * sets its own Zusatzbeitragssatz yearly (§242 SGB V), so no published table
 * can supply this employer's rate. The employer enters the fund's own rate,
 * exactly as they enter a SUI experience rate. The engine reads the
 * resolution and refuses an unconfigured year rather than defaulting to zero
 * or to the BMG-announced national average (deliberately NOT transcribed).
 *
 * Scope is org-wide (one configured fund rate): an employer whose workforce
 * spans several Krankenkassen with different Zusatzbeitragssätzen is NOT
 * modelled — the configured rate applies to every employee, which the setup
 * surface states next to the input. A per-fund scope point does not exist in
 * the generic layer's vocabulary (org / region / sub_region /
 * filing_account), and Krankenkassen are none of those.
 *
 * Umlagen U1/U2 (kassenindividuell) and the Insolvenzgeldumlage are likewise
 * fund- or employer-specific, but the 2026 engine accrues no employer levies
 * (see compute-statutory.ts), so they gain slots when that engine lands —
 * declaring a rate no engine reads would be silent surface.
 */
const DE_KVZ_SLOT = {
  key: "de_kvz",
  label: "Krankenkassenindividueller Zusatzbeitrag",
  scope: "org",
  systemKeys: ["kv"],
  // The 2026 engine already refuses without the fund's own rate; the
  // declaration records that refusal here.
  whenUnconfigured: "refuse",
  fields: [
    {
      key: "rate",
      label: "Zusatzbeitragssatz (%)",
      kind: "percent",
      decimals: 2,
      min: "0",
      max: "10",
      required: true,
      help: "The Krankenkasse's own Zusatzbeitragssatz as a percent number "
        + "(2,90 for 2,90%), from the fund's own notice — never the "
        + "BMG-announced national average. Applies to every employee in this "
        + "configuration; a workforce spanning several funds is not modelled.",
    },
  ],
  citation: "§§241–242 SGB V (allgemeiner Satz 14,6 Prozent; kassenindividueller Zusatzbeitrag)",
  variesBecause:
    "each Krankenkasse sets its own Zusatzbeitragssatz yearly; no pack constant can carry this employer's fund rate",
} as const;

export const DE_PACK_RATES: PayrollPackRates = {
  country: "DE",
  slots: [DE_KVZ_SLOT],
};
