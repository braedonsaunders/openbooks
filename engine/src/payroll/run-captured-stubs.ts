import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from "./scope.ts";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  type PayRunCalculationError,
  type PayRunRefusalAcknowledgement,
} from "./run-calculation-evidence.ts";

/** One line of a stub, as `captureCalculatedStubs` hands it back. */
export interface CapturedStubLine {
  componentId: string | null;
  systemKey: string | null;
  kind: "earning" | "deduction" | "employer_contribution" | "credit";
  description: string;
  hours: string | null;
  derivedQuantity: string | null;
  derivedRuleCode: string | null;
  rate: string | null;
  amount: string;
  /** Dated earnings provenance retained for wage and allocation review. */
  earnedFrom: string | null;
  earnedTo: string | null;
  paymentKind: "cash" | "non_cash";
  nonCashAccountId: string | null;
  projectId: string | null;
  departmentId: string | null;
  timeTypeId: string | null;
  itemId: string | null;
  /** Expense stamp resolved at calculate (migration 0180); nulls when the
   * line carries no stamp and posts through the component-then-default
   * fallback. This is what the operator saw on screen at calculate. */
  expenseAccountId: string | null;
  expenseAccountSource: string;
  expenseAccountEvidence: { reason: string; reference: string } | null;
  sequence: number;
}

/** One employee's whole calculated result, read back inside the transaction. */
export interface CapturedStub {
  employeePartyId: string;
  province: string;
  gross: string;
  netPay: string;
  employerCost: string;
  /** Statutory calculation evidence retained even when the preview rolls back. */
  factors: Record<string, string>;
  lines: CapturedStubLine[];
}

export interface PayRunCalculation {
  employees: number;
  errors: PayRunCalculationError[];
  gross: string;
  net: string;
  employerCost: string;
  /**
   * The stubs the calculation produced, present for dry runs and simulations.
   * Read back inside the transaction that is about to be rolled back, which is
   * the whole point: the caller gets the calculation's real output without any
   * of it surviving.
   */
  stubs?: CapturedStub[];
  /**
   * The run's acknowledgement AFTER this calculate, read in the same
   * transaction: a successful calculate clears any stale acknowledgement
   * (nothing refused, nothing to acknowledge), otherwise the stored record
   * survives untouched. Valid exactly when `refusalsAcknowledged`, so the
   * caller never has to re-derive the gate client-side.
   */
  refusalAcknowledgement: PayRunRefusalAcknowledgement | null;
  refusalsAcknowledged: boolean;
}

/**
 * Read a run's just-calculated stubs back, inside the calculating transaction.
 *
 * Exported because retro pay's quantification needs the LINES, not the totals:
 * "what would this period pay today" only answers the retro question when it
 * can be differenced component by component and job by job against what the
 * period actually paid (engine/src/payroll/retro.ts).
 */
export async function captureCalculatedStubs(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  documentId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<CapturedStub[]> {
  const rows = await tx.execute<Record<string, string | number | null>>(
    sql`
    select s.employee_party_id, s.province, s.gross, s.net_pay, s.employer_cost, s.factors,
           l.component_id, c.system_key, l.kind, l.description, l.hours, l.derived_quantity, l.derived_rule_code, l.rate, l.amount, l.payment_kind, l.non_cash_account_id,
           l.earned_from::text as earned_from, l.earned_to::text as earned_to,
           l.project_id, l.department_id, l.time_type_id, l.item_id,
           l.expense_account_id, l.expense_account_source, l.expense_account_evidence, l.sequence
      from pay_stubs s
      left join pay_stub_lines l on l.stub_id = s.id and l.org_id = s.org_id
      left join pay_components c on c.id = l.component_id and c.org_id = s.org_id
      left join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
     where s.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
       ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
     order by s.employee_party_id, l.sequence, l.description
  `,
    "objects",
  );
  const byEmployee = new Map<string, CapturedStub>();
  for (const row of rows) {
    const employeePartyId = String(row.employee_party_id);
    let stub = byEmployee.get(employeePartyId);
    if (!stub) {
      stub = {
        employeePartyId,
        province: String(row.province ?? ""),
        gross: String(row.gross ?? "0"),
        netPay: String(row.net_pay ?? "0"),
        employerCost: String(row.employer_cost ?? "0"),
        factors: row.factors as unknown as Record<string, string>,
        lines: [],
      };
      byEmployee.set(employeePartyId, stub);
    }
    // A stub with no lines at all still exists as a stub; the outer join keeps
    // it, and an absent line must not be invented as a zero one.
    if (row.kind == null) continue;
    stub.lines.push({
      componentId: row.component_id == null ? null : String(row.component_id),
      systemKey: row.system_key == null ? null : String(row.system_key),
      kind: String(row.kind) as CapturedStubLine["kind"],
      description: String(row.description ?? ""),
      hours: row.hours == null ? null : String(row.hours),
      derivedQuantity: row.derived_quantity == null ? null : String(row.derived_quantity),
      derivedRuleCode: row.derived_rule_code == null ? null : String(row.derived_rule_code),
      rate: row.rate == null ? null : String(row.rate),
      amount: String(row.amount ?? "0"),
      earnedFrom: row.earned_from == null ? null : String(row.earned_from),
      earnedTo: row.earned_to == null ? null : String(row.earned_to),
      paymentKind: row.payment_kind === "non_cash" ? "non_cash" : "cash",
      nonCashAccountId: row.non_cash_account_id == null ? null : String(row.non_cash_account_id),
      projectId: row.project_id == null ? null : String(row.project_id),
      departmentId: row.department_id == null ? null : String(row.department_id),
      timeTypeId: row.time_type_id == null ? null : String(row.time_type_id),
      itemId: row.item_id == null ? null : String(row.item_id),
      expenseAccountId: row.expense_account_id == null ? null : String(row.expense_account_id),
      expenseAccountSource: String(row.expense_account_source ?? "unknown"),
      expenseAccountEvidence:
        row.expense_account_evidence == null
          ? null
          : (row.expense_account_evidence as unknown as { reason: string; reference: string }),
      sequence: Number(row.sequence ?? 0),
    });
  }
  return [...byEmployee.values()];
}
