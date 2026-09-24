import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { uuidArray } from "../organization/subsidiaries.ts";

/**
 * Admin merge for duplicate projects (the same job under two ids — e.g. a
 * connector mirror that landed outside the source-envelope fence). One
 * project survives; every reference moves to it inside a single transaction:
 * all typed `project_id` columns except the reviewed exclusions in
 * PROJECT_MERGE_EXCLUSIONS (certified-payroll runs stay put as filed
 * compliance evidence), project-task children, the parent link, polymorphic
 * activity links, and `reference`-type custom values pointing at projects.
 * The merged-away row is deactivated with a `merged_into` pointer in
 * `custom`, never deleted, and the merge writes one audit row with the
 * per-table moved counts. Re-running the same pair is a no-op.
 *
 * Posted-structure conflicts fail closed before anything moves: lines on
 * non-draft documents (frozen by the storage immutability guard), posted
 * journal lines in a controller-closed GL period (reopen the period first),
 * a merge cycle, a change-order number present on both sides (numbers are
 * unique per project in storage), or a budget/retro allocation cell key the
 * survivor already holds. Posted journal lines in open periods move with
 * everything else through the governed amend path — the same paired
 * transaction-local authority party merges use — and the preview reports
 * those counts so the admin sees the posted impact before committing.
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

/**
 * Every typed `project_id` column that follows a project merge.
 *
 * Exported for the catalog-completeness test (merge-refs): any typed
 * `project_id` column in the catalog must appear here or in
 * PROJECT_MERGE_EXCLUSIONS, so a new project-linked table cannot silently
 * stay behind on the merged-away project.
 */
export const PROJECT_REFS: readonly (readonly [table: string, column: string])[] = [
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
  ["crew_time_batches", "project_id"],
  ["project_geofences", "project_id"],
  ["time_kiosks", "project_id"],
  ["time_clock_events", "project_id"],
  ["hrm_per_diem_entries", "project_id"],
  ["hrm_travel_pay_entries", "project_id"],
  ["hrm_compliance_findings", "project_id"],
];

/**
 * Typed `project_id` columns that deliberately do NOT follow a merge, each
 * with the reviewed reason. The completeness test requires every catalog
 * column to sit here or in PROJECT_REFS — an exclusion is a decision with
 * a remedy, never a quiet omission.
 */
export const PROJECT_MERGE_EXCLUSIONS: readonly (readonly [table: string, reason: string])[] = [
  [
    "hrm_certified_payroll_runs",
    "filed compliance evidence stays on its original project: generated and submitted runs snapshot the week's project data into a payload whose rendered report file is housed in that project's file folder, amendment chains link runs across weeks, and draft members of a chain stay with the filed runs they amend. Re-pointing any of them would rewrite filed history — amend or regenerate under the survivor instead.",
  ],
];

/** List duplicate groups: same source ref, same name+customer, same job number. */
export async function findDuplicateProjects(
  orgId: string,
  opts: { subsidiaryIds?: string[] | null } = {},
): Promise<DuplicateGroup[]> {
  return withOrgTransaction(orgId, async () => {
    // Restricted callers see only rows in their allowlist: null-subsidiary
    // projects stay hidden, mirroring guardSubsidiaryScope without
    // org-wide-null (projects carry no org-wide identity — the old
    // `or subsidiary_id is null` leaked rows the record gate denies).
    // An empty allowlist therefore lists nothing; a null one lists all.
    const scope = opts.subsidiaryIds
      ? sql`and p.subsidiary_id = any(${uuidArray(opts.subsidiaryIds)}::uuid[])`
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
  contract_value: string | null;
  project_type_id: string | null;
  invoicing_preference: unknown;
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
  lock = false,
): Promise<ProjectRow | null> {
  const found = (await runner.execute<ProjectRow>(lock
    ? sql`
      select id, code, name, customer_id, status, is_active, parent_id, subsidiary_id,
             contract_value::text as contract_value, project_type_id, invoicing_preference, custom
        from projects where id = ${id} and org_id = ${orgId} limit 1 for update`
    : sql`
      select id, code, name, customer_id, status, is_active, parent_id, subsidiary_id,
             contract_value::text as contract_value, project_type_id, invoicing_preference, custom
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

/**
 * Subsidiary scope inside the locked merge: both locked rows must sit in
 * the caller's scope. Restricted callers fail closed on null-subsidiary
 * projects, mirroring guardSubsidiaryScope without org-wide-null (projects
 * carry no org-wide identity). An undefined scope means the caller passed
 * none — the HTTP boundary always passes its allowlist; engine-internal
 * callers without one inherit no enforcement and must be audited.
 */
/**
 * Order-insensitive JSON canonical form for comparing jsonb preferences:
 * two stored documents with the same meaning but different key order must
 * compare equal, so a cosmetic rewrite never blocks a merge.
 */
function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function mergeScopeAllows(
  scope: ReadonlySet<string> | null | undefined,
  subsidiaryId: string | null,
): boolean {
  if (scope === undefined || scope === null) return true;
  return subsidiaryId !== null && scope.has(subsidiaryId);
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
  lock = false,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
): Promise<{ survivor: ProjectRow; duplicate: ProjectRow; moved: MergePreview["moved"]; customRefs: MergePreview["customRefs"]; alreadyMerged: boolean }> {
  if (survivorId === duplicateId) {
    throw new ProjectMergeError("a project cannot merge into itself");
  }
  // A committing merge locks both rows in deterministic id order BEFORE
  // planning: two merges racing on overlapping pairs serialize here instead
  // of both planning against unlocked reads — the loser would otherwise move
  // zero refs, overwrite merged_into, and audit success. The merged_into
  // checks below then re-read locked state, so the loser becomes a no-op (or
  // refuses) rather than a second success. Previews stay unlocked: they are
  // read-only, and the committing merge re-checks under its own locks.
  let survivor: ProjectRow | null;
  let duplicate: ProjectRow | null;
  if (lock) {
    const [firstId, secondId] = [survivorId, duplicateId].sort() as [string, string];
    const first = await loadProject(runner, orgId, firstId, true);
    const second = await loadProject(runner, orgId, secondId, true);
    survivor = firstId === survivorId ? first : second;
    duplicate = firstId === survivorId ? second : first;
  } else {
    [survivor, duplicate] = await Promise.all([
      loadProject(runner, orgId, survivorId),
      loadProject(runner, orgId, duplicateId),
    ]);
  }
  if (!survivor || !duplicate) {
    throw new ProjectMergeError("both projects must exist in this organization");
  }
  // The scope check runs on the locked rows, not on a pre-transaction read:
  // a scope narrowing between the route's fast-path check and this
  // transaction must still refuse before anything moves. Scope stays ahead
  // of the idempotency short-circuit below: access fail-closed wins over a
  // quiet no-op.
  if (
    !mergeScopeAllows(allowedSubsidiaryIds, survivor.subsidiary_id) ||
    !mergeScopeAllows(allowedSubsidiaryIds, duplicate.subsidiary_id)
  ) {
    throw new ProjectMergeError("merge pair is outside the caller subsidiary scope");
  }
  const prior = mergedInto(duplicate.custom);
  if (prior) {
    if (prior === survivorId) return { survivor, duplicate, moved: [], customRefs: [], alreadyMerged: true };
    throw new ProjectMergeError("this project already merged into another project");
  }
  if (mergedInto(survivor.custom)) {
    throw new ProjectMergeError("a merged-away project cannot survive another merge");
  }
  // The merge rewrites project_id on every reference while each row keeps
  // its own subsidiary, so merging across subsidiaries would silently fold
  // one legal entity's postings, budgets, and billings into another's.
  // Refuse with the remedy: set both projects to the same subsidiary first.
  // Sits after the idempotent no-op above so re-running a finished pair
  // stays a no-op.
  if (survivor.subsidiary_id !== duplicate.subsidiary_id) {
    throw new ProjectMergeError(
      "cannot merge projects from different subsidiaries; set both projects to the same subsidiary first",
    );
  }
  // Billing identity reconciles before references move: the survivor's
  // contract value, project type, and invoicing preference price every
  // moved line, so a mismatch refuses — naming the field and the remedy,
  // reconcile it on one side first — instead of silently repricing the
  // duplicate's history. After the no-op above for the same reason.
  const billingMismatch =
    survivor.contract_value !== duplicate.contract_value
      ? "contract value"
      : survivor.project_type_id !== duplicate.project_type_id
        ? "project type"
        : stableJson(survivor.invoicing_preference) !== stableJson(duplicate.invoicing_preference)
          ? "invoicing preference"
          : null;
  if (billingMismatch) {
    throw new ProjectMergeError(
      `cannot merge: the projects disagree on ${billingMismatch}; reconcile it on one side first`,
    );
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
  // Posted journal lines move through the governed amend path (the same
  // paired transaction-local authority party merges use), but a
  // controller-closed GL period still refuses: those lines cannot follow
  // the merge while the period is closed. Checked here — with the same
  // migration-aware lens the journal guard will see under the amend pair —
  // so both preview and commit refuse by name instead of the guard firing
  // a raw storage error mid-merge.
  const closedLines = (await runner.execute<{ n: string }>(sql`
    select count(*)::text as n
      from journal_lines jl
      join journal_entries e on e.id = jl.entry_id and e.org_id = jl.org_id
     where jl.org_id = ${orgId} and jl.project_id = ${duplicateId}
       and e.status in ('posted', 'reversed')
       and period_module_blocks_write(${orgId}, e.period_id, e.book_id, jl.subsidiary_id, 'gl', true)`)).rows[0]?.n;
  if (closedLines !== "0") {
    throw new ProjectMergeError(
      `cannot merge: ${closedLines} posted journal line(s) sit in a closed GL period; reopen the period before merging`,
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
  // One primary baseline per project in storage: moving the duplicate's
  // primary onto a survivor that already holds one would violate the
  // partial unique index instead of merging. Refuse with the remedy.
  const baselineCollision = (await runner.execute<{ n: string }>(sql`
    select count(*)::text as n
      from schedule_baselines d
     where d.org_id = ${orgId} and d.project_id = ${duplicateId} and d.is_primary
       and exists (select 1 from schedule_baselines s
                    where s.org_id = ${orgId} and s.project_id = ${survivorId} and s.is_primary)`)).rows[0]?.n;
  if (baselineCollision !== "0") {
    throw new ProjectMergeError("both projects hold a primary schedule baseline; reconcile baselines first");
  }
  // Pay applications number per project like change orders: the same
  // application number on both sides would violate the per-project unique
  // index on the move. Name the numbers, like the change-order guard.
  const payAppCollision = (await runner.execute<{ number: string }>(sql`
    select d.application_number as number from pay_applications d
     where d.org_id = ${orgId} and d.project_id = ${duplicateId}
       and exists (select 1 from pay_applications s
                    where s.org_id = ${orgId} and s.project_id = ${survivorId}
                      and s.application_number = d.application_number)
     limit 5`)).rows;
  if (payAppCollision.length > 0) {
    throw new ProjectMergeError(
      `pay application number ${payAppCollision.map((row) => row.number).join(", ")} exists on both projects`,
    );
  }
  // One open pay application per project in storage: moving the duplicate's
  // open application onto a survivor that already holds one would violate
  // the partial unique index instead of merging. Refuse with the remedy.
  const openPayAppCollision = (await runner.execute<{ n: string }>(sql`
    select count(*)::text as n
      from pay_applications d
     where d.org_id = ${orgId} and d.project_id = ${duplicateId}
       and d.status in ('draft', 'submitted', 'approved')
       and exists (select 1 from pay_applications s
                    where s.org_id = ${orgId} and s.project_id = ${survivorId}
                      and s.status in ('draft', 'submitted', 'approved'))`)).rows[0]?.n;
  if (openPayAppCollision !== "0") {
    throw new ProjectMergeError("both projects hold an open pay application; reconcile pay applications first");
  }
  // Field-time identity is per foreman-day in storage: the same foreman's
  // batch for the same day on both sides would violate the unique index on
  // the move. Name the collisions like the change-order guard.
  const batchCollision = (await runner.execute<{ detail: string }>(sql`
    select p.display_name || ' on ' || d.worked_on::text as detail
      from crew_time_batches d
      join parties p on p.id = d.foreman_party_id and p.org_id = d.org_id
     where d.org_id = ${orgId} and d.project_id = ${duplicateId}
       and exists (select 1 from crew_time_batches s
                    where s.org_id = ${orgId} and s.project_id = ${survivorId}
                      and s.foreman_party_id = d.foreman_party_id and s.worked_on = d.worked_on)
     limit 5`)).rows;
  if (batchCollision.length > 0) {
    throw new ProjectMergeError(
      `crew time for the same foreman day exists on both projects (${batchCollision.map((row) => row.detail).join("; ")}); reconcile crew time first`,
    );
  }
  // One geofence of each kind per project in storage.
  const geofenceCollision = (await runner.execute<{ kind: string }>(sql`
    select d.kind from project_geofences d
     where d.org_id = ${orgId} and d.project_id = ${duplicateId}
       and exists (select 1 from project_geofences s
                    where s.org_id = ${orgId} and s.project_id = ${survivorId} and s.kind = d.kind)
     limit 5`)).rows;
  if (geofenceCollision.length > 0) {
    throw new ProjectMergeError(
      `a ${geofenceCollision.map((row) => row.kind).join(", ")} geofence exists on both projects; reconcile geofences first`,
    );
  }
  // Per-diem and travel pay uniqueness is per worker-day in storage.
  const perDiemCollision = (await runner.execute<{ detail: string }>(sql`
    select p.display_name || ' on ' || d.worked_on::text as detail
      from hrm_per_diem_entries d
      join worker_employments e on e.org_id = d.org_id and e.id = d.employment_id
      join parties p on p.id = e.worker_party_id and p.org_id = d.org_id
     where d.org_id = ${orgId} and d.project_id = ${duplicateId}
       and exists (select 1 from hrm_per_diem_entries s
                    where s.org_id = ${orgId} and s.project_id = ${survivorId}
                      and s.employment_id = d.employment_id and s.worked_on = d.worked_on)
     limit 5`)).rows;
  if (perDiemCollision.length > 0) {
    throw new ProjectMergeError(
      `per-diem for the same worker day exists on both projects (${perDiemCollision.map((row) => row.detail).join("; ")}); reconcile per-diem entries first`,
    );
  }
  const travelCollision = (await runner.execute<{ detail: string }>(sql`
    select p.display_name || ' on ' || d.worked_on::text as detail
      from hrm_travel_pay_entries d
      join worker_employments e on e.org_id = d.org_id and e.id = d.employment_id
      join parties p on p.id = e.worker_party_id and p.org_id = d.org_id
     where d.org_id = ${orgId} and d.project_id = ${duplicateId}
       and exists (select 1 from hrm_travel_pay_entries s
                    where s.org_id = ${orgId} and s.project_id = ${survivorId}
                      and s.employment_id = d.employment_id and s.worked_on = d.worked_on)
     limit 5`)).rows;
  if (travelCollision.length > 0) {
    throw new ProjectMergeError(
      `travel pay for the same worker day exists on both projects (${travelCollision.map((row) => row.detail).join("; ")}); reconcile travel pay entries first`,
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
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
): Promise<MergePreview> {
  return withOrgTransaction(orgId, async () => {
    // In-transaction fence: the route's entry gate may be stale by the time
    // this runs, so a concurrent feature disable still refuses here.
    if (!(await lockAndCheckOrgFeature(db, orgId, "projects"))) {
      throw new ProjectMergeError("projects feature is disabled");
    }
    const plan = await planMerge(db, orgId, survivorId, duplicateId, false, allowedSubsidiaryIds);
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
 *
 * When the caller passes its subsidiary allowlist it is enforced on the
 * locked rows inside this transaction — the route's pre-check alone cannot
 * cover a scope narrowing mid-flight.
 */
export async function mergeProjects(
  orgId: string,
  opts: {
    survivorId: string;
    duplicateId: string;
    actorId: string | null;
    allowedSubsidiaryIds?: ReadonlySet<string> | null;
  },
): Promise<MergeResult> {
  return withOrgTransaction(orgId, () =>
    db.transaction(async (tx) => {
      // In-transaction feature fence first: the route's entry gate read the
      // flag outside any transaction, so an in-flight merge must re-check
      // under the org's shared feature lock before rewriting references or
      // deactivating a project under a disabled gate.
      if (!(await lockAndCheckOrgFeature(tx, orgId, "projects"))) {
        throw new ProjectMergeError("projects feature is disabled");
      }
      // Re-pointing posted journal lines runs through the governed amend
      // path, the same paired transaction-local authority party merges and
      // historical replay use: the journal guard admits posted-line project
      // moves, while controller-closed periods still block (those pairs
      // refuse by name in planMerge before anything moves). Either setting
      // alone is deliberately not a bypass. Previous values are restored on
      // success; after a failure only rollback is legal, and the settings
      // last only until the transaction ends either way.
      const prior = (await tx.execute<{ name: string; value: string }>(sql`
        select 'openbooks.amend' as name, coalesce(current_setting('openbooks.amend', true), 'off') as value
         union all
        select 'openbooks.migration', coalesce(current_setting('openbooks.migration', true), 'off')`)).rows;
      const restore = new Map(prior.map((r) => [r.name, r.value]));
      // Sequential restores: concurrent set_config calls share this
      // transaction's single pg client.
      const restoreSettings = async (): Promise<void> => {
        await tx.execute(
          sql`select set_config('openbooks.amend', ${restore.get("openbooks.amend") ?? "off"}, true)`,
        );
        await tx.execute(
          sql`select set_config('openbooks.migration', ${restore.get("openbooks.migration") ?? "off"}, true)`,
        );
      };
      await tx.execute(sql`set local openbooks.amend = on`);
      await tx.execute(sql`set local openbooks.migration = on`);
      const plan = await planMerge(tx, orgId, opts.survivorId, opts.duplicateId, true, opts.allowedSubsidiaryIds);
      if (plan.alreadyMerged) {
        await restoreSettings();
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
      await restoreSettings();
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
