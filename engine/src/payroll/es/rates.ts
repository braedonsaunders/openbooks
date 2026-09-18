/**
 * Spain 2026 statutory tables — TRANSCRIBED from the agencies, not invented.
 *
 * Tax year: calendar 2026 (LIRPF art. 12: el período impositivo es el año
 * natural). Two editions, because AEAT replaced the retention algorithm
 * mid-September: the numeric core (TABLA 1, TABLA 2, reducciones, mínimos,
 * SS tipos) is IDENTICAL in both; only the La Palma exceptional-regime
 * window differs:
 * - edition "2026-early" covers pay dates 2026-01-01..2026-09-09,
 * - edition "2026" covers pay dates 2026-09-10..2026-12-31.
 * `ratesForPayDate` throws for any pay date outside 2026: calculating 2027
 * with 2026 constants would be silent wrong money.
 *
 * SOURCES (all fetched September 2026; HTTP 200 with real content):
 *
 * IRPF — AEAT "ALGORITMO DE CÁLCULO DEL TIPO DE RETENCIÓN A CUENTA DEL IRPF
 * PARA LOS RENDIMIENTOS DEL TRABAJO PERSONAL", early edition
 * (https://www3.agenciatributaria.gob.es/static_files/Sede/Programas_ayuda/Retenciones/2026/ALGORITMO_2026.pdf,
 * "EJERCICIO 2026 (Desde 1 de Enero a 9 de septiembre)", "09-09-2026 (SGTT)")
 * and September edition
 * (https://www3.agenciatributaria.gob.es/static_files/Sede/Programas_ayuda/Retenciones/2026/Algoritmo%20Retenciones-2026_10sept.pdf,
 * "EJERCICIO 2026 (a partir de 10 DE SEPTIEMBRE)", "10-09-2026 (SGTT)"),
 * both listed on https://sede.agenciatributaria.gob.es/Sede/Retenciones.shtml
 * ("Aplicable desde 1 de enero hasta 09 de septiembre de 2026" /
 * "Aplicable a partir del 10 de septiembre de 2026").
 * - TABLA 1 (p.29, "Art. 81 RIRPF (según modif. Real Decreto 142/2024, de 6
 *   de febrero)"): "SITUACIÓN 1 --- 17.644 18.694 / SITUACIÓN 2 17.197
 *   18.130 19.262 / SITUACIÓN 3 15.876 16.342 16.867" (columns 0, 1, 2+ hijos).
 * - TABLA 2 (p.30, "ESCALA DE RETENCIÓN"): "0,00 0,00 12.450,00 19,00 /
 *   12.450,00 2.365,50 7.750,00 24,00 / 20.200,00 4.225,50 15.000,00 30,00 /
 *   35.200,00 8.725,50 24.800,00 37,00 / 60.000,00 17.901,50 240.000,00 45,00
 *   / 300.000,00 125.901,50 En adelante 47,00" (BASE hasta / Cuota / Resto
 *   BASE hasta / Porcentaje), with the worked example "Para una base de
 *   24.000,00: Hasta 20.200,00: 4.225,50 / Resto: 24.000,00 – 20.200,00 =
 *   3.800,00: 3.800,00* 0,30 = 1.140,00 / CUOTA 1= 4.225,50 + 1.140, 00 =
 *   5.365,50".
 * - RED20 (p.22, "art. 20 LIRPF, según RD-Ley 4/2024, y art. 83.3.d) RIRPF"):
 *   "Si RNT ≤ 14.852,00: RED20 = 7.302,00" / "Si 14.852,00 < RNT ≤
 *   17.673,52: RED20 = 7.302,00 - [1,75 * (RNT- 14.852,00)]" / "Si 17.673,52
 *   < RNT < 19.747,50: RED20 = 2.364,34 - [1,14 * (RNT- 17.673,52)]" /
 *   "Else: RED20 = 0,00", then "RED20 = REDONDEAR1 (RED20)".
 * - Gastos (p.21-22): "GASTOSGEN = 2.000,00"; "Si MOVIL = S: INCREGASMOVIL =
 *   2.000,00"; discapacidad "INCREGASDISTRA = 7.750,00" (≥65 o 33–65 con
 *   ayuda/movilidad) / "INCREGASDISTRA= 3.500,00" (33–65);
 *   "RNT = RETRIB – IRREGULAR1 – IRREGULAR2 – COTIZACIONES".
 * - PENSION/HIJOS/DESEM (p.22-23): "Si SITUPER = PENSIONISTA: PENSION =
 *   600,00"; "Si NUMDES > 2: HIJOS = 600,00"; "Si SITUPER = DESEMPLEADO:
 *   DESEM = 1.200,00"; "REDU = PENSION + HIJOS + DESEM + CONYUGE" (CONYUGE =
 *   "PENSIÓN COMPENSATORIA A FAVOR DEL CÓNYUGE. IMPORTE FIJADO
 *   JUDICIALMENTE", p.40).
 * - Mínimo del contribuyente (p.24): "MINPER = 5.550,00"; "Si (2026 – AÑOPER)
 *   > 64: 65PER = 1.150,00"; "Si (2026– AÑOPER) >74: 75PER = 1.400,00".
 * - Mínimo por descendientes (p.24-25, order "por orden creciente de AÑODES"):
 *   "Si i = 1: MINDESG = 2.400,00 * ENTERO (i)" / "Si i = 2: MINDESG =
 *   MINDESG + [2.700,00 * ENTERO (i)]" / "Si i = 3: … [4.000,00 * ENTERO
 *   (i)]" / "Else: … [4.500,00 * ENTERO (i)]"; "< 3 AÑOS: Si AÑODES (i) >
 *   2023: MINDES3 = MINDES3 + [2.800,00 * ENTERO (i)]" (adoptados: "AÑOADOP
 *   (i) ≥ AÑODES (i) y AÑOADOP (i) > 2023"); "Si POR ENTERO = S: ENTERO = 1 /
 *   Else: ENTERO = 0,5" (p.10).
 * - Mínimo por ascendientes (p.25-26): "65AS = 65AS + [1.150,00 /
 *   CONVIVENCIA (j)]"; "75AS = 75AS + [1.400,00 / CONVIVENCIA (j)]".
 * - Mínimo por discapacidad (p.26-28): "Si DISCAPER = DESDE65: DISPER =
 *   9.000,00 / Si DISCAPER = DE33A65: DISPER = 3.000,00"; "Si [DISCAPER =
 *   DESDE65 ó (DISCAPER = DE33A65 Y MOVILPER = S)]: ASISPER = 3.000,00";
 *   descendientes "DISDES = DISDES + [ 9.000,00 * ENTERO (i) ]" /
 *   "[ 3.000,00 * ENTERO (i) ]"; ascendientes the same "/ CONVIVENCIA (j)";
 *   asistencia descendiente "[ 3.000,00 * ENTERO (i)]" (DESDE65, o DE33A65
 *   con MOVILDES = S) y ascendiente "[3.000,00 / CONVIVENCIA (j)]" (misma
 *   condición con MOVILAS).
 * - 43% limit (p.31, "art. 85.3 RIRPF, según modif R.D. 1039/2022"): "Si
 *   RETRIB ≤ 35.200,00" then e.g. "Si NUMDES = 1: LIMITE = [RETRIB -
 *   (17.644,00 + PENSION + DESEM)] * 0,43" (same TABLA 1 cells as above,
 *   per situación); "Si CUOTA > LIMITE: CUOTA = LIMITE".
 * - Anualidades art. 7.k (p.30-31): "Si [ANUALIDADES > 0,00 y (BASE –
 *   ANUALIDADES) > 0,00]: BASE1 = BASE – ANUALIDADES / BASE2 = ANUALIDADES /
 *   CUOTA1 = CUOTA1.1+ CUOTA1.2" y "CUOTA 2 = ESCALA (MINPERFA + 1.980)".
 * - Ceuta/Melilla (p.32, both editions): "Si (RESICEME = S y RENCEME = S):
 *   CEUMELI = S"; "Si CEUMELI = S: DIFERENCIA POSITIVA = (CUOTA* 0,40) -
 *   MINOPAGO / Else: DIFERENCIA POSITIVA = CUOTA - MINOPAGO"; floors "Si
 *   (CONTRATO = ESPECIAL y TIPO < 15,00): TIPO = 15,00 / Si (CONTRATO =
 *   INFERIORAÑO y TIPO < 2,00): TIPO = 2,00" and with CEUMELI "TIPO < 6,00"
 *   / "TIPO < 0,80". Vivienda (RD 1975/2008): "Si RETRIB < 33.007,20 y
 *   PRESVIV= S: MINOPAGO = 2,00% *RETRIB", "MINOPAGO = TRUNCAR (MINOPAGO)".
 * - Tipo (p.33): "TIPO = (DIFERENCIAPOSITIVA/RETRIB) * 100 / TIPO = TRUNCAR
 *   (TIPO)"; "TRUNCAR (TIPO), que consiste en truncar el tipo en el segundo
 *   decimal. Ejemplo: TIPO = 17,85964523; TRUNCAR (TIPO) = 17,85";
 *   "IMPORTE = (RETRIB * TIPO) /100 / IMPORTE = REDONDEAR1 (IMPORTE)".
 * - Rounding (p.9 "NOTA IMPORTANTE PARA EL CÁLCULO"): "Todas las variables
 *   que intervienen en los cálculos se utilizan con el máximo número de
 *   decimales, excepto en las que explícitamente se utilicen las funciones
 *   de REDONDEAR o TRUNCAR"; "REDONDEAR1 (...), consistente en redondear al
 *   segundo decimal magnitudes que se consideran «finales», en aplicación
 *   de la normativa sobre introducción del EURO, y teniendo en cuenta que
 *   0,005 se redondea a 0,01."
 * - La Palma window (September edition, p.4): "Real Decreto-Ley 23/2026, de
 *   8 de septiembre, por el que se modifica la D.A. 57ª de la Ley 35/2006,
 *   del IRPF, ampliando con efectos a partir de su entrada en vigor, el 10
 *   de septiembre, para el ejercicio 2026, la aplicación del régimen
 *   excepcional de reducción del tipo de retención a los contribuyentes con
 *   residencia habitual y efectiva en la Isla de la Palma, en los mismos
 *   términos y condiciones que para los contribuyentes con residencia
 *   habitual y efectiva en Ceuta y Melilla." The early edition states the
 *   same regime "no ha sido objeto de prórroga con efectos a partir de 1
 *   de enero de 2026" — hence the two editions.
 * - Regularización (pp.36-37, TIPOREG path with "Si TIPOREG < 0,00:
 *   TIPOREG = 0" and "Si TIPOREG > 47,00: TIPOREG = 47,00") is NOT
 *   implemented: the engine computes the initial tipo only and refuses
 *   regularización inputs by name — see compute-statutory.ts.
 *
 * SEGURIDAD SOCIAL — Orden PJC/297/2026, de 30 de marzo, BOE núm. 79 de
 * 31 de marzo de 2026 (https://www.boe.es/boe/dias/2026/03/31/pdfs/BOE-A-2026-7296.pdf,
 * HTTP 200), "con efectos desde el día 1 de enero de 2026":
 * - Tope máximo (art. 2.1): "El tope máximo de la base de cotización al
 *   Régimen General de la Seguridad Social será, desde el 1 de enero de
 *   2026, de 5.101,20 euros mensuales".
 * - Tope mínimo AT/EP (art. 2.2): "el tope mínimo de cotización para las
 *   contingencias de accidente de trabajo y enfermedad profesional será
 *   equivalente al salario mínimo interprofesional vigente, incrementado en
 *   un sexto, sin que pueda ser inferior a 1.424,40 euros".
 * - Grupos 1–7 (art. 3, €/mes): "1 … 1.989,30 5.101,20 / 2 … 1.649,70
 *   5.101,20 / 3 … 1.435,20 5.101,20 / 4 … 1.424,40 5.101,20 / 5 …
 *   1.424,40 5.101,20 / 6 … 1.424,40 5.101,20 / 7 … 1.424,40 5.101,20";
 *   grupos 8–11 (€/día): "47,48 170,04" for all four.
 * - Contingencias comunes (art. 4.a): "el 28,30 por ciento, del que el
 *   23,60 por ciento será a cargo de la empresa y el 4,70 por ciento, a
 *   cargo de la persona trabajadora".
 * - AT/EP (art. 4.b): "se aplicarán los tipos de la tarifa de primas
 *   establecida en la disposición adicional sexagésima primera" del LGSS,
 *   "siendo las primas resultantes a cargo exclusivo de la empresa" — rated
 *   by activity, so tenant-entered, NEVER transcribed here.
 * - Horas extra (art. 5): fuerza mayor "el tipo del 14,00 por ciento, del
 *   que el 12,00 por ciento será a cargo de la empresa y el 2,00 por
 *   ciento, a cargo de la persona trabajadora"; resto "el tipo del 28,30
 *   por ciento, del que el 23,60 por ciento será a cargo de la empresa y
 *   el 4,70 por ciento, a cargo de la persona trabajadora".
 * - Desempleo (art. 33.2.a): indefinida "7,05 por ciento, del que el 5,5
 *   por ciento será a cargo de la empresa y el 1,55 por ciento, a cargo de
 *   la persona trabajadora"; temporal "8,30 por ciento, del que el 6,70
 *   por ciento será a cargo del empresario y el 1,60 por ciento, a cargo
 *   de la persona trabajadora".
 * - FOGASA (art. 33.2.b): "el 0,20 por ciento, a cargo de la empresa".
 * - Formación (art. 33.2.c): "el 0,70 por ciento, del que el 0,60 por
 *   ciento será a cargo de la empresa y el 0,10 por ciento, a cargo de la
 *   persona trabajadora".
 * - MEI (art. 16): "aplicando el tipo del 0,90 por ciento sobre la base de
 *   cotización por contingencias comunes, del que el 0,75 por ciento será
 *   a cargo del empleador y el 0,15 por ciento, a cargo de la persona
 *   trabajadora".
 * - Solidaridad (art. 17.1): "El 1,15 por ciento a la parte de la
 *   retribución comprendida entre 5.101,21 euros y 5.611,32 euros, siendo
 *   el 0,96 por ciento a cargo de la empresa y el 0,19 por ciento a cargo
 *   de la persona trabajadora" / "El 1,25 por ciento a la parte …
 *   entre 5.611,33 euros y 7.651,80 euros, siendo el 1,04 por ciento …
 *   y el 0,21 por ciento …" / "El 1,46 por ciento a la parte … que supere
 *   los 7.651,80 euros, siendo el 1,22 por ciento … y el 0,24 por ciento …".
 *
 * SS rounding is ENGINE-STATED, not agency-quoted (AU precedent): the Orden
 * states no rounding rule, so each cuota rounds half-up to the cent
 * (REDONDEAR1-style). AT/EP is tenant-entered and never computed from a
 * transcribed rate.
 *
 * FETCH HONESTY: sede.agenciatributaria.gob.es, www3.agenciatributaria.gob.es
 * and boe.es all returned HTTP 200 with real bodies. www.seg-social.es
 * returned HTTP 200 with a JS-portal shell (no quotable figures in the
 * static body) — nothing from that host is cited; the SS figures come from
 * the BOE Orden instead. No vendor, law-firm, OECD or other-ERP source is
 * cited anywhere.
 */
import type { PayrollTaxYearSupport } from "../tax-years.ts";
import type { PayrollPackRates } from "../statutory-rates.ts";

export const ES_RATES_MODULE = "engine/src/payroll/es/rates.ts";

/** Situación familiar (Modelo 145 datum, RIRPF art. 81-83). */
export type EsSituacionFamiliar = "1" | "2" | "3";

/** One TABLA 2 row: cuota acumulada hasta `hasta`, then `porcentaje` on the resto. */
export interface EsIrpfEscalaTramo {
  /** Upper base edge in euro, null for the final open row. */
  readonly hasta: string | null;
  /** Cuota acumulada at `hasta`. */
  readonly cuota: string;
  /** Width of the resto band above `hasta`, null for the final open row. */
  readonly restoHasta: string | null;
  /** Marginal rate as a decimal fraction string. */
  readonly porcentaje: string;
}

/** TABLA 2 — ESCALA DE RETENCIÓN (identical in both 2026 editions). */
export const ES_IRPF_ESCALA_2026: readonly EsIrpfEscalaTramo[] = [
  { hasta: "0", cuota: "0", restoHasta: "12450", porcentaje: "0.19" },
  { hasta: "12450", cuota: "2365.50", restoHasta: "7750", porcentaje: "0.24" },
  { hasta: "20200", cuota: "4225.50", restoHasta: "15000", porcentaje: "0.30" },
  { hasta: "35200", cuota: "8725.50", restoHasta: "24800", porcentaje: "0.37" },
  { hasta: "60000", cuota: "17901.50", restoHasta: "240000", porcentaje: "0.45" },
  { hasta: "300000", cuota: "125901.50", restoHasta: null, porcentaje: "0.47" },
];

/** TABLA 1 — exclusion limits by situación and descendiente count band. */
export interface EsIrpfTabla1 {
  readonly unDescendiente: string;
  readonly dosOMas: string;
  readonly cero: string | null;
}

/** TABLA 1 limits (situación 1 has no 0-descendiente cell: it requires ≥1). */
export const ES_IRPF_TABLA1_2026: Readonly<Record<EsSituacionFamiliar, EsIrpfTabla1>> = {
  "1": { cero: null, unDescendiente: "17644", dosOMas: "18694" },
  "2": { cero: "17197", unDescendiente: "18130", dosOMas: "19262" },
  "3": { cero: "15876", unDescendiente: "16342", dosOMas: "16867" },
};

/** Reducción por obtención de rendimientos del trabajo (art. 20 LIRPF). */
export const ES_RED20_2026 = {
  tramo1Hasta: "14852",
  tramo1Importe: "7302",
  tramo2Hasta: "17673.52",
  tramo2Pendiente: "1.75",
  tramo3Hasta: "19747.50",
  tramo3Base: "2364.34",
  tramo3Pendiente: "1.14",
} as const;

/** Otros gastos deducibles (art. 19 LIRPF): general, movilidad, discapacidad. */
export const ES_GASTOS_2026 = {
  general: "2000",
  movilidad: "2000",
  discapacidadAlta: "7750",
  discapacidadMedia: "3500",
} as const;

/** PENSION / HIJOS / DESEM reducciones. */
export const ES_REDUCCIONES_2026 = {
  pensionista: "600",
  masDeDosDescendientes: "600",
  desempleado: "1200",
} as const;

/** Mínimo personal y familiar del contribuyente. */
export const ES_MINIMO_CONTRIBUYENTE_2026 = {
  general: "5550",
  mayor65: "1150",
  mayor75: "1400",
} as const;

/** Mínimo por descendientes: 1º/2º/3º/4º+ and <3 años. */
export const ES_MINIMO_DESCENDIENTES_2026 = {
  primero: "2400",
  segundo: "2700",
  tercero: "4000",
  cuartoOMas: "4500",
  menorDeTres: "2800",
} as const;

/** Mínimo por ascendientes ≥65 / ≥75 (each divided by convivencia). */
export const ES_MINIMO_ASCENDIENTES_2026 = {
  mayor65: "1150",
  mayor75: "1400",
} as const;

/** Mínimo por discapacidad: grados and asistencia. */
export const ES_MINIMO_DISCAPACIDAD_2026 = {
  desde65: "9000",
  de33a65: "3000",
  asistencia: "3000",
} as const;

/** Anualidades art. 7.k offset added to MINPERFA in the split CUOTA2. */
export const ES_ANUALIDADES_MINPERFA_OFFSET = "1980";

/** 43% cap (art. 85.3): applies when RETRIB ≤ this. */
export const ES_LIMITE_43_RETRIB_MAX = "35200";
export const ES_LIMITE_43_FACTOR = "0.43";

/** Vivienda habitual (RD 1975/2008): threshold and 2% factor. */
export const ES_PRESVIV_RETRIB_MAX = "33007.20";
export const ES_PRESVIV_FACTOR = "0.02";

/** Minimum tipo floors by contract (general / Ceuta-Melilla-La Palma). */
export const ES_TIPO_MINIMO_2026 = {
  especial: "15",
  inferiorAno: "2",
  especialCeutaMelilla: "6",
  inferiorAnoCeutaMelilla: "0.80",
} as const;

/** Ceuta/Melilla(/La Palma) reduction factor applied to CUOTA. */
export const ES_CEUMELI_FACTOR = "0.40";

/** Monthly/daily base regime for a grupo de cotización. */
export type EsGrupoRegimen = "mensual" | "diaria";

/** One grupo de cotización: base mínima/máxima for 2026. */
export interface EsGrupoCotizacion {
  readonly grupo: number;
  readonly regimen: EsGrupoRegimen;
  readonly minima: string;
  readonly maxima: string;
}

/** Grupos 1–11 (art. 3 Orden PJC/297/2026). */
export const ES_GRUPOS_2026: readonly EsGrupoCotizacion[] = [
  { grupo: 1, regimen: "mensual", minima: "1989.30", maxima: "5101.20" },
  { grupo: 2, regimen: "mensual", minima: "1649.70", maxima: "5101.20" },
  { grupo: 3, regimen: "mensual", minima: "1435.20", maxima: "5101.20" },
  { grupo: 4, regimen: "mensual", minima: "1424.40", maxima: "5101.20" },
  { grupo: 5, regimen: "mensual", minima: "1424.40", maxima: "5101.20" },
  { grupo: 6, regimen: "mensual", minima: "1424.40", maxima: "5101.20" },
  { grupo: 7, regimen: "mensual", minima: "1424.40", maxima: "5101.20" },
  { grupo: 8, regimen: "diaria", minima: "47.48", maxima: "170.04" },
  { grupo: 9, regimen: "diaria", minima: "47.48", maxima: "170.04" },
  { grupo: 10, regimen: "diaria", minima: "47.48", maxima: "170.04" },
  { grupo: 11, regimen: "diaria", minima: "47.48", maxima: "170.04" },
];

/** Tope máximo mensual Régimen General (art. 2.1). */
export const ES_TOPE_MAXIMO_2026 = "5101.20";
/** Floor for the AT/EP minimum and daily-regime coherence (art. 2.2). */
export const ES_TOPE_MINIMO_AT_2026 = "1424.40";

/** Split rate: [total, empresa, trabajador] as decimal fraction strings. */
export interface EsTipoSplit {
  readonly total: string;
  readonly empresa: string;
  readonly trabajador: string;
}

/** Tipos de cotización Régimen General 2026. */
export const ES_TIPOS_2026 = {
  contingenciasComunes: { total: "0.2830", empresa: "0.2360", trabajador: "0.0470" },
  desempleoIndefinido: { total: "0.0705", empresa: "0.0550", trabajador: "0.0155" },
  desempleoTemporal: { total: "0.0830", empresa: "0.0670", trabajador: "0.0160" },
  fogasa: { total: "0.0020", empresa: "0.0020", trabajador: "0" },
  formacion: { total: "0.0070", empresa: "0.0060", trabajador: "0.0010" },
  mei: { total: "0.0090", empresa: "0.0075", trabajador: "0.0015" },
  horasExtraFuerzaMayor: { total: "0.14", empresa: "0.12", trabajador: "0.02" },
  horasExtraResto: { total: "0.2830", empresa: "0.2360", trabajador: "0.0470" },
} as const satisfies Record<string, EsTipoSplit>;

/** Solidaridad tranches above the tope máximo (art. 17.1). */
export interface EsSolidaridadTramo {
  /** Lower edge (exclusive) in euro. */
  readonly desde: string;
  /** Upper edge (inclusive) in euro, null for the final open tranche. */
  readonly hasta: string | null;
  readonly tipos: EsTipoSplit;
}

export const ES_SOLIDARIDAD_2026: readonly EsSolidaridadTramo[] = [
  {
    desde: "5101.20",
    hasta: "5611.32",
    tipos: { total: "0.0115", empresa: "0.0096", trabajador: "0.0019" },
  },
  {
    desde: "5611.32",
    hasta: "7651.80",
    tipos: { total: "0.0125", empresa: "0.0104", trabajador: "0.0021" },
  },
  {
    desde: "7651.80",
    hasta: null,
    tipos: { total: "0.0146", empresa: "0.0122", trabajador: "0.0024" },
  },
];

/** A 2026 edition: shared numeric core, distinct La Palma window + citation. */
export interface EsEdition {
  readonly edition: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string;
  /** La Palma exceptional regime (D.A. 57ª) in force for this edition. */
  readonly laPalmaExcepcional: boolean;
  readonly citation: string;
}

const CITATION_EARLY =
  "AEAT ALGORITMO_2026.pdf (09-09-2026 SGTT), aplicable 1 de enero–9 de septiembre de 2026; "
  + "Orden PJC/297/2026 (BOE-A-2026-7296, BOE 31-3-2026, efectos 1-1-2026)";
const CITATION_SEPT =
  "AEAT Algoritmo Retenciones-2026_10sept.pdf (10-09-2026 SGTT), aplicable desde el 10 de "
  + "septiembre de 2026 (RD-Ley 23/2026, D.A. 57ª: La Palma); "
  + "Orden PJC/297/2026 (BOE-A-2026-7296, BOE 31-3-2026, efectos 1-1-2026)";

const EDITION_2026_EARLY: EsEdition = {
  edition: "2026-early",
  effectiveFrom: "2026-01-01",
  effectiveTo: "2026-09-09",
  laPalmaExcepcional: false,
  citation: CITATION_EARLY,
};

const EDITION_2026: EsEdition = {
  edition: "2026",
  effectiveFrom: "2026-09-10",
  effectiveTo: "2026-12-31",
  laPalmaExcepcional: true,
  citation: CITATION_SEPT,
};

/**
 * Resolve the 2026 edition for a pay date. Throws for any date outside
 * 2026-01-01..2026-12-31 — never extrapolate, never clamp to the nearest
 * table. A date either side of 2026-09-10 resolves to different editions.
 */
export function ratesForPayDate(payDate: string): EsEdition {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) {
    throw new Error(`ES payroll: pay date is not an ISO date: "${payDate}"`);
  }
  if (payDate < "2026-01-01" || payDate > "2026-12-31") {
    throw new Error(
      `ES payroll: no transcribed tables for pay date ${payDate} — 2026 only`,
    );
  }
  return payDate < "2026-09-10" ? EDITION_2026_EARLY : EDITION_2026;
}

export const ES_TAX_YEARS: PayrollTaxYearSupport = {
  country: "ES",
  editions: [
    {
      year: 2026,
      label: "2026 IRPF retention algorithm + TGSS tables (January edition, to 9 September)",
      effectiveFrom: "2026-01-01",
      citation: CITATION_EARLY,
      status: "published",
    },
    {
      year: 2026,
      label: "2026 IRPF retention algorithm (September edition: La Palma D.A. 57ª from 10 September)",
      effectiveFrom: "2026-09-10",
      citation: CITATION_SEPT,
      status: "published",
    },
  ],
  regionsWithOwnTables: ["NC", "PV"],
  ratesModule: ES_RATES_MODULE,
  scaffold: {
    files: [
      {
        path: ES_RATES_MODULE,
        purpose: "AEAT retention algorithm editions + TGSS contribution bases/tipos, versioned by year",
        template:
          "Transcribe the AEAT ALGORITMO for {year} (Sede/Programas_ayuda/Retenciones/{year}/) "
          + "and the TGSS Orden de cotización for {year}, beside the {priorYear} edition.",
      },
    ],
    barrels: [],
    steps: [
      "Fetch the AEAT ALGORITMO for the year from Sede/Programas_ayuda/Retenciones and transcribe "
        + "the situación-familiar brackets, TABLA 1 exclusion limits, and hijos reductions.",
      "Transcribe the TGSS Orden de cotización (bases mínimas/máximas, tipos empresa/trabajador, MEI).",
      "Transcribe or explicitly refuse the foral tables (Navarra; Álava/Araba, Gipuzkoa, Bizkaia).",
      "Add golden stubs and flip the pack to installable.",
    ],
  },
};

export const ES_PACK_RATES: PayrollPackRates = {
  country: "ES",
  slots: [],
};
