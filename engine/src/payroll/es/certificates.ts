/**
 * The ES pack's withholding certificate: Modelo 145.
 *
 * "Modelo 145. IRPF. Retenciones sobre rendimientos del trabajo. Comunicación
 * de datos al pagador (artículo 88 del Reglamento del IRPF)" — the employee
 * tells the PAYER their personal and family data so the payer can compute the
 * retention rate. It is not filed with the AEAT; the payer keeps a copy at the
 * agency's disposal. Approved by Resolución de 3 de enero de 2011 (BOE 5-1-2011).
 *
 * Sede electrónica:
 * https://sede.agenciatributaria.gob.es/Sede/en_gb/impuestos-tasas/impuesto-sobre-renta-personas-fisicas/modelo-145-irpf______tos-trabajo-comunicacion-pagador_/nota-aclaratoria.html
 *
 * The fields below are the form's own data blocks (situación familiar 1/2/3
 * per RIRPF art. 81, hijos y descendientes, ascendientes, discapacidad). The
 * degree tables the AEAT algorithm applies to them (ALGORITMO_2026) are NOT
 * transcribed — see ./rates.ts.
 */
import type {
  PayrollCertificate,
  PayrollPackCertificates,
} from "../certificates.ts";

const MODELO_145: PayrollCertificate = {
  key: "es_145",
  form: "145",
  label: "Comunicación de datos al pagador (retenciones sobre rendimientos del trabajo)",
  scope: { level: "country" },
  purpose: "withholding",
  citation:
    "AEAT Modelo 145 (art. 88 RIRPF, RD 439/2007); situaciones familiares del art. 81 RIRPF; "
    + "Resolución de 3 de enero de 2011 (BOE núm. 4, de 5 de enero de 2011)",
  summary:
    "El perceptor comunica al pagador su situación familiar y sus datos personales para que "
    + "calcule el tipo de retención. Sin comunicación, la retención practicada puede resultar "
    + "superior a la procedente y la diferencia se recupera en la declaración del IRPF.",
  storage: "certificate_rows",
  fields: [
    {
      key: "situacion_familiar", label: "Situación familiar", kind: "choice",
      choices: [
        {
          value: "1",
          label: "Situación 1 — Soltero, viudo, divorciado o separado legal con hijos a cargo",
          help: "Art. 81.1 RIRPF: contribuyentes solteros, viudos, divorciados o separados "
            + "legalmente con hijos que convivan y den derecho al mínimo por descendientes.",
        },
        {
          value: "2",
          label: "Situación 2 — Casado no separado con cónyuge sin rentas superiores a 1.500 €",
          help: "Art. 81.2 RIRPF: casados y no separados legalmente cuyo cónyuge no obtiene "
            + "rentas anuales superiores a 1.500 euros, excluidas las exentas.",
        },
        {
          value: "3",
          label: "Situación 3 — Resto de perceptores",
          help: "Art. 81.3 RIRPF: la categoría residual — solteros sin hijos, casados cuyo "
            + "cónyuge supera el límite de rentas, y cualquier otra situación.",
        },
      ],
      default: "3", required: true,
      help: "La situación familiar del Modelo 145 (art. 81 RIRPF). La situación 3 es la "
        + "residual que el pagador aplica cuando el perceptor no comunica otra.",
    },
    {
      key: "hijos_descendientes", label: "Hijos y otros descendientes", kind: "count",
      min: "0", max: "99", default: "0",
      help: "Número de hijos y otros descendientes que dan derecho al mínimo por descendientes "
        + "y minoran el tipo de retención. Años de nacimiento y grados de discapacidad, sin "
        + "transcribir (ALGORITMO AEAT pendiente).",
    },
    {
      key: "ascendientes", label: "Ascendientes a cargo", kind: "count",
      min: "0", max: "99", default: "0",
      help: "Ascendientes que conviven con el perceptor y dan derecho al mínimo por "
        + "ascendientes. Edades y grados de discapacidad, sin transcribir.",
    },
    {
      key: "discapacidad", label: "Discapacidad reconocida del perceptor", kind: "flag",
      help: "El perceptor tiene reconocido un grado de discapacidad. Los grados (33–64%, "
        + "65% o superior, con ayuda de tercera persona) determinan las minoraciones del "
        + "algoritmo AEAT y están sin transcribir.",
    },
  ],
};

/**
 * The payer-held employment facts the AEAT retention algorithm prices:
 * SITUPER (the labour status), the TGSS contribution group and the birth
 * year (AÑOPER).
 *
 * This is NOT the Modelo 145: that form's situación familiar (art. 81
 * RIRPF) is a FAMILY status, while SITUPER is the LABOUR status the
 * algorithm moves gastos and REDU on — the two must never be conflated, so
 * they are declared on separate certificates. Which AEAT/TGSS artefact the
 * operator copies each value off (contrato, alta en Seguridad Social, otro)
 * is still an open sourcing question, recorded on the employeeFacts notes;
 * the values themselves are the algorithm's own inputs (SITUPER, grupo
 * 1–11 per Orden PJC/297/2026 art. 33, AÑOPER), so the channel does not
 * wait on it.
 *
 * Column-backed (`storage: "profile_columns"`), like the TD1/W-4 mappings:
 * the answers live on `employee_payroll_profiles.es_*`, the profile editor
 * renders them from this declaration, and the engine reads them off the
 * profile row. Every band restates what computeEsStatutory enforces — never
 * narrower, never wider.
 */
const ES_DATOS_PERCEPTOR: PayrollCertificate = {
  key: "es_datos_perceptor",
  // Not a numbered form: no single agency form carries these three facts, so
  // the form names the declaration itself instead of inventing a code.
  form: "Datos laborales del perceptor",
  label: "Employment facts for IRPF/Seguridad Social (SITUPER, grupo, año)",
  scope: { level: "country" },
  purpose: "withholding",
  citation:
    "AEAT ALGORITMO de cálculo del tipo de retención 2026 (SITUPER, AÑOPER); Orden PJC/297/2026 "
    + "art. 33 (grupos de cotización 1–11); LIRPF art. 12 (período impositivo: año natural)",
  summary:
    "The labour status, contribution group and birth year the AEAT algorithm prices. Kept apart "
    + "from the Modelo 145, whose situación familiar is a different fact.",
  storage: "profile_columns",
  fields: [
    {
      key: "situacion_laboral",
      label: "Situación laboral (SITUPER)",
      kind: "choice",
      choices: [
        { value: "activo", label: "Activo" },
        { value: "pensionista", label: "Pensionista" },
        { value: "desempleado", label: "Desempleado" },
      ],
      storage: { kind: "column", column: "es_situacion_laboral" },
      // Required: the engine prices no ES employee without it — but an
      // UNANSWERED profile still saves, so readiness names the gap before
      // calculation rather than the save refusing an incomplete setup.
      required: true,
      help: "SITUPER moves gastos and REDU, so it is never defaulted. This is the LABOUR status, "
        + "not the Modelo 145 situación familiar.",
    },
    {
      key: "grupo_cotizacion",
      label: "Grupo de cotización (1–11)",
      kind: "count",
      min: "1",
      max: "11",
      storage: { kind: "column", column: "es_grupo_cotizacion" },
      required: true,
      help: "The TGSS contribution group from the professional category (Orden PJC/297/2026 art. 33). "
        + "An undeclared group never falls through to group 1 pricing.",
    },
    {
      key: "ano_nacimiento",
      label: "Año de nacimiento",
      kind: "count",
      min: "1906",
      max: "2026",
      storage: { kind: "column", column: "es_ano_nacimiento" },
      required: true,
      help: "The AÑOPER the age-banded rule reads. An unknown age never falls through to standard pricing.",
    },
  ],
};

export const ES_CERTIFICATES: PayrollPackCertificates = {
  country: "ES",
  certificates: [MODELO_145, ES_DATOS_PERCEPTOR],
};
