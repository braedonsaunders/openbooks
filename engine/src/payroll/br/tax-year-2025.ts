/**
 * Brasil 2025 — the transcribed statutory tables (monthly CLT scope).
 *
 * Operative instruments (quoted below, translated after each quote):
 *
 * - INSS employee contribution: Portaria Interministerial MPS/MF nº 6, de 10
 *   de janeiro de 2025, ANEXO II — "TABELA DE CONTRIBUIÇÃO DOS SEGURADOS
 *   EMPREGADO, EMPREGADO DOMÉSTICO E TRABALHADOR AVULSO, PARA PAGAMENTO DE
 *   REMUNERAÇÃO A PARTIR DE 1º DE JANEIRO DE 2025" / "CONTRIBUTION TABLE FOR
 *   EMPLOYEE, DOMESTIC AND CASUAL-WORKER INSUREDS, FOR REMUNERATION PAID FROM
 *   1 JANUARY 2025". Quoted from the certified DOU text (DOU 13/1/2025) via
 *   the Wayback Machine, because in.gov.br was unreachable from the
 *   transcribing machine (HTTP 000 — connection failure). Single table for
 *   the whole year: the portaria reprices every January.
 * - IRRF January–April: Lei nº 14.848/2024, art. 1º, item XI — "a partir do
 *   mês de fevereiro do ano-calendário de 2024 até o mês de abril do
 *   ano-calendário de 2025" / "from February of calendar year 2024 through
 *   April of calendar year 2025" (wording set by MP nº 1.294/2025, kept
 *   verbatim by its conversion law). Quoted from planalto.gov.br.
 * - IRRF May–December: Lei nº 15.191/2025, art. 2º, item XII — "a partir do
 *   mês de maio do ano-calendário de 2025" / "from May of calendar year
 *   2025" (conversion of MP nº 1.294/2025, same figures). Quoted from
 *   planalto.gov.br.
 * - Monthly deductions: R$ 189,59 per dependent, and the simplified monthly
 *   discount of 25% of the zero-rate band ceiling (Lei 14.663/2023, art. 6º,
 *   §2º of art. 4º of Lei 9.250/1995). Both figures confirmed on Receita
 *   Federal's official 2025 tabelas page ("De janeiro a abril de 2025 …
 *   desconto simplificado R$ 564,80"; "A partir de maio de 2025 … R$ 607,20"),
 *   via the Wayback Machine because www.gov.br denies non-browser clients
 *   (HTTP 403).
 *
 * No monthly reduction existed in 2025: the art. 3º-A reduction of Lei
 * 9.250/1995 (Lei nº 15.270/2025) produces effects "a partir de 1º de
 * janeiro de 2026" only.
 *
 * Money: BRL has centavos. Every monetary result is truncated (fractions of
 * a centavo dropped) after exact rational arithmetic — the eSocial per-slice
 * rule the 2026 module documents (see BR_2026_ROUNDING). All figures below
 * are decimal strings, never floats.
 */

/** Calendar 2025: two IRRF editions (Jan–Apr vs May–Dec), one INSS table. */
export const BR_TRANSCRIBED_YEAR_2025 = 2025;

/**
 * INSS 2025 — Anexo II of Portaria Interministerial MPS/MF nº 6/2025.
 * Upper bound of each salary-de-contribuição slice (inclusive) and its rate
 * as an exact percent string. The last bound is the teto.
 */
export const BR_2025_INSS_BRACKETS = [
  { upTo: "1518.00", rate: "7.5" },
  { upTo: "2793.88", rate: "9" },
  { upTo: "4190.83", rate: "12" },
  { upTo: "8157.41", rate: "14" },
] as const;

/** The 2025 teto: no slice above R$ 8.157,41 (Portaria 6/2025, art. 2º). */
export const BR_2025_INSS_TETO = "8157.41";

/** Salário mínimo from 1 January 2025 (Decreto nº 12.342/2024, art. 1º). */
export const BR_2025_SALARIO_MINIMO = "1518.00";

/**
 * IRRF January–April 2025 — Tabela Progressiva Mensal (Lei 14.848/2024
 * art. 1º, item XI: the same figures as Feb–Dec 2024).
 */
export const BR_2025_IRRF_EARLY = {
  /** "Lei 14.848/2024 item XI (Jan–Apr 2025)". */
  label: "2025-01/04 (Lei 14.848/2024 item XI)",
  bands: [
    { upTo: "2259.20", rate: "0", deduct: "0" },
    { upTo: "2826.65", rate: "7.5", deduct: "169.44" },
    { upTo: "3751.05", rate: "15", deduct: "381.44" },
    { upTo: "4664.68", rate: "22.5", deduct: "662.77" },
    { upTo: null, rate: "27.5", deduct: "896.00" },
  ],
  /**
   * Desconto simplificado mensal: 25% × 2.259,20 = 564,80
   * (RFB official 2025 tabelas page).
   */
  simplificado: "564.80",
} as const;

/**
 * IRRF May–December 2025 — Tabela Progressiva Mensal (Lei 15.191/2025
 * art. 2º, item XII).
 */
export const BR_2025_IRRF_LATE = {
  /** "Lei 15.191/2025 item XII (May–Dec 2025)". */
  label: "2025-05/12 (Lei 15.191/2025 item XII)",
  bands: [
    { upTo: "2428.80", rate: "0", deduct: "0" },
    { upTo: "2826.65", rate: "7.5", deduct: "182.16" },
    { upTo: "3751.05", rate: "15", deduct: "394.16" },
    { upTo: "4664.68", rate: "22.5", deduct: "675.49" },
    { upTo: null, rate: "27.5", deduct: "908.73" },
  ],
  /**
   * Desconto simplificado mensal: 25% × 2.428,80 = 607,20
   * (RFB official 2025 tabelas page).
   */
  simplificado: "607.20",
} as const;

/**
 * Dedução mensal por dependente (RFB official 2025 tabelas page prints
 * R$ 189,59 for both monthly ranges; annual table prints R$ 2.275,08 =
 * 12 × 189,59).
 */
export const BR_2025_DEPENDENTE = "189.59";

/** Employer INSS patronal: 20% on total remuneration, no teto (Lei 8.212/1991, art. 22, I). */
export const BR_2025_PATRONAL = "20";

/** FGTS: 8% of remuneration, deposited to the worker's account — employer cost, never withheld (Lei 8.036/1990, art. 15). */
export const BR_2025_FGTS = "8";

/** Edition stamps for BR_TAX_YEARS. */
export const BR_2025_EDITION_LABEL_EARLY =
  "Portaria Interministerial MPS/MF nº 6/2025 (INSS) + Lei 14.848/2024 art. 1º item XI (IRRF jan-apr)";
export const BR_2025_EDITION_LABEL_LATE =
  "Portaria Interministerial MPS/MF nº 6/2025 (INSS) + Lei 15.191/2025 art. 2º item XII (IRRF may-dec)";

/**
 * Named refusals for 2025 — the boundary of the transcription, in the
 * BR_REFUSED_2026 shape. Each names the feature and the datum or instrument
 * the pack does not carry.
 */
export const BR_REFUSED_2025: readonly string[] = [
  "13º salário (gratificação natalina, Lei 4.090/1962): exclusive-source withholding with its own INSS teto accounting — not modelled; monthly pay only",
  "férias + 1/3 constitucional (CF art. 7º, XVII): separate base, accrual and IRRF timing — not modelled",
  "rescisão / termination payments (CLT art. 477; aviso prévio, multa de 40% do FGTS, seguro-desemprego): not modelled",
  "salário-família (cota R$ 65,00 for remuneration ≤ R$ 1.906,04, Portaria 6/2025 art. 4º): needs children count/ages the pack does not carry — not modelled",
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
