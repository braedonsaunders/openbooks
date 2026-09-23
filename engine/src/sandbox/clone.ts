import { sql } from "drizzle-orm";
import { db, withMaintenanceTransaction } from "../platform/db.ts";
import { assertUuid, insertionOrder, loadCatalog, PARENT_FILTER, type TableInfo } from "./catalog.ts";
import { loadMaskingPolicies, maskExpr, type MaskTransform } from "./masking.ts";
import { rebaseClonedJsonReferences } from "./json-references.ts";
import { copyS3Blob, deleteS3Blobs, MASKED_STORAGE_KIND } from "../platform/file-storage.ts";

/**
 * The deterministic UUID-rebase clone engine. Copies one org's rows into a
 * sandbox org by rewriting every PK and FK through ob_rebase(id, seed): because
 * the same seed rebases both sides of every reference, the copied graph stays
 * internally consistent with no mapping table. Runs as a single deferred-
 * constraint transaction with the kernel-migration GUC set so already-posted
 * ledger rows can be inserted.
 */

export type SandboxTier = "dev" | "masked" | "full" | "as_of";

export interface CloneOptions {
  productionOrgId: string;
  sandboxOrgId: string;
  seed: string;
  tier: SandboxTier;
  masked: boolean;
  /** for tier='as_of': trim the GL to entries in periods closing at/before this. */
  asOfPeriod?: { fiscalYear: number; periodNumber: number } | null;
  /** Restrict the copy to these tables (used by refresh to skip the preserved
   * customization layer). Undefined = copy the tier's full set. */
  onlyTables?: Set<string>;
}

export interface CloneResult {
  tablesCopied: number;
  rowsCopied: number;
  perTable: { table: string; rows: number }[];
}

/** The user-built customization layer — the only tables a 'dev' sandbox copies,
 * and the set preserved across a "keep customizations" refresh / diffed on
 * promotion. Names not present in the schema are skipped harmlessly. */
export const CUSTOMIZATION_LAYER = new Set([
  "user_scripts",
  "custom_field_defs",
  "custom_record_types",
  "form_layouts",
  "user_form_preferences",
  "list_views",
  "user_list_preferences",
  "statement_layouts",
  "segment_definitions",
  "segment_values",
  "fx_provider_configs",
  "saved_reports",
  "report_definitions",
  "report_schedules",
  "saved_views",
  "app_roles",
  "role_assignments",
  "user_permission_overrides",
  "user_dashboard_layouts",
  "role_dashboard_layouts",
  "account_groups",
  "account_group_members",
  "users",
]);

/** Generate the INSERT..SELECT that copies one table, or null to skip it.
 * `retainedTenantTables` = tenant-owned tables the clone deliberately does not
 * copy (the catalog EXCLUDE set): a real FK into one of them can never be
 * copied verbatim — the value would be a pointer at PRODUCTION's row. */
function generateCopySql(
  t: TableInfo,
  opts: CloneOptions,
  rebaseSet: Set<string>,
  retainedTenantTables: Set<string>,
  masking: Map<string, Map<string, MaskTransform>>,
): string | null {
  const seed = assertUuid(opts.seed);
  const sbx = assertUuid(opts.sandboxOrgId);
  const prod = assertUuid(opts.productionOrgId);
  const tableMask = opts.masked ? masking.get(t.name) : undefined;

  // A masked sandbox never receives production file bytes: the blob table is
  // not copied at all, and version/file rows carry the tombstone storage
  // kind instead of 'db'/'s3'. Every download path refuses the tombstone by
  // name (see MASKED_STORAGE_KIND); metadata (names, sizes, hashes) stays so
  // the cabinet remains browsable test data.
  if (opts.masked && t.name === "file_blobs") return null;

  const cols: string[] = [];
  const exprs: string[] = [];
  for (const c of t.columns) {
    cols.push(`"${c.name}"`);
    if (opts.masked && (t.name === "files" || t.name === "file_versions") && c.name === "storage_kind") {
      exprs.push(`'${MASKED_STORAGE_KIND}'`);
      continue;
    }
    const fkTarget = t.fks[c.name];
    if (c.name === "id" && t.hasId) {
      exprs.push(`ob_rebase("id", '${seed}')`);
    } else if (c.name === "org_id") {
      exprs.push(`'${sbx}'::uuid`);
    } else if (fkTarget && retainedTenantTables.has(fkTarget)) {
      if (!c.isNullable) {
        throw new Error(
          `sandbox clone: ${t.name}.${c.name} is NOT NULL and references ${fkTarget}, which is never copied into a sandbox`,
        );
      }
      exprs.push("null");
    } else if ((fkTarget && rebaseSet.has(fkTarget)) || t.forceRebase.has(c.name)) {
      exprs.push(`(case when "${c.name}" is null then null else ob_rebase("${c.name}", '${seed}') end)`);
    } else if (tableMask?.has(c.name)) {
      exprs.push(`${maskExpr(c.name, tableMask.get(c.name)!, "id", c)} `);
    } else if (opts.masked && (c.udtName === "jsonb" || c.udtName === "json") && c.name === "custom") {
      // Custom fields are arbitrary tenant-authored JSON and may contain PII
      // without a schema-level column for a masking policy to name. A masked
      // environment must not carry that payload by default; an explicit
      // table/column policy can opt into a narrower transform when safe.
      exprs.push(`${maskExpr(c.name, "null_out", "id", c)} `);
    } else {
      exprs.push(`"${c.name}"`);
    }
  }

  // Source-row filter.
  let where: string;
  if (t.hasOrgId) {
    where = `org_id = '${prod}'`;
  } else if (PARENT_FILTER[t.name]) {
    where = PARENT_FILTER[t.name]!(prod);
  } else {
    return null; // org-less, no known parent filter — skip
  }

  // as_of: trim the general ledger to periods closing at/before the cutoff.
  if (opts.tier === "as_of" && opts.asOfPeriod) {
    const { fiscalYear: y, periodNumber: n } = opts.asOfPeriod;
    const periodPred = `(fiscal_year < ${y} or (fiscal_year = ${y} and period_number <= ${n}))`;
    if (t.name === "journal_entries") {
      where += ` and period_id in (select id from accounting_periods where org_id = '${prod}' and ${periodPred})`;
    } else if (t.name === "journal_lines") {
      where += ` and entry_id in (select je.id from journal_entries je join accounting_periods p on p.id = je.period_id where p.org_id = '${prod}' and ${periodPred})`;
    }
  }

  // The subsidiary BEFORE trigger requires its parent to exist already.
  // Deferred FKs cannot repair child-first insertion, and heap/index scan order
  // changes after ordinary edits. Order the entire hierarchy by ancestor depth.
  const tree = t.name === "subsidiaries" ? `with recursive source_tree as (
    select id, 0 as depth from subsidiaries where org_id = '${prod}' and parent_id is null
    union all
    select child.id, parent.depth + 1 from subsidiaries child
      join source_tree parent on parent.id = child.parent_id where child.org_id = '${prod}'
  ) ` : "";
  const order = t.name === "subsidiaries"
    ? ` order by (select depth from source_tree where source_tree.id = subsidiaries.id), id`
    : "";
  return `${tree}insert into "${t.name}" (${cols.join(", ")}) select ${exprs.join(", ")} from "${t.name}" where ${where}${order}`;
}

export async function runClone(opts: CloneOptions): Promise<CloneResult> {
  const cat = await loadCatalog();
  const { tables, rebaseSet } = cat;
  const retainedTenantTables = new Set(
    cat.tenantTables.map((t) => t.name).filter((name) => !rebaseSet.has(name)),
  );
  const masking = opts.masked
    ? await loadMaskingPolicies(opts.productionOrgId)
    : new Map<string, Map<string, MaskTransform>>();

  // Dev also needs the legal-entity tree so copied roles have real scope
  // targets. Keep it outside CUSTOMIZATION_LAYER: refresh must refresh that
  // reference data even when preserving role customizations.
  let selected =
    opts.tier === "dev" ? tables.filter((t) => CUSTOMIZATION_LAYER.has(t.name) || t.name === "subsidiaries") : tables;
  if (opts.onlyTables) selected = selected.filter((t) => opts.onlyTables!.has(t.name));
  // Copy parents before children: 152 FKs are non-deferrable, so `set constraints
  // all deferred` alone can't guarantee a valid order.
  const insOrder = insertionOrder(cat);
  const rank = new Map(insOrder.map((n, i) => [n, i]));
  selected = [...selected].sort((a, b) => (rank.get(a.name) ?? 1e9) - (rank.get(b.name) ?? 1e9));

  const perTable: { table: string; rows: number }[] = [];
  let rowsCopied = 0;

  // One transaction, unscoped (RLS bypass) since we span production→sandbox.
  // Repeatable read pins a single snapshot of production for every table
  // copy: under read committed, a post landing mid-clone is visible to some
  // copies and invisible to others, and the torn set dies at commit on a
  // deferred FK (or worse, commits FK-consistent but incomplete). The clone
  // only writes sandbox rows, so the pinned snapshot cannot conflict with
  // concurrent production writers.
  await withMaintenanceTransaction(null, async () => {
    // As-of trims journal entries past the cutoff but copies every document,
    // so a post-cutoff posted entry would leave its documents pointing at an
    // entry that was never copied — a deferred-FK failure at commit. Refuse up
    // front with an actionable error instead. The predicate mirrors the copy
    // filter exactly (entries whose period is not in the cutoff set, including
    // a null period, are the ones the copy would drop).
    if (opts.tier === "as_of" && opts.asOfPeriod) {
      const { fiscalYear: y, periodNumber: n } = opts.asOfPeriod;
      const beyond = (await db.execute<{ count: string }>(sql`
        select count(*)::text as count
          from journal_entries je
         where je.org_id = ${opts.productionOrgId}
           and je.status in ('posted', 'reversed')
           and not (je.period_id in (
             select p.id from accounting_periods p
              where p.org_id = ${opts.productionOrgId}
                and (p.fiscal_year < ${y} or (p.fiscal_year = ${y} and p.period_number <= ${n}))
           ))`)).rows[0]?.count;
      if (beyond !== "0") {
        throw new Error(
          `as-of sandbox to fiscal ${y} period ${n} excludes ${beyond ?? "?"} posted entries in later periods; ` +
            `their documents would reference entries that were never copied — ` +
            `choose a cutoff at or after the latest posted period, or use a full tier`,
        );
      }
    }
    await db.execute(sql`set constraints all deferred`);
    // Trusted bulk copy: the deterministic rebase guarantees integrity, so the
    // kernel guards (account-postability via 'migration', posted-immutability
    // via 'amend') must stand down while we insert already-posted rows.
    await db.execute(sql`select set_config('openbooks.migration', 'on', true)`);
    await db.execute(sql`select set_config('openbooks.amend', 'on', true)`);
    for (const t of selected) {
      const stmt = generateCopySql(t, opts, rebaseSet, retainedTenantTables, masking);
      if (!stmt) continue;
      const res = (await db.execute(sql.raw(stmt)));
      const n = res.rowCount ?? 0;
      perTable.push({ table: t.name, rows: n });
      rowsCopied += n;
    }
    await rebaseClonedJsonReferences({ ...opts, copiedTables: new Set(perTable.map(row => row.table)) });
    // These rollups are intentionally excluded from the clone catalog because
    // they are maintained projections, not source evidence. Rebuild them after
    // every copy: application rows can be inserted before their journal-line
    // endpoints (composite tenant FKs are deferred), so their row trigger may
    // legitimately have no effect during the bulk load. A rebuild also clears
    // stale values left by a refresh before applying the new source snapshot.
    await db.execute(sql`select openbooks_gl_activity_rebuild(${opts.sandboxOrgId})`);
    await db.execute(sql`select openbooks_party_payment_stats_rebuild(${opts.sandboxOrgId})`);
  }, { isolationLevel: "REPEATABLE READ" });

  return { tablesCopied: perTable.length, rowsCopied, perTable };
}

/**
 * S3 object keys are `file-cabinet/<versionId>`, so a row copy that rebases
 * file_versions.id orphans every S3-backed attachment: the sandbox row points
 * at a key that was never written. Copy each production object onto its
 * rebased key (server-side — bytes never transit the clone worker).
 *
 * Masked clones are excluded by construction: their version rows carry the
 * MASKED_STORAGE_KIND tombstone instead of 's3', so the pair query below
 * matches nothing. Tiers that skip files (dev) likewise match nothing via
 * the sandbox-side existence check, and a restricted `onlyTables` copy
 * without file_versions returns early.
 *
 * Runs AFTER the row-copy transaction commits — object storage cannot roll
 * back with it. On failure the objects already copied are deleted and the
 * error rethrown, so the caller marks the sandbox failed instead of
 * publishing a clone whose cabinet 404s.
 */
export async function copyClonedFileObjects(opts: {
  productionOrgId: string;
  sandboxOrgId: string;
  seed: string;
  onlyTables?: Set<string>;
}): Promise<{ objectsCopied: number }> {
  if (opts.onlyTables && !opts.onlyTables.has("file_versions")) return { objectsCopied: 0 };
  // assertUuid at this boundary: both ids are interpolated below (the shared
  // PARENT_FILTER pattern), so they must provably be values, not statements.
  const seed = assertUuid(opts.seed);
  const prod = assertUuid(opts.productionOrgId);
  const pairs = (await db.execute<{ prodVersionId: string; sandboxVersionId: string }>(sql.raw(`
    select fv.id as "prodVersionId", ob_rebase(fv.id, '${seed}') as "sandboxVersionId"
      from file_versions fv
      join files f on f.id = fv.file_id
     where f.org_id = '${prod}'
       and fv.storage_kind = 's3'
       and exists (
         select 1 from file_versions sv
          where sv.id = ob_rebase(fv.id, '${seed}') and sv.storage_kind = 's3'
       )
  `))).rows;
  const copied: string[] = [];
  try {
    for (const pair of pairs) {
      await copyS3Blob(pair.prodVersionId, pair.sandboxVersionId);
      copied.push(pair.sandboxVersionId);
    }
  } catch (err) {
    await deleteS3Blobs(copied).catch(() => undefined);
    throw err;
  }
  return { objectsCopied: copied.length };
}

/**
 * S3 version ids currently referenced by a sandbox's cabinet. Collected
 * BEFORE a wipe so delete/refresh can remove the sandbox's objects after
 * its rows are gone (objects cannot roll back with the row transaction, so
 * they are deleted after the row commit, never before).
 */
export async function listSandboxS3VersionIds(sandboxOrgId: string): Promise<string[]> {
  const org = assertUuid(sandboxOrgId);
  const rows = (await db.execute<{ id: string }>(sql.raw(`
    select fv.id as id
      from file_versions fv
      join files f on f.id = fv.file_id
     where f.org_id = '${org}' and fv.storage_kind = 's3'
  `))).rows;
  return rows.map((row) => row.id);
}
