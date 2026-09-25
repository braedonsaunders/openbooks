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

// Required employee facts. The compute path reads twelve `emp[...]` keys;
  // the three blocking ones (situación, grupo, año) are served since 0191
  // by the profile columns the `es_datos_perceptor` certificate fields map
  // — kept apart from the Modelo 145, whose situación familiar (art. 81
  // RIRPF) is a FAMILY status, not the labour status SITUPER prices. The
  // fourth (contrato temporal) accepts absence and stays unbuilt, as do the
  // fifth and sixth (the classified overtime pay split, per-period) and the
  // tenth and eleventh (tiempo parcial contract type and its monthly hours):
  // no profile column or certificate field collects any of them yet. The
  // twelfth (residencia fiscal) resolves through the stored-certificate
  // channel, like the US federal alien-status fact.
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
        "Only a present-but-foreign value refuses; absent is accepted as an indefinite contract.",
      required: false,
      producer: {
        kind: "none",
        notes:
          "No channel exists, and none is needed for the common case: absent is accepted, so this fact "
          + "does not block `payable`. When the temporal/indefinido input is built (same form as the "
          + "trio above), declare the certificate or profile-column producer here.",
      },
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
      choices: ["residente", "no_residente_sin_convenio", "no_residente_con_convenio"],
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
