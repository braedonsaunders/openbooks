/**
 * IRRF for transcribed pre-2026 years — the pure monthly withholding
 * calculator with the tables passed in.
 *
 * Order of operations (the thing the hand-worked goldens prove):
 *  1. rendimentos = the month's aggregate taxable receipts (gross);
 *  2. deduction = max(desconto simplificado, INSS + dependente ×
 *     dependentes + pensão) — the source applies whichever benefits the
 *     taxpayer ("caso seja mais benéfico");
 *  3. base = max(0, rendimentos − deduction);
 *  4. IRRF = base × alíquota − parcela a deduzir (monthly table),
 *     truncated to cents, floored at zero.
 *
 * There is deliberately NO art. 3º-A reduction step: the reduction
 * (Lei 15.270/2025) produces effects from 1 January 2026 only, so every
 * pre-2026 golden asserts reducao "0.00". The table-pricing steps are
 * line-for-line the irrf-2026.ts algorithm; only the table source differs
 * (argument, not the 2026 constants), so the 2026 path is untouched.
 *
 * Decimal strings in and out; no floats anywhere.
 */
import { PayrollPackError } from "../payroll-error.ts";

/** The month's transcribed IRRF table: bands, simplified discount, dependent value. */
export interface BrIrrfTables {
  /** Base-de-cálculo bands with exact percent strings and published deducts. */
  bands: readonly {
    readonly upTo: string | null;
    readonly rate: string;
    readonly deduct: string;
  }[];
  /** Desconto simplificado mensal (25% of the zero band) as a decimal string. */
  simplificado: string;
  /** Dedução mensal por dependente as a decimal string. */
  dependente: string;
  /** Names the edition in refusals, e.g. "BR 2024 IRRF (feb-dec)". */
  tag: string;
}

function truncCents(numerator: bigint, denominator: bigint): bigint {
  const q = numerator / denominator;
  const r = numerator % denominator;
  if (r < 0n) return q + 1n;
  return q;
}

function toCents(value: string, what: string, tag: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) {
    throw new PayrollPackError(
      `${tag} needs ${what} as a non-negative decimal amount, got "${value}"`,
    );
  }
  const whole = match[1];
  if (whole === undefined) {
    throw new PayrollPackError(`${tag}: unparsed amount "${value}"`);
  }
  return BigInt(whole) * 100n + BigInt((match[2] ?? "00").padEnd(2, "0"));
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

export interface BrIrrfYearInput {
  /** Month's aggregate rendimentos tributáveis (gross, before deductions). */
  rendimentos: string;
  /** Employee INSS contribution for the month (deductible from the base). */
  inss: string;
  /** Dependent count for the per-dependent deduction. */
  dependentes: number;
  /** Monthly court-ordered pensão alimentícia (0 when none). */
  pensaoMensal: string;
}

export interface BrIrrfYearResult {
  /** The deduction actually applied (simplified vs legal winner). */
  deducaoAplicada: string;
  /** Which arm won: the flat simplified or the summed legal deductions. */
  deducaoVia: "simplificado" | "legal";
  /** Base de cálculo after the deduction, floored at zero. */
  baseCalculo: string;
  /** Imposto from the progressive table — the final withholding (no reduction pre-2026). */
  impostoBruto: string;
  /**
   * Always "0.00" before 2026: the art. 3º-A reduction exists only from
   * 1 January 2026. Kept so the adapter's factor shape is uniform across years.
   */
  reducao: string;
  /** Final monthly IRRF, never negative. */
  irrf: string;
}

export function calculateBrIrrfFromTables(
  tables: BrIrrfTables,
  input: BrIrrfYearInput,
): BrIrrfYearResult {
  if (!Number.isInteger(input.dependentes) || input.dependentes < 0) {
    throw new PayrollPackError(
      `${tables.tag} needs dependentes as a non-negative integer, got "${input.dependentes}"`,
    );
  }
  const rendimentos = toCents(input.rendimentos, "rendimentos", tables.tag);
  const inss = toCents(input.inss, "inss", tables.tag);
  const pensao = toCents(input.pensaoMensal, "pensaoMensal", tables.tag);
  const simplificado = toCents(tables.simplificado, "desconto simplificado", tables.tag);
  const porDependente = toCents(tables.dependente, "deducao por dependente", tables.tag);
  const legal = inss + porDependente * BigInt(input.dependentes) + pensao;
  const via = legal > simplificado ? "legal" : "simplificado";
  const deducao = legal > simplificado ? legal : simplificado;
  const base = rendimentos > deducao ? rendimentos - deducao : 0n;

  let impostoBruto = 0n;
  for (const band of tables.bands) {
    if (band.upTo !== null && base > toCents(band.upTo, "band bound", tables.tag)) continue;
    const { num, den } = percentParts(band.rate);
    impostoBruto = truncCents(base * num, den) - toCents(band.deduct, "parcela a deduzir", tables.tag);
    if (impostoBruto < 0n) impostoBruto = 0n;
    break;
  }

  return {
    deducaoAplicada: fromCents(deducao),
    deducaoVia: via,
    baseCalculo: fromCents(base),
    impostoBruto: fromCents(impostoBruto),
    reducao: "0.00",
    irrf: fromCents(impostoBruto),
  };
}
