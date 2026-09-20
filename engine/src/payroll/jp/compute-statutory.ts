/**
 * Phase 9 — JP pack statutory pass: 2026 源泉徴収 (月額表・甲/乙) + 厚生年金
 * + 健康保険 for a monthly payslip.
 *
 * Pure pricing lives in ./withholding-2026.ts (proven by goldens); this
 * adapter maps the generic run context onto it. The pack is monthly: the
 * 月額表 prices a month's pay and the 標準報酬月額 is intrinsically monthly,
 * so periodsPerYear must be 12.
 *
 * Pack-owned inputs (named refusals when absent, never defaulted into a
 * lower withholding):
 * - emp jp_hyojun_hoshu: the operator-entered 標準報酬月額, copied off the
 *   JPS notice. Must equal a published grade value (定時決定/随時改定 are
 *   refused — the grade is a fact, never derived from current pay).
 * - emp jp_kaigo_dainigou: "true"/"false". "true" (a 介護保険第2号被保険者,
 *   40–64) refuses — the 介護 premium has no channel; anything else refuses
 *   too, because silently pricing health without 介護 under-withholds.
 * - jp_fuyo certificate on file → 甲欄 at its 扶養親族等の数; absent → 乙欄
 *   (exactly the statute: no declaration, no 甲欄).
 * - jp_health_rate tenant slot per prefecture (scope region); unconfigured
 *   refuses at the rate channel.
 * - Any non-periodic amount refuses (賞与算出率の表 untranscribed).
 *
 * Deliberately called: the `ctx.assertRegionSupported` callback. Unlike
 * Italy's engine this pass runs only for known JIS prefectures and asserts
 * the generic gate too — the prefecture selects the health rate, so an
 * unknown code must stop here, not price a neighbour's rate.
 */
import { toUnits } from "../../money.ts";
import { empFact } from "../employee-facts.ts";
// Side effect: registers JP_EMPLOYEE_FACTS, so every read below resolves
// through the declaration in every import graph — never via a transitive
// side effect of the pack registry.
import "./employee-facts.ts";
import { PayrollPackError } from "../payroll-error.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import { resolveStatutoryRates } from "../statutory-rates.ts";
import { calculateJp2026 } from "./withholding-2026.ts";
import { JP_PACK_RATES } from "./rates.ts";
import { JP_PREFECTURE_CODES } from "./regions.ts";

function fail(message: string): never {
  throw new PayrollPackError(`JP payroll 2026: ${message}`);
}

export interface JpStatutoryRates {
  healthRate: string | null;
}

/**
 * The DB-free half of the statutory pass: glue from the run context to the
 * pure engine, with the tenant health rate injected. Unit tests drive this
 * (no Postgres); the production entry below resolves the rate first.
 */
/**
 * Trace-factor labels for the stub calculation trace, keyed by the factor
 * keys this pass returns. Terms are the NTA 月額表 and shaho tables' own
 * (源泉徴収, pension and health half-shares) — see withholding-2026.ts.
 */
export const JP_FACTOR_LABELS: Readonly<Record<string, string>> = {
  JP_GENSEN_BASE: "源泉徴収 base (after social insurance)",
  JP_GENSEN: "源泉徴収 income tax",
  JP_PENSION_W: "厚生年金 (employee share)",
  JP_PENSION_ER: "厚生年金 (employer share)",
  JP_HEALTH_W: "健康保険 (employee share)",
  JP_HEALTH_ER: "健康保険 (employer share)",
};

export async function computeJpStatutoryWithRates(
  ctx: PayrollStatutoryComputeContext,
  rates: JpStatutoryRates,
): Promise<Record<string, string>> {
  const { taxYear, region, income, nonPeriodic, periodsPerYear, pushStatutory, certificateFor, bool } = ctx;
  if (taxYear !== 2026) {
    fail(
      `tax year ${taxYear} has not been transcribed — the JP payroll pack's only transcribed `
      + "year is calendar 2026 (令和8年分 月額表 + 厚生年金保険料額表 令和8年度版; see "
      + "engine/src/payroll/jp/rates.ts). Transcribe the year's tables before calculating",
    );
  }
  if (!JP_PREFECTURE_CODES.includes(region)) {
    fail(
      `region "${region || "(unset)"}" is not a known JIS prefecture code `
      + `(${JP_PREFECTURE_CODES[0]}–${JP_PREFECTURE_CODES[JP_PREFECTURE_CODES.length - 1]}) — refusing, never defaulting`,
    );
  }
  ctx.assertRegionSupported(region);
  if (periodsPerYear !== 12) {
    fail(
      `periodsPerYear ${periodsPerYear} is refused: the 月額表 prices a month's pay and the `
      + "標準報酬月額 is intrinsically monthly — monthly payroll only",
    );
  }
  // Amounts arrive as decimal strings (money.ts 4dp, e.g. "300000.0000");
  // JPY has no minor unit, so anything below the yen refuses here.
  const yenOf = (value: string, what: string): number => {
    let units: bigint;
    try {
      units = toUnits(value === "" ? "0" : value);
    } catch {
      fail(`${what} "${value}" is not a decimal amount`);
    }
    if (units! < 0n) fail(`${what} "${value}" is negative`);
    if (units! % 10000n !== 0n) {
      fail(`${what} "${value}" is not a whole yen amount (JPY has no minor unit)`);
    }
    const yen = Number(units! / 10000n);
    if (!Number.isSafeInteger(yen)) fail(`${what} "${value}" is out of range`);
    return yen;
  };
  if (yenOf(nonPeriodic, "non-periodic amount") !== 0) {
    fail(
      `non-periodic amount ${nonPeriodic} is refused: bonus withholding uses the 賞与に対する源泉徴収税額の`
      + "算出率の表, which is not transcribed — see JP_REFUSED_2026",
    );
  }
  const gross = yenOf(income, "monthly gross");

  // Resolved through the pack's employeeFacts declaration (see the PL
  // adapter): raw values untouched, undeclared keys refused at authoring.
  const standardRaw = empFact("JP", ctx.emp, "jp_hyojun_hoshu");
  if (standardRaw == null || !/^\d+$/.test(standardRaw)) {
    fail(
      `employee jp_hyojun_hoshu "${standardRaw ?? ""}" is not set: the 標準報酬月額 (a published 厚生年金 `
      + "grade value, copied off the JPS notice) is required — see JP_REFUSED_2026 on 定時決定/随時改定",
    );
  }
  const standard = Number(standardRaw);

  const kaigo = empFact("JP", ctx.emp, "jp_kaigo_dainigou");
  if (kaigo !== "false") {
    fail(
      `employee jp_kaigo_dainigou "${kaigo ?? ""}" is not "false": a 介護保険第2号被保険者 (40–64) owes `
      + "the 介護 premium this engine does not price, and an undeclared status must not default into "
      + "health-without-介護 — see JP_REFUSED_2026",
    );
  }

  let dependents: number | null = null;
  const cert = certificateFor("jp_fuyo");
  if (cert !== null) {
    const answers = cert.answers ?? {};
    const countOf = (key: string): number => {
      const raw = answers[key];
      if (raw == null || raw === "") return 0;
      if (!/^\d+$/.test(raw)) fail(`jp_fuyo ${key} "${raw}" is not a non-negative integer`);
      return Number(raw);
    };
    dependents = countOf("fuyo_count")
      + (bool(answers["honnin_shogai"] ?? null) ? 1 : 0)
      + (bool(answers["hitori_oya"] ?? null) ? 1 : 0)
      + (bool(answers["kafu"] ?? null) ? 1 : 0)
      + (bool(answers["kinro_gakusei"] ?? null) ? 1 : 0)
      + countOf("kazoku_shogai_kasan");
  }

  if (rates.healthRate == null || rates.healthRate === "") {
    fail(
      `no jp_health_rate is configured for prefecture ${region} in 2026 — the in-force 健康保険 rate `
      + "(協会けんぽ branch or 健康保険組合) must be entered; the pack computes no health premium without it",
    );
  }

  const result = calculateJp2026({ grossMonthly: gross, standard, dependents, healthRate: rates.healthRate });

  pushStatutory("income_tax", "deduction", "源泉徴収 (gensen withholding)", String(result.gensen), 110);
  pushStatutory("pension", "deduction", "厚生年金保険 (employee)", String(result.pension), 120);
  pushStatutory("health", "deduction", "健康保険 (employee)", String(result.health), 130);
  pushStatutory("pension", "employer_contribution", "厚生年金保険 (employer)", String(result.pensionEmployer), 220);
  pushStatutory("health", "employer_contribution", "健康保険 (employer)", String(result.healthEmployer), 230);
  return {
    JP_GENSEN_BASE: String(result.gensenBase),
    JP_GENSEN: String(result.gensen),
    JP_PENSION_W: String(result.pension),
    JP_PENSION_ER: String(result.pensionEmployer),
    JP_HEALTH_W: String(result.health),
    JP_HEALTH_ER: String(result.healthEmployer),
  };
}

/** Phase 9 — JP pack statutory pass for 2026. Refuses every other year. */
export async function computeJpStatutory(
  ctx: PayrollStatutoryComputeContext,
): Promise<Record<string, string>> {
  if (ctx.taxYear !== 2026) {
    return computeJpStatutoryWithRates(ctx, { healthRate: null });
  }
  const resolution = await resolveStatutoryRates(ctx.orgId, JP_PACK_RATES, ctx.taxYear, ctx.run.pay_date);
  const health = resolution.values("jp_health_rate", { region: ctx.region });
  return computeJpStatutoryWithRates(ctx, { healthRate: health?.rate ?? null });
}
