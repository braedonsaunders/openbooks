import { sql } from "drizzle-orm";
import { add } from "../../money/money.ts";
import { db } from "../../platform/db.ts";
import { PayrollError } from "../error.ts";
import { assertPayrollCountryKnown } from "../country.ts";
import { assertPayrollFilingAccountKnown } from "../filing.ts";
import type {
  PayrollFilingData,
  PayrollFilingRowScope,
  PayrollYearEndFiling,
} from "../filing-registry.ts";

/**
 * The IE pack's filing declaration: the PAYE Modernisation reconciliation.
 *
 * Ireland has no employer-issued annual slip to build. The P60 was abolished
 * with PAYE Modernisation on 1 January 2019 (with the P35, P45, P30 and P46 —
 * Oireachtas debate 25 Oct 2018; Citizens Information "Employment Detail
 * Summary (formerly P60)"), and the employee's annual statement — the
 * Employment Detail Summary — is produced by Revenue from the employer's
 * per-pay-period payroll submissions and collected via Revenue myAccount, not
 * issued by the employer. A cessation is likewise reported through the
 * submission. Inventing a P60 the law no longer recognises would be worse
 * than declaring nothing, so this filing declares NO slip: `hasSlip` is
 * false and the surface renders the population table.
 *
 * What the filing DOES declare is what an Irish employer can be given: the
 * reconciliation proving the year's committed runs agree with what was
 * withheld — PAYE, PRSI (employee and employer) and USC per employee, tying
 * to the runs to the cent. The PRSI columns split pre/post 1 October by pay
 * date because the Class A rates step mid-year (the 2026 October edition,
 * effective 2026-10-01 — engine/src/payroll/ie/pack.ts IE_TAX_YEARS); each
 * half reconciles against its own edition's tables.
 *
 * Import discipline (the ES TDZ lesson, following the CA precedent): this
 * module takes NO runtime edge to ../packs.ts or ../filing-registry.ts —
 * both are `import type` only, erased at compile time — and carries its own
 * row-id grammar rather than importing a shared helper. The uncovered-year
 * refusal needs no lookup here either: the generic enumeration
 * (`orgYearEndFilings`) refuses a year the pack does not publish uniformly
 * before `population` is ever called.
 */

/** One employee's reconciled year: every figure a sum off committed stubs. */
export interface IeReconciliationRow {
  employeePartyId: string;
  employeeName: string;
  filingAccountId: string | null;
  grossPay: string;
  taxablePay: string;
  reckonablePay: string;
  paye: string;
  prsiEmployeePre: string;
  prsiEmployeePost: string;
  prsiEmployerPre: string;
  prsiEmployerPost: string;
  usc: string;
}

/**
 * The PRSI mid-year step date for a tax year, as an ISO date. The Class A
 * rates step on 1 October (2026 October edition effective 2026-10-01; the
 * Roadmap stepped 1 October in 2024 and 2025 likewise). The reconciliation
 * attributes each stub by its pay date against this boundary — never by
 * year — so either half of the year prices against its own edition.
 */
export function iePrsiStepDate(taxYear: number): string {
  return `${taxYear}-10-01`;
}

const num = (value: unknown): string => (value == null ? "0" : String(value));

/**
 * The year's reconciliation, straight off the committed-stub subledger —
 * reported, never recomputed. A draft or uncommitted run must not appear on
 * a statutory surface, so only `committed` runs count; voided documents are
 * excluded exactly as `ieEmployeeYtd` excludes them, so this table agrees
 * with the cumulative positions the engine priced from. Refuses by name
 * when there is nothing to reconcile: an empty table would read as "nil
 * withheld" and be believed.
 */
export async function iePayeReconciliation(
  orgId: string,
  taxYear: number,
): Promise<IeReconciliationRow[]> {
  await assertPayrollCountryKnown(db, orgId, taxYear);
  await assertPayrollFilingAccountKnown(db, orgId, { taxYear });
  const stepDate = iePrsiStepDate(taxYear);
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select s.employee_party_id, p.display_name,
           s.filing_account_id as filing_account_id,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = 'earning')) as gross,
           sum(coalesce((s.factors->>'IE_TAXBASE')::numeric, 0)) as taxable,
           sum(s.pensionable_earnings) as reckonable,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = 'deduction'
                  and pc.system_key = 'ie_paye')) as paye,
           sum(case when s.pay_date < ${stepDate}::date
                    then (select coalesce(sum(l.amount), 0) from pay_stub_lines l
                           join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                          where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = 'deduction'
                            and pc.system_key = 'prsi')
                    else 0 end) as prsi_ee_pre,
           sum(case when s.pay_date >= ${stepDate}::date
                    then (select coalesce(sum(l.amount), 0) from pay_stub_lines l
                           join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                          where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = 'deduction'
                            and pc.system_key = 'prsi')
                    else 0 end) as prsi_ee_post,
           sum(case when s.pay_date < ${stepDate}::date
                    then (select coalesce(sum(l.amount), 0) from pay_stub_lines l
                           join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                          where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = 'employer_contribution'
                            and pc.system_key = 'prsi')
                    else 0 end) as prsi_er_pre,
           sum(case when s.pay_date >= ${stepDate}::date
                    then (select coalesce(sum(l.amount), 0) from pay_stub_lines l
                           join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                          where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = 'employer_contribution'
                            and pc.system_key = 'prsi')
                    else 0 end) as prsi_er_post,
           sum((select coalesce(sum(l.amount), 0) from pay_stub_lines l
                 join pay_components pc on pc.id = l.component_id and pc.org_id = l.org_id
                where l.org_id = ${orgId} and l.stub_id = s.id and l.kind = 'deduction'
                  and pc.system_key = 'usc')) as usc
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
        and r.run_status = 'committed'
      join documents d on d.id = r.document_id and d.org_id = r.org_id
        and d.status <> 'voided'
      join parties p on p.id = s.employee_party_id and p.org_id = ${orgId}
     where s.org_id = ${orgId} and s.tax_year = ${taxYear} and s.country = 'IE'
     group by s.employee_party_id, p.display_name, s.filing_account_id
     order by p.display_name
  `));
  if (rows.rows.length === 0) {
    throw new PayrollError(
      `no committed IE pay stubs for tax year ${taxYear} — run, calculate and commit `
      + "an IE pay run before reconciling the year's PAYE, PRSI and USC",
    );
  }
  return rows.rows.map((row) => ({
    employeePartyId: String(row.employee_party_id),
    employeeName: String(row.display_name),
    filingAccountId: (row.filing_account_id as string | null) ?? null,
    grossPay: num(row.gross),
    taxablePay: num(row.taxable),
    reckonablePay: num(row.reckonable),
    paye: num(row.paye),
    prsiEmployeePre: num(row.prsi_ee_pre),
    prsiEmployeePost: num(row.prsi_ee_post),
    prsiEmployerPre: num(row.prsi_er_pre),
    prsiEmployerPost: num(row.prsi_er_post),
    usc: num(row.usc),
  }));
}

/**
 * The row grammar, as the inverse of `iePopulation`'s
 * `employee:account` construction (the account empty for the unassigned
 * aggregate). Owned HERE, beside the builder — the subsidiary-scope guard
 * parses through the declaration, never its own copy of this shape. The UUID
 * shape mirrors `isFilingRowUuid` in ../filing-registry.ts (the canonical
 * definition); the copy is deliberate, per the CA precedent — a runtime
 * import of the registry from a pack module is a module-evaluation cycle.
 */
const IE_ROW_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseIeReconciliationRowId(rowId: string): PayrollFilingRowScope | null {
  const parts = rowId.split(":");
  const employee = parts[0] ?? "";
  const account = parts[1] ?? "";
  if (parts.length !== 2 || !IE_ROW_UUID_RE.test(employee)) return null;
  if (account && !IE_ROW_UUID_RE.test(account)) return null;
  return { employees: [employee], accounts: account ? [account] : [] };
}

async function iePopulation(orgId: string, taxYear: number): Promise<PayrollFilingData> {
  const reconciliation = await iePayeReconciliation(orgId, taxYear);
  // The employer-side tie (the PL PIT-4R lesson): Ireland's employer
  // obligation is the per-pay-period ROS submission, not a second annual
  // filing — so no second filing is declared. Instead these totals are the
  // figure the year's submissions must sum to: exact-decimal `add`, no floats.
  const total = (pick: (row: IeReconciliationRow) => string): string =>
    reconciliation.reduce((acc, row) => add(acc, pick(row)), "0");
  const totalPrsi = add(
    add(total((row) => row.prsiEmployeePre), total((row) => row.prsiEmployeePost)),
    add(total((row) => row.prsiEmployerPre), total((row) => row.prsiEmployerPost)),
  );
  return {
    rowKey: "rowId",
    columns: [
      { key: "employee", label: "Employee" },
      { key: "grossPay", label: "Gross pay", align: "right", money: true },
      { key: "taxablePay", label: "Taxable pay", align: "right", money: true },
      { key: "reckonablePay", label: "Reckonable pay", align: "right", money: true },
      { key: "paye", label: "PAYE", align: "right", money: true },
      { key: "prsiEmployeePre", label: "PRSI ee (pre-Oct)", align: "right", money: true },
      { key: "prsiEmployeePost", label: "PRSI ee (post-Oct)", align: "right", money: true },
      { key: "prsiEmployerPre", label: "PRSI er (pre-Oct)", align: "right", money: true },
      { key: "prsiEmployerPost", label: "PRSI er (post-Oct)", align: "right", money: true },
      { key: "usc", label: "USC", align: "right", money: true },
    ],
    rows: reconciliation.map((row) => ({
      rowId: `${row.employeePartyId}:${row.filingAccountId ?? ""}`,
      employee: row.employeeName,
      grossPay: row.grossPay,
      taxablePay: row.taxablePay,
      reckonablePay: row.reckonablePay,
      paye: row.paye,
      prsiEmployeePre: row.prsiEmployeePre,
      prsiEmployeePost: row.prsiEmployeePost,
      prsiEmployerPre: row.prsiEmployerPre,
      prsiEmployerPost: row.prsiEmployerPost,
      usc: row.usc,
    })),
    totals: [
      { label: "Employees", value: String(reconciliation.length) },
      { label: "Gross pay", value: total((row) => row.grossPay), money: true },
      { label: "PAYE", value: total((row) => row.paye), money: true },
      { label: "PRSI (employee + employer)", value: totalPrsi, money: true },
      { label: "USC", value: total((row) => row.usc), money: true },
    ],
  };
}

/** Lazy, like caPackFilings/usPackFilings: the declaration must not be
 * dereferenced at module-evaluation time (see the import discipline above). */
let cached: PayrollYearEndFiling | null = null;

export function iePayeReconciliationFiling(): PayrollYearEndFiling {
  cached ??= {
    key: "paye-reconciliation",
    label: "PAYE Modernisation reconciliation",
    cadence: "annual",
    description: "Year-end reconciliation of PAYE, PRSI and USC withheld on committed IE pay runs. "
      + "Ireland issues no employer annual slip: the P60 was abolished with PAYE Modernisation "
      + "(1 January 2019) and the Employment Detail Summary is produced by Revenue from the "
      + "employer's per-pay-period payroll submissions — collect it via Revenue myAccount. "
      + "PRSI splits pre/post 1 October by pay date against the year's mid-year step.",
    emptyText: "No committed IE pay stubs for this year.",
    population: (orgId, taxYear) => iePopulation(orgId, taxYear),
    parseRowId: parseIeReconciliationRowId,
    downloadRefusal:
      "the IE pack produces no ROS payroll-submission file — the reconciliation above is the "
      + "source data; submit each pay period's payroll to Revenue through Revenue Online "
      + "Service (ROS)",
    // An issued submission is corrected by sending a corrected payroll
    // submission for the same pay period — there is no separate correction
    // form, and this product does not transmit. `supported: false` with the
    // real remedy, never another agency's mechanics.
    amendment: {
      supported: false,
      refusal: "the IE pack does not correct an issued submission in-product — correct the pay "
        + "period in payroll and send a corrected payroll submission for that period to Revenue "
        + "through Revenue Online Service (ROS); the reconciliation above carries what was withheld",
    },
  };
}

/** The declaration object, for the pack and for tests. */
export const IE_PAYE_RECONCILIATION_FILING: PayrollYearEndFiling =
  iePayeReconciliationFiling();
