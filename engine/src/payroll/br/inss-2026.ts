/**
 * INSS 2026 — pure employee-contribution calculator.
 *
 * EC 103/2019 methodology applied from Portaria 13/2026 Anexo I: each
 * salary-de-contribuição slice prices at its own rate ("faixa a faixa"),
 * capped at the teto, with every slice truncated to cents (eSocial rule —
 * see BR_2026_ROUNDING). Proven by tax-year-2026.test.ts, including the
 * sweep that would catch flat-rating the whole salary at the top rate.
 *
 * Decimal strings in and out (BRL centavos scale); no floats anywhere.
 */
import { PayrollPackError } from "../payroll-error.ts";
import {
  BR_2026_INSS_BRACKETS,
  BR_2026_INSS_TETO,
} from "./tax-year-2026.ts";

/** Truncate a rational number of centavos toward zero. */
function truncCents(numerator: bigint, denominator: bigint): bigint {
  const q = numerator / denominator;
  const r = numerator % denominator;
  if (r < 0n) return q + 1n;
  return q;
}

/** Parse "1234.56" (or "1234") to exact centavos, refusing anything else. */
function toCents(value: string, what: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) {
    throw new PayrollPackError(
      `BR 2026 INSS needs ${what} as a non-negative decimal amount, got "${value}"`,
    );
  }
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? "00").padEnd(2, "0"));
}

function fromCents(cents: bigint): string {
  const sign = cents < 0n ? "-" : "";
  const abs = cents < 0n ? -cents : cents;
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

/** "7.5" → { num: 75n, den: 1000n } — exact rational percent. */
function percentParts(percent: string): { num: bigint; den: bigint } {
  const [whole = "0", frac = ""] = percent.split(".");
  const den = 10n ** BigInt(frac.length);
  return { num: BigInt(whole) * den + BigInt(frac || "0"), den: den * 100n };
}

export interface BrInss2026Input {
  /** Monthly salary-de-contribuição (already aggregated for the month). */
  salarioContribuicao: string;
}

export interface BrInss2026Result {
  /** Total employee contribution, truncated per slice then summed. */
  contribuicao: string;
  /** Per-slice amounts, in bracket order, for the trace. */
  fatias: string[];
  /** The base actually priced (input capped at the teto). */
  baseTributavel: string;
}

export function calculateBrInss2026(input: BrInss2026Input): BrInss2026Result {
  const teto = toCents(BR_2026_INSS_TETO, "teto");
  const salario = toCents(input.salarioContribuicao, "salarioContribuicao");
  const base = salario < teto ? salario : teto;
  const fatias: string[] = [];
  let floor = 0n;
  for (const bracket of BR_2026_INSS_BRACKETS) {
    const upTo = toCents(bracket.upTo, "bracket bound");
    const slice = (base < upTo ? base : upTo) - floor;
    if (slice <= 0n) break;
    const { num, den } = percentParts(bracket.rate);
    // slice_cents × rate / 100, truncated — the eSocial per-slice rule.
    fatias.push(fromCents(truncCents(slice * num, den)));
    floor = upTo;
    if (base <= upTo) break;
  }
  const total = fatias.reduce((acc, f) => acc + toCents(f, "fatia"), 0n);
  return { contribuicao: fromCents(total), fatias, baseTributavel: fromCents(base) };
}
