/**
 * BR employer facts: the establishment facts the pack's statutory engine
 * reads, DECLARED with kind, bounds and refusal reason.
 *
 * One source, two readers: `./pack.ts` states it as the pack's
 * `employerFacts` declaration (registered centrally by packs.ts), and the
 * compute path resolves stored values through `resolveStoredEmployerFact`,
 * which validates against this declaration. See `../employer-facts.ts`
 * for the shape.
 */
import type { PayrollEmployerFact } from "../employer-facts.ts";

/**
 * The establishment's tax regime decides whether employer CPP is a
 * separate payroll accrual: LC 123/2006 art. 13 VI folds the Lei 8.212
 * art. 22 CPP into the Simples monthly DAS, EXCEPT Annex IV service
 * businesses (art. 18 §5-C), which pay it separately like general-regime
 * employers. Terceiros (Sistema S / salário-educação) are outside DAS for
 * every Simples annex — only general-regime employers accrue them here.
 * MEI employer CPP (a different rate) is not a choice: an MEI
 * establishment cannot honestly declare any value below and the run
 * refuses naming the valid options.
 */
export const BR_REGIME_TRIBUTARIO_CHOICES = [
  "simples_1",
  "simples_2",
  "simples_3",
  "simples_4",
  "simples_5",
  "geral",
] as const;

export type BrRegimeTributario = (typeof BR_REGIME_TRIBUTARIO_CHOICES)[number];

/** Regimes whose employer CPP is folded into the Simples DAS (no separate accrual). */
export const BR_CPP_IN_DAS: ReadonlySet<string> = new Set([
  "simples_1",
  "simples_2",
  "simples_3",
  "simples_5",
]);

export const BR_EMPLOYER_FACTS: readonly PayrollEmployerFact[] = [
  {
    key: "br_regime_tributario",
    kind: "choice",
    label: "Regime tributário do estabelecimento (Simples Nacional / geral)",
    refusalReason:
      "Simples Nacional annexes I, II, III and V pay employer CPP inside the monthly DAS (LC 123/2006 art. 13 VI) "
      + "while Annex IV and general-regime employers accrue it separately (art. 18 §5-C) — pricing without the "
      + "regime charges a 20% CPP the establishment never owes, or omits one it does.",
    legalBasis: "Lei Complementar nº 123/2006, art. 13 VI and art. 18 §5-C",
    required: true,
    effectivePeriod: "calendar_year",
    choices: [
      { value: "simples_1", label: "Simples Nacional – Anexo I (comércio)" },
      { value: "simples_2", label: "Simples Nacional – Anexo II (indústria)" },
      { value: "simples_3", label: "Simples Nacional – Anexo III (serviços)" },
      { value: "simples_4", label: "Simples Nacional – Anexo IV (serviços, CPP em separado)" },
      { value: "simples_5", label: "Simples Nacional – Anexo V (serviços)" },
      { value: "geral", label: "Regime geral (lucro real/presumido — CPP em separado)" },
    ],
  },
];
