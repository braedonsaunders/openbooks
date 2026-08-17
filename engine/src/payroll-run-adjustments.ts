import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { PayrollError } from "./payroll-error.ts";

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

/**
 * Mutate the inputs of one pay run under the same row lock used by calculate
 * and commit. Every successful change invalidates the calculated snapshot so
 * a caller cannot commit stubs that no longer represent the inputs.
 */
export async function mutatePayRunAdjustment(input: {
  orgId: string;
  documentId: string;
  actorId: string;
  mutation: PayRunAdjustmentMutation;
}): Promise<{ changed: boolean }> {
  const { orgId, documentId, actorId, mutation } = input;
  return db.transaction(async (tx) => {
    const runRows = (await tx.execute(sql`
      select r.run_status, r.pay_schedule_id, d.status as document_status
        from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
       where r.org_id = ${orgId} and r.document_id = ${documentId}
       for update of r, d
    `)) as unknown as {
      rows: { run_status: string; pay_schedule_id: string; document_status: string }[];
    };
    const run = runRows.rows[0];
    if (!run) throw new PayrollError("pay run not found");
    if (run.run_status === "committed" || run.document_status !== "draft") {
      throw new PayrollError("pay run is not editable");
    }

    const employeeId = mutation.action === "delete" ? null : mutation.employeePartyId;
    if (employeeId) {
      const membership = (await tx.execute(sql`
        select 1
          from employee_payroll_profiles prof
          join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
         where prof.org_id = ${orgId}
           and prof.employee_party_id = ${employeeId}
           and prof.pay_schedule_id = ${run.pay_schedule_id}
           and prof.is_active and p.is_active
         limit 1
      `)) as unknown as { rows: unknown[] };
      if (membership.rows.length === 0) {
        throw new PayrollError("employee is not an active member of this pay run's schedule");
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
      `)) as unknown as { rows: unknown[] };
      if (component.rows.length === 0) throw new PayrollError("component cannot be adjusted");
      await tx.execute(sql`
        insert into pay_run_adjustments
          (org_id, pay_run_document_id, employee_party_id, adjustment_type,
           component_id, amount, hours, replace_component, note, created_by, updated_by)
        values
          (${orgId}, ${documentId}, ${mutation.employeePartyId}, 'line',
           ${mutation.componentId}, ${mutation.amount}, ${mutation.hours ?? null},
           ${mutation.replaceComponent === true}, ${mutation.note ?? null}, ${actorId}, ${actorId})
      `);
      changed = true;
    } else if (mutation.action === "delete") {
      const deleted = (await tx.execute(sql`
        delete from pay_run_adjustments
         where org_id = ${orgId} and pay_run_document_id = ${documentId}
           and id = ${mutation.adjustmentId}
         returning id
      `)) as unknown as { rows: { id: string }[] };
      if (deleted.rows.length === 0) throw new PayrollError("pay run adjustment not found");
      changed = true;
    } else if (mutation.action === "exclude") {
      const inserted = (await tx.execute(sql`
        insert into pay_run_adjustments
          (org_id, pay_run_document_id, employee_party_id, adjustment_type, created_by, updated_by)
        values (${orgId}, ${documentId}, ${mutation.employeePartyId}, 'exclude', ${actorId}, ${actorId})
        on conflict (pay_run_document_id, employee_party_id)
          where adjustment_type = 'exclude'
        do nothing
        returning id
      `)) as unknown as { rows: { id: string }[] };
      changed = inserted.rows.length > 0;
    } else {
      const deleted = (await tx.execute(sql`
        delete from pay_run_adjustments
         where org_id = ${orgId} and pay_run_document_id = ${documentId}
           and employee_party_id = ${mutation.employeePartyId} and adjustment_type = 'exclude'
         returning id
      `)) as unknown as { rows: { id: string }[] };
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
