/**
 * Transcribed Polish statutory tables for calendar year 2025: PIT (podatek
 * dochodowy od osób fizycznych) and ZUS/NFZ contributions.
 *
 * Provenance — every figure below was read in its Polish original on
 * 2026-09-20/21 (official gazette PDFs via eli.gov.pl / dziennikustaw.gov.pl /
 * monitorpolski.gov.pl, and ZUS's own contribution guide):
 *
 * - Skala podatkowa + kwota zmniejszająca: ustawa z dnia 26 lipca 1991 r.
 *   o podatku dochodowym od osób fizycznych, tekst jednolity Dz.U. 2025
 *   poz. 163 (obwieszczenie Marszałka Sejmu z 10 stycznia 2025 r.). Art. 27
 *   ust. 1 gives the scale (120 000 / 12 % / 3 600 / 10 800 + 32 % —
 *   verified verbatim, identical to the 2026 transcription); art. 31b
 *   ust. 1–3 the monthly reduction on the employee's oświadczenie.
 * - Monthly advances: art. 32 ust. 2 (12 % / 32 % with the 120 000 zł
 *   year-to-date test) and ust. 4 (dochód = monthly revenue minus KUP and
 *   minus the employee's social contributions), verified verbatim. KUP:
 *   art. 22 ust. 2 pkt 1 (250 zł) and pkt 3 (300 zł dojazd), verified.
 *   Art. 27b (the old zdrowotna-from-tax deduction) prints "(uchylony)" —
 *   zdrowotna is NOT deductible from PIT in 2025.
 * - Rounding of PIT bases and advances: Ordynacja podatkowa art. 63 § 1,
 *   tekst jednolity Dz.U. 2025 poz. 111 — verified verbatim.
 * - Contribution rates and the employee/employer split: ustawa z dnia
 *   13 października 1998 r. o systemie ubezpieczeń społecznych, tekst
 *   jednolity Dz.U. 2025 poz. 350 — art. 22 ust. 1 (19,52 % / 8,00 % /
 *   2,45 % / 0,40–8,12 %) and art. 16 ust. 1, 1b, 2, 3 (split), verified
 *   verbatim, identical to 2026.
 * - Annual emerytalne/rentowe base limit: obwieszczenie MRPiPS z dnia
 *   10 grudnia 2024 r., M.P. 2024 poz. 1051: "ogłasza się, że kwota
 *   ograniczenia rocznej podstawy wymiaru składek na ubezpieczenia
 *   emerytalne i rentowe w roku 2025 wynosi 260 190 zł, a przyjęta do jej
 *   ustalenia kwota prognozowanego przeciętnego wynagrodzenia wynosi
 *   8673 zł." Corroborated twice: Budget 2025 art. 24 (8 673 zł;
 *   30 × 8 673 = 260 190) and the ZUS komunikat M.P. 2024 poz. 1061
 *   (21 682,50 zł = 250 % × 8 673 for voluntary sickness).
 * - Zdrowotna: ustawa z dnia 27 sierpnia 2004 r. o świadczeniach opieki
 *   zdrowotnej, tekst jednolity Dz.U. 2025 poz. 1461 — art. 79 ust. 1 (9 %),
 *   art. 81 ust. 5 (no 30× cap) and ust. 6 (minus the employee's
 *   emerytalne/rentowe/chorobowe), verified verbatim.
 * - FP 1,0 % / FS 1,45 % / FGŚP 0,10 %: ustawa budżetowa na rok 2025,
 *   Dz.U. 2025 poz. 63 — art. 25 (FP), art. 26 (FS), art. 27 (FGŚP),
 *   read from the gazette PDF. ZUS's own guide "Zasady opłacania składek
 *   na Fundusz Pracy, FGŚP, FEP oraz Fundusz Solidarnościowy" states the
 *   standing history: FP 1,00 % od 1 stycznia 2021 r., FS 1,45 % od
 *   2021 r., joint DRA declaration at the summed 2,45 %, FGŚP 0,10 % —
 *   so the 2025 Budget articles re-set the same standing rates.
 * - FP base and age rules: until 31 May 2025 the promotion act (tekst
 *   jednolity Dz.U. 2025 poz. 214 — art. 104 ust. 1 base, art. 104b
 *   ust. 2 age bar, verified verbatim); from 1 June 2025 the labour-market
 *   act, Dz.U. 2025 poz. 620 (art. 259 ust. 1, art. 260–263 — quotes as
 *   transcribed in ./tables-2026.ts). Same substance either side of the
 *   switchover: one 2025 edition, no mid-year engine change.
 * - FGŚP age bar: claims-protection act, tekst jednolity Dz.U. 2025
 *   poz. 433 — art. 9b ust. 2 exempts women 55+ / men 60+ from FGŚP
 *   (single-version print, verified). The 2026 engine prices FGŚP
 *   unconditionally, so 2025 sets the pack's `fgspAgeBar` flag while 2026
 *   keeps its landed behaviour (reported, not changed here).
 * - Minimum wage 2025: rozporządzenie RM z dnia 12 września 2024 r.,
 *   Dz.U. 2024 poz. 1362, § 1: single step, 4 666 zł from 1 January 2025.
 * - Wypadkowe posture: sus art. 22 ust. 2 (Dz.U. 2025 poz. 350) — per-payer
 *   rate, tenant-declared, never table-supplied.
 * - Ulga dla młodych limit 85 528 zł: updof Dz.U. 2025 poz. 163
 *   (art. 21 ust. 1 reliefs) — a refusal-channel fact, the engine prices
 *   the standard scale only.
 *
 * Operative Polish is quoted on every constant below. Translations are the
 * pack's own.
 *
 * Money discipline: rates are exact decimal FRACTION strings ("0.0976" for
 * 9,76 %), never floats, never percents-as-numbers. Amounts are whole
 * złotych. The engine consumes them with bigint units (see
 * ./compute-statutory.ts).
 */

import type { PlRate } from "./tables-2026.ts";

// ---------------------------------------------------------------------------
// PIT — skala podatkowa (art. 27 ust. 1 updof, Dz.U. 2025 poz. 163)
// ---------------------------------------------------------------------------

/**
 * "120 000 12 % minus kwota zmniejszająca podatek 3600 zł" and
 * "10 800 zł + 32 % nadwyżki ponad 120 000 zł" (Dz.U. 2025 poz. 163,
 * art. 27 ust. 1 — verified verbatim 2026-09-20).
 */
export const PL_PIT_SKALA_2025 = {
  prog: "120000",
  stawkaDolna: { rate: "0.12", quote: "120 000 12 % minus kwota zmniejszająca podatek 3600 zł" },
  kwotaZmniejszajaca: "3600",
  podatekOdProgu: "10800",
  stawkaGorna: { rate: "0.32", quote: "10 800 zł + 32 % nadwyżki ponad 120 000 zł" },
} as const;

/**
 * Art. 31b ust. 1 (Dz.U. 2025 poz. 163): "płatnik pomniejsza zaliczki
 * o kwotę stanowiącą nie więcej niż 1/12 kwoty zmniejszającej podatek,
 * jeżeli podatnik złoży temu płatnikowi oświadczenie o stosowaniu
 * pomniejszenia." Ust. 3: 1/12, 1/24 or 1/36. Verified verbatim.
 */
export const PL_PIT_POMNIEJSZENIE_2025 = {
  pelne: "300",
  polowa: "150",
  trzecia: "100",
  quote:
    "płatnik pomniejsza zaliczki o kwotę stanowiącą nie więcej niż 1/12 kwoty zmniejszającej podatek, "
    + "jeżeli podatnik złoży temu płatnikowi oświadczenie o stosowaniu pomniejszenia",
} as const;

/**
 * Art. 32 ust. 2 (Dz.U. 2025 poz. 163): "Zaliczki za miesiące od stycznia
 * do grudnia wynoszą: 1) za miesiące, w których dochód podatnika
 * uzyskany od początku roku od danego płatnika nie przekroczył kwoty
 * 120 000 zł – 12 % dochodu uzyskanego w danym miesiącu; 2) za miesiąc,
 * w którym dochód podatnika uzyskany od początku roku od danego płatnika
 * przekroczył kwotę 120 000 zł – 12 % od tej części dochodu uzyskanego
 * w tym miesiącu, która nie przekroczyła tej kwoty, i 32 % od nadwyżki
 * ponad kwotę 120 000 zł; 3) za miesiące następujące po miesiącu,
 * o którym mowa w pkt 2 – 32 % dochodu uzyskanego w danym miesiącu od
 * danego płatnika." Verified verbatim.
 *
 * Art. 32 ust. 4: "Za dochód, o którym mowa w ust. 2 i 3, uważa się
 * uzyskane w ciągu miesiąca przychody, o których mowa w ust. 1, po
 * odliczeniu kosztów uzyskania w wysokości określonej w art. 22 ust. 2
 * pkt 1 albo 3 lub ust. 9 pkt 1–3 oraz po odliczeniu potrąconych przez
 * płatnika w danym miesiącu składek na ubezpieczenie społeczne, o których
 * mowa w art. 26 ust. 1 pkt 2 lit. b lub pkt 2a." Verified verbatim.
 */
export const PL_PIT_ZALICZKA_QUOTE_2025 =
  "Zaliczki za miesiące od stycznia do grudnia wynoszą: 1) za miesiące, w których dochód podatnika "
  + "uzyskany od początku roku od danego płatnika nie przekroczył kwoty 120 000 zł – 12 % dochodu "
  + "uzyskanego w danym miesiącu; 2) za miesiąc, w którym dochód podatnika uzyskany od początku roku "
  + "od danego płatnika przekroczył kwotę 120 000 zł – 12 % od tej części dochodu uzyskanego w tym "
  + "miesiącu, która nie przekroczyła tej kwoty, i 32 % od nadwyżki ponad kwotę 120 000 zł; "
  + "3) za miesiące następujące po miesiącu, o którym mowa w pkt 2 – 32 % dochodu uzyskanego "
  + "w danym miesiącu od danego płatnika";

export const PL_PIT_DOCHOD_QUOTE_2025 =
  "Za dochód, o którym mowa w ust. 2 i 3, uważa się uzyskane w ciągu miesiąca przychody, "
  + "o których mowa w ust. 1, po odliczeniu kosztów uzyskania w wysokości określonej w art. 22 "
  + "ust. 2 pkt 1 albo 3 lub ust. 9 pkt 1–3 oraz po odliczeniu potrąconych przez płatnika w danym "
  + "miesiącu składek na ubezpieczenie społeczne, o których mowa w art. 26 ust. 1 pkt 2 lit. b lub pkt 2a";

/**
 * Art. 22 ust. 2 pkt 1 / pkt 3 (Dz.U. 2025 poz. 163): "wynoszą 250 zł
 * miesięcznie, a za rok podatkowy łącznie nie więcej niż 3000 zł" /
 * "wynoszą 300 zł miesięcznie, a za rok podatkowy łącznie nie więcej niż
 * 3600 zł". Verified verbatim.
 */
export const PL_KUP_2025 = {
  miejscowy: {
    miesiecznie: "250",
    quote:
      "wynoszą 250 zł miesięcznie, a za rok podatkowy łącznie nie więcej niż 3000 zł – w przypadku "
      + "gdy podatnik uzyskuje przychody z tytułu jednego stosunku służbowego, stosunku pracy, "
      + "spółdzielczego stosunku pracy oraz pracy nakładczej",
  },
  dojazd: {
    miesiecznie: "300",
    quote:
      "wynoszą 300 zł miesięcznie, a za rok podatkowy łącznie nie więcej niż 3600 zł – w przypadku "
      + "gdy miejsce stałego lub czasowego zamieszkania podatnika jest położone poza miejscowością, "
      + "w której znajduje się zakład pracy, i podatnik nie uzyskuje dodatku za rozłąkę",
  },
} as const;

/**
 * Ordynacja podatkowa art. 63 § 1 (Dz.U. 2025 poz. 111): "Podstawy
 * opodatkowania, kwoty podatków, odsetki za zwłokę, opłaty prolongacyjne,
 * oprocentowanie nadpłat oraz wynagrodzenia przysługujące płatnikom
 * i inkasentom zaokrągla się do pełnych złotych w ten sposób, że końcówki
 * kwot wynoszące mniej niż 50 groszy pomija się, a końcówki kwot
 * wynoszące 50 i więcej groszy podwyższa się do pełnych złotych,
 * z zastrzeżeniem § 1a i 2." Verified verbatim.
 */
export const PL_ZAOKRAGLENIE_PIT_QUOTE_2025 =
  "Podstawy opodatkowania, kwoty podatków, odsetki za zwłokę, opłaty prolongacyjne, oprocentowanie "
  + "nadpłat oraz wynagrodzenia przysługujące płatnikom i inkasentom zaokrągla się do pełnych złotych "
  + "w ten sposób, że końcówki kwot wynoszące mniej niż 50 groszy pomija się, a końcówki kwot "
  + "wynoszące 50 i więcej groszy podwyższa się do pełnych złotych, z zastrzeżeniem § 1a i 2";

// ---------------------------------------------------------------------------
// ZUS — rates (art. 22 ust. 1) and split (art. 16), Dz.U. 2025 poz. 350
// ---------------------------------------------------------------------------

/**
 * Art. 22 ust. 1 (Dz.U. 2025 poz. 350): "Stopy procentowe składek wynoszą:
 * 1) 19,52 % podstawy wymiaru – na ubezpieczenie emerytalne (...);
 * 2) 8,00 % podstawy wymiaru – na ubezpieczenia rentowe;
 * 3) 2,45 % podstawy wymiaru – na ubezpieczenie chorobowe;
 * 4) od 0,40 % do 8,12 % podstawy wymiaru – na ubezpieczenie wypadkowe."
 * Verified verbatim.
 */
export const PL_SKLADKI_STOPY_2025 = {
  emerytalneTotal: { rate: "0.1952", quote: "19,52 % podstawy wymiaru – na ubezpieczenie emerytalne" },
  rentoweTotal: { rate: "0.08", quote: "8,00 % podstawy wymiaru – na ubezpieczenia rentowe" },
  choroboweTotal: { rate: "0.0245", quote: "2,45 % podstawy wymiaru – na ubezpieczenie chorobowe" },
  wypadkoweRange: {
    min: "0.004",
    max: "0.0812",
    quote: "od 0,40 % do 8,12 % podstawy wymiaru – na ubezpieczenie wypadkowe",
  },
} as const;

/**
 * Art. 16 ust. 1 (emerytalne, equal halves), ust. 1b (rentowe 1,5 % /
 * 6,5 %), ust. 2 (chorobowe, employee only), ust. 3 (wypadkowe, employer
 * only) — Dz.U. 2025 poz. 350, verified verbatim, same split as 2026.
 */
export const PL_SKLADKI_PODZIAL_2025 = {
  emerytalneEe: {
    rate: "0.0976",
    quote:
      "Składki na ubezpieczenia emerytalne: 1) pracowników (…) – finansują z własnych środków, "
      + "w równych częściach, ubezpieczeni i płatnicy składek",
  },
  emerytalneEr: {
    rate: "0.0976",
    quote:
      "Składki na ubezpieczenia emerytalne: 1) pracowników (…) – finansują z własnych środków, "
      + "w równych częściach, ubezpieczeni i płatnicy składek",
  },
  rentoweEe: {
    rate: "0.015",
    quote:
      "Składki na ubezpieczenia rentowe osób, o których mowa w ust. 1 i 1a, finansują z własnych "
      + "środków, w wysokości 1,5 % podstawy wymiaru ubezpieczeni i w wysokości 6,5 % podstawy "
      + "wymiaru płatnicy składek",
  },
  rentoweEr: {
    rate: "0.065",
    quote:
      "Składki na ubezpieczenia rentowe osób, o których mowa w ust. 1 i 1a, finansują z własnych "
      + "środków, w wysokości 1,5 % podstawy wymiaru ubezpieczeni i w wysokości 6,5 % podstawy "
      + "wymiaru płatnicy składek",
  },
  choroboweEe: {
    rate: "0.0245",
    quote:
      "Składki na ubezpieczenie chorobowe podlegających temu ubezpieczeniu osób, wymienionych "
      + "w ust. 1 pkt 1–4, 7a–9 i 11 oraz w ust. 1c, finansują w całości, z własnych środków, "
      + "sami ubezpieczeni",
  },
  wypadkoweEr: {
    rate: null,
    quote:
      "Składki na ubezpieczenie wypadkowe osób wymienionych w ust. 1 pkt 1 i 3–10 (…) finansują "
      + "w całości, z własnych środków, płatnicy składek",
  },
} as const;

/**
 * Obwieszczenie MRPiPS z dnia 10 grudnia 2024 r., M.P. 2024 poz. 1051
 * (read from the gazette PDF 2026-09-20): "ogłasza się, że kwota
 * ograniczenia rocznej podstawy wymiaru składek na ubezpieczenia
 * emerytalne i rentowe w roku 2025 wynosi 260 190 zł, a przyjęta do jej
 * ustalenia kwota prognozowanego przeciętnego wynagrodzenia wynosi
 * 8673 zł."
 */
export const PL_ROCZNY_LIMIT_2025 = {
  annual: "260190",
  prognozowane: "8673",
  quote:
    "ogłasza się, że kwota ograniczenia rocznej podstawy wymiaru składek na ubezpieczenia emerytalne "
    + "i rentowe w roku 2025 wynosi 260 190 zł, a przyjęta do jej ustalenia kwota prognozowanego "
    + "przeciętnego wynagrodzenia wynosi 8673 zł",
} as const;

// ---------------------------------------------------------------------------
// NFZ — składka zdrowotna, Dz.U. 2025 poz. 1461
// ---------------------------------------------------------------------------

/**
 * Art. 79 ust. 1: "Składka na ubezpieczenie zdrowotne wynosi 9 %
 * podstawy wymiaru składki, z zastrzeżeniem art. 79a, art. 80, art. 82
 * i art. 242." Verified verbatim. Art. 27b updof prints "(uchylony)" —
 * no PIT deduction for zdrowotna in 2025.
 */
export const PL_ZDROWOTNA_2025: PlRate = {
  rate: "0.09",
  quote: "Składka na ubezpieczenie zdrowotne wynosi 9 % podstawy wymiaru składki",
};

export const PL_ZDROWOTNA_PODSTAWA_QUOTE_2025 =
  "Podstawę wymiaru składki na ubezpieczenie zdrowotne pomniejsza się o kwoty składek na "
  + "ubezpieczenia emerytalne, rentowe i chorobowe finansowanych przez ubezpieczonych niebędących "
  + "płatnikami składek, potrąconych przez płatników ze środków ubezpieczonego, zgodnie z przepisami "
  + "o systemie ubezpieczeń społecznych";

// ---------------------------------------------------------------------------
// FP / FS / FGŚP 2025 — Budget Act rates on the promotion/labour-market base
// ---------------------------------------------------------------------------

/**
 * Ustawa budżetowa na rok 2025 (Dz.U. 2025 poz. 63), read from the gazette
 * PDF 2026-09-21:
 * - Art. 25: "ustala się wysokość obowiązkowej składki na Fundusz Pracy,
 *   która wynosi 1,0 % podstawy wymiaru składek na ubezpieczenia
 *   emerytalne i rentowe, określonej w art. 104 ust. 1 wymienionej ustawy"
 *   (the promotion act, Dz.U. 2024 poz. 475).
 * - Art. 26: "ustala się wysokość obowiązkowej składki na Fundusz
 *   Solidarnościowy, która wynosi 1,45 % podstawy wymiaru składek na
 *   ubezpieczenia emerytalne i rentowe, określonej w art. 104 ust. 1
 *   ustawy wymienionej w art. 25" (the FS act, Dz.U. 2024 poz. 1848).
 * - Art. 27: "ustala się wysokość obowiązkowej składki na Fundusz
 *   Gwarantowanych Świadczeń Pracowniczych, która wynosi 0,10 % podstawy
 *   wymiaru składek na ubezpieczenia emerytalne i rentowe, określonej
 *   w art. 29 ust. 1 wymienionej ustawy" (the claims-protection act).
 * - Art. 24 corroborates the forecast wage: "Prognozowane przeciętne
 *   miesięczne wynagrodzenie brutto w gospodarce narodowej wynosi 8 673 zł."
 *
 * All employer-paid. FP and FS price the same base under the same
 * conditions and are declared jointly in DRA block VII field 01 (ZUS
 * guide: "w wysokości sumy stóp procentowych tych składek").
 */
export const PL_FUNDUSZE_2025 = {
  fp: {
    rate: "0.01",
    quote:
      "ustala się wysokość obowiązkowej składki na Fundusz Pracy, która wynosi 1,0 % podstawy "
      + "wymiaru składek na ubezpieczenia emerytalne i rentowe, określonej w art. 104 ust. 1 "
      + "wymienionej ustawy",
  },
  fs: {
    rate: "0.0145",
    quote:
      "ustala się wysokość obowiązkowej składki na Fundusz Solidarnościowy, która wynosi 1,45 % "
      + "podstawy wymiaru składek na ubezpieczenia emerytalne i rentowe, określonej w art. 104 ust. 1 "
      + "ustawy wymienionej w art. 25",
  },
  fgsp: {
    rate: "0.001",
    quote:
      "ustala się wysokość obowiązkowej składki na Fundusz Gwarantowanych Świadczeń Pracowniczych, "
      + "która wynosi 0,10 % podstawy wymiaru składek na ubezpieczenia emerytalne i rentowe, "
      + "określonej w art. 29 ust. 1 wymienionej ustawy",
  },
} as const;

/**
 * Promotion act (Dz.U. 2025 poz. 214), in force until superseded:
 * Art. 104 ust. 1: "Obowiązkowe składki na Fundusz Pracy, ustalone od
 * kwot stanowiących podstawę wymiaru składek na ubezpieczenia emerytalne
 * i rentowe bez stosowania ograniczenia, o którym mowa w art. 19 ust. 1
 * ustawy (...) o systemie ubezpieczeń społecznych, wynoszących
 * w przeliczeniu na okres miesiąca, co najmniej minimalne wynagrodzenie
 * za pracę opłacają: 1) pracodawcy (...)". Verified verbatim.
 *
 * From 1 June 2025 the labour-market act (Dz.U. 2025 poz. 620) restates
 * the same base as art. 259 ust. 1 (quote as transcribed in
 * ./tables-2026.ts). Same substance either side — one 2025 edition.
 */
export const PL_FP_PODSTAWA_QUOTE_2025 =
  "Obowiązkowe składki na Fundusz Pracy, ustalone od kwot stanowiących podstawę wymiaru składek "
  + "na ubezpieczenia emerytalne i rentowe bez stosowania ograniczenia, o którym mowa w art. 19 "
  + "ust. 1 ustawy z dnia 13 października 1998 r. o systemie ubezpieczeń społecznych, wynoszących "
  + "w przeliczeniu na okres miesiąca, co najmniej minimalne wynagrodzenie za pracę opłacają: "
  + "1) pracodawcy oraz inne jednostki organizacyjne za osoby pozostające w stosunku pracy";

/**
 * Promotion act (Dz.U. 2025 poz. 214) art. 104b ust. 2: "Składki na
 * Fundusz Pracy, o których mowa w art. 104 ust. 1, opłaca się za osoby
 * wymienione w art. 104 ust. 1 pkt 1–3, które nie osiągnęły wieku
 * wynoszącego co najmniej 55 lat dla kobiet i co najmniej 60 lat dla
 * mężczyzn." Verified verbatim (single-version print — the t.j.'s only
 * version split concerns art. 104a return-from-leave wording).
 *
 * From 1 June 2025 the labour-market act art. 261 states the same bar
 * (quote as transcribed in ./tables-2026.ts). The engine cites "art. 104b
 * ust. 2 / art. 261" for 2025 pay dates.
 */
export const PL_FP_WIEK_QUOTE_2025 =
  "Składki na Fundusz Pracy, o których mowa w art. 104 ust. 1, opłaca się za osoby wymienione "
  + "w art. 104 ust. 1 pkt 1–3, które nie osiągnęły wieku wynoszącego co najmniej 55 lat dla kobiet "
  + "i co najmniej 60 lat dla mężczyzn";

/**
 * Claims-protection act (Dz.U. 2025 poz. 433) art. 9b ust. 2:
 * "Pracodawca, o którym mowa w art. 9, nie opłaca składek na Fundusz za
 * pracowników, którzy osiągnęli wiek wynoszący co najmniej 55 lat dla
 * kobiet i co najmniej 60 lat dla mężczyzn." Verified verbatim
 * (single-version print). FGŚP follows the same 55/60 bar as FP/FS in
 * 2025 — the pack's `fgspAgeBar` flag (see ./compute-statutory.ts).
 */
export const PL_FGSP_WIEK_QUOTE_2025 =
  "Pracodawca, o którym mowa w art. 9, nie opłaca składek na Fundusz za pracowników, którzy "
  + "osiągnęli wiek wynoszący co najmniej 55 lat dla kobiet i co najmniej 60 lat dla mężczyzn";

/**
 * Rozporządzenie RM z dnia 12 września 2024 r. (Dz.U. 2024 poz. 1362),
 * § 1: "Od dnia 1 stycznia 2025 r. ustala się minimalne wynagrodzenie
 * za pracę w wysokości 4666 zł." Single step for the whole year (read
 * from the gazette PDF 2026-09-21).
 */
export const PL_MIN_WAGE_2025 = {
  monthly: "4666",
  quote:
    "Od dnia 1 stycznia 2025 r. ustala się minimalne wynagrodzenie za pracę w wysokości 4666 zł",
} as const;

// ---------------------------------------------------------------------------
// Tenant-declared by design (posture quotes, no rates transcribable)
// ---------------------------------------------------------------------------

/**
 * Sus art. 22 ust. 2 (Dz.U. 2025 poz. 350): "Zasady różnicowania stopy
 * procentowej składek na ubezpieczenie wypadkowe określają przepisy
 * o ubezpieczeniu społecznym z tytułu wypadków przy pracy i chorób
 * zawodowych." Verified verbatim — per-payer rate, tenant-declared.
 */
export const PL_TENANT_DECLARED_QUOTE_2025 =
  "Zasady różnicowania stopy procentowej składek na ubezpieczenie wypadkowe określają przepisy "
  + "o ubezpieczeniu społecznym z tytułu wypadków przy pracy i chorób zawodowych";

/**
 * Named refusals for the 2025 pass: everything this file transcribes but
 * the engine must not guess at, with the reason. The engine quotes these
 * names back.
 */
export const PL_REFUSALS_2025: readonly string[] = [
  "Wypadkowe (employer, 0,40–8,12 % band transcribed above): the rate depends on the payer's PKD risk category or ZUS notification — tenant-declared via the pl_wypadkowe slot, never table-supplied",
  "FP/FS age band 55–60: art. 104b ust. 2 (promotion act; art. 261 labour-market act from 1 June 2025) splits the exemption by sex (55 women / 60 men) and no pack channel carries the employee's sex or birth month — the engine applies FP/FS below 55-by-year and zeroes them above 60-by-year, and refuses the band in between",
  "FGŚP age band 55–60: art. 9b ust. 2 splits the exemption the same way — the engine zeroes FGŚP above 60-by-year with FP/FS, and refuses the band in between",
  "FP/FS PUP-hire and return-from-leave exemptions (promotion act art. 104a/104c; labour-market act from 1 June 2025): need a hiring/leave channel no pack carries — the engine prices the standard FP-liable employee",
  "PIT 120 000 zł crossing on uneven pay: art. 32 ust. 2 tests year-to-date income from this payer and no pack channel carries YTD — the engine annualises the month's dochód at monthly periodicity (exact for level pay) and refuses uneven paths",
  "Emerytalne/rentowe 260 190 zł crossing on uneven pay: same — the engine annualises the month's base (exact for level pay) and refuses uneven paths",
  "Ulga dla młodych (under-26 exemption): needs the art. 31a ust. 8 exemption-claim channel plus YTD against the 85 528 zł limit — refused by name for every employee who turns 26 or less in the tax year",
  "50 % koszty uzyskania (twórcy) and art. 22 ust. 9 flat amounts: the engine applies ust. 2 pkt 1/3 only — author-work KUP needs a contract-type channel",
  "Wspólne rozliczenie / samotny rodzic (art. 6 ust. 2, 4, 4d): the art. 32 ust. 3 joint-filing advance variants need the spouse/child income statement — refused by name",
  "PPK (pracownicze plany kapitałowe): opt-out and needs a participation channel — refused by name",
  "Umowa zlecenia / dzieło and other non-employment titles: different ZUS/PIT regimes (voluntary chorobowe, no KUP 250/300, ryczałt advances) — refused by name, never priced as employment",
  "Niepobieranie zaliczek (art. 31c zero-advance request) and 1/24–1/36 split pomniejszenia across payers (art. 31b ust. 5): need declaration channels beyond the single-payer certificate — refused by name",
  "Non-monthly periodicity: the pack prices monthly pay (12 periods) only",
];
