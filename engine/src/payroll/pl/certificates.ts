/**
 * The PL pack's employee certificate: the PIT-2 reduction statement and the
 * KUP variant — both employee-declared facts the monthly advance needs.
 *
 * PIT-2 ("Oświadczenie pracownika dla celów obliczania miesięcznych
 * zaliczek na podatek dochodowy od osób fizycznych", Ministerstwo
 * Finansów) carries the art. 31b oświadczenie o stosowaniu pomniejszenia:
 * whether the payer may reduce advances by 1/12, 1/24 or 1/36 of the
 * 3 600 zł kwota zmniejszająca — "nie więcej niż 1/12 kwoty zmniejszającej
 * podatek, jeżeli podatnik złoży temu płatnikowi oświadczenie
 * o stosowaniu pomniejszenia" (art. 31b ust. 1). Whether it was filed is a
 * CERTIFICATE ANSWER: the engine never assumes the 300 zł reduction.
 *
 * The KUP variant rides the same certificate for want of a better channel:
 * art. 22 ust. 2 pkt 1 (250 zł, same town) vs pkt 3 (300 zł, commute
 * without a separation allowance) turns on where the employee lives
 * relative to the workplace — an employee-stated residence fact, defaulted
 * to neither.
 */
import type {
  PayrollCertificate,
  PayrollPackCertificates,
} from "../certificates.ts";

const PL_PIT2_CERTIFICATE: PayrollCertificate = {
  key: "pl_pit2",
  form: "PIT-2",
  label:
    "Oświadczenie pracownika dla celów obliczania miesięcznych zaliczek na podatek dochodowy od osób fizycznych",
  scope: { level: "country" },
  purpose: "withholding",
  citation:
    "Ministerstwo Finansów, formularz PIT-2; art. 31b (oświadczenie "
    + "o stosowaniu pomniejszenia) i art. 22 ust. 2 pkt 1/3 (KUP) ustawy "
    + "o podatku dochodowym od osób fizycznych",
  summary:
    "Whether the employee filed the monthly-reduction statement and which KUP the payer deducts; the payer copies both answers, never computes them.",
  storage: "certificate_rows",
  fields: [
    {
      key: "pomniejszenie",
      label: "Stosowanie pomniejszenia zaliczki (art. 31b)",
      kind: "choice",
      choices: [
        { value: "1/12", label: "Pełne pomniejszenie — 1/12 kwoty (300 zł)" },
        { value: "1/24", label: "Połowa pomniejszenia — 1/24 kwoty (150 zł)" },
        { value: "1/36", label: "Trzecia część — 1/36 kwoty (100 zł)" },
        { value: "nie", label: "Oświadczenie nie złożone — bez pomniejszenia" },
      ],
      // No default, required: the 300 zł reduction applies only on a filed
      // statement, and an undeclared answer must not fall through to it.
      required: true,
      help: "Którą część kwoty zmniejszającej podatek płatnik stosuje co miesiąc. Bez złożonego oświadczenia nie stosuje żadnej.",
    },
    {
      key: "kup",
      label: "Koszty uzyskania przychodu (art. 22 ust. 2)",
      kind: "choice",
      choices: [
        { value: "miejscowy", label: "250 zł — jedna umowa, ta sama miejscowość" },
        { value: "dojazd", label: "300 zł — zamieszkanie poza miejscowością zakładu, bez dodatku za rozłąkę" },
      ],
      // No default, required: the two amounts differ and an undeclared
      // residence must not fall through to 250 zł.
      required: true,
      help: "Miesięczne koszty uzyskania z tytułu stosunku pracy. 300 zł tylko gdy miejsce zamieszkania leży poza miejscowością zakładu pracy i nie ma dodatku za rozłąkę.",
    },
  ],
};

/**
 * The payer-held birth year for the FP age bar and the under-26 refusal.
 *
 * This is NOT an employee-filed form — no PIT attachment carries it — so it
 * is declared as what it is: one payer-held fact with a verified origin.
 * The PESEL the pack already collects encodes the birth year in its first
 * six digits (ustawa o ewidencji ludności, art. 15 ust. 2: YYMMDD with the
 * century in the month digits — 01–12 → 1900s, 21–32 → 2000s, 81–92 →
 * 1800s; see `./pesel.ts`), so a filed PESEL derives and prefills this
 * field, while employees without a PESEL (foreign workers on NIP/passport)
 * are entered here directly. A saved value contradicting the PESEL refuses
 * at the profile API naming both — one source with a verified origin, never
 * two sources that disagree.
 *
 * Column-backed (`storage: "profile_columns"`), like the TD1/W-4 mappings:
 * the answer lives on `employee_payroll_profiles.pl_rok_urodzenia`, the
 * profile editor renders it from this declaration, and the engine reads it
 * off the profile row. The 1900–2026 band restates what calculatePlZus2026
 * enforces — never narrower, never wider.
 */
const PL_WIEK_CERTIFICATE: PayrollCertificate = {
  key: "pl_wiek",
  // Not a numbered form: there is no agency form behind this fact, so the
  // form names the declaration itself instead of inventing a code (the same
  // convention the JP 扶養控除等申告書 declaration states).
  form: "Rok urodzenia",
  label: "Birth year (rok urodzenia) — PESEL-derived with a declared fallback",
  scope: { level: "country" },
  purpose: "withholding",
  citation:
    "ustawa o ewidencji ludności, art. 15 ust. 2 (Dz.U. 2018 poz. 1382: century in the PESEL month "
    + "digits); updof FP/FS age bar (art. 261) and the under-26 refusal, which cannot be decided "
    + "without the year",
  summary:
    "The employee's birth year for the FP age bar. Derived from the PESEL on file where one "
    + "exists; entered here for employees without one. A value contradicting the PESEL refuses.",
  storage: "profile_columns",
  fields: [
    {
      key: "rok_urodzenia",
      label: "Birth year (rok urodzenia)",
      kind: "count",
      min: "1900",
      max: "2026",
      storage: { kind: "column", column: "pl_rok_urodzenia" },
      // Required: the engine prices no PL employee without it — but an
      // UNANSWERED profile still saves, so readiness names the gap before
      // calculation rather than the save refusing an incomplete setup.
      required: true,
      help: "Four-digit birth year. Prefilled from the employee's PESEL where one is on file "
        + "(first six digits YYMMDD, century in the month digits); enter it directly for "
        + "employees without a PESEL. A year contradicting the PESEL refuses on save.",
    },
  ],
};

export const PL_CERTIFICATES: PayrollPackCertificates = {
  country: "PL",
  certificates: [PL_PIT2_CERTIFICATE, PL_WIEK_CERTIFICATE],
};
