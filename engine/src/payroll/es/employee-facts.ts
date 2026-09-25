/**
 * ES required employee facts: the `emp` keys the pack's statutory engine
 * reads, DECLARED with kind, bounds, producer and refusal reason.
 *
 * One source, two readers: `./pack.ts` states it as the pack's
 * `employeeFacts` declaration, and `./compute-statutory.ts` imports this
 * module so every read registers before it can run. See
 * `../employee-facts.ts` for the shape and the derivation of `payable`.
 */
import { empFact, registerEmployeeFacts, resolveEmployeeFact } from "../employee-facts.ts";
import type { PayrollEmployeeFact } from "../employee-facts.ts";
import { PayrollPackError } from "../payroll-error.ts";
import { ES_PROVINCIA_CODES } from "./provincias.ts";

// Required employee facts. The compute path reads eighteen `emp[...]`
  // keys; the four blocking ones (situación, grupo, año, contrato temporal)
  // are served by the profile columns the `es_datos_perceptor` certificate
  // fields map (situación, grupo and año since 0191; contrato temporal
  // since 0406) — kept apart from the Modelo 145, whose situación familiar
  // (art. 81 RIRPF) is a FAMILY status, not the labour status SITUPER
  // prices. The fifth and sixth (the classified overtime pay split,
  // per-period) and the tenth and eleventh (tiempo parcial contract type
  // and its monthly hours) stay unbuilt: no profile column or certificate
  // field collects any of them yet. The twelfth (residencia fiscal)
  // resolves through the stored-certificate channel, like the US federal
  // alien-status fact. The thirteenth (régimen general/hogar, absent is
  // general) selects the contribution table; the five hogar-only facts
  // after it refuse by name when a household payroll needs them and never
  // block General-Regime payroll.
  //
  // OPEN, still: which AEAT/TGSS artefact the operator copies each value
  // off (contrato, alta en Seguridad Social, otro) — and, shared with PL,
  // whether the age-banded rule keys on BIRTH YEAR or on AGE AT THE PAY
  // DATE. This channel supplies the values; it answers neither question,
  // and both still owe a citation.
  export const ES_EMPLOYEE_FACTS: readonly PayrollEmployeeFact[] = [
    {
      key: "es_situacion_laboral",
      kind: "choice",
      choices: ["activo", "pensionista", "desempleado"],
      label: "Situación laboral (SITUPER)",
      refusalReason:
        "SITUPER moves gastos and REDU, so the employment situation is never defaulted.",
      required: true,
      producer: { kind: "profile_column", column: "es_situacion_laboral" },
    },
    {
      key: "es_grupo_cotizacion",
      kind: "integer",
      min: 1,
      max: 11,
      label: "Grupo de cotización (1–11)",
      refusalReason:
        "The contribution group selects the Seguridad Social bases and topes; an undeclared group "
        + "must not fall through to group 1 pricing.",
      required: true,
      producer: { kind: "profile_column", column: "es_grupo_cotizacion" },
    },
    {
      key: "es_ano_nacimiento",
      kind: "year",
      min: 1906,
      max: 2026,
      label: "Año de nacimiento",
      refusalReason:
        "The birth year feeds an age-banded rule; an unknown age must not fall through to standard pricing.",
      required: true,
      producer: { kind: "profile_column", column: "es_ano_nacimiento" },
    },
    {
      key: "es_contrato_temporal",
      kind: "flag",
      label: "Contrato temporal",
      refusalReason:
        "The contract type selects the desempleo rate split (7,05% indefinite vs 8,30% temporary, "
        + "Orden PJC/297/2026 art. 33.2.a); an undeclared contract must not fall through to indefinite pricing.",
      required: true,
      producer: { kind: "profile_column", column: "es_contrato_temporal" },
    },
    {
      key: "es_contrato_duracion_dias",
      kind: "integer",
      min: 1,
      label: "Duración efectiva del contrato temporal (días naturales)",
      refusalReason:
        "Art. 28 prices only fixed-term contracts under thirty days, so a temporal contract needs its "
        + "effective duration in days before the €33.62 charge can be evaluated.",
      required: false,
      producer: {
        kind: "none",
        notes:
          "Read only for temporal contracts; indefinite contracts never need it. Absent is refused at "
          + "calculation, never defaulted.",
      },
    },
    {
      key: "es_contrato_tipo",
      kind: "choice",
      choices: ["ordinario", "sustitucion", "formacion", "agrario", "hogar", "minero", "artista"],
      label: "Clase de contrato temporal (art. 28.2)",
      refusalReason:
        "Art. 28.2 excludes sustitución, formación, agrario, hogar, minería del carbón and artistas; an "
        + "unknown class cannot be priced or excluded, so it refuses by name.",
      required: false,
      producer: {
        kind: "none",
        notes:
          "Read only for temporal contracts. Ordinario is the chargeable class; every other value names "
          + "an art. 28.2 exclusion.",
      },
    },
    {
      key: "es_contrato_fin_periodo",
      kind: "flag",
      label: "El contrato temporal finaliza en este periodo",
      refusalReason:
        "The €33.62 charge accrues at termination; absent is accepted as not ending this period.",
      required: false,
      producer: {
        kind: "none",
        notes:
          "Read only for temporal contracts. Only a present-but-foreign value refuses; absent means the "
          + "contract continues and no charge accrues.",
      },
    },
    {
      key: "es_horas_extra_resto",
      kind: "amount",
      label: "Horas extraordinarias no estructurales: retribución del periodo",
      refusalReason:
        "Non-force-majeure overtime carries the Orden PJC/297/2026 art. 5 additional 4,70 % / 23,60 % "
        + "contribution on its own pay; unclassified overtime pay must not price as ordinary pay alone.",
      required: false,
      producer: {
        kind: "derivation",
        derivation: "ES overtime pay split",
        notes:
          "No channel exists yet: the period's classified overtime pay needs a per-period input "
          + "alongside the overtime earning lines, which this change does not ship. Until then absent "
          + "is accepted as no overtime of this class — and a run whose overtime lines carry hours "
          + "but no classified pay is refused rather than priced without the additional contribution.",
      },
    },
    {
      key: "es_horas_extra_fuerza_mayor",
      kind: "amount",
      label: "Horas extraordinarias por fuerza mayor: retribución del periodo",
      refusalReason:
        "Force-majeure overtime carries the Orden PJC/297/2026 art. 5 additional 2 % / 12 % "
        + "contribution on its own pay; unclassified overtime pay must not price as ordinary pay alone.",
      required: false,
      producer: {
        kind: "derivation",
        derivation: "ES overtime pay split",
        notes:
          "No channel exists yet: the period's classified overtime pay needs a per-period input "
          + "alongside the overtime earning lines, which this change does not ship. Until then absent "
          + "is accepted as no overtime of this class — and a run whose overtime lines carry hours "
          + "but no classified pay is refused rather than priced without the additional contribution.",
      },
    },
    {
      key: "es_tiempo_parcial",
      kind: "flag",
      label: "Contrato a tiempo parcial",
      refusalReason:
        "A part-time contract prices the art. 39 hourly floor instead of the full-period grupo "
        + "minimum; only a present-but-foreign value refuses, while absent is accepted as full-time.",
      required: false,
      producer: {
        kind: "none",
        notes:
          "No profile column or certificate field collects the contract type yet; absent is accepted "
          + "as full-time, so this fact does not block `payable`. A part-time \"true\" without monthly "
          + "hours refuses in compute-statutory.ts. When the contract-type input is built (same form "
          + "as the trio above), declare the certificate or profile-column producer here.",
      },
    },
    {
      key: "es_horas_tiempo_parcial",
      kind: "amount",
      label: "Horas trabajadas en el mes (tiempo parcial)",
      refusalReason:
        "The art. 39.2 monthly minimum is hours actually worked times the grupo hourly minimum; "
        + "without the month's hours a declared part-time contract cannot price. Only a "
        + "present-but-unusable value refuses; absent is accepted (full-time, or part-time "
        + "refused downstream for missing hours).",
      required: false,
      producer: {
        kind: "none",
        notes:
          "Decimal hour count, not money — \"amount\" is the declaration's only decimal-string kind. "
          + "No profile column or certificate field collects it yet. compute-statutory.ts validates "
          + "it as the calculator does (decimal, 0–744). When the hours input is built, declare the "
          + "certificate or profile-column producer here.",
      },
    },
    {
      key: "es_residencia_fiscal",
      kind: "choice",
      choices: ["residente", "no_residente_ue_eee", "no_residente_otros", "no_residente_convenio"],
      label: "Residencia fiscal (IRPF/IRNR)",
      refusalReason:
        "Spanish-source wages of a nonresident fall under the IRNR, not the IRPF, and this pack "
        + "computes no IRNR levy — pricing them as IRPF withholds the wrong tax.",
      // The calculation boundary below requires this row-backed status; keep
      // it out of profile-column readiness gaps because certificates are
      // resolved through the stored-certificate channel (same shape as the
      // US federal alien-status fact).
      required: false,
      producer: { kind: "certificate", certificate: "es_residencia_fiscal", field: "residencia" },
    },
    {
      key: "es_regimen",
      kind: "choice",
      choices: ["general", "hogar"],
      label: "Régimen de Seguridad Social",
      refusalReason:
        "A declared special system prices its own transcribed table; anything else refuses by name.",
      required: false,
      producer: {
        kind: "none",
        notes:
          "No channel exists yet: absent is the General Regime, so this fact does not block `payable`. "
          + "When the régimen input is built (same form as the profile-column facts above), declare the "
          + "certificate or profile-column producer here.",
      },
    },
    {
      key: "es_hogar_retribucion_mensual",
      kind: "amount",
      label: "Retribución mensual hogar (con prorrata de extras)",
      refusalReason:
        "The household band prices the monthly retribution including proportional extra pays (art. 147.1 LGSS).",
      required: false,
      producer: {
        kind: "none",
        notes:
          "Hogar-only input: required when es_regimen is hogar (named refusal when missing), ignored "
          + "otherwise, so it never blocks General-Regime payroll.",
      },
    },
    {
      key: "es_hogar_horas_mes",
      kind: "count",
      label: "Horas mensuales pactadas (hogar)",
      refusalReason:
        "The art. 15.2 SMI floor scales to agreed monthly hours.",
      required: false,
      producer: {
        kind: "none",
        notes:
          "Hogar-only input: required when es_regimen is hogar (named refusal when missing), ignored "
          + "otherwise, so it never blocks General-Regime payroll.",
      },
    },
    {
      key: "es_hogar_retribucion_por_horas",
      kind: "flag",
      label: "Retribución pactada por horas todo incluido (hogar)",
      refusalReason:
        "Only a present-but-foreign value refuses; absent counts as monthly pay (art. 15.2(d)).",
      required: false,
      producer: {
        kind: "none",
        notes:
          "Hogar-only input: absent is accepted as monthly pay, so it never blocks `payable`.",
      },
    },
    {
      key: "es_hogar_beneficio_cc",
      kind: "choice",
      choices: ["alta_20", "familia_numerosa_45", "ninguno"],
      label: "Beneficio en la cuota empresarial CC (hogar)",
      refusalReason:
        "The employer CC quota needs its benefit: 20% alta reduction, 45% single large-family caregiver "
        + "(not cumulative), or none.",
      required: false,
      producer: {
        kind: "none",
        notes:
          "Hogar-only input: required when es_regimen is hogar (named refusal when missing), ignored "
          + "otherwise, so it never blocks General-Regime payroll.",
      },
    },
    {
      key: "es_hogar_at_ep_rate",
      kind: "amount",
      label: "Tipo AT/EP hogar (tarifa de primas)",
      refusalReason:
        "Professional-contingency premiums are activity-rated and tenant-entered, never transcribed.",
      required: false,
      producer: {
        kind: "none",
        notes:
          "Hogar-only input: the TGSS-assigned tarifa rate (percent) for the household activity, "
          + "required when es_regimen is hogar (named refusal when missing), ignored otherwise.",
      },
    },
    {
      key: "es_provincia_domicilio",
      kind: "choice",
      choices: ES_PROVINCIA_CODES,
      label: "Provincia del domicilio del perceptor (código de dos dígitos)",
      refusalReason:
        "Modelo 190 type-2 positions 76–77 carry the perceptor's domicile province — the work "
        + "community snapshotted on the pay stub is employment, not domicile, so the 190 refuses "
        + "until the domicile is declared and never substitutes the stub province.",
      // Optional at WITHHOLDING time: the IRPF rate never reads domicile, so
      // an undeclared domicile must not block calculation — only the Modelo
      // 190 population refuses (./yearend.ts names the employee and the remedy).
      required: false,
      producer: { kind: "certificate", certificate: "es_domicilio", field: "provincia_domicilio" },
    },
];

registerEmployeeFacts("ES", ES_EMPLOYEE_FACTS);

/**
 * Fiscal residence is required at the ES calculation boundary. Spanish-source
 * wages of a nonresident fall under the IRNR (LIRNR), never the IRPF retention
 * algorithm — pricing them as IRPF withholds the wrong levy, so an unrecorded
 * status refuses rather than assuming residence.
 */
export function requireEsFiscalResidence(raw: string | null | undefined): string {
  // Route the certificate-backed fact through the same declared-fact reader
  // as profile-backed facts, while preserving the certificate as producer.
  const status = resolveEmployeeFact(
    "ES",
    "es_residencia_fiscal",
    empFact("ES", { es_residencia_fiscal: raw ?? null }, "es_residencia_fiscal"),
  );
  if (!status) {
    throw new PayrollPackError(
      "ES payroll cannot calculate without the employee's fiscal residence; record residente "
      + "fiscal en España, or the applicable no_residente value, on the employee's "
      + "es_residencia_fiscal certificate — refused by name",
    );
  }
  return status;
}
