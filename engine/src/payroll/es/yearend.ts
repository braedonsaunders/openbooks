import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { assertPayrollCountryKnown } from "../country.ts";
import { PayrollError } from "../error.ts";
import { assertPayrollFilingAccountKnown } from "../filing.ts";
import type {
  PayrollFilingCorrectionRow,
  PayrollFilingData,
  PayrollFilingSlipData,
} from "../filing-registry.ts";
import { ES_TAX_YEARS } from "./rates.ts";

/**
 * The ES pack's year-end builders: Modelo 190 perceptor rows and Modelo 111
 * quarterly aggregates, both straight off the committed-stub subledger.
 *
 * A filing reports what was actually paid and withheld — never a
 * recomputation. Draft and uncommitted runs never appear: every query joins
 * pay_runs on run_status = 'committed'. Annual boxes are sums across the
 * year's editions, priced by pay date at calculation time, so a year split
 * across editions (like 2026's 1 January–9 September vs 10 September+
 * ALGORITMO pair) needs no edition logic here.
 *
 * Perception keys: every row files under clave A with no subclave — see
 * ./modelo-190.ts, the pack's declared classification data.
 */

const num = (value: unknown): string => (value == null ? "0" : String(value));

/**
 * The calendar years this tree publishes ES tables for — read off the pack's
 * own tax-year declaration (./rates.ts), never the registry: this module must
 * not runtime-import ../packs.ts or ../filing-registry.ts, because packs.ts
 * evaluates PAYROLL_COUNTRY_PACKS (including ES_PACK_FILINGS via es/pack.ts)
 * at module top, and a pack-first entry order would then TDZ on this very
 * module. The year-end surface applies payrollTaxYearProblem uniformly before
 * calling any population; this builder-level check is the same refusal for
 * direct callers. In this tree only 2026 is transcribed — 2024 and 2025
 * refuse here by name even though the keep/payroll-es-priors branch
 * transcribes them; that branch is not merged, and a filing must never price
 * a year the tree cannot withhold for.
 */
const ES_PUBLISHED_YEARS: readonly number[] = ES_TAX_YEARS.editions
  .filter((edition) => edition.status === "published")
  .map((edition) => edition.year);

/** Guard every ES population: known country, known filing accounts, published year. */
async function assertEsFilingYear(orgId: string, taxYear: number, filing: string): Promise<void> {
  await assertPayrollCountryKnown(db, orgId, taxYear);
  await assertPayrollFilingAccountKnown(db, orgId, { taxYear });
  if (!ES_PUBLISHED_YEARS.includes(taxYear)) {
    throw new PayrollError(
      `the ES payroll pack cannot populate ${filing} for tax year ${taxYear}: `
      + `${taxYear} statutory tables are not loaded for ES — loaded years: `
      + `${ES_PUBLISHED_YEARS.join(", ")}. Transcribe the year's ALGORITMO into `
      + "engine/src/payroll/es/rates.ts before filing it.",
    );
  }
}

export interface Es190Slip {
  employeePartyId: string;
  employeeName: string;
  province: string;
  percepcionIntegra: string;
  retencionesPracticadas: string;
}

/**
 * One Modelo 190 perceptor row per (employee, province): the year's committed
 * taxable earnings as percepción íntegra and the year's committed IRPF lines
 * as retenciones practicadas — clave A, no subclave (./modelo-190.ts).
 */
export async function es190Slips(orgId: string, taxYear: number): Promise<Es190Slip[]> {
  await assertEsFilingYear(orgId, taxYear, "the Modelo 190");
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select s.employee_party_id, p.display_name,
           s.province as province,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = 'earning'
                  and coalesce(pc.taxable, true))) as percepcion,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = 'deduction'
                  and pc.system_key = 'irpf')) as retencion
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
       and r.run_status = 'committed'
      join parties p on p.id = s.employee_party_id and p.org_id = ${orgId}
     where s.org_id = ${orgId} and s.tax_year = ${taxYear} and s.country = 'ES'
     group by s.employee_party_id, p.display_name, s.province
     order by p.display_name, s.province
  `));
  if (rows.rows.length === 0) {
    throw new PayrollError(
      `no committed ES pay stubs for tax year ${taxYear} — the Modelo 190 reports amounts `
      + "actually paid and withheld, so calculate and commit the year's pay runs first",
    );
  }
  return rows.rows.map((row) => ({
    employeePartyId: String(row.employee_party_id),
    employeeName: String(row.display_name),
    province: String(row.province ?? ""),
    percepcionIntegra: num(row.percepcion),
    retencionesPracticadas: num(row.retencion),
  }));
}

export interface Es111Quarter {
  quarter: 1 | 2 | 3 | 4;
  /** Casilla 01: distinct persons paid IRPF-subject cash wages in the quarter. */
  perceptores: number;
  /** Casilla 02: cash employment income satisfied in the quarter. */
  percepciones: string;
  /** Casilla 03: IRPF withheld in the quarter. */
  retenciones: string;
}

/**
 * The Modelo 111 quarterly worksheet: one row per calendar quarter with
 * committed stubs, keyed by pay date (the 111 is cash-basis — percepciones
 * satisfechas en el período objeto de autoliquidación).
 */
export async function es111Quarters(orgId: string, taxYear: number): Promise<Es111Quarter[]> {
  await assertEsFilingYear(orgId, taxYear, "the Modelo 111");
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select extract(quarter from s.pay_date)::int as quarter,
           count(distinct s.employee_party_id) as perceptores,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = 'earning'
                  and coalesce(pc.taxable, true))) as percepciones,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = 'deduction'
                  and pc.system_key = 'irpf')) as retenciones
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
       and r.run_status = 'committed'
     where s.org_id = ${orgId} and s.tax_year = ${taxYear} and s.country = 'ES'
     group by 1 order by 1
  `));
  if (rows.rows.length === 0) {
    throw new PayrollError(
      `no committed ES pay stubs for tax year ${taxYear} — the Modelo 111 reports amounts `
      + "actually paid and withheld in each quarter, so calculate and commit the year's pay "
      + "runs first",
    );
  }
  return rows.rows.map((row) => ({
    quarter: Number(row.quarter) as 1 | 2 | 3 | 4,
    perceptores: Number(row.perceptores),
    percepciones: num(row.percepciones),
    retenciones: num(row.retenciones),
  }));
}

export async function es190Population(orgId: string, taxYear: number): Promise<PayrollFilingData> {
  const slips = await es190Slips(orgId, taxYear);
  return {
    rowKey: "rowId",
    columns: [
      { key: "employee", label: "Perceptor" },
      { key: "province", label: "Provincia" },
      { key: "clave", label: "Clave" },
      { key: "percepcion", label: "Percepción íntegra", align: "right", money: true },
      { key: "retenciones", label: "Retenciones practicadas", align: "right", money: true },
    ],
    rows: slips.map((slip) => ({
      rowId: `${slip.employeePartyId}:${slip.province}`,
      employee: slip.employeeName,
      province: slip.province,
      clave: "A",
      percepcion: slip.percepcionIntegra,
      retenciones: slip.retencionesPracticadas,
    })),
  };
}

export async function es111Population(orgId: string, taxYear: number): Promise<PayrollFilingData> {
  const quarters = await es111Quarters(orgId, taxYear);
  return {
    rowKey: "rowId",
    columns: [
      { key: "quarter", label: "Trimestre" },
      { key: "perceptores", label: "N.º perceptores (01)" },
      { key: "percepciones", label: "Percepciones (02)", align: "right", money: true },
      { key: "retenciones", label: "Retenciones (03)", align: "right", money: true },
    ],
    rows: quarters.map((quarter) => ({
      rowId: `Q${quarter.quarter}`,
      quarter: `Q${quarter.quarter}`,
      perceptores: String(quarter.perceptores),
      percepciones: quarter.percepciones,
      retenciones: quarter.retenciones,
    })),
  };
}

const ES_GAPS = [
  "NIF del perceptor: the payroll profile holds no DNI/NIE column, so the slip cannot print "
    + "it — transcribe it from the employee's identity document before handing over the "
    + "certificate (the pack validates DNI 8 digits + letter, NIE X/Y/Z + 7 digits + letter).",
  "Datos de la persona o entidad pagadora (NIF, apellidos y nombre o razón social): the "
    + "product holds no AEAT declarant identity — complete from the employer's AEAT "
    + "registration (the pack's remittanceVendorSettingsKey is null until Orchestrate adds "
    + "an AEAT remittance-party settings field).",
  "Retribuciones en especie (valoración, ingresos a cuenta efectuados y repercutidos): the "
    + "engine prices no in-kind remuneration — value especie from outside payroll.",
  "Contribuciones empresariales a planes de pensiones, PPSE, mutualidades y seguros "
    + "colectivos de dependencia: no channel transcribes them — add from the pension records.",
  "Reducciones (LIRPF art. 18.2/3, DT 11.ª/12.ª) y gastos deducibles (LIRPF art. 19.2, "
    + "incluidas las cuotas a la Seguridad Social): the stubs carry TGSS cuotas, not "
    + "certificate gastos — transcribe from the payroll records, never by copying the SS lines.",
  "Atrasos de ejercicios anteriores (LIRPF art. 14.2.b): the engine imputes by pay date "
    + "(retroactivePayTreatment 'periodic', pack.ts) and cannot re-spread arrears to the year "
    + "they became due — atrasos regularise on declaración complementaria outside payroll.",
  "Reintegros, dietas exceptuadas (RIRPF art. 9) y rentas exentas (clave L): the engine "
    + "tracks no reimbursed, per-diem or exempt amounts — they come from expense records; "
    + "any excess over the exempt limits files under the matching non-L clave instead.",
];

/**
 * One employee-province row as the certificado de retenciones e ingresos a
 * cuenta del IRPF sobre rendimientos del trabajo — the statement RIRPF
 * art. 108.3 (RD 439/2007) obliges the retenedor to issue to each perceptor.
 * The AEAT model prints: datos del perceptor (NIF, apellidos y nombre),
 * datos de la persona o entidad pagadora, detalle de percepciones y
 * retenciones (retribuciones dinerarias: importe íntegro satisfecho,
 * retenciones practicadas; especie: valoración, ingresos a cuenta efectuados
 * y repercutidos; contribuciones a planes/mutualidades/seguros; reducciones;
 * gastos), atrasos, reintegros, dietas y exentas, fecha y firma.
 *
 * Only the dinerarias pair is computable from committed stubs; every other
 * section is a named gap above, never a zero the perceptor would file.
 */
export async function es190Slip(
  orgId: string, taxYear: number, rowId: string,
): Promise<PayrollFilingSlipData> {
  const slips = await es190Slips(orgId, taxYear);
  const slip = slips.find((s) => `${s.employeePartyId}:${s.province}` === rowId);
  if (!slip) {
    throw new PayrollError(`no ${taxYear} Modelo 190 row matches the requested employee/province`);
  }
  return {
    formCode: "ES_CERT_RET",
    formName: "Certificado de retenciones e ingresos a cuenta del IRPF — rendimientos del trabajo",
    headerFields: [
      { label: "Perceptor (apellidos y nombre)", value: slip.employeeName },
      { label: "Ejercicio", value: String(taxYear) },
      {
        label: "Clave de percepción",
        value: "A — Empleados por cuenta ajena en general (sin subclave)",
      },
      { label: "Código de provincia", value: slip.province || "—" },
    ],
    boxes: [
      {
        code: "dinerarias-integro",
        label: "Retribuciones dinerarias — Importe íntegro satisfecho",
        value: slip.percepcionIntegra,
        emphasis: true,
      },
      {
        code: "dinerarias-retenciones",
        label: "Retribuciones dinerarias — Retenciones practicadas",
        value: slip.retencionesPracticadas,
        emphasis: true,
      },
    ],
    notes: [
      "Percepción íntegra is the year's committed taxable earnings; retenciones practicadas "
        + "is the year's committed IRPF lines — the slip ties to the pay runs to the cent.",
      ...ES_GAPS,
    ],
  };
}

/**
 * One quarter as the Modelo 111 aggregate the AEAT instructions define —
 * Instrucciones del Modelo 111, apartado I (rendimientos del trabajo):
 * casilla 01 (n.º de perceptores), casilla 02 (importe de las percepciones
 * dinerarias), casilla 03 (importe de las retenciones).
 */
export async function es111Slip(
  orgId: string, taxYear: number, rowId: string,
): Promise<PayrollFilingSlipData> {
  const quarters = await es111Quarters(orgId, taxYear);
  const quarter = quarters.find((q) => `Q${q.quarter}` === rowId);
  if (!quarter) {
    throw new PayrollError(`no ${taxYear} Modelo 111 quarter matches the requested row`);
  }
  return {
    formCode: "ES_111",
    formName: "Modelo 111 — Retenciones e ingresos a cuenta (rendimientos del trabajo)",
    formNumber: "Modelo 111",
    headerFields: [
      { label: "Ejercicio", value: String(taxYear) },
      { label: "Período", value: `Trimestre ${quarter.quarter} (Q${quarter.quarter})` },
    ],
    boxes: [
      {
        code: "01",
        label: "N.º de perceptores — rendimientos dinerarios del trabajo",
        value: String(quarter.perceptores),
      },
      {
        code: "02",
        label: "Importe de las percepciones — rendimientos dinerarios del trabajo",
        value: quarter.percepciones,
        emphasis: true,
      },
      {
        code: "03",
        label: "Importe de las retenciones — rendimientos dinerarios del trabajo",
        value: quarter.retenciones,
        emphasis: true,
      },
    ],
    notes: [
      "Cash-basis: percepciones satisfechas en el trimestre — the quarter comes from each "
        + "committed stub's pay date, and the worksheet ties to the pay runs to the cent.",
      "Rendimientos en especie (casillas 04–06) and apartados II onward (actividades "
        + "económicas, premios, cesión de imagen): the engine prices no especie and payroll "
        + "never produces non-employment income — complete those apartados from outside payroll.",
      "Autoliquidación trimestral (20 primeros días de abril, julio, octubre y enero); "
        + "grandes empresas autoliquidan mensualmente — regroup the same committed stubs by "
        + "month from the pay dates above.",
    ],
  };
}

/**
 * The corrected certificado: what was reported beside what is correct.
 *
 * The AEAT corrects a 190 by re-filing the SAME return — declaración
 * complementaria (percepciones omitted from an earlier filing of the same
 * ejercicio: only the omitted ones travel) or sustitutiva (annuls and fully
 * replaces an earlier filing with inexact data), quoting the 13-digit
 * justificante of the replaced declaration (Instrucciones del Modelo 190,
 * "Declaración complementaria o sustitutiva"). A filed quarter is never
 * withdrawn empty, so only `amended` is declared — there is no cancelled.
 */
export async function es190CorrectionSlip(row: PayrollFilingCorrectionRow): Promise<PayrollFilingSlipData> {
  const boxes = row.changes
    .filter((change) => change.code != null)
    .flatMap((change) => [
      { code: change.code!, label: `${change.label} — declarado`, value: change.previous ?? "—" },
      {
        code: change.code!, label: `${change.label} — rectificado`, value: change.current ?? "—",
        emphasis: true,
      },
    ]);
  const identity = row.changes
    .filter((change) => change.code == null)
    .map((change) => ({
      label: `Declarado — ${change.label}`,
      value: change.redacted ? "changed (not displayed)" : (change.previous ?? "—"),
    }));
  if (boxes.length === 0 && identity.length === 0) {
    throw new PayrollError(
      `nothing on ${row.label}'s certificado changed — a complementaria/sustitutiva that `
      + "restates the same figures tells the AEAT nothing and must not be filed",
    );
  }
  return {
    formCode: "ES_CERT_RET",
    formName: "Certificado de retenciones — rectificado (complementaria / sustitutiva del Modelo 190)",
    headerFields: [
      ...row.current.headerFields,
      { label: "Clase de declaración", value: "Complementaria o sustitutiva del Modelo 190" },
      ...identity,
    ],
    boxes,
    notes: [
      "Only the figures that moved are restated; every other figure on the original stands. "
        + "The amounts are recomputed from committed pay stubs — a corrected certificate can "
        + "never disagree with the payroll subledger it summarizes.",
      "Quote the 13-digit justificante of the declaration being replaced, and file only the "
        + "omitted percepciones on a complementaria, the full replacement on a sustitutiva.",
    ],
  };
}
