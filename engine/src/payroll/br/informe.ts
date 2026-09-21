import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { add } from "../../money/money.ts";
import { assertPayrollCountryKnown } from "../country.ts";
import {
  assertPayrollFilingAccountKnown,
  filingAccountRef,
  filingAccountsById,
} from "../filing.ts";
import { PayrollError } from "../error.ts";
import type {
  PayrollFilingData,
  PayrollFilingRowScope,
  PayrollFilingSlipData,
} from "../filing-registry.ts";
import { BR_TAX_YEARS } from "./rates.ts";
import { BR_2024_DEPENDENTE } from "./tax-year-2024.ts";
import { BR_2025_DEPENDENTE } from "./tax-year-2025.ts";
import { BR_2026_DEPENDENTE } from "./tax-year-2026.ts";

/**
 * The BR pack's year-end builders: the Comprovante de Rendimentos Pagos e de
 * Imposto sobre a Renda Retido na Fonte (the "informe de rendimentos") the
 * employer must furnish each employee for their annual return.
 *
 * Authority: Instrução Normativa RFB nº 2.060/2021 (DOU 15/12/2021, in force
 * 1/1/2022 — it revoked IN RFB nº 1.215/2011). Art. 2º: whoever paid an
 * individual income with withholding during the calendar year, even in a
 * single month, furnishes the Comprovante on the Anexo I model. Art. 3º: the
 * deadline is the last business day of February following the payment year
 * (on rescission, at rescission if earlier). Art. 4º: the statement carries
 * the nature and amount of the income, the deductions and the IRRF for the
 * calendar year as annual totals in reais, plus complementary information,
 * per the Anexo II fill instructions. Art. 5º: R$ 41,43 fine per
 * missing/inaccurate comprovante — the reason a wrong one is corrected.
 *
 * The boxes below are IN 2.060/2021 Anexo II Quadro/Linha vocabulary, read
 * off the Receita Federal normas portal. Every figure is a sum over the
 * year's COMMITTED pay runs — what was actually paid and withheld, never a
 * recomputation. Annual figures span the mid-year IRRF table changes
 * (2024-02-01, 2025-05-01) because each month was priced through the table
 * in force for its pay month; the slip adds months, never reprices them.
 */

/** Years with transcribed monthly tables, off the pack's own declaration. */
export function brInformeYears(): number[] {
  // Both prior years carry two published editions (one per mid-year IRRF
  // table), so the year list dedupes — the informe is annual either way.
  return [...new Set(
    BR_TAX_YEARS.editions
      .filter((edition) => edition.status === "published")
      .map((edition) => edition.year),
  )].sort((a, b) => a - b);
}

/**
 * Refuse a year the pack cannot price — before touching the database, so an
 * uncovered year refuses deterministically for every caller.
 */
export function assertBrInformeYearSupported(taxYear: number): void {
  if (!brInformeYears().includes(taxYear)) {
    throw new PayrollError(
      `BR payroll: tax year ${taxYear} has not been transcribed — the transcribed years are `
      + `${brInformeYears().join(", ")} (see engine/src/payroll/br/tax-year-2024.ts, `
      + "tax-year-2025.ts and tax-year-2026.ts). "
      + "Transcribe the year's Portaria + monthly tables before issuing informes de rendimentos",
    );
  }
}

/** The monthly dependent deduction off the year's own module (Lei 9.250/1995, art. 4º). */
export function brDependenteValue(taxYear: number): string {
  assertBrInformeYearSupported(taxYear);
  if (taxYear === 2024) return BR_2024_DEPENDENTE;
  if (taxYear === 2025) return BR_2025_DEPENDENTE;
  return BR_2026_DEPENDENTE;
}

/**
 * Which reporting channel the year's figures travel on — the live DIRF
 * sunset, settled per year:
 * - 2024: DIRF still applies (IN RFB nº 1.990/2020; IN RFB nº 2.181/2024
 *   postponed the extinction so substitution starts with facts from
 *   1/1/2025 — the 2024 facts still went on DIRF 2025, due February 2025).
 * - 2025+: DIRF extinguished for facts from 1/1/2025 (IN RFB nº 2.163/2023,
 *   art. 3º §1º, as amended by IN RFB nº 2.181/2024): employer remuneration
 *   via eSocial event S-1210, other-source withholding via the EFD-Reinf
 *   R-4000 series (plus S-2501 for labour claims). The Comprovante owed to
 *   the employee survives the sunset (IN RFB nº 2.060/2021 stands).
 */
export function brInformeChannelNote(taxYear: number): string {
  assertBrInformeYearSupported(taxYear);
  if (taxYear === 2024) {
    return "2024 facts still travel on the DIRF (IN RFB nº 1.990/2020; IN RFB nº 2.181/2024 "
      + "postponed the extinction to facts from 1/1/2025), alongside the monthly eSocial and "
      + "EFD-Reinf events.";
  }
  return `DIRF is extinta for ${taxYear} facts (IN RFB nº 2.163/2023 art. 3º §1º, as amended by IN RFB `
    + "nº 2.181/2024 — substitution for facts from 1/1/2025): remuneration travels on eSocial "
    + "event S-1210 and other-source withholding on the EFD-Reinf R-4000 series. The Comprovante "
    + "owed to the employee is unchanged (IN RFB nº 2.060/2021).";
}

/**
 * The row-id UUID shape, LOCAL to this module (the CA precedent): a value
 * import of the registry's shared helper would close a module-evaluation
 * cycle (registry → packs → br/pack → here → registry) and read
 * BR_PAYROLL_PACK before initialisation. Type imports are erased and cost
 * nothing.
 */
const INFORME_ROW_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The informe row grammar, as the inverse of brInformeRows'
 * `employee:account` construction (the account empty for the unassigned
 * aggregate — the W-2 grammar's shape, owned HERE beside the builder).
 */
export function parseBrInformeRowId(rowId: string): PayrollFilingRowScope | null {
  const parts = rowId.split(":");
  const employee = parts[0] ?? "";
  const account = parts[1] ?? "";
  if (parts.length !== 2 || !INFORME_ROW_UUID_RE.test(employee)) return null;
  if (account && !INFORME_ROW_UUID_RE.test(account)) return null;
  return { employees: [employee], accounts: account ? [account] : [] };
}

/** One employee's annual informe figures, straight off committed stubs. */
export interface BrInformeRow {
  employeePartyId: string;
  employeeName: string;
  filingAccountId: string | null;
  /** Dependent count on record (the profile column the monthly IRRF read). */
  dependentes: number | null;
  /** Quadro 3, Linha 1 — total taxable income paid in the year. */
  rendimentos: string;
  /** Quadro 3, Linha 2 — official social-security contributions withheld. */
  inss: string;
  /** Quadro 3, Linha 5 — IRRF withheld on the Linha 1 income. */
  irrf: string;
}

const num = (value: unknown): string => (value == null ? "0" : String(value));

/**
 * Every employee paid through committed BR runs in the year, with the
 * Anexo II Quadro 3 lines the subledger can answer. A year with no
 * committed runs refuses BY NAME: an empty statutory form is a wrong
 * statutory form.
 */
export async function brInformeRows(orgId: string, taxYear: number): Promise<BrInformeRow[]> {
  assertBrInformeYearSupported(taxYear);
  await assertPayrollCountryKnown(db, orgId, taxYear);
  await assertPayrollFilingAccountKnown(db, orgId, { taxYear });
  const rows = (await db.execute<Record<string, unknown>>(sql`
    with committed as (
      select s.*
        from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
     where s.org_id = ${orgId} and s.tax_year = ${taxYear}
       and s.country = 'BR'
    )
    select c.employee_party_id, p.display_name, c.filing_account_id,
           max(prof.br_dependentes) as dependentes,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = c.id and l.kind = 'earning'
                  and coalesce(pc.taxable, true))) as rendimentos,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = c.id and l.kind = 'deduction'
                  and pc.system_key = 'inss')) as inss,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = c.id and l.kind = 'deduction'
                  and pc.system_key = 'irrf')) as irrf
      from committed c
      join parties p on p.id = c.employee_party_id and p.org_id = ${orgId}
      left join employee_payroll_profiles prof
        on prof.org_id = ${orgId} and prof.employee_party_id = c.employee_party_id
     group by c.employee_party_id, p.display_name, c.filing_account_id
     order by p.display_name
  `));
  if (rows.rows.length === 0) {
    throw new PayrollError(
      `no committed BR pay runs for ${taxYear} — calculate and commit a BR pay run for the year `
      + "before issuing Comprovantes de Rendimentos; a draft or uncommitted run never appears "
      + "on a statutory filing",
    );
  }
  return rows.rows.map((row) => ({
    employeePartyId: String(row.employee_party_id),
    employeeName: String(row.display_name),
    filingAccountId: (row.filing_account_id as string | null) ?? null,
    dependentes: row.dependentes == null ? null : Number(row.dependentes),
    rendimentos: num(row.rendimentos),
    inss: num(row.inss),
    irrf: num(row.irrf),
  }));
}

export async function brInformePopulation(orgId: string, taxYear: number): Promise<PayrollFilingData> {
  const slips = await brInformeRows(orgId, taxYear);
  const total = (pick: (slip: BrInformeRow) => string) =>
    slips.reduce((acc, slip) => add(acc, pick(slip)), "0");
  return {
    rowKey: "rowId",
    columns: [
      { key: "employee", label: "Employee" },
      { key: "rendimentos", label: "Rendimentos tributáveis (Q3-1)", align: "right", money: true },
      { key: "inss", label: "Previdência oficial (Q3-2)", align: "right", money: true },
      { key: "irrf", label: "IRRF retido (Q3-5)", align: "right", money: true },
      { key: "dependentes", label: "Dependentes" },
    ],
    rows: slips.map((slip) => ({
      rowId: `${slip.employeePartyId}:${slip.filingAccountId ?? ""}`,
      employee: slip.employeeName,
      rendimentos: slip.rendimentos,
      inss: slip.inss,
      irrf: slip.irrf,
      dependentes: slip.dependentes,
    })),
    totals: [
      { label: "Comprovantes", value: String(slips.length) },
      { label: "Rendimentos tributáveis", value: total((s) => s.rendimentos), money: true },
      { label: "Previdência oficial", value: total((s) => s.inss), money: true },
      { label: "IRRF retido", value: total((s) => s.irrf), money: true },
    ],
  };
}

/**
 * One employee's Comprovante, box for box in the authority's own Quadro/Linha
 * vocabulary. Boxes the subledger cannot answer are NOT printed as zeros —
 * each names its reason in the notes, with the real remedy:
 * - Q3-3 (previdência complementar/FAPI): the pack prices no such
 *   contribution, so no total exists — complete it from the entidade's
 *   records (Anexo II, Quadro 3, Linha 3).
 * - Q3-4 (pensão alimentícia): br_pensao_mensal reduces the monthly IRRF
 *   base inside the engine but is pushed as no stub line, so no annual paid
 *   total exists — complete it from the court-ordered payment records
 *   (Anexo II, Quadro 3, Linha 4).
 * - Quadro 4 (isentos e não tributáveis): the BR component vocabulary maps
 *   no exempt income — complete any such amount from its source records.
 * - Quadro 5 (tributação exclusiva, incl. 13º): 13º, férias and rescisão are
 *   named engine refusals (monthly CLT only) — complete from the 13º/PLR
 *   source records.
 * - Quadro 6 (RRA): the engine carries no rendimentos recebidos
 *   acumuladamente vocabulary — complete from the award records.
 * - Quadro 7 (complementares): beyond the dependentes below, health-plan and
 *   other payroll-deducted reimbursements are not in the BR component
 *   vocabulary — complete from the operator/plan records.
 */
export async function brInformeSlip(
  orgId: string,
  taxYear: number,
  rowId: string,
): Promise<PayrollFilingSlipData> {
  const slips = await brInformeRows(orgId, taxYear);
  const slip = slips.find(
    (s) => `${s.employeePartyId}:${s.filingAccountId ?? ""}` === rowId,
  );
  if (!slip) {
    throw new PayrollError(`no ${taxYear} Comprovante de Rendimentos matches the requested employee`);
  }
  const account = filingAccountRef(slip.filingAccountId, await filingAccountsById(orgId));
  const dependente = brDependenteValue(taxYear);
  return {
    formCode: "BR_INFORME",
    formName: "Comprovante de Rendimentos Pagos e de Imposto sobre a Renda Retido na Fonte",
    formNumber: "IN RFB nº 2.060/2021 · Anexo I",
    headerFields: [
      { label: "Beneficiário", value: slip.employeeName },
      {
        label: "CNPJ do estabelecimento",
        value: account.accountNumber
          ? `${account.accountNumber}${account.name ? ` · ${account.name}` : ""}`
          : "Unassigned",
      },
      { label: "Ano-calendário", value: String(taxYear) },
      {
        label: "Dependentes (dedução IRRF, Lei 9.250/1995 art. 4º)",
        value: slip.dependentes == null
          ? "not on record"
          : `${slip.dependentes} × R$ ${dependente}`,
      },
    ],
    boxes: [
      {
        code: "Q3-1",
        label: "Quadro 3, Linha 1 — Total dos rendimentos tributáveis (inclusive férias)",
        value: slip.rendimentos,
      },
      {
        code: "Q3-2",
        label: "Quadro 3, Linha 2 — Contribuição Previdenciária Oficial (INSS segurado)",
        value: slip.inss,
      },
      {
        code: "Q3-5",
        label: "Quadro 3, Linha 5 — Imposto sobre a Renda Retido na Fonte sobre a Linha 1",
        value: slip.irrf,
        emphasis: true,
      },
    ],
    notes: [
      "The beneficiary's CPF (the Anexo I identification) is not printed — the pack holds no "
      + "CPF column (its identifier declaration is a validation pattern for eSocial, not "
      + "storage); complete it from the eSocial cadastro before furnishing.",
      "Each month was priced through the IRRF table in force for its pay month; the annual "
      + "figures add months, never reprice them.",
      "The dependent deduction (R$ 189,59 per dependent per month, Lei 9.250/1995 art. 4º) "
      + "lives inside each month's IRRF — the count above is the cadastre count on record, "
      + "not a repriced annual total.",
      "Quadro 3, Linha 3 (previdência complementar/FAPI) is not produced — the pack prices no "
      + "such contribution, so the subledger holds no total; complete it from the entidade's records.",
      "Quadro 3, Linha 4 (pensão alimentícia) is not produced — br_pensao_mensal reduces the "
      + "monthly IRRF base but is pushed as no stub line, so no annual paid total exists; complete "
      + "it from the court-ordered payment records.",
      "Quadro 4 (isentos e não tributáveis), Quadro 5 (tributação exclusiva, incl. 13º salário) "
      + "and Quadro 6 (RRA) are not produced — the BR component vocabulary maps no exempt, "
      + "exclusive-source or accumulated income (13º, férias and rescisão are named engine "
      + "refusals); complete any such amount from its source records.",
      "Quadro 7 health-plan and other complementary deductions are not produced — they are not "
      + "in the BR component vocabulary; complete them from the operator/plan records.",
      brInformeChannelNote(taxYear),
      "Furnish to the beneficiary by the last business day of February following the "
      + "ano-calendário (IN RFB nº 2.060/2021, art. 3º).",
    ],
  };
}
