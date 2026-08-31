import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { fromUnits, normalizeDecimal, toUnits } from "../money.ts";
import type {
  MigrationSource,
} from "./source.ts";

export interface ProjectFinancialInputSyncResult {
  sourceTimeEntries: number;
  targetTimeEntries: number;
  exactTimeEntries: number;
  changedTimeEntries: number;
  missingTargetTimeEntries: number;
  targetOnlyTimeEntries: number;
  sourceProjects: number;
  targetProjects: number;
  exactProjects: number;
  changedProjects: number;
  missingTargetProjects: number;
  targetOnlyProjects: number;
  applied: boolean;
}
type TargetBillingState = {
  id: string;
  source_ref: string;
  billing_status: "unbilled" | "billed";
  costing_basis: "actual" | "estimated";
  source_status: string | null;
  invoiced_by_line_id: string | null;
  cost_journal_entry_id: string | null;
  overhead_journal_entry_id: string | null;
  payroll_batch_ref: string | null;
  employee_party_id: string;
  project_id: string | null;
  item_id: string | null;
  department_id: string | null;
  time_type_id: string | null;
  employee_ref: string | null;
  project_ref: string | null;
  item_ref: string | null;
  department_ref: string | null;
  time_type_ref: string | null;
  worked_on: string;
  hours: string;
  cost_rate: string | null;
  bill_rate: string | null;
  is_billable: boolean;
  field_ticket_id: string | null;
  field_ticket_project_ref: string | null;
};
type TargetProjectState = {
  id: string;
  source_ref: string;
  project_type_id: string | null;
  project_type_key: string | null;
  contract_value: string | null;
};

function duplicates(
  refs: string[],
): string[] {
  const seen = new Set<string>();
  const found = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref)) found.add(ref);
    seen.add(ref);
  }
  return [...found].sort();
}

function decimal(value: string | null | undefined): string | null {
  return value == null || value === "" ? null : normalizeDecimal(value, 8);
}

/**
 * Reconcile source commercial billing state without touching documents, GL,
 * files, or PDFs. The complete population is compared before any write; a
 * missing or ambiguous source identity fails closed.
 */
export async function syncProjectFinancialInputs(
  source: MigrationSource,
  options: {
    orgId: string;
    connectionId: string;
    runId: string;
    actorId?: string | null;
    apply: boolean;
  },
): Promise<ProjectFinancialInputSyncResult> {
  if (!source.projectFinancialInputs) {
    throw new Error(
      `${source.name} does not expose project-financial input synchronization`,
    );
  }
  const snapshot = await source.projectFinancialInputs();
  const sourceStates = snapshot.timeEntryBillingStates;
  const duplicateSourceRefs = duplicates(
    sourceStates.map((state) => state.sourceRef),
  );
  if (duplicateSourceRefs.length) {
    throw new Error(
      `source returned duplicate time-entry billing identities: ${duplicateSourceRefs
        .slice(0, 20)
        .join(", ")}`,
    );
  }

  const targetResult = (await db.execute<TargetBillingState>(sql`
    select time.id, time.custom ->> ${source.refKey} as source_ref,
           time.billing_status, time.costing_basis,
           time.custom ->> 'sourceBillingStatus' as source_status,
           time.invoiced_by_line_id,
           time.cost_journal_entry_id,
           time.overhead_journal_entry_id,
           time.payroll_batch_ref,
           time.employee_party_id, time.project_id, time.item_id,
           time.department_id, time.time_type_id,
           employee.custom ->> ${source.refKey} as employee_ref,
           project.custom ->> ${source.refKey} as project_ref,
           item.custom ->> ${source.refKey} as item_ref,
           department.custom ->> ${source.refKey} as department_ref,
           time_type.custom ->> ${source.refKey} as time_type_ref,
           time.worked_on::text, time.hours::text,
           time.cost_rate::text, time.bill_rate::text, time.is_billable,
           time.field_ticket_id,
           ticket_project.custom ->> ${source.refKey} as field_ticket_project_ref
      from time_entries time
      join parties employee
        on employee.id = time.employee_party_id and employee.org_id = time.org_id
      left join projects project
        on project.id = time.project_id and project.org_id = time.org_id
      left join items item
        on item.id = time.item_id and item.org_id = time.org_id
      left join departments department
        on department.id = time.department_id and department.org_id = time.org_id
      left join time_types time_type
        on time_type.id = time.time_type_id and time_type.org_id = time.org_id
      left join documents ticket
        on ticket.id = time.field_ticket_id and ticket.org_id = time.org_id
      left join projects ticket_project
        on ticket_project.id = ticket.project_id
       and ticket_project.org_id = ticket.org_id
     where time.org_id = ${options.orgId}
       and time.custom ->> ${source.refKey} is not null
  `));

  const referenceRows = (await db.execute<{ kind: string; id: string; source_ref: string | null }>(sql`
    select 'employee' as kind, id, custom ->> ${source.refKey} as source_ref
      from parties where org_id = ${options.orgId}
    union all
    select 'project', id, custom ->> ${source.refKey}
      from projects where org_id = ${options.orgId}
    union all
    select 'item', id, custom ->> ${source.refKey}
      from items where org_id = ${options.orgId}
    union all
    select 'department', id, custom ->> ${source.refKey}
      from departments where org_id = ${options.orgId}
    union all
    select 'time_type', id, custom ->> ${source.refKey}
      from time_types where org_id = ${options.orgId}
  `));
  const idsByKind = new Map<string, Map<string, string>>();
  for (const row of referenceRows.rows) {
    if (!row.source_ref) continue;
    const refs = idsByKind.get(row.kind) ?? new Map<string, string>();
    if (refs.has(row.source_ref)) {
      throw new Error(
        `OpenBooks contains duplicate ${source.name} ${row.kind} identity ${row.source_ref}`,
      );
    }
    refs.set(row.source_ref, row.id);
    idsByKind.set(row.kind, refs);
  }
  const resolveRef = (
    kind: string,
    sourceRef: string | null | undefined,
    timeEntryRef: string,
    required = false,
  ): string | null => {
    if (!sourceRef) {
      if (required) {
        throw new Error(
          `source time entry ${timeEntryRef} has no ${kind} identity`,
        );
      }
      return null;
    }
    const id = idsByKind.get(kind)?.get(sourceRef) ?? null;
    if (!id) {
      throw new Error(
        `source time entry ${timeEntryRef} requires missing ${kind} ${sourceRef}`,
      );
    }
    return id;
  };

  const targetByRef = new Map<string, TargetBillingState>();
  const duplicateTargetRefs: string[] = [];
  for (const row of targetResult.rows) {
    if (targetByRef.has(row.source_ref)) duplicateTargetRefs.push(row.source_ref);
    else targetByRef.set(row.source_ref, row);
  }
  if (duplicateTargetRefs.length) {
    throw new Error(
      `OpenBooks contains duplicate ${source.name} time-entry identities: ${[
        ...new Set(duplicateTargetRefs),
      ]
        .slice(0, 20)
        .join(", ")}`,
    );
  }

  const duplicateSourceProjectRefs = duplicates(
    snapshot.projects.map((project) => project.sourceRef),
  );
  if (duplicateSourceProjectRefs.length) {
    throw new Error(
      `source returned duplicate project identities: ${duplicateSourceProjectRefs
        .slice(0, 20)
        .join(", ")}`,
    );
  }
  const targetProjectsResult = (await db.execute<TargetProjectState>(sql`
    select p.id, p.custom ->> ${source.refKey} as source_ref,
           p.project_type_id, pt.key as project_type_key, p.contract_value
      from projects p
      left join project_types pt
        on pt.id = p.project_type_id and pt.org_id = p.org_id
     where p.org_id = ${options.orgId}
       and p.custom ->> ${source.refKey} is not null
  `));
  const targetProjectByRef = new Map<string, TargetProjectState>();
  const duplicateTargetProjectRefs: string[] = [];
  for (const row of targetProjectsResult.rows) {
    if (targetProjectByRef.has(row.source_ref)) {
      duplicateTargetProjectRefs.push(row.source_ref);
    } else {
      targetProjectByRef.set(row.source_ref, row);
    }
  }
  if (duplicateTargetProjectRefs.length) {
    throw new Error(
      `OpenBooks contains duplicate ${source.name} project identities: ${[
        ...new Set(duplicateTargetProjectRefs),
      ]
        .slice(0, 20)
        .join(", ")}`,
    );
  }
  const projectTypeResult = (await db.execute<{ id: string; key: string }>(sql`
    select id, key from project_types
     where org_id = ${options.orgId} and is_active
  `));
  const projectTypeIdByKey = new Map(
    projectTypeResult.rows.map((row) => [row.key, row.id]),
  );
  const sourceProjectRefs = new Set(
    snapshot.projects.map((project) => project.sourceRef),
  );
  const missingTargetProjects = snapshot.projects.filter(
    (project) => !targetProjectByRef.has(project.sourceRef),
  );
  const targetOnlyProjects = targetProjectsResult.rows.filter(
    (project) => !sourceProjectRefs.has(project.source_ref),
  );
  const changedProjects = snapshot.projects.flatMap((project) => {
    const target = targetProjectByRef.get(project.sourceRef);
    if (!target) return [];
    const targetContract = fromUnits(
      toUnits(target.contract_value ?? "0"),
    );
    const sourceContract =
      project.contractValue === null
        ? null
        : fromUnits(toUnits(project.contractValue));
    const typeChanged =
      project.billingMethod !== null &&
      target.project_type_key !== project.billingMethod;
    const contractChanged =
      sourceContract !== null && targetContract !== sourceContract;
    if (!typeChanged && !contractChanged) return [];
    const projectTypeId =
      project.billingMethod === null
        ? null
        : projectTypeIdByKey.get(project.billingMethod);
    if (project.billingMethod && !projectTypeId) {
      throw new Error(
        `source project ${project.sourceRef} requires missing project type ${project.billingMethod}`,
      );
    }
    return [
      {
        id: target.id,
        sourceRef: project.sourceRef,
        beforeProjectTypeId: target.project_type_id,
        beforeProjectType: target.project_type_key,
        afterProjectType:
          project.billingMethod ?? target.project_type_key,
        afterProjectTypeId: projectTypeId ?? null,
        beforeContractValue: targetContract,
        beforeContractValueRaw: target.contract_value,
        afterContractValue: sourceContract ?? targetContract,
      },
    ];
  });

  const sourceRefs = new Set(sourceStates.map((state) => state.sourceRef));
  const missingTarget = sourceStates.filter(
    (state) => !targetByRef.has(state.sourceRef),
  );
  const targetOnly = targetResult.rows.filter(
    (row) => !sourceRefs.has(row.source_ref),
  );
  const changed = sourceStates.flatMap((state) => {
    const target = targetByRef.get(state.sourceRef);
    if (!target) return [];
    const sourceStatus = state.sourceStatus ?? null;
    const billingChanged = target.billing_status !== state.billingStatus;
    const costingChanged = target.costing_basis !== state.costingBasis;
    const afterEmployeeId =
      state.employeeRef === undefined
        ? target.employee_party_id
        : resolveRef(
            "employee",
            state.employeeRef,
            state.sourceRef,
            true,
          );
    const afterProjectId =
      state.projectRef === undefined
        ? target.project_id
        : resolveRef("project", state.projectRef, state.sourceRef);
    const afterItemId =
      state.itemRef === undefined
        ? target.item_id
        : resolveRef("item", state.itemRef, state.sourceRef);
    const afterDepartmentId =
      state.departmentRef === undefined
        ? target.department_id
        : resolveRef("department", state.departmentRef, state.sourceRef);
    const afterTimeTypeId =
      state.timeTypeRef === undefined
        ? target.time_type_id
        : resolveRef("time_type", state.timeTypeRef, state.sourceRef);
    const factsChanged =
      (state.employeeRef !== undefined &&
        target.employee_ref !== (state.employeeRef ?? null)) ||
      (state.projectRef !== undefined &&
        target.project_ref !== (state.projectRef ?? null)) ||
      (state.itemRef !== undefined &&
        target.item_ref !== (state.itemRef ?? null)) ||
      (state.departmentRef !== undefined &&
        target.department_ref !== (state.departmentRef ?? null)) ||
      (state.timeTypeRef !== undefined &&
        target.time_type_ref !== (state.timeTypeRef ?? null)) ||
      (state.workedOn !== undefined &&
        target.worked_on !== (state.workedOn ?? null)) ||
      (state.hours !== undefined &&
        decimal(target.hours) !== decimal(state.hours)) ||
      (state.costRate !== undefined &&
        decimal(target.cost_rate) !== decimal(state.costRate)) ||
      (state.billRate !== undefined &&
        decimal(target.bill_rate) !== decimal(state.billRate)) ||
      (state.isBillable !== undefined &&
        state.isBillable !== null &&
        target.is_billable !== state.isBillable);
    if (!billingChanged && !costingChanged && !factsChanged) return [];
    if (
      billingChanged &&
      target.invoiced_by_line_id &&
      state.billingStatus === "unbilled"
    ) {
      throw new Error(
        `source time entry ${state.sourceRef} is unbilled but OpenBooks carries invoice-line provenance`,
      );
    }
    const immutableEvidence = [
      target.invoiced_by_line_id ? "invoice-line" : null,
      target.cost_journal_entry_id ? "cost journal" : null,
      target.overhead_journal_entry_id ? "overhead journal" : null,
      target.payroll_batch_ref ? "payroll batch" : null,
    ].filter((value): value is string => value !== null);
    const immutableFactChange = costingChanged || factsChanged;
    if (immutableFactChange && immutableEvidence.length > 0) {
      throw new Error(
        `source time entry ${state.sourceRef} changes ${immutableEvidence.join(
          ", ",
        )} evidence; corrections must be new offsetting entries`,
      );
    }
    if (
      target.field_ticket_id &&
      state.projectRef !== undefined &&
      target.field_ticket_project_ref !== (state.projectRef ?? null)
    ) {
      throw new Error(
        `source time entry ${state.sourceRef} cannot move away from Field Ticket ${target.field_ticket_id}'s project`,
      );
    }
    return [
      {
        id: target.id,
        sourceRef: state.sourceRef,
        beforeBillingStatus: target.billing_status,
        billingStatus: state.billingStatus,
        beforeCostingBasis: target.costing_basis,
        costingBasis: state.costingBasis,
        immutableFactChange,
        beforeSourceStatus: target.source_status,
        sourceStatus,
        beforeInvoicedByLineId: target.invoiced_by_line_id,
        beforeEmployeeRef: target.employee_ref,
        beforeEmployeeId: target.employee_party_id,
        employeeId: afterEmployeeId,
        employeeRef:
          state.employeeRef === undefined
            ? target.employee_ref
            : state.employeeRef,
        beforeProjectRef: target.project_ref,
        beforeProjectId: target.project_id,
        projectId: afterProjectId,
        projectRef:
          state.projectRef === undefined ? target.project_ref : state.projectRef,
        beforeItemRef: target.item_ref,
        beforeItemId: target.item_id,
        itemId: afterItemId,
        itemRef: state.itemRef === undefined ? target.item_ref : state.itemRef,
        beforeDepartmentRef: target.department_ref,
        beforeDepartmentId: target.department_id,
        departmentId: afterDepartmentId,
        departmentRef:
          state.departmentRef === undefined
            ? target.department_ref
            : state.departmentRef,
        beforeTimeTypeRef: target.time_type_ref,
        beforeTimeTypeId: target.time_type_id,
        timeTypeId: afterTimeTypeId,
        timeTypeRef:
          state.timeTypeRef === undefined
            ? target.time_type_ref
            : state.timeTypeRef,
        beforeWorkedOn: target.worked_on,
        workedOn: state.workedOn ?? target.worked_on,
        beforeHours: decimal(target.hours),
        hours: decimal(state.hours) ?? decimal(target.hours),
        beforeCostRate: decimal(target.cost_rate),
        costRate:
          state.costRate === undefined
            ? decimal(target.cost_rate)
            : decimal(state.costRate),
        beforeBillRate: decimal(target.bill_rate),
        billRate:
          state.billRate === undefined
            ? decimal(target.bill_rate)
            : decimal(state.billRate),
        beforeIsBillable: target.is_billable,
        isBillable:
          state.isBillable == null ? target.is_billable : state.isBillable,
      },
    ];
  });

  const result: ProjectFinancialInputSyncResult = {
    sourceTimeEntries: sourceStates.length,
    targetTimeEntries: targetResult.rows.length,
    exactTimeEntries:
      sourceStates.length - missingTarget.length - changed.length,
    changedTimeEntries: changed.length,
    missingTargetTimeEntries: missingTarget.length,
    targetOnlyTimeEntries: targetOnly.length,
    sourceProjects: snapshot.projects.length,
    targetProjects: targetProjectsResult.rows.length,
    exactProjects:
      snapshot.projects.length -
      missingTargetProjects.length -
      changedProjects.length,
    changedProjects: changedProjects.length,
    missingTargetProjects: missingTargetProjects.length,
    targetOnlyProjects: targetOnlyProjects.length,
    applied: false,
  };
  if (missingTarget.length) {
    throw new Error(
      `project-financial input sync is incomplete: ${missingTarget.length} source time entries are absent from OpenBooks (first: ${missingTarget
        .slice(0, 20)
        .map((state) => state.sourceRef)
        .join(", ")})`,
    );
  }
  if (missingTargetProjects.length) {
    throw new Error(
      `project-financial input sync is incomplete: ${missingTargetProjects.length} source projects are absent from OpenBooks (first: ${missingTargetProjects
        .slice(0, 20)
        .map((project) => project.sourceRef)
        .join(", ")})`,
    );
  }
  if (
    !options.apply ||
    (changed.length === 0 && changedProjects.length === 0)
  ) {
    return result;
  }

  const actorId =
    options.actorId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      options.actorId,
    )
      ? options.actorId
      : null;
  const BATCH = 1_000;
  await db.transaction(async (tx) => {
    for (let offset = 0; offset < changed.length; offset += BATCH) {
      const batch = changed.slice(offset, offset + BATCH);
      const write = await tx.execute(sql`
        with input as (
          select *
            from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
                 as x(
                   id uuid,
                   "sourceRef" text,
                   "beforeBillingStatus" text,
                   "billingStatus" text,
                   "beforeCostingBasis" text,
                   "costingBasis" text,
                   "immutableFactChange" boolean,
                   "beforeSourceStatus" text,
                   "sourceStatus" text,
                   "beforeInvoicedByLineId" uuid,
                   "beforeEmployeeRef" text,
                   "beforeEmployeeId" uuid,
                   "employeeId" uuid,
                   "employeeRef" text,
                   "beforeProjectRef" text,
                   "beforeProjectId" uuid,
                   "projectId" uuid,
                   "projectRef" text,
                   "beforeItemRef" text,
                   "beforeItemId" uuid,
                   "itemId" uuid,
                   "itemRef" text,
                   "beforeDepartmentRef" text,
                   "beforeDepartmentId" uuid,
                   "departmentId" uuid,
                   "departmentRef" text,
                   "beforeTimeTypeRef" text,
                   "beforeTimeTypeId" uuid,
                   "timeTypeId" uuid,
                   "timeTypeRef" text,
                   "beforeWorkedOn" date,
                   "workedOn" date,
                   "beforeHours" numeric,
                   hours numeric,
                   "beforeCostRate" numeric,
                   "costRate" numeric,
                   "beforeBillRate" numeric,
                   "billRate" numeric,
                   "beforeIsBillable" boolean,
                   "isBillable" boolean
                 )
        ),
        updated as (
          update time_entries te
             set employee_party_id = input."employeeId",
                 project_id = input."projectId",
                 item_id = input."itemId",
                 department_id = input."departmentId",
                 time_type_id = input."timeTypeId",
                 worked_on = input."workedOn",
                 hours = input.hours,
                 cost_rate = input."costRate",
                 bill_rate = input."billRate",
                 is_billable = input."isBillable",
                 billing_status = input."billingStatus",
                 costing_basis = input."costingBasis",
                 custom = jsonb_set(
                   coalesce(te.custom, '{}'::jsonb),
                   '{sourceBillingStatus}',
                   coalesce(to_jsonb(input."sourceStatus"), 'null'::jsonb),
                   true
                 ),
                 updated_at = now(),
                 updated_by = ${actorId}
            from input
           where te.id = input.id
             and te.org_id = ${options.orgId}
             and te.custom ->> ${source.refKey} = input."sourceRef"
             and (
               not input."immutableFactChange"
               or (
                 te.invoiced_by_line_id is null
                 and te.cost_journal_entry_id is null
                 and te.overhead_journal_entry_id is null
                 and te.payroll_batch_ref is null
               )
             )
             and te.invoiced_by_line_id is not distinct from input."beforeInvoicedByLineId"
             and te.employee_party_id is not distinct from input."beforeEmployeeId"
             and te.project_id is not distinct from input."beforeProjectId"
             and te.item_id is not distinct from input."beforeItemId"
             and te.department_id is not distinct from input."beforeDepartmentId"
             and te.time_type_id is not distinct from input."beforeTimeTypeId"
             and te.billing_status is not distinct from input."beforeBillingStatus"
             and te.costing_basis is not distinct from input."beforeCostingBasis"
             and te.custom ->> 'sourceBillingStatus' is not distinct from input."beforeSourceStatus"
             and te.worked_on is not distinct from input."beforeWorkedOn"
             and te.hours is not distinct from input."beforeHours"
             and te.cost_rate is not distinct from input."beforeCostRate"
             and te.bill_rate is not distinct from input."beforeBillRate"
             and te.is_billable is not distinct from input."beforeIsBillable"
           returning te.id
        )
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        select ${options.orgId}, 'time_entries', input.id, 'update',
               jsonb_build_object(
                 'before', jsonb_build_object(
                   'billingStatus', input."beforeBillingStatus",
                   'costingBasis', input."beforeCostingBasis",
                   'sourceBillingStatus', input."beforeSourceStatus",
                   'employeeRef', input."beforeEmployeeRef",
                   'projectRef', input."beforeProjectRef",
                   'itemRef', input."beforeItemRef",
                   'departmentRef', input."beforeDepartmentRef",
                   'timeTypeRef', input."beforeTimeTypeRef",
                   'workedOn', input."beforeWorkedOn",
                   'hours', input."beforeHours",
                   'costRate', input."beforeCostRate",
                   'billRate', input."beforeBillRate",
                   'isBillable', input."beforeIsBillable"
                 ),
                 'after', jsonb_build_object(
                   'billingStatus', input."billingStatus",
                   'costingBasis', input."costingBasis",
                   'sourceBillingStatus', input."sourceStatus",
                   'employeeRef', input."employeeRef",
                   'projectRef', input."projectRef",
                   'itemRef', input."itemRef",
                   'departmentRef', input."departmentRef",
                   'timeTypeRef', input."timeTypeRef",
                   'workedOn', input."workedOn",
                   'hours', input.hours,
                   'costRate', input."costRate",
                   'billRate', input."billRate",
                   'isBillable', input."isBillable"
                 ),
                 'source', jsonb_build_object(
                   'system', cast(${source.name} as text),
                   'ref', input."sourceRef",
                   'connectionId', cast(${options.connectionId} as text),
                   'syncRunId', cast(${options.runId} as text)
                 )
               ),
               ${actorId}, ${options.runId}
          from input
          join updated on updated.id = input.id
          returning row_id
      `);
      if (write.rows.length !== batch.length) {
        throw new Error(
          `project-financial input sync detected concurrent time-entry edits; retry (expected ${batch.length} updates, applied ${write.rows.length})`,
        );
      }
    }
    for (
      let offset = 0;
      offset < changedProjects.length;
      offset += BATCH
    ) {
      const batch = changedProjects.slice(offset, offset + BATCH);
      const updated = await tx.execute(sql`
        with input as (
          select *
            from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
                 as x(
                   id uuid,
                   "sourceRef" text,
                   "beforeProjectTypeId" uuid,
                   "beforeProjectType" text,
                   "afterProjectType" text,
                   "afterProjectTypeId" uuid,
                   "beforeContractValue" numeric,
                   "beforeContractValueRaw" numeric,
                   "afterContractValue" numeric
                 )
        ),
        updated as (
          update projects p
             set project_type_id = coalesce(input."afterProjectTypeId", p.project_type_id),
                 contract_value = input."afterContractValue",
                 updated_at = now(),
                 updated_by = ${actorId}
            from input
           where p.id = input.id
             and p.org_id = ${options.orgId}
             and p.custom ->> ${source.refKey} = input."sourceRef"
             and p.project_type_id is not distinct from input."beforeProjectTypeId"
             and p.contract_value is not distinct from input."beforeContractValueRaw"
           returning p.id
        )
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        select ${options.orgId}, 'projects', input.id, 'update',
               jsonb_build_object(
                 'before', jsonb_build_object(
                   'projectType', input."beforeProjectType",
                   'contractValue', input."beforeContractValue"
                 ),
                 'after', jsonb_build_object(
                   'projectType', input."afterProjectType",
                   'contractValue', input."afterContractValue"
                 ),
                 'source', jsonb_build_object(
                   'system', cast(${source.name} as text),
                   'ref', input."sourceRef",
                   'connectionId', cast(${options.connectionId} as text),
                   'syncRunId', cast(${options.runId} as text)
                 )
               ),
               ${actorId}, ${options.runId}
          from input
          join updated on updated.id = input.id
      `);
      if ((updated.rowCount ?? 0) !== batch.length) {
        throw new Error(
          `project-financial input sync detected concurrent project edits; retry (expected ${batch.length} updates, applied ${updated.rowCount ?? 0})`,
        );
      }
    }
  });
  return { ...result, applied: true };
}
