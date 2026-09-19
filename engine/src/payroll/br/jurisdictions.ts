/**
 * The BR pack's holiday calendar: the national feriados.
 *
 * Lei nº 662/1949 (as amended by Lei nº 6.802/1980), art. 1º: the civil
 * national holidays are 1 January, 21 April (Tiradentes), 1 May, 7
 * September, 2 November, 15 November and 25 December, plus Good Friday
 * ("Sexta-Feira da Paixão", movable) and Corpus Christi — the latter kept
 * out: it is a ponto facultativo federally, not a national feriado, and
 * declaring it would pay a day nobody owes. State/municipal feriados
 * (Consciência Negra where not national, city anniversaries, Carnaval) are
 * untranscribed — see the ledger.
 *
 * `observance: "none"`: a feriado falling on a weekend does not move.
 * `holidayPay` is null: the CLT holiday-pay formula for monthly employees
 * (paid rest is embedded in the monthly salary) has no lookback to
 * transcribe — and férias pay is a named refusal. Null refuses until a
 * sourced formula lands.
 */
import type { PayrollJurisdiction } from "../packs.ts";

export const BR_JURISDICTIONS: readonly PayrollJurisdiction[] = [
  {
    key: "BR",
    name: "Brasil (feriados nacionais)",
    scope: "employment",
    citation:
      "Lei nº 662, de 6/4/1949, art. 1º (redação Lei nº 6.802/1980); CLT art. 70",
    holidays: [
      { key: "confraternizacao", name: "Confraternização Universal", rule: { kind: "fixed", month: 1, day: 1 }, observance: "none" },
      { key: "paixao", name: "Paixão de Cristo", rule: { kind: "easter_offset", days: -2 }, observance: "none" },
      { key: "tiradentes", name: "Tiradentes", rule: { kind: "fixed", month: 4, day: 21 }, observance: "none" },
      { key: "trabalho", name: "Dia do Trabalho", rule: { kind: "fixed", month: 5, day: 1 }, observance: "none" },
      { key: "independencia", name: "Independência do Brasil", rule: { kind: "fixed", month: 9, day: 7 }, observance: "none" },
      { key: "aparecida", name: "Nossa Senhora Aparecida", rule: { kind: "fixed", month: 10, day: 12 }, observance: "none" },
      { key: "finados", name: "Finados", rule: { kind: "fixed", month: 11, day: 2 }, observance: "none" },
      { key: "republica", name: "Proclamação da República", rule: { kind: "fixed", month: 11, day: 15 }, observance: "none" },
      { key: "natal", name: "Natal", rule: { kind: "fixed", month: 12, day: 25 }, observance: "none" },
    ],
    holidayPay: null,
  },
];
