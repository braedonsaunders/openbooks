/**
 * Transcribed Polish statutory tables for calendar year 2024: PIT (podatek
 * dochodowy od osób fizycznych) and ZUS/NFZ contributions.
 *
 * Provenance — every figure below was read in its Polish original on
 * 2026-09-20/21 (official gazette PDFs via eli.gov.pl / dziennikustaw.gov.pl /
 * monitorpolski.gov.pl, and ZUS's own contribution guide):
 *
 * - Skala podatkowa + kwota zmniejszająca: ustawa z dnia 26 lipca 1991 r.
 *   o podatku dochodowym od osób fizycznych, tekst jednolity Dz.U. 2024
 *   poz. 226. Art. 27 ust. 1 gives the scale (120 000 / 12 % / 3 600 /
 *   10 800 + 32 % — verified verbatim, identical to the 2025/2026
 *   transcription); art. 31b ust. 1–3 the monthly reduction.
 * - Monthly advances: art. 32 ust. 2 / ust. 4, verified verbatim. KUP:
 *   art. 22 ust. 2 pkt 1 (250 zł) and pkt 3 (300 zł dojazd), verified.
 *   Art. 27b prints "(uchylony)" — zdrowotna is NOT deductible from PIT
 *   in 2024.
 * - Rounding: Ordynacja podatkowa art. 63 § 1, tekst jednolity Dz.U. 2023
 *   poz. 2383 — verified verbatim.
 * - Contribution rates and split: sus tekst jednolity Dz.U. 2024 poz. 497
 *   — art. 22 ust. 1 (19,52 % / 8,00 % / 2,45 % / 0,40–8,12 %) and art. 16
 *   ust. 1, 1b, 2, 3, verified verbatim, identical to 2025/2026.
 * - Annual emerytalne/rentowe base limit: obwieszczenie MRiPS z dnia
 *   4 grudnia 2023 r., M.P. 2023 poz. 1356 (read from the gazette PDF
 *   2026-09-21): "ogłasza się, że kwota ograniczenia rocznej podstawy
 *   wymiaru składek na ubezpieczenia emerytalne i rentowe w roku 2024
 *   wynosi 234 720 zł, a przyjęta do jej ustalenia kwota prognozowanego
 *   przeciętnego wynagrodzenia wynosi 7824 zł." Corroborated by Budget
 *   2024 art. 24 (7 824 zł; 30 × 7 824 = 234 720).
 * - Zdrowotna: health act tekst jednolity Dz.U. 2024 poz. 146 —
 *   art. 79 ust. 1 (9 %), art. 81 ust. 5 (no 30× cap) and ust. 6 (minus
 *   the employee's emerytalne/rentowe/chorobowe), verified verbatim.
 * - FP 1,0 % / FS 1,45 % / FGŚP 0,10 %: ustawa budżetowa na rok 2024,
 *   Dz.U. 2024 poz. 122 — art. 26 (FP, base: promotion act art. 104
 *   ust. 1), art. 27 (FS, same base, FS act Dz.U. 2023 poz. 647),
 *   art. 28 (FGŚP, base: claims-protection art. 29 ust. 1), read from the
 *   gazette PDF. ZUS's own guide confirms the standing history (FP 1,00 %
 *   od 2021, FS 1,45 % od 2021, joint DRA declaration at 2,45 %).
 * - FP base and age rules: promotion act, tekst jednolity Dz.U. 2024
 *   poz. 475 — art. 104 ust. 1 (base, verified verbatim) and art. 104b
 *   ust. 2: "Składki na Fundusz Pracy, o których mowa w art. 104 ust. 1,
 *   opłaca się za osoby wymienione w art. 104 ust. 1 pkt 1–3, które nie
 *   osiągnęły wieku wynoszącego co najmniej 55 lat dla kobiet
 *   i co najmniej 60 lat dla mężczyzn" (verified verbatim).
 * - FGŚP age bar: claims-protection act, tekst jednolity Dz.U. 2023
 *   poz. 1087 — art. 9b ust. 2 (same 55/60 exemption, verified verbatim;
 *   the 2024 amendments Dz.U. 2024 poz. 1089, 1635, 1871 reword neither
 *   quoted sentence, confirmed by the single-version print in the
 *   Dz.U. 2025 poz. 433 consolidation). 2024 sets the pack's `fgspAgeBar`
 *   flag, as does 2026 under its own consolidated text (Dz.U. 2026
 *   poz. 186 — see ./tables-2026.ts).
 * - Minimum wage 2024, TWO steps in one regulation: rozporządzenie RM
 *   z dnia 14 września 2023 r., Dz.U. 2023 poz. 1893 — "Od dnia
 *   1 stycznia 2024 r. ustala się minimalne wynagrodzenie za pracę
 *   w wysokości 4242 zł" and "Od dnia 1 lipca 2024 r. ustala się
 *   minimalne wynagrodzenie za pracę w wysokości 4300 zł" (read from the
 *   gazette PDF 2026-09-20). The FP/FS threshold follows the month, so
 *   the 2024 tables carry both values with the 1 July switch — ONE 2024
 *   edition (one publication, two effective dates), not two editions.
 * - Wypadkowe posture: sus art. 22 ust. 2 (Dz.U. 2024 poz. 497) —
 *   per-payer rate, tenant-declared. Ulga dla młodych limit 85 528 zł:
 *   updof Dz.U. 2024 poz. 226 — refusal-channel fact.
 *
 * Operative Polish is quoted on every constant below. Translations are the
 * pack's own. Money discipline as in ./tables-2026.ts.
 */

import type { PlRate } from "./tables-2026.ts";

// ---------------------------------------------------------------------------
// PIT — skala podatkowa (art. 27 ust. 1 updof, Dz.U. 2024 poz. 226)
// ---------------------------------------------------------------------------

/**
 * "120 000 12% minus kwota zmniejszająca podatek 3600 zł" and
 * "10 800 zł + 32% nadwyżki ponad 120 000 zł" (Dz.U. 2024 poz. 226,
 * art. 27 ust. 1 — verified verbatim 2026-09-20).
 */
export const PL_PIT_SKALA_2024 = {
  prog: "120000",
  stawkaDolna: { rate: "0.12", quote: "120 000 12% minus kwota zmniejszająca podatek 3600 zł" },
  kwotaZmniejszajaca: "3600",
  podatekOdProgu: "10800",
  stawkaGorna: { rate: "0.32", quote: "10 800 zł + 32% nadwyżki ponad 120 000 zł" },
} as const;

/**
 * Art. 31b ust. 1 (Dz.U. 2024 poz. 226): "płatnik pomniejsza zaliczki
 * o kwotę stanowiącą nie więcej niż 1/12 kwoty zmniejszającej podatek,
 * jeżeli podatnik złoży temu płatnikowi oświadczenie o stosowaniu
 * pomniejszenia." Ust. 3: 1/12, 1/24 or 1/36. Verified verbatim.
 */
export const PL_PIT_POMNIEJSZENIE_2024 = {
  pelne: "300",
  polowa: "150",
  trzecia: "100",
  quote:
    "płatnik pomniejsza zaliczki o kwotę stanowiącą nie więcej niż 1/12 kwoty zmniejszającej podatek, "
    + "jeżeli podatnik złoży temu płatnikowi oświadczenie o stosowaniu pomniejszenia",
} as const;

/**
 * Art. 32 ust. 2 / ust. 4 (Dz.U. 2024 poz. 226) — the 12 %/32 % monthly
 * advances with the 120 000 zł year-to-date test, and dochód as monthly
 * revenue minus KUP minus the employee's social contributions. Verified
 * verbatim, identical to the 2025/2026 transcription.
 */
export const PL_PIT_ZALICZKA_QUOTE_2024 =
  "Zaliczki za miesiące od stycznia do grudnia wynoszą: 1) za miesiące, w których dochód podatnika "
  + "uzyskany od początku roku od danego płatnika nie przekroczył kwoty 120 000 zł – 12 % dochodu "
  + "uzyskanego w danym miesiącu; 2) za miesiąc, w którym dochód podatnika uzyskany od początku roku "
  + "od danego płatnika przekroczył kwotę 120 000 zł – 12 % od tej części dochodu uzyskanego w tym "
  + "miesiącu, która nie przekroczyła tej kwoty, i 32 % od nadwyżki ponad kwotę 120 000 zł; "
  + "3) za miesiące następujące po miesiącu, o którym mowa w pkt 2 – 32 % dochodu uzyskanego "
  + "w danym miesiącu od danego płatnika";

export const PL_PIT_DOCHOD_QUOTE_2024 =
  "Za dochód, o którym mowa w ust. 2 i 3, uważa się uzyskane w ciągu miesiąca przychody, "
  + "o których mowa w ust. 1, po odliczeniu kosztów uzyskania w wysokości określonej w art. 22 "
  + "ust. 2 pkt 1 albo 3 lub ust. 9 pkt 1–3 oraz po odliczeniu potrąconych przez płatnika w danym "
  + "miesiącu składek na ubezpieczenie społeczne, o których mowa w art. 26 ust. 1 pkt 2 lit. b lub pkt 2a";

/**
 * Art. 22 ust. 2 pkt 1 / pkt 3 (Dz.U. 2024 poz. 226): "wynoszą 250 zł
 * miesięcznie, a za rok podatkowy łącznie nie więcej niż 3000 zł" /
 * "wynoszą 300 zł miesięcznie, a za rok podatkowy łącznie nie więcej niż
 * 3600 zł". Verified verbatim.
 */
export const PL_KUP_2024 = {
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
 * Ordynacja podatkowa art. 63 § 1 (Dz.U. 2023 poz. 2383): "Podstawy
 * opodatkowania, kwoty podatków, (...) zaokrągla się do pełnych złotych
 * w ten sposób, że końcówki kwot wynoszące mniej niż 50 groszy pomija
 * się, a końcówki kwot wynoszące 50 i więcej groszy podwyższa się do
 * pełnych złotych, z zastrzeżeniem § 1a i 2." Verified verbatim.
 */
export const PL_ZAOKRAGLENIE_PIT_QUOTE_2024 =
  "Podstawy opodatkowania, kwoty podatków, odsetki za zwłokę, opłaty prolongacyjne, oprocentowanie "
  + "nadpłat oraz wynagrodzenia przysługujące płatnikom i inkasentom zaokrągla się do pełnych złotych "
  + "w ten sposób, że końcówki kwot wynoszące mniej niż 50 groszy pomija się, a końcówki kwot "
  + "wynoszące 50 i więcej groszy podwyższa się do pełnych złotych, z zastrzeżeniem § 1a i 2";

// ---------------------------------------------------------------------------
// ZUS — rates (art. 22 ust. 1) and split (art. 16), Dz.U. 2024 poz. 497
// ---------------------------------------------------------------------------

/**
 * Art. 22 ust. 1 (Dz.U. 2024 poz. 497): 19,52 % / 8,00 % / 2,45 % /
 * od 0,40 % do 8,12 %. Verified verbatim, identical to 2025/2026.
 */
export const PL_SKLADKI_STOPY_2024 = {
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
 * Art. 16 ust. 1 (equal halves), ust. 1b (1,5 % / 6,5 %), ust. 2
 * (chorobowe employee only), ust. 3 (wypadkowe employer only) — Dz.U. 2024
 * poz. 497, verified verbatim, same split as 2025/2026.
 */
export const PL_SKLADKI_PODZIAL_2024 = {
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
 * Obwieszczenie Ministra Rodziny i Polityki Społecznej z dnia 4 grudnia
 * 2023 r., M.P. 2023 poz. 1356 (read from the gazette PDF 2026-09-21):
 * "ogłasza się, że kwota ograniczenia rocznej podstawy wymiaru składek
 * na ubezpieczenia emerytalne i rentowe w roku 2024 wynosi 234 720 zł,
 * a przyjęta do jej ustalenia kwota prognozowanego przeciętnego
 * wynagrodzenia wynosi 7824 zł."
 */
export const PL_ROCZNY_LIMIT_2024 = {
  annual: "234720",
  prognozowane: "7824",
  quote:
    "ogłasza się, że kwota ograniczenia rocznej podstawy wymiaru składek na ubezpieczenia emerytalne "
    + "i rentowe w roku 2024 wynosi 234 720 zł, a przyjęta do jej ustalenia kwota prognozowanego "
    + "przeciętnego wynagrodzenia wynosi 7824 zł",
} as const;

// ---------------------------------------------------------------------------
// NFZ — składka zdrowotna, Dz.U. 2024 poz. 146
// ---------------------------------------------------------------------------

/**
 * Art. 79 ust. 1: "Składka na ubezpieczenie zdrowotne wynosi 9 %
 * podstawy wymiaru składki, z zastrzeżeniem art. 79a, art. 80, art. 82
 * i art. 242." Verified verbatim. Art. 27b updof prints "(uchylony)" —
 * no PIT deduction for zdrowotna in 2024.
 */
export const PL_ZDROWOTNA_2024: PlRate = {
  rate: "0.09",
  quote: "Składka na ubezpieczenie zdrowotne wynosi 9 % podstawy wymiaru składki",
};

export const PL_ZDROWOTNA_PODSTAWA_QUOTE_2024 =
  "Podstawę wymiaru składki na ubezpieczenie zdrowotne pomniejsza się o kwoty składek na "
  + "ubezpieczenia emerytalne, rentowe i chorobowe finansowanych przez ubezpieczonych niebędących "
  + "płatnikami składek, potrąconych przez płatników ze środków ubezpieczonego, zgodnie z przepisami "
  + "o systemie ubezpieczeń społecznych";

// ---------------------------------------------------------------------------
// FP / FS / FGŚP 2024 — Budget Act rates on the promotion-act base
// ---------------------------------------------------------------------------

/**
 * Ustawa budżetowa na rok 2024 (Dz.U. 2024 poz. 122), read from the
 * gazette PDF 2026-09-21:
 * - Art. 26: "ustala się wysokość obowiązkowej składki na Fundusz Pracy,
 *   która wynosi 1,0 % podstawy wymiaru składek na ubezpieczenia
 *   emerytalne i rentowe, określonej w art. 104 ust. 1 wymienionej ustawy"
 *   (the promotion act, Dz.U. 2023 poz. 735).
 * - Art. 27: "ustala się wysokość obowiązkowej składki na Fundusz
 *   Solidarnościowy, która wynosi 1,45 % podstawy wymiaru składek na
 *   ubezpieczenia emerytalne i rentowe, określonej w art. 104 ust. 1
 *   ustawy wymienionej w art. 26" (the FS act, Dz.U. 2023 poz. 647).
 * - Art. 28: "ustala się wysokość obowiązkowej składki na Fundusz
 *   Gwarantowanych Świadczeń Pracowniczych, która wynosi 0,10 % podstawy
 *   wymiaru składek na ubezpieczenia emerytalne i rentowe, określonej
 *   w art. 29 ust. 1 wymienionej ustawy" (the claims-protection act,
 *   Dz.U. 2023 poz. 1087).
 * - Art. 24 corroborates the forecast wage: "Prognozowane przeciętne
 *   miesięczne wynagrodzenie brutto w gospodarce narodowej wynosi 7 824 zł."
 */
export const PL_FUNDUSZE_2024 = {
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
      + "ustawy wymienionej w art. 26",
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
 * Promotion act (Dz.U. 2024 poz. 475) art. 104 ust. 1: "Obowiązkowe
 * składki na Fundusz Pracy, ustalone od kwot stanowiących podstawę
 * wymiaru składek na ubezpieczenia emerytalne i rentowe bez stosowania
 * ograniczenia, o którym mowa w art. 19 ust. 1 ustawy (...) o systemie
 * ubezpieczeń społecznych, wynoszących w przeliczeniu na okres miesiąca,
 * co najmniej minimalne wynagrodzenie za pracę opłacają: 1) pracodawcy
 * (...)". Verified verbatim.
 */
export const PL_FP_PODSTAWA_QUOTE_2024 =
  "Obowiązkowe składki na Fundusz Pracy, ustalone od kwot stanowiących podstawę wymiaru składek "
  + "na ubezpieczenia emerytalne i rentowe bez stosowania ograniczenia, o którym mowa w art. 19 "
  + "ust. 1 ustawy z dnia 13 października 1998 r. o systemie ubezpieczeń społecznych, wynoszących "
  + "w przeliczeniu na okres miesiąca, co najmniej minimalne wynagrodzenie za pracę opłacają: "
  + "1) pracodawcy oraz inne jednostki organizacyjne za osoby pozostające w stosunku pracy";

/**
 * Promotion act (Dz.U. 2024 poz. 475) art. 104b ust. 2: "Składki na
 * Fundusz Pracy, o których mowa w art. 104 ust. 1, opłaca się za osoby
 * wymienione w art. 104 ust. 1 pkt 1–3, które nie osiągnęły wieku
 * wynoszącego co najmniej 55 lat dla kobiet i co najmniej 60 lat dla
 * mężczyzn." Verified verbatim.
 */
export const PL_FP_WIEK_QUOTE_2024 =
  "Składki na Fundusz Pracy, o których mowa w art. 104 ust. 1, opłaca się za osoby wymienione "
  + "w art. 104 ust. 1 pkt 1–3, które nie osiągnęły wieku wynoszącego co najmniej 55 lat dla kobiet "
  + "i co najmniej 60 lat dla mężczyzn";

/**
 * Claims-protection act (Dz.U. 2023 poz. 1087) art. 9b ust. 2:
 * "Pracodawca, o którym mowa w art. 9, nie opłaca składek na Fundusz za
 * pracowników, którzy osiągnęli wiek wynoszący co najmniej 55 lat dla
 * kobiet i co najmniej 60 lat dla mężczyzn." Verified verbatim. FGŚP
 * follows the same 55/60 bar as FP/FS in 2024 — the pack's `fgspAgeBar`
 * flag (see ./compute-statutory.ts).
 */
export const PL_FGSP_WIEK_QUOTE_2024 =
  "Pracodawca, o którym mowa w art. 9, nie opłaca składek na Fundusz za pracowników, którzy "
  + "osiągnęli wiek wynoszący co najmniej 55 lat dla kobiet i co najmniej 60 lat dla mężczyzn";

/**
 * Rozporządzenie RM z dnia 14 września 2023 r. (Dz.U. 2023 poz. 1893) —
 * TWO steps in one regulation: "Od dnia 1 stycznia 2024 r. ustala się
 * minimalne wynagrodzenie za pracę w wysokości 4242 zł" and "Od dnia
 * 1 lipca 2024 r. ustala się minimalne wynagrodzenie za pracę
 * w wysokości 4300 zł" (read from the gazette PDF 2026-09-20). The
 * FP/FS minimum-wage threshold follows the month: the engine resolves
 * it from the pay date (see ./compute-statutory.ts).
 */
export const PL_MIN_WAGE_2024 = {
  pierwszaPolowa: "4242",
  drugaPolowa: "4300",
  zmianaOd: "2024-07-01",
  quote:
    "Od dnia 1 stycznia 2024 r. ustala się minimalne wynagrodzenie za pracę w wysokości 4242 zł; "
    + "od dnia 1 lipca 2024 r. ustala się minimalne wynagrodzenie za pracę w wysokości 4300 zł",
} as const;

// ---------------------------------------------------------------------------
// Tenant-declared by design (posture quotes, no rates transcribable)
// ---------------------------------------------------------------------------

/**
 * Sus art. 22 ust. 2 (Dz.U. 2024 poz. 497): "Zasady różnicowania stopy
 * procentowej składek na ubezpieczenie wypadkowe określają przepisy
 * o ubezpieczeniu społecznym z tytułu wypadków przy pracy i chorób
 * zawodowych." Verified verbatim — per-payer rate, tenant-declared.
 */
export const PL_TENANT_DECLARED_QUOTE_2024 =
  "Zasady różnicowania stopy procentowej składek na ubezpieczenie wypadkowe określają przepisy "
  + "o ubezpieczeniu społecznym z tytułu wypadków przy pracy i chorób zawodowych";

/**
 * Named refusals for the 2024 pass: everything this file transcribes but
 * the engine must not guess at, with the reason. The engine quotes these
 * names back.
 */
export const PL_REFUSALS_2024: readonly string[] = [
  "Wypadkowe (employer, 0,40–8,12 % band transcribed above): the rate depends on the payer's PKD risk category or ZUS notification — tenant-declared via the pl_wypadkowe slot, never table-supplied",
  "FP/FS age band 55–60: art. 104b ust. 2 splits the exemption by sex (55 women / 60 men) and no pack channel carries the employee's sex or birth month — the engine applies FP/FS below 55-by-year and zeroes them above 60-by-year, and refuses the band in between",
  "FGŚP age band 55–60: art. 9b ust. 2 splits the exemption the same way — the engine zeroes FGŚP above 60-by-year with FP/FS, and refuses the band in between",
  "FP/FS PUP-hire and return-from-leave exemptions (art. 104a, 104c): need a hiring/leave channel no pack carries — the engine prices the standard FP-liable employee",
  "PIT 120 000 zł crossing on uneven pay: art. 32 ust. 2 tests year-to-date income from this payer and no pack channel carries YTD — the engine annualises the month's dochód at monthly periodicity (exact for level pay) and refuses uneven paths",
  "Emerytalne/rentowe 234 720 zł crossing on uneven pay: same — the engine annualises the month's base (exact for level pay) and refuses uneven paths",
  "Ulga dla młodych (under-26 exemption): needs the art. 31a ust. 8 exemption-claim channel plus YTD against the 85 528 zł limit — refused by name for every employee who turns 26 or less in the tax year",
  "50 % koszty uzyskania (twórcy) and art. 22 ust. 9 flat amounts: the engine applies ust. 2 pkt 1/3 only — author-work KUP needs a contract-type channel",
  "Wspólne rozliczenie / samotny rodzic (art. 6 ust. 2, 4, 4d): the art. 32 ust. 3 joint-filing advance variants need the spouse/child income statement — refused by name",
  "PPK (pracownicze plany kapitałowe): opt-out and needs a participation channel — refused by name",
  "Umowa zlecenia / dzieło and other non-employment titles: different ZUS/PIT regimes (voluntary chorobowe, no KUP 250/300, ryczałt advances) — refused by name, never priced as employment",
  "Niepobieranie zaliczek (art. 31c zero-advance request) and 1/24–1/36 split pomniejszenia across payers (art. 31b ust. 5): need declaration channels beyond the single-payer certificate — refused by name",
  "Non-monthly periodicity: the pack prices monthly pay (12 periods) only",
];
