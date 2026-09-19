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

export const PL_CERTIFICATES: PayrollPackCertificates = {
  country: "PL",
  certificates: [PL_PIT2_CERTIFICATE],
};
