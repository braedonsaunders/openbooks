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
  /** for tier='as_of': the selected cutoff period id. Only the id crosses the
   * transaction boundary: the period's calendar and end date are resolved
   * INSIDE the clone's snapshot transaction (see resolveAsOfCutoff), so a
   * concurrent fiscal-period derivation can never strand the copy filter on
   * a stale ordinal while the copied period rows carry new labels. */
  asOfPeriodId?: string | null;
  /** Create-only: overwrite the (already inserted) sandbox org row with the
   * production org configuration captured inside the clone snapshot. Refresh
   * preserves the sandbox's own org row and omits this. */
  initializeOrg?: boolean;
  /**
   * Create-only: caller-owned settings keys merged over the captured source
   * configuration (and over the provisional row), so ownership/provenance the
   * caller needs for crash recovery survives the authoritative overwrite.
   * Refresh never carries one.
   */
  settingsOverlay?: Record<string, unknown>;
  /** Restrict the copy to these tables (used by refresh to skip the preserved
   * customization layer). Undefined = copy the tier's full set. */
  onlyTables?: Set<string>;
}

/**
 * An as-of cutoff resolved inside the clone snapshot: the selected period's
 * end date is the cutoff instant, qualified by its calendar for display.
 *
 * Policy: an entry is included iff its posting_date is on or before the
 * cutoff end date, whatever calendar its period belongs to. Posting date —
 * not the period ordinal — is what every other as-of feature cuts on (trial
 * balance, aging, open items and statements all read `posting_date <= asOf`),
 * so the sandbox's books equal production's books-as-of that date exactly.
 * The period's only role is to supply the cutoff instant and the
 * date-and-calendar label the UI and the refusal carry.
 */
export interface AsOfCutoff {
  periodId: string;
  periodName: string;
  endsOn: string;
  fiscalYear: number;
  periodNumber: number;
  calendarId: string;
  calendarName: string;
}

export interface CloneResult {
  tablesCopied: number;
  rowsCopied: number;
  perTable: { table: string; rows: number }[];
  /** The cutoff used, when tier='as_of'. */
  asOfCutoff: Pick<AsOfCutoff, "periodId" | "periodName" | "endsOn" | "calendarName"> | null;
  /** Production org settings captured inside the clone snapshot (SBOX2: the
   * same snapshot the tenant rows came from). Null unless initializeOrg. */
  sourceSettings: Record<string, unknown> | null;
}

/** A cutoff end date comes out of our own snapshot as an ISO civil date. */
function assertCutoffDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`as-of cutoff end date is not a civil date: ${value}`);
  }
  return value;
}

/**
 * Resolve the selected cutoff period inside the caller's snapshot
 * transaction: first statement of the clone unit, so the identity (calendar
 * + end date) the preflight and the copy filter share is the snapshot's,
 * never an outer lookup's. Scoped to the production org — a foreign or
 * missing period id is a refusal, not an empty cutoff.
 */
export async function resolveAsOfCutoff(
  productionOrgId: string,
  periodId: string,
): Promise<AsOfCutoff> {
  const res = await db.execute<{
    id: string; name: string; ends_on: string;
    fiscal_year: number; period_number: number;
    calendar_id: string; calendar_name: string;
  }>(sql`
    select p.id, p.name, p.ends_on::text as ends_on,
           p.fiscal_year, p.period_number,
           p.fiscal_calendar_id as calendar_id, fc.name as calendar_name
      from accounting_periods p
      join fiscal_calendars fc
        on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
     where p.id = ${periodId} and p.org_id = ${productionOrgId}`);
  const row = res.rows[0];
  if (!row) throw new Error("as-of cutoff period must belong to the production organization");
  return {
    periodId: row.id,
    periodName: row.name,
    endsOn: assertCutoffDate(row.ends_on),
    fiscalYear: row.fiscal_year,
    periodNumber: row.period_number,
    calendarId: row.calendar_id,
    calendarName: row.calendar_name,
  };
}

interface SourceOrgConfig {
  legalName: string | null;
  baseCurrency: string;
  country: string;
  taxIds: unknown;
  settings: Record<string, unknown>;
}

/** Read the production org configuration inside the clone snapshot. A
 * zero-row read is a failure: the caller named a source org that is gone. */
async function readSourceOrgConfig(productionOrgId: string): Promise<SourceOrgConfig> {
  const res = await db.execute<{
    legal_name: string | null; base_currency: string;
    country: string; tax_ids: unknown; settings: Record<string, unknown> | null;
  }>(sql`
    select legal_name, base_currency, country, tax_ids, settings
      from orgs where id = ${productionOrgId}`);
  const row = res.rows[0];
  if (!row) throw new Error(`production org not found: ${productionOrgId}`);
  return {
    legalName: row.legal_name,
    baseCurrency: row.base_currency,
    country: row.country,
    taxIds: row.tax_ids ?? {},
    settings: row.settings ?? {},
  };
}

/**
 * Overwrite the sandbox org row with the in-snapshot source configuration. A
 * zero-row write is a failure: the sandbox row must already exist (create
 * inserts it before the clone; refresh never sets initializeOrg). `name` is
 * deliberately NOT captured: it is the sandbox's own display name
 * (create inserts the user's sandbox name), not source configuration.
 */
async function applySandboxOrgConfig(
  sandboxOrgId: string,
  source: SourceOrgConfig,
  masked: boolean,
  settingsOverlay: Record<string, unknown> = {},
): Promise<void> {
  const updated = await db.execute(sql`
    update orgs
       set legal_name = ${source.legalName},
           base_currency = ${source.baseCurrency},
           country = ${source.country},
           tax_ids = ${JSON.stringify(masked ? {} : (source.taxIds ?? {}))}::jsonb,
           settings = (${JSON.stringify(source.settings)}::jsonb || ${JSON.stringify(settingsOverlay)}::jsonb),
           updated_at = now()
     where id = ${sandboxOrgId}`);
  if ((updated.rowCount ?? 0) !== 1) {
    throw new Error(`sandbox org row not found: ${sandboxOrgId}`);
  }
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
  cutoff: AsOfCutoff | null,
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
    } else if (c.isUuid && fkTarget && retainedTenantTables.has(fkTarget)) {
      if (!c.isNullable) {
        throw new Error(
          `sandbox clone: ${t.name}.${c.name} is NOT NULL and references ${fkTarget}, which is never copied into a sandbox`,
        );
      }
      exprs.push("null");
    } else if (c.isUuid && ((fkTarget && rebaseSet.has(fkTarget)) || t.forceRebase.has(c.name))) {
      exprs.push(`(case when "${c.name}" is null then null else ob_rebase("${c.name}", '${seed}') end)`);
    } else if (t.name === "hrm_employment_change_requests" && c.name === "decision_snapshot") {
      // OM-13c: the decision snapshot binds flow_run_id BY VALUE (storage
      // CHECK ..._snapshot_binding), but the copy rebases flow_run_id to the
      // sandbox run while a verbatim snapshot still names the source run —
      // the INSERT dies on the binding CHECK before any post-copy fixup can
      // run. Rebind the snapshot's flow_run_id to the rebased run at copy
      // time. Every other bound key (payload digest, schema version,
      // expected revision) is rebase-invariant, and rows without a snapshot
      // (drafts) or without a run pass through untouched.
      exprs.push(
        `(case when "decision_snapshot" is null or "flow_run_id" is null then "decision_snapshot" ` +
          `else jsonb_set("decision_snapshot", '{flow_run_id}', to_jsonb(ob_rebase("flow_run_id", '${seed}')::text)) end)`,
      );
    } else if (t.name === "flow_runs" && c.name === "occurrence_key") {
      // OM-13-CLONE: occurrence_key sits in a global partial unique with no
      // org_id, so a verbatim copy collides with the source's own row (PG
      // 23505) and hands the sandbox production's dedup claim. The run rows
      // stay — gates and effects reference them by NOT NULL run_id — but the
      // key is cleared: a sandbox never adopts the source's dedup slot, and
      // retried attempts mint their own keys.
      exprs.push("null");
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

  // as_of: trim the general ledger to entries posted on or before the cutoff
  // end date, whatever calendar their period belongs to. The date is the
  // in-snapshot cutoff resolved by runClone and asserted to ISO shape there,
  // so this interpolation is provably a value, not a statement.
  if (opts.tier === "as_of" && cutoff) {
    const endsOn = cutoff.endsOn;
    if (t.name === "journal_entries") {
      where += ` and posting_date <= '${endsOn}'`;
    } else if (t.name === "journal_lines") {
      where += ` and entry_id in (select je.id from journal_entries je where je.org_id = '${prod}' and je.posting_date <= '${endsOn}')`;
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

/**
 * The clone plan's table set: the tier's full set, restricted to onlyTables
 * when given. verify-rls derives its proof from this same selector, so the
 * isolation proof always covers exactly the tables the clone actually
 * copied — a dev-tier proof over ledger tables would be vacuous (dev never
 * copies them) while production counts kept the total positive.
 */
export function selectCloneTables(
  tables: TableInfo[],
  tier: SandboxTier,
  onlyTables?: Set<string>,
): TableInfo[] {
  // Dev also needs the legal-entity tree so copied roles have real scope
  // targets. Keep it outside CUSTOMIZATION_LAYER: refresh must refresh that
  // reference data even when preserving role customizations.
  let selected =
    tier === "dev" ? tables.filter((t) => CUSTOMIZATION_LAYER.has(t.name) || t.name === "subsidiaries") : tables;
  if (onlyTables) selected = selected.filter((t) => onlyTables.has(t.name));
  return selected;
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

  let selected = selectCloneTables(tables, opts.tier, opts.onlyTables);
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
  const { cutoff, sourceSettings } = await withMaintenanceTransaction(null, async () => {
    let cutoff: AsOfCutoff | null = null;
    let sourceSettings: Record<string, unknown> | null = null;
    // Resolve the as-of cutoff FIRST: under runClone's own REPEATABLE READ
    // transaction this statement pins the snapshot; under a refresh reuse it
    // joins the outer unit's snapshot. Either way the calendar and end date
    // the preflight and the copy filter share are the snapshot's own — a
    // concurrent period relabel can neither strand the filter on a stale
    // ordinal nor slip between the refusal check and the copy.
    if (opts.tier === "as_of") {
      if (!opts.asOfPeriodId) throw new Error("as-of sandbox requires a cutoff period");
      cutoff = await resolveAsOfCutoff(opts.productionOrgId, opts.asOfPeriodId);
    }
    // Capture settings in the same snapshot as copied rows. Refresh uses this
    // captured value to rebase JSON control-account references, avoiding a
    // live read after the clone commits that could pair snapshot rows with a
    // newer production control map.
    const source = await readSourceOrgConfig(opts.productionOrgId);
    sourceSettings = source.settings;
    // Create additionally applies that snapshot to its new org row; refresh
    // preserves the sandbox org row but still consumes sourceSettings below.
    if (opts.initializeOrg) {
      await applySandboxOrgConfig(opts.sandboxOrgId, source, opts.masked, opts.settingsOverlay ?? {});
    }
    // As-of trims journal entries past the cutoff but copies every document,
    // so a post-cutoff posted entry would leave its documents pointing at an
    // entry that was never copied — a deferred-FK failure at commit. Refuse up
    // front with an actionable error instead. The predicate mirrors the copy
    // filter exactly: posted/reversed entries with posting_date past the
    // cutoff end date are precisely the posted entries the copy drops
    // (posting_date is NOT NULL, so there is no null edge to diverge on).
    if (opts.tier === "as_of" && cutoff) {
      const beyond = (await db.execute<{ count: string }>(sql`
        select count(*)::text as count
          from journal_entries je
         where je.org_id = ${opts.productionOrgId}
           and je.status in ('posted', 'reversed')
           and je.posting_date > ${cutoff.endsOn}`)).rows[0]?.count;
      if (beyond !== "0") {
        throw new Error(
          `as-of sandbox to period "${cutoff.periodName}" ending ${cutoff.endsOn} ` +
            `(calendar "${cutoff.calendarName}") excludes ${beyond ?? "?"} posted entries ` +
            `dated after ${cutoff.endsOn}; ` +
            `their documents would reference entries that were never copied — ` +
            `choose a cutoff ending on or after the latest posted date, or use a full tier`,
        );
      }
    }
    await db.execute(sql`set constraints all deferred`);
    // Trusted bulk copy: the deterministic rebase guarantees integrity, so the
    // kernel guards (account-postability via 'migration', posted-immutability
    // via 'amend') must stand down while we insert already-posted rows.
    await db.execute(sql`select set_config('openbooks.migration', 'on', true)`);
    await db.execute(sql`select set_config('openbooks.amend', 'on', true)`);
    // Clone authority (OM-13): replaying posted history into target periods
    // that are already closed there is refused by the closed-period guards
    // even under the flags above. This transaction-local flag — set ONLY
    // here, inside runClone's own maintenance transaction — lets those
    // guards admit INSERTs of posted/reversed rows (see
    // openbooks_clone_authority()). UPDATE and DELETE of posted history stay
    // blocked, and the flag is inert outside this transaction: the authority
    // also requires the migration/amend flags above plus RLS bypass, which a
    // tenant transaction never holds.
    await db.execute(sql`select set_config('openbooks.clone', 'on', true)`);
    for (const t of selected) {
      const stmt = generateCopySql(t, opts, rebaseSet, retainedTenantTables, masking, cutoff);
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
    // Evidence for the clone authority asserted above (OM-13): one audit row
    // in the target org recording the provenance and scope of this copy, so
    // closed-period history carried under openbooks.clone is attributable.
    // audit_log is never copied (catalog EXCLUDE), so this insert cannot
    // collide with the bulk copy; it commits or rolls back with the clone.
    await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${opts.sandboxOrgId}, 'orgs', ${opts.sandboxOrgId}, 'insert',
        ${JSON.stringify({
          mode: "sandbox_clone_authority",
          productionOrgId: opts.productionOrgId,
          tier: opts.tier,
          masked: opts.masked,
          tablesCopied: perTable.length,
          rowsCopied,
          authority: "openbooks.clone",
          scope: "INSERT of posted/reversed history into closed periods only; UPDATE and DELETE of posted history stay blocked",
        })}::jsonb, null)`);
    return { cutoff, sourceSettings };
  }, { isolationLevel: "REPEATABLE READ" });

  return {
    tablesCopied: perTable.length,
    rowsCopied,
    perTable,
    asOfCutoff: cutoff
      ? {
          periodId: cutoff.periodId,
          periodName: cutoff.periodName,
          endsOn: cutoff.endsOn,
          calendarName: cutoff.calendarName,
        }
      : null,
    sourceSettings,
  };
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
  // assertUuid at this boundary: both ids travel as bound parameters below,
  // so they must provably be values, not statements.
  const seed = assertUuid(opts.seed);
  const prod = assertUuid(opts.productionOrgId);
  const pairs = (await db.execute<{ prodVersionId: string; sandboxVersionId: string }>(sql`
    select fv.id as "prodVersionId", ob_rebase(fv.id, ${seed}) as "sandboxVersionId"
      from file_versions fv
      join files f on f.id = fv.file_id
     where f.org_id = ${prod}
       and fv.storage_kind = 's3'
       and exists (
         select 1 from file_versions sv
          where sv.id = ob_rebase(fv.id, ${seed}) and sv.storage_kind = 's3'
       )
  `)).rows;
  const copied: string[] = [];
  try {
    for (const pair of pairs) {
      await copyS3Blob(pair.prodVersionId, pair.sandboxVersionId);
      copied.push(pair.sandboxVersionId);
    }
  } catch (err) {
    // Compensating cleanup during unwind: best-effort on purpose — a cleanup
    // failure here must never mask the original copy error being rethrown.
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
  const rows = (await db.execute<{ id: string }>(sql`
    select fv.id as id
      from file_versions fv
      join files f on f.id = fv.file_id
     where f.org_id = ${org} and fv.storage_kind = 's3'
  `)).rows;
  return rows.map((row) => row.id);
}
