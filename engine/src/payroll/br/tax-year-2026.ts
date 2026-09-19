/**
 * Brasil 2026 — the transcribed statutory tables (monthly CLT scope).
 *
 * Operative instruments (quoted below, translated after each quote):
 *
 * - INSS employee contribution: Portaria Interministerial MPS/MF nº 13, de 9
 *   de janeiro de 2026, ANEXO I — "TABELA DE CONTRIBUIÇÃO DOS SEGURADOS
 *   EMPREGADO, EMPREGADO DOMÉSTICO E TRABALHADOR AVULSO, PARA PAGAMENTO DE
 *   REMUNERAÇÃO A PARTIR DE 1º DE JANEIRO DE 2026" / "CONTRIBUTION TABLE FOR
 *   EMPLOYEE, DOMESTIC AND CASUAL-WORKER INSUREDS, FOR REMUNERATION PAID FROM
 *   1 JANUARY 2026". The brackets below are that Anexo I verbatim. The
 *   progressive application ("faixa a faixa") is the EC 103/2019 methodology
 *   the portaria applies every January; the per-slice truncation is the
 *   eSocial operational rule (see BR_2026_ROUNDING).
 * - IRRF monthly table: Lei nº 11.482/2007, art. 1º, XII, in the wording in
 *   force since MP nº 1.294/2025 (May 2025) — "a partir do mês de maio do
 *   ano-calendário de 2025" / "from May of calendar year 2025". Quoted from
 *   the Federal Senate's legislative record (legis.senado.leg.br), because
 *   planalto.gov.br and in.gov.br (DOU) were unreachable from the
 *   transcribing machine (both HTTP 000 — connection failure, 0 bytes; DOU
 *   search the same). The figures are additionally confirmed by Receita
 *   Federal's 2026 materials (IRPF simulator, 2026 presentation) and three
 *   independent reproductions that agree to the centavo.
 * - IRRF monthly reduction: Lei nº 15.270/2025, art. 3º-A of Lei 9.250/1995,
 *   producing effects "a partir de 1º de janeiro de 2026" / "from 1 January
 *   2026" (DOU 27/11/2025, Edição 226, Seção 1, Página 3). Quoted verbatim
 *   from the certified DOU text.
 * - Monthly deductions: Lei nº 9.250/1995, art. 4º (INSS contributions; R$
 *   189,59 per dependent) and art. 10 (simplified monthly discount of 25% of
 *   the zero-rate band ceiling, "caso seja mais benéfico ao contribuinte" /
 *   "where more beneficial to the taxpayer", in the MP 1.171/2023 wording).
 *
 * Money: BRL has centavos. Every monetary result is truncated (fractions of
 * a centavo dropped) after exact rational arithmetic — see BR_2026_ROUNDING.
 * All figures below are decimal strings, never floats.
 */

/** Calendar 2026, the only transcribed year. */
export const BR_TRANSCRIBED_YEAR = 2026;

/**
 * INSS 2026 — Anexo I of Portaria Interministerial MPS/MF nº 13/2026.
 * Upper bound of each salary-de-contribuição slice (inclusive) and its rate
 * as an exact percent string. The last bound is the teto.
 */
export const BR_2026_INSS_BRACKETS = [
  { upTo: "1621.00", rate: "7.5" },
  { upTo: "2902.84", rate: "9" },
  { upTo: "4354.27", rate: "12" },
  { upTo: "8475.55", rate: "14" },
] as const;

/** The 2026 teto: no slice above R$ 8.475,55. */
export const BR_2026_INSS_TETO = "8475.55";

/** Salário mínimo from 1 January 2026 (Decreto nº 12.797/2025). */
export const BR_2026_SALARIO_MINIMO = "1621.00";

/**
 * IRRF 2026 — Tabela Progressiva Mensal (Lei 11.482/2007 art. 1º XII, MP
 * 1.294/2025). Upper bound of each base-de-cálculo band (inclusive), rate as
 * an exact percent string, and the published parcela a deduzir.
 *
 * Cross-verification against cumulative bracket arithmetic (exact, then
 * truncated to cents): 2.428,80 × 7,5% = 182,16 ✓; 2.826,65 × 7,5% + 182,16
 * = 394,15875 → 394,16 ✓; 3.751,05 × 7,5% + 394,16 = 675,48875 → 675,49 ✓;
 * 4.664,68 × 5% + 675,49 = 908,724 → published 908,73, ONE centavo above the
 * truncated derivation. Transcription wins over derivation: the published
 * 908,73 is the law. (Continuity is unaffected — both bands price R$
 * 4.664,68 at R$ 374,06 after cent truncation.)
 */
export const BR_2026_IRRF_BANDS = [
  { upTo: "2428.80", rate: "0", deduct: "0" },
  { upTo: "2826.65", rate: "7.5", deduct: "182.16" },
  { upTo: "3751.05", rate: "15", deduct: "394.16" },
  { upTo: "4664.68", rate: "22.5", deduct: "675.49" },
  { upTo: null, rate: "27.5", deduct: "908.73" },
] as const;

/** Dedução mensal por dependente (Lei 9.250/1995, art. 4º). */
export const BR_2026_DEPENDENTE = "189.59";

/**
 * Desconto simplificado mensal: 25% of the zero-rate band ceiling
 * (Lei 9.250/1995, art. 10) — 25% × 2.428,80 = 607,20. Applied when more
 * beneficial than the legal deductions ("caso seja mais benéfico"), which
 * the paying source must assess every month.
 */
export const BR_2026_DESCONTO_SIMPLIFICADO = "607.20";

/**
 * IRRF monthly reduction (Lei 15.270/2025, art. 3º-A of Lei 9.250/1995),
 * keyed on the month's gross rendimentos tributáveis:
 * - gross ≤ 5.000,00 → the computed tax, capped at 312,89;
 * - 5.000,00 < gross ≤ 7.350,00 → 978,62 − 0,133145 × gross, capped at tax;
 * - gross > 7.350,00 → no reduction.
 * The result never goes below zero (§1º caps the reduction at the computed
 * tax; §2º removes it above R$ 7.350,00).
 */
export const BR_2026_REDUCAO = {
  /** First-band ceiling (inclusive) and its cap. */
  faixaIsencao: "5000.00",
  faixaIsencaoCap: "312.89",
  /** Transition-band ceiling (inclusive); the exact zero of the formula. */
  faixaTransicao: "7350.00",
  base: "978.62",
  /** 0,133145 as an exact rational numerator/denominator. */
  coeficienteNum: 133145n,
  coeficienteDen: 1000000n,
} as const;

/** Employer INSS patronal: 20% on total remuneration, no teto (Lei 8.212/1991, art. 22, I). */
export const BR_2026_PATRONAL = "20";

/** FGTS: 8% of remuneration, deposited to the worker's account — employer cost, never withheld (Lei 8.036/1990, art. 15). */
export const BR_2026_FGTS = "8";

/**
 * Rounding — truncation, uniformly.
 *
 * The eSocial operational rule for the segurado contribution: calculations
 * in each bracket truncate after the second decimal place ("Os cálculos em
 * cada faixa devem ser realizados mediante o truncamento após a segunda casa
 * decimal" / "Calculations in each bracket are done by truncating after the
 * second decimal place"). The pack applies the same rule to every monetary
 * intermediate (INSS slices, IRRF tax, reduction formula), so the stub ties
 * to eSocial/DCTFWeb to the centavo.
 *
 * The law's own figures agree: at R$ 5.000,00 the exact reduction is
 * 978,62 − 0,133145 × 5000 = 312,895 and the printed cap is "até R$
 * 312,89" — truncated, not half-up (which would print 312,90).
 */
export const BR_2026_ROUNDING = "truncate-to-cent" as const;

/** Edition stamp for BR_TAX_YEARS. */
export const BR_2026_EDITION_LABEL =
  "Portaria Interministerial MPS/MF nº 13/2026 (INSS) + Lei 11.482/2007 art. 1º XII / MP 1.294/2025 (IRRF mensal) + Lei 15.270/2025 art. 3º-A (redução mensal)";

/**
 * Named refusals for 2026 — the boundary of round one, in the IT_REFUSED
 * precedent's shape. Each names the feature and the datum or instrument the
 * pack does not carry, so the next person knows exactly what is missing.
 */
export const BR_REFUSED_2026: readonly string[] = [
  "13º salário (gratificação natalina, Lei 4.090/1962): exclusive-source withholding with the art. 3º-A reduction (Lei 15.270/2025 §3º) and its own INSS teto accounting — not modelled; monthly pay only",
  "férias + 1/3 constitucional (CF art. 7º, XVII): separate base, accrual and IRRF timing — not modelled",
  "rescisão / termination payments (CLT art. 477; aviso prévio, multa de 40% do FGTS, seguro-desemprego): not modelled",
  "salário-família (cota R$ 67,54 for remuneration ≤ R$ 1.980,38, Portaria 13/2026): needs children count/ages the pack does not carry — not modelled",
  "salário-maternidade, auxílio-doença and other benefit offsets compensated through payroll: not modelled",
  "RAT/terceiros/FAP without tenant-declared values (br_rat, br_fap, br_terceiros slots): the CNAE risk class and accident history are unknowable to the pack — refused at lookup, never table-supplied",
  "regimes other than standard monthly CLT (aprendiz with 2% FGTS, doméstico, temporário, intermitente, horista/diarista, obra certa): refused via br_regime",
  "contribuinte individual / autônomo / MEI / segurado facultativo contribution rules: employee-only pack, CLT only",
  "non-resident 25% exclusive withholding and double-taxation treaty relief: not modelled",
  "annual adjustment (declaração de ajuste anual, art. 11-A reduction, tributação mínima art. 16-A, educação deduction R$ 3.561,50): the engine withholds monthly only",
  "INSS multi-employment teto aggregation (simultaneous employments sharing one teto): needs other-employer pay the pack cannot see",
  "stock options / PLR (participação nos lucros) exclusive-source taxation: not modelled",
  "vale-transporte 6% employee share, union dues (contribuição assistencial), consignado loan deductions: contractual/consensual deductions, not statutory",
];
