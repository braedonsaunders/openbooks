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

const ES_ZONA_IRPF: PayrollCertificate = {
  key: "es_zona_irpf",
  form: "Declaración de residencia y rendimientos en zona especial",
  label: "Datos de zona para el cálculo de retenciones IRPF",
  scope: { level: "country" },
  purpose: "withholding",
  citation:
    "AEAT ALGORITMO de cálculo del tipo de retención 2026, RESICEME y RENCEME; "
    + "LIRPF art. 68.4 and D.A. 57ª; Real Decreto-ley 23/2026, effective 10 September 2026",
  summary:
    "The employee declares habitual and effective residence in Ceuta/Melilla or La Palma, and "
    + "whether the employment income was obtained there. Both conditions control the reduced IRPF type.",
  storage: "certificate_rows",
  fields: [
    {
      key: "zona_residencia",
      label: "Zona de residencia habitual y efectiva",
      kind: "choice",
      choices: [
        { value: "ninguna", label: "No reside en Ceuta, Melilla ni La Palma" },
        { value: "ceuta-melilla", label: "Ceuta o Melilla" },
        { value: "la-palma", label: "La Palma" },
      ],
      required: true,
      help: "La residencia y la obtención de los rendimientos en la zona se declaran por separado. "
        + "La Palma solo da acceso al régimen excepcional desde el 10 de septiembre de 2026.",
    },
    {
      key: "rendimientos_en_zona",
      label: "Rendimientos del trabajo obtenidos en esa zona",
      kind: "flag",
      required: true,
      help: "El tipo reducido exige residencia habitual y efectiva en la zona y rendimientos obtenidos allí.",
    },
  ],
};

/**
 * Contract category for the IRPF minimum rate. No single agency form carries
 * it, so the form names the declaration itself instead of inventing a code —
 * the operator copies the category off the signed contrato (or alta en
 * Seguridad Social). Values are the calculator's contract categories
 * verbatim, so a validated answer maps without translation.
 */
const ES_CONTRATO: PayrollCertificate = {
  key: "es_contrato",
  form: "Categoría contractual del perceptor",
  label: "Contract category for the IRPF minimum withholding rate",
  scope: { level: "country" },
  purpose: "withholding",
  citation:
    "AEAT ALGORITMO de cálculo del tipo de retención 2026, TIPO mínimo "
    + "(contratos de duración inferior al año; relaciones laborales especiales)",
  summary:
    "The worker's contract category, which selects the statutory minimum "
    + "withholding rate. An unidentified category never falls through to the "
    + "general rate.",
  storage: "certificate_rows",
  fields: [
    {
      key: "categoria_contrato",
      label: "Categoría contractual",
      kind: "choice",
      choices: [
        { value: "general", label: "General" },
        { value: "inferiorAno", label: "Duración inferior al año" },
        { value: "especial", label: "Relación laboral especial" },
      ],
      required: true,
      help: "Copy the category off the signed contrato: sub-one-year duration prices "
        + "the 2% minimum, a special employment relationship the 15% minimum. "
        + "An undeclared category refuses calculation instead of pricing general.",
    },
  ],
};

const ES_RETRIBUCION_ANUAL: PayrollCertificate = {
  key: "es_retribucion_anual",
  form: "Previsión anual de retribuciones",
  label: "Previsión de retribuciones para IRPF",
  scope: { level: "country" },
  purpose: "withholding",
  citation: "RIRPF art. 83.2.1ª (RD 439/2007): remuneration normally expected in the calendar year",
  summary:
    "The employer records the total employment remuneration expected for this employee from this payer "
    + "in the calendar year, based on the effective contract and predictable circumstances.",
  storage: "certificate_rows",
  fields: [
    {
      key: "importe_anual_previsto",
      label: "Total remuneration expected for this calendar year (€)",
      kind: "amount",
      decimals: 2,
      min: "0.01",
      required: true,
      help: "Include only remuneration expected from this payer in the current calendar year, including "
        + "predictable one-off amounts. Update this signed declaration when expected remuneration changes.",
    },
    {
      key: "periodos_recurrentes_esperados",
      label: "Recurring pay periods expected from now through year-end",
      kind: "count",
      min: "1",
      max: "12",
      required: true,
      help: "Count the monthly recurring payroll periods in which this employee is expected to be paid "
        + "during this calendar year, including this period. A December starter normally has one.",
    },
  ],
};

/**
 * Fiscal residence for IRPF vs IRNR. No agency form carries this single
 * fact — the Modelo 145 is filed only by IRPF perceptores and never states
 * nonresidence — so the form names the declaration itself instead of
 * inventing a code, like es_datos_perceptor above. No default: "no
 * certificate on file" is not a statutory resident, so absence refuses at
 * the calculation boundary rather than pricing IRNR wages as IRPF.
 */
const ES_RESIDENCIA_FISCAL: PayrollCertificate = {
  key: "es_residencia_fiscal",
  form: "Residencia fiscal del perceptor",
  label: "Fiscal residence for wage withholding (IRPF vs IRNR)",
  scope: { level: "country" },
  purpose: "withholding",
  citation:
    "LIRNR (RD Legislativo 5/2004) arts. 1–13 (contribuyentes, rentas de fuente española); "
    + "AEAT IRNR rates 19%/24% (LIRNR art. 25) and rendimientos del trabajo guidance "
    + "(sede.agenciatributaria.gob.es, IRNR sin establecimiento permanente)",
  summary:
    "Whether the perceptor is a Spanish fiscal resident (IRPF) or a nonresident whose "
    + "Spanish-source wages fall under the IRNR. The pack computes no IRNR levy, so a "
    + "recorded nonresident refuses by name instead of withholding IRPF on IRNR wages.",
  storage: "certificate_rows",
  fields: [
    {
      key: "residencia", label: "Residencia fiscal", kind: "choice",
      choices: [
        {
          value: "residente",
          label: "Residente fiscal en España — tributa por el IRPF",
          help: "LIRPF (Ley 35/2006): worldwide employment income taxed under IRPF; "
            + "the AEAT retention algorithm prices the withholding.",
        },
        {
          value: "no_residente_sin_convenio",
          label: "No residente sin convenio aplicable — tributa por el IRNR",
          help: "LIRNR: Spanish-source employment income is taxed under the IRNR at the "
            + "general rates (19% qualifying EU/EEA residents, 24% otherwise — art. 25), "
            + "which this pack does not compute.",
        },
        {
          value: "no_residente_con_convenio",
          label: "No residente con convenio de doble imposición aplicable",
          help: "The applicable treaty may exempt or limit Spanish taxation; this pack "
            + "computes no treaty relief, so the run refuses until IRNR pricing exists.",
        },
      ],
      required: true,
      help: "IRPF taxes residents; the IRNR taxes nonresidents' Spanish-source wages. "
        + "The two are different levies — recording the wrong one withholds the wrong tax.",
    },
  ],
};

export const ES_CERTIFICATES: PayrollPackCertificates = {
  country: "ES",
  certificates: [MODELO_145, ES_DATOS_PERCEPTOR, ES_ZONA_IRPF, ES_RETRIBUCION_ANUAL, ES_CONTRATO, ES_RESIDENCIA_FISCAL],
};
