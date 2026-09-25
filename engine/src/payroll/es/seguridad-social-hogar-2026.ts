/**
 * Sistema Especial para Empleados de Hogar 2026 — contribution bases and
 * rates (BOE Orden PJC/297/2026, de 30 de marzo, BOE núm. 79 de 31 de marzo
 * de 2026, con efectos desde el 1 de enero de 2026):
 * - Tramos 1–8 (art. 15.1): monthly retribution INCLUDING the proportional
 *   extra pays (art. 147.1 LGSS) selects the band; tramo 8 prices actual pay.
 * - TGSS floor (art. 15.2): the applied base cannot sit below the band of
 *   the SMI-equivalent retribution — monthly SMI plus extras, proportional
 *   to agreed hours (or SMI-hora × hours for all-in hourly pacts); unknown
 *   pay type counts as monthly (art. 15.2(d)).
 * - Contingencias comunes (art. 15.3): 28,30% = 23,60% employer + 4,70%
 *   employee, on the band base.
 * - Profesionales (art. 15.4): the DA 61ª LGSS tarifa rate for the activity,
 *   employer only. The rate is activity-rated, so (like the General Regime
 *   pack) it is tenant-entered here, never transcribed: the household
 *   employer enters the TGSS-assigned rate.
 * - Desempleo + FOGASA (art. 35): indefinido 7,05% (5,50/1,55), temporal
 *   8,30% (6,70/1,60); FOGASA 0,20% employer only.
 * - MEI 0,90% = 0,75% employer + 0,15% employee (TGSS 2026 tables).
 * - Beneficios (TGSS): 20% alta reduction on the employer CC quota;
 *   45% for a single large-family caregiver (not cumulative with the 20%);
 *   80% on the employer desempleo quota and on FOGASA. The 75% IT age-62+,
 *   disability and interinidad benefits need contingency facts no regime
 *   carries and stay unmodeled.
 * SMI 2026 (RD 126/2026): 1.221 €/mes × 14 pagas (17.094 €/año); hogar
 * all-in hourly minimum 9,55 €/hora.
 *
 * All arithmetic is exact bigint through the shared decimal helpers. Every
 * cuota rounds half-up to the cent (the pack's engine-stated SS rule).
 */
import { fromUnits, roundDiv, toUnits } from "../../money/money.ts";
import { PayrollPackError } from "../payroll-error.ts";
import { ES_TOPE_MAXIMO_2026 } from "./rates.ts";

const U = (s: string): bigint => toUnits(s);
const D = (u: bigint): string => fromUnits(u);
/** One cuota: base × rate, half-up to the cent (engine-stated). */
const cuota = (base: bigint, rate: string): bigint =>
  roundDiv(base * U(rate), 10000n * 100n) * 100n;
/** A quota reduction by an integer num/den factor, half-up to the cent. */
const rebaja = (quota: bigint, num: bigint, den: bigint): bigint =>
  roundDiv(quota * num, den * 100n) * 100n;

function fail(message: string): never {
  throw new PayrollPackError(`ES Hogar 2026: ${message}`);
}

/** SMI 2026 monthly cost with extras (1.221 × 14 / 12 = 1.424,50), in cents. */
const SMI_MENSUAL_CON_EXTRAS_CENTS = 142450n;
/** SMI-hora hogar 2026 (all concepts), in euro-cents per hour. */
const SMI_HORA_HOGAR_CENTS = 955n;
/** Full-time month for the art. 15.2 floor (160 h/mes o 40 h/semana). */
const JORNADA_COMPLETA_HORAS = 160;

/** Tramo top (inclusive, cents) → fixed band base (cents). Tramo 8 prices actual pay. */
const ES_HOGAR_TRAMOS_2026: readonly { hasta: bigint; base: bigint }[] = [
  { hasta: 32900n, base: 30600n },
  { hasta: 51000n, base: 43600n },
  { hasta: 69300n, base: 60200n },
  { hasta: 87700n, base: 78500n },
  { hasta: 106100n, base: 97000n },
  { hasta: 124200n, base: 115100n },
  { hasta: 142440n, base: 142440n },
];
/** Top fixed band edge: a floor reference past it has no fixed band (tramo 8 prices actual pay). */
const TOP_TRAMO_FIJO_HASTA = 142440n;

/** Band base for a retribution in cents; tramo 8 returns the pay itself, capped at the tope máximo. */
function tramoBase(retribCents: bigint, topeCents: bigint): bigint {
  for (const tramo of ES_HOGAR_TRAMOS_2026) {
    if (retribCents <= tramo.hasta) return tramo.base;
  }
  return retribCents > topeCents ? topeCents : retribCents;
}

export interface EsHogarInput {
  /** Monthly retribution INCLUDING proportional extra pays (art. 147.1 LGSS), in euros. */
  retribucionMensual: string;
  /** Agreed monthly hours (art. 15.2 full/part-time line). */
  horasMes: number;
  /** All-in hourly pact (art. 15.2(c)); false counts as monthly (art. 15.2(d)). */
  retribucionPorHoras: boolean;
  /** Fixed-term contract: desempleo 8,30 instead of 7,05. */
  contratoTemporal: boolean;
  /** Employer CC benefit: alta_20, familia_numerosa_45 (single caregiver, not cumulative), or ninguno. */
  beneficioCc: "alta_20" | "familia_numerosa_45" | "ninguno";
  /** Tenant-entered AT/EP tarifa rate in percent (employer only). */
  atEpRate: string;
}

export interface EsHogarResult {
  base: string;
  ccTrabajador: string;
  ccEmpresa: string;
  desempleoTrabajador: string;
  desempleoEmpresa: string;
  fogasaEmpresa: string;
  meiTrabajador: string;
  meiEmpresa: string;
  atEpEmpresa: string;
  trabajadorTotal: string;
  empresaTotal: string;
}

/**
 * The 2026 household contribution for one month: band base from the
 * retribution with the art. 15.2 SMI floor, then every applicable rate.
 */
export function calculateEsHogar2026(input: EsHogarInput): EsHogarResult {
  let retribCents: bigint;
  try {
    retribCents = roundDiv(U(input.retribucionMensual), 100n);
  } catch {
    fail(`retribucionMensual "${input.retribucionMensual}" is not a decimal amount`);
  }
  if (retribCents < 0n) fail(`retribucionMensual "${input.retribucionMensual}" must be non-negative`);
  if (!Number.isInteger(input.horasMes) || input.horasMes < 1 || input.horasMes > 744) {
    fail(`horasMes "${input.horasMes}" is not an integer 1–744`);
  }
  if (input.beneficioCc !== "alta_20"
    && input.beneficioCc !== "familia_numerosa_45"
    && input.beneficioCc !== "ninguno") {
    fail(`beneficioCc "${input.beneficioCc}" is not alta_20/familia_numerosa_45/ninguno`);
  }
  let atEpRateUnits: bigint;
  try {
    atEpRateUnits = U(input.atEpRate);
  } catch {
    fail(`atEpRate "${input.atEpRate}" is not a decimal rate`);
  }
  if (atEpRateUnits < 0n || atEpRateUnits > U("100")) {
    fail(`atEpRate "${input.atEpRate}" is not a rate 0–100`);
  }

  const topeCents = roundDiv(U(ES_TOPE_MAXIMO_2026), 100n);
  // Art. 15.2 floor: SMI-equivalent retribution (monthly SMI plus extras,
  // proportional to agreed hours — or SMI-hora × hours for all-in hourly
  // pacts), then the band of that reference. A reference past tramo 7 has
  // no fixed band (tramo 8 prices actual pay), so the floor is the actual
  // retribution itself.
  const refCents = input.retribucionPorHoras
    ? roundDiv(SMI_HORA_HOGAR_CENTS * BigInt(input.horasMes), 100n)
    : roundDiv(
      SMI_MENSUAL_CON_EXTRAS_CENTS * BigInt(Math.min(input.horasMes, JORNADA_COMPLETA_HORAS)),
      BigInt(JORNADA_COMPLETA_HORAS),
    );
  const sueloBase = refCents > TOP_TRAMO_FIJO_HASTA
    ? retribCents
    : tramoBase(refCents, topeCents);
  const baseCents = (() => {
    const bandBase = tramoBase(retribCents, topeCents);
    return bandBase > sueloBase ? bandBase : sueloBase;
  })();
  const base = BigInt(baseCents) * 100n;

  // House convention (shared with the General Regime calculator): cuota
  // takes decimal FRACTIONS, so the agency's percent figures transcribe
  // with the decimal point shifted ("4,70%" → "0.0470").
  const ccTrabajador = cuota(base, "0.0470");
  const ccEmpresaCuota = cuota(base, "0.2360");
  const ccEmpresa = input.beneficioCc === "alta_20"
    ? rebaja(ccEmpresaCuota, 8n, 10n)
    : input.beneficioCc === "familia_numerosa_45"
      ? rebaja(ccEmpresaCuota, 55n, 100n)
      : ccEmpresaCuota;

  const desEmpresaRate = input.contratoTemporal ? "0.0670" : "0.0550";
  const desTrabajadorRate = input.contratoTemporal ? "0.0160" : "0.0155";
  const desempleoTrabajador = cuota(base, desTrabajadorRate);
  const desempleoEmpresa = rebaja(cuota(base, desEmpresaRate), 2n, 10n);
  const fogasaEmpresa = rebaja(cuota(base, "0.0020"), 2n, 10n);
  const meiTrabajador = cuota(base, "0.0015");
  const meiEmpresa = cuota(base, "0.0075");
  // The tenant enters the tarifa as a PERCENT (validated 0–100 above), so
  // the extra factor of 100 folds into this call's divisor — full precision,
  // no intermediate truncation to two decimals.
  const atEpEmpresa = roundDiv(base * atEpRateUnits, 10000n * 100n * 100n) * 100n;

  const trabajadorTotal = ccTrabajador + desempleoTrabajador + meiTrabajador;
  const empresaTotal = ccEmpresa + desempleoEmpresa + fogasaEmpresa + meiEmpresa + atEpEmpresa;
  return {
    base: D(base),
    ccTrabajador: D(ccTrabajador),
    ccEmpresa: D(ccEmpresa),
    desempleoTrabajador: D(desempleoTrabajador),
    desempleoEmpresa: D(desempleoEmpresa),
    fogasaEmpresa: D(fogasaEmpresa),
    meiTrabajador: D(meiTrabajador),
    meiEmpresa: D(meiEmpresa),
    atEpEmpresa: D(atEpEmpresa),
    trabajadorTotal: D(trabajadorTotal),
    empresaTotal: D(empresaTotal),
  };
}
