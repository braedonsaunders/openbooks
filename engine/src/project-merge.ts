import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "./db.ts";
import { uuidArray } from "./subsidiaries.ts";

/**
 * Admin merge for duplicate projects (the same job under two ids — e.g. a
 * connector mirror that landed outside the source-envelope fence). One
 * project survives; every reference moves to it inside a single transaction:
 * all typed `project_id` columns, project-task children, the parent link,
 * polymorphic activity links, and `reference`-type custom values pointing at
 * projects. The merged-away row is deactivated with a `merged_into` pointer
 * in `custom`, never deleted, and the merge writes one audit row with the
 * per-table moved counts. Re-running the same pair is a no-op.
 *
 * Posted-structure conflicts fail closed before anything moves: lines on
 * non-draft documents (frozen by the storage immutability guard), a merge
 * cycle, a change-order number present on both sides (numbers are unique per
 * project in storage), or a budget/retro allocation cell key the survivor
 * already holds. Posted journal dimensions move with everything else — for a
 * true duplicate the split itself is the data error — and the preview
 * reports those counts so the admin sees the posted impact before committing.
 */

export class ProjectMergeError extends Error {
  readonly name = "ProjectMergeError";
}

export interface DuplicateProject {
  id: string;
  code: string | null;
  name: string;
  customerId: string | null;
  status: string;
  isActive: boolean;
}

export interface DuplicateGroup {
  kind: "source_ref" | "name_customer" | "job_number";
  key: string;
  projects: DuplicateProject[];
}

/** Every typed `project_id` column that follows a project merge. */
const PROJECT_REFS: readonly (readonly [table: string, column: string])[] = [
  ["journal_lines", "project_id"],
  ["document_lines", "project_id"],
  ["documents", "project_id"],
  ["fixed_assets", "project_id"],
  ["budget_lines", "project_id"],
  ["project_tasks", "project_id"],
  ["time_entries", "project_id"],
  ["billing_requests", "project_id"],
  ["billing_schedules", "project_id"],
  ["item_rate_book_assignments", "project_id"],
  ["compliance_records", "project_id"],
  ["compliance_waivers", "project_id"],
  ["lien_waivers", "project_id"],
  ["field_ticket_policies", "project_id"],
  ["project_overhead_adjustments", "project_id"],
  ["project_financial_adjustments", "project_id"],
  ["subcontracts", "project_id"],
  ["wip_prebills", "project_id"],
  ["wip_prebill_lines", "project_id"],
  ["wip_holds", "project_id"],
  ["pay_stub_lines", "project_id"],
  ["pay_derived_rules", "project_id"],
  ["payroll_retro_allocations", "project_id"],
  ["allocation_rule_targets", "project_id"],
  ["change_orders", "project_id"],
  ["lease_agreements", "project_id"],
  ["pay_applications", "project_id"],
  ["revenue_contracts", "project_id"],
  ["schedule_baselines", "project_id"],
  ["schedule_calendars", "project_id"],
  ["schedule_dependencies", "project_id"],
  ["schedule_resources", "project_id"],
  ["sov_lines", "project_id"],
];

/** List duplicate groups: same source ref, same name+customer, same job number. */
export async function findDuplicateProjects(
  orgId: string,
  opts: { subsidiaryIds?: string[] | null } = {},
): Promise<DuplicateGroup[]> {
  return withOrgTransaction(orgId, async () => {
    const scope = opts.subsidiaryIds
      ? sql`and (p.subsidiary_id = any(${uuidArray(opts.subsidiaryIds)}::uuid[]) or p.subsidiary_id is null)`
      : sql``;
    // Resolved merges leave the detection list; every other row — active or
    // not — is still a candidate.
    const unresolved = sql`and (p.custom -> 'merged_into' is null)`;
    const cols = sql`p.id, p.code, p.name, p.customer_id, p.status, p.is_active`;
    type Row = {
      id: string;
      code: string | null;
      name: string;
      customer_id: string | null;
      status: string;
      is_active: boolean;
    };
    const toProject = (row: Row): DuplicateProject => ({
      id: row.id,
      code: row.code,
      name: row.name,
      customerId: row.customer_id,
      status: row.status,
      isActive: row.is_active,
    });
    const toProjects = (rows: Row[]): DuplicateProject[] => rows.map(toProject);
    const groups: DuplicateGroup[] = [];
    // The source envelope is fenced unique per org, so the envelope leg is
    // normally empty — it guards the invariant. The legacy connector identity
    // (custom.nsid, carried by rows created before the envelope convergence)
    // is unfenced and is the leg that fires on real mirror duplicates.
    const sourceRows = (await db.execute<{ key: string; projects: Row[] }>(sql`
      with keyed as (
        select ${cols},
               (p.custom -> 'source' ->> 'system') as system,
               (p.custom -> 'source' ->> 'externalId') as external_id,
               (p.custom ->> 'nsId') as nsid
          from projects p
         where p.org_id = ${orgId} ${scope} ${unresolved}
      )
      select system || '|' || external_id as key, json_agg(to_jsonb(k) order by k.name, k.id) as projects
        from (select * from keyed where system is not null and external_id is not null) k
       group by system, external_id having count(*) > 1`)).rows;
    for (const row of sourceRows) {
      groups.push({ kind: "source_ref", key: row.key, projects: toProjects(row.projects) });
    }
    const nsidRows = (await db.execute<{ key: string; projects: Row[] }>(sql`
      select p.custom ->> 'nsId' as key, json_agg(to_jsonb(p) order by p.name, p.id) as projects
        from (select ${cols}, p.custom from projects p
              where p.org_id = ${orgId} and p.custom ->> 'nsId' is not null ${scope} ${unresolved}) p
       group by p.custom ->> 'nsId' having count(*) > 1`)).rows;
    for (const row of nsidRows) {
      groups.push({ kind: "source_ref", key: `nsId:${row.key}`, projects: toProjects(row.projects) });
    }
    const nameRows = (await db.execute<{ key: string; projects: Row[] }>(sql`
      select lower(p.name) || '|' || coalesce(p.customer_id::text, '-') as key,
             json_agg(to_jsonb(p) order by p.name, p.id) as projects
        from (select ${cols} from projects p where p.org_id = ${orgId} ${scope} ${unresolved}) p
       group by lower(p.name), p.customer_id having count(*) > 1`)).rows;
    for (const row of nameRows) {
      groups.push({ kind: "name_customer", key: row.key, projects: toProjects(row.projects) });
    }
    const codeRows = (await db.execute<{ key: string; projects: Row[] }>(sql`
      select p.code as key, json_agg(to_jsonb(p) order by p.name, p.id) as projects
        from (select ${cols} from projects p
              where p.org_id = ${orgId} and p.code is not null and p.code <> '' ${scope} ${unresolved}) p
       group by p.code having count(*) > 1`)).rows;
    for (const row of codeRows) {
      groups.push({ kind: "job_number", key: row.key, projects: toProjects(row.projects) });
    }
    return groups;
  });
}

type ProjectRow = {
  id: string;
  code: string | null;
  name: string;
  customer_id: string | null;
  status: string;
  is_active: boolean;
  parent_id: string | null;
  subsidiary_id: string | null;
  custom: Record<string, unknown>;
};

export interface MergePreview {
  survivorId: string;
  duplicateId: string;
  /** Rows that would move, per table. Posted journal lines are included. */
  moved: { table: string; rows: number }[];
  customRefs: { table: string; key: string; rows: number }[];
  alreadyMerged: boolean;
}

export interface MergeResult extends MergePreview {
  auditId: string | null;
}

async function loadProject(
  runner: SqlExecutor,
  orgId: string,
  id: string,
): Promise<ProjectRow | null> {
  const found = (await runner.execute<ProjectRow>(sql`
    select id, code, name, customer_id, status, is_active, parent_id, subsidiary_id, custom
      from projects where id = ${id} and org_id = ${orgId} limit 1`));
  return found.rows[0] ?? null;
}

function mergedInto(custom: Record<string, unknown>): string | null {
  const marker = custom?.["merged_into"];
  if (typeof marker === "object" && marker !== null) {
    const survivor = (marker as Record<string, unknown>)["survivor"];
    if (typeof survivor === "string") return survivor;
  }
  return null;
}

async function customProjectRefs(
  runner: SqlExecutor,
  orgId: string,
): Promise<{ targetTable: string; key: string }[]> {
  const defs = (await runner.execute<{ target_table: string; key: string }>(sql`
    select target_table, key from custom_field_defs
     where org_id = ${orgId} and field_type = 'reference'
       and config ->> 'referenceTable' = 'projects' and is_active`)).rows;
  const valid: { targetTable: string; key: string }[] = [];
  for (const def of defs) {
    // Target tables are tenant data: only touch real tables with a custom
    // column, never interpolate an unchecked identifier anywhere else.
    if (!/^[a-z_]+$/.test(def.target_table) || !/^[a-z_][a-z0-9_]*$/.test(def.key)) continue;
    const exists = (await runner.execute<{ n: string }>(sql`
      select count(*)::text as n from information_schema.columns
       where table_schema = 'public' and table_name = ${def.target_table}
         and column_name = 'custom'`)).rows[0]?.n;
    const orgScoped = (await runner.execute<{ n: string }>(sql`
      select count(*)::text as n from information_schema.columns
       where table_schema = 'public' and table_name = ${def.target_table}
         and column_name = 'org_id'`)).rows[0]?.n;
    if (exists === "1" && orgScoped === "1") valid.push({ targetTable: def.target_table, key: def.key });
  }
  return valid;
}

async function planMerge(
  runner: SqlExecutor,
  orgId: string,
  survivorId: string,
  duplicateId: string,
): Promise<{ survivor: ProjectRow; duplicate: ProjectRow; moved: MergePreview["moved"]; customRefs: MergePreview["customRefs"]; alreadyMerged: boolean }> {
  if (survivorId === duplicateId) {
    throw new ProjectMergeError("a project cannot merge into itself");
  }
  const [survivor, duplicate] = await Promise.all([
    loadProject(runner, orgId, survivorId),
    loadProject(runner, orgId, duplicateId),
  ]);
  if (!survivor || !duplicate) {
    throw new ProjectMergeError("both projects must exist in this organization");
  }
  const prior = mergedInto(duplicate.custom);
  if (prior) {
    if (prior === survivorId) return { survivor, duplicate, moved: [], customRefs: [], alreadyMerged: true };
    throw new ProjectMergeError("this project already merged into another project");
  }
  if (mergedInto(survivor.custom)) {
    throw new ProjectMergeError("a merged-away project cannot survive another merge");
  }
  // Cycle fence: the survivor must not sit under the duplicate.
  let cursor: string | null = survivor.parent_id;
  for (let hops = 0; hops < 100 && cursor; hops++) {
    if (cursor === duplicateId) {
      throw new ProjectMergeError("merge would cycle the project hierarchy");
    }
    const parent = (await runner.execute<{ parent_id: string | null }>(sql`
      select parent_id from projects where id = ${cursor} and org_id = ${orgId} limit 1`)).rows[0];
    if (!parent) break;
    cursor = parent.parent_id;
  }
  // Lines of non-draft documents are frozen by the storage immutability
  // guard and cannot follow the merge: a duplicate carrying them refuses,
  // naming the count, instead of splitting posted history. Draft lines move.
  const frozenLines = (await runner.execute<{ n: string }>(sql`
    select count(*)::text as n
      from document_lines dl join documents d on d.id = dl.document_id and d.org_id = dl.org_id
     where dl.org_id = ${orgId} and dl.project_id = ${duplicateId} and d.status <> 'draft'`)).rows[0]?.n;
  if (frozenLines !== "0") {
    throw new ProjectMergeError(
      `cannot move lines of ${frozenLines} non-draft document(s); void or correct them first`,
    );
  }
  // Storage-level collisions fail closed before anything moves.
  const budgetCollision = (await runner.execute<{ n: string }>(sql`
    select count(*)::text as n
      from budget_lines d
      join budget_lines s
        on s.org_id = d.org_id and s.scenario_id = d.scenario_id and s.account_id = d.account_id
       and s.period_id = d.period_id and s.subsidiary_id is not distinct from d.subsidiary_id
       and s.department_id is not distinct from d.department_id and s.project_id = ${survivorId}
       and s.location_id is not distinct from d.location_id and s.class_id is not distinct from d.class_id
     where d.org_id = ${orgId} and d.project_id = ${duplicateId}`)).rows[0]?.n;
  if (budgetCollision !== "0") {
    throw new ProjectMergeError("both projects hold the same budget cell; reconcile budgets first");
  }
  const retroCollision = (await runner.execute<{ n: string }>(sql`
    select count(*)::text as n
      from payroll_retro_allocations d
      join payroll_retro_allocations s
        on s.org_id = d.org_id and s.settlement_id = d.settlement_id
       and s.component_id = d.component_id and s.project_id = ${survivorId}
       and s.department_id is not distinct from d.department_id
     where d.org_id = ${orgId} and d.project_id = ${duplicateId}`)).rows[0]?.n;
  if (retroCollision !== "0") {
    throw new ProjectMergeError("both projects hold the same retro allocation bucket; reconcile first");
  }
  const orderCollision = (await runner.execute<{ number: string }>(sql`
    select d.number from change_orders d
     where d.org_id = ${orgId} and d.project_id = ${duplicateId}
       and exists (select 1 from change_orders s
                    where s.org_id = ${orgId} and s.project_id = ${survivorId} and s.number = d.number)
     limit 5`)).rows;
  if (orderCollision.length > 0) {
    throw new ProjectMergeError(
      `change order number ${orderCollision.map((row) => row.number).join(", ")} exists on both projects`,
    );
  }
  const moved: MergePreview["moved"] = [];
  for (const [table, column] of PROJECT_REFS) {
    const count = (await runner.execute<{ n: string }>(sql`
      select count(*)::text as n from ${sql.identifier(table)}
       where org_id = ${orgId} and ${sql.identifier(column)} = ${duplicateId}`)).rows[0]?.n;
    moved.push({ table, rows: Number(count ?? 0) });
  }
  const customRefs: MergePreview["customRefs"] = [];
  for (const ref of await customProjectRefs(runner, orgId)) {
    const count = (await runner.execute<{ n: string }>(sql`
      select count(*)::text as n from ${sql.identifier(ref.targetTable)}
       where org_id = ${orgId} and custom ->> ${ref.key} = ${duplicateId}`)).rows[0]?.n;
    if (count !== "0") customRefs.push({ table: ref.targetTable, key: ref.key, rows: Number(count ?? 0) });
  }
  return { survivor, duplicate, moved, customRefs, alreadyMerged: false };
}

/** Read-only impact preview for one merge pair. */
export async function previewProjectMerge(
  orgId: string,
  survivorId: string,
  duplicateId: string,
): Promise<MergePreview> {
  return withOrgTransaction(orgId, async () => {
    const plan = await planMerge(db, orgId, survivorId, duplicateId);
    return {
      survivorId,
      duplicateId,
      moved: plan.moved,
      customRefs: plan.customRefs,
      alreadyMerged: plan.alreadyMerged,
    };
  });
}

/**
 * Merge `duplicateId` into `survivorId` in one transaction. Every typed
 * reference, child project, activity link, and project custom value moves;
 * the duplicate is deactivated with a `merged_into` pointer; one audit row
 * records the per-table counts, actor, and reason. Idempotent.
 */
export async function mergeProjects(
  orgId: string,
  opts: { survivorId: string; duplicateId: string; actorId: string | null },
): Promise<MergeResult> {
  return withOrgTransaction(orgId, () =>
    db.transaction(async (tx) => {
      const plan = await planMerge(tx, orgId, opts.survivorId, opts.duplicateId);
      if (plan.alreadyMerged) {
        return {
          survivorId: opts.survivorId,
          duplicateId: opts.duplicateId,
          moved: [],
          customRefs: [],
          alreadyMerged: true,
          auditId: null,
        };
      }
      const movedCounts: Record<string, number> = {};
      for (const [table, column] of PROJECT_REFS) {
        const updated = (await tx.execute<{ id: string }>(sql`
          update ${sql.identifier(table)} set ${sql.identifier(column)} = ${opts.survivorId}
           where org_id = ${orgId} and ${sql.identifier(column)} = ${opts.duplicateId}
          returning id`)).rows;
        if (updated.length > 0) movedCounts[table] = updated.length;
      }
      // Children follow the survivor; a survivor parented under the duplicate
      // keeps its hierarchy level instead of pointing at a merged row.
      await tx.execute(sql`
        update projects set parent_id = ${opts.survivorId}, updated_at = now(), updated_by = ${opts.actorId}
         where org_id = ${orgId} and parent_id = ${opts.duplicateId} and id <> ${opts.survivorId}`);
      if (plan.survivor.parent_id === opts.duplicateId) {
        await tx.execute(sql`
          update projects set parent_id = ${plan.duplicate.parent_id}, updated_at = now(), updated_by = ${opts.actorId}
           where org_id = ${orgId} and id = ${opts.survivorId}`);
      }
      await tx.execute(sql`
        update crm_activity_links set subject_id = ${opts.survivorId}
         where org_id = ${orgId} and subject_kind = 'project' and subject_id = ${opts.duplicateId}`);
      for (const ref of await customProjectRefs(tx, orgId)) {
        await tx.execute(sql`
          update ${sql.identifier(ref.targetTable)}
             set custom = jsonb_set(custom, array[${ref.key}], to_jsonb(${opts.survivorId}::text))
           where org_id = ${orgId} and custom ->> ${ref.key} = ${opts.duplicateId}`);
      }
      const mergedCustom = {
        ...(plan.duplicate.custom ?? {}),
        merged_into: {
          survivor: opts.survivorId,
          at: new Date().toISOString(),
          by: opts.actorId,
        },
      };
      await tx.execute(sql`
        update projects
           set is_active = false, custom = ${JSON.stringify(mergedCustom)}::jsonb,
               updated_at = now(), updated_by = ${opts.actorId}
         where org_id = ${orgId} and id = ${opts.duplicateId}`);
      const audit = (await tx.execute<{ id: string }>(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'projects', ${opts.duplicateId}, 'merge',
                ${JSON.stringify({
                  survivor: opts.survivorId,
                  moved: movedCounts,
                  reason: "duplicate project merge",
                })}::jsonb, ${opts.actorId})
        returning id`)).rows[0];
      return {
        survivorId: opts.survivorId,
        duplicateId: opts.duplicateId,
        moved: plan.moved,
        customRefs: plan.customRefs,
        alreadyMerged: false,
        auditId: audit?.id ?? null,
      };
    }));
}
