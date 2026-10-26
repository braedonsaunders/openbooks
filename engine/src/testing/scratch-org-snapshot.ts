import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import type { ScratchOrg } from "./scratch-org-bootstrap.ts";
import {
  AUDIT_WRITER_TRIGGERS,
  CORE_A,
  GUARDED_EVIDENCE,
  RETAINED_CABINET_FILE_SOURCES,
  SQL_IDENT,
  clearDisposableProjectAwardReferences,
  deleteQualifiedCabinetFixtureSources,
  dropScratchOrgEscaped,
  guardTeardownTransaction,
  qualified,
  setTeardownGucs,
} from "./tenant-teardown.ts";

// ---------------------------------------------------------------------------
// Bounded integration-fixture pool.
// ---------------------------------------------------------------------------

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function snapshotSchemaName(orgId: string): string {
  return `scratch_fixture_snapshot_${orgId.replaceAll(/[^a-zA-Z0-9]/g, "")}`;
}

export type OrgTableColumns = ReadonlyMap<string, readonly string[]>;

export async function loadOrgTableColumns(tables: readonly string[]): Promise<OrgTableColumns> {
  const result = await db.execute<{ table_name: string; column_name: string }>(
    sql`
    select table_name, column_name
      from information_schema.columns
     where table_schema = 'public'
       and table_name in (${sql.join(
         tables.map((table) => sql`${table}`),
         sql`, `,
       )})
       and is_generated = 'NEVER'
     order by table_name, ordinal_position`,
    "objects",
  );
  const columns = new Map<string, string[]>();
  for (const row of result) {
    const tableColumns = columns.get(row.table_name) ?? [];
    if (!columns.has(row.table_name)) columns.set(row.table_name, tableColumns);
    tableColumns.push(row.column_name);
  }
  return columns;
}

function rowMatch(columns: readonly string[], left: string, right: string): string {
  return columns
    .map(
      (column) =>
        `${left}.${quoteIdentifier(column)} is not distinct from ${right}.${quoteIdentifier(column)}`,
    )
    .join(" and ");
}

/** Discover plain-column unique and exclusion keys for safe baseline restoration. */
async function loadUniqueKeys(tables: readonly string[]): Promise<Map<string, string[][]>> {
  const keys = new Map<string, string[][]>();
  if (tables.length === 0) return keys;
  const result = await db.execute<{ index: string; table: string; column: string }>(
    sql`
    select i.indexrelid::text as "index", t.relname as "table", a.attname as "column"
      from pg_index i
      join pg_class t on t.oid = i.indrelid
      join pg_namespace n on n.oid = t.relnamespace and n.nspname = 'public'
      join lateral unnest(i.indkey) with ordinality as k(attnum, ord) on true
      join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
     where ((i.indisunique and i.indexprs is null) or i.indisexclusion)
       and i.indisvalid and not i.indisprimary
       and t.relname in (${sql.join(
         tables.map((table) => sql`${table}`),
         sql`, `,
       )})
     order by "index", k.ord`,
    "objects",
  );
  const byIndex = new Map<string, { table: string; columns: string[] }>();
  for (const row of result) {
    let entry = byIndex.get(row.index);
    if (!entry) {
      entry = { table: row.table, columns: [] };
      byIndex.set(row.index, entry);
    }
    entry.columns.push(row.column);
  }
  for (const { table, columns } of byIndex.values()) {
    // Catalog names are quoted at use; drop anything that is not a plain
    // identifier rather than trusting DDL made elsewhere.
    if (!SQL_IDENT.test(table) || columns.some((column) => !SQL_IDENT.test(column))) continue;
    const tableKeys = keys.get(table) ?? [];
    if (!keys.has(table)) keys.set(table, tableKeys);
    tableKeys.push(columns);
  }
  return keys;
}

/** Persist a committed template for every org-owned row. This snapshot is
 * database-backed (not a module/temp-table cache), so all test connections
 * restore the same exact baseline, including updates to seeded rows. */
export async function snapshotScratchOrg(
  org: ScratchOrg,
  tables: readonly string[],
): Promise<ScratchOrg> {
  const schema = snapshotSchemaName(org.orgId);
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`create schema if not exists ${quoteIdentifier(schema)}`));
    for (const table of tables) {
      const target = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
      const source = `public.${quoteIdentifier(table)}`;
      await tx.execute(sql.raw(`drop table if exists ${target}`));
      await tx.execute(sql.raw(`create table ${target} as table ${source} with no data`));
      if (table === "orgs") {
        await tx.execute(
          sql`insert into ${sql.raw(target)} select * from ${sql.raw(source)} where id = ${org.orgId}`,
        );
      } else {
        await tx.execute(
          sql`insert into ${sql.raw(target)} select * from ${sql.raw(source)} where org_id = ${org.orgId}`,
        );
      }
    }
  });
  return { ...org, snapshotSchema: schema };
}

/** Preserve PostgreSQL diagnostic details without the driver query dump. */
function describeResetFailure(error: unknown): string {
  const cause = (error as { cause?: unknown } | null | undefined)?.cause;
  if (typeof cause === "object" && cause !== null) {
    const pg = cause as {
      message?: unknown;
      code?: unknown;
      constraint?: unknown;
      detail?: unknown;
    };
    if (typeof pg.message === "string") {
      const code = typeof pg.code === "string" ? pg.code : "?";
      const constraint = typeof pg.constraint === "string" ? pg.constraint : "?";
      const detail = typeof pg.detail === "string" && pg.detail.length > 0 ? ` ${pg.detail}` : "";
      return `${pg.message} [${code}:${constraint}]${detail}`;
    }
  }
  return String(error);
}

export interface ScratchOrgTouchProbe {
  /** Org-owned tables whose live rows differ from the committed snapshot. */
  tables: string[];
  /** Non-org-keyed evidence (file blobs/versions, tax members, password resets) exists for the org. */
  special: boolean;
}

/** Compare live rows with the committed snapshot and report tables needing reset. */
export async function probeScratchOrgTouchedTables(
  org: ScratchOrg,
  tables: readonly string[],
): Promise<ScratchOrgTouchProbe> {
  const schema = org.snapshotSchema;
  if (!schema) throw new Error(`scratch fixture ${org.orgId} has no committed baseline snapshot`);
  const orgId = org.orgId;
  const snapshot = quoteIdentifier(schema);
  const predicate = (table: string) =>
    table === "orgs" ? sql`id = ${orgId}` : sql`org_id = ${orgId}`;
  return await db.transaction(async (tx) => {
    const countBranches = tables.map(
      (table) => sql`
      select ${table}::text as "table",
        (select count(*)::int from ${sql.raw(`public.${quoteIdentifier(table)}`)} where ${predicate(table)}) as "live",
        (select count(*)::int from ${sql.raw(`${snapshot}.${quoteIdentifier(table)}`)}) as "snap"`,
    );
    const counts = await tx.execute<{ table: string; live: number; snap: number }>(
      sql.join(countBranches, sql` union all `),
      "objects",
    );
    const touched = new Set<string>();
    const candidates: string[] = [];
    for (const row of counts) {
      if (row.live !== row.snap) touched.add(row.table);
      else if (row.snap > 0) candidates.push(row.table);
    }
    // Tables with matching non-zero counts may still hide an in-place
    // baseline mutation. Compare full row multisets in both directions;
    // equal counts plus empty differences in both directions is equality.
    if (candidates.length > 0) {
      const diffBranches = candidates.map(
        (table) => sql`
        select ${table}::text as "table", (
          (select count(*)::int from (
            (select * from ${sql.raw(`public.${quoteIdentifier(table)}`)} where ${predicate(table)})
            except
            (select * from ${sql.raw(`${snapshot}.${quoteIdentifier(table)}`)})
          ) d1)
          + (select count(*)::int from (
            (select * from ${sql.raw(`${snapshot}.${quoteIdentifier(table)}`)})
            except
            (select * from ${sql.raw(`public.${quoteIdentifier(table)}`)} where ${predicate(table)})
          ) d2)
        ) as "diff"`,
      );
      const diffs = await tx.execute<{ table: string; diff: number }>(
        sql.join(diffBranches, sql` union all `),
        "objects",
      );
      for (const row of diffs) {
        if (row.diff !== 0) touched.add(row.table);
      }
    }
    // Probe evidence rows linked through files, groups, or users instead of org_id.
    const special = await tx.execute<{
      blobs: boolean;
      versions: boolean;
      members: boolean;
      resets: boolean;
    }>(
      sql`
      select
        exists(select 1 from file_blobs
          where version_id in (select v.id from file_versions v join files f on f.id = v.file_id where f.org_id = ${orgId})) as "blobs",
        exists(select 1 from file_versions
          where file_id in (select id from files where org_id = ${orgId})) as "versions",
        exists(select 1 from tax_group_members
          where tax_group_id in (select id from tax_groups where org_id = ${orgId})) as "members",
        exists(select 1 from auth_password_resets
          where user_id in (select id from users where org_id = ${orgId})) as "resets"`,
      "objects",
    );
    const flag = special[0];
    return {
      tables: [...touched],
      special: !flag || flag.blobs || flag.versions || flag.members || flag.resets,
    };
  });
}

/** Restore mutable baseline values and missing rows before and after tenant cleanup. */
/** Defer guarded lifecycle columns until test rows have been deleted. */
const DEFERRED_RESTORE_COLUMNS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["accounting_books", new Set(["is_primary"])],
  ["accounts", new Set(["type"])],
  ["orgs", new Set(["env_kind"])],
]);

async function restoreScratchOrgBaseline(
  org: ScratchOrg,
  tables: readonly string[],
  columns: OrgTableColumns,
  options?: { deferLifecycleColumns?: boolean },
): Promise<void> {
  const schema = org.snapshotSchema;
  if (!schema) throw new Error(`scratch fixture ${org.orgId} has no committed baseline snapshot`);
  let restoreRemaining = tables.filter((table) => (columns.get(table) ?? []).includes("id"));
  const uniqueKeys = await loadUniqueKeys(restoreRemaining);
  const restoreErrors = new Map<string, string>();
  for (let pass = 0; pass < 10 && restoreRemaining.length > 0; pass += 1) {
    const failed = await db.transaction(async (tx) => {
      await guardTeardownTransaction(tx, org.orgId, "scratch");
      // Template restoration is part of the same disposable tenant wipe.
      // Production recipe guards admit this only for an identified sandbox.
      await tx.execute(sql`update orgs set env_kind='sandbox' where id=${org.orgId}`);
      // Defer both document/journal references while restoring the committed baseline.
      await tx.execute(
        sql`set constraints documents_posted_entry_id_fkey, documents_reversal_entry_id_fkey deferred`,
      );
      // Clear a non-baseline default before restoring the baseline default to preserve its unique constraint.
      if (restoreRemaining.includes("fiscal_calendars")) {
        await tx.execute(sql`
          update ${sql.raw(`public.${quoteIdentifier("fiscal_calendars")}`)} as target
             set ${sql.raw(quoteIdentifier("is_default"))} = false
           where target.${sql.raw(quoteIdentifier("org_id"))} = ${org.orgId}
             and target.${sql.raw(quoteIdentifier("is_default"))}
             and not exists (
               select 1
                 from ${sql.raw(`${quoteIdentifier(schema)}.${quoteIdentifier("fiscal_calendars")}`)} as baseline
                where baseline.${sql.raw(quoteIdentifier("id"))} = target.${sql.raw(quoteIdentifier("id"))}
             )
        `);
      }
      const failures: { table: string; error: string }[] = [];
      for (const [index, table] of restoreRemaining.entries()) {
        const tableColumns = columns.get(table) ?? [];
        const deferred =
          options?.deferLifecycleColumns === true ? DEFERRED_RESTORE_COLUMNS.get(table) : undefined;
        const mutable = tableColumns.filter((column) => column !== "id" && !deferred?.has(column));
        const target = `public.${quoteIdentifier(table)}`;
        const snapshot = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
        const assignments = mutable
          .map((column) => `${quoteIdentifier(column)} = baseline.${quoteIdentifier(column)}`)
          .join(", ");
        const insertColumns = tableColumns.map(quoteIdentifier).join(", ");
        // The owner column is an identifier chosen by a ternary over two fixed
        // names; the org id itself always travels as a bound parameter, never
        // interpolated into raw SQL.
        const ownerColumnFragment = sql.raw(`target.${table === "orgs" ? "id" : "org_id"}`);
        const savepoint = `scratch_fixture_restore_${pass}_${index}`;
        await tx.execute(sql.raw(`savepoint ${savepoint}`));
        try {
          // Recipe templates can predate the test's approved production revision.
          // The disposable database owner restores only this identified tenant;
          // table locks keep the temporary guard change inside this transaction.
          if (table === "bom_components") {
            await tx.execute(
              sql`alter table public.bom_components disable trigger production_bom_revision_guard`,
            );
            await tx.execute(
              sql`alter table public.bom_components disable trigger production_bom_revision_complete_guard`,
            );
          }
          // Remove unique-key colliders before reinserting baseline rows; leave FK-pinned rows for delete passes.
          const tableKeys = uniqueKeys.get(table) ?? [];
          if (tableKeys.length > 0) {
            const ownerColumn = table === "orgs" ? "id" : "org_id";
            const collider = tableKeys
              .map(
                (key) =>
                  `exists (select 1 from ${snapshot} as baseline where ${key.map((column) => `baseline.${quoteIdentifier(column)} is not distinct from target.${quoteIdentifier(column)}`).join(" and ")})`,
              )
              .join(" or ");
            const nested = `${savepoint}_colliders`;
            await tx.execute(sql.raw(`savepoint ${nested}`));
            try {
              await tx.execute(sql`
                delete from ${sql.raw(target)} as target
                 where target.${sql.raw(quoteIdentifier(ownerColumn))} = ${org.orgId}
                   and not exists (
                     select 1 from ${sql.raw(snapshot)} as baseline
                      where baseline.${sql.raw(quoteIdentifier("id"))} = target.${sql.raw(quoteIdentifier("id"))}
                   )
                   and (${sql.raw(collider)})
              `);
              await tx.execute(sql.raw(`release savepoint ${nested}`));
            } catch {
              await tx.execute(sql.raw(`rollback to savepoint ${nested}`));
              await tx.execute(sql.raw(`release savepoint ${nested}`));
            }
          }
          if (mutable.length > 0) {
            await tx.execute(sql`
              update ${sql.raw(target)} as target
                 set ${sql.raw(assignments)}
                from ${sql.raw(snapshot)} as baseline
               where target.id = baseline.id and ${ownerColumnFragment} = ${org.orgId}
                 and row(${sql.raw(mutable.map((column) => `target.${quoteIdentifier(column)}`).join(", "))})
                   is distinct from row(${sql.raw(mutable.map((column) => `baseline.${quoteIdentifier(column)}`).join(", "))})
            `);
          }
          await tx.execute(sql`
            insert into ${sql.raw(target)} (${sql.raw(insertColumns)})
            select ${sql.raw(insertColumns)} from ${sql.raw(snapshot)} as baseline
             where not exists (select 1 from ${sql.raw(target)} as target where target.id = baseline.id)
          `);
          if (table === "bom_components") {
            await tx.execute(
              sql`alter table public.bom_components enable trigger production_bom_revision_guard`,
            );
            await tx.execute(
              sql`alter table public.bom_components enable trigger production_bom_revision_complete_guard`,
            );
          }
          await tx.execute(sql.raw(`release savepoint ${savepoint}`));
        } catch (error) {
          await tx.execute(sql.raw(`rollback to savepoint ${savepoint}`));
          await tx.execute(sql.raw(`release savepoint ${savepoint}`));
          failures.push({ table, error: describeResetFailure(error) });
        }
      }
      return failures;
    });
    for (const table of restoreRemaining) restoreErrors.delete(table);
    for (const failure of failed) restoreErrors.set(failure.table, failure.error);
    const failedNames = failed.map((failure) => failure.table);
    if (failedNames.length === 0) {
      restoreRemaining = [];
      break;
    }
    if (failedNames.length === restoreRemaining.length) break;
    restoreRemaining = failedNames;
  }
  if (restoreRemaining.length > 0) {
    const detail = restoreRemaining
      .map((table) => `${table}: ${restoreErrors.get(table) ?? "unknown restore failure"}`)
      .join("; ");
    throw new Error(`scratch fixture baseline restore failed — ${detail}`);
  }
}

/** Remove test-created rows and restore the committed tenant baseline. */
export async function resetScratchOrgEscaped(
  org: ScratchOrg,
  tables: readonly string[],
  columns: OrgTableColumns,
): Promise<void> {
  const schema = org.snapshotSchema;
  if (!schema) throw new Error(`scratch fixture ${org.orgId} has no committed baseline snapshot`);
  // Probe touched tables first; on probe failure, reset every table.
  let resetTables: readonly string[] = tables;
  try {
    const probe = await probeScratchOrgTouchedTables(org, tables);
    if (probe.tables.length === 0 && !probe.special) return;
    resetTables = probe.tables;
  } catch (error) {
    console.error(
      `scratch fixture ${org.orgId} touch probe failed; running the full reset:`,
      error,
    );
  }
  const touched = new Set(resetTables);
  // Restore baseline references before deleting test rows so they cannot pin cleanup.
  await restoreScratchOrgBaseline(org, resetTables, columns, { deferLifecycleColumns: true });
  let remaining = [...resetTables].filter((table) => table !== "orgs");
  const errors = new Map<string, string>();
  const coreSet = new Set<string>(CORE_A);

  for (let pass = 0; pass < 10 && remaining.length > 0; pass += 1) {
    // Delete non-core children before the interlocked core; repeat blocked rows until no progress.
    const remainingSet = new Set(remaining);
    const ordered = [
      ...remaining.filter((t) => !coreSet.has(t)),
      ...CORE_A.filter((t) => remainingSet.has(t)),
    ];
    const failed: { table: string; error: string }[] = await db.transaction(async (tx) => {
      await guardTeardownTransaction(tx, org.orgId, "scratch");
      // Reset runs as the test login in an isolated database; guard changes, deferred links, and deletes stay transactional.
      await tx.execute(
        sql`update orgs set env_kind = 'sandbox' where id = ${org.orgId} and name like 'Scratch %'`,
      );
      await tx.execute(sql`set constraints documents_posted_entry_id_fkey, documents_reversal_entry_id_fkey,
          time_entries_invoiced_by_line_id_fkey, time_entries_cost_journal_entry_id_fkey, mfg_receipt_rework_source_fk deferred`);

      // Disable named evidence triggers only within this reset transaction.
      for (const { table, trigger } of [...GUARDED_EVIDENCE, ...AUDIT_WRITER_TRIGGERS]) {
        if (!touched.has(table)) continue;
        await tx.execute(sql.raw(`alter table public."${table}" disable trigger ${trigger}`));
      }
      await clearDisposableProjectAwardReferences(tx, org.orgId);
      const hasBankFiles =
        (
          await tx.execute(
            sql`select 1 as x from pay_run_bank_files where org_id = ${org.orgId} limit 1`,
            "objects",
          )
        ).length > 0;
      if (hasBankFiles) {
        await tx.execute(
          sql.raw(
            `alter table public."pay_run_bank_files" disable trigger pay_run_bank_file_immutable`,
          ),
        );
        await tx.execute(
          sql.raw(
            `alter table public."file_blobs" disable trigger payroll_bank_file_blob_immutable`,
          ),
        );
        await tx.execute(sql`delete from pay_run_bank_files where org_id = ${org.orgId}`);
      }
      // Delete capture evidence before protected blobs, then sweep remaining rows.
      const captureItems = await tx.execute(
        sql`select 1 from ap_capture_items where org_id = ${org.orgId} limit 1`,
        "objects",
      );
      if (captureItems.length > 0) {
        for (const [table, trigger] of [
          ["ap_capture_fields", "ap_capture_fields_append_only"],
          ["ap_capture_runs", "ap_capture_runs_immutable"],
          ["ap_capture_corrections", "ap_capture_corrections_append_only"],
          ["ap_capture_events", "ap_capture_events_append_only"],
        ] as const) {
          await tx.execute(sql.raw(`alter table public."${table}" disable trigger ${trigger}`));
          await tx.execute(sql`delete from ${qualified(table)} where org_id = ${org.orgId}`);
          await tx.execute(sql.raw(`alter table public."${table}" enable trigger ${trigger}`));
        }
        await tx.execute(sql`delete from ap_capture_items where org_id = ${org.orgId}`);
      }
      // Retained holiday rights pin Cabinet versions until their allocations and claims are removed.
      for (const table of [
        "pay_run_holiday_allocations",
        "payroll_holiday_occurrences",
        "payroll_holiday_obligations",
      ]) {
        if (tables.includes(table))
          await tx.execute(sql`delete from ${qualified(table)} where org_id=${org.orgId}`);
      }
      await deleteQualifiedCabinetFixtureSources(tx, org.orgId, new Set(tables));
      for (const table of RETAINED_CABINET_FILE_SOURCES) {
        if (tables.includes(table))
          await tx.execute(sql`delete from ${qualified(table)} where org_id=${org.orgId}`);
      }
      await tx.execute(sql`delete from file_blobs where version_id in
          (select v.id from file_versions v join files f on f.id = v.file_id where f.org_id = ${org.orgId})`);
      await tx.execute(
        sql`delete from file_versions where file_id in (select id from files where org_id = ${org.orgId})`,
      );
      if (hasBankFiles) {
        await tx.execute(
          sql.raw(
            `alter table public."file_blobs" enable trigger payroll_bank_file_blob_immutable`,
          ),
        );
        await tx.execute(
          sql.raw(
            `alter table public."pay_run_bank_files" enable trigger pay_run_bank_file_immutable`,
          ),
        );
      }
      // These unconditional guards require the same scoped disable used by full teardown.
      {
        const captureTables = [
          "ap_capture_items",
          "ap_capture_fields",
          "ap_capture_runs",
          "ap_capture_corrections",
          "ap_capture_events",
        ].filter((t) => touched.has(t));
        let captureRows = false;
        for (const t of captureTables) {
          const probe = await tx.execute(
            sql`select 1 as x from ${qualified(t)} where org_id = ${org.orgId} limit 1`,
            "objects",
          );
          if (probe.length > 0) {
            captureRows = true;
            break;
          }
        }
        if (captureRows) {
          for (const [table, trigger] of [
            ["ap_capture_fields", "ap_capture_fields_append_only"],
            ["ap_capture_runs", "ap_capture_runs_immutable"],
            ["ap_capture_corrections", "ap_capture_corrections_append_only"],
            ["ap_capture_events", "ap_capture_events_append_only"],
          ] as const) {
            if (!touched.has(table)) continue;
            await tx.execute(sql.raw(`alter table public."${table}" disable trigger ${trigger}`));
            await tx.execute(sql`delete from ${qualified(table)} where org_id = ${org.orgId}`);
            await tx.execute(sql.raw(`alter table public."${table}" enable trigger ${trigger}`));
          }
          if (touched.has("ap_capture_items")) {
            await tx.execute(sql`delete from ap_capture_items where org_id = ${org.orgId}`);
          }
        }
      }
      await tx.execute(sql`delete from tax_group_members where tax_group_id in
          (select id from tax_groups where org_id = ${org.orgId})`);
      // Clear password-reset rows by user id because they have no tenant key or foreign key.
      await tx.execute(sql`delete from auth_password_resets
          where user_id in (select id from users where org_id = ${org.orgId})`);
      await tx.execute(sql`update time_entries set invoiced_by_line_id = null, cost_journal_entry_id = null
          where org_id = ${org.orgId} and production_consumed_operation_id is null`);
      await tx.execute(
        sql`update payment_schedules set last_payment_run_id = null where org_id = ${org.orgId}`,
      );
      // Repeat savepoint deletes until FK dependencies clear or a full sweep makes no progress.
      let sweepTodo = ordered;
      let failures: { table: string; error: string }[] = [];
      for (let sweep = 0; sweepTodo.length > 0; sweep += 1) {
        failures = [];
        for (const [index, table] of sweepTodo.entries()) {
          const savepoint = `scratch_fixture_reset_${pass}_${sweep}_${index}`;
          await tx.execute(sql.raw(`savepoint ${savepoint}`));
          try {
            const target = `public.${quoteIdentifier(table)}`;
            const snapshot = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
            const tableColumns = columns.get(table) ?? [];
            if (tableColumns.includes("id")) {
              await tx.execute(sql`
                  delete from ${sql.raw(target)} as target
                   where target.org_id = ${org.orgId}
                     and not exists (select 1 from ${sql.raw(snapshot)} as baseline where baseline.id = target.id)`);
            } else {
              // Restore composite-key rows by comparing all nullable columns.
              const match = rowMatch(tableColumns, "target", "baseline");
              const insertColumns = tableColumns.map(quoteIdentifier).join(", ");
              await tx.execute(sql`
                  delete from ${sql.raw(target)} as target
                   where target.org_id = ${org.orgId}
                     and not exists (select 1 from ${sql.raw(snapshot)} as baseline where ${sql.raw(match)})
                `);
              await tx.execute(sql`
                  insert into ${sql.raw(target)} (${sql.raw(insertColumns)})
                  select ${sql.raw(insertColumns)} from ${sql.raw(snapshot)} as baseline
                   where not exists (
                     select 1 from ${sql.raw(target)} as target
                      where target.org_id = ${org.orgId}
                        and ${sql.raw(rowMatch(tableColumns, "target", "baseline"))}
                   )
                `);
            }
            await tx.execute(sql.raw(`release savepoint ${savepoint}`));
          } catch (error) {
            // A savepoint isolates FK failures so later sweeps can retry the blocked table.
            await tx.execute(sql.raw(`rollback to savepoint ${savepoint}`));
            await tx.execute(sql.raw(`release savepoint ${savepoint}`));
            failures.push({ table, error: describeResetFailure(error) });
          }
        }
        if (failures.length === 0) break;
        // The todo set only ever shrinks: an identical-length failure set
        // means the sweep converged nothing and further sweeps would replay
        // the identical statements against the identical rows.
        if (failures.length === sweepTodo.length) break;
        sweepTodo = failures.map((failure) => failure.table);
      }
      for (const { table, trigger } of [...GUARDED_EVIDENCE, ...AUDIT_WRITER_TRIGGERS]) {
        if (!touched.has(table)) continue;
        await tx.execute(sql.raw(`alter table public."${table}" enable trigger ${trigger}`));
      }
      const doomNames = new Set(failures.map((f) => f.table));
      if (doomNames.has("documents") && !doomNames.has("journal_entries")) {
        // Fail before commit if documents remain without their deferred journal entries.
        const detail = failures.map((f) => `${f.table}: ${f.error}`).join("; ");
        throw new Error(
          `scratch fixture ${org.orgId} reset cannot clear documents while journal entries are gone — ${detail}`,
        );
      }
      return failures;
    });
    for (const table of remaining) errors.delete(table);
    for (const failure of failed) errors.set(failure.table, failure.error);
    const failedNames = failed.map((failure) => failure.table);
    if (failedNames.length === 0) {
      remaining = [];
      break;
    }
    if (failedNames.length === remaining.length) break;
    remaining = failedNames;
  }

  if (remaining.length > 0) {
    const detail = remaining
      .map((table) => `${table}: ${errors.get(table) ?? "unknown reset failure"}`)
      .join("; ");
    throw new Error(`scratch fixture ${org.orgId} leaked rows that could not be reset — ${detail}`);
  }
  // Restore values and missing baseline rows after deleting scenario-created records.
  await restoreScratchOrgBaseline(org, resetTables, columns);
  await db.transaction(async (tx) => {
    await setTeardownGucs(tx);
    await tx.execute(
      sql`update orgs set env_kind = 'production' where id = ${org.orgId} and name like 'Scratch %'`,
    );
  });
}

export async function dropScratchOrgAndSnapshot(org: ScratchOrg): Promise<void> {
  try {
    await dropScratchOrgEscaped(org.orgId);
  } finally {
    if (org.snapshotSchema) {
      await db.execute(
        sql.raw(`drop schema if exists ${quoteIdentifier(org.snapshotSchema)} cascade`),
      );
    }
  }
}
