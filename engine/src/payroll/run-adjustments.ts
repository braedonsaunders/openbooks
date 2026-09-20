import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { normalizeMoney } from "../money/money.ts";
import { PayrollError } from "./error.ts";
import { lockAndCheckPayrollRunPopulation, payrollSubsidiaryInScope, type PayrollSubsidiaryScope } from "./scope.ts";

/**
 * Adjustment money must be an exact 4dp amount the numeric(19,4) column can
 * hold: anything wider died at storage with a driver error.
 */
function persistAdjustmentMoney(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) {
    throw new PayrollError("adjustment amount must be an exact decimal of at most 4 decimal places");
  }
  let amount: string;
  try {
    amount = normalizeMoney(exact);
  } catch {
    throw new PayrollError("adjustment amount must be an exact decimal of at most 4 decimal places");
  }
  if (amount.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 15) {
    throw new PayrollError("adjustment amount is out of range — at most 15 whole digits fit the ledger");
  }
  return amount;
}

/**
 * Adjustment hours persist into numeric(12,2): at most 2dp and ten whole
 * digits. Anything past 2dp was silently rounded by the column; anything
 * wider died at storage. Negative hours are refused — a correction is a
 * separate adjustment, not a sign flip smuggled into one cell.
 */
function persistAdjustmentHours(value: unknown): string {
  const exact = canonicalDecimal(value, 2);
  if (exact === null || exact.startsWith("-")) {
    throw new PayrollError("adjustment hours must be a non-negative decimal of at most 2 decimal places");
  }
  if (exact.replace(/^[+]/, "").split(".")[0]!.replace(/^0+/, "").length > 10) {
    throw new PayrollError("adjustment hours are out of range — at most 10 whole digits fit the ledger");
  }
  return exact;
}

/**
 * Canonicalize API-supplied adjustment hours for the numeric(12,2) column:
 * at most 2dp, non-negative, ten whole digits. Returns null for absent input
 * (no hours) and for anything unpersistable. HTTP seams must use this — NOT
 * the 4dp money normalizer, which pads every value past the column scale so
 * the engine gate below rejects even whole hours.
 */
export function canonicalAdjustmentHours(value: unknown): string | null {
  if (value == null || value === "") return null;
  const exact = canonicalDecimal(value, 2);
  if (exact === null || exact.startsWith("-")) return null;
  if (exact.replace(/^[+]/, "").split(".")[0]!.replace(/^0+/, "").length > 10) return null;
  return exact;
}

export type PayRunAdjustmentMutation =
  | {
      action: "add";
      employeePartyId: string;
      componentId: string;
      amount: string;
      hours?: string | null;
      replaceComponent?: boolean;
      note?: string | null;
    }
  | { action: "delete"; adjustmentId: string }
  | { action: "exclude"; employeePartyId: string }
  | { action: "include"; employeePartyId: string };

type ScheduleMember = {
  display_name: string | null;
  party_active: boolean;
  profile_active: boolean | null;
} | undefined;

/**
 * Refusal for a move TOWARD paying someone (include, line adjustment) when
 * they are not an active member of the run's schedule. Names the employee
 * and the exact failed predicate: no such employee, a deactivated employee,
 * no profile on this schedule, or an inactive profile — each with the remedy
 * that fixes it.
 */
function inactiveMemberRefusal(member: ScheduleMember, employeeId: string): string {
  if (!member) {
    return `employee "${employeeId}" is not an active member of this pay run's schedule — no employee with that id; check the id and try again`;
  }
  const name = member.display_name ?? employeeId;
  if (!member.party_active) {
    return `employee "${name}" is not an active member of this pay run's schedule — they are deactivated; reactivate them before adding them to a pay run`;
  }
  if (member.profile_active === null) {
    return `employee "${name}" is not an active member of this pay run's schedule — they have no payroll profile on this run's pay schedule; link them to the schedule before adding them`;
  }
  return `employee "${name}" is not an active member of this pay run's schedule — their payroll profile on this run's pay schedule is inactive; reactivate it before adding them`;
}

/**
 * Refusal for a removal (exclude) of someone who was never on the run's
 * schedule. Names who was passed — the display name when the id belongs to a
 * real employee on another schedule, the raw id when it belongs to nobody —
 * so the operator can tell a mistyped id from a wrong-schedule employee.
 */
function excludeStrangerRefusal(displayName: string | null | undefined, employeeId: string): string {
  if (displayName) {
    return `employee "${displayName}" is not on this run's pay schedule — nothing to remove; they were never linked to this schedule`;
  }
  return `employee "${employeeId}" is not on this run's pay schedule — no employee with that id; check the id and try again`;
}

/**
 * Mutate the inputs of one pay run under the same row lock used by calculate
 * and commit. Every successful change invalidates the calculated snapshot so
 * a caller cannot commit stubs that no longer represent the inputs.
 */
export async function mutatePayRunAdjustment(input: {
  orgId: string;
  documentId: string;
  actorId: string;
  allowedSubsidiaryIds?: PayrollSubsidiaryScope;
  mutation: PayRunAdjustmentMutation;
}): Promise<{ changed: boolean }> {
  const { orgId, documentId, actorId, mutation } = input;
  return db.transaction(async (tx) => {
    const runRows = (await tx.execute<{ run_status: string; pay_schedule_id: string; document_status: string; subsidiary_id: string | null }>(sql`
      select r.run_status, r.pay_schedule_id, d.status as document_status, d.subsidiary_id
        from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
       where r.org_id = ${orgId} and r.document_id = ${documentId}
       for update of r, d
    `));
    const run = runRows.rows[0];
    if (!run || !payrollSubsidiaryInScope(input.allowedSubsidiaryIds, run.subsidiary_id)) {
      throw new PayrollError("pay run not found");
    }
    if (run.run_status === "committed" || run.document_status !== "draft") {
      throw new PayrollError("pay run is not editable");
    }

    const target = mutation.action === "delete"
      ? (await tx.execute<{ employee_party_id: string }>(sql`
          select employee_party_id from pay_run_adjustments
           where org_id=${orgId} and pay_run_document_id=${documentId} and id=${mutation.adjustmentId}
           for update`)).rows[0]?.employee_party_id
      : mutation.employeePartyId;
    if (mutation.action === "delete" && !target) throw new PayrollError("pay run adjustment not found");
    // A changed adjustment invalidates the complete run snapshot.
    await lockAndCheckPayrollRunPopulation(tx, orgId, documentId, input.allowedSubsidiaryIds, [{ id: target! }]);

    const employeeId = mutation.action === "delete" ? null : mutation.employeePartyId;
    if (employeeId) {
      // The party row rides along so a refusal can name the employee and the
      // exact failed predicate — on a roster of up to 2000 an unnamed refusal
      // is unactionable.
      const membership = (await tx.execute<{
        display_name: string | null; party_active: boolean; profile_active: boolean | null;
      }>(sql`
        select p.display_name, p.is_active as party_active, prof.is_active as profile_active
          from parties p
          left join employee_payroll_profiles prof
            on prof.org_id = p.org_id
           and prof.employee_party_id = p.id
           and prof.pay_schedule_id = ${run.pay_schedule_id}
         where p.org_id = ${orgId} and p.id = ${employeeId}
         limit 1
      `));
      const member = membership.rows[0];
      // A validity precondition belongs on the state being moved TOWARD, not
      // the state being moved AWAY FROM. Adding someone (include, or a line
      // adjustment for them) moves toward paying them, so active membership
      // is required. Removing someone (exclude) moves away: the inactive
      // member is exactly who must stay removable — refusing to remove them
      // bars the only exit from the invalid state the check detects
      // (deactivating an employee once bricked scope editing on every run
      // whose roster held them). Exclude still requires a profile on this
      // run's schedule, so a stranger or a mistyped id is refused, not
      // recorded. Do NOT "restore symmetry" by re-adding the active check
      // to exclude.
      if (mutation.action === "exclude") {
        if (!member || member.profile_active === null) {
          throw new PayrollError(excludeStrangerRefusal(member?.display_name, employeeId));
        }
      } else if (!member || !member.party_active || member.profile_active !== true) {
        throw new PayrollError(inactiveMemberRefusal(member, employeeId));
      }
    }

    let changed = false;
    if (mutation.action === "add") {
      const component = (await tx.execute(sql`
        select 1
          from pay_components
         where org_id = ${orgId} and id = ${mutation.componentId} and is_active
           and (system_key is null or system_key in ('base_pay','overtime','bonus','vacation_payout'))
         limit 1
      `));
      if (component.rows.length === 0) throw new PayrollError("component cannot be adjusted");
      // amount is numeric(19,4) and hours numeric(12,2): the values reach the
      // columns verbatim, so an oversized paste died at storage with a driver
      // error and 4dp hours were silently rounded to the column scale. Fail
      // closed here with a named error before any write.
      const amount = persistAdjustmentMoney(mutation.amount);
      const hours = mutation.hours == null || mutation.hours === ""
        ? null
        : persistAdjustmentHours(mutation.hours);
      await tx.execute(sql`
        insert into pay_run_adjustments
          (org_id, pay_run_document_id, employee_party_id, adjustment_type,
           component_id, amount, hours, replace_component, note, created_by, updated_by)
        values
          (${orgId}, ${documentId}, ${mutation.employeePartyId}, 'line',
           ${mutation.componentId}, ${amount}, ${hours},
           ${mutation.replaceComponent === true}, ${mutation.note ?? null}, ${actorId}, ${actorId})
      `);
      changed = true;
    } else if (mutation.action === "delete") {
      const deleted = (await tx.execute<{ id: string }>(sql`
        delete from pay_run_adjustments
         where org_id = ${orgId} and pay_run_document_id = ${documentId}
           and id = ${mutation.adjustmentId}
         returning id
      `));
      if (deleted.rows.length === 0) throw new PayrollError("pay run adjustment not found");
      changed = true;
    } else if (mutation.action === "exclude") {
      const inserted = (await tx.execute<{ id: string }>(sql`
        insert into pay_run_adjustments
          (org_id, pay_run_document_id, employee_party_id, adjustment_type, created_by, updated_by)
        values (${orgId}, ${documentId}, ${mutation.employeePartyId}, 'exclude', ${actorId}, ${actorId})
        on conflict (pay_run_document_id, employee_party_id)
          where adjustment_type = 'exclude'
        do nothing
        returning id
      `));
      changed = inserted.rows.length > 0;
    } else {
      const deleted = (await tx.execute<{ id: string }>(sql`
        delete from pay_run_adjustments
         where org_id = ${orgId} and pay_run_document_id = ${documentId}
           and employee_party_id = ${mutation.employeePartyId} and adjustment_type = 'exclude'
         returning id
      `));
      changed = deleted.rows.length > 0;
    }

    if (changed) {
      // Calculated stubs are a derived snapshot. Remove them and reset the
      // lifecycle in the same transaction as the input change.
      await tx.execute(sql`
        delete from pay_stubs where org_id = ${orgId} and pay_run_document_id = ${documentId}
      `);
      await tx.execute(sql`
        update pay_runs
           set run_status = 'draft', gross_total = 0, net_total = 0,
               employer_cost_total = 0, employee_count = 0, calculated_at = null,
               updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and document_id = ${documentId}
      `);
    }
    return { changed };
  });
}
