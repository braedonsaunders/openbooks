/**
 * ES required employee facts: the `emp` keys the pack's statutory engine
 * reads, DECLARED with kind, bounds, producer and refusal reason.
 *
 * One source, two readers: `./pack.ts` states it as the pack's
 * `employeeFacts` declaration, and `./compute-statutory.ts` imports this
 * module so every read registers before it can run. See
 * `../employee-facts.ts` for the shape and the derivation of `payable`.
 */
import { registerEmployeeFacts } from "../employee-facts.ts";
import type { PayrollEmployeeFact } from "../employee-facts.ts";

// Required employee facts. The compute path reads four `emp[...]` keys;
  // the three blocking ones (situación, grupo, año) are served since 0191
  // by the profile columns the `es_datos_perceptor` certificate fields map
  // — kept apart from the Modelo 145, whose situación familiar (art. 81
  // RIRPF) is a FAMILY status, not the labour status SITUPER prices. The
  // fourth (contrato temporal) accepts absence and stays unbuilt.
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
];

registerEmployeeFacts("ES", ES_EMPLOYEE_FACTS);
