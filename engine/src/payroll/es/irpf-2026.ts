/**
 * Spain 2026 IRPF retention engine — pure, no database, no clock.
 *
 * Implements the AEAT "procedimiento general para determinar el tipo de
 * retención" (RIRPF arts. 80–89) as published in the ALGORITMO documents
 * transcribed in ./rates.ts: annual projected remuneration → gastos and
 * reducciones → mínimo personal y familiar → base → CUOTA1/CUOTA2 via the
 * escala → 43% limit → tipo truncated → annual importe rounded. It is NOT a
 * band lookup on period pay: the tipo is annual and divides back per period.
 *
 * Money discipline: decimal strings in, bigint 1e4 units inside (money.ts),
 * never floats. REDONDEAR1 is half-up to the cent ("0,005 se redondea a
 * 0,01"); TRUNCAR drops past the second decimal ("TIPO = 17,85964523;
 * TRUNCAR (TIPO) = 17,85"). Everything else runs at full precision.
 *
 * Named refusals (never guessed): REGULARIZACIÓN inputs (the TIPOREG
 * mid-year path, ALGORITMO pp.36–37); La Palma exceptional claims before
 * 2026-09-10 (RD-Ley 23/2026 window); situación 1 with no descendientes
 * (ALGORITMO validation 14); PRESVIV at or above 33.007,20 € (validation
 * 21); IRREGULAR1 above 90.000 or above 30% of RETRIB (validations 19–20).
 */
import { fromUnits, roundDiv, toUnits } from "../../money/money.ts";
import { PayrollPackError } from "../payroll-error.ts";
import {
  ES_ANUALIDADES_MINPERFA_OFFSET,
  ES_CEUMELI_FACTOR,
  ES_GASTOS_2026,
  ES_IRPF_ESCALA_2026,
  ES_IRPF_TABLA1_2026,
  ES_LIMITE_43_FACTOR,
  ES_LIMITE_43_RETRIB_MAX,
  ES_MINIMO_ASCENDIENTES_2026,
  ES_MINIMO_CONTRIBUYENTE_2026,
  ES_MINIMO_DESCENDIENTES_2026,
  ES_MINIMO_DISCAPACIDAD_2026,
  ES_PRESVIV_FACTOR,
  ES_PRESVIV_RETRIB_MAX,
  ES_RED20_2026,
  ES_REDUCCIONES_2026,
  ES_TIPO_MINIMO_2026,
  ratesForPayDate,
  type EsEdition,
  type EsSituacionFamiliar,
} from "./rates.ts";

const U = (s: string): bigint => toUnits(s);
const D = (u: bigint): string => fromUnits(u);
/** REDONDEAR1: half-up to the cent. */
const R1 = (u: bigint): bigint => roundDiv(u, 100n) * 100n;

export type EsDiscapacidad = "none" | "de33a65" | "desde65";
export type EsContrato = "general" | "inferiorAno" | "especial" | "manuales";
export type EsZonaExcepcional = "ninguna" | "ceuta-melilla" | "la-palma";

export interface EsDescendiente {
  readonly birthYear: number;
  /** POR ENTERO: 1 whole, 0.5 shared (ALGORITMO: "ENTERO = 1 / 0,5"). */
  readonly entero: 1 | 0.5;
  readonly adopcionYear?: number | null;
  readonly discapacidad: EsDiscapacidad;
  readonly movilidadReducida: boolean;
}

export interface EsAscendiente {
  readonly mayor75: boolean;
  /** CONVIVENCIA: persons sharing the ascendiente's support (1–9). */
  readonly convivencia: number;
  readonly discapacidad: EsDiscapacidad;
  readonly movilidadReducida: boolean;
}

export interface EsIrpfInput {
  readonly payDate: string;
  /** RETRIB: total annual remuneration, must exceed 0. */
  readonly retribuciones: string;
  /** COTIZACIONES (art. 19.2 a–c): employee SS and assimilated. */
  readonly cotizaciones?: string;
  readonly irregular1?: string;
  readonly irregular2?: string;
  readonly situacionFamiliar: EsSituacionFamiliar;
  readonly descendientes?: readonly EsDescendiente[];
  readonly ascendientes?: readonly EsAscendiente[];
  /** AÑOPER: perceptor birth year. */
  readonly birthYear: number;
  readonly pensionista?: boolean;
  readonly desempleado?: boolean;
  readonly movilidadGeografica?: boolean;
  readonly discapacidad?: EsDiscapacidad;
  /** MOVILPER: needs third-person help or reduced mobility. */
  readonly ayudaMovilidad?: boolean;
  readonly contrato?: EsContrato;
  /** CONYUGE: court-ordered compensatory pension (a REDU reduction). */
  readonly pensionCompensatoria?: string;
  /** ANUALIDADES art. 7.k (child support annuities). */
  readonly anualidades?: string;
  readonly presVivienda?: boolean;
  readonly zona?: EsZonaExcepcional;
  /** RENCEME: the yields themselves were obtained in the zone. */
  readonly rendimientosZona?: boolean;
}

export interface EsIrpfResult {
  readonly edition: string;
  readonly exento: boolean;
  /** TIPO: percent with exactly two decimals, truncated. */
  readonly tipo: string;
  /** Annual withholding at the truncated tipo, rounded. */
  readonly importeAnual: string;
  readonly cuota: string;
  readonly base: string;
  readonly minimoPersonalFamiliar: string;
}

function fail(message: string): never {
  throw new PayrollPackError(`ES IRPF 2026: ${message}`);
}

function amount(value: string | undefined, fallback: string, what: string): bigint {
  const raw = value ?? fallback;
  let parsed: bigint;
  try {
    parsed = U(raw);
  } catch {
    fail(`${what} is not a decimal amount: "${raw}"`);
  }
  if (parsed < 0n) fail(`${what} must be non-negative, got "${raw}"`);
  return parsed;
}

/**
 * ESCALA: apply TABLA 2 to a base, exact at 1e4 units. Each row's `hasta` is
 * the LOWER edge holding `cuota`, with `porcentaje` on the resto above it
 * (ALGORITMO example: base 24.000 → "Hasta 20.200,00: 4.225,50" plus
 * "3.800,00 * 0,30 = 1.140,00").
 */
/** Test hook: TABLA 2 applied to a base, returned as canonical units. */
export function escalaIrpf2026(base: string): string {
  return D(escala(U(base)));
}

function escala(base: bigint): bigint {
  let cuota = 0n;
  let edge = 0n;
  let pct = U(ES_IRPF_ESCALA_2026[0]!.porcentaje);
  for (const tramo of ES_IRPF_ESCALA_2026) {
    if (tramo.hasta !== null && U(tramo.hasta) > base) break;
    cuota = U(tramo.cuota);
    if (tramo.hasta !== null) edge = U(tramo.hasta);
    pct = U(tramo.porcentaje);
  }
  return cuota + ((base - edge) * pct) / 10000n;
}

/** TABLA 1 cell for a situación + descendiente count. */
function tabla1Cell(sit: EsSituacionFamiliar, numdes: number): bigint {
  const row = ES_IRPF_TABLA1_2026[sit];
  if (numdes <= 0) {
    if (row.cero === null) fail("situación familiar 1 requires at least one descendiente");
    return U(row.cero);
  }
  return U(numdes === 1 ? row.unDescendiente : row.dosOMas);
}

function enteroParts(entero: 1 | 0.5): { num: bigint; den: bigint } {
  return entero === 1 ? { num: 1n, den: 1n } : { num: 1n, den: 2n };
}

/** Share of a euro rate (given in cents) by entero fraction and convivencia. */
function shareCents(rateCents: bigint, entero: 1 | 0.5, convivencia: number): bigint {
  const { num, den } = enteroParts(entero);
  return roundDiv(rateCents * num, den * BigInt(convivencia));
}

export function calculateEsIrpf2026(input: EsIrpfInput): EsIrpfResult {
  const edition: EsEdition = ratesForPayDate(input.payDate);
  const zona: EsZonaExcepcional = input.zona ?? "ninguna";
  if (zona === "la-palma" && !edition.laPalmaExcepcional) {
    fail(
      "La Palma exceptional regime (D.A. 57ª) is not in force before 2026-09-10 "
      + "(RD-Ley 23/2026, effects 10 September) — refusing, never backdating",
    );
  }
  const retrib = amount(input.retribuciones, "", "RETRIB");
  if (retrib <= 0n) fail('RETRIB must exceed 0 ("Las retribuciones totales son obligatorias")');
  const cotiz = amount(input.cotizaciones, "0", "COTIZACIONES");
  const irreg1 = amount(input.irregular1, "0", "IRREGULAR1");
  const irreg2 = amount(input.irregular2, "0", "IRREGULAR2");
  if (irreg1 > U("90000")) fail("IRREGULAR1 exceeds 90.000 € (art. 18.2 LIRPF cap)");
  if (irreg1 * 10n > retrib * 3n) fail("IRREGULAR1 exceeds 30% of RETRIB (art. 18.2 LIRPF cap)");
  const conyuge = amount(input.pensionCompensatoria, "0", "CONYUGE");
  const anualidades = amount(input.anualidades, "0", "ANUALIDADES");
  if (input.presVivienda === true && retrib >= U(ES_PRESVIV_RETRIB_MAX)) {
    fail("PRESVIV needs RETRIB below 33.007,20 € — deactivate the vivienda box");
  }
  const descendientes = input.descendientes ?? [];
  const ascendientes = input.ascendientes ?? [];
  const numdes = descendientes.length;
  if (input.situacionFamiliar === "1" && numdes === 0) {
    fail('situación familiar "1" needs a descendiente (monoparental joint-taxation reduction)');
  }
  for (const [i, d] of descendientes.entries()) {
    if (!Number.isInteger(d.birthYear) || d.birthYear < 1906 || d.birthYear > 2026) {
      fail(`descendiente ${i + 1}: birth year out of range 1906–2026`);
    }
    if (d.entero !== 1 && d.entero !== 0.5) fail(`descendiente ${i + 1}: entero is 1 or 0.5`);
  }
  for (const [j, a] of ascendientes.entries()) {
    if (!Number.isInteger(a.convivencia) || a.convivencia < 1 || a.convivencia > 9) {
      fail(`ascendiente ${j + 1}: convivencia is 1–9`);
    }
  }

  const pensionista = input.pensionista === true;
  const desempleado = input.desempleado === true;
  const activo = !pensionista && !desempleado;
  const pension = pensionista ? U(ES_REDUCCIONES_2026.pensionista) : 0n;
  const hijos = numdes > 2 ? U(ES_REDUCCIONES_2026.masDeDosDescendientes) : 0n;
  const desem = desempleado ? U(ES_REDUCCIONES_2026.desempleado) : 0n;

  // A. Exención (TABLA 1): RETRIB at or below the cell + PENSION + DESEM.
  const cell = tabla1Cell(input.situacionFamiliar, numdes);
  if (retrib <= cell + pension + desem) {
    return {
      edition: edition.edition,
      exento: true,
      tipo: "0.00",
      importeAnual: D(0n),
      cuota: D(0n),
      base: D(0n),
      minimoPersonalFamiliar: D(0n),
    };
  }

  // B. Gastos deducibles.
  const disc = input.discapacidad ?? "none";
  const ayuda = input.ayudaMovilidad === true;
  let incrementoDisc = 0n;
  if (activo) {
    if (disc === "desde65" || (disc === "de33a65" && ayuda)) {
      incrementoDisc = U(ES_GASTOS_2026.discapacidadAlta);
    } else if (disc === "de33a65") {
      incrementoDisc = U(ES_GASTOS_2026.discapacidadMedia);
    }
  }
  let otros = U(ES_GASTOS_2026.general)
    + (input.movilidadGeografica === true ? U(ES_GASTOS_2026.movilidad) : 0n)
    + incrementoDisc;
  const retribMenosCotiz = retrib - cotiz;
  if (retribMenosCotiz < 0n) otros = 0n;
  else if (otros > retribMenosCotiz) otros = retribMenosCotiz;

  // C. RNT and RED20.
  let rnt = retrib - irreg1 - irreg2 - cotiz;
  if (rnt < 0n) rnt = 0n;
  const R = ES_RED20_2026;
  let red20: bigint;
  if (rnt <= U(R.tramo1Hasta)) {
    red20 = U(R.tramo1Importe);
  } else if (rnt <= U(R.tramo2Hasta)) {
    red20 = U(R.tramo1Importe) - ((rnt - U(R.tramo1Hasta)) * 7n) / 4n;
  } else if (rnt < U(R.tramo3Hasta)) {
    red20 = U(R.tramo3Base) - ((rnt - U(R.tramo2Hasta)) * 57n) / 50n;
  } else {
    red20 = 0n;
  }
  red20 = R1(red20);
  let rntRedu = rnt - otros - red20;
  if (rntRedu < 0n) rntRedu = 0n;

  // D. Mínimo personal y familiar.
  const age = 2026 - input.birthYear;
  const mincon = U(ES_MINIMO_CONTRIBUYENTE_2026.general)
    + (age > 64 ? U(ES_MINIMO_CONTRIBUYENTE_2026.mayor65) : 0n)
    + (age > 74 ? U(ES_MINIMO_CONTRIBUYENTE_2026.mayor75) : 0n);
  const ordenados = [...descendientes].sort((a, b) => a.birthYear - b.birthYear);
  const MD = ES_MINIMO_DESCENDIENTES_2026;
  const tramosDesc = [MD.primero, MD.segundo, MD.tercero];
  let mindesg = 0n;
  let mindes3 = 0n;
  ordenados.forEach((d, index) => {
    const tramo = index < 3 ? U(tramosDesc[index]!) : U(MD.cuartoOMas);
    mindesg += shareCents(tramo / 100n, d.entero, 1);
    const menor3 = d.birthYear > 2023
      || (d.adopcionYear != null && d.adopcionYear >= d.birthYear && d.adopcionYear > 2023);
    if (menor3) mindes3 += shareCents(U(MD.menorDeTres) / 100n, d.entero, 1);
  });
  mindesg = R1(mindesg * 100n);
  mindes3 = R1(mindes3 * 100n);
  const mindes = mindesg + mindes3;
  let as65 = 0n;
  let as75 = 0n;
  for (const a of ascendientes) {
    as65 += shareCents(U(ES_MINIMO_ASCENDIENTES_2026.mayor65) / 100n, 1, a.convivencia);
    if (a.mayor75) as75 += shareCents(U(ES_MINIMO_ASCENDIENTES_2026.mayor75) / 100n, 1, a.convivencia);
  }
  as65 = R1(as65 * 100n);
  as75 = R1(as75 * 100n);
  const minas = as65 + as75;
  const MDI = ES_MINIMO_DISCAPACIDAD_2026;
  const grado = (g: EsDiscapacidad): bigint =>
    g === "desde65" ? U(MDI.desde65) : g === "de33a65" ? U(MDI.de33a65) : 0n;
  const asisContrib = disc === "desde65" || (disc === "de33a65" && ayuda) ? U(MDI.asistencia) : 0n;
  let disdes = 0n;
  let asisdes = 0n;
  for (const d of descendientes) {
    disdes += shareCents(grado(d.discapacidad) / 100n, d.entero, 1);
    if (d.discapacidad === "desde65" || (d.discapacidad === "de33a65" && d.movilidadReducida)) {
      asisdes += shareCents(U(MDI.asistencia) / 100n, d.entero, 1);
    }
  }
  disdes = R1(disdes * 100n);
  asisdes = R1(asisdes * 100n);
  let disas = 0n;
  let asisas = 0n;
  for (const a of ascendientes) {
    disas += shareCents(grado(a.discapacidad) / 100n, 1, a.convivencia);
    if (a.discapacidad === "desde65" || (a.discapacidad === "de33a65" && a.movilidadReducida)) {
      asisas += shareCents(U(MDI.asistencia) / 100n, 1, a.convivencia);
    }
  }
  disas = R1(disas * 100n);
  asisas = R1(asisas * 100n);
  const mindis = grado(disc) + asisContrib + disdes + disas + asisdes + asisas;
  const minperfa = mincon + mindes + minas + mindis;

  // E. Base.
  const redu = pension + hijos + desem + conyuge;
  const base = rntRedu > redu ? rntRedu - redu : 0n;

  // F. Cuotas via TABLA 2, with the anualidades split.
  let cuota1: bigint;
  let cuota2: bigint;
  if (anualidades > 0n && base - anualidades > 0n) {
    cuota1 = escala(base - anualidades) + escala(anualidades);
    cuota2 = escala(minperfa + U(ES_ANUALIDADES_MINPERFA_OFFSET));
  } else {
    cuota1 = escala(base);
    cuota2 = escala(minperfa);
  }
  let cuota = cuota1 > cuota2 ? cuota1 - cuota2 : 0n;

  // G. 43% limit (art. 85.3): "LIMITE = [RETRIB - (cell + PENSION + DESEM)] * 0,43".
  if (retrib <= U(ES_LIMITE_43_RETRIB_MAX)) {
    const limite = ((retrib - cell - pension - desem) * U(ES_LIMITE_43_FACTOR)) / 10000n;
    if (cuota > limite) cuota = limite;
  }

  // H. Tipo: Ceuta/Melilla(/La Palma) reduction, vivienda offset, truncate, floors.
  const ceumeli = zona !== "ninguna" && input.rendimientosZona === true;
  // "MINOPAGO = 2,00% * RETRIB" then "MINOPAGO = TRUNCAR (MINOPAGO)":
  // floor to the cent (2% of a 2dp amount can carry a sub-cent tail).
  const minopago = input.presVivienda === true
    ? ((retrib * U(ES_PRESVIV_FACTOR)) / 10000n / 100n) * 100n
    : 0n;
  // "DIFERENCIA POSITIVA = (CUOTA * 0,40) - MINOPAGO" with CEUMELI, else "CUOTA - MINOPAGO".
  // The 1e4-unit scale floors sub-0,0001 € remainders of the 0,40 product;
  // every other step of the chain is exact at this scale.
  const rebajada = (cuota * U(ES_CEUMELI_FACTOR)) / 10000n;
  let diferencia = (ceumeli ? rebajada : cuota) - minopago;
  if (diferencia < 0n) diferencia = 0n;
  // TRUNCAR: hundredths of a percent, dropped.
  let hundredths = (diferencia * 10000n) / retrib;
  const contrato: EsContrato = input.contrato ?? "general";
  const T = ES_TIPO_MINIMO_2026;
  const floorPct = ceumeli
    ? contrato === "especial" ? U(T.especialCeutaMelilla) : contrato === "inferiorAno" ? U(T.inferiorAnoCeutaMelilla) : 0n
    : contrato === "especial" ? U(T.especial) : contrato === "inferiorAno" ? U(T.inferiorAno) : 0n;
  const floorHundredths = floorPct / 100n;
  if (hundredths < floorHundredths) hundredths = floorHundredths;
  const tipo = `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, "0")}`;

  // I. Annual importe at the truncated tipo, rounded.
  const importe = roundDiv(retrib * hundredths, 10000n * 100n) * 100n;

  return {
    edition: edition.edition,
    exento: false,
    tipo,
    importeAnual: D(importe),
    cuota: D(cuota),
    base: D(base),
    minimoPersonalFamiliar: D(minperfa),
  };
}
