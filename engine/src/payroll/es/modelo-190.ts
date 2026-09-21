/**
 * The Modelo 190 perception-key classification for payroll the ES engine prices.
 *
 * Authority: AEAT "Diseños lógicos — Modelo 190, Declaración Informativa.
 * Retenciones e ingresos a cuenta ... Resumen anual", ejercicio 2025
 * (www3.agenciatributaria.gob.es, Sede/Disenyo_registro/DR_100_199/
 * archivos_25/DISENOS_LOGICOS_190_2025.pdf), registro tipo 2:
 * - campo CLAVE (posición 78): clave A, "Rendimientos del trabajo:
 *   Empleados por cuenta ajena en general. Se utilizará esta clave para
 *   relacionar todas aquellas percepciones, dinerarias o en especie, que
 *   hayan sido satisfechas ... en concepto de rendimientos del trabajo,
 *   siempre que para determinar el importe de la retención hubiese resultado
 *   aplicable el procedimiento general establecido en el artículo 82 del
 *   Reglamento del Impuesto y que sean distintas de las que deban reflejarse
 *   específicamente en las claves B, C y D".
 * - campo SUBCLAVE (posiciones 79-80): "Tratándose de percepciones
 *   correspondientes a las claves B, C, E, F, G, H, I, K y L, deberá
 *   consignarse, además, la subclave ... En percepciones correspondientes a
 *   claves distintas de las mencionadas, no se cumplimentará este campo."
 *   Clave A takes NO subclave.
 *
 * This module is DECLARED DATA, not a switch in generic code: the 190
 * population reads every committed payroll earning/IRPF line as clave A
 * because that is the only classification this engine can produce — ordinary
 * wages priced under the article-82 general procedure — and every other
 * clave names here why payroll never files it.
 */
export interface Es190ClaveMapping {
  /** The AEAT clave under which the population reports these lines. */
  readonly clave: "A";
  /** Clave A takes no subclave (diseños lógicos, campo SUBCLAVE). */
  readonly subclave: null;
  /** Which committed-stub lines aggregate under this clave. */
  readonly scope: string;
  /** The authority text this mapping rests on. */
  readonly citation: string;
}

/** Ordinary payroll: taxable earnings as percepción íntegra, IRPF as retención. */
export const ES_190_PAYROLL_CLAVE: Es190ClaveMapping = {
  clave: "A",
  subclave: null,
  scope:
    "committed pay-stub earning lines (taxable, coalesce(pc.taxable, true)) aggregate as "
    + "percepción íntegra, and system_key 'irpf' deduction lines as retenciones practicadas, "
    + "per employee and province. Seguridad Social cuotas (ss_*, employer or employee) are "
    + "TGSS contributions, not IRPF percepciones or retenciones, and never enter Modelo 190.",
  citation:
    "AEAT Diseños lógicos Modelo 190 ejercicio 2025, registro tipo 2, campo CLAVE (pos. 78): "
    + "clave A for rendimientos del trabajo under the artículo 82 RIRPF general procedure; "
    + "campo SUBCLAVE (pos. 79-80): no subclave for claves other than B, C, E, F, G, H, I, K, L",
};

export interface Es190UnsupportedClave {
  readonly clave: string;
  /** Why payroll the engine prices never files under this clave. */
  readonly reason: string;
}

/**
 * Every non-A clave, refused by name. Each reason states the different
 * payer, relationship or income kind — so a future pack that prices one of
 * them extends this table instead of re-pointing payroll lines at it.
 */
export const ES_190_UNSUPPORTED_CLAVES: readonly Es190UnsupportedClave[] = [
  {
    clave: "B",
    reason:
      "pensionistas y haberes pasivos (LIRPF art. 17.2.a): pensions paid by the Seguridad "
      + "Social or Clases Pasivas, a different payer — an employee whose SITUPER is "
      + "'pensionista' still earns clave-A wages from this employer",
  },
  {
    clave: "C",
    reason:
      "prestaciones o subsidios por desempleo: paid by the SEPE, never by the employer "
      + "running payroll",
  },
  {
    clave: "D",
    reason:
      "suppressed since 1 January 2013 for pago-único desempleo (LIRPF art. 7.n exempts "
      + "them; current amounts file under clave L subclave 13) — kept only for pre-2013 "
      + "reintegros, which payroll never produces",
  },
  {
    clave: "E",
    reason:
      "consejeros y administradores: board remuneration, a different legal relationship — "
      + "the engine prices employment contracts, never board mandates",
  },
  {
    clave: "F",
    reason:
      "cursos, conferencias y obras: teaching and authorship income — the engine has no "
      + "course-work classification and prices no such payments",
  },
  {
    clave: "G",
    reason:
      "actividades profesionales (LIRPF art. 101.5.a): self-employment income — payroll "
      + "never produces rendimientos de actividades económicas",
  },
  {
    clave: "H",
    reason:
      "actividades agrícolas/ganaderas/forestales y estimación objetiva (RIRPF art. 95): "
      + "never employment income",
  },
  {
    clave: "I",
    reason:
      "propiedad intelectual, asistencia técnica y arrendamientos as actividades "
      + "económicas (RIRPF art. 75.2.b): never employment income",
  },
  {
    clave: "J",
    reason:
      "cesión de derechos de imagen imputada a no residentes (LIRPF art. 92.8): neither "
      + "employment nor resident income",
  },
  {
    clave: "K",
    reason:
      "premios y aprovechamientos forestales vecinales (RIRPF art. 75.2.c): the engine "
      + "pays no prizes",
  },
  {
    clave: "L",
    reason:
      "rentas exentas y dietas exceptuadas (RIRPF art. 9; LIRPF art. 7): the engine tracks "
      + "no exempt amounts, no per-diem travel and no in-kind valuations — dietas and "
      + "exempt amounts come from expense records outside payroll and the operator adds "
      + "them to the 190 directly",
  },
];
