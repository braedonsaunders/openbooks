/**
 * IRRF 2026 — pure monthly withholding calculator.
 *
 * Order of operations (the thing the hand-worked golden proves):
 *  1. rendimentos = the month's aggregate taxable receipts (gross);
 *  2. deduction = max(desconto simplificado R$ 607,20, INSS + R$ 189,59 ×
 *     dependentes + pensão) — the source applies whichever benefits the
 *     taxpayer (Lei 9.250/1995, art. 10: "caso seja mais benéfico");
 *  3. base = max(0, rendimentos − deduction);
 *  4. imposto bruto = base × alíquota − parcela a deduzir (monthly table),
 *     truncated to cents;
 *  5. redutor from the art. 3º-A table keyed on GROSS rendimentos
 *     (Receita's official formula uses "renda bruta mensal"), capped at the
 *     computed tax;
 *  6. IRRF = max(0, bruto − redutor).
 *
 * Decimal strings in and out; no floats anywhere.
 */
import { PayrollPackError } from "../payroll-error.ts";
import {
  BR_2026_DEPENDENTE,
  BR_2026_DESCONTO_SIMPLIFICADO,
  BR_2026_IRRF_BANDS,
  BR_2026_REDUCAO,
} from "./tax-year-2026.ts";

function truncCents(numerator: bigint, denominator: bigint): bigint {
  const q = numerator / denominator;
  const r = numerator % denominator;
  if (r < 0n) return q + 1n;
  return q;
}

function toCents(value: string, what: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) {
    throw new PayrollPackError(
      `BR 2026 IRRF needs ${what} as a non-negative decimal amount, got "${value}"`,
    );
  }
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? "00").padEnd(2, "0"));
}

function fromCents(cents: bigint): string {
  const sign = cents < 0n ? "-" : "";
  const abs = cents < 0n ? -cents : cents;
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

function percentParts(percent: string): { num: bigint; den: bigint } {
  const [whole = "0", frac = ""] = percent.split(".");
  const den = 10n ** BigInt(frac.length);
  return { num: BigInt(whole) * den + BigInt(frac || "0"), den: den * 100n };
}

export interface BrIrrf2026Input {
  /** Month's aggregate rendimentos tributáveis (gross, before deductions). */
  rendimentos: string;
  /** Employee INSS contribution for the month (deductible from the base). */
  inss: string;
  /** Dependent count for the R$ 189,59 deduction. */
  dependentes: number;
  /** Monthly court-ordered pensão alimentícia (0 when none). */
  pensaoMensal: string;
}

export interface BrIrrf2026Result {
  /** The deduction actually applied (simplified vs legal winner). */
  deducaoAplicada: string;
  /** Which arm won: the flat simplified or the summed legal deductions. */
  deducaoVia: "simplificado" | "legal";
  /** Base de cálculo after the deduction, floored at zero. */
  baseCalculo: string;
  /** Imposto from the progressive table, before the art. 3º-A reduction. */
  impostoBruto: string;
  /** The art. 3º-A reduction actually subtracted (capped at the tax). */
  reducao: string;
  /** Final monthly IRRF, never negative. */
  irrf: string;
}

export function calculateBrIrrf2026(input: BrIrrf2026Input): BrIrrf2026Result {
  if (!Number.isInteger(input.dependentes) || input.dependentes < 0) {
    throw new PayrollPackError(
      `BR 2026 IRRF needs dependentes as a non-negative integer, got "${input.dependentes}"`,
    );
  }
  const rendimentos = toCents(input.rendimentos, "rendimentos");
  const inss = toCents(input.inss, "inss");
  const pensao = toCents(input.pensaoMensal, "pensaoMensal");
  const simplificado = toCents(BR_2026_DESCONTO_SIMPLIFICADO, "desconto simplificado");
  const porDependente = toCents(BR_2026_DEPENDENTE, "deducao por dependente");
  const legal = inss + porDependente * BigInt(input.dependentes) + pensao;
  const via = legal > simplificado ? "legal" : "simplificado";
  const deducao = legal > simplificado ? legal : simplificado;
  const base = rendimentos > deducao ? rendimentos - deducao : 0n;

  let impostoBruto = 0n;
  for (const band of BR_2026_IRRF_BANDS) {
    if (band.upTo !== null && base > toCents(band.upTo, "band bound")) continue;
    const { num, den } = percentParts(band.rate);
    impostoBruto = truncCents(base * num, den) - toCents(band.deduct, "parcela a deduzir");
    if (impostoBruto < 0n) impostoBruto = 0n;
    break;
  }

  const faixaIsencao = toCents(BR_2026_REDUCAO.faixaIsencao, "faixa de isencao");
  const faixaTransicao = toCents(BR_2026_REDUCAO.faixaTransicao, "faixa de transicao");
  let reducao = 0n;
  if (rendimentos <= faixaIsencao) {
    const cap = toCents(BR_2026_REDUCAO.faixaIsencaoCap, "reduction cap");
    reducao = impostoBruto < cap ? impostoBruto : cap;
  } else if (rendimentos <= faixaTransicao) {
    const exact = toCents(BR_2026_REDUCAO.base, "reduction base")
      - truncCents(rendimentos * BR_2026_REDUCAO.coeficienteNum, BR_2026_REDUCAO.coeficienteDen);
    const positive = exact < 0n ? 0n : exact;
    reducao = impostoBruto < positive ? impostoBruto : positive;
  }

  const irrf = impostoBruto > reducao ? impostoBruto - reducao : 0n;
  return {
    deducaoAplicada: fromCents(deducao),
    deducaoVia: via,
    baseCalculo: fromCents(base),
    impostoBruto: fromCents(impostoBruto),
    reducao: fromCents(reducao),
    irrf: fromCents(irrf),
  };
}
