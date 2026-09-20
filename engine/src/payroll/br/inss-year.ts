/**
 * INSS for transcribed pre-2026 years — the pure employee-contribution
 * calculator with the tables passed in.
 *
 * This is the EC 103/2019 methodology the January portaria applies every
 * year: each salary-de-contribuição slice prices at its own rate
 * ("faixa a faixa"), capped at the year's teto, with every slice truncated
 * to cents (the eSocial operational rule — see BR_2026_ROUNDING). The
 * arithmetic below is line-for-line the inss-2026.ts algorithm; only the
 * table source differs (argument, not the 2026 constants), so the 2026 path
 * is untouched. Proven by tax-year-2024.test.ts and tax-year-2025.test.ts.
 *
 * Decimal strings in and out (BRL centavos scale); no floats anywhere.
 */
import { PayrollPackError } from "../payroll-error.ts";

/** The year's transcribed INSS table: slice bounds with rates, and the teto. */
export interface BrInssTables {
  /** Slice upper bounds (inclusive) with exact percent strings; last bound is the teto. */
  brackets: readonly { readonly upTo: string; readonly rate: string }[];
  /** The year's teto as a decimal string. */
  teto: string;
  /** Names the year in refusals, e.g. "BR 2024 INSS". */
  tag: string;
}

/** Truncate a rational number of centavos toward zero. */
function truncCents(numerator: bigint, denominator: bigint): bigint {
  const q = numerator / denominator;
  const r = numerator % denominator;
  if (r < 0n) return q + 1n;
  return q;
}

/** Parse "1234.56" (or "1234") to exact centavos, refusing anything else. */
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

/** "7.5" → { num: 75n, den: 1000n } — exact rational percent. */
function percentParts(percent: string): { num: bigint; den: bigint } {
  const [whole = "0", frac = ""] = percent.split(".");
  const den = 10n ** BigInt(frac.length);
  return { num: BigInt(whole) * den + BigInt(frac || "0"), den: den * 100n };
}

export interface BrInssYearInput {
  /** Monthly salary-de-contribuição (already aggregated for the month). */
  salarioContribuicao: string;
}

export interface BrInssYearResult {
  /** Total employee contribution, truncated per slice then summed. */
  contribuicao: string;
  /** Per-slice amounts, in bracket order, for the trace. */
  fatias: string[];
  /** The base actually priced (input capped at the teto). */
  baseTributavel: string;
}

export function calculateBrInssFromTables(
  tables: BrInssTables,
  input: BrInssYearInput,
): BrInssYearResult {
  const teto = toCents(tables.teto, "teto", tables.tag);
  const salario = toCents(input.salarioContribuicao, "salarioContribuicao", tables.tag);
  const base = salario < teto ? salario : teto;
  const fatias: string[] = [];
  let floor = 0n;
  for (const bracket of tables.brackets) {
    const upTo = toCents(bracket.upTo, "bracket bound", tables.tag);
    const slice = (base < upTo ? base : upTo) - floor;
    if (slice <= 0n) break;
    const { num, den } = percentParts(bracket.rate);
    // slice_cents × rate / 100, truncated — the eSocial per-slice rule.
    fatias.push(fromCents(truncCents(slice * num, den)));
    floor = upTo;
    if (base <= upTo) break;
  }
  const total = fatias.reduce((acc, f) => acc + toCents(f, "fatia", tables.tag), 0n);
  return { contribuicao: fromCents(total), fatias, baseTributavel: fromCents(base) };
}
