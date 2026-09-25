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
import { sql } from "drizzle-orm";
import { empFact, resolveEmployeeFact } from "../employee-facts.ts";
import { certificateAmount, certificateCount } from "../certificates.ts";
// Side effect: registers ES_EMPLOYEE_FACTS, so every read below resolves
// through the declaration in every import graph — never via a transitive
// side effect of the pack registry.
import "./employee-facts.ts";
import "./employer-facts.ts";
import { resolveStoredEmployerFact } from "../employer-fact-store.ts";
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
 * Article 87 requires recalculating the annual withholding and spreading the
 * difference over the remaining expected remuneration after a relevant
 * change. This adapter does not carry the prior-retention/remaining-pay
 * inputs, so a change visible in committed same-year payroll must be refused
 * before it emits a plausible but understated IRPF line. Drafts and voided
 * runs are deliberately excluded: neither is money actually paid or withheld.
 */
async function refuseIfPriorPayChanged(
  ctx: PayrollStatutoryComputeContext,
  payDate: string,
  currentOrdinaryGross: string,
): Promise<void> {
  const { tx, orgId, employeePartyId, documentId, taxYear } = ctx;
  if (!tx) fail("Article 87 change detection requires committed payroll history");
  if (!orgId || !employeePartyId || !documentId) {
    fail("Article 87 change detection requires the organization, employee, and run identifiers");
  }
  const prior = await tx.execute<{ changed: boolean }>(sql`
    select exists (
      select 1
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
      join documents d on d.id = r.document_id and d.org_id = r.org_id
      where s.org_id = ${orgId}
        and s.employee_party_id = ${employeePartyId}
        and s.tax_year = ${taxYear}
        and s.pay_date < ${payDate}::date
        and r.run_status = 'committed'
        and d.status <> 'voided'
        and s.gross <> ${currentOrdinaryGross}::numeric
    ) as changed
  `);
  if (prior.rows[0]?.changed === true) {
    fail(
      "prior committed pay in this tax year differs from current ordinary pay; the Article 87 "
      + "regularization needs year-to-date retentions and remaining expected remuneration. "
      + "Reconcile the employee's year-to-date and remaining annual pay before releasing this run",
    );
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

  const zoneAnswers = certificateFor("es_zona_irpf")?.answers;
  const zona = zoneAnswers?.["zona_residencia"];
  if (zona !== "ninguna" && zona !== "ceuta-melilla" && zona !== "la-palma") {
    fail("es_zona_irpf zona_residencia is missing or invalid; certify the employee's residence zone");
  }
  const rendimientosEnZonaRaw = zoneAnswers?.["rendimientos_en_zona"];
  const rendimientosEnZona = rendimientosEnZonaRaw === "true" || rendimientosEnZonaRaw === "1"
    || rendimientosEnZonaRaw === "yes";
  if (!rendimientosEnZona && rendimientosEnZonaRaw !== "false" && rendimientosEnZonaRaw !== "0"
    && rendimientosEnZonaRaw !== "no") {
    fail("es_zona_irpf rendimientos_en_zona is missing or invalid; certify where the income was obtained");
  }
  if (zona === "ninguna" && rendimientosEnZona) {
    fail("es_zona_irpf declares income in Ceuta/Melilla/La Palma without residence in a qualifying zone");
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
  // Orden PJC/297/2026 art. 28: a fixed-term contract under thirty days owes
  // €33.62 at termination unless it is an art. 28.2 exclusion. Duration and
  // class are required for temporal contracts and refuse by name; the ends
  // flag defaults to a continuing contract.
  let cortaDuracionAplicable = false;
  if (temporal === "true") {
    const duracionRaw = empFact("ES", emp, "es_contrato_duracion_dias");
    if (duracionRaw == null || duracionRaw === "") {
      fail(
        "employee es_contrato_duracion_dias is missing: art. 28 prices only contracts under thirty "
        + "days, so a temporal contract needs its effective duration in days",
      );
    }
    const duracion = Number(duracionRaw);
    if (!Number.isInteger(duracion) || duracion < 1) {
      fail(`employee es_contrato_duracion_dias "${duracionRaw}" is not a positive integer number of days`);
    }
    const tipo = empFact("ES", emp, "es_contrato_tipo");
    if (tipo == null || tipo === "") {
      fail(
        "employee es_contrato_tipo is missing: art. 28.2 excludes sustitución, formación, agrario, "
        + "hogar, minería del carbón and artistas — file the contract class before calculating",
      );
    }
    if (!["ordinario", "sustitucion", "formacion", "agrario", "hogar", "minero", "artista"].includes(tipo)) {
      fail(`employee es_contrato_tipo "${tipo}" is not a declared art. 28.2 contract class`);
    }
    const fin = empFact("ES", emp, "es_contrato_fin_periodo");
    if (fin !== undefined && fin !== null && fin !== "" && fin !== "true" && fin !== "false") {
      fail(`employee es_contrato_fin_periodo "${fin}" is not "true"/"false"`);
    }
    cortaDuracionAplicable = duracion < 30 && tipo === "ordinario" && fin === "true";
  }

  // Orden PJC/297/2026 art. 5 prices the additional overtime contribution
  // on classified overtime PAY (fuerza mayor vs resto), never on hours.
  // Both classes resolve through the pack's employeeFacts declaration:
  // absent reads as none of that class, and a supplied-but-unusable value
  // refuses through the shared gate. Validated here so a refusal names the
  // fact key, never a calculator argument.
  const hexRestoRaw = resolveEmployeeFact("ES", "es_horas_extra_resto", empFact("ES", emp, "es_horas_extra_resto"));
  const hexFmRaw = resolveEmployeeFact("ES", "es_horas_extra_fuerza_mayor", empFact("ES", emp, "es_horas_extra_fuerza_mayor"));
  const hexResto = hexRestoRaw === null ? null : dec(hexRestoRaw, "es_horas_extra_resto");
  const hexFm = hexFmRaw === null ? null : dec(hexFmRaw, "es_horas_extra_fuerza_mayor");
  if (hexResto !== null && hexResto < 0n) fail(`employee es_horas_extra_resto "${hexRestoRaw}" must be non-negative`);
  if (hexFm !== null && hexFm < 0n) fail(`employee es_horas_extra_fuerza_mayor "${hexFmRaw}" must be non-negative`);
  // Overtime lines carrying hours with no classified pay behind them: the
  // additional contribution is always owed on overtime worked, so the run
  // is refused by name instead of pricing ordinary contributions alone —
  // split the overtime pay across the two facts above, or correct the
  // earning lines if no overtime was worked.
  const extraHours = ctx.statutoryHours?.extra;
  if ((hexResto ?? 0n) === 0n && (hexFm ?? 0n) === 0n && extraHours !== undefined && dec(extraHours, "extra hours") > 0n) {
    fail(
      `the run records ${extraHours} extra hours on overtime-classified earning lines but no classified `
      + "overtime pay (es_horas_extra_resto / es_horas_extra_fuerza_mayor) was supplied: the Orden "
      + "PJC/297/2026 art. 5 additional contribution cannot price unclassified overtime",
    );
  }

  const periodPay = dec(income, "income") + dec(nonPeriodic === "" ? "0" : nonPeriodic, "nonPeriodic");
  if (periodPay < 0n) fail("period pay must be non-negative");

  const retribucionAnualCert = certificateFor("es_retribucion_anual");
  if (!retribucionAnualCert) {
    fail("es_retribucion_anual is missing; certify remuneration expected from this payer this calendar year");
  }
  const retribucionAnualRaw = certificateAmount(retribucionAnualCert, "importe_anual_previsto");
  if (retribucionAnualRaw == null) {
    fail("es_retribucion_anual importe_anual_previsto is missing; certify the calendar-year total");
  }
  const retribucionAnualUnits = dec(retribucionAnualRaw, "es_retribucion_anual importe_anual_previsto");
  if (retribucionAnualUnits <= 0n) fail("es_retribucion_anual importe_anual_previsto must be positive");
  if (retribucionAnualUnits < periodPay) {
    fail("es_retribucion_anual expected annual remuneration is below the current pay period total");
  }
  const periodosAnuales = certificateCount(retribucionAnualCert, "periodos_recurrentes_esperados");
  if (periodosAnuales == null || periodosAnuales < 1 || periodosAnuales > 12) {
    fail("es_retribucion_anual periodos_recurrentes_esperados must be 1–12 monthly periods");
  }

  const currentGross = dec(ctx.gross ?? D(periodPay), "gross");
  const nonPeriodicUnits = dec(nonPeriodic === "" ? "0" : nonPeriodic, "nonPeriodic");
  if (currentGross < nonPeriodicUnits) {
    fail("non-periodic pay exceeds current gross pay");
  }
  const currentOrdinaryGross = D(currentGross - nonPeriodicUnits);
  await refuseIfPriorPayChanged(ctx, payDate, currentOrdinaryGross);

  // Monthly SS on the period bases; the employee share annualised feeds IRPF
  // COTIZACIONES (exact when the base holds all year; mid-year changes take
  // the regularización path, which is refused by name).
  const pensionableUnits = dec(pensionable, "pensionable");
  const insurableUnits = dec(insurable === "" ? pensionable : insurable, "insurable");
  const pensionableNonPeriodicUnits = dec(ctx.pensionableNonPeriodic ?? "0", "pensionableNonPeriodic");
  if (pensionableNonPeriodicUnits > pensionableUnits) {
    fail("pensionableNonPeriodic exceeds the current pensionable base");
  }
  if (pensionableNonPeriodicUnits > insurableUnits) {
    fail("pensionableNonPeriodic exceeds the current insurable base");
  }
  // AT/EP is an establishment tariff, never an employee answer: resolve the
  // legal employer's filed DA 61ª rate and price the employer premium from
  // it. A run whose employer has no tariff on file refuses by name instead
  // of silently omitting the premium. Contexts without a paying-employer
  // identity keep the pure calculator's omit — production runs always carry
  // the subsidiary, as the FR adapter requires.
  let atEpRate: string | undefined;
  if (ctx.subsidiaryId) {
    atEpRate = await resolveStoredEmployerFact({
      tx: ctx.tx,
      orgId: ctx.orgId,
      subsidiaryId: ctx.subsidiaryId,
      country: "ES",
      factKey: "es_atep_rate",
      asOf: payDate,
    }) ?? undefined;
  }
  const ss = calculateEsSeguridadSocial2026({
    payDate,
    grupo,
    base: D(pensionableUnits),
    retribucionMensual: D(insurableUnits),
    contratoTemporal: temporal === "true",
    atEpRate,
    cortaDuracionAplicable,
    horasExtraResto: hexResto === null ? undefined : D(hexResto),
    horasExtraFuerzaMayor: hexFm === null ? undefined : D(hexFm),
  });
  const ssRecurrente = pensionableNonPeriodicUnits === 0n
    ? ss
    : calculateEsSeguridadSocial2026({
      payDate,
      grupo,
      base: D(pensionableUnits - pensionableNonPeriodicUnits),
      retribucionMensual: D(insurableUnits - pensionableNonPeriodicUnits),
      contratoTemporal: temporal === "true",
      atEpRate,
      cortaDuracionAplicable,
      horasExtraResto: hexResto === null ? undefined : D(hexResto),
      horasExtraFuerzaMayor: hexFm === null ? undefined : D(hexFm),
    });
  const cotizacionesAnual = D(
    U(ssRecurrente.trabajadorTotal) * BigInt(periodosAnuales)
      + U(ss.trabajadorTotal) - U(ssRecurrente.trabajadorTotal),
  );

  // RIRPF art. 83.2.1ª prices the calendar-year amount normally expected,
  // not twelve copies of a check whose employee may have started midyear.
  const retribAnual = D(retribucionAnualUnits);
  const irpf = calculateEsIrpf2026({
    payDate,
    retribuciones: retribAnual,
    cotizaciones: cotizacionesAnual,
    situacionFamiliar: situacion as EsSituacionFamiliar,
    birthYear: ano,
    pensionista: situacionLaboral === "pensionista",
    desempleado: situacionLaboral === "desempleado",
    zona,
    rendimientosZona: rendimientosEnZona,
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
  if (ss.atEpEmpresa != null) {
    pushStatutory("ss_atep_er", "employer_contribution", "AT/EP (employer)", ss.atEpEmpresa, 215);
  }
  if (ss.cortaDuracionEmpresa != null) {
    pushStatutory("ss_corta_er", "employer_contribution", "Cotización adicional contratos corta duración (employer)", ss.cortaDuracionEmpresa, 216);
  }
  // Art. 5 additional contributions exist only when classified overtime pay
  // exists: pushed when nonzero, never as zero lines on ordinary runs (so
  // the no-overtime line set the adapter goldens enumerate stays stable).
  if (U(ss.horasExtraRestoTrabajador) !== 0n) pushStatutory("ss_hex_resto", "deduction", "Horas extraordinarias (employee)", ss.horasExtraRestoTrabajador, 124);
  if (U(ss.horasExtraFMTrabajador) !== 0n) pushStatutory("ss_hex_fm", "deduction", "Horas extraordinarias fuerza mayor (employee)", ss.horasExtraFMTrabajador, 125);
  if (U(ss.horasExtraRestoEmpresa) !== 0n) pushStatutory("ss_hex_resto_er", "employer_contribution", "Horas extraordinarias (employer)", ss.horasExtraRestoEmpresa, 217);
  if (U(ss.horasExtraFMEmpresa) !== 0n) pushStatutory("ss_hex_fm_er", "employer_contribution", "Horas extraordinarias fuerza mayor (employer)", ss.horasExtraFMEmpresa, 218);
  return {
    ES_TIPO_IRPF: irpf.tipo,
    ES_IMPORTE_ANUAL: irpf.importeAnual,
    ES_IRPF_MES: D(irpfMes),
    ES_SS_EE: ss.trabajadorTotal,
    ES_SS_ER: ss.empresaTotal,
    ES_EDITION: irpf.edition,
  };
}
