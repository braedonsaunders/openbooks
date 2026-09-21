/**
 * DE settlement employee facts: the `emp` keys the Lohnsteuer-Jahresausgleich
 * (§42b EStG) reads, DECLARED with kind, producer and refusal reason.
 *
 * These facts attest what the December certificates and the committed stubs
 * cannot show: continuous employment through the Ausgleichsjahr, constancy
 * of class and Betriebsstätte, and the absence of every statutory exclusion.
 * The monthly engine reads none of them, so all three are `required: false`
 * (absent is an accepted answer every month of the year) with an honest
 * `none` producer (no profile surface collects them yet) — and the
 * settlement refuses by name for the employee missing or denying any of
 * them. An assumed "yes" would be a silently wrong refund, and a
 * `required: true` here would make the pack unpayable (packPayableProblem),
 * blocking the monthly payroll the settlement is meant to supplement.
 *
 * One source, two readers: `./pack.ts` states these as the pack's
 * `employeeFacts` declaration, and `./annual-settlement.ts` imports this
 * module so every read registers before it can run. See
 * `../employee-facts.ts` for the shape and the derivation of `payable`.
 */
import { registerEmployeeFacts } from "../employee-facts.ts";
import type { PayrollEmployeeFact } from "../employee-facts.ts";

export const DE_AUSGLEICH_GANZJAEHRIG = "de_ausgleich_ganzjaehrig";
export const DE_AUSGLEICH_UNVERAENDERT = "de_ausgleich_unveraendert";
export const DE_AUSGLEICH_KEIN_AUSSCHLUSS = "de_ausgleich_kein_ausschluss";

export const DE_EMPLOYEE_FACTS: readonly PayrollEmployeeFact[] = [
  {
    key: DE_AUSGLEICH_GANZJAEHRIG,
    kind: "flag",
    label: "Ganzjähriges Dienstverhältnis (Lohnsteuer-Jahresausgleich)",
    refusalReason:
      "§42b Abs. 1 Satz 1 EStG entitles the employer to the Jahresausgleich only for "
      + "employees who stood in the employment relationship continuously through the whole "
      + "Ausgleichsjahr and are unbeschränkt einkommensteuerpflichtig — a mid-year joiner, "
      + "leaver, or beschränkt Steuerpflichtiger settles through assessment, never through "
      + "this settlement.",
    required: false,
    producer: {
      kind: "none",
      notes:
        "Attested from the employer's HR records (entry/exit dates, residence for §1 EStG); "
        + "no profile surface collects it yet, so the settlement refuses until it is declared.",
    },
  },
  {
    key: DE_AUSGLEICH_UNVERAENDERT,
    kind: "flag",
    label: "Unveränderte Steuerklasse und Betriebsstätte (Lohnsteuer-Jahresausgleich)",
    refusalReason:
      "§42b Abs. 1 Satz 3 Nr. 2–3 EStG bars the Ausgleich whenever the employee was taxed "
      + "under class V or VI for any part of the year or under class II, III or IV for part "
      + "of it — the class must have been constant all year (the December ELStAM class alone "
      + "cannot show that). The Beschäftigungsland must likewise have been constant: the "
      + "Sachsen PV split (§58 Abs. 3 und 5 SGB XI) and the 8%-in-BY/BW-versus-9% "
      + "Kirchenlohnsteuer rate key off it, and the annual recomputation prices one rate.",
    required: false,
    producer: {
      kind: "none",
      notes:
        "Attested from the ELStAM retrieval history and the Betriebsstätten record; no profile "
        + "surface collects it yet, so the settlement refuses until it is declared.",
    },
  },
  {
    key: DE_AUSGLEICH_KEIN_AUSSCHLUSS,
    kind: "flag",
    label: "Kein Ausschlussgrund (Lohnsteuer-Jahresausgleich)",
    refusalReason:
      "§42b Abs. 1 Satz 3 Nr. 1, 4, 4a, 5, 5a und 6 EStG bar the Ausgleich on employee "
      + "objection, wage-replacement benefits (Kurzarbeitergeld and the listed equivalents), "
      + "Großbuchstabe U, any mid-year change in the Vorsorgepauschale inputs "
      + "(Krankenkasse Zusatzbeitragssatz, Pflege-Abschläge), and foreign employment income "
      + "without domestic withholding — and the engine prices laufenden Arbeitslohn only, so "
      + "sonstige Bezüge, Versorgungsbezüge and the Altersentlastungsbetrag (PAP paths this "
      + "pack does not transcribe) likewise exclude the employee from this settlement.",
    required: false,
    producer: {
      kind: "none",
      notes:
        "Attested from the Lohnkonto, the benefit records and the pay history; no profile "
        + "surface collects it yet, so the settlement refuses until it is declared.",
    },
  },
];

registerEmployeeFacts("DE", DE_EMPLOYEE_FACTS);
