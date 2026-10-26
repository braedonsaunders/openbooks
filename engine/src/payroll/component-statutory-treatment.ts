import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { PayrollError } from "./error.ts";

export type ResolvedComponentStatutoryTreatment = {
  id: string;
  pay_component_id: string;
  worker_comp_group_id: string | null;
  effective_from: string;
  effective_to: string | null;
  program_exclusions: string[];
  vacationable: boolean;
};

export function selectComponentStatutoryTreatments(
  rows: readonly ResolvedComponentStatutoryTreatment[],
  workerCompGroupId: string | null,
  payDate: string,
): Map<string, ResolvedComponentStatutoryTreatment> {
  const resolved = new Map<string, ResolvedComponentStatutoryTreatment>();
  for (const row of rows) {
    if (row.effective_from > payDate || (row.effective_to !== null && row.effective_to < payDate))
      continue;
    if (row.worker_comp_group_id !== null && row.worker_comp_group_id !== workerCompGroupId)
      continue;
    const existing = resolved.get(row.pay_component_id);
    if (!existing) {
      resolved.set(row.pay_component_id, row);
      continue;
    }
    if (existing.worker_comp_group_id === row.worker_comp_group_id) {
      throw new PayrollError(
        "More than one statutory treatment covers a pay component at the same scope on this pay date; resolve the overlapping Payroll Setup history before calculating.",
      );
    }
    if (row.worker_comp_group_id !== null) resolved.set(row.pay_component_id, row);
  }
  return resolved;
}

/** Resolve assessability and vacation-base inclusion at payroll pay date. */
export async function resolveComponentStatutoryTreatments(
  tx: SqlExecutor,
  orgId: string,
  payDate: string,
  componentIds: readonly string[],
  workerCompGroupId: string | null = null,
): Promise<Map<string, ResolvedComponentStatutoryTreatment>> {
  const ids = [...new Set(componentIds)].sort();
  if (!ids.length) return new Map();
  const componentList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const lockedComponents = await tx.execute(
    sql`
    select component.id
      from pay_components component
     where component.org_id = ${orgId}
       and component.id in (${componentList})
     order by component.id
     for share of component
  `,
    "objects",
  );
  if (lockedComponents.length !== ids.length) {
    throw new PayrollError(
      "An earning component changed while its statutory treatment was being resolved; recalculate the editable pay run.",
    );
  }
  const rows = await tx.execute<ResolvedComponentStatutoryTreatment>(
    sql`
    select treatment.id::text,
           treatment.pay_component_id::text,
           treatment.worker_comp_group_id::text,
           treatment.effective_from::text,
           treatment.effective_to::text,
           treatment.program_exclusions,
           treatment.vacationable
      from pay_component_statutory_treatments treatment
     where treatment.org_id = ${orgId}
       and treatment.pay_component_id in (${sql.join(
         ids.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
       and (treatment.worker_comp_group_id is null
         or treatment.worker_comp_group_id is not distinct from ${workerCompGroupId}::uuid)
       and treatment.effective_from <= ${payDate}::date
       and (treatment.effective_to is null or treatment.effective_to >= ${payDate}::date)
     order by treatment.pay_component_id,
       (treatment.worker_comp_group_id is not null) desc,
       treatment.effective_from desc, treatment.id
     for share of treatment
  `,
    "objects",
  );
  return selectComponentStatutoryTreatments(rows, workerCompGroupId, payDate);
}

export function requireComponentStatutoryTreatment(
  componentId: string,
  treatments: ReadonlyMap<string, ResolvedComponentStatutoryTreatment>,
  payDate: string,
): ResolvedComponentStatutoryTreatment {
  const treatment = treatments.get(componentId);
  if (!treatment) {
    throw new PayrollError(
      `No effective statutory treatment covers component ${componentId} on ${payDate}; add a dated treatment in Payroll Setup before calculating.`,
    );
  }
  if (typeof treatment.vacationable !== "boolean") {
    throw new PayrollError(
      `The dated treatment for component ${componentId} on ${payDate} has no explicit vacation-base inclusion; correct its Payroll Setup statutory treatment before calculating.`,
    );
  }
  return treatment;
}

/** Vacation bases require a resolved dated treatment; absent policy never implies inclusion. */
export function vacationBaseIncluded(earning: {
  componentId: string | null;
  vacationable?: boolean;
}): boolean {
  if (earning.componentId === null || typeof earning.vacationable !== "boolean") {
    throw new PayrollError(
      "Vacation-base inclusion has no resolved dated component treatment; configure Payroll Setup statutory treatments and recalculate the editable run.",
    );
  }
  return earning.vacationable;
}
