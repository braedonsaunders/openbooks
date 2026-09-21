/**
 * The AU STP finalisation population: per-employee year-to-date figures off
 * the committed-stub subledger.
 *
 * What a finalisation declaration asserts (ATO Single Touch Payroll employer
 * reporting guidelines): a declaration in the approved form given to the
 * Commissioner of Taxation BY 14 JULY, stating the employer has fully
 * reported for the financial year and for each employee using Single Touch
 * Payroll. It is what flips employee income statements to tax-ready in
 * myGov — payment summaries were replaced by STP, so there is no slip the
 * employer issues; the obligation is this declaration plus the YTD figures
 * it declares. The population below IS those figures, reconciled to the
 * year's committed, posted runs to the cent.
 *
 * Superannuation in the finalisation: STP reports, as a minimum, the
 * LIABILITY for superannuation guarantee or ordinary time earnings (the
 * actual cash payment to the fund is never STP-reported). The liability
 * basis is exactly what the subledger carries — the stub's
 * `super_guarantee` employer-contribution lines, priced by the pack at 12%
 * of ordinary time earnings (SGAA 1992 s17A(2), Compilation C2026C00272;
 * see ./tax-year-2027.ts AU_SUPER_2027). Both are populated: the SG
 * liability and the OTE base it was priced on.
 *
 * STP Phase 2 disaggregates gross (ATO Phase 2 employer reporting
 * guidelines, "Reporting the amounts you have paid: Disaggregation of
 * gross": all remuneration not separately itemised is reported as gross).
 * The subledger classifies earning lines by component system_key, so
 * overtime, bonuses and paid leave are split out of the gross total and
 * everything else stays in gross. Categories the subledger cannot see —
 * allowances, directors' fees, employment termination payments (the pack
 * refuses Schedule 12, see AU_REFUSED_2027), lump sums — are declared
 * unsupported on the filing, never guessed.
 *
 * Cycle discipline (the ES-pack TDZ lesson): this module takes NO runtime
 * edge to `../packs.ts` or `../filing-registry.ts`. The tax-year coverage
 * is read off the pack's OWN declaration (./rates.ts AU_TAX_YEARS), the
 * row-id grammar and figures live in the leaf ./stp-figures.ts beside it,
 * and filing-registry/packs types arrive as `import type` only. Runtime
 * imports here are the query layer (drizzle, platform/db), the pack error,
 * and the two guard queries — none of which import a country pack back.
 */
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { assertPayrollCountryKnown } from "../country.ts";
import { assertPayrollFilingAccountKnown } from "../filing.ts";
import { PayrollPackError } from "../payroll-error.ts";
import {
  assertAuFinalisationYear,
  auFinancialYearLabel,
  type AuStpFinalisationRow,
} from "./stp-figures.ts";

export type { AuStpFinalisationRow };

const num = (value: unknown): string => (value == null ? "0" : String(value));

/**
 * Per-employee STP year-to-date figures from COMMITTED, POSTED pay runs —
 * what was actually paid and withheld, never a recomputation. A draft or
 * uncommitted run joins out through `r.run_status = 'committed'` and can
 * never appear on the declaration.
 *
 * Refuses by name (never an empty form — an empty statutory reconciliation
 * is a wrong one): an uncovered year via assertAuFinalisationYear, a year
 * with no committed AU runs via the no-stubs refusal below.
 */
export async function auStpFinalisationRows(
  orgId: string, taxYear: number,
): Promise<AuStpFinalisationRow[]> {
  assertAuFinalisationYear(taxYear);
  await assertPayrollCountryKnown(db, orgId, taxYear);
  await assertPayrollFilingAccountKnown(db, orgId, { taxYear });
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select s.employee_party_id, p.display_name,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = 'earning')) as gross,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = 'earning'
                  and pc.system_key = 'overtime')) as overtime,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = 'earning'
                  and pc.system_key = 'bonus')) as bonuses,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = 'earning'
                  and pc.system_key = 'vacation_payout')) as paid_leave,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = 'deduction'
                  and pc.system_key = 'payg_withholding')) as payg,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = 'employer_contribution'
                  and pc.system_key = 'super_guarantee')) as sg,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = 'deduction'
                  and pc.tax_treatment = 'salary_sacrifice')) as sacrifice,
           sum(s.pensionable_earnings) as ote
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      join parties p on p.id = s.employee_party_id and p.org_id = ${orgId}
     where s.org_id = ${orgId} and s.tax_year = ${taxYear} and s.country = 'AU'
     group by s.employee_party_id, p.display_name
     order by p.display_name, s.employee_party_id
  `));
  if (rows.rows.length === 0) {
    throw new PayrollPackError(
      `AU STP finalisation for ${auFinancialYearLabel(taxYear)} (taxYear ${taxYear}): `
      + "no committed AU pay runs — the finalisation declares year-to-date figures that were "
      + "actually paid, so a year with nothing committed has nothing to declare. Commit and post "
      + "the year's pay runs before finalising.",
    );
  }
  return rows.rows.map((row) => ({
    employeePartyId: String(row.employee_party_id),
    employeeName: String(row.display_name),
    gross: num(row.gross),
    overtime: num(row.overtime),
    bonusesCommissions: num(row.bonuses),
    paidLeave: num(row.paid_leave),
    paygWithheld: num(row.payg),
    sgLiability: num(row.sg),
    salarySacrifice: num(row.sacrifice),
    oteBase: num(row.ote),
  }));
}
