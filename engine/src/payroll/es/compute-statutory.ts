/**
 * Phase 9 — ES pack statutory pass: 2026 IRPF + Seguridad Social.
 *
 * Pure calculators live in ./irpf-2026.ts and ./seguridad-social-2026.ts
 * (proven by goldens); this adapter maps the generic run context onto them.
 * The AEAT pack is monthly: the SS base is intrinsically monthly and the
 * annual IRPF tipo hits each month's pay, so periodsPerYear must be 12.
 *
 * Pack-owned emp keys (named refusals when absent, never defaulted into a
 * lower withholding): es_grupo_cotizacion (1–11), es_situacion_laboral
 * (activo/pensionista/desempleado), es_ano_nacimiento (AÑOPER).
 * The es_145 certificate carries situacion_familiar plus hijos/ascendientes
 * counts and a discapacidad flag: counts above zero or a set flag refuse by
 * name here, because the per-person rows (birth years, enteros, grados,
 * convivencias) the ALGORITMO prices have no certificate channel yet — the
 * pure calculators serve those cases directly.
 */
import { fromUnits, roundDiv, toUnits } from "../../money/money.ts";
import { empFact } from "../employee-facts.ts";
// Side effect: registers ES_EMPLOYEE_FACTS, so every read below resolves
// through the declaration in every import graph — never via a transitive
// side effect of the pack registry.
import "./employee-facts.ts";
import { PayrollPackError } from "../payroll-error.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import { calculateEsIrpf2026 } from "./irpf-2026.ts";
import type { EsSituacionFamiliar } from "./rates.ts";
import { calculateEsSeguridadSocial2026 } from "./seguridad-social-2026.ts";

const U = (s: string): bigint => toUnits(s);
const D = (u: bigint): string => fromUnits(u);

/** AEAT-territory communities: everything except the foral NC/PV. */
const ES_AEAT_REGIONS = [
  "AN", "AR", "AS", "CN", "CB", "CL", "CM", "CT", "EX", "GA",
  "IB", "RI", "MD", "MC", "VC", "CE", "ML",
];

function fail(message: string): never {
  throw new PayrollPackError(`ES payroll 2026: ${message}`);
}

function dec(value: string, what: string): bigint {
  try {
    return U(value);
  } catch {
    fail(`${what} is not a decimal amount: "${value}"`);
  }
}

/**
 * Trace-factor labels for the stub calculation trace, keyed by the factor
 * keys this pass returns. Terms are the AEAT ALGORITMO's own (tipo,
 * importe, Seguridad Social shares) — see the module's transcribed basis.
 */
export const ES_FACTOR_LABELS: Readonly<Record<string, string>> = {
  ES_TIPO_IRPF: "Tipo IRPF aplicado",
  ES_IMPORTE_ANUAL: "Importe anual IRPF",
  ES_IRPF_MES: "IRPF del mes",
  ES_SS_EE: "Seguridad Social (trabajador)",
  ES_SS_ER: "Seguridad Social (empresa)",
  ES_EDITION: "Edition priced",
};

export async function computeEsStatutory(
  ctx: PayrollStatutoryComputeContext,
): Promise<Record<string, string>> {
  const { taxYear, region, run, emp, income, nonPeriodic, pensionable, insurable, periodsPerYear, pushStatutory, certificateFor, assertRegionSupported } = ctx;
  if (taxYear !== 2026) {
    fail(
      `tax year ${taxYear} has not been transcribed — the ES payroll pack's only `
      + "transcribed year is calendar 2026 (see engine/src/payroll/es/rates.ts). "
      + "Transcribe the year's ALGORITMO before calculating",
    );
  }
  if (region === "NC" || region === "PV") {
    fail(
      `region "${region}" applies the foral IRPF regime (Hacienda Foral de Navarra / `
      + "Haciendas Forales de Álava, Gipuzkoa y Bizkaia) — AEAT tables never cover it. Transcribe "
      + "the foral tables into engine/src/payroll/es/rates.ts before calculating",
    );
  }
  assertRegionSupported(region);
  if (!ES_AEAT_REGIONS.includes(region)) {
    fail(`region "${region}" is not a known AEAT-territory community — refusing, never defaulting`);
  }
  if (periodsPerYear !== 12) {
    fail(
      `periodsPerYear ${periodsPerYear} is refused: the TGSS base is intrinsically monthly `
      + "and the annual IRPF tipo hits each month's pay — monthly payroll only",
    );
  }
  const payDate = run["pay_date"];
  if (payDate === undefined || payDate === "") {
    fail("the run has no pay date, so no 2026 edition resolves (1 January–9 September vs 10 September+)");
  }

  const answers = certificateFor("es_145")?.answers ?? {};
  const situacion = answers["situacion_familiar"] ?? "3";
  if (situacion !== "1" && situacion !== "2" && situacion !== "3") {
    fail(`es_145 situacion_familiar "${situacion}" is not 1, 2 or 3`);
  }
  if (answers["hijos_descendientes"] !== undefined && answers["hijos_descendientes"] !== "0") {
    fail(
      "es_145 declares hijos/descendientes: the per-descendiente rows (birth years, enteros, "
      + "grados) the ALGORITMO prices have no certificate channel yet — price via "
      + "calculateEsIrpf2026 directly, never via a guessed mínimo",
    );
  }
  if (answers["ascendientes"] !== undefined && answers["ascendientes"] !== "0") {
    fail(
      "es_145 declares ascendientes: convivencia/grado rows have no certificate channel yet — "
      + "price via calculateEsIrpf2026 directly",
    );
  }
  if (answers["discapacidad"] === "true" || answers["discapacidad"] === "S") {
    fail(
      "es_145 declares discapacidad without a grado (33–65% vs 65%+, ayuda/movilidad) — "
      + "the ALGORITMO prices grados, never a bare flag",
    );
  }

  // Resolved through the pack's employeeFacts declaration (see the PL
  // adapter): raw values untouched, undeclared keys refused at authoring.
  // An empty value is not out of range, it is MISSING: now that operators
  // can supply these fields both causes are reachable, so absence refuses
  // as absence (naming what was never supplied) while a supplied but
  // unusable value keeps the band message. Same refusals, sharper names.
  const situacionLaboral = empFact("ES", emp, "es_situacion_laboral");
  if (situacionLaboral == null || situacionLaboral === "") {
    fail(
      "employee es_situacion_laboral is missing: SITUPER was never supplied, "
      + "and it moves gastos and REDU, so it is never defaulted",
    );
  }
  if (situacionLaboral !== "activo" && situacionLaboral !== "pensionista" && situacionLaboral !== "desempleado") {
    fail(
      `employee es_situacion_laboral "${situacionLaboral}" is not activo/pensionista/desempleado: `
      + "SITUPER moves gastos and REDU, so it is never defaulted",
    );
  }
  const grupoRaw = empFact("ES", emp, "es_grupo_cotizacion");
  if (grupoRaw == null || grupoRaw === "") {
    fail("employee es_grupo_cotizacion is missing: the TGSS contribution group 1–11 was never supplied");
  }
  const grupo = Number(grupoRaw);
  if (!Number.isInteger(grupo) || grupo < 1 || grupo > 11) {
    fail(`employee es_grupo_cotizacion "${grupoRaw}" is not an integer 1–11`);
  }
  const anoRaw = empFact("ES", emp, "es_ano_nacimiento");
  if (anoRaw == null || anoRaw === "") {
    fail("employee es_ano_nacimiento is missing: the birth year (AÑOPER) was never supplied");
  }
  const ano = Number(anoRaw);
  if (!Number.isInteger(ano) || ano < 1906 || ano > 2026) {
    fail(`employee es_ano_nacimiento "${anoRaw}" is out of range 1906–2026`);
  }
  const temporal = empFact("ES", emp, "es_contrato_temporal");
  if (temporal !== undefined && temporal !== null && temporal !== "true" && temporal !== "false") {
    fail(`employee es_contrato_temporal "${temporal}" is not "true"/"false"`);
  }

  const periodPay = dec(income, "income") + dec(nonPeriodic === "" ? "0" : nonPeriodic, "nonPeriodic");
  if (periodPay < 0n) fail("period pay must be non-negative");

  // Monthly SS on the period bases; the employee share annualised feeds IRPF
  // COTIZACIONES (exact when the base holds all year; mid-year changes take
  // the regularización path, which is refused by name).
  const ss = calculateEsSeguridadSocial2026({
    payDate,
    grupo,
    base: D(dec(pensionable, "pensionable")),
    retribucionMensual: D(dec(insurable === "" ? pensionable : insurable, "insurable")),
    contratoTemporal: temporal === "true",
  });
  const cotizacionesAnual = D(U(ss.trabajadorTotal) * 12n);

  // Annual RETRIB = twelve months plus the once-paid non-periodic amount.
  const retribAnual = D(dec(income, "income") * 12n + dec(nonPeriodic === "" ? "0" : nonPeriodic, "nonPeriodic"));
  const irpf = calculateEsIrpf2026({
    payDate,
    retribuciones: retribAnual,
    cotizaciones: cotizacionesAnual,
    situacionFamiliar: situacion as EsSituacionFamiliar,
    birthYear: ano,
    pensionista: situacionLaboral === "pensionista",
    desempleado: situacionLaboral === "desempleado",
  });

  // The annual tipo hits the month's pay, rounded half-up to the cent.
  // The tipo is exactly two decimals, parsed without floats.
  const [tipoEntero = "0", tipoDec = "00"] = irpf.tipo.split(".");
  const tipoHundredths = BigInt(tipoEntero) * 100n + BigInt(tipoDec.padEnd(2, "0").slice(0, 2));
  const irpfMes = roundDiv(periodPay * tipoHundredths, 10000n * 100n) * 100n;

  pushStatutory("irpf", "deduction", "IRPF withholding", D(irpfMes), 110);
  pushStatutory("ss_cc", "deduction", "Seguridad Social (employee)", ss.ccTrabajador, 120);
  pushStatutory("ss_des", "deduction", "Desempleo (employee)", ss.desempleoTrabajador, 121);
  pushStatutory("ss_for", "deduction", "Formación profesional (employee)", ss.formacionTrabajador, 122);
  pushStatutory("ss_mei", "deduction", "MEI (employee)", ss.meiTrabajador, 123);
  pushStatutory("ss_cc_er", "employer_contribution", "Seguridad Social (employer)", ss.ccEmpresa, 210);
  pushStatutory("ss_des_er", "employer_contribution", "Desempleo (employer)", ss.desempleoEmpresa, 211);
  pushStatutory("ss_fogasa_er", "employer_contribution", "FOGASA (employer)", ss.fogasaEmpresa, 212);
  pushStatutory("ss_for_er", "employer_contribution", "Formación profesional (employer)", ss.formacionEmpresa, 213);
  pushStatutory("ss_mei_er", "employer_contribution", "MEI (employer)", ss.meiEmpresa, 214);
  return {
    ES_TIPO_IRPF: irpf.tipo,
    ES_IMPORTE_ANUAL: irpf.importeAnual,
    ES_IRPF_MES: D(irpfMes),
    ES_SS_EE: ss.trabajadorTotal,
    ES_SS_ER: ss.empresaTotal,
    ES_EDITION: irpf.edition,
  };
}
