import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { fromUnits, toUnits } from "../money.ts";
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

interface TargetBillingState {
  id: string;
  source_ref: string;
  billing_status: "unbilled" | "billed";
  costing_basis: "actual" | "estimated";
  source_status: string | null;
  invoiced_by_line_id: string | null;
}

interface TargetProjectState {
  id: string;
  source_ref: string;
  project_type_key: string | null;
  contract_value: string | null;
}

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

  const targetResult = (await db.execute(sql`
    select id, custom ->> ${source.refKey} as source_ref, billing_status,
           costing_basis,
           custom ->> 'sourceBillingStatus' as source_status,
           invoiced_by_line_id
      from time_entries
     where org_id = ${options.orgId}
       and custom ->> ${source.refKey} is not null
  `)) as unknown as { rows: TargetBillingState[] };

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
  const targetProjectsResult = (await db.execute(sql`
    select p.id, p.custom ->> ${source.refKey} as source_ref,
           pt.key as project_type_key, p.contract_value
      from projects p
      left join project_types pt
        on pt.id = p.project_type_id and pt.org_id = p.org_id
     where p.org_id = ${options.orgId}
       and p.custom ->> ${source.refKey} is not null
  `)) as unknown as { rows: TargetProjectState[] };
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
  const projectTypeResult = (await db.execute(sql`
    select id, key from project_types
     where org_id = ${options.orgId} and is_active
  `)) as unknown as { rows: { id: string; key: string }[] };
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
        beforeProjectType: target.project_type_key,
        afterProjectType:
          project.billingMethod ?? target.project_type_key,
        afterProjectTypeId: projectTypeId ?? null,
        beforeContractValue: targetContract,
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
    if (!billingChanged && !costingChanged) return [];
    if (
      billingChanged &&
      target.invoiced_by_line_id &&
      state.billingStatus === "unbilled"
    ) {
      throw new Error(
        `source time entry ${state.sourceRef} is unbilled but OpenBooks carries invoice-line provenance`,
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
        sourceStatus,
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
      await tx.execute(sql`
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
                   "sourceStatus" text
                 )
        ),
        prior as materialized (
          select te.id, te.billing_status as before_status,
                 te.costing_basis as before_costing_basis,
                 te.custom ->> 'sourceBillingStatus' as before_source_status,
                 input."sourceRef" as source_ref,
                 input."billingStatus" as after_status,
                 input."costingBasis" as after_costing_basis,
                 input."sourceStatus" as after_source_status
            from time_entries te
            join input on input.id = te.id
           where te.org_id = ${options.orgId}
             and te.custom ->> ${source.refKey} = input."sourceRef"
             and (
               te.billing_status is distinct from input."billingStatus"
               or te.costing_basis is distinct from input."costingBasis"
             )
           for update
        ),
        updated as (
          update time_entries te
             set billing_status = prior.after_status,
                 costing_basis = prior.after_costing_basis,
                 custom = jsonb_set(
                   coalesce(te.custom, '{}'::jsonb),
                   '{sourceBillingStatus}',
                   coalesce(to_jsonb(prior.after_source_status), 'null'::jsonb),
                   true
                 ),
                 updated_at = now(),
                 updated_by = ${actorId}
            from prior
           where te.id = prior.id
           returning te.id
        )
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        select ${options.orgId}, 'time_entries', prior.id, 'update',
               jsonb_build_object(
                 'before', jsonb_build_object(
                   'billingStatus', prior.before_status,
                   'costingBasis', prior.before_costing_basis,
                   'sourceBillingStatus', prior.before_source_status
                 ),
                 'after', jsonb_build_object(
                   'billingStatus', prior.after_status,
                   'costingBasis', prior.after_costing_basis,
                   'sourceBillingStatus', prior.after_source_status
                 ),
                 'source', jsonb_build_object(
                   'system', cast(${source.name} as text),
                   'ref', prior.source_ref,
                   'connectionId', cast(${options.connectionId} as text),
                   'syncRunId', cast(${options.runId} as text)
                 )
               ),
               ${actorId}, ${options.runId}
          from prior
          join updated on updated.id = prior.id
      `);
    }
    for (
      let offset = 0;
      offset < changedProjects.length;
      offset += BATCH
    ) {
      const batch = changedProjects.slice(offset, offset + BATCH);
      await tx.execute(sql`
        with input as (
          select *
            from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
                 as x(
                   id uuid,
                   "sourceRef" text,
                   "beforeProjectType" text,
                   "afterProjectType" text,
                   "afterProjectTypeId" uuid,
                   "beforeContractValue" numeric,
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
           where p.id = input.id and p.org_id = ${options.orgId}
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
    }
  });
  return { ...result, applied: true };
}
