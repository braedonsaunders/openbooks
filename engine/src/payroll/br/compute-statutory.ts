/**
 * Phase 9 — BR pack statutory pass: 2026 INSS + IRRF + employer cost.
 *
 * Pure calculators live in ./inss-2026.ts and ./irrf-2026.ts (proven by
 * goldens); this adapter maps the generic run context onto them. The BR pack
 * is monthly: periodsPerYear must be 12 (13º, férias and rescisão are named
 * refusals, never priced through this path).
 *
 * Pack-owned emp keys (named refusals when absent, never defaulted into a
 * different withholding): br_dependentes (integer ≥ 0, required),
 * br_pensao_mensal (optional decimal, absent = none ordered) and br_regime
 * (optional; present and not "clt" refuses — aprendiz/doméstico/temporário
 * price differently).
 *
 * Money enters as engine 4dp decimals and is truncated to centavos at the
 * boundary — the pack's uniform rule (see BR_2026_ROUNDING).
 */
import { fromUnits, toUnits } from "../../money/money.ts";
import { empFact } from "../employee-facts.ts";
// Side effect: registers BR_EMPLOYEE_FACTS, so every read below resolves
// through the declaration in every import graph — never via a transitive
// side effect of the pack registry.
import "./employee-facts.ts";
import { PayrollPackError } from "../payroll-error.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import { resolveStatutoryRates } from "../statutory-rates.ts";
import { calculateBrInss2026 } from "./inss-2026.ts";
import { calculateBrIrrf2026 } from "./irrf-2026.ts";
import { calculateBrInssFromTables } from "./inss-year.ts";
import { calculateBrIrrfFromTables } from "./irrf-year.ts";
import { brTablesForPayDate } from "./year-tables.ts";
import { BR_PACK_RATES } from "./rates.ts";
import { BR_2026_FGTS, BR_2026_PATRONAL } from "./tax-year-2026.ts";

function fail(message: string): never {
  throw new PayrollPackError(`BR payroll 2026: ${message}`);
}

/** Engine 4dp decimal → exact centavos, truncating sub-centavo fractions. */
function cents(value: string, what: string): bigint {
  let units: bigint;
  try {
    units = toUnits(value);
  } catch {
    fail(`${what} is not a decimal amount: "${value}"`);
  }
  if (units < 0n) fail(`${what} must be non-negative, got "${value}"`);
  return units / 100n;
}

/** Exact centavos → engine 4dp decimal. */
function brl4(centsValue: bigint): string {
  return fromUnits(centsValue * 100n);
}

/** "312.89" (2dp calculator output) → exact centavos. */
function centsOf2dp(value: string): bigint {
  const match = /^(\d+)\.(\d{2})$/.exec(value);
  const [, whole, hundredths] = match ?? [];
  if (whole === undefined || hundredths === undefined) {
    fail(`internal error: expected 2dp amount, got "${value}"`);
  }
  return BigInt(whole) * 100n + BigInt(hundredths);
}

/** Parse an exact percent string ("2", "1.50") to a rational. */
function percentParts(percent: string, what: string): { num: bigint; den: bigint } {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(percent.trim());
  const whole = match?.[1];
  if (whole === undefined) fail(`${what} is not a percent: "${percent}"`);
  const frac = match?.[2] ?? "";
  const den = 10n ** BigInt(frac.length);
  return { num: BigInt(whole) * den + BigInt(frac || "0"), den: den * 100n };
}

/** Parse an exact factor string ("1.5", "0.5000") to a rational. */
function factorParts(factor: string, what: string): { num: bigint; den: bigint } {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(factor.trim());
  const whole = match?.[1];
  if (whole === undefined) fail(`${what} is not a factor: "${factor}"`);
  const frac = match?.[2] ?? "";
  return { num: BigInt(whole) * 10n ** BigInt(frac.length) + BigInt(frac || "0"), den: 10n ** BigInt(frac.length) };
}

/** Truncate an exact rational of centavos toward zero (all inputs ≥ 0). */
function truncCents(numerator: bigint, denominator: bigint): bigint {
  return numerator / denominator;
}

/** Tenant-declared employer rates, injected for unit tests (IT precedent). */
export interface BrEmployerRates {
  /** RAT percent as notified ("2" = 2%); null = undeclared. */
  ratPct: string | null;
  /** FAP factor as notified ("1.5"); null = undeclared. */
  fap: string | null;
  /** Aggregate terceiros percent; null = undeclared. */
  terceirosPct: string | null;
}

export async function computeBrStatutoryWithRates(
  ctx: PayrollStatutoryComputeContext,
  rates: BrEmployerRates,
): Promise<Record<string, string>> {
  const {
    taxYear, region, run, income, nonPeriodic, pensionable, insurable,
    periodsPerYear, pushStatutory, assertRegionSupported, emp,
  } = ctx;
  if (taxYear !== 2026 && taxYear !== 2025 && taxYear !== 2024) {
    fail(
      `tax year ${taxYear} has not been transcribed — the BR payroll pack's transcribed years are `
      + "calendar 2024, 2025 and 2026 (see engine/src/payroll/br/tax-year-2024.ts, "
      + "tax-year-2025.ts and tax-year-2026.ts). "
      + "Transcribe the year's Portaria + monthly tables before calculating",
    );
  }
  // Prior years price through their own transcribed tables, selected by pay
  // month (each changed the IRRF table mid-year); 2026 keeps its own path
  // below, byte-for-byte the behaviour the 2026 suite proves.
  const payDate = run.pay_date;
  if (taxYear !== 2026 && (typeof payDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(payDate))) {
    fail(
      `run pay_date "${payDate ?? "(missing)"}" does not name an ISO day in tax year ${taxYear} — `
      + "prior-year tables are selected by pay month, so the run must carry its pay_date",
    );
  }
  const priorTables =
    taxYear === 2024 || taxYear === 2025 ? brTablesForPayDate(taxYear, payDate as string) : null;
  assertRegionSupported(region);
  if (region !== "BR") {
    fail(`region "${region}" is not covered — the BR pack withholds nationally, never by state`);
  }
  if (periodsPerYear !== 12) {
    fail(
      `periodsPerYear ${periodsPerYear} is refused: the INSS teto and the IRRF monthly table are `
      + "intrinsically monthly — monthly payroll only (13º/férias/rescisão are named refusals)",
    );
  }

  // Resolved through the pack's employeeFacts declaration (see the PL
  // adapter): raw values untouched, undeclared keys refused at authoring.
  const regime = empFact("BR", emp, "br_regime");
  if (regime !== undefined && regime !== null && regime !== "" && regime !== "clt") {
    fail(
      `employee br_regime "${regime}" is not standard monthly CLT — aprendiz (2% FGTS), doméstico, `
      + `temporário and other regimes price differently: see BR_REFUSED_${taxYear}`,
    );
  }
  const depRaw = empFact("BR", emp, "br_dependentes");
  if (depRaw === undefined || depRaw === null || depRaw === "") {
    fail(
      'employee br_dependentes is missing: the R$ 189,59 dependent deduction needs the count — '
      + "it is never defaulted",
    );
  }
  const dependentes = Number(depRaw);
  if (!Number.isInteger(dependentes) || dependentes < 0) {
    fail(`employee br_dependentes "${depRaw}" is not a non-negative integer`);
  }
  const pensaoRaw = empFact("BR", emp, "br_pensao_mensal");
  const pensao = pensaoRaw === undefined || pensaoRaw === null || pensaoRaw === ""
    ? "0.00"
    : (() => {
      const c = cents(pensaoRaw, "br_pensao_mensal");
      return `${c / 100n}.${String(c % 100n).padStart(2, "0")}`;
    })();

  // The month aggregates: every amount paid in the month joins both bases
  // (periodic treatment — IRRF is assessed on the month's accumulated
  // rendimentos, and the INSS salary-de-contribuição is monthly).
  const rendimentos = cents(income, "income") + cents(nonPeriodic === "" ? "0" : nonPeriodic, "nonPeriodic");
  const salarioContribuicao = cents(pensionable, "pensionable");
  const remuneracao = cents(insurable === "" ? pensionable : insurable, "insurable");
  const fmtCents = (c: bigint): string => `${c / 100n}.${String(c % 100n).padStart(2, "0")}`;

  // 1. INSS first: it is deductible from the IRRF base, so the order matters.
  const inss = priorTables === null
    ? calculateBrInss2026({ salarioContribuicao: fmtCents(salarioContribuicao) })
    : calculateBrInssFromTables(priorTables.inss, { salarioContribuicao: fmtCents(salarioContribuicao) });

  // 2. IRRF on the month's aggregate, with the INSS deduction inside.
  // Pre-2026 editions carry no art. 3º-A reduction (Lei 15.270/2025 takes
  // effect 1 January 2026), so the generic calculator prices table tax only.
  const irrf = priorTables === null
    ? calculateBrIrrf2026({
      rendimentos: fmtCents(rendimentos),
      inss: inss.contribuicao,
      dependentes,
      pensaoMensal: pensao,
    })
    : calculateBrIrrfFromTables(priorTables.irrf, {
      rendimentos: fmtCents(rendimentos),
      inss: inss.contribuicao,
      dependentes,
      pensaoMensal: pensao,
    });

  // 3. Employer cost: patronal 20% (published) + RAT×FAP + terceiros
  // (tenant-declared, refused by name when the lookup finds nothing) +
  // FGTS 8% (employer obligation, never withheld).
  if (rates.ratPct === null) {
    fail(
      "the br_rat statutory rate is not declared for this establishment — the CNAE risk class "
      + "(1%/2%/3%) is tenant-entered on the eSocial CNPJ filing account, never table-supplied",
    );
  }
  if (rates.fap === null) {
    fail(
      "the br_fap statutory rate is not declared for this establishment — the FAP factor (0.5–2.0) "
      + "is tenant-entered on the eSocial CNPJ filing account, never table-supplied",
    );
  }
  if (rates.terceirosPct === null) {
    fail(
      "the br_terceiros statutory rate is not declared for this establishment — the aggregate "
      + "terceiros percent for its FPAS code is tenant-entered, never table-supplied",
    );
  }
  const rat = percentParts(rates.ratPct, "br_rat aliquota");
  if (rat.num * 100n < rat.den || rat.num * 100n > rat.den * 3n) {
    fail(`br_rat aliquota "${rates.ratPct}" is not 1, 2 or 3 percent`);
  }
  const fap = factorParts(rates.fap, "br_fap fator");
  if (fap.num * 2n < fap.den || fap.num > fap.den * 2n) {
    fail(`br_fap fator "${rates.fap}" is outside 0.5–2.0`);
  }
  const terceiros = percentParts(rates.terceirosPct, "br_terceiros aliquota");
  // Patronal 20% and FGTS 8% every transcribed year (Lei 8.212/1991 art. 22,
  // I; Lei 8.036/1990 art. 15) — read off the year's own module, never
  // borrowed across years.
  const patronalRate = percentParts(priorTables?.patronal ?? BR_2026_PATRONAL, "patronal");
  const fgtsRate = percentParts(priorTables?.fgts ?? BR_2026_FGTS, "FGTS");

  const patronal = truncCents(remuneracao * patronalRate.num, patronalRate.den);
  const ratEr = truncCents(remuneracao * rat.num * fap.num, rat.den * fap.den);
  const terceirosEr = truncCents(remuneracao * terceiros.num, terceiros.den);
  const fgts = truncCents(remuneracao * fgtsRate.num, fgtsRate.den);

  pushStatutory("irrf", "deduction", "IRRF", brl4(centsOf2dp(irrf.irrf)), 110);
  pushStatutory("inss", "deduction", "INSS (segurado)", brl4(centsOf2dp(inss.contribuicao)), 120);
  pushStatutory("inss_patronal", "employer_contribution", "INSS patronal (20%)", brl4(patronal), 210);
  pushStatutory("inss_rat", "employer_contribution", "RAT × FAP", brl4(ratEr), 211);
  pushStatutory("inss_terceiros", "employer_contribution", "Terceiros", brl4(terceirosEr), 212);
  pushStatutory("fgts", "employer_contribution", "FGTS (8%)", brl4(fgts), 220);
  return {
    BR_RENDIMENTOS: brl4(rendimentos),
    BR_INSS: brl4(centsOf2dp(inss.contribuicao)),
    BR_BASE_IRRF: brl4(centsOf2dp(irrf.baseCalculo)),
    BR_DEDUCAO_VIA: irrf.deducaoVia,
    BR_IMPOSTO_BRUTO: brl4(centsOf2dp(irrf.impostoBruto)),
    BR_REDUCAO: brl4(centsOf2dp(irrf.reducao)),
    BR_IRRF: brl4(centsOf2dp(irrf.irrf)),
    BR_PATRONAL: brl4(patronal),
    BR_RAT: brl4(ratEr),
    BR_TERCEIROS: brl4(terceirosEr),
    BR_FGTS: brl4(fgts),
  };
}

/**
 * Trace-factor labels for the stub calculation trace, keyed by the factor
 * keys this pass returns. Terms are the CLT computation's own (rendimentos,
 * INSS, IRRF, FGTS) — see irrf-2026.ts.
 */
export const BR_FACTOR_LABELS: Readonly<Record<string, string>> = {
  BR_RENDIMENTOS: "Rendimentos tributáveis",
  BR_INSS: "INSS (segurado)",
  BR_BASE_IRRF: "Base de cálculo IRRF",
  BR_DEDUCAO_VIA: "Deduction path (simplificado/legal)",
  BR_IMPOSTO_BRUTO: "Imposto bruto",
  BR_REDUCAO: "Redução",
  BR_IRRF: "IRRF (imposto de renda retido na fonte)",
  BR_PATRONAL: "INSS patronal",
  BR_RAT: "RAT × FAP",
  BR_TERCEIROS: "Terceiros",
  BR_FGTS: "FGTS (fundo de garantia do tempo de serviço)",
};

/** The establishment scope BR rate lookups resolve at: the employee's region
 * plus their eSocial filing account. The region is load-bearing — every
 * br_* row carries one (the schema forbids an account-scoped row without
 * it), so a lookup without it matches nothing and the whole pack refuses.
 * Exported so the unit partition can hold the wiring, not just the engine. */
export function brRateLookupScope(ctx: Pick<PayrollStatutoryComputeContext, "region" | "filingAccountId">): {
  region: string | null;
  filingAccountId: string | null;
} {
  return { region: ctx.region, filingAccountId: ctx.filingAccountId };
}

/** Phase 9 — BR pack statutory pass for 2026. Refuses every other year. */
/** Phase 9 — BR pack statutory pass for 2024–2026. Refuses every other year. */
export async function computeBrStatutory(
  ctx: PayrollStatutoryComputeContext,
): Promise<Record<string, string>> {
  if (ctx.taxYear !== 2026 && ctx.taxYear !== 2025 && ctx.taxYear !== 2024) {
    return computeBrStatutoryWithRates(ctx, { ratPct: null, fap: null, terceirosPct: null });
  }
  const resolution = await resolveStatutoryRates(ctx.orgId, BR_PACK_RATES, ctx.taxYear, ctx.run.pay_date);
  const at = brRateLookupScope(ctx);
  return computeBrStatutoryWithRates(ctx, {
    ratPct: resolution.values("br_rat", at)?.["aliquota"] ?? null,
    fap: resolution.values("br_fap", at)?.["fator"] ?? null,
    terceirosPct: resolution.values("br_terceiros", at)?.["aliquota"] ?? null,
  });
}
