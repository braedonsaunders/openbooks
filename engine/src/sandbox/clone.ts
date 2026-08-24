import { sql } from "drizzle-orm";
import { db, withOrg } from "../db.ts";
import { assertUuid, insertionOrder, loadCatalog, PARENT_FILTER, type TableInfo } from "./catalog.ts";
import { loadMaskingPolicies, maskExpr, type MaskTransform } from "./masking.ts";

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

/** Generate the INSERT..SELECT that copies one table, or null to skip it. */
function generateCopySql(
  t: TableInfo,
  opts: CloneOptions,
  rebaseSet: Set<string>,
  masking: Map<string, Map<string, MaskTransform>>,
): string | null {
  const seed = assertUuid(opts.seed);
  const sbx = assertUuid(opts.sandboxOrgId);
  const prod = assertUuid(opts.productionOrgId);
  const tableMask = opts.masked ? masking.get(t.name) : undefined;

  const cols: string[] = [];
  const exprs: string[] = [];
  for (const c of t.columns) {
    cols.push(`"${c.name}"`);
    if (c.name === "id" && t.hasId) {
      exprs.push(`ob_rebase("id", '${seed}')`);
    } else if (c.name === "org_id") {
      exprs.push(`'${sbx}'::uuid`);
    } else if ((t.fks[c.name] && rebaseSet.has(t.fks[c.name]!)) || t.forceRebase.has(c.name)) {
      exprs.push(`(case when "${c.name}" is null then null else ob_rebase("${c.name}", '${seed}') end)`);
    } else if (tableMask?.has(c.name)) {
      exprs.push(`${maskExpr(c.name, tableMask.get(c.name)!)} `);
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

  return `insert into "${t.name}" (${cols.join(", ")}) select ${exprs.join(", ")} from "${t.name}" where ${where}`;
}

export async function runClone(opts: CloneOptions): Promise<CloneResult> {
  const cat = await loadCatalog();
  const { tables, rebaseSet } = cat;
  const masking = opts.masked
    ? await loadMaskingPolicies(opts.productionOrgId)
    : new Map<string, Map<string, MaskTransform>>();

  // 'dev' copies only the customization layer; others copy the full rebase set.
  let selected =
    opts.tier === "dev" ? tables.filter((t) => CUSTOMIZATION_LAYER.has(t.name)) : tables;
  if (opts.onlyTables) selected = selected.filter((t) => opts.onlyTables!.has(t.name));
  // Copy parents before children: 152 FKs are non-deferrable, so `set constraints
  // all deferred` alone can't guarantee a valid order.
  const insOrder = insertionOrder(cat);
  const rank = new Map(insOrder.map((n, i) => [n, i]));
  selected = [...selected].sort((a, b) => (rank.get(a.name) ?? 1e9) - (rank.get(b.name) ?? 1e9));

  const perTable: { table: string; rows: number }[] = [];
  let rowsCopied = 0;

  // One transaction, unscoped (RLS bypass) since we span production→sandbox.
  await withOrg(null, async () => {
    await db.execute(sql`set constraints all deferred`);
    // Trusted bulk copy: the deterministic rebase guarantees integrity, so the
    // kernel guards (account-postability via 'migration', posted-immutability
    // via 'amend') must stand down while we insert already-posted rows.
    await db.execute(sql`select set_config('openbooks.migration', 'on', true)`);
    await db.execute(sql`select set_config('openbooks.amend', 'on', true)`);
    for (const t of selected) {
      const stmt = generateCopySql(t, opts, rebaseSet, masking);
      if (!stmt) continue;
      const res = (await db.execute(sql.raw(stmt))) as any;
      const n = res.rowCount ?? 0;
      perTable.push({ table: t.name, rows: n });
      rowsCopied += n;
    }
  });

  return { tablesCopied: perTable.length, rowsCopied, perTable };
}
