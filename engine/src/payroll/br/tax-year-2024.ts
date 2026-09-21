/**
 * Brasil 2024 — the transcribed statutory tables (monthly CLT scope).
 *
 * Operative instruments (quoted below, translated after each quote):
 *
 * - INSS employee contribution: Portaria Interministerial MPS/MF nº 2, de 11
 *   de janeiro de 2024, ANEXO II — "TABELA DE CONTRIBUIÇÃO DOS SEGURADOS
 *   EMPREGADO, EMPREGADO DOMÉSTICO E TRABALHADOR AVULSO, PARA PAGAMENTO DE
 *   REMUNERAÇÃO A PARTIR DE 1º DE JANEIRO DE 2024" / "CONTRIBUTION TABLE FOR
 *   EMPLOYEE, DOMESTIC AND CASUAL-WORKER INSUREDS, FOR REMUNERATION PAID FROM
 *   1 JANUARY 2024". Quoted from the certified DOU text (DOU 12/1/2024) via
 *   the Wayback Machine, because in.gov.br was unreachable from the
 *   transcribing machine (HTTP 000 — connection failure). Single table for
 *   the whole year: the portaria reprices every January.
 * - IRRF January: Lei nº 14.663/2023, art. 5º, item X — "a partir do mês de
 *   maio do ano-calendário de 2023" / "from May of calendar year 2023", in
 *   force through January 2024 per Lei 14.848/2024 ("até o mês de janeiro do
 *   ano-calendário de 2024"). Quoted from planalto.gov.br.
 * - IRRF February–December: Lei nº 14.848/2024, art. 1º, item XI —
 *   "a partir do mês de fevereiro do ano-calendário de 2024" / "from February
 *   of calendar year 2024" (converting MP nº 1.206/2024, same figures).
 *   Quoted from planalto.gov.br.
 * - Monthly deductions: R$ 189,59 per dependent, and the simplified monthly
 *   discount of 25% of the zero-rate band ceiling (Lei 14.663/2023, art. 6º,
 *   adding §2º to art. 4º of Lei 9.250/1995: "caso seja mais benéfico ao
 *   contribuinte" / "where more beneficial to the taxpayer"). Both figures
 *   confirmed on Receita Federal's official 2024 tabelas page
 *   ("De maio de 2023 a janeiro de 2024 … desconto simplificado R$ 528,00";
 *   "A partir de fevereiro de 2024 … R$ 564,80"), via the Wayback Machine
 *   because www.gov.br denies non-browser clients (HTTP 403).
 *
 * No monthly reduction existed in 2024: the art. 3º-A reduction of Lei
 * 9.250/1995 (Lei nº 15.270/2025) produces effects "a partir de 1º de
 * janeiro de 2026" only.
 *
 * Money: BRL has centavos. Every monetary result is truncated (fractions of
 * a centavo dropped) after exact rational arithmetic — the eSocial per-slice
 * rule the 2026 module documents (see BR_2026_ROUNDING). All figures below
 * are decimal strings, never floats.
 */

/** Calendar 2024: two IRRF editions (January vs February–December), one INSS table. */
export const BR_TRANSCRIBED_YEAR_2024 = 2024;

/**
 * INSS 2024 — Anexo II of Portaria Interministerial MPS/MF nº 2/2024.
 * Upper bound of each salary-de-contribuição slice (inclusive) and its rate
 * as an exact percent string. The last bound is the teto.
 */
export const BR_2024_INSS_BRACKETS = [
  { upTo: "1412.00", rate: "7.5" },
  { upTo: "2666.68", rate: "9" },
  { upTo: "4000.03", rate: "12" },
  { upTo: "7786.02", rate: "14" },
] as const;

/** The 2024 teto: no slice above R$ 7.786,02 (Portaria 2/2024, art. 2º). */
export const BR_2024_INSS_TETO = "7786.02";

/** Salário mínimo from 1 January 2024 (Decreto nº 11.864/2023, art. 1º). */
export const BR_2024_SALARIO_MINIMO = "1412.00";

/**
 * IRRF January 2024 — Tabela Progressiva Mensal (Lei 14.663/2023 art. 5º,
 * item X). Upper bound of each base-de-cálculo band (inclusive), rate as an
 * exact percent string, and the published parcela a deduzir.
 */
export const BR_2024_IRRF_JAN = {
  /** "Lei 14.663/2023 item X (May 2023–Jan 2024)". */
  label: "2024-01 (Lei 14.663/2023 item X)",
  bands: [
    { upTo: "2112.00", rate: "0", deduct: "0" },
    { upTo: "2826.65", rate: "7.5", deduct: "158.40" },
    { upTo: "3751.05", rate: "15", deduct: "370.40" },
    { upTo: "4664.68", rate: "22.5", deduct: "651.73" },
    { upTo: null, rate: "27.5", deduct: "884.96" },
  ],
  /**
   * Desconto simplificado mensal: 25% of the zero-rate band ceiling —
   * 25% × 2.112,00 = 528,00 (RFB official 2024 tabelas page).
   */
  simplificado: "528.00",
} as const;

/**
 * IRRF February–December 2024 — Tabela Progressiva Mensal
 * (Lei 14.848/2024 art. 1º, item XI).
 */
export const BR_2024_IRRF_FEB = {
  /** "Lei 14.848/2024 item XI (Feb–Dec 2024)". */
  label: "2024-02/12 (Lei 14.848/2024 item XI)",
  bands: [
    { upTo: "2259.20", rate: "0", deduct: "0" },
    { upTo: "2826.65", rate: "7.5", deduct: "169.44" },
    { upTo: "3751.05", rate: "15", deduct: "381.44" },
    { upTo: "4664.68", rate: "22.5", deduct: "662.77" },
    { upTo: null, rate: "27.5", deduct: "896.00" },
  ],
  /**
   * Desconto simplificado mensal: 25% × 2.259,20 = 564,80
   * (RFB official 2024 tabelas page).
   */
  simplificado: "564.80",
} as const;

/**
 * Dedução mensal por dependente (RFB official 2024 tabelas page prints
 * R$ 189,59 for both monthly ranges; annual table prints R$ 2.275,08 =
 * 12 × 189,59).
 */
export const BR_2024_DEPENDENTE = "189.59";

/** Employer INSS patronal: 20% on total remuneration, no teto (Lei 8.212/1991, art. 22, I). */
export const BR_2024_PATRONAL = "20";

/** FGTS: 8% of remuneration, deposited to the worker's account — employer cost, never withheld (Lei 8.036/1990, art. 15). */
export const BR_2024_FGTS = "8";

/** Edition stamps for BR_TAX_YEARS. */
export const BR_2024_EDITION_LABEL_JAN =
  "Portaria Interministerial MPS/MF nº 2/2024 (INSS) + Lei 14.663/2023 art. 5º item X (IRRF jan)";
export const BR_2024_EDITION_LABEL_FEB =
  "Portaria Interministerial MPS/MF nº 2/2024 (INSS) + Lei 14.848/2024 art. 1º item XI (IRRF feb-dec)";

/**
 * Named refusals for 2024 — the boundary of the transcription, in the
 * BR_REFUSED_2026 shape. Each names the feature and the datum or instrument
 * the pack does not carry.
 */
export const BR_REFUSED_2024: readonly string[] = [
  "13º salário (gratificação natalina, Lei 4.090/1962): exclusive-source withholding with its own INSS teto accounting — not modelled; monthly pay only",
  "férias + 1/3 constitucional (CF art. 7º, XVII): separate base, accrual and IRRF timing — not modelled",
  "rescisão / termination payments (CLT art. 477; aviso prévio, multa de 40% do FGTS, seguro-desemprego): not modelled",
  "salário-família (cota R$ 62,04 for remuneration ≤ R$ 1.819,26, Portaria 2/2024 art. 4º): needs children count/ages the pack does not carry — not modelled",
  "salário-maternidade, auxílio-doença and other benefit offsets compensated through payroll: not modelled",
  "RAT/terceiros/FAP without tenant-declared values (br_rat, br_fap, br_terceiros slots): the CNAE risk class and accident history are unknowable to the pack — refused at lookup, never table-supplied",
  "regimes other than standard monthly CLT (aprendiz with 2% FGTS, doméstico, temporário, intermitente, horista/diarista, obra certa): refused via br_regime",
  "contribuinte individual / autônomo / MEI / segurado facultativo contribution rules: employee-only pack, CLT only",
  "non-resident 25% exclusive withholding and double-taxation treaty relief: not modelled",
  "annual adjustment (declaração de ajuste anual, educação deduction R$ 3.561,50): the engine withholds monthly only",
  "INSS multi-employment teto aggregation (simultaneous employments sharing one teto): needs other-employer pay the pack cannot see",
  "stock options / PLR (participação nos lucros) exclusive-source taxation: not modelled",
  "vale-transporte 6% employee share, union dues (contribuição assistencial), consignado loan deductions: contractual/consensual deductions, not statutory",
];
