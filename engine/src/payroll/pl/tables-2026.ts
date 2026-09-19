/**
 * Transcribed Polish statutory tables for calendar year 2026: PIT (podatek
 * dochodowy od osób fizycznych) and ZUS/NFZ contributions.
 *
 * Provenance — every figure below was read in its Polish original on
 * 2026-09-18/19 (official gazette PDFs via eli.gov.pl, ZUS's own guide):
 *
 * - Skala podatkowa + kwota zmniejszająca: ustawa z dnia 26 lipca 1991 r.
 *   o podatku dochodowym od osób fizycznych, tekst jednolity Dz.U. 2025
 *   poz. 163. Art. 27 ust. 1 gives the scale; art. 31b ust. 1–3 the monthly
 *   reduction on the employee's oświadczenie (the PIT-2 successor).
 * - Monthly advances: art. 32 ust. 2 (12 % / 32 % with the 120 000 zł
 *   year-to-date test) and ust. 4 (dochód = monthly revenue minus KUP and
 *   minus the employee's social contributions). KUP: art. 22 ust. 2 pkt 1
 *   (250 zł) and pkt 3 (300 zł dojazd).
 * - Rounding of PIT bases and advances: Ordynacja podatkowa art. 63 § 1,
 *   tekst jednolity Dz.U. 2025 poz. 111.
 * - Contribution rates and the employee/employer split: ustawa z dnia
 *   13 października 1998 r. o systemie ubezpieczeń społecznych, current
 *   2026 text Dz.U. 2026 poz. 199 — art. 22 ust. 1 (rates) and art. 16
 *   ust. 1, 1b, 2, 3 (split). Verified unchanged in the 2026 text.
 * - Annual emerytalne/rentowe base limit: obwieszczenie MRPiPS z dnia
 *   19 listopada 2025 r., M.P. 2025 poz. 1206 (282 600 zł at a 9 420 zł
 *   forecast wage; the 2026 Budget Act art. 24 corroborates 9 420 zł).
 * - Zdrowotna: ustawa z dnia 27 sierpnia 2004 r. o świadczeniach opieki
 *   zdrowotnej, tekst jednolity Dz.U. 2025 poz. 1461 — art. 79 ust. 1 (9 %)
 *   and art. 81 ust. 1, 5, 6 (base follows the emerytalne/rentowe base,
 *   NO 30× limit, minus the employee's emerytalne/rentowe/chorobowe).
 * - FP / FS / FGŚP 2026 rates: ustawa budżetowa na rok 2026, Dz.U. 2026
 *   poz. 62 — art. 25 (FP 1,0 %), art. 26 (FS 1,45 %), art. 27 (FGŚP 0,10 %).
 *   FP base and age rules: ustawa z dnia 20 marca 2025 r. o rynku pracy
 *   i służbach zatrudnienia, Dz.U. 2025 poz. 620 — art. 259 ust. 1 (base,
 *   no 30× cap, ≥ minimum wage), art. 260–263 (rate via budget act;
 *   55/60 age bar; PUP-hire and return-from-leave exemptions).
 * - Minimum wage 2026: rozporządzenie RM z dnia 11 września 2025 r.,
 *   Dz.U. 2025 poz. 1242 (4 806 zł from 1 January 2026).
 * - ZUS corroboration (baza-wiedzy/skladki-wskazniki-odsetki, read 2026-09-19,
 *   HTTP 200 with rendered content — not the SPA shell): the stopy page
 *   restates 19,52 % / 8,00 % / 2,45 % with wypadkowe "zróżnicowana"; the
 *   roczna-podstawa page lists "282 600,00 zł – kwota rocznego ograniczenia
 *   podstawy w 2026 r. (MP 2025.1206)"; the wysokość page states "Roczna
 *   podstawa wymiaru na ubezpieczenia emerytalne i rentowe w 2026 roku może
 *   wynosić maksymalnie 282 600 zł" with the 9 420 zł forecast. Statutes
 *   remain the source of every number; ZUS confirms them.
 * - Wypadkowe posture: sus art. 22 ust. 2 (differentiation rules live in
 *   the accident-insurance provisions) and ZUS's own guide "Ustalanie stopy
 *   procentowej składki na ubezpieczenie wypadkowe" (stan prawny
 *   1 stycznia 2026; rok składkowy 1 kwietnia 2026 – 31 marca 2027), where
 *   the rate is set per payer from its PKD risk category (small payers) or
 *   notified by ZUS (larger payers). No published table can supply it.
 *
 * Operative Polish is quoted on every constant below. Translations are the
 * pack's own.
 *
 * Money discipline: rates are exact decimal FRACTION strings ("0.0976" for
 * 9,76 %), never floats, never percents-as-numbers. Amounts are whole
 * złotych. The engine consumes them with bigint units (see
 * ./compute-statutory.ts).
 *
 * Rounding: the PIT Act states no line rounding of its own — Ordynacja
 * art. 63 § 1 rounds PIT bases and advances to full złotych. For ZUS/NFZ
 * lines NO agency rounding rule is quotable (the sus act's "pełnych groszy"
 * provisions govern self-employed bases, not payroll lines). Method
 * (engine-stated, not agency-quoted, per the FR precedent): each
 * contribution line rounds half-up to the grosz; ZUS settlement documents
 * are grosz-denominated, so grosz granularity is the honest scale.
 */

import { PayrollPackError } from "../payroll-error.ts";

/** One transcribed rate with its quoted source figure. */
export interface PlRate {
  /** Exact decimal fraction ("0.0976" for 9,76 %). */
  readonly rate: string;
  /** Operative text quoted from the statute. */
  readonly quote: string;
}

// ---------------------------------------------------------------------------
// PIT — skala podatkowa (art. 27 ust. 1 updof)
// ---------------------------------------------------------------------------

/**
 * "120 000 12 % minus kwota zmniejszająca podatek 3600 zł" and
 * "10 800 zł + 32 % nadwyżki ponad 120 000 zł".
 *
 * Translation: 12 % minus a 3 600 zł tax-reducing amount on bases up to
 * 120 000 zł; 10 800 zł plus 32 % of the excess above 120 000 zł.
 * (10 800 = 12 % × 90 000 — the engine asserts this relationship rather
 * than transcribing 10 800 as an independent figure.)
 */
export const PL_PIT_SKALA_2026 = {
  prog: "120000",
  stawkaDolna: { rate: "0.12", quote: "120 000 12 % minus kwota zmniejszająca podatek 3600 zł" },
  kwotaZmniejszajaca: "3600",
  podatekOdProgu: "10800",
  stawkaGorna: { rate: "0.32", quote: "10 800 zł + 32 % nadwyżki ponad 120 000 zł" },
} as const;

/**
 * Art. 31b ust. 1: "płatnik pomniejsza zaliczki o kwotę stanowiącą nie
 * więcej niż 1/12 kwoty zmniejszającej podatek, jeżeli podatnik złoży temu
 * płatnikowi oświadczenie o stosowaniu pomniejszenia."
 *
 * Translation: the payer reduces advances by at most 1/12 of the
 * tax-reducing amount when the employee files the reduction statement.
 * 1/12 × 3 600 = 300 zł. Art. 31b ust. 3 lets the employee elect 1/12,
 * 1/24 or 1/36 (300 / 150 / 100 zł); "nie więcej niż" caps the reduction
 * at the advance itself, so the engine floors the advance at zero.
 */
export const PL_PIT_POMNIEJSZENIE_2026 = {
  pelne: "300",
  polowa: "150",
  trzecia: "100",
  quote:
    "płatnik pomniejsza zaliczki o kwotę stanowiącą nie więcej niż 1/12 kwoty zmniejszającej podatek, "
    + "jeżeli podatnik złoży temu płatnikowi oświadczenie o stosowaniu pomniejszenia",
} as const;

/**
 * Art. 32 ust. 2: "Zaliczki za miesiące od stycznia do grudnia wynoszą:
 * 1) za miesiące, w których dochód podatnika uzyskany od początku roku od
 * danego płatnika nie przekroczył kwoty 120 000 zł – 12 % dochodu
 * uzyskanego w danym miesiącu; 2) za miesiąc, w którym dochód podatnika
 * uzyskany od początku roku od danego płatnika przekroczył kwotę
 * 120 000 zł – 12 % od tej części dochodu uzyskanego w tym miesiącu,
 * która nie przekroczyła tej kwoty, i 32 % od nadwyżki ponad kwotę
 * 120 000 zł; 3) za miesiące następujące po miesiącu, o którym mowa
 * w pkt 2 – 32 % dochodu uzyskanego w danym miesiącu od danego płatnika."
 *
 * Art. 32 ust. 4: "Za dochód, o którym mowa w ust. 2 i 3, uważa się
 * uzyskane w ciągu miesiąca przychody, o których mowa w ust. 1, po
 * odliczeniu kosztów uzyskania w wysokości określonej w art. 22 ust. 2
 * pkt 1 albo 3 lub ust. 9 pkt 1–3 oraz po odliczeniu potrąconych przez
 * płatnika w danym miesiącu składek na ubezpieczenie społeczne, o których
 * mowa w art. 26 ust. 1 pkt 2 lit. b lub pkt 2a."
 */
export const PL_PIT_ZALICZKA_QUOTE_2026 =
  "Zaliczki za miesiące od stycznia do grudnia wynoszą: 1) za miesiące, w których dochód podatnika "
  + "uzyskany od początku roku od danego płatnika nie przekroczył kwoty 120 000 zł – 12 % dochodu "
  + "uzyskanego w danym miesiącu; 2) za miesiąc, w którym dochód podatnika uzyskany od początku roku "
  + "od danego płatnika przekroczył kwotę 120 000 zł – 12 % od tej części dochodu uzyskanego w tym "
  + "miesiącu, która nie przekroczyła tej kwoty, i 32 % od nadwyżki ponad kwotę 120 000 zł; "
  + "3) za miesiące następujące po miesiącu, o którym mowa w pkt 2 – 32 % dochodu uzyskanego "
  + "w danym miesiącu od danego płatnika";

export const PL_PIT_DOCHOD_QUOTE_2026 =
  "Za dochód, o którym mowa w ust. 2 i 3, uważa się uzyskane w ciągu miesiąca przychody, "
  + "o których mowa w ust. 1, po odliczeniu kosztów uzyskania w wysokości określonej w art. 22 "
  + "ust. 2 pkt 1 albo 3 lub ust. 9 pkt 1–3 oraz po odliczeniu potrąconych przez płatnika w danym "
  + "miesiącu składek na ubezpieczenie społeczne, o których mowa w art. 26 ust. 1 pkt 2 lit. b lub pkt 2a";

/**
 * Art. 22 ust. 2 pkt 1: "wynoszą 250 zł miesięcznie, a za rok podatkowy
 * łącznie nie więcej niż 3000 zł – w przypadku gdy podatnik uzyskuje
 * przychody z tytułu jednego stosunku służbowego, stosunku pracy,
 * spółdzielczego stosunku pracy oraz pracy nakładczej"; pkt 3: "wynoszą
 * 300 zł miesięcznie, a za rok podatkowy łącznie nie więcej niż 3600 zł –
 * w przypadku gdy miejsce stałego lub czasowego zamieszkania podatnika
 * jest położone poza miejscowością, w której znajduje się zakład pracy,
 * i podatnik nie uzyskuje dodatku za rozłąkę".
 */
export const PL_KUP_2026 = {
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
 * Ordynacja podatkowa art. 63 § 1: "Podstawy opodatkowania, kwoty podatków,
 * odsetki za zwłokę, opłaty prolongacyjne, oprocentowanie nadpłat oraz
 * wynagrodzenia przysługujące płatnikom i inkasentom zaokrągla się do
 * pełnych złotych w ten sposób, że końcówki kwot wynoszące mniej niż
 * 50 groszy pomija się, a końcówki kwot wynoszące 50 i więcej groszy
 * podwyższa się do pełnych złotych, z zastrzeżeniem § 1a i 2."
 *
 * Translation: tax bases and tax amounts round to whole złotych —
 * endings below 50 groszy are dropped, 50+ groszy round up.
 */
export const PL_ZAOKRAGLENIE_PIT_QUOTE_2026 =
  "Podstawy opodatkowania, kwoty podatków, odsetki za zwłokę, opłaty prolongacyjne, oprocentowanie "
  + "nadpłat oraz wynagrodzenia przysługujące płatnikom i inkasentom zaokrągla się do pełnych złotych "
  + "w ten sposób, że końcówki kwot wynoszące mniej niż 50 groszy pomija się, a końcówki kwot "
  + "wynoszące 50 i więcej groszy podwyższa się do pełnych złotych, z zastrzeżeniem § 1a i 2";

// ---------------------------------------------------------------------------
// ZUS — rates (art. 22 ust. 1) and split (art. 16)
// ---------------------------------------------------------------------------

/**
 * Art. 22 ust. 1: "Stopy procentowe składek wynoszą: 1) 19,52 %
 * podstawy wymiaru – na ubezpieczenie emerytalne, z zastrzeżeniem ust. 3
 * i 4; 2) 8,00 % podstawy wymiaru – na ubezpieczenia rentowe; 3) 2,45 %
 * podstawy wymiaru – na ubezpieczenie chorobowe; 4) od 0,40 % do 8,12 %
 * podstawy wymiaru – na ubezpieczenie wypadkowe."
 */
export const PL_SKLADKI_STOPY_2026 = {
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
 * Art. 16 ust. 1 (emerytalne): workers' contributions "finansują
 * z własnych środków, w równych częściach, ubezpieczeni i płatnicy
 * składek" — in equal parts, so 9,76 % / 9,76 %. The engine asserts the
 * halving rather than transcribing 9,76 as an independent figure.
 *
 * Art. 16 ust. 1b (rentowe): "finansują z własnych środków, w wysokości
 * 1,5 % podstawy wymiaru ubezpieczeni i w wysokości 6,5 % podstawy wymiaru
 * płatnicy składek."
 *
 * Art. 16 ust. 2 (chorobowe): "finansują w całości, z własnych środków,
 * sami ubezpieczeni."
 *
 * Art. 16 ust. 3 (wypadkowe): "finansują w całości, z własnych środków,
 * płatnicy składek."
 */
export const PL_SKLADKI_PODZIAL_2026 = {
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
 * Art. 19 ust. 1: "Roczna podstawa wymiaru składek na ubezpieczenia
 * emerytalne i rentowe osób, o których mowa w art. 6 i 7, w danym roku
 * kalendarzowym nie może być wyższa od kwoty odpowiadającej
 * trzydziestokrotności prognozowanego przeciętnego wynagrodzenia
 * miesięcznego w gospodarce narodowej na dany rok kalendarzowy (…)"
 * Art. 19 ust. 3: "Od nadwyżki ponad kwotę, o której mowa w ust. 1, nie
 * pobiera się składek na ubezpieczenia emerytalne i rentowe."
 *
 * The 2026 figure: obwieszczenie MRPiPS z dnia 19 listopada 2025 r.
 * (M.P. 2025 poz. 1206): "ogłasza się, że kwota ograniczenia rocznej
 * podstawy wymiaru składek na ubezpieczenia emerytalne i rentowe w roku
 * 2026 wynosi 282 600 zł, a przyjęta do jej ustalenia kwota
 * prognozowanego przeciętnego wynagrodzenia wynosi 9420 zł."
 *
 * The cap covers emerytalne/rentowe ONLY — chorobowe, wypadkowe and
 * zdrowotna price the full revenue (see art. 81 ust. 5 for zdrowotna).
 */
export const PL_ROCZNY_LIMIT_2026 = {
  annual: "282600",
  prognozowane: "9420",
  quote:
    "ogłasza się, że kwota ograniczenia rocznej podstawy wymiaru składek na ubezpieczenia emerytalne "
    + "i rentowe w roku 2026 wynosi 282 600 zł, a przyjęta do jej ustalenia kwota prognozowanego "
    + "przeciętnego wynagrodzenia wynosi 9420 zł",
} as const;

// ---------------------------------------------------------------------------
// NFZ — składka zdrowotna (art. 79 ust. 1, art. 81)
// ---------------------------------------------------------------------------

/**
 * Art. 79 ust. 1: "Składka na ubezpieczenie zdrowotne wynosi 9 %
 * podstawy wymiaru składki, z zastrzeżeniem art. 79a, art. 80, art. 82
 * i art. 242."
 *
 * Art. 81 ust. 6: "Podstawę wymiaru składki na ubezpieczenie zdrowotne
 * pomniejsza się o kwoty składek na ubezpieczenia emerytalne, rentowe
 * i chorobowe finansowanych przez ubezpieczonych niebędących płatnikami
 * składek, potrąconych przez płatników ze środków ubezpieczonego, zgodnie
 * z przepisami o systemie ubezpieczeń społecznych."
 *
 * Art. 81 ust. 5 (no cap): "Przy ustalaniu podstawy wymiaru składki na
 * ubezpieczenie zdrowotne osób, o których mowa w ust. 1, nie stosuje się
 * wyłączeń wynagrodzeń za czas niezdolności do pracy (…) oraz nie stosuje
 * się ograniczenia, o którym mowa w art. 19 ust. 1 ustawy z dnia
 * 13 października 1998 r. o systemie ubezpieczeń społecznych."
 */
export const PL_ZDROWOTNA_2026: PlRate = {
  rate: "0.09",
  quote: "Składka na ubezpieczenie zdrowotne wynosi 9 % podstawy wymiaru składki",
};

export const PL_ZDROWOTNA_PODSTAWA_QUOTE_2026 =
  "Podstawę wymiaru składki na ubezpieczenie zdrowotne pomniejsza się o kwoty składek na "
  + "ubezpieczenia emerytalne, rentowe i chorobowe finansowanych przez ubezpieczonych niebędących "
  + "płatnikami składek, potrąconych przez płatników ze środków ubezpieczonego, zgodnie z przepisami "
  + "o systemie ubezpieczeń społecznych";

// ---------------------------------------------------------------------------
// FP / FS / FGŚP 2026 — Budget Act rates on the labour-market-act base
// ---------------------------------------------------------------------------

/**
 * Ustawa budżetowa na rok 2026 (Dz.U. 2026 poz. 62):
 * - Art. 25: "ustala się wysokość obowiązkowej składki na Fundusz Pracy,
 *   która wynosi 1,0 % podstawy wymiaru składek na ubezpieczenia
 *   emerytalne i rentowe, określonej w art. 259 ust. 1 wymienionej ustawy."
 * - Art. 26: "ustala się wysokość obowiązkowej składki na Fundusz
 *   Solidarnościowy, która wynosi 1,45 % podstawy wymiaru składek na
 *   ubezpieczenia emerytalne i rentowe, określonej w art. 259 ust. 1
 *   ustawy wymienionej w art. 25."
 * - Art. 27: "ustala się wysokość obowiązkowej składki na Fundusz
 *   Gwarantowanych Świadczeń Pracowniczych, która wynosi 0,10 % podstawy
 *   wymiaru składek na ubezpieczenia emerytalne i rentowe, określonej
 *   w art. 29 ust. 1 wymienionej ustawy."
 * - Art. 24 corroborates the forecast wage: "Prognozowane przeciętne
 *   miesięczne wynagrodzenie brutto w gospodarce narodowej wynosi 9 420 zł."
 *
 * All employer-paid. FP + FS = 2,45 % prices the same base under the same
 * conditions (Budget art. 26 ties FS to the art. 259 ust. 1 base).
 */
export const PL_FUNDUSZE_2026 = {
  fp: {
    rate: "0.01",
    quote:
      "ustala się wysokość obowiązkowej składki na Fundusz Pracy, która wynosi 1,0 % podstawy "
      + "wymiaru składek na ubezpieczenia emerytalne i rentowe, określonej w art. 259 ust. 1 "
      + "wymienionej ustawy",
  },
  fs: {
    rate: "0.0145",
    quote:
      "ustala się wysokość obowiązkowej składki na Fundusz Solidarnościowy, która wynosi 1,45 % "
      + "podstawy wymiaru składek na ubezpieczenia emerytalne i rentowe, określonej w art. 259 ust. 1 "
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
 * Art. 259 ust. 1 (labour-market act): "Obowiązkowe składki na Fundusz
 * Pracy, ustalone od kwot stanowiących podstawę wymiaru składek na
 * ubezpieczenia emerytalne i rentowe bez stosowania ograniczenia,
 * o którym mowa w art. 19 ust. 1 ustawy (…) o systemie ubezpieczeń
 * społecznych, wynoszących w przeliczeniu na okres miesiąca, co najmniej
 * minimalne wynagrodzenie za pracę opłacają: 1) pracodawcy (…) za:
 * a) osoby pozostające w stosunku pracy lub stosunku służbowym (…)"
 *
 * So the FP/FS base is the UNCAPPED emerytalne/rentowe base, but only
 * when it reaches the minimum wage for the month.
 *
 * Art. 261: "Obowiązkowe składki na Fundusz Pracy opłaca się za osoby
 * wymienione w art. 259 ust. 1, które nie osiągnęły wieku wynoszącego
 * co najmniej 55 lat w przypadku kobiet i co najmniej 60 lat
 * w przypadku mężczyzn."
 */
export const PL_FP_PODSTAWA_QUOTE_2026 =
  "Obowiązkowe składki na Fundusz Pracy, ustalone od kwot stanowiących podstawę wymiaru składek "
  + "na ubezpieczenia emerytalne i rentowe bez stosowania ograniczenia, o którym mowa w art. 19 "
  + "ust. 1 ustawy z dnia 13 października 1998 r. o systemie ubezpieczeń społecznych, wynoszących "
  + "w przeliczeniu na okres miesiąca, co najmniej minimalne wynagrodzenie za pracę opłacają: "
  + "1) pracodawcy oraz inne jednostki organizacyjne za: a) osoby pozostające w stosunku pracy "
  + "lub stosunku służbowym";

export const PL_FP_WIEK_QUOTE_2026 =
  "Obowiązkowe składki na Fundusz Pracy opłaca się za osoby wymienione w art. 259 ust. 1, które "
  + "nie osiągnęły wieku wynoszącego co najmniej 55 lat w przypadku kobiet i co najmniej 60 lat "
  + "w przypadku mężczyzn";

/**
 * Rozporządzenie RM z dnia 11 września 2025 r. (Dz.U. 2025 poz. 1242),
 * § 1: "Od dnia 1 stycznia 2026 r. ustala się minimalne wynagrodzenie
 * za pracę w wysokości 4806 zł."
 */
export const PL_MIN_WAGE_2026 = {
  monthly: "4806",
  quote:
    "Od dnia 1 stycznia 2026 r. ustala się minimalne wynagrodzenie za pracę w wysokości 4806 zł",
} as const;

// ---------------------------------------------------------------------------
// Tenant-declared by design (posture quotes, no rates transcribable)
// ---------------------------------------------------------------------------

/**
 * Sus art. 22 ust. 2: "Zasady różnicowania stopy procentowej składek na
 * ubezpieczenie wypadkowe określają przepisy o ubezpieczeniu społecznym
 * z tytułu wypadków przy pracy i chorób zawodowych." Those rules set the
 * rate per payer from its PKD risk category (small payers take their
 * activity group's rate) or by ZUS notification (larger payers, from their
 * ZUS IWA record) — ZUS poradnik "Ustalanie stopy procentowej składki na
 * ubezpieczenie wypadkowe", stan prawny 1 stycznia 2026, for the rok
 * składkowy 1 kwietnia 2026 – 31 marca 2027. A pack constant would be a
 * guess: the tenant declares the rate, the pack never invents one.
 */
export const PL_TENANT_DECLARED_QUOTE_2026 =
  "Zasady różnicowania stopy procentowej składek na ubezpieczenie wypadkowe określają przepisy "
  + "o ubezpieczeniu społecznym z tytułu wypadków przy pracy i chorób zawodowych";

/**
 * Named refusals for the 2026 pass: everything this file transcribes but
 * the engine must not guess at, with the reason. The engine quotes these
 * names back.
 */
export const PL_REFUSALS_2026: readonly string[] = [
  "Wypadkowe (employer, 0,40–8,12 % band transcribed above): the rate depends on the payer's PKD risk category or ZUS notification — tenant-declared via the pl_wypadkowe slot, never table-supplied",
  "FP/FS age band 55–60: art. 261 splits the exemption by sex (55 women / 60 men) and no pack channel carries the employee's sex or birth month — the engine applies FP/FS below 55-by-year and zeroes them above 60-by-year, and refuses the band in between",
  "FP/FS PUP-hire and return-from-leave exemptions (art. 262–263): need a hiring/leave channel no pack carries — the engine prices the standard FP-liable employee",
  "PIT 120 000 zł crossing on uneven pay: art. 32 ust. 2 tests year-to-date income from this payer and no pack channel carries YTD — the engine annualises the month's dochód at monthly periodicity (exact for level pay) and refuses uneven paths",
  "Emerytalne/rentowe 282 600 zł crossing on uneven pay: same — the engine annualises the month's base (exact for level pay) and refuses uneven paths",
  "Ulga dla młodych (under-26 exemption): needs the art. 31a ust. 8 exemption-claim channel plus YTD against the 85 528 zł limit — refused by name for every employee who turns 26 or less in the tax year",
  "50 % koszty uzyskania (twórcy) and art. 22 ust. 9 flat amounts: the engine applies ust. 2 pkt 1/3 only — author-work KUP needs a contract-type channel",
  "Wspólne rozliczenie / samotny rodzic (art. 6 ust. 2, 4, 4d): the art. 32 ust. 3 joint-filing advance variants need the spouse/child income statement — refused by name",
  "PPK (pracownicze plany kapitałowe): opt-out and needs a participation channel — refused by name",
  "Umowa zlecenia / dzieło and other non-employment titles: different ZUS/PIT regimes (voluntary chorobowe, no KUP 250/300, ryczałt advances) — refused by name, never priced as employment",
  "Niepobieranie zaliczek (art. 31c zero-advance request) and 1/24–1/36 split pomniejszenia across payers (art. 31b ust. 5): need declaration channels beyond the single-payer certificate — refused by name",
  "Non-monthly periodicity: the pack prices monthly pay (12 periods) only",
];

/** 2026 tables resolve by calendar year and throw otherwise. */
export function plTableYearForPayDate(payDate: string): 2026 {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) {
    throw new PayrollPackError(
      `PL tables need an ISO pay date (YYYY-MM-DD), got "${payDate}"`,
    );
  }
  if (payDate < "2026-01-01" || payDate > "2026-12-31") {
    throw new PayrollPackError(
      `PL tables have no transcribed figures for pay date ${payDate}: `
      + "the PL pack transcribes calendar 2026 only "
      + "(PIT skala + ZUS/NFZ/FP rates, Budget Act and obwieszczenia for 2026). "
      + "Transcribe the year's tables into engine/src/payroll/pl/ first.",
    );
  }
  return 2026;
}
