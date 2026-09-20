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

// Required employee facts. The compute path reads four `emp[...]` keys
  // and NO surface produces any of them — no profile column, no Modelo 145
  // field (it carries situación familiar, hijos, ascendientes and
  // discapacidad — not situación laboral, grupo, año or contrato), no API
  // input, no UI. Three block every employee; the fourth (contrato
  // temporal) accepts absence. Declared here with no producers yet, so
  // readiness names the gap before calculation and `payable` derives false
  // until the next shard builds the channels.
  export const ES_EMPLOYEE_FACTS: readonly PayrollEmployeeFact[] = [
    {
      key: "es_situacion_laboral",
      kind: "choice",
      choices: ["activo", "pensionista", "desempleado"],
      label: "Situación laboral (SITUPER)",
      refusalReason:
        "SITUPER moves gastos and REDU, so the employment situation is never defaulted.",
      required: true,
      producer: {
        kind: "none",
        notes:
          "No channel exists. Modelo 145's situación familiar (art. 81 RIRPF: soltero/viudo/divorciado "
          + "con hijos, casado, resto) is a FAMILY status, not the labour status SITUPER prices — the two "
          + "must not be conflated. OPEN QUESTION: which AEAT artefact carries situación laboral for the "
          + "operator (contrato, alta en Seguridad Social, otro)? AEAT citation required before building.",
      },
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
      producer: {
        kind: "none",
        notes:
          "No channel exists. OPEN QUESTION: which source fixes the group for the operator — the "
          + "contrato/convenio colectivo (the group follows the professional category) or a TGSS alta "
          + "document? TGSS/AEAT citation required before building; the 1–11 band itself is Orden "
          + "PJC/297/2026 art. 33.",
      },
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
      producer: {
        kind: "none",
        notes:
          "No channel exists. OPEN QUESTION, shared with PL: is the age-banded rule keyed on BIRTH YEAR "
          + "or on AGE AT THE PAY DATE? Those differ for anyone whose birthday falls inside the period. "
          + "AEAT citation required before building. The DNI/NIE the pack already collects carries no "
          + "birth date, so unlike PL there is no deriving identifier — this needs a declared field.",
      },
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
];

registerEmployeeFacts("ES", ES_EMPLOYEE_FACTS);
