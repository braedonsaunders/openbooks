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

export const ES_CERTIFICATES: PayrollPackCertificates = {
  country: "ES",
  certificates: [MODELO_145],
};
