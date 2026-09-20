/**
 * Spain 2026 Seguridad Social engine — pure, no database, no clock.
 *
 * Applies the Orden PJC/297/2026 tipos (transcribed in ./rates.ts) to a
 * monthly contribution base: contingencias comunes, desempleo (indefinido /
 * temporal split), FOGASA, formación profesional, MEI, the solidaridad
 * tranches above the tope máximo, and the horas-extra adicionales. AT/EP is
 * rated by activity (tarifa de primas, DA 61ª LGSS) so its rate is
 * tenant-entered, never transcribed: pass `atEpRate` to compute the employer
 * line from it, or omit it and the line is absent (not zero).
 *
 * Money discipline: decimal strings in, bigint 1e4 units inside (money.ts),
 * never floats. Each cuota rounds half-up to the cent — ENGINE-STATED, not
 * agency-quoted (the Orden states no rounding rule; AU precedent).
 *
 * Named refusals: diaria-regime solidaridad (art. 17.2 states the daily
 * threshold but no daily tranches — monthly tranches are never stretched
 * onto it); grupo outside 1–11; diaria without días de alta.
 */
import { fromUnits, roundDiv, toUnits } from "../../money/money.ts";
import { PayrollPackError } from "../payroll-error.ts";
import {
  ES_GRUPOS_2026,
  ES_SOLIDARIDAD_2026,
  ES_TIPOS_2026,
  ES_TOPE_MAXIMO_2026,
  type EsTipoSplit,
} from "./rates.ts";

const U = (s: string): bigint => toUnits(s);
const D = (u: bigint): string => fromUnits(u);
/** One cuota: base × rate, half-up to the cent (engine-stated). */
const cuota = (base: bigint, rate: string): bigint =>
  roundDiv(base * U(rate), 10000n * 100n) * 100n;

function fail(message: string): never {
  throw new PayrollPackError(`ES Seguridad Social 2026: ${message}`);
}

export interface EsSeguridadSocialInput {
  readonly payDate: string;
  /** Grupo de cotización 1–11. */
  readonly grupo: number;
  /**
   * Monthly base for grupos 1–7; daily base for grupos 8–11 (needs `dias`).
   * The payroll supplies it; the engine clamps to the grupo topes.
   */
  readonly base: string;
  /** Days in alta with contribution duty (required for grupos 8–11). */
  readonly dias?: number;
  /** Temporal contract → 8,30% desempleo; default indefinido 7,05%. */
  readonly contratoTemporal?: boolean;
  /** Monthly gross for the solidaridad tranches (defaults to the base). */
  readonly retribucionMensual?: string;
  readonly horasExtraFuerzaMayor?: string;
  readonly horasExtraResto?: string;
  /** Tenant-entered AT/EP tariff rate (decimal fraction); absent = no line. */
  readonly atEpRate?: string | null;
}

export interface EsSeguridadSocialResult {
  /** Monthly CC base after clamping. */
  readonly baseContingenciasComunes: string;
  /** Professional-risk base (CC base + horas extra), capped. */
  readonly baseProfesional: string;
  readonly ccTrabajador: string;
  readonly ccEmpresa: string;
  readonly desempleoTrabajador: string;
  readonly desempleoEmpresa: string;
  readonly fogasaEmpresa: string;
  readonly formacionTrabajador: string;
  readonly formacionEmpresa: string;
  readonly meiTrabajador: string;
  readonly meiEmpresa: string;
  readonly solidaridadTrabajador: string;
  readonly solidaridadEmpresa: string;
  readonly horasExtraFMTrabajador: string;
  readonly horasExtraFMEmpresa: string;
  readonly horasExtraRestoTrabajador: string;
  readonly horasExtraRestoEmpresa: string;
  /** Absent (null) when no tenant AT/EP rate was entered. */
  readonly atEpEmpresa: string | null;
  /** Total employee share (feeds IRPF COTIZACIONES). */
  readonly trabajadorTotal: string;
  readonly empresaTotal: string;
}

function split(base: bigint, tipos: EsTipoSplit): { trabajador: bigint; empresa: bigint } {
  return { trabajador: cuota(base, tipos.trabajador), empresa: cuota(base, tipos.empresa) };
}

export function calculateEsSeguridadSocial2026(
  input: EsSeguridadSocialInput,
): EsSeguridadSocialResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.payDate)) {
    fail(`pay date is not an ISO date: "${input.payDate}"`);
  }
  if (input.payDate < "2026-01-01" || input.payDate > "2026-12-31") {
    fail(`no transcribed tables for pay date ${input.payDate} — 2026 only`);
  }
  const grupo = ES_GRUPOS_2026.find((g) => g.grupo === input.grupo);
  if (!grupo) fail(`grupo de cotización ${input.grupo} is outside 1–11`);
  const diaria = grupo!.regimen === "diaria";
  if (diaria && (input.dias === undefined || !Number.isInteger(input.dias) || input.dias <= 0)) {
    fail("grupos 8–11 need integer días de alta with contribution duty");
  }
  const dias = diaria ? input.dias! : 1;
  let base: bigint;
  try {
    base = U(input.base);
  } catch {
    fail(`base is not a decimal amount: "${input.base}"`);
  }
  if (base < 0n) fail(`base must be non-negative, got "${input.base}"`);
  const mensual = diaria ? base * BigInt(dias) : base;
  const minima = U(grupo!.minima) * BigInt(dias);
  let maxima = U(grupo!.maxima) * BigInt(dias);
  const tope = U(ES_TOPE_MAXIMO_2026);
  if (maxima > tope) maxima = tope;
  let ccBase = mensual;
  if (ccBase < minima) ccBase = minima;
  if (ccBase > maxima) ccBase = maxima;

  const heFM = parseExtra(input.horasExtraFuerzaMayor, "horas extra fuerza mayor");
  const heResto = parseExtra(input.horasExtraResto, "horas extra resto");
  let baseProf = ccBase + heFM + heResto;
  if (baseProf > maxima) baseProf = maxima;

  const T = ES_TIPOS_2026;
  const cc = split(ccBase, T.contingenciasComunes);
  const des = split(baseProf, input.contratoTemporal === true ? T.desempleoTemporal : T.desempleoIndefinido);
  const fogasa = cuota(baseProf, T.fogasa.empresa);
  const form = split(baseProf, T.formacion);
  const mei = split(ccBase, T.mei);
  const hefmEe = cuota(heFM, T.horasExtraFuerzaMayor.trabajador);
  const hefmEr = cuota(heFM, T.horasExtraFuerzaMayor.empresa);
  const herEe = cuota(heResto, T.horasExtraResto.trabajador);
  const herEr = cuota(heResto, T.horasExtraResto.empresa);

  // Solidaridad (art. 17.1): monthly tranches above 5.101,20.
  // Without an explicit monthly figure the month's retribution is the base
  // itself (mensual) or the daily base times the days in alta (diaria).
  let retrib: bigint;
  try {
    retrib = input.retribucionMensual !== undefined
      ? U(input.retribucionMensual)
      : diaria ? base * BigInt(dias) : base;
  } catch {
    fail(`retribucionMensual is not a decimal amount: "${input.retribucionMensual}"`);
  }
  if (retrib < 0n) fail("retribucionMensual must be non-negative");
  if (diaria && retrib > U(grupo!.maxima) * BigInt(dias)) {
    fail(
      "diaria-regime solidaridad is refused: art. 17.2 states a daily threshold "
      + "but no daily tranches — monthly tranches are never stretched onto it",
    );
  }
  let solEe = 0n;
  let solEr = 0n;
  for (const tramo of ES_SOLIDARIDAD_2026) {
    const desde = U(tramo.desde);
    if (retrib <= desde) break;
    const hasta = tramo.hasta === null ? retrib : U(tramo.hasta);
    const slice = (retrib < hasta ? retrib : hasta) - desde;
    if (slice <= 0n) continue;
    solEe += cuota(slice, tramo.tipos.trabajador);
    solEr += cuota(slice, tramo.tipos.empresa);
  }

  let atEp: bigint | null = null;
  if (input.atEpRate !== undefined && input.atEpRate !== null && input.atEpRate !== "") {
    let rate: bigint;
    try {
      rate = U(input.atEpRate);
    } catch {
      fail(`AT/EP rate is not a decimal fraction: "${input.atEpRate}"`);
    }
    if (rate < 0n || rate > U("1")) fail(`AT/EP rate out of range 0–1: "${input.atEpRate}"`);
    atEp = roundDiv(baseProf * rate, 10000n * 100n) * 100n;
  }

  const trabajadorTotal = cc.trabajador + des.trabajador + form.trabajador + mei.trabajador
    + solEe + hefmEe + herEe;
  const empresaTotal = cc.empresa + des.empresa + fogasa + form.empresa + mei.empresa
    + solEr + hefmEr + herEr + (atEp ?? 0n);

  return {
    baseContingenciasComunes: D(ccBase),
    baseProfesional: D(baseProf),
    ccTrabajador: D(cc.trabajador),
    ccEmpresa: D(cc.empresa),
    desempleoTrabajador: D(des.trabajador),
    desempleoEmpresa: D(des.empresa),
    fogasaEmpresa: D(fogasa),
    formacionTrabajador: D(form.trabajador),
    formacionEmpresa: D(form.empresa),
    meiTrabajador: D(mei.trabajador),
    meiEmpresa: D(mei.empresa),
    solidaridadTrabajador: D(solEe),
    solidaridadEmpresa: D(solEr),
    horasExtraFMTrabajador: D(hefmEe),
    horasExtraFMEmpresa: D(hefmEr),
    horasExtraRestoTrabajador: D(herEe),
    horasExtraRestoEmpresa: D(herEr),
    atEpEmpresa: atEp === null ? null : D(atEp),
    trabajadorTotal: D(trabajadorTotal),
    empresaTotal: D(empresaTotal),
  };
}

function parseExtra(value: string | undefined, what: string): bigint {
  if (value === undefined) return 0n;
  let parsed: bigint;
  try {
    parsed = U(value);
  } catch {
    fail(`${what} is not a decimal amount: "${value}"`);
  }
  if (parsed < 0n) fail(`${what} must be non-negative, got "${value}"`);
  return parsed;
}
